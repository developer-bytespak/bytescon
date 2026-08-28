// =============================================================
// §7.1 — Option-period watch.
//
// Honesty rule that drives the whole module: an EXPLICIT recorded date always
// wins. Only when neither `decisionDate` nor `exerciseDeadline` exists may a
// window be derived from the option start, and that derived date is labelled
// INTERNAL_RECOMMENDATION — never presented as a government or contractual
// deadline. With no usable dates at all the answer is INSUFFICIENT_DATA, not a
// fabricated deadline.
//
// The agent may surface and escalate an approaching decision. It may NEVER
// exercise, decline or mark an option — that is a human decision.
// =============================================================
import { prisma } from '../../../config/database'
import { workingDaysBetween } from '../../milestones/workingDays'
// §7.2 moved the calendar builder up one level so the Opportunity Agent shares
// the exact same holiday arithmetic. Re-exported below: every existing caller
// and test of `optionWatch.buildWorkingCalendar` is unchanged.
import { buildWorkingCalendar, resetWorkingCalendarCache } from '../workingCalendar'
import { OPTION_DERIVED_LEAD_DAYS, OPTION_WINDOW_WORKING_DAYS, type ContractHealthState } from './policy'
import type { EvidenceRef } from '../types'

const DAY_MS = 24 * 60 * 60 * 1000

export type OptionDateBasis = 'EXERCISE_DEADLINE' | 'DECISION_DATE' | 'INTERNAL_RECOMMENDATION' | 'NONE'

export type OptionWindowState = 'FUTURE' | 'OPEN' | 'PAST' | 'CLOSED' | 'INSUFFICIENT_DATA'

export interface OptionWindow {
  optionPeriodId: string
  label: string
  exerciseStatus: string
  startDate: string | null
  endDate: string | null
  optionValue: string | null
  /** The date the window is measured against. */
  effectiveDecisionDate: string | null
  /** Where that date came from. INTERNAL_RECOMMENDATION is NOT a real deadline. */
  dateBasis: OptionDateBasis
  isInternalRecommendation: boolean
  workingDaysUntilDecision: number | null
  state: OptionWindowState
  ownerUserId: string | null
  reasons: string[]
}

export interface OptionAssessment {
  total: number
  upcomingDecisionWindows: OptionWindow[]
  openWindowCount: number
  missingOwnerCount: number
  insufficientDataCount: number
  health: ContractHealthState
  evidence: EvidenceRef[]
  warnings: string[]
}

/** Statuses where a decision has already been taken — no window to watch. */
const DECIDED_STATUSES = new Set(['EXERCISED', 'NOT_EXERCISED', 'EXPIRED'])

export { buildWorkingCalendar }

/** Test seam — clears the memoised calendar. Delegates to the shared module. */
export function __resetCalendarCache(): void {
  resetWorkingCalendarCache()
}

/**
 * Resolves the date a decision should be measured against, and says honestly
 * where it came from.
 */
export function resolveDecisionDate(option: {
  decisionDate: Date | null
  exerciseDeadline: Date | null
  startDate: Date | null
}): { date: Date | null; basis: OptionDateBasis } {
  // Explicit dates always win, deadline first (it is the harder constraint).
  if (option.exerciseDeadline) return { date: option.exerciseDeadline, basis: 'EXERCISE_DEADLINE' }
  if (option.decisionDate) return { date: option.decisionDate, basis: 'DECISION_DATE' }
  if (option.startDate) {
    return {
      date: new Date(option.startDate.getTime() - OPTION_DERIVED_LEAD_DAYS * DAY_MS),
      basis: 'INTERNAL_RECOMMENDATION',
    }
  }
  return { date: null, basis: 'NONE' }
}

export async function assessOptions(args: {
  consultingFirmId: string
  contractId: string
  contractOwnerUserId: string | null
  now: Date
}): Promise<OptionAssessment> {
  const { consultingFirmId, contractId, now } = args

  const options = await prisma.contractOptionPeriod.findMany({
    where: { consultingFirmId, contractId },
    orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
  })

  const calendar = await buildWorkingCalendar(consultingFirmId, now)

  const assessment: OptionAssessment = {
    total: options.length,
    upcomingDecisionWindows: [],
    openWindowCount: 0,
    missingOwnerCount: 0,
    insufficientDataCount: 0,
    health: 'HEALTHY',
    evidence: [],
    warnings: [],
  }

  for (const o of options) {
    const reasons: string[] = []
    const decided = DECIDED_STATUSES.has(o.exerciseStatus)

    const { date, basis } = resolveDecisionDate(o)
    let state: OptionWindowState
    let workingDaysUntil: number | null = null

    if (decided) {
      state = 'CLOSED'
      reasons.push(`Option is already ${o.exerciseStatus}; no decision window is being tracked.`)
    } else if (!date) {
      state = 'INSUFFICIENT_DATA'
      assessment.insufficientDataCount++
      reasons.push('No exercise deadline, decision date or option start date is recorded, so no decision window can be determined.')
    } else {
      workingDaysUntil = workingDaysBetween(now, date, calendar)
      if (date.getTime() < now.getTime()) {
        state = 'PAST'
        reasons.push('The decision date has already passed without a recorded decision.')
      } else if (workingDaysUntil <= OPTION_WINDOW_WORKING_DAYS) {
        state = 'OPEN'
        assessment.openWindowCount++
        reasons.push(`Decision is ${workingDaysUntil} working day(s) away, inside the ${OPTION_WINDOW_WORKING_DAYS}-working-day window.`)
      } else {
        state = 'FUTURE'
      }

      if (basis === 'INTERNAL_RECOMMENDATION') {
        reasons.push(
          `This date is an INTERNAL RECOMMENDATION derived ${OPTION_DERIVED_LEAD_DAYS} days before the option start. It is not a government or contractual deadline.`,
        )
      }
    }

    const ownerUserId = args.contractOwnerUserId
    if ((state === 'OPEN' || state === 'PAST') && !ownerUserId) {
      assessment.missingOwnerCount++
      reasons.push('No contract owner is assigned to make this decision.')
    }

    const window: OptionWindow = {
      optionPeriodId: o.id,
      label: o.label,
      exerciseStatus: o.exerciseStatus,
      startDate: o.startDate?.toISOString() ?? null,
      endDate: o.endDate?.toISOString() ?? null,
      optionValue: o.optionValue ? o.optionValue.toFixed(2) : null,
      effectiveDecisionDate: date?.toISOString() ?? null,
      dateBasis: basis,
      isInternalRecommendation: basis === 'INTERNAL_RECOMMENDATION',
      workingDaysUntilDecision: workingDaysUntil,
      state,
      ownerUserId,
      reasons,
    }

    // Only surface windows that a human might need to act on.
    if (state === 'OPEN' || state === 'PAST' || state === 'INSUFFICIENT_DATA') {
      assessment.upcomingDecisionWindows.push(window)
    } else if (state === 'FUTURE' && workingDaysUntil !== null && workingDaysUntil <= OPTION_WINDOW_WORKING_DAYS * 2) {
      assessment.upcomingDecisionWindows.push(window)
    }
  }

  if (assessment.missingOwnerCount > 0) assessment.health = 'CRITICAL'
  else if (assessment.openWindowCount > 0) assessment.health = 'ATTENTION'
  else if (assessment.insufficientDataCount > 0 && assessment.total > 0) assessment.health = 'INSUFFICIENT_DATA'

  if (assessment.total > 0) {
    assessment.evidence.push({
      sourceType: 'ContractOptionPeriod',
      sourceId: contractId,
      sourceLocator: `contract:${contractId}/options`,
      retrievedAt: now.toISOString(),
      note: `${assessment.total} option period(s): ${assessment.openWindowCount} decision window(s) open, ${assessment.insufficientDataCount} without usable dates. Explicit recorded dates always take precedence over derived recommendations.`,
    })
  }

  return assessment
}

export function optionEscalationDedupeHint(optionPeriodId: string, kind: 'MISSING_OWNER' | 'WINDOW_OPEN'): string {
  return `contract-option:${optionPeriodId}:${kind}`
}
