// =============================================================
// §7.2 — Source health.
//
// Reports honestly on every configured source: which succeeded, which failed,
// which are stale, which were never configured, and when each last synced. A
// provider failure is surfaced, never hidden behind an otherwise-green run.
//
// Staleness uses each source's OWN `stalenessHours` via the Section 6
// `deriveFreshness` helper. No global staleness rule is invented when per-source
// configuration already exists.
//
// This module NEVER changes a source's verification state. §6.1A promotes a
// source to LIVE_VERIFIED only after a real provider round-trip, and that
// remains the only path.
// =============================================================
import { prisma } from '../../../config/database'
import { deriveFreshness } from '../../discovery/sourceSync'
import { SOURCE_FAILURE_ESCALATION_THRESHOLD } from './policy'
import type { ProposedEscalation } from '../types'

export type SourceHealthState = 'OK' | 'STALE' | 'FAILING' | 'NOT_CONFIGURED' | 'DISABLED' | 'NEVER_SYNCED'

export interface SourceHealthRow {
  sourceConfigId: string
  displayName: string
  adapterKey: string
  category: string
  isEnabled: boolean
  state: SourceHealthState
  verification: string
  dataQuality: string
  consecutiveFailures: number
  stalenessHours: number
  ageHours: number | null
  freshnessLabel: string
  lastSuccessfulSync: Date | null
  lastFailureAt: Date | null
  lastFailureMessage: string | null
  nextRunAt: Date | null
}

export interface SourceHealthAssessment {
  sources: SourceHealthRow[]
  successful: SourceHealthRow[]
  failing: SourceHealthRow[]
  stale: SourceHealthRow[]
  notConfigured: SourceHealthRow[]
  warnings: string[]
  dataLimitations: string[]
  escalations: ProposedEscalation[]
}

export function sourceEscalationDedupeHint(sourceConfigId: string, condition: 'FAILING' | 'STALE'): string {
  return `opportunity-source-${condition.toLowerCase()}:${sourceConfigId}`
}

/**
 * Read every source configured for the tenant and classify it.
 *
 * Read-only: this never triggers a sync, never mutates a config, and never
 * promotes a verification state. The canonical hourly Section 6 `source-sync`
 * job remains the only thing that fetches from a provider on a schedule.
 */
export async function assessSourceHealth(
  consultingFirmId: string,
  now: Date = new Date(),
): Promise<SourceHealthAssessment> {
  const configs = await prisma.opportunitySourceConfig.findMany({
    where: { consultingFirmId },
    orderBy: { displayName: 'asc' },
    take: 200,
  })

  const sources: SourceHealthRow[] = configs.map((config) => {
    const freshness = deriveFreshness(
      { lastSuccessfulSync: config.lastSuccessfulSync, stalenessHours: config.stalenessHours, dataQuality: config.dataQuality },
      now,
    )

    let state: SourceHealthState
    if (config.verification === 'NOT_CONFIGURED') state = 'NOT_CONFIGURED'
    else if (!config.isEnabled) state = 'DISABLED'
    else if (config.consecutiveFailures >= SOURCE_FAILURE_ESCALATION_THRESHOLD) state = 'FAILING'
    else if (!config.lastSuccessfulSync) state = 'NEVER_SYNCED'
    else if (freshness.isStale) state = 'STALE'
    else state = 'OK'

    return {
      sourceConfigId: config.id,
      displayName: config.displayName,
      adapterKey: config.adapterKey,
      category: config.category,
      isEnabled: config.isEnabled,
      state,
      verification: config.verification,
      dataQuality: config.dataQuality,
      consecutiveFailures: config.consecutiveFailures,
      stalenessHours: config.stalenessHours,
      ageHours: freshness.ageHours,
      freshnessLabel: freshness.label,
      lastSuccessfulSync: config.lastSuccessfulSync,
      lastFailureAt: config.lastFailureAt,
      lastFailureMessage: config.lastFailureMessage,
      nextRunAt: config.nextRunAt,
    }
  })

  const failing = sources.filter((s) => s.state === 'FAILING')
  const stale = sources.filter((s) => s.state === 'STALE' || s.state === 'NEVER_SYNCED')
  const notConfigured = sources.filter((s) => s.state === 'NOT_CONFIGURED')
  const successful = sources.filter((s) => s.state === 'OK')

  const warnings: string[] = []
  const dataLimitations: string[] = []
  const escalations: ProposedEscalation[] = []

  for (const source of failing) {
    warnings.push(`${source.displayName} has failed ${source.consecutiveFailures} time(s) in a row.`)
    dataLimitations.push(`${source.displayName} is failing, so this brief may be missing opportunities from it.`)
    escalations.push({
      severity: 'HIGH',
      title: `Opportunity source failing: ${source.displayName}`,
      reason:
        `${source.displayName} (${source.adapterKey}) has ${source.consecutiveFailures} consecutive failures, ` +
        `at or beyond the ${SOURCE_FAILURE_ESCALATION_THRESHOLD}-failure threshold. ` +
        `Last error: ${source.lastFailureMessage ?? 'not recorded'}.`,
      recommendedAction: 'Check the source credentials, base URL and provider status, then re-run the sync.',
      entityType: 'OpportunitySourceConfig',
      entityId: source.sourceConfigId,
      // One item per (tenant, source, condition) — a re-run refreshes it rather
      // than queueing an identical second escalation.
      dedupeHint: sourceEscalationDedupeHint(source.sourceConfigId, 'FAILING'),
    })
  }

  for (const source of stale) {
    warnings.push(`${source.displayName}: ${source.freshnessLabel}.`)
    dataLimitations.push(
      `${source.displayName} has not synced successfully within its configured ${source.stalenessHours}h freshness window.`,
    )
    escalations.push({
      severity: 'MEDIUM',
      title: `Opportunity source stale: ${source.displayName}`,
      reason:
        `${source.displayName} is beyond its own ${source.stalenessHours}-hour staleness window. ` +
        `${source.freshnessLabel}.`,
      recommendedAction: 'Confirm the source is still reachable, then run a manual sync.',
      entityType: 'OpportunitySourceConfig',
      entityId: source.sourceConfigId,
      dedupeHint: sourceEscalationDedupeHint(source.sourceConfigId, 'STALE'),
    })
  }

  for (const source of notConfigured) {
    // Not configured is an honest, expected state — reported, never escalated.
    dataLimitations.push(`${source.displayName} is not configured, so it contributed nothing to this brief.`)
  }

  if (sources.length === 0) {
    dataLimitations.push('No opportunity sources are configured for this firm.')
  }

  return { sources, successful, failing, stale, notConfigured, warnings, dataLimitations, escalations }
}
