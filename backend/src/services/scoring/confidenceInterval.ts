// =============================================================
// §6.2H — Confidence / prediction intervals.
//
// Method (documented, and chosen for the data that actually exists):
//   A Wilson score interval on the tenant's calibration-bin outcome counts.
//
// Why Wilson rather than a normal (Wald) interval: Wald collapses to a
// zero-width interval at p=0 or p=1 and badly under-covers at small n — exactly
// the regime a new tenant is in. Wilson stays bounded in (0,1), has correct
// coverage at small n, and widens honestly when data is thin, which is the
// behaviour §6.2H requires ("do not display artificially narrow intervals").
//
// The interval is centred on the tenant's OBSERVED rate in the bin the point
// estimate falls into, then re-anchored on the point estimate so it brackets
// what the user is shown. Where no bin has enough data, no interval is
// produced — the caller renders "INSUFFICIENT DATA — INTERVAL NOT AVAILABLE".
// Statistical certainty is never fabricated.
// =============================================================

export type ConfidenceState = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA'

export const CONFIDENCE_METHOD = 'wilson-bin-v1'
/** Below this many samples in the relevant bin no interval is produced. */
export const MIN_BIN_SAMPLES = 8
/** Below this many tenant samples overall confidence can never exceed LOW. */
export const MIN_TENANT_SAMPLES_FOR_MEDIUM = 30
export const MIN_TENANT_SAMPLES_FOR_HIGH = 100
/** Default bin count over [0,1]. */
export const DEFAULT_BIN_COUNT = 10
const Z_95 = 1.959963985

export interface CalibrationBin {
  /** Inclusive lower edge of the predicted-probability bin, 0..1. */
  lower: number
  /** Exclusive upper edge (inclusive at 1.0). */
  upper: number
  count: number
  /** Observed wins in this bin. */
  wins: number
}

export interface IntervalInput {
  /** Point estimate, 0..1. */
  pointEstimate: number
  bins: CalibrationBin[]
  /** Total verified tenant outcome samples. */
  tenantSampleSize: number
  modelVersion: string
  /** 0..1 completeness of the model inputs for THIS record. */
  dataCompleteness: number
  /**
   * 0..1 similarity of this record to the training data (e.g. is its NAICS /
   * agency / value band represented). Low similarity widens nothing but does
   * downgrade the reported confidence state, which is the honest signal.
   */
  trainingSimilarity: number
}

export interface IntervalResult {
  lower: number | null
  point: number
  upper: number | null
  available: boolean
  confidence: ConfidenceState
  reason: string
  method: string
  binSampleSize: number
  tenantSampleSize: number
  modelVersion: string
  /** Verbatim string to render when no interval is available. */
  unavailableLabel: string | null
}

export const INTERVAL_UNAVAILABLE_LABEL = 'INSUFFICIENT DATA — INTERVAL NOT AVAILABLE'

/**
 * Wilson score interval for a binomial proportion. Pure; deterministic.
 * Returns null for n <= 0.
 */
export function wilsonInterval(successes: number, n: number, z: number = Z_95): { low: number; high: number } | null {
  if (!Number.isFinite(n) || n <= 0) return null
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = p + z2 / (2 * n)
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  const low = (centre - margin) / denom
  const high = (centre + margin) / denom
  return { low: Math.max(0, Number(low.toFixed(6))), high: Math.min(1, Number(high.toFixed(6))) }
}

/** Build equal-width bins from raw (predicted, observed) pairs. */
export function buildBins(
  samples: Array<{ predicted: number; observed: number }>,
  binCount: number = DEFAULT_BIN_COUNT,
): CalibrationBin[] {
  const bins: CalibrationBin[] = Array.from({ length: binCount }, (_, i) => ({
    lower: i / binCount,
    upper: (i + 1) / binCount,
    count: 0,
    wins: 0,
  }))
  for (const s of samples) {
    const p = Math.min(0.999999, Math.max(0, s.predicted))
    const idx = Math.min(binCount - 1, Math.floor(p * binCount))
    bins[idx].count++
    if (s.observed >= 0.5) bins[idx].wins++
  }
  return bins
}

export function findBin(bins: CalibrationBin[], p: number): CalibrationBin | null {
  const clamped = Math.min(1, Math.max(0, p))
  return bins.find((b) => (clamped >= b.lower && clamped < b.upper) || (clamped === 1 && b.upper === 1)) ?? null
}

/**
 * Compute the interval for one prediction.
 *
 * Anchoring: the Wilson half-widths from the matching bin are applied around
 * the POINT ESTIMATE, so the band brackets the number the user actually sees
 * rather than the bin's historical mean. The band is clamped to [0,1].
 */
export function computeConfidenceInterval(input: IntervalInput): IntervalResult {
  const point = Math.min(1, Math.max(0, input.pointEstimate))
  const base = {
    point: Number(point.toFixed(4)),
    method: CONFIDENCE_METHOD,
    tenantSampleSize: input.tenantSampleSize,
    modelVersion: input.modelVersion,
  }

  const bin = findBin(input.bins, point)
  const binSampleSize = bin?.count ?? 0

  if (!bin || binSampleSize < MIN_BIN_SAMPLES) {
    return {
      ...base,
      lower: null,
      upper: null,
      available: false,
      confidence: 'INSUFFICIENT_DATA',
      reason:
        `Only ${binSampleSize} verified outcome(s) fall in the ${bin ? `${(bin.lower * 100).toFixed(0)}–${(bin.upper * 100).toFixed(0)}%` : 'relevant'} probability band ` +
        `(minimum ${MIN_BIN_SAMPLES}). An interval computed from this would be misleading, so none is shown.`,
      binSampleSize,
      unavailableLabel: INTERVAL_UNAVAILABLE_LABEL,
    }
  }

  const wilson = wilsonInterval(bin.wins, bin.count)
  if (!wilson) {
    return {
      ...base, lower: null, upper: null, available: false, confidence: 'INSUFFICIENT_DATA',
      reason: 'The matching probability band has no usable outcome counts.',
      binSampleSize, unavailableLabel: INTERVAL_UNAVAILABLE_LABEL,
    }
  }

  const observedRate = bin.wins / bin.count
  const lowerHalfWidth = Math.max(0, observedRate - wilson.low)
  const upperHalfWidth = Math.max(0, wilson.high - observedRate)
  const lower = Number(Math.max(0, point - lowerHalfWidth).toFixed(4))
  const upper = Number(Math.min(1, point + upperHalfWidth).toFixed(4))

  // Confidence state combines sample size, input completeness and how much this
  // record resembles the training data. The weakest signal wins.
  const reasons: string[] = []
  let confidence: ConfidenceState

  if (input.tenantSampleSize >= MIN_TENANT_SAMPLES_FOR_HIGH && binSampleSize >= 25) confidence = 'HIGH'
  else if (input.tenantSampleSize >= MIN_TENANT_SAMPLES_FOR_MEDIUM) confidence = 'MEDIUM'
  else confidence = 'LOW'

  if (confidence === 'HIGH' && input.dataCompleteness < 0.8) { confidence = 'MEDIUM'; reasons.push(`model inputs are only ${(input.dataCompleteness * 100).toFixed(0)}% complete`) }
  if (input.dataCompleteness < 0.5) { confidence = 'LOW'; reasons.push(`model inputs are only ${(input.dataCompleteness * 100).toFixed(0)}% complete`) }
  if (confidence === 'HIGH' && input.trainingSimilarity < 0.5) { confidence = 'MEDIUM'; reasons.push('this opportunity is unlike the historical record it was calibrated on') }
  if (input.trainingSimilarity < 0.25) { confidence = 'LOW'; reasons.push('this opportunity is very unlike the historical record it was calibrated on') }

  const width = upper - lower
  const reason =
    `Wilson 95% interval from ${bin.wins}/${bin.count} verified outcomes in the ${(bin.lower * 100).toFixed(0)}–${(bin.upper * 100).toFixed(0)}% band ` +
    `across ${input.tenantSampleSize} tenant sample(s); band width ${(width * 100).toFixed(1)} points.` +
    (reasons.length ? ` Confidence reduced because ${reasons.join(' and ')}.` : '')

  return { ...base, lower, upper, available: true, confidence, reason, binSampleSize, unavailableLabel: null }
}

/**
 * Data completeness for a scoring feature set: fraction of the model's inputs
 * that were actually present. Used as the dataCompleteness signal above.
 */
export function featureCompleteness(features: Record<string, unknown>, expectedKeys: string[]): number {
  if (expectedKeys.length === 0) return 0
  const present = expectedKeys.filter((k) => {
    const v = features[k]
    return v !== null && v !== undefined && v !== ''
  }).length
  return Number((present / expectedKeys.length).toFixed(4))
}
