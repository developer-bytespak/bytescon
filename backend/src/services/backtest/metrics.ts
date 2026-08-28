// =============================================================
// Backtest metrics — beyond Brier score.
//
// All inputs: labeled predictions = [{ predicted: 0..1, observed: 0|1 }, ...].
// All outputs: numeric or null when undefined (e.g. AUC on single-class).
//
// References:
//  - Brier decomposition: Murphy (1973), "A New Vector Partition of the
//    Probability Score". Reliability + Resolution + Uncertainty.
//  - ECE: Guo et al. (2017), "On Calibration of Modern Neural Networks".
//  - AUC: Mann-Whitney U formulation, O(n log n) sort-based.
// =============================================================

export interface LabeledPrediction {
  predicted: number
  observed: number  // 0 or 1
}

export interface BrierDecomposition {
  brier: number
  reliability: number   // lower = better calibrated
  resolution: number    // higher = more signal
  uncertainty: number   // base-rate variance, model-independent
}

/** Cross-entropy / log-loss. Clamped to avoid log(0). */
export function logLoss(preds: LabeledPrediction[]): number {
  if (preds.length === 0) return 0
  const EPS = 1e-15
  let sum = 0
  for (const p of preds) {
    const q = Math.max(EPS, Math.min(1 - EPS, p.predicted))
    sum += p.observed === 1 ? -Math.log(q) : -Math.log(1 - q)
  }
  return sum / preds.length
}

/**
 * ROC AUC via Mann-Whitney U.
 * Returns null when only one class is present (AUC is undefined).
 *
 * Algorithm: sort all predictions, walk through ranks, assign average rank
 * to ties (so AUC is unbiased when many predictions share the same value).
 * AUC = (R_pos - n_pos*(n_pos+1)/2) / (n_pos * n_neg)
 * where R_pos = sum of ranks of positive class.
 */
export function rocAuc(preds: LabeledPrediction[]): number | null {
  if (preds.length === 0) return null
  const nPos = preds.filter(p => p.observed === 1).length
  const nNeg = preds.length - nPos
  if (nPos === 0 || nNeg === 0) return null

  // Sort ascending by predicted prob; track which are positives.
  const sorted = [...preds].sort((a, b) => a.predicted - b.predicted)
  // Compute average ranks for ties.
  let rankSumPos = 0
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && sorted[j].predicted === sorted[i].predicted) j++
    // ranks are 1-based; average over tied range
    const avgRank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) {
      if (sorted[k].observed === 1) rankSumPos += avgRank
    }
    i = j
  }
  const u = rankSumPos - (nPos * (nPos + 1)) / 2
  return u / (nPos * nNeg)
}

export type EceBinning = 'equal-mass' | 'equal-width'

/**
 * Expected Calibration Error: weighted average |meanPredicted - meanObserved|
 * per bin. 0 = perfectly calibrated.
 *
 * PROMPT.md §6.3: fixed-width ECE is sensitive to bin count and under/over-counts
 * error where prediction density is uneven (the common case for imbalanced
 * win/loss data). The default here is therefore EQUAL-MASS (adaptive) binning —
 * each bin holds ~equal numbers of predictions, with tied predicted values kept
 * in the same bin so identical predictions are never split across bins (which
 * would otherwise degenerate into a per-point error). The legacy equal-width
 * estimator is retained behind `binning: 'equal-width'` for comparison.
 */
export function expectedCalibrationError(
  preds: LabeledPrediction[],
  numBins = 10,
  binning: EceBinning = 'equal-mass',
): number {
  if (preds.length === 0) return 0
  const N = preds.length

  if (binning === 'equal-width') {
    const bins: { sumPred: number; sumObs: number; count: number }[] =
      Array.from({ length: numBins }, () => ({ sumPred: 0, sumObs: 0, count: 0 }))
    for (const p of preds) {
      // Edge: predicted=1.0 lands in last bin
      const idx = Math.min(numBins - 1, Math.floor(p.predicted * numBins))
      bins[idx].sumPred += p.predicted
      bins[idx].sumObs += p.observed
      bins[idx].count++
    }
    let ece = 0
    for (const b of bins) {
      if (b.count === 0) continue
      ece += (b.count / N) * Math.abs(b.sumPred / b.count - b.sumObs / b.count)
    }
    return ece
  }

  // Equal-mass (adaptive): sort by predicted, fill bins to ~N/numBins each,
  // never splitting a run of equal predicted values across two bins.
  const sorted = [...preds].sort((a, b) => a.predicted - b.predicted)
  const targetBins = Math.max(1, Math.min(numBins, N))
  let ece = 0
  let i = 0
  let binsUsed = 0
  while (i < N) {
    // Redistribute the remaining points across the remaining bins. A fixed
    // ideal grid (round((binsUsed + 1) * N / targetBins)) lags behind when the
    // tie-extension below pushes a bin far past its grid boundary, collapsing
    // every following bin to size 1 until the grid catches up. The last bin
    // always absorbs the remainder, so binsLeft is always >= 1 here.
    const binsLeft = targetBins - binsUsed
    let end = Math.min(N, i + Math.max(1, Math.round((N - i) / binsLeft)))
    // Keep ties together: extend the boundary across equal predicted values.
    while (end < N && sorted[end].predicted === sorted[end - 1].predicted) end++
    let sumPred = 0
    let sumObs = 0
    for (let k = i; k < end; k++) {
      sumPred += sorted[k].predicted
      sumObs += sorted[k].observed
    }
    const count = end - i
    ece += (count / N) * Math.abs(sumPred / count - sumObs / count)
    i = end
    binsUsed++
  }
  return ece
}

/**
 * Brier score decomposition (Murphy, 1973).
 *
 *   Brier = Reliability - Resolution + Uncertainty
 *
 * - Uncertainty = p̄(1-p̄), where p̄ is base rate of positives. Model-independent;
 *   pure variance of the labels.
 * - Reliability = Σ_k (n_k/N) (p̄_k - ō_k)²  — calibration error per bin.
 * - Resolution = Σ_k (n_k/N) (ō_k - p̄)²    — how much the bins separate from base.
 *
 * Lower reliability + higher resolution = better model.
 */
export function brierDecomposition(
  preds: LabeledPrediction[],
  numBins = 10,
): BrierDecomposition {
  if (preds.length === 0) {
    return { brier: 0, reliability: 0, resolution: 0, uncertainty: 0 }
  }

  const N = preds.length
  const baseRate = preds.reduce((a, p) => a + p.observed, 0) / N
  const uncertainty = baseRate * (1 - baseRate)

  const brier =
    preds.reduce((a, p) => a + (p.observed - p.predicted) ** 2, 0) / N

  const bins: { sumPred: number; sumObs: number; count: number }[] =
    Array.from({ length: numBins }, () => ({ sumPred: 0, sumObs: 0, count: 0 }))

  for (const p of preds) {
    const idx = Math.min(numBins - 1, Math.floor(p.predicted * numBins))
    bins[idx].sumPred += p.predicted
    bins[idx].sumObs += p.observed
    bins[idx].count++
  }

  let reliability = 0
  let resolution = 0
  for (const b of bins) {
    if (b.count === 0) continue
    const meanPred = b.sumPred / b.count
    const meanObs = b.sumObs / b.count
    const w = b.count / N
    reliability += w * (meanPred - meanObs) ** 2
    resolution += w * (meanObs - baseRate) ** 2
  }

  return { brier, reliability, resolution, uncertainty }
}
