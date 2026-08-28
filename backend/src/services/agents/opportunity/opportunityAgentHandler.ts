// =============================================================
// §7.2 — Opportunity Agent handler.
//
// A plain async function on the §7.0 AgentContext/AgentResult contract. It owns
// no queue, no worker, no scheduler and no reaper — the shared runtime provides
// all of that.
//
// IT DOES NOT SYNC SOURCES ON A SCHEDULE. The canonical hourly `source-sync` job
// in section6Worker remains the ONLY scheduled provider fetch. This agent
// consumes and orchestrates the RESULTS of Section 6 discovery: it classifies,
// matches, evaluates profiles, detects re-competes and learns. A manual run may
// ask the canonical `runSourceSync` service to catch a source up, and even then
// it honours that service's own idempotency and due-ness rules rather than
// building a second ingestion path.
//
// FULLY DETERMINISTIC. This handler performs ZERO LLM calls: it never touches
// `ctx.budget.generate` or `generateWithRouter`, so it runs correctly with no
// provider configured and consumes no tokens. A regression test asserts the
// provider boundary is never reached.
//
// It never applies a learned weighting, verifies a capability, accepts a
// re-compete signal, confirms a forecast link, records a bid decision, or
// touches a MANUAL-origin opportunity's protected data. Those are human acts.
// =============================================================
import { EligibilityState, PursuitFeedbackStatus } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import { buildWorkingCalendar } from '../workingCalendar'
import { workingDaysBetween } from '../../milestones/workingDays'
import { classifyNotice } from '../../noticeClassification'
import { detectRecompetes } from '../../discovery/recompeteDetection'
import { linkForecastsToSolicitations } from '../../discovery/forecastIngest'
import { refreshFirmMatches } from '../../discovery/matchRefresh'
import { evaluateProfile } from '../../discovery/profileAlerts'
import { assessSourceHealth, type SourceHealthAssessment } from './sourceHealth'
import { analysePursuitFeedback, resolveEffectiveWeights } from './pursuitFeedback'
import {
  CAPABILITY_ENTITY_TYPE,
  PROFILE_ENTITY_TYPE,
  PURSUIT_ENTITY_TYPE,
  SOURCE_CONFIG_ENTITY_TYPE,
} from './opportunityEvents'
import {
  BRIEF_SECTION_LIMIT,
  CRITICAL_DEADLINE_WORKING_DAYS,
  CRITICAL_MATCH_SCORE,
  HIGH_MATCH_SCORE,
  LIVE_OPPORTUNITY_STATUSES,
  MAX_OPPORTUNITIES_PER_RUN,
  OPPORTUNITY_POLICY_DOC,
} from './policy'

export const OPPORTUNITY_AGENT_KEY = 'OPPORTUNITY' as const

/** Observable stages, in the order a full run performs them. */
export const OPPORTUNITY_PHASES = [
  'LOAD_CONTEXT',
  'CHECK_SOURCE_HEALTH',
  'PROCESS_CHANGED_OPPORTUNITIES',
  'CLASSIFY_NOTICES',
  'REFRESH_CAPABILITY_MATCHES',
  'REFRESH_ELIGIBILITY',
  'REFRESH_RECOMPETES',
  'EVALUATE_MONITORING_PROFILES',
  'ANALYZE_PURSUIT_FEEDBACK',
  'BUILD_OPPORTUNITY_BRIEF',
  'CREATE_ESCALATIONS',
  'COMPLETE',
] as const

export type OpportunityPhase = (typeof OPPORTUNITY_PHASES)[number]

/**
 * Which phases a run performs.
 *
 * An event-triggered run is deliberately narrow: a capability change does not
 * justify re-running re-compete detection across the whole portfolio, and a
 * profile save does not justify a full match refresh. The event's entity type
 * decides, so tenant-wide work only happens when tenant-wide work is warranted.
 */
export function phasesForRun(triggerEntityType: string | null): OpportunityPhase[] {
  const always: OpportunityPhase[] = ['LOAD_CONTEXT', 'CHECK_SOURCE_HEALTH', 'BUILD_OPPORTUNITY_BRIEF', 'CREATE_ESCALATIONS', 'COMPLETE']

  switch (triggerEntityType) {
    case CAPABILITY_ENTITY_TYPE:
      // Capabilities feed matching and eligibility, nothing else.
      return dedupe([...always.slice(0, 2), 'REFRESH_CAPABILITY_MATCHES', 'REFRESH_ELIGIBILITY', ...always.slice(2)])
    case PROFILE_ENTITY_TYPE:
      return dedupe([...always.slice(0, 2), 'EVALUATE_MONITORING_PROFILES', ...always.slice(2)])
    case PURSUIT_ENTITY_TYPE:
      return dedupe([...always.slice(0, 2), 'ANALYZE_PURSUIT_FEEDBACK', ...always.slice(2)])
    case SOURCE_CONFIG_ENTITY_TYPE:
      return dedupe([
        ...always.slice(0, 2),
        'PROCESS_CHANGED_OPPORTUNITIES',
        'CLASSIFY_NOTICES',
        'REFRESH_CAPABILITY_MATCHES',
        'REFRESH_ELIGIBILITY',
        'EVALUATE_MONITORING_PROFILES',
        ...always.slice(2),
      ])
    default:
      // Scheduled or manual tenant-wide run — everything.
      return [...OPPORTUNITY_PHASES]
  }
}

function dedupe(phases: OpportunityPhase[]): OpportunityPhase[] {
  return OPPORTUNITY_PHASES.filter((p) => phases.includes(p))
}

/** Unique, in canonical order. */
function uniquePhases(phases: OpportunityPhase[]): OpportunityPhase[] {
  const seen = new Set(phases)
  return OPPORTUNITY_PHASES.filter((p) => seen.has(p))
}

interface PhaseOutcome {
  phase: OpportunityPhase
  ok: boolean
  detail: string
  error?: string
}

export interface OpportunityBrief {
  generatedAt: string
  runId: string
  scope: string
  phases: OpportunityPhase[]
  tenantSummary: {
    liveOpportunities: number
    newOpportunities: number
    changedOpportunities: number
    highPriorityMatches: number
    criticalMatches: number
    preSolicitationCount: number
    recompeteCount: number
    forecastCount: number
  }
  highMatchOpportunities: HighMatchRow[]
  preSolicitation: PreSolicitationRow[]
  recompetes: RecompeteRow[]
  forecasts: ForecastRow[]
  pursuitLearning: {
    status: string
    sampleSize: number
    pursuedSampleSize: number
    ignoredSampleSize: number
    minimumSampleSize: number
    confidence: string
    proposedAdjustmentId: string | null
    appliedAdjustmentId: string | null
    effectiveWeightProfile: 'BASE' | 'PURSUIT_ADJUSTED'
    reason: string
  }
  sourceHealth: SourceHealthAssessment['sources']
  operations: {
    successfulSources: string[]
    failedSources: string[]
    staleSources: string[]
    notConfiguredSources: string[]
    successfulPhases: OpportunityPhase[]
    failedPhases: OpportunityPhase[]
  }
  alerts: Array<{ profileId: string; profileName: string; newAlerts: number; reAlerts: number; suppressed: number; notificationsSent: number; skippedReason?: string }>
  warnings: string[]
  dataLimitations: string[]
  policy: typeof OPPORTUNITY_POLICY_DOC
}

interface HighMatchRow {
  opportunityId: string
  title: string
  agency: string
  deadline: string | null
  source: string
  noticeType: string | null
  priority: 'HIGH' | 'CRITICAL'
  matchScore: number
  baseMatchScore: number | null
  weightProfile: string
  matchDimensions: Array<{ key: string; score: number | null; weight: number; baseWeight: number }>
  eligibility: string | null
  eligibilityReason: string | null
  certificationWarnings: string[]
  whyItMatched: string[]
  workingDaysToDeadline: number | null
  evidence: string[]
}

interface PreSolicitationRow {
  opportunityId: string
  title: string
  agency: string
  noticeType: string | null
  kind: string
  label: string
  basis: string
  responseDeadline: string | null
  capabilityFit: number | null
  eligibility: string | null
  whyEarlyResponseMayMatter: string | null
}

interface RecompeteRow {
  signalId: string
  sourceContractId: string | null
  incumbent: string | null
  agency: string | null
  contractNumber: string | null
  estimatedWindowStart: string | null
  estimatedWindowEnd: string | null
  confidence: string
  confidenceReason: string | null
  status: string
  requiresHumanAcceptance: boolean
}

interface ForecastRow {
  forecastId: string
  title: string
  agency: string
  anticipatedSolicitationDate: string | null
  linkState: string
  linkedOpportunityId: string | null
  /** 0–1 similarity recorded by §6.1B. Null when no candidate was evaluated. */
  linkConfidence: number | null
  requiresHumanConfirmation: boolean
  note: string
}

/**
 * The agent entry point.
 *
 * Every phase is individually isolated: one failing source, opportunity,
 * profile, forecast or re-compete calculation degrades the run to PARTIAL data
 * sufficiency with an honest limitation, it does not fail the whole run.
 */
export async function opportunityAgentHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  // OBSERVE may compute and persist artifacts but must not notify. PROPOSE and
  // above may evaluate profiles (which notify) and raise escalations.
  const mayAct = ctx.autonomyLevel !== 'OBSERVE'

  const phases = phasesForRun(ctx.triggerEntityType)
  const outcomes: PhaseOutcome[] = []
  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []

  ctx.log('opportunity agent scope resolved', {
    phases: phases.length,
    triggerEntityType: ctx.triggerEntityType,
    mayAct,
  })

  let completed = 0
  const step = async <T>(phase: OpportunityPhase, fn: () => Promise<T>, describe: (r: T) => string): Promise<T | null> => {
    if (!phases.includes(phase)) return null
    if (ctx.signal.aborted) {
      outcomes.push({ phase, ok: false, detail: 'cancelled before this phase ran' })
      return null
    }
    try {
      const result = await fn()
      outcomes.push({ phase, ok: true, detail: describe(result) })
      return result
    } catch (err) {
      const message = (err as Error).message
      outcomes.push({ phase, ok: false, detail: 'failed', error: message })
      warnings.push(`Phase ${phase} failed: ${message}`)
      limitations.push(`${phase} could not complete, so this brief may be incomplete in that area.`)
      logger.error('Opportunity agent phase failed (continuing)', {
        phase, runId: ctx.runId, error: message,
      })
      return null
    } finally {
      completed++
      await ctx.heartbeat(Math.round((completed / phases.length) * 100), phase).catch(() => undefined)
    }
  }

  // --- LOAD_CONTEXT ------------------------------------------------
  const context = await step(
    'LOAD_CONTEXT',
    async () => loadTenantContext(ctx.consultingFirmId, now),
    (r) => `${r.liveOpportunities} live opportunit(ies), ${r.profileCount} active profile(s)`,
  )

  // --- CHECK_SOURCE_HEALTH -----------------------------------------
  const health = await step(
    'CHECK_SOURCE_HEALTH',
    async () => assessSourceHealth(ctx.consultingFirmId, now),
    (r) => `${r.successful.length} healthy, ${r.failing.length} failing, ${r.stale.length} stale`,
  )
  if (health) {
    warnings.push(...health.warnings)
    limitations.push(...health.dataLimitations)
    escalations.push(...health.escalations)
    for (const source of health.sources) {
      evidence.push({
        sourceType: 'OpportunitySourceConfig',
        sourceId: source.sourceConfigId,
        sourceLocator: source.adapterKey,
        retrievedAt: now.toISOString(),
        note: `${source.state} — ${source.freshnessLabel}`,
      })
    }
  }

  // --- PROCESS_CHANGED_OPPORTUNITIES + CLASSIFY_NOTICES -------------
  // Classification is recomputed from the authoritative feed notice type. It
  // updates only the derived `presolicitationKind` column, never a MANUAL
  // record's protected content.
  const classified = await step(
    'CLASSIFY_NOTICES',
    async () => reclassifyNotices(ctx.consultingFirmId, ctx.triggerEntityId, ctx.triggerEntityType),
    (r) => `${r.updated} of ${r.examined} notice classification(s) refreshed`,
  )

  // --- REFRESH_CAPABILITY_MATCHES + REFRESH_ELIGIBILITY -------------
  // One call refreshes both: §6.1E computes the match and §6.1F computes the
  // eligibility inside the same canonical service. They are reported as two
  // phases because they answer two different questions.
  const matches = await step(
    'REFRESH_CAPABILITY_MATCHES',
    async () => refreshFirmMatches(ctx.consultingFirmId, { limit: MAX_OPPORTUNITIES_PER_RUN, now }),
    (r) => `${r.refreshed} match(es) refreshed`,
  )
  if (matches && phases.includes('REFRESH_ELIGIBILITY')) {
    outcomes.push({
      phase: 'REFRESH_ELIGIBILITY',
      ok: true,
      detail: `${matches.eligibleCount} eligible, ${matches.insufficientData} with insufficient matching data`,
    })
    if (matches.insufficientData > 0) {
      limitations.push(
        `${matches.insufficientData} opportunit(ies) could not be scored on enough dimensions to be presented as reliable.`,
      )
    }
  }

  // --- REFRESH_RECOMPETES -------------------------------------------
  const recompetes = await step(
    'REFRESH_RECOMPETES',
    async () => detectRecompetes(ctx.consultingFirmId, { now }),
    (r) => `${r.created} created, ${r.updated} updated, ${r.skippedVerified} human-verified signal(s) left untouched`,
  )

  // Forecast linking runs alongside re-compete detection. It may propose a link
  // but an ambiguous one stays REVIEW_REQUIRED for a human — §6.1B's rule.
  const forecastLinks = await step(
    'REFRESH_RECOMPETES',
    async () => linkForecastsToSolicitations(ctx.consultingFirmId, now),
    (r) => `${r.autoLinked} forecast(s) auto-linked, ${r.flaggedForReview} flagged for human review`,
  )

  // --- EVALUATE_MONITORING_PROFILES ---------------------------------
  const alertResults = await step(
    'EVALUATE_MONITORING_PROFILES',
    async () => evaluateProfiles(ctx, now, mayAct),
    (r) => `${r.length} profile(s) evaluated`,
  )
  if (!mayAct && phases.includes('EVALUATE_MONITORING_PROFILES')) {
    limitations.push('Autonomy is OBSERVE, so monitoring profiles were not evaluated and no alerts were sent.')
  }

  // --- ANALYZE_PURSUIT_FEEDBACK -------------------------------------
  const learning = await step(
    'ANALYZE_PURSUIT_FEEDBACK',
    async () => analysePursuitFeedback({ consultingFirmId: ctx.consultingFirmId, runId: ctx.runId, now }),
    (r) => `${r.status} on ${r.computation.sampleSize} labelled decision(s)`,
  )
  const effective = await resolveEffectiveWeights(ctx.consultingFirmId)
  if (learning && learning.status === PursuitFeedbackStatus.PROPOSED && learning.created) {
    // Surfaced, never applied. Applying is an ADMIN action through the API.
    escalations.push({
      severity: 'INFO',
      title: 'Pursuit-preference adjustment proposed',
      reason:
        `${learning.computation.sampleSize} labelled decision(s) (${learning.computation.pursuedSampleSize} pursued, ` +
        `${learning.computation.ignoredSampleSize} declined) suggest a bounded change to opportunity ranking. ` +
        'Production matching is unchanged until an administrator applies it.',
      recommendedAction: 'Review the proposed weighting on /discovery and apply or dismiss it.',
      entityType: 'PursuitFeedbackSignal',
      entityId: learning.signalId,
      dedupeHint: `pursuit-feedback-proposed:${learning.signalId}`,
    })
  }

  // --- BUILD_OPPORTUNITY_BRIEF --------------------------------------
  const artifacts: ProposedArtifact[] = []
  const brief = await step(
    'BUILD_OPPORTUNITY_BRIEF',
    async () =>
      buildBrief({
        ctx,
        now,
        phases,
        health,
        learning,
        effective,
        alertResults: alertResults ?? [],
        warnings,
        limitations,
        outcomes,
        context,
      }),
    (r) => `${r.highMatchOpportunities.length} high-priority match(es)`,
  )

  if (brief) {
    artifacts.push({
      artifactType: 'OPPORTUNITY_BRIEF',
      title: `Opportunity brief — ${now.toISOString().slice(0, 10)}`,
      summary: buildSummaryLine(brief),
      structuredData: brief as unknown as Record<string, unknown>,
      evidence,
      sourceEntityType: 'ConsultingFirm',
      sourceEntityId: ctx.consultingFirmId,
      confidenceState: health && health.failing.length > 0 ? 'MEDIUM' : 'HIGH',
      // One current brief per tenant; earlier ones are superseded rather than
      // overwritten, so the history stays intact and the every-2-hour cadence
      // does not accumulate identical live artifacts.
      supersedeKey: `opportunity-brief:${ctx.consultingFirmId}`,
    })

    escalations.push(...buildDeadlineEscalations(brief))
  }

  // --- CREATE_ESCALATIONS + COMPLETE --------------------------------
  if (phases.includes('CREATE_ESCALATIONS')) {
    outcomes.push({ phase: 'CREATE_ESCALATIONS', ok: true, detail: `${escalations.length} condition(s) raised` })
  }

  const failedPhases = outcomes.filter((o) => !o.ok)
  const cancelled = ctx.signal.aborted
  if (cancelled) limitations.push('The run was cancelled before every phase completed.')

  // A run is only FAILED when it produced no meaningful result at all. A
  // partially-degraded run reports COMPLETED with honest warnings, because a
  // brief built from three of four sources is still useful.
  const producedResult = brief !== null
  const status = producedResult ? 'COMPLETED' : 'FAILED'

  return {
    status,
    summary: brief
      ? buildSummaryLine(brief) + (failedPhases.length ? ` ${failedPhases.length} phase(s) degraded.` : '')
      : 'The opportunity brief could not be produced. See warnings for the failing phase.',
    confidence: !producedResult ? 'LOW' : failedPhases.length > 0 ? 'MEDIUM' : 'HIGH',
    dataSufficiency: !producedResult
      ? 'INSUFFICIENT'
      : failedPhases.length > 0 || limitations.length > 0
        ? 'PARTIAL'
        : 'SUFFICIENT',
    evidence,
    artifacts,
    escalations,
    metrics: {
      phasesPlanned: phases.length,
      phasesSucceeded: outcomes.filter((o) => o.ok).length,
      phasesFailed: failedPhases.length,
      sourcesHealthy: health?.successful.length ?? 0,
      sourcesFailing: health?.failing.length ?? 0,
      sourcesStale: health?.stale.length ?? 0,
      noticesReclassified: classified?.updated ?? 0,
      matchesRefreshed: matches?.refreshed ?? 0,
      eligibleOpportunities: matches?.eligibleCount ?? 0,
      recompetesCreated: recompetes?.created ?? 0,
      forecastsFlaggedForReview: forecastLinks?.flaggedForReview ?? 0,
      profilesEvaluated: alertResults?.length ?? 0,
      newProfileAlerts: (alertResults ?? []).reduce((s, a) => s + a.newAlerts, 0),
      highPriorityMatches: brief?.tenantSummary.highPriorityMatches ?? 0,
      criticalMatches: brief?.tenantSummary.criticalMatches ?? 0,
      pursuitSampleSize: learning?.computation.sampleSize ?? 0,
      escalationsRaised: escalations.length,
    },
    warnings,
    limitations,
    inputSnapshot: {
      scope: ctx.triggerEntityId ?? 'TENANT',
      triggerEntityType: ctx.triggerEntityType,
      phases,
      autonomyLevel: ctx.autonomyLevel,
      weightProfile: effective.profile,
    },
    // Materially-derived: two runs over the same opportunity surface, the same
    // source health and the same learning fingerprint hash identically, so an
    // unchanged 2-hourly re-run is recognisably the same input.
    inputHash: buildInputHash({
      consultingFirmId: ctx.consultingFirmId,
      scope: ctx.triggerEntityId ?? 'TENANT',
      liveOpportunities: context?.liveOpportunities ?? 0,
      lastChangeAt: context?.lastChangeAt ?? null,
      sourceStates: (health?.sources ?? []).map((s) => `${s.sourceConfigId}:${s.state}`),
      learningHash: learning?.computation.inputHash ?? 'none',
      weightProfile: effective.profile,
    }),
  }
}

// -------------------------------------------------------------
// Phase implementations
// -------------------------------------------------------------

interface TenantContext {
  liveOpportunities: number
  newOpportunities: number
  changedOpportunities: number
  profileCount: number
  lastChangeAt: string | null
}

const CHANGE_WINDOW_HOURS = 48

async function loadTenantContext(consultingFirmId: string, now: Date): Promise<TenantContext> {
  const since = new Date(now.getTime() - CHANGE_WINDOW_HOURS * 3600_000)
  const [liveOpportunities, newOpportunities, changedOpportunities, profileCount, latest] = await Promise.all([
    prisma.opportunity.count({
      where: { consultingFirmId, isDemo: false, status: { in: [...LIVE_OPPORTUNITY_STATUSES] } },
    }),
    prisma.opportunity.count({
      where: { consultingFirmId, isDemo: false, sourceFirstSeenAt: { gte: since } },
    }),
    prisma.opportunity.count({
      where: { consultingFirmId, isDemo: false, sourceUpdatedAt: { gte: since } },
    }),
    prisma.savedMonitoringProfile.count({ where: { consultingFirmId, isActive: true, isArchived: false } }),
    prisma.opportunity.findFirst({
      where: { consultingFirmId, isDemo: false },
      orderBy: { updatedAt: 'desc' },
      select: { updatedAt: true },
    }),
  ])
  return {
    liveOpportunities,
    newOpportunities,
    changedOpportunities,
    profileCount,
    lastChangeAt: latest?.updatedAt.toISOString() ?? null,
  }
}

/**
 * Recompute the derived pre-solicitation classification.
 *
 * The feed's own notice type stays authoritative — `classifyNotice` only falls
 * back to the title when the feed supplied nothing. Only the derived column is
 * written, so a MANUAL record's human-maintained content is untouched.
 */
async function reclassifyNotices(
  consultingFirmId: string,
  triggerEntityId: string | null,
  triggerEntityType: string | null,
): Promise<{ examined: number; updated: number }> {
  const opportunities = await prisma.opportunity.findMany({
    where: {
      consultingFirmId,
      isDemo: false,
      status: { in: [...LIVE_OPPORTUNITY_STATUSES] },
      ...(triggerEntityType === SOURCE_CONFIG_ENTITY_TYPE && triggerEntityId
        ? { sourceConfigId: triggerEntityId }
        : {}),
    },
    select: { id: true, noticeType: true, title: true, presolicitationKind: true },
    orderBy: { sourceLastSeenAt: 'desc' },
    take: MAX_OPPORTUNITIES_PER_RUN,
  })

  let updated = 0
  for (const opp of opportunities) {
    const classification = classifyNotice(opp.noticeType, opp.title)
    if (classification.kind === opp.presolicitationKind) continue
    await prisma.opportunity.update({
      where: { id: opp.id },
      data: { presolicitationKind: classification.kind },
    })
    updated++
  }
  return { examined: opportunities.length, updated }
}

interface ProfileAlertRow {
  profileId: string
  profileName: string
  newAlerts: number
  reAlerts: number
  suppressed: number
  notificationsSent: number
  skippedReason?: string
}

/**
 * Evaluate the tenant's saved profiles through the canonical §6.1G service.
 *
 * Dedupe, DAILY/WEEKLY digest grouping and DISABLED handling all belong to that
 * service and are not re-implemented here. Per-profile failure is isolated.
 */
async function evaluateProfiles(ctx: AgentExecutionContext, now: Date, mayAct: boolean): Promise<ProfileAlertRow[]> {
  if (!mayAct) return []

  const targeted = ctx.triggerEntityType === PROFILE_ENTITY_TYPE && ctx.triggerEntityId
  const profiles = await prisma.savedMonitoringProfile.findMany({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      isActive: true,
      isArchived: false,
      alertFrequency: { not: 'DISABLED' },
      ...(targeted ? { id: ctx.triggerEntityId as string } : {}),
      // Respect the cadence the profile itself declares — a 2-hourly agent must
      // not turn a DAILY profile into a 2-hourly one.
      ...(targeted ? {} : { OR: [{ nextEvaluationAt: null }, { nextEvaluationAt: { lte: now } }] }),
    },
    select: { id: true, name: true },
    take: 50,
  })

  const rows: ProfileAlertRow[] = []
  for (const profile of profiles) {
    if (ctx.signal.aborted) break
    try {
      const result = await evaluateProfile(profile.id, { now })
      rows.push({
        profileId: profile.id,
        profileName: profile.name,
        newAlerts: result.newAlerts,
        reAlerts: result.reAlerts,
        suppressed: result.suppressed,
        notificationsSent: result.notificationsSent,
        ...(result.skippedReason ? { skippedReason: result.skippedReason } : {}),
      })
    } catch (err) {
      logger.error('Opportunity agent profile evaluation failed (continuing)', {
        profileId: profile.id, runId: ctx.runId, error: (err as Error).message,
      })
      rows.push({
        profileId: profile.id,
        profileName: profile.name,
        newAlerts: 0, reAlerts: 0, suppressed: 0, notificationsSent: 0,
        skippedReason: `Evaluation failed: ${(err as Error).message}`,
      })
    }
  }
  return rows
}

// -------------------------------------------------------------
// Brief assembly
// -------------------------------------------------------------

async function buildBrief(args: {
  ctx: AgentExecutionContext
  now: Date
  phases: OpportunityPhase[]
  health: SourceHealthAssessment | null
  learning: Awaited<ReturnType<typeof analysePursuitFeedback>> | null
  effective: Awaited<ReturnType<typeof resolveEffectiveWeights>>
  alertResults: ProfileAlertRow[]
  warnings: string[]
  limitations: string[]
  outcomes: PhaseOutcome[]
  context: TenantContext | null
}): Promise<OpportunityBrief> {
  const { ctx, now, health, learning, effective, context } = args
  const calendar = await buildWorkingCalendar(ctx.consultingFirmId, now)

  const [scored, presolicitations, recompeteRows, forecastRows] = await Promise.all([
    prisma.opportunity.findMany({
      where: {
        consultingFirmId: ctx.consultingFirmId,
        isDemo: false,
        status: { in: [...LIVE_OPPORTUNITY_STATUSES] },
        match: { overallScore: { gte: HIGH_MATCH_SCORE } },
      },
      select: {
        id: true, title: true, agency: true, responseDeadline: true, source: true, noticeType: true,
        match: true,
      },
      orderBy: { responseDeadline: 'asc' },
      take: BRIEF_SECTION_LIMIT,
    }),
    prisma.opportunity.findMany({
      where: {
        consultingFirmId: ctx.consultingFirmId,
        isDemo: false,
        status: { in: [...LIVE_OPPORTUNITY_STATUSES] },
        presolicitationKind: { not: null },
      },
      select: {
        id: true, title: true, agency: true, noticeType: true, presolicitationKind: true,
        responseDeadline: true, match: { select: { overallScore: true, eligibility: true } },
      },
      orderBy: { responseDeadline: 'asc' },
      take: BRIEF_SECTION_LIMIT,
    }),
    prisma.recompeteSignal.findMany({
      where: { consultingFirmId: ctx.consultingFirmId },
      orderBy: { windowStart: 'asc' },
      take: BRIEF_SECTION_LIMIT,
      select: {
        id: true, sourceContractId: true, incumbentName: true, agency: true, contractNumber: true,
        windowStart: true, windowEnd: true, confidence: true, confidenceReason: true, verification: true,
      },
    }),
    prisma.agencyForecast.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, isArchived: false },
      orderBy: { anticipatedSolicitationDate: 'asc' },
      take: BRIEF_SECTION_LIMIT,
      select: {
        id: true, title: true, agency: true, anticipatedSolicitationDate: true,
        linkState: true, linkedOpportunityId: true, linkConfidence: true,
      },
    }),
  ])

  const highMatchOpportunities: HighMatchRow[] = scored.map((opp) => {
    const match = opp.match
    const score = match?.overallScore ?? 0
    const priority: 'HIGH' | 'CRITICAL' = score >= CRITICAL_MATCH_SCORE ? 'CRITICAL' : 'HIGH'
    const matchEvidence = (match?.evidence ?? {}) as {
      dimensions?: Array<{ key: string; score: number | null; weight: number; baseWeight: number; evidence: string }>
      weightProfile?: string
      baseOverallScore?: number
    }
    const dimensions = matchEvidence.dimensions ?? []
    const classification = classifyNotice(opp.noticeType, opp.title)

    return {
      opportunityId: opp.id,
      title: opp.title,
      agency: opp.agency,
      deadline: opp.responseDeadline?.toISOString() ?? null,
      source: opp.source,
      noticeType: opp.noticeType,
      priority,
      matchScore: score,
      baseMatchScore: matchEvidence.baseOverallScore ?? null,
      weightProfile: matchEvidence.weightProfile ?? 'BASE',
      matchDimensions: dimensions.map((d) => ({ key: d.key, score: d.score, weight: d.weight, baseWeight: d.baseWeight })),
      eligibility: match?.eligibility ?? null,
      eligibilityReason: match?.eligibilityReason ?? null,
      certificationWarnings: buildCertificationWarnings(match, classification.label),
      // Ranked strongest first, so "why" is the evidence rather than an assertion.
      whyItMatched: dimensions
        .filter((d) => typeof d.score === 'number' && (d.score as number) > 0)
        .sort((a, b) => (b.score as number) * b.weight - (a.score as number) * a.weight)
        .slice(0, 3)
        .map((d) => d.evidence),
      workingDaysToDeadline: opp.responseDeadline ? workingDaysBetween(now, opp.responseDeadline, calendar) : null,
      evidence: match?.dataLimitations ?? [],
    }
  })

  const preSolicitation: PreSolicitationRow[] = presolicitations.map((opp) => {
    const classification = classifyNotice(opp.noticeType, opp.title)
    return {
      opportunityId: opp.id,
      title: opp.title,
      agency: opp.agency,
      noticeType: opp.noticeType,
      kind: opp.presolicitationKind ?? classification.kind ?? 'UNKNOWN',
      label: classification.label,
      basis: classification.basis,
      responseDeadline: opp.responseDeadline?.toISOString() ?? null,
      capabilityFit: opp.match?.overallScore ?? null,
      eligibility: opp.match?.eligibility ?? null,
      // Verbatim from §6.1D, which is deliberately conditional and never claims
      // that responding influences the requirement or wins the work.
      whyEarlyResponseMayMatter: classification.whyEarlyResponseMayMatter,
    }
  })

  const recompetes: RecompeteRow[] = recompeteRows.map((r) => ({
    signalId: r.id,
    sourceContractId: r.sourceContractId,
    incumbent: r.incumbentName,
    agency: r.agency,
    contractNumber: r.contractNumber,
    estimatedWindowStart: r.windowStart?.toISOString() ?? null,
    estimatedWindowEnd: r.windowEnd?.toISOString() ?? null,
    confidence: r.confidence,
    confidenceReason: r.confidenceReason,
    status: r.verification,
    requiresHumanAcceptance: r.verification === 'UNVERIFIED',
  }))

  const forecasts: ForecastRow[] = forecastRows.map((f) => ({
    forecastId: f.id,
    title: f.title,
    agency: f.agency,
    anticipatedSolicitationDate: f.anticipatedSolicitationDate?.toISOString() ?? null,
    linkState: f.linkState,
    linkedOpportunityId: f.linkedOpportunityId,
    linkConfidence: f.linkConfidence,
    requiresHumanConfirmation: f.linkState === 'REVIEW_REQUIRED',
    note: 'A forecast is an agency planning record, not a released solicitation.',
  }))

  return {
    generatedAt: now.toISOString(),
    runId: ctx.runId,
    scope: ctx.triggerEntityId ?? 'TENANT',
    phases: args.phases,
    tenantSummary: {
      liveOpportunities: context?.liveOpportunities ?? 0,
      newOpportunities: context?.newOpportunities ?? 0,
      changedOpportunities: context?.changedOpportunities ?? 0,
      highPriorityMatches: highMatchOpportunities.filter((o) => o.priority === 'HIGH').length,
      criticalMatches: highMatchOpportunities.filter((o) => o.priority === 'CRITICAL').length,
      preSolicitationCount: preSolicitation.length,
      recompeteCount: recompetes.length,
      forecastCount: forecasts.length,
    },
    highMatchOpportunities,
    preSolicitation,
    recompetes,
    forecasts,
    pursuitLearning: {
      status: learning?.status ?? 'NOT_ANALYSED',
      sampleSize: learning?.computation.sampleSize ?? 0,
      pursuedSampleSize: learning?.computation.pursuedSampleSize ?? 0,
      ignoredSampleSize: learning?.computation.ignoredSampleSize ?? 0,
      minimumSampleSize: OPPORTUNITY_POLICY_DOC.minimumSampleSize,
      confidence: learning?.computation.confidenceState ?? 'INSUFFICIENT_DATA',
      proposedAdjustmentId:
        learning && learning.status === PursuitFeedbackStatus.PROPOSED ? learning.signalId : null,
      appliedAdjustmentId: effective.appliedSignalId,
      effectiveWeightProfile: effective.profile,
      reason: learning?.computation.summary ?? 'Pursuit feedback was not analysed on this run.',
    },
    sourceHealth: health?.sources ?? [],
    operations: {
      successfulSources: (health?.successful ?? []).map((s) => s.displayName),
      failedSources: (health?.failing ?? []).map((s) => s.displayName),
      staleSources: (health?.stale ?? []).map((s) => s.displayName),
      notConfiguredSources: (health?.notConfigured ?? []).map((s) => s.displayName),
      // De-duplicated: forecast linking is reported under REFRESH_RECOMPETES, so
      // the same phase can produce two outcomes. A phase counts as failed if ANY
      // of its steps failed, so a failure can never be masked by a sibling
      // success on the same label.
      successfulPhases: uniquePhases(args.outcomes.filter((o) => o.ok).map((o) => o.phase))
        .filter((p) => !args.outcomes.some((o) => !o.ok && o.phase === p)),
      failedPhases: uniquePhases(args.outcomes.filter((o) => !o.ok).map((o) => o.phase)),
    },
    alerts: args.alertResults,
    warnings: args.warnings,
    dataLimitations: args.limitations,
    policy: OPPORTUNITY_POLICY_DOC,
  }
}

function buildCertificationWarnings(
  match: { eligibility: EligibilityState; eligibilityReason: string | null; expiringCertificationIds: string[] } | null,
  noticeLabel: string,
): string[] {
  if (!match) return []
  const out: string[] = []
  if (match.eligibility === EligibilityState.EXPIRING_BEFORE_DEADLINE) {
    out.push(
      `A certification this ${noticeLabel} relies on expires before the response deadline. ${match.eligibilityReason ?? ''}`.trim(),
    )
  }
  if (match.eligibility === EligibilityState.POSSIBLY_ELIGIBLE) {
    out.push(`Eligibility could not be confirmed from stored records. ${match.eligibilityReason ?? ''}`.trim())
  }
  if (match.eligibility === EligibilityState.INSUFFICIENT_DATA) {
    out.push('There is not enough registration or certification data to assess eligibility for this set-aside.')
  }
  if (match.expiringCertificationIds.length > 0) {
    out.push(`${match.expiringCertificationIds.length} relevant certification(s) expire before this deadline.`)
  }
  return out
}

/**
 * Escalate a CRITICAL-priority match inside the working-day deadline window.
 *
 * Suppressed when the opportunity has no deadline, is no longer a critical
 * match, or the eligibility position rules it out. Working days only — a naive
 * calendar subtraction would fire over a holiday weekend.
 */
export function buildDeadlineEscalations(brief: OpportunityBrief): ProposedEscalation[] {
  const out: ProposedEscalation[] = []
  for (const row of brief.highMatchOpportunities) {
    if (row.priority !== 'CRITICAL') continue
    if (!row.deadline || row.workingDaysToDeadline === null) continue
    if (row.workingDaysToDeadline > CRITICAL_DEADLINE_WORKING_DAYS) continue
    if (row.eligibility === EligibilityState.NOT_ELIGIBLE) continue

    out.push({
      severity: row.workingDaysToDeadline <= 2 ? 'CRITICAL' : 'HIGH',
      title: `Critical match closing in ${row.workingDaysToDeadline} working day(s): ${row.title}`,
      reason:
        `${row.title} (${row.agency}) scores ${row.matchScore} — at or above the ${CRITICAL_MATCH_SCORE} critical threshold — ` +
        `and closes on ${row.deadline.slice(0, 10)}, ${row.workingDaysToDeadline} working day(s) away ` +
        `(weekends and US federal holidays excluded). Eligibility: ${row.eligibility ?? 'not determined'}. ` +
        (row.certificationWarnings.length ? `Warnings: ${row.certificationWarnings.join(' ')}` : '') +
        ` Why it matched: ${row.whyItMatched.join(' ') || 'see the match evidence.'}`,
      recommendedAction: 'Decide whether to pursue. The agent never records a bid decision.',
      entityType: 'Opportunity',
      entityId: row.opportunityId,
      // Stable per (tenant, opportunity, condition) — a re-run refreshes rather
      // than queueing an identical second item.
      dedupeHint: `opportunity-critical-deadline:${row.opportunityId}`,
    })
  }
  return out
}

function buildSummaryLine(brief: OpportunityBrief): string {
  const bits: string[] = []
  bits.push(`${brief.tenantSummary.liveOpportunities} live opportunit(ies)`)
  if (brief.tenantSummary.criticalMatches) bits.push(`${brief.tenantSummary.criticalMatches} critical match(es)`)
  if (brief.tenantSummary.highPriorityMatches) bits.push(`${brief.tenantSummary.highPriorityMatches} high match(es)`)
  if (brief.tenantSummary.preSolicitationCount) bits.push(`${brief.tenantSummary.preSolicitationCount} pre-solicitation notice(s)`)
  if (brief.tenantSummary.recompeteCount) bits.push(`${brief.tenantSummary.recompeteCount} re-compete signal(s)`)
  if (brief.operations.failedSources.length) bits.push(`${brief.operations.failedSources.length} source(s) failing`)
  return bits.join(' · ')
}

function buildInputHash(parts: Record<string, unknown>): string {
  // Not a cryptographic requirement — a stable, readable digest is enough for
  // the runtime's skip-if-unchanged comparison.
  const raw = JSON.stringify(parts)
  let hash = 0
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0
  }
  return `opportunity:${parts.consultingFirmId}:${parts.scope}:${(hash >>> 0).toString(16)}`
}
