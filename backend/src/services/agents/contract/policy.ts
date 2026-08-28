// =============================================================
// §7.1 — Contract Administration policy.
//
// EVERY threshold, lead time and health rule for this agent lives here. The
// brief is explicit: no magic percentages scattered across the handler, routes
// and frontend. The backend is authoritative; the UI renders what this decides.
//
// Where Section 5 already defines a canonical threshold it is REUSED rather
// than restated. `contractFinance.computeBurn` already treats 0.9 as the
// funding/ceiling "low" line (its `fundingLowThresholdPct` default) and emits
// the FinancialWarning vocabulary — so FUNDING_WARNING_PCT below is that same
// number, imported by value, and the only genuinely new figure is the tighter
// CRITICAL band this agent needs to distinguish "watch" from "act now".
//
// Fully deterministic. No LLM is used anywhere in this agent.
// =============================================================

/**
 * Section 5 canonical "low" line, matching `computeBurn`'s default
 * `fundingLowThresholdPct`. Changing this changes both surfaces together, which
 * is the point of having one constant.
 */
export const FUNDING_WARNING_PCT = 0.9

/** New in §7.1: the band at which remaining funding needs action, not watching. */
export const FUNDING_CRITICAL_PCT = 0.98

/** Ceiling uses the same bands — a ceiling breach is at least as serious. */
export const CEILING_WARNING_PCT = FUNDING_WARNING_PCT
export const CEILING_CRITICAL_PCT = FUNDING_CRITICAL_PCT

/** Reminder ladder lead days for contract deliverables (descending firing). */
export const DELIVERABLE_LEAD_DAYS = [14, 7, 3]

/** Hours past a deliverable's due date before escalation widens beyond the owner. */
export const DELIVERABLE_ESCALATE_AFTER_HOURS = 24

/** A deliverable inside this many days is reported as "due soon" on the health card. */
export const DELIVERABLE_DUE_SOON_DAYS = 14

/**
 * Working days before an AUTHORITATIVE option decision date at which the
 * decision window is considered open and the owner is alerted.
 */
export const OPTION_WINDOW_WORKING_DAYS = 30

/**
 * Calendar days before an option period's START used to derive an INTERNAL
 * recommended decision date when neither `decisionDate` nor `exerciseDeadline`
 * is recorded. Always labelled INTERNAL_RECOMMENDATION — never presented as a
 * government or contractual deadline.
 */
export const OPTION_DERIVED_LEAD_DAYS = 90

/** Calendar days before contract end at which the period of performance is "approaching end". */
export const POP_APPROACHING_DAYS = 60

/** Modifications created/applied inside this window are reported as recent. */
export const MODIFICATION_RECENT_DAYS = 90

/** Contract statuses this agent monitors. Everything else is out of lifecycle. */
export const MONITORED_CONTRACT_STATUSES = ['ACTIVE', 'ON_HOLD'] as const

/** The status at which a contract is considered awarded/live for event purposes. */
export const AWARDED_CONTRACT_STATUS = 'ACTIVE'

export type ContractHealthState = 'HEALTHY' | 'ATTENTION' | 'CRITICAL' | 'INSUFFICIENT_DATA'

export type FundingThresholdState =
  | 'OK'
  | 'FUNDING_WARNING'
  | 'FUNDING_CRITICAL'
  | 'CEILING_WARNING'
  | 'CEILING_CRITICAL'
  | 'DEPLETION_BEFORE_END'
  | 'INSUFFICIENT_DATA'

const HEALTH_RANK: Record<ContractHealthState, number> = {
  HEALTHY: 0,
  INSUFFICIENT_DATA: 1,
  ATTENTION: 2,
  CRITICAL: 3,
}

/** Worst-wins combination, with INSUFFICIENT_DATA ranked below a real problem. */
export function worstHealth(states: ContractHealthState[]): ContractHealthState {
  if (!states.length) return 'INSUFFICIENT_DATA'
  return states.reduce((worst, s) => (HEALTH_RANK[s] > HEALTH_RANK[worst] ? s : worst), 'HEALTHY' as ContractHealthState)
}

/**
 * Maps a consumed-percentage onto the funding bands.
 *
 * Boundaries are inclusive at the threshold (>= 0.9 is a warning, >= 0.98 is
 * critical) so "exactly at the boundary" is a breach, matching `computeBurn`'s
 * `>= lowPct` comparison. Tested at just-below / exactly / just-above.
 */
export function fundingBand(consumedPct: number, kind: 'FUNDING' | 'CEILING'): FundingThresholdState {
  const warn = kind === 'FUNDING' ? FUNDING_WARNING_PCT : CEILING_WARNING_PCT
  const crit = kind === 'FUNDING' ? FUNDING_CRITICAL_PCT : CEILING_CRITICAL_PCT
  if (!Number.isFinite(consumedPct)) return 'INSUFFICIENT_DATA'
  if (consumedPct >= crit) return kind === 'FUNDING' ? 'FUNDING_CRITICAL' : 'CEILING_CRITICAL'
  if (consumedPct >= warn) return kind === 'FUNDING' ? 'FUNDING_WARNING' : 'CEILING_WARNING'
  return 'OK'
}

export function thresholdStateToHealth(state: FundingThresholdState): ContractHealthState {
  switch (state) {
    case 'FUNDING_CRITICAL':
    case 'CEILING_CRITICAL':
    case 'DEPLETION_BEFORE_END':
      return 'CRITICAL'
    case 'FUNDING_WARNING':
    case 'CEILING_WARNING':
      return 'ATTENTION'
    case 'INSUFFICIENT_DATA':
      return 'INSUFFICIENT_DATA'
    default:
      return 'HEALTHY'
  }
}

/**
 * Escalation severity for a funding/ceiling band. Kept here so the handler
 * never invents severities inline.
 */
export function thresholdSeverity(state: FundingThresholdState): 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  switch (state) {
    case 'FUNDING_CRITICAL':
    case 'CEILING_CRITICAL':
      return 'CRITICAL'
    case 'DEPLETION_BEFORE_END':
      return 'HIGH'
    default:
      return 'MEDIUM'
  }
}

/**
 * Documented defaults, surfaced through the API so the UI can explain a
 * threshold rather than hard-coding a number of its own.
 */
export const CONTRACT_POLICY_DOC = {
  fundingWarningPct: FUNDING_WARNING_PCT,
  fundingCriticalPct: FUNDING_CRITICAL_PCT,
  ceilingWarningPct: CEILING_WARNING_PCT,
  ceilingCriticalPct: CEILING_CRITICAL_PCT,
  deliverableLeadDays: DELIVERABLE_LEAD_DAYS,
  deliverableEscalateAfterHours: DELIVERABLE_ESCALATE_AFTER_HOURS,
  deliverableDueSoonDays: DELIVERABLE_DUE_SOON_DAYS,
  optionWindowWorkingDays: OPTION_WINDOW_WORKING_DAYS,
  optionDerivedLeadDays: OPTION_DERIVED_LEAD_DAYS,
  popApproachingDays: POP_APPROACHING_DAYS,
  modificationRecentDays: MODIFICATION_RECENT_DAYS,
  monitoredContractStatuses: MONITORED_CONTRACT_STATUSES,
  notes: [
    'Funding and ceiling remaining are distinct figures and are never presented as one.',
    'A burn projection is suppressed unless there is real expenditure over at least 7 days.',
    'A derived option decision date is always labelled INTERNAL_RECOMMENDATION.',
    'This agent performs no AI inference and consumes no tokens.',
  ],
}
