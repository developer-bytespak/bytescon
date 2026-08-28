// =============================================================
// §7.4 — Borderline policy.
//
// The single, deterministic, explainable decision rule for the Qualification
// Agent. Every threshold lives here; nothing elsewhere invents one.
//
// THE CENTRAL RULE: borderline is NOT defined by probability alone. A confident
// 80% with a critical capability gap is borderline. A 40% whose interval spans
// the decision boundary is borderline. A 75% with no interval at all and half
// the evidence missing is borderline. Probability is one of six inputs.
//
// Where Section 5 already owns a threshold it is REUSED by import rather than
// restated: the BID / CONDITIONAL scorecard bands come from `scorecardScoring`,
// so the agent and the human scorecard cannot disagree about what a good score
// is.
//
// Fully deterministic. No LLM, no randomness, no clock dependence.
// =============================================================
import { BID_THRESHOLD, CONDITIONAL_THRESHOLD } from '../../scorecardScoring'

export const BORDERLINE_POLICY_VERSION = 'qualification-borderline-v1'

/**
 * Section 5's canonical scorecard bands, re-exported so there is exactly one
 * definition of "good enough to bid" in the codebase.
 *   BID_THRESHOLD         = 70
 *   CONDITIONAL_THRESHOLD = 50
 */
export { BID_THRESHOLD, CONDITIONAL_THRESHOLD }

/**
 * The probability at which bid and no-bid are equally supported.
 *
 * Aligned to Section 5's `CONDITIONAL_THRESHOLD` rather than an arbitrary 50:
 * the scorecard already treats 50 as the line below which an opportunity is not
 * worth conditional pursuit, and using a different number for probability would
 * mean two "decision boundaries" that disagree.
 */
export const DECISION_BOUNDARY = CONDITIONAL_THRESHOLD

/**
 * Half-width of the band around the boundary inside which a probability is
 * "near the line" regardless of anything else.
 *
 * 10 points is deliberately conservative: it makes 40–60 a human call. A
 * narrower band would push marginal bids through automatically, which is the
 * failure mode this agent exists to prevent.
 */
export const BORDERLINE_BAND = 10

export const BORDERLINE_LOWER = DECISION_BOUNDARY - BORDERLINE_BAND
export const BORDERLINE_UPPER = DECISION_BOUNDARY + BORDERLINE_BAND

/**
 * A confidence interval wider than this tells you almost nothing, so the point
 * estimate inside it cannot carry a decision on its own.
 */
export const MAX_USEFUL_INTERVAL_WIDTH = 40

/** Probability at or above which a bid recommendation may be called STRONG. */
export const STRONG_BID_PROBABILITY = 70
/** Probability at or below which a no-bid recommendation may be called STRONG. */
export const STRONG_NO_BID_PROBABILITY = 25

export type CapabilityGapSeverity = 'NONE' | 'MINOR' | 'MAJOR' | 'CRITICAL'
export type CapacityState = 'AVAILABLE' | 'NEAR_CAPACITY' | 'OVER_CAPACITY' | 'INSUFFICIENT_DATA'

export type RecommendationResult =
  | 'RECOMMEND_BID'
  | 'RECOMMEND_NO_BID'
  | 'BORDERLINE_REVIEW'
  | 'INSUFFICIENT_DATA'

export type RecommendationStrength = 'STRONG' | 'MODERATE' | 'WEAK' | 'NONE'

/**
 * Stable machine-readable reason codes. The narrative renders these; it never
 * invents a reason of its own.
 */
export type BorderlineReasonCode =
  | 'PROBABILITY_NEAR_BOUNDARY'
  | 'INTERVAL_CROSSES_BOUNDARY'
  | 'INTERVAL_TOO_WIDE'
  | 'INTERVAL_UNAVAILABLE'
  | 'CRITICAL_CAPABILITY_GAP'
  | 'MAJOR_CAPABILITY_GAP'
  | 'CAPACITY_CONFLICT'
  | 'CAPACITY_UNKNOWN'
  | 'COMPLIANCE_BLOCKER'
  | 'COMPLIANCE_HUMAN_REVIEW'
  | 'INSUFFICIENT_EVIDENCE'

export interface BorderlineInput {
  /** 0–100 calibrated-or-raw probability. Null when none could be computed. */
  finalProbability: number | null
  /** 0–100 interval bounds, or null when no defensible interval exists. */
  intervalLower: number | null
  intervalUpper: number | null
  /** The canonical confidenceInterval state. */
  confidenceState: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA'
  /** The canonical winProbability data sufficiency. */
  dataSufficiency: 'SUFFICIENT' | 'INSUFFICIENT' | 'NONE'
  capabilityGapSeverity: CapabilityGapSeverity
  capacityState: CapacityState
  /** Hard compliance blockers affecting this pursuit. */
  complianceBlockers: number
  /** Compliance items explicitly awaiting a human or legal review. */
  complianceHumanReviewItems: number
  /** 0–100 scorecard total, when a scorecard exists. */
  scorecardScore: number | null
}

export interface BorderlineOutcome {
  recommendation: RecommendationResult
  strength: RecommendationStrength
  isBorderline: boolean
  /** Machine-readable codes, deduplicated and in a stable order. */
  reasonCodes: BorderlineReasonCode[]
  /** One human-readable sentence per code, in the same order. */
  reasons: string[]
  policyVersion: string
}

const REASON_TEXT: Record<BorderlineReasonCode, (i: BorderlineInput) => string> = {
  PROBABILITY_NEAR_BOUNDARY: (i) =>
    `Win probability is ${i.finalProbability}%, inside the ${BORDERLINE_LOWER}–${BORDERLINE_UPPER}% band around the ${DECISION_BOUNDARY}% decision boundary.`,
  INTERVAL_CROSSES_BOUNDARY: (i) =>
    `The ${i.intervalLower}–${i.intervalUpper}% confidence interval crosses the ${DECISION_BOUNDARY}% decision boundary, so the evidence supports both outcomes.`,
  INTERVAL_TOO_WIDE: (i) =>
    `The confidence interval spans ${(i.intervalUpper ?? 0) - (i.intervalLower ?? 0)} points, wider than the ${MAX_USEFUL_INTERVAL_WIDTH}-point limit for a decision to rest on the point estimate.`,
  INTERVAL_UNAVAILABLE: () =>
    'No defensible confidence interval could be produced, so the probability cannot carry a decision on its own.',
  CRITICAL_CAPABILITY_GAP: () =>
    'A critical capability requirement has no verified coverage.',
  MAJOR_CAPABILITY_GAP: () =>
    'A major capability gap is unresolved.',
  CAPACITY_CONFLICT: () =>
    'Recorded delivery capacity is already at or beyond its limit.',
  CAPACITY_UNKNOWN: () =>
    'There is not enough recorded capacity information to judge whether this pursuit can be delivered.',
  COMPLIANCE_BLOCKER: (i) =>
    `${i.complianceBlockers} compliance blocker(s) affect this pursuit.`,
  COMPLIANCE_HUMAN_REVIEW: (i) =>
    `${i.complianceHumanReviewItems} compliance item(s) are awaiting a human or legal review.`,
  INSUFFICIENT_EVIDENCE: () =>
    'Too much of the underlying evidence is missing to support a recommendation.',
}

/** Stable ordering so identical inputs always produce identical output. */
const REASON_ORDER: BorderlineReasonCode[] = [
  'INSUFFICIENT_EVIDENCE',
  'COMPLIANCE_BLOCKER',
  'CRITICAL_CAPABILITY_GAP',
  'CAPACITY_CONFLICT',
  'PROBABILITY_NEAR_BOUNDARY',
  'INTERVAL_CROSSES_BOUNDARY',
  'INTERVAL_TOO_WIDE',
  'INTERVAL_UNAVAILABLE',
  'MAJOR_CAPABILITY_GAP',
  'CAPACITY_UNKNOWN',
  'COMPLIANCE_HUMAN_REVIEW',
]

/**
 * The one decision function.
 *
 * Order of precedence:
 *   1. No probability at all            → INSUFFICIENT_DATA
 *   2. Any borderline condition          → BORDERLINE_REVIEW
 *   3. Otherwise the probability decides → BID or NO_BID
 *
 * A BORDERLINE_REVIEW is NEVER silently converted into a bid or a no-bid. That
 * is the guarantee the whole agent rests on.
 */
export function evaluateBorderline(input: BorderlineInput): BorderlineOutcome {
  const codes = new Set<BorderlineReasonCode>()

  // --- 1. is there anything to decide on at all? ----------------------
  const noProbability = input.finalProbability === null
  const noEvidence = input.dataSufficiency === 'NONE'
  if (noProbability || noEvidence) {
    codes.add('INSUFFICIENT_EVIDENCE')
    if (input.capacityState === 'INSUFFICIENT_DATA') codes.add('CAPACITY_UNKNOWN')
    return build('INSUFFICIENT_DATA', 'NONE', false, codes, input)
  }

  const probability = input.finalProbability as number

  // --- 2. borderline conditions ---------------------------------------
  if (probability >= BORDERLINE_LOWER && probability <= BORDERLINE_UPPER) {
    codes.add('PROBABILITY_NEAR_BOUNDARY')
  }

  const hasInterval = input.intervalLower !== null && input.intervalUpper !== null
  if (!hasInterval) {
    codes.add('INTERVAL_UNAVAILABLE')
  } else {
    const lower = input.intervalLower as number
    const upper = input.intervalUpper as number
    if (lower <= DECISION_BOUNDARY && upper >= DECISION_BOUNDARY) codes.add('INTERVAL_CROSSES_BOUNDARY')
    if (upper - lower > MAX_USEFUL_INTERVAL_WIDTH) codes.add('INTERVAL_TOO_WIDE')
  }

  if (input.capabilityGapSeverity === 'CRITICAL') codes.add('CRITICAL_CAPABILITY_GAP')
  else if (input.capabilityGapSeverity === 'MAJOR') codes.add('MAJOR_CAPABILITY_GAP')

  if (input.capacityState === 'OVER_CAPACITY') codes.add('CAPACITY_CONFLICT')
  else if (input.capacityState === 'INSUFFICIENT_DATA') codes.add('CAPACITY_UNKNOWN')

  if (input.complianceBlockers > 0) codes.add('COMPLIANCE_BLOCKER')
  if (input.complianceHumanReviewItems > 0) codes.add('COMPLIANCE_HUMAN_REVIEW')

  if (input.dataSufficiency === 'INSUFFICIENT' && input.confidenceState === 'INSUFFICIENT_DATA') {
    codes.add('INSUFFICIENT_EVIDENCE')
  }

  if (codes.size > 0) {
    return build('BORDERLINE_REVIEW', 'NONE', true, codes, input)
  }

  // --- 3. a clean call ---------------------------------------------------
  if (probability > DECISION_BOUNDARY) {
    const strength = probability >= STRONG_BID_PROBABILITY && input.confidenceState !== 'LOW' ? 'STRONG' : 'MODERATE'
    return build('RECOMMEND_BID', strength, false, codes, input)
  }
  const strength = probability <= STRONG_NO_BID_PROBABILITY && input.confidenceState !== 'LOW' ? 'STRONG' : 'MODERATE'
  return build('RECOMMEND_NO_BID', strength, false, codes, input)
}

function build(
  recommendation: RecommendationResult,
  strength: RecommendationStrength,
  isBorderline: boolean,
  codes: Set<BorderlineReasonCode>,
  input: BorderlineInput,
): BorderlineOutcome {
  const ordered = REASON_ORDER.filter((c) => codes.has(c))
  return {
    recommendation,
    strength,
    isBorderline,
    reasonCodes: ordered,
    reasons: ordered.map((c) => REASON_TEXT[c](input)),
    policyVersion: BORDERLINE_POLICY_VERSION,
  }
}

/**
 * Whether new evidence materially contradicts how far the pursuit has already
 * progressed — a pursuit deep in proposal whose probability has collapsed, or
 * which has acquired a critical gap or a compliance blocker.
 *
 * This NEVER moves the pursuit backwards. It only asks for a human to look.
 */
export const LATE_STAGE_PURSUIT_STAGES = ['CAPTURE', 'PROPOSAL', 'SUBMITTED'] as const

export function detectStageContradiction(args: {
  pipelineStage: string | null
  outcome: BorderlineOutcome
  finalProbability: number | null
  capabilityGapSeverity: CapabilityGapSeverity
  complianceBlockers: number
}): { contradicts: boolean; reason: string | null } {
  if (!args.pipelineStage || !(LATE_STAGE_PURSUIT_STAGES as readonly string[]).includes(args.pipelineStage)) {
    return { contradicts: false, reason: null }
  }

  if (args.outcome.recommendation === 'RECOMMEND_NO_BID') {
    return {
      contradicts: true,
      reason:
        `This pursuit is already at ${args.pipelineStage}, but the current evidence recommends not bidding` +
        (args.finalProbability !== null ? ` (win probability ${args.finalProbability}%).` : '.') +
        ' A human should confirm whether to continue. The agent has not changed the stage or any decision.',
    }
  }
  if (args.complianceBlockers > 0) {
    return {
      contradicts: true,
      reason:
        `This pursuit is already at ${args.pipelineStage} with ${args.complianceBlockers} unresolved compliance blocker(s). ` +
        'A human should confirm whether to continue. The agent has not changed the stage or any decision.',
    }
  }
  if (args.capabilityGapSeverity === 'CRITICAL') {
    return {
      contradicts: true,
      reason:
        `This pursuit is already at ${args.pipelineStage} but a critical capability requirement still has no verified coverage. ` +
        'A human should confirm whether to continue. The agent has not changed the stage or any decision.',
    }
  }
  return { contradicts: false, reason: null }
}

/**
 * Documented defaults, surfaced through the API so no UI hard-codes a band.
 */
export const BORDERLINE_POLICY_DOC = {
  policyVersion: BORDERLINE_POLICY_VERSION,
  decisionBoundary: DECISION_BOUNDARY,
  borderlineBand: BORDERLINE_BAND,
  borderlineLower: BORDERLINE_LOWER,
  borderlineUpper: BORDERLINE_UPPER,
  maxUsefulIntervalWidth: MAX_USEFUL_INTERVAL_WIDTH,
  strongBidProbability: STRONG_BID_PROBABILITY,
  strongNoBidProbability: STRONG_NO_BID_PROBABILITY,
  scorecardBidThreshold: BID_THRESHOLD,
  scorecardConditionalThreshold: CONDITIONAL_THRESHOLD,
  notes: [
    'Borderline is never decided by probability alone — six inputs are considered.',
    'A BORDERLINE_REVIEW is never silently converted into a bid or a no-bid.',
    'Missing capacity information is treated as unknown, never as available capacity.',
    'The decision boundary is Section 5\'s conditional threshold, so the agent and the scorecard agree.',
    'The agent recommends. Only a human records a bid/no-bid decision.',
  ],
}
