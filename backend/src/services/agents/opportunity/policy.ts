// =============================================================
// §7.2 — Opportunity Agent policy.
//
// EVERY threshold, sample minimum, bound and lead time for this agent lives
// here. The brief is explicit: the minimum sample size is a PRODUCT POLICY, not
// a hidden statistical fact, so it is named, exported, surfaced through the API
// and asserted by tests at threshold-1 / threshold / threshold+1.
//
// Where Section 6 already owns a number it is REUSED rather than restated —
// source staleness comes from OpportunitySourceConfig.stalenessHours, alert
// priorities come from profileAlerts.derivePriority, and match dimensions come
// from capabilityMatch.DIMENSION_WEIGHTS. Nothing here re-derives them.
//
// Fully deterministic. No LLM is used anywhere in this agent.
// =============================================================
import { DIMENSION_WEIGHTS, type DimensionKey } from '../../capabilityMatch'

/** Bumped whenever the learning derivation changes. Stored on every signal. */
export const PURSUIT_ALGORITHM_VERSION = 'pursuit-feedback-v1'

/**
 * PRODUCT POLICY. Below this many labelled pursue/ignore decisions the agent
 * reports INSUFFICIENT_DATA and proposes nothing at all.
 *
 * 20 is a deliberately conservative initial default: it is large enough that a
 * single week of clicking cannot move the weighting, and small enough that a
 * firm with a real pipeline reaches it within a quarter. It is not derived from
 * a statistical power calculation and is not presented as one.
 */
export const MIN_FEEDBACK_SAMPLE_SIZE = 20

/**
 * Both classes must be represented. A firm that pursued 20 opportunities and
 * declined none has expressed no contrast, so there is nothing to learn from.
 */
export const MIN_FEEDBACK_CLASS_SIZE = 3

/**
 * Hard bound on how far one dimension's weight may move, as a fraction of its
 * own base weight, BEFORE renormalisation. A dimension can therefore never be
 * zeroed out or made dominant by preference alone.
 */
export const MAX_WEIGHT_ADJUSTMENT_PCT = 0.25

/** Sample sizes at which the proposal's confidence is reported as higher. */
export const CONFIDENCE_MEDIUM_SAMPLE = 30
export const CONFIDENCE_HIGH_SAMPLE = 60

/** Opportunities considered per learning pass. Bounds one run's work. */
export const MAX_FEEDBACK_RECORDS = 1000

/** Opportunities processed per scheduled tenant-wide run. */
export const MAX_OPPORTUNITIES_PER_RUN = 200

/** Match score at or above which an opportunity is reported as high-priority. */
export const HIGH_MATCH_SCORE = 70
/** Match score at or above which an opportunity is reported as critical. */
export const CRITICAL_MATCH_SCORE = 85

/**
 * Consecutive source failures at which the agent escalates. Matches the plan's
 * stated rule and sits below the Section 6 worker's own back-off at 10, so a
 * human is told before the platform stops trying.
 */
export const SOURCE_FAILURE_ESCALATION_THRESHOLD = 5

/**
 * Working days before a response deadline at which a CRITICAL-priority match is
 * escalated. Working days, never naive calendar subtraction — the calculation is
 * the one generalised and verified in §7.1.
 */
export const CRITICAL_DEADLINE_WORKING_DAYS = 5

/** Rows carried in each list of the OPPORTUNITY_BRIEF. Keeps the artifact bounded. */
export const BRIEF_SECTION_LIMIT = 25

/** Opportunity statuses the agent considers live. Everything else is out of scope. */
export const LIVE_OPPORTUNITY_STATUSES = ['ACTIVE'] as const

export type PursuitLabel = 'PURSUED' | 'IGNORED'

/**
 * The dimension keys the production matching system actually understands. The
 * learning loop may only ever adjust these — it never invents a feature of its
 * own, and it never learns an opaque one.
 */
export const LEARNABLE_DIMENSIONS = Object.keys(DIMENSION_WEIGHTS) as DimensionKey[]

export type WeightMap = Record<DimensionKey, number>

/** The unadjusted, canonical Section 6 weighting. */
export function baseWeights(): WeightMap {
  return { ...DIMENSION_WEIGHTS }
}

/**
 * True when a stored weight map is structurally valid: every learnable
 * dimension present, every value a finite positive number. A malformed applied
 * signal must fall back to the base model rather than corrupt matching.
 */
export function isValidWeightMap(value: unknown): value is WeightMap {
  if (!value || typeof value !== 'object') return false
  const map = value as Record<string, unknown>
  return LEARNABLE_DIMENSIONS.every((k) => typeof map[k] === 'number' && Number.isFinite(map[k] as number) && (map[k] as number) > 0)
}

/** Exact equality of two weight maps, to the stored precision. */
export function weightsEqual(a: WeightMap, b: WeightMap): boolean {
  return LEARNABLE_DIMENSIONS.every((k) => a[k] === b[k])
}

/**
 * Documented defaults, surfaced through the API so the UI explains a threshold
 * rather than hard-coding a number of its own.
 */
export const OPPORTUNITY_POLICY_DOC = {
  algorithmVersion: PURSUIT_ALGORITHM_VERSION,
  minimumSampleSize: MIN_FEEDBACK_SAMPLE_SIZE,
  minimumClassSize: MIN_FEEDBACK_CLASS_SIZE,
  maxWeightAdjustmentPct: MAX_WEIGHT_ADJUSTMENT_PCT,
  highMatchScore: HIGH_MATCH_SCORE,
  criticalMatchScore: CRITICAL_MATCH_SCORE,
  sourceFailureEscalationThreshold: SOURCE_FAILURE_ESCALATION_THRESHOLD,
  criticalDeadlineWorkingDays: CRITICAL_DEADLINE_WORKING_DAYS,
  learnableDimensions: LEARNABLE_DIMENSIONS,
  baseWeights: baseWeights(),
  notes: [
    'The minimum sample size is a product policy, not a statistical guarantee.',
    'Learned weights are advisory: nothing changes until an ADMIN applies them.',
    'A learned adjustment changes ranking only. It never changes eligibility, capability records or win probability.',
    'Preference is not capability, and it is not legal set-aside eligibility.',
    'Learning is tenant-private. No pursuit behaviour is ever aggregated across firms.',
    'Source staleness comes from each source\'s own stalenessHours, never a global rule.',
    'This agent performs no AI inference and consumes no tokens.',
  ],
}
