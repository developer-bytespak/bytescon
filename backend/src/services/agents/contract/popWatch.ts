// =============================================================
// §7.1 — Period-of-performance watch and modification impact monitoring.
//
// Both are read-only assessments. The agent NEVER closes a contract, extends
// dates, exercises an option, or applies a modification — the existing
// human-controlled Section 5 workflows stay authoritative. When a modification
// is recorded but not yet applied, the agent reports the impact it WOULD have
// (computed with the same `computeContractAfterMod` the apply path uses) and
// leaves the contract untouched.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { computeContractAfterMod } from '../../contractModification'
import { MODIFICATION_RECENT_DAYS, POP_APPROACHING_DAYS, type ContractHealthState } from './policy'
import type { EvidenceRef } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

export type PopState = 'ACTIVE' | 'APPROACHING_END' | 'EXPIRED' | 'OPTION_WINDOW' | 'NOT_STARTED' | 'INSUFFICIENT_DATA'

export interface PopAssessment {
  startDate: string | null
  endDate: string | null
  state: PopState
  daysRemaining: number | null
  health: ContractHealthState
  reasons: string[]
  evidence: EvidenceRef[]
}

/**
 * Derives the period-of-performance state from the contract's own dates.
 * `hasOpenOptionWindow` lets an imminent option decision take precedence over a
 * plain "approaching end", because that is the more actionable framing.
 */
export function assessPeriodOfPerformance(args: {
  contractId: string
  startDate: Date | null
  endDate: Date | null
  now: Date
  hasOpenOptionWindow: boolean
  openDeliverableCount: number
}): PopAssessment {
  const { startDate, endDate, now } = args
  const reasons: string[] = []

  if (!endDate) {
    return {
      startDate: startDate?.toISOString() ?? null,
      endDate: null,
      state: 'INSUFFICIENT_DATA',
      daysRemaining: null,
      health: 'INSUFFICIENT_DATA',
      reasons: ['No contract end date is recorded, so the period of performance cannot be assessed.'],
      evidence: [],
    }
  }

  const daysRemaining = Math.floor((endDate.getTime() - now.getTime()) / DAY_MS)

  let state: PopState
  let health: ContractHealthState = 'HEALTHY'

  if (startDate && startDate.getTime() > now.getTime()) {
    state = 'NOT_STARTED'
    reasons.push(`Performance has not started yet; it begins in ${Math.ceil((startDate.getTime() - now.getTime()) / DAY_MS)} day(s).`)
  } else if (daysRemaining < 0) {
    state = 'EXPIRED'
    health = 'CRITICAL'
    reasons.push(`The period of performance ended ${Math.abs(daysRemaining)} day(s) ago.`)
  } else if (daysRemaining <= POP_APPROACHING_DAYS) {
    state = args.hasOpenOptionWindow ? 'OPTION_WINDOW' : 'APPROACHING_END'
    health = 'ATTENTION'
    reasons.push(`The period of performance ends in ${daysRemaining} day(s).`)
    if (args.hasOpenOptionWindow) reasons.push('An option decision window is open for this contract.')
  } else {
    state = 'ACTIVE'
  }

  // The condition that actually matters: running out of time with work open.
  if ((state === 'EXPIRED' || state === 'APPROACHING_END' || state === 'OPTION_WINDOW') && args.openDeliverableCount > 0) {
    health = 'CRITICAL'
    reasons.push(`${args.openDeliverableCount} deliverable(s) are still open as the period of performance closes.`)
  }

  return {
    startDate: startDate?.toISOString() ?? null,
    endDate: endDate.toISOString(),
    state,
    daysRemaining,
    health,
    reasons,
    evidence: [
      {
        sourceType: 'Contract',
        sourceId: args.contractId,
        sourceLocator: `contract:${args.contractId}/dates`,
        retrievedAt: now.toISOString(),
        note: `Period of performance ${startDate?.toISOString().slice(0, 10) ?? 'unknown'} → ${endDate.toISOString().slice(0, 10)} (${daysRemaining} day(s) remaining).`,
      },
    ],
  }
}

export function popEscalationDedupeHint(contractId: string): string {
  return `contract-pop-expiring:${contractId}`
}

// -------------------------------------------------------------
// Modification impact
// -------------------------------------------------------------

export interface ModificationImpact {
  modificationId: string
  modNumber: string
  modType: string | null
  status: string
  appliedAt: string | null
  effectiveDate: string | null
  /** True when the modification is recorded but its effect is NOT yet in the contract totals. */
  isUnresolved: boolean
  fundingChange: string | null
  ceilingChange: string | null
  startDateChange: string | null
  endDateChange: string | null
  /** What the totals WOULD become. Projection only — never written by the agent. */
  projectedFundedValue: string | null
  projectedCeilingValue: string | null
  projectedStartDate: string | null
  projectedEndDate: string | null
  note: string
}

export interface ModificationAssessment {
  recent: ModificationImpact[]
  unresolvedImpacts: ModificationImpact[]
  health: ContractHealthState
  evidence: EvidenceRef[]
  warnings: string[]
}

/** A modification in one of these states has not yet moved the contract totals. */
const UNRESOLVED_STATUSES = new Set(['DRAFT', 'RECORDED'])

export async function assessModifications(args: {
  consultingFirmId: string
  contractId: string
  fundedValue: Prisma.Decimal | null
  ceilingValue: Prisma.Decimal | null
  startDate: Date | null
  endDate: Date | null
  now: Date
}): Promise<ModificationAssessment> {
  const { consultingFirmId, contractId, now } = args
  const since = new Date(now.getTime() - MODIFICATION_RECENT_DAYS * DAY_MS)

  const mods = await prisma.contractModification.findMany({
    where: {
      consultingFirmId,
      contractId,
      OR: [{ createdAt: { gte: since } }, { status: { in: ['DRAFT', 'RECORDED'] } }],
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })

  const assessment: ModificationAssessment = {
    recent: [],
    unresolvedImpacts: [],
    health: 'HEALTHY',
    evidence: [],
    warnings: [],
  }

  for (const m of mods) {
    const unresolved = UNRESOLVED_STATUSES.has(m.status) && m.appliedAt === null

    // Same function the human apply path uses — so the projection matches
    // exactly what applying it would do. Nothing is written here.
    const projected = unresolved
      ? computeContractAfterMod(
          { fundedValue: args.fundedValue, ceilingValue: args.ceilingValue, startDate: args.startDate, endDate: args.endDate },
          { fundingChange: m.fundingChange, ceilingChange: m.ceilingChange, startDateChange: m.startDateChange, endDateChange: m.endDateChange },
        )
      : null

    const impact: ModificationImpact = {
      modificationId: m.id,
      modNumber: m.modNumber,
      modType: m.modType,
      status: m.status,
      appliedAt: m.appliedAt?.toISOString() ?? null,
      effectiveDate: m.effectiveDate?.toISOString() ?? null,
      isUnresolved: unresolved,
      fundingChange: m.fundingChange ? m.fundingChange.toFixed(2) : null,
      ceilingChange: m.ceilingChange ? m.ceilingChange.toFixed(2) : null,
      startDateChange: m.startDateChange?.toISOString() ?? null,
      endDateChange: m.endDateChange?.toISOString() ?? null,
      projectedFundedValue: projected?.fundedValue ? projected.fundedValue.toFixed(2) : null,
      projectedCeilingValue: projected?.ceilingValue ? projected.ceilingValue.toFixed(2) : null,
      projectedStartDate: projected?.startDate?.toISOString() ?? null,
      projectedEndDate: projected?.endDate?.toISOString() ?? null,
      note: unresolved
        ? 'Recorded but not applied. The projected totals show what applying it would produce; the agent does not apply modifications.'
        : 'Already applied to the contract totals by a human action.',
    }

    assessment.recent.push(impact)
    if (unresolved) assessment.unresolvedImpacts.push(impact)
  }

  if (assessment.unresolvedImpacts.length > 0) {
    assessment.health = 'ATTENTION'
    assessment.warnings.push(
      `${assessment.unresolvedImpacts.length} modification(s) are recorded but not yet applied, so contract totals do not reflect them.`,
    )
    assessment.evidence.push({
      sourceType: 'ContractModification',
      sourceId: contractId,
      sourceLocator: `contract:${contractId}/modifications`,
      retrievedAt: now.toISOString(),
      note: `${assessment.unresolvedImpacts.length} unapplied modification(s) detected. Applying a modification remains a human action.`,
    })
  }

  return assessment
}

export function modificationEscalationDedupeHint(contractId: string): string {
  return `contract-unapplied-mods:${contractId}`
}
