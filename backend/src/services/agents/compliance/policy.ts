// =============================================================
// §7.3 — Compliance Agent policy.
//
// EVERY threshold, lead time and status rule for this agent lives here.
//
// Where Section 5 or Section 6 already owns a number it is REUSED by import
// rather than restated: the L/M similarity bands come from `lmMapping`, expiry
// lead days come from each record's own `reminderLeadDays`, and document expiry
// states come from `documentExpiry`. The only genuinely new figures are the
// SAM 30-day escalation window and the 5-working-day amendment window, both of
// which the implementation plan specifies.
//
// The overall status decision is centralised in `deriveOverallStatus` so the
// handler, the API and the UI can never disagree about what BLOCKED means.
// =============================================================
import { CLEAR_MAPPING_SIMILARITY, MIN_MAPPING_SIMILARITY } from '../../requirements/lmMapping'

/**
 * Calendar days before SAM registration expiry at which the agent escalates.
 * Specified by the implementation plan.
 */
export const SAM_EXPIRY_ESCALATION_DAYS = 30

/**
 * Working days before a response deadline within which a newly recorded
 * amendment is escalated rather than merely notified. Working days, never naive
 * calendar subtraction — the calculation is the one generalised in §7.1.
 */
export const AMENDMENT_DEADLINE_WORKING_DAYS = 5

/**
 * Working days before a response deadline within which a missing mandatory
 * requirement becomes a blocker rather than an item of attention.
 */
export const MANDATORY_GAP_BLOCKER_WORKING_DAYS = 10

/** Opportunities considered per scheduled tenant-wide sweep. */
export const MAX_OPPORTUNITIES_PER_SWEEP = 50

/** Rows carried in each list of the COMPLIANCE_STATUS artifact. */
export const STATUS_SECTION_LIMIT = 25

/**
 * Pipeline stages at which a pursuit is actively being worked and therefore
 * warrants the full per-opportunity compliance check. Terminal stages are
 * deliberately excluded so a closed pursuit stops consuming sweep budget.
 */
export const ACTIVE_PURSUIT_STAGES = ['QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED'] as const

/** Stages at which pre-submission readiness is worth running. */
export const PRE_SUBMISSION_STAGES = ['PROPOSAL', 'SUBMITTED'] as const

/** Terminal stages — no further compliance sweeping. */
export const TERMINAL_PURSUIT_STAGES = ['AWARDED', 'LOST', 'NO_BID', 'ARCHIVED'] as const

/**
 * Re-exported so the L/M bands have exactly ONE definition in the codebase.
 * Above CLEAR a mapping may be derived automatically; between MIN and CLEAR a
 * human must review it; below MIN nothing is fabricated at all.
 */
export { MIN_MAPPING_SIMILARITY, CLEAR_MAPPING_SIMILARITY }

export type ComplianceOverallStatus =
  | 'COMPLIANT_CURRENT'
  | 'ATTENTION_REQUIRED'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'BLOCKED'
  | 'INSUFFICIENT_DATA'

const STATUS_RANK: Record<ComplianceOverallStatus, number> = {
  COMPLIANT_CURRENT: 0,
  INSUFFICIENT_DATA: 1,
  ATTENTION_REQUIRED: 2,
  HUMAN_REVIEW_REQUIRED: 3,
  BLOCKED: 4,
}

/**
 * Worst-wins combination.
 *
 * INSUFFICIENT_DATA ranks ABOVE compliant and BELOW a real problem: not knowing
 * is worse than being fine, but it is not the same as being blocked.
 */
export function worstStatus(states: ComplianceOverallStatus[]): ComplianceOverallStatus {
  if (!states.length) return 'INSUFFICIENT_DATA'
  return states.reduce((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst), 'COMPLIANT_CURRENT' as ComplianceOverallStatus)
}

export interface OverallStatusInputs {
  /** A registration, certification or requirement that hard-blocks a bid. */
  blockers: string[]
  /** An ambiguous mapping, a flow-down needing legal review, an amendment conflict. */
  humanReviewReasons: string[]
  /** Expiring records, incomplete non-critical requirements. */
  attentionReasons: string[]
  /** Critical source records that are simply absent. */
  insufficientReasons: string[]
}

/**
 * The single deterministic status decision.
 *
 * Deliberately NOT a function of "did the extractor finish". Completing an
 * extraction says nothing about whether the firm is compliant, and calling
 * something COMPLIANT on that basis would be the most dangerous lie this agent
 * could tell.
 */
export function deriveOverallStatus(inputs: OverallStatusInputs): {
  status: ComplianceOverallStatus
  reasons: string[]
} {
  if (inputs.blockers.length > 0) return { status: 'BLOCKED', reasons: inputs.blockers }
  if (inputs.humanReviewReasons.length > 0) return { status: 'HUMAN_REVIEW_REQUIRED', reasons: inputs.humanReviewReasons }
  if (inputs.attentionReasons.length > 0) return { status: 'ATTENTION_REQUIRED', reasons: inputs.attentionReasons }
  if (inputs.insufficientReasons.length > 0) return { status: 'INSUFFICIENT_DATA', reasons: inputs.insufficientReasons }
  return { status: 'COMPLIANT_CURRENT', reasons: ['No blocking, review-required or expiring compliance condition was found.'] }
}

/** Escalation severity for an overall status. Kept here so nothing invents one. */
export function statusSeverity(status: ComplianceOverallStatus): 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  switch (status) {
    case 'BLOCKED': return 'CRITICAL'
    case 'HUMAN_REVIEW_REQUIRED': return 'HIGH'
    case 'ATTENTION_REQUIRED': return 'MEDIUM'
    case 'INSUFFICIENT_DATA': return 'LOW'
    default: return 'INFO'
  }
}

/**
 * The wording the platform uses for a possible subcontract flow-down.
 *
 * Kept as one constant because §6.1 pinned it and the Compliance Agent must not
 * drift into anything that reads as a legal conclusion.
 */
export const FLOW_DOWN_REVIEW_WORDING =
  'Potential flow-down identified — legal review required before relying on this classification.'

/**
 * Documented defaults, surfaced through the API so the UI explains a threshold
 * rather than hard-coding a number of its own.
 */
export const COMPLIANCE_POLICY_DOC = {
  samExpiryEscalationDays: SAM_EXPIRY_ESCALATION_DAYS,
  amendmentDeadlineWorkingDays: AMENDMENT_DEADLINE_WORKING_DAYS,
  mandatoryGapBlockerWorkingDays: MANDATORY_GAP_BLOCKER_WORKING_DAYS,
  minMappingSimilarity: MIN_MAPPING_SIMILARITY,
  clearMappingSimilarity: CLEAR_MAPPING_SIMILARITY,
  activePursuitStages: ACTIVE_PURSUIT_STAGES,
  preSubmissionStages: PRE_SUBMISSION_STAGES,
  notes: [
    'Certification and insurance lead times come from each record\'s own reminderLeadDays, not a global rule.',
    'A completed extraction never makes a firm COMPLIANT — extraction says nothing about compliance.',
    'Every possible subcontract flow-down stays legalReviewRequired until a human reviews it.',
    'A mapping below the minimum similarity is left unmapped rather than fabricated.',
    'The agent never marks a requirement verified, approves a clause, or acknowledges an amendment.',
    'Bonding headroom is derived from recorded limits; absent inputs report INSUFFICIENT_DATA rather than a guess.',
    'AI-enhanced extraction is optional. Every deterministic check runs with no LLM provider configured.',
  ],
}
