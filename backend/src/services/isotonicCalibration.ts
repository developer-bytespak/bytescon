// =============================================================
// Isotonic regression calibration — Pool Adjacent Violators (PAV)
//
// Why: a logistic model can rank well (good AUC) yet be miscalibrated —
// e.g. predicted 0.7 might correspond to observed win rate 0.5. PAV is
// the non-parametric workhorse here: it produces the monotonic step
// function that minimizes squared error between predicted and observed.
//
// Two-step flow:
//   1. fitIsotonic(predictions) → IsotonicCurve (set of breakpoints)
//   2. applyIsotonic(rawProb, curve) → calibrated probability
//
// The curve is persisted as JSON on the BacktestRun that produced it.
// Loaded once at app start (or via /api/admin/calibration/refresh) and
// applied inside scoreOpportunityForClient when the env flag is set.
//
// References:
//   - Ayer, Brunk, Ewing, Reid, Silverman (1955), "An empirical
//     distribution function for sampling with incomplete information".
//   - Niculescu-Mizil & Caruana (2005), "Predicting good probabilities
//     with supervised learning" — comparison to Platt scaling.
// =============================================================

import type { LabeledPrediction } from './backtest/metrics'

/**
 * A fitted isotonic curve, stored as monotonic non-decreasing breakpoints
 * (xs ascending, ys non-decreasing). Linear interpolation between
 * breakpoints; extrapolation pinned to first/last y.
 */
export interface IsotonicCurve {
  xs: number[]
  ys: number[]
  fittedAt: string  // ISO timestamp
  sampleSize: number
  /** Diagnostic — Brier score before and after applying the curve to the
   * training set. After/before ratio < 1 means calibration helped. */
  preBrier: number
  postBrier: number
}

/**
 * Fit isotonic regression via Pool Adjacent Violators on labeled
 * predictions. Returns null when input is too small (< 20 points) to
 * fit a meaningful curve.
 *
 * Algorithm:
 *   1. Sort predictions by predicted probability ascending.
 *   2. Initialize blocks: one block per point with y = observed.
 *   3. Walk left→right; whenever block[i].y > block[i+1].y, merge them
 *      (weighted mean of y). Repeat until no violators.
 *   4. The resulting block boundaries form the curve breakpoints.
 *
 * Complexity: O(n) amortized after sort; sort is O(n log n).
 */
export function fitIsotonic(
  predictions: LabeledPrediction[],
): IsotonicCurve | null {
  if (predictions.length < 20) return null

  // Sort copy ascending by predicted probability.
  const sorted = [...predictions].sort((a, b) => a.predicted - b.predicted)

  // PAV blocks: { x, y, weight } where x = mean predicted in block,
  // y = mean observed in block, weight = number of points in block.
  interface Block { x: number; y: number; weight: number }
  const blocks: Block[] = sorted.map((p) => ({ x: p.predicted, y: p.observed, weight: 1 }))

  // Walk and merge violators. Stack-based variant keeps amortized O(n).
  const stack: Block[] = []
  for (const cur of blocks) {
    let merged: Block = { ...cur }
    while (stack.length > 0 && stack[stack.length - 1].y > merged.y) {
      const top = stack.pop()!
      const w = top.weight + merged.weight
      merged = {
        x: (top.x * top.weight + merged.x * merged.weight) / w,
        y: (top.y * top.weight + merged.y * merged.weight) / w,
        weight: w,
      }
    }
    stack.push(merged)
  }

  const xs = stack.map((b) => b.x)
  const ys = stack.map((b) => b.y)

  // Diagnostics — Brier before/after.
  const preBrier =
    predictions.reduce((a, p) => a + (p.observed - p.predicted) ** 2, 0) /
    predictions.length
  const postBrier =
    predictions.reduce(
      (a, p) => a + (p.observed - applyIsotonic(p.predicted, { xs, ys, fittedAt: '', sampleSize: 0, preBrier: 0, postBrier: 0 })) ** 2,
      0,
    ) / predictions.length

  return {
    xs,
    ys,
    fittedAt: new Date().toISOString(),
    sampleSize: predictions.length,
    preBrier,
    postBrier,
  }
}

/**
 * Apply the fitted curve to a single raw probability.
 *
 * - Below xs[0] → ys[0]
 * - Above xs[last] → ys[last]
 * - Between breakpoints → linear interpolation
 *
 * Output is in [0, 1] by construction (since ys are means of {0,1} labels).
 */
export function applyIsotonic(rawProb: number, curve: IsotonicCurve): number {
  const { xs, ys } = curve
  if (xs.length === 0) return rawProb
  if (rawProb <= xs[0]) return ys[0]
  if (rawProb >= xs[xs.length - 1]) return ys[ys.length - 1]

  // Binary search for the bracketing interval.
  let lo = 0
  let hi = xs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1
    if (xs[mid] <= rawProb) lo = mid
    else hi = mid
  }

  // Linear interpolation between (xs[lo], ys[lo]) and (xs[hi], ys[hi]).
  const dx = xs[hi] - xs[lo]
  if (dx <= 0) return ys[lo]
  const t = (rawProb - xs[lo]) / dx
  return ys[lo] + t * (ys[hi] - ys[lo])
}

/**
 * Apply to a batch — convenient when re-scoring a backtest run after
 * fitting a curve (diagnostics).
 */
export function applyIsotonicBatch(
  predictions: LabeledPrediction[],
  curve: IsotonicCurve,
): LabeledPrediction[] {
  return predictions.map((p) => ({
    predicted: applyIsotonic(p.predicted, curve),
    observed: p.observed,
  }))
}
