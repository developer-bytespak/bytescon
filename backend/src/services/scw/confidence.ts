// =============================================================
// SCW-1 Confidence Components — pure functions
//
// Per SUBCONTRACTING_WORKFLOW_SPEC.md §3 SCW-1, a likely-prime's composite
// confidence decomposes into five named components. The spec is explicit:
// "Never return a confidence value without the decomposition." This module
// computes each component as a pure function so it can be tested in
// isolation and so the UI can surface every contributing factor on hover.
//
// All components return a ComponentBreakdown { raw, weight, weighted,
// confidence, reasoning } shape, matching the LikelyPrime.confidence
// surface in the spec.
//
// Component math summary (see per-function docstrings for details):
//
//   awardFrequency       (weight 0.30): past_awards_count normalized
//                                       against the top-scoring prime in
//                                       the candidate set.
//   awardRecency         (weight 0.20): exponential decay on years since
//                                       most recent award, 2-year half-life.
//   dollarVolume         (weight 0.15): log10-normalized total past value
//                                       against the top scorer.
//   subawardPropensity   (weight 0.20): sub-$ / award-$ ratio for this
//                                       prime, Bayesian-shrunk toward the
//                                       agency-average ratio when this
//                                       prime's sample is thin.
//   sdvosbGoalGap        (weight 0.15): FAR 52.219-9 pressure proxy from
//                                       subaward history. Returns
//                                       confidence=0 when subaward set-aside
//                                       data is unavailable (the current
//                                       state — see R4 in docs/scw/data-
//                                       layer-introspection.md).
//
// Weights sum to 1.0 — verified by SCW1_WEIGHTS_TOTAL at module load.
// =============================================================

export const SCW1_WEIGHTS = {
  awardFrequency: 0.30,
  awardRecency: 0.20,
  dollarVolume: 0.15,
  subawardPropensity: 0.20,
  sdvosbGoalGap: 0.15,
} as const

const SCW1_WEIGHTS_TOTAL = Object.values(SCW1_WEIGHTS).reduce((a, b) => a + b, 0)
if (Math.abs(SCW1_WEIGHTS_TOTAL - 1.0) > 1e-9) {
  throw new Error(`SCW1_WEIGHTS must sum to 1.0, got ${SCW1_WEIGHTS_TOTAL}`)
}

const RECENCY_HALF_LIFE_YEARS = 2.0
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

// Bayesian prior for subaward propensity (in dollars). Interpretation:
// "k dollars of evidence." A $5M prime's raw ratio is mostly the agency
// prior; a $5B prime's raw ratio dominates the prior. Mirrors the
// SUBSPEND_PRIOR_DOLLARS from services/teamingSuggester.ts for consistency
// across the codebase.
const SUBSPEND_PRIOR_DOLLARS = 50_000_000

// SDVOSB statutory goal under FAR 52.219-9 / SBA scorecards (3.0% government-
// wide). A prime sitting below this for the fiscal year is "under pressure"
// to find SDVOSB subs — the actionable signal for BID SUB outreach.
const SDVOSB_STATUTORY_GOAL_PCT = 3.0

export interface ComponentBreakdown {
  raw: number          // [0,1] — un-weighted component score
  weight: number       // contribution to composite, [0,1], sums to 1.0
  weighted: number     // raw * weight, [0, weight]
  confidence: number   // [0,1] — data quality / sample size for this component
  reasoning: string    // short human-readable justification surfaced in UI
}

export interface PrimeStats {
  /** Number of prime-side awards in the (NAICS, agency) window. */
  pastAwardsCount: number
  /** Sum of obligation across those awards, in USD. */
  totalPastValue: number
  /** Most recent prime-side award date, null when no rows. */
  mostRecentAward: Date | null
}

export interface SubawardStats {
  /** This prime's total prime-side $ in the (NAICS, agency) window. */
  totalAwardDollars: number
  /** This prime's total sub-side $ across all of their primes. */
  totalSubawardDollars: number
  /** Number of subaward rows attributed to this prime. Drives confidence. */
  sampleSize: number
  /** Optional agency-average sub-spend ratio, used as the Bayesian prior. */
  agencyAvgSubSpendRatio?: number
}

export interface SdvosbStats {
  /** True when we have any data to compute the gap; false otherwise. */
  hasGoalData: boolean
  /** Stated FY subcontracting plan goal (%) from eSRS, null when unknown. */
  goalPercent: number | null
  /** Actual SDVOSB % from subaward history (proxy when eSRS missing). */
  actualPercent: number | null
}

export interface AggregateContext {
  /** Max pastAwardsCount across the candidate set, used for normalization. */
  topPastAwardsCount: number
  /** Max totalPastValue across the candidate set, used for normalization. */
  topTotalPastValue: number
}

// =============================================================
// Component scorers
// =============================================================

/**
 * Award frequency in (NAICS, agency). Highest-volume prime gets raw=1.0;
 * everyone else scales linearly. A prime with zero past awards gets 0.
 *
 * Confidence reflects sample depth: a single past award is a weak signal
 * (confidence 0.3) regardless of how much normalization rewards it.
 */
export function scoreAwardFrequency(
  stats: PrimeStats,
  ctx: AggregateContext,
): ComponentBreakdown {
  const weight = SCW1_WEIGHTS.awardFrequency
  if (ctx.topPastAwardsCount <= 0 || stats.pastAwardsCount <= 0) {
    return zero(weight, 'No past awards in this NAICS+agency window.')
  }
  const raw = clamp01(stats.pastAwardsCount / ctx.topPastAwardsCount)
  const confidence =
    stats.pastAwardsCount >= 5 ? 1.0 :
    stats.pastAwardsCount >= 3 ? 0.75 :
    stats.pastAwardsCount >= 2 ? 0.5 :
    0.3
  return {
    raw,
    weight,
    weighted: raw * weight,
    confidence,
    reasoning: `${stats.pastAwardsCount} past award(s) in this NAICS+agency window (top: ${ctx.topPastAwardsCount}).`,
  }
}

/**
 * Award recency with 2-year half-life. raw = 0.5 ^ (yearsSince / 2).
 * A win 2 years ago → 0.5; 4 years ago → 0.25; today → 1.0.
 *
 * Confidence is 1.0 when we have a date, 0 when null.
 */
export function scoreAwardRecency(stats: PrimeStats): ComponentBreakdown {
  const weight = SCW1_WEIGHTS.awardRecency
  if (!stats.mostRecentAward) {
    return zero(weight, 'No award date on file — cannot weight recency.')
  }
  const years = (Date.now() - stats.mostRecentAward.getTime()) / MS_PER_YEAR
  if (!Number.isFinite(years) || years < 0) {
    return zero(weight, 'Invalid award date.')
  }
  const raw = clamp01(Math.pow(0.5, years / RECENCY_HALF_LIFE_YEARS))
  return {
    raw,
    weight,
    weighted: raw * weight,
    confidence: 1.0,
    reasoning: `Most recent award ${years.toFixed(1)}y ago (2y half-life decay).`,
  }
}

/**
 * Total dollar volume, log10-normalized against the top scorer's volume.
 * Log scale because $50M vs $500M is much more meaningful than $5B vs $5.5B.
 *
 * Confidence rewards real money: < $1M total is weak signal regardless of
 * how the log normalizes.
 */
export function scoreDollarVolume(
  stats: PrimeStats,
  ctx: AggregateContext,
): ComponentBreakdown {
  const weight = SCW1_WEIGHTS.dollarVolume
  if (ctx.topTotalPastValue <= 0 || stats.totalPastValue <= 0) {
    return zero(weight, 'No dollar volume in this NAICS+agency window.')
  }
  const numerator = Math.log10(1 + stats.totalPastValue)
  const denominator = Math.log10(1 + ctx.topTotalPastValue)
  const raw = denominator > 0 ? clamp01(numerator / denominator) : 0
  const confidence =
    stats.totalPastValue >= 10_000_000 ? 1.0 :
    stats.totalPastValue >= 1_000_000 ? 0.75 :
    stats.totalPastValue >= 100_000 ? 0.5 :
    0.3
  return {
    raw,
    weight,
    weighted: raw * weight,
    confidence,
    reasoning: `$${fmtMillions(stats.totalPastValue)} total in this NAICS+agency (top: $${fmtMillions(ctx.topTotalPastValue)}).`,
  }
}

/**
 * Subaward propensity = sub-$ / award-$, Bayesian-shrunk toward the agency
 * average when this prime's sample is thin. A prime with high propensity
 * historically subs out a larger share of contract value — they're a more
 * realistic teaming partner for a small business looking to bid as sub.
 *
 * Confidence reflects sample size: a single subaward row is noise.
 */
export function scoreSubawardPropensity(stats: SubawardStats): ComponentBreakdown {
  const weight = SCW1_WEIGHTS.subawardPropensity
  if (stats.totalAwardDollars <= 0) {
    return zero(weight, 'No prime-side award dollars on file — cannot compute propensity.')
  }
  if (stats.sampleSize === 0) {
    return {
      raw: 0,
      weight,
      weighted: 0,
      confidence: 0,
      reasoning: 'No subaward history available — propensity unknown.',
    }
  }

  // Bayesian shrinkage: observed ratio mixed with the prior (agency average
  // when known, else 0.30 — a rough cross-sector subaward share).
  const observed = stats.totalSubawardDollars / stats.totalAwardDollars
  const prior = stats.agencyAvgSubSpendRatio ?? 0.30
  const k = SUBSPEND_PRIOR_DOLLARS
  const shrunk =
    (stats.totalSubawardDollars + prior * k) / (stats.totalAwardDollars + k)
  const raw = clamp01(shrunk)

  // Confidence proportional to sample size, capped at 1.0 at ~30 rows
  // (matches the SETASIDE_PRIOR_ROWS heuristic from teamingSuggester).
  const confidence = Math.min(1.0, stats.sampleSize / 30)

  return {
    raw,
    weight,
    weighted: raw * weight,
    confidence,
    reasoning: `Subbed ~${(raw * 100).toFixed(0)}% of award value historically (observed ${(observed * 100).toFixed(0)}%, sample n=${stats.sampleSize}).`,
  }
}

/**
 * SDVOSB goal gap = goalPercent - actualPercent. Positive gap means the
 * prime is behind their FAR 52.219-9 subcontracting goal and under
 * regulatory pressure to find SDVOSB subs — the actionable signal for
 * BID SUB outreach.
 *
 * Per R4 (docs/scw/data-layer-introspection.md), USAspending's subaward
 * endpoint does not return SDVOSB flags, so the proxy path is currently
 * unavailable. Until SAM.gov enrichment or BigQuery pivot lands,
 * sdvosbStats.hasGoalData should be false and this returns confidence=0
 * with an explicit reasoning string — per spec §2.5 "No silent failures".
 */
export function scoreSdvosbGoalGap(stats: SdvosbStats): ComponentBreakdown {
  const weight = SCW1_WEIGHTS.sdvosbGoalGap
  if (!stats.hasGoalData || stats.actualPercent === null) {
    return {
      raw: 0,
      weight,
      weighted: 0,
      confidence: 0,
      reasoning: 'SDVOSB subaward set-aside data unavailable (R4 — see docs/scw/data-layer-introspection.md). Goal gap cannot be computed.',
    }
  }
  const goal = stats.goalPercent ?? SDVOSB_STATUTORY_GOAL_PCT
  const gap = goal - stats.actualPercent
  // Map gap to [0,1]: 0% gap → 0.5 (at goal), +3% gap → ~1.0 (deep deficit
  // = strong pressure), -3% gap → ~0.0 (well over goal = no pressure).
  const raw = clamp01(0.5 + gap / 6)
  return {
    raw,
    weight,
    weighted: raw * weight,
    confidence: 0.75, // never claim full confidence on the proxy path
    reasoning: `SDVOSB goal ${goal.toFixed(1)}% vs actual ${stats.actualPercent.toFixed(1)}% (gap ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp).`,
  }
}

// =============================================================
// Compositing
// =============================================================

export interface CompositeConfidence {
  composite: number
  components: {
    awardFrequency: ComponentBreakdown
    awardRecency: ComponentBreakdown
    dollarVolume: ComponentBreakdown
    subawardPropensity: ComponentBreakdown
    sdvosbGoalGap: ComponentBreakdown
  }
  /** Top-N component reasons (by weighted × confidence) — surfaced in UI. */
  topReasons: string[]
  /** Source citation rolled up across components. Set by the caller. */
  citation: string
  /**
   * What fraction of the total weight backed components actually scored
   * (confidence > 0). 1.0 means every component contributed; lower values
   * mean some components were unavailable and excluded from the composite.
   * Surfaces as a UI tooltip so operators see "this score is based on 3 of
   * 5 components" rather than a hidden penalty.
   */
  coverage: number
}

/**
 * Compose the five components into a composite confidence in [0,1].
 *
 * Math (spec §2.3 "weighted sum" — refined for the no-silent-failures
 * intent of spec §2.5): components with confidence=0 are excluded from
 * BOTH numerator and denominator instead of dragging the average down.
 * This was a real demo blocker — two of the five components currently
 * ship confidence=0 (subawardPropensity when the prime has no subaward
 * rows in the corpus, sdvosbGoalGap when R4 data is unavailable), which
 * capped the achievable composite at ~0.65 even for primes scoring 1.0
 * on every measurable component.
 *
 * The "coverage" field reports the fraction of total weight that did
 * score, so the operator can see "0.62 score, 65% coverage" and judge
 * how much to trust the headline number. Top reasons still rank by
 * weighted × confidence as before, so zero-confidence components never
 * appear as a reason for the score.
 *
 * Citation is left to the caller — it's a function of the input query
 * (NAICS, agency, date window) which lives outside this module.
 */
export function composeConfidence(
  components: CompositeConfidence['components'],
  citation: string,
): CompositeConfidence {
  const ordered = [
    components.awardFrequency,
    components.awardRecency,
    components.dollarVolume,
    components.subawardPropensity,
    components.sdvosbGoalGap,
  ]
  // Effective weight: count a component only when its confidence > 0.
  // weighted = raw * weight is already on the row, but we re-derive the
  // average over effective weights so unavailable data doesn't penalize.
  let weightedSum = 0
  let effectiveWeight = 0
  for (const c of ordered) {
    if (c.confidence <= 0) continue
    weightedSum += c.raw * c.weight
    effectiveWeight += c.weight
  }
  const composite =
    effectiveWeight > 0 ? clamp01(weightedSum / effectiveWeight) : 0

  const sorted = [
    { key: 'awardFrequency', c: components.awardFrequency },
    { key: 'awardRecency', c: components.awardRecency },
    { key: 'dollarVolume', c: components.dollarVolume },
    { key: 'subawardPropensity', c: components.subawardPropensity },
    { key: 'sdvosbGoalGap', c: components.sdvosbGoalGap },
  ].sort((a, b) => b.c.weighted * b.c.confidence - a.c.weighted * a.c.confidence)
  const topReasons = sorted.slice(0, 3).map((s) => s.c.reasoning)

  return {
    composite,
    components,
    topReasons,
    citation,
    coverage: Number(effectiveWeight.toFixed(2)),
  }
}

// =============================================================
// Helpers
// =============================================================

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function fmtMillions(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toFixed(0)
}

function zero(weight: number, reasoning: string): ComponentBreakdown {
  return { raw: 0, weight, weighted: 0, confidence: 0, reasoning }
}
