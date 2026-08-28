// =============================================================
// Platt Scaling calibration
//
// Fits P_calibrated = σ(A · logit(rawProb) + B) using gradient
// descent on binary cross-entropy loss. This is the standard
// post-hoc calibration for models whose output is already a
// probability — re-parametrising the sigmoid in log-odds space
// corrects systematic over/under-confidence.
//
// When to prefer over isotonic regression:
//   - Backtest sample < ~200 points (isotonic can overfit)
//   - Miscalibration is predominantly a scale/bias shift
//
// When isotonic is better:
//   - Large sample (1 000+ points, typical for v2-permutation)
//   - Non-sigmoid calibration error shape
//
// Both methods are fit on every v2-permutation BacktestRun so
// the operator can compare preBrier/postBrier and pick the
// winner via CALIBRATION_METHOD=isotonic|platt.
//
// References:
//   - Platt (1999), "Probabilistic outputs for SVMs..."
//   - Niculescu-Mizil & Caruana (2005), "Predicting good
//     probabilities with supervised learning"
// =============================================================

import type { LabeledPrediction } from './backtest/metrics'

export interface PlattParams {
  A: number
  B: number
  fittedAt: string   // ISO timestamp
  sampleSize: number
  preBrier: number
  postBrier: number
}

// Numerical stability clamp — keeps logit finite and sigmoid ≠ 0/1.
const EPS = 1e-7

function clamp(p: number): number {
  return Math.max(EPS, Math.min(1 - EPS, p))
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

function logit(p: number): number {
  const c = clamp(p)
  return Math.log(c / (1 - c))
}

/**
 * Fit Platt scaling parameters A and B via gradient descent.
 *
 * Returns null when the input is too small (< 20 points) or when
 * all labels are identical (degenerate — no calibration possible).
 *
 * @param predictions  Labeled (predicted, observed) pairs, same type used by isotonic.
 * @param options.maxIter  Maximum gradient-descent iterations (default 1 000).
 * @param options.lr       Initial learning rate (default 0.05); halved on loss increase.
 */
export function fitPlatt(
  predictions: LabeledPrediction[],
  options: { maxIter?: number; lr?: number } = {},
): PlattParams | null {
  if (predictions.length < 20) return null

  const labels = predictions.map((p) => p.observed)
  const positives = labels.reduce((a, y) => a + y, 0)
  if (positives === 0 || positives === labels.length) return null // degenerate

  const n = predictions.length
  const maxIter = options.maxIter ?? 1000
  let lr = options.lr ?? 0.05

  // Feature: logit of the raw predicted probability.
  const X = predictions.map((p) => logit(p.predicted))
  const y = labels

  // Pre-calibration Brier score.
  const preBrier = predictions.reduce((a, p) => a + (p.observed - p.predicted) ** 2, 0) / n

  // Initialise: A=1 (identity in log-odds space), B=0.
  let A = 1.0
  let B = 0.0

  let prevLoss = Infinity

  for (let iter = 0; iter < maxIter; iter++) {
    let loss = 0
    let dA = 0
    let dB = 0

    for (let i = 0; i < n; i++) {
      const z = A * X[i] + B
      const p = sigmoid(z)
      const err = p - y[i]
      dA += err * X[i]
      dB += err
      // Binary cross-entropy, numerically stable.
      loss += -y[i] * Math.log(clamp(p)) - (1 - y[i]) * Math.log(clamp(1 - p))
    }

    loss /= n
    dA /= n
    dB /= n

    // Backtrack if loss increased (simple Armijo-style step control).
    if (loss > prevLoss) {
      lr *= 0.5
      if (lr < 1e-10) break // learning rate vanished — converged
      continue
    }
    prevLoss = loss

    A -= lr * dA
    B -= lr * dB

    // Convergence: gradient norm < 1e-6.
    if (Math.sqrt(dA * dA + dB * dB) < 1e-6) break
  }

  // Post-calibration Brier score.
  const postBrier =
    predictions.reduce((a, p) => {
      const calibrated = sigmoid(A * logit(p.predicted) + B)
      return a + (p.observed - calibrated) ** 2
    }, 0) / n

  return {
    A,
    B,
    fittedAt: new Date().toISOString(),
    sampleSize: n,
    preBrier,
    postBrier,
  }
}

/**
 * Apply fitted Platt parameters to a single raw probability.
 * Output is in (0, 1) — never exactly 0 or 1 due to EPS clamp.
 */
export function applyPlatt(rawProb: number, params: PlattParams): number {
  return sigmoid(params.A * logit(rawProb) + params.B)
}
