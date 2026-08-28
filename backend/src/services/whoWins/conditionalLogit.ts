// =============================================================
// Who-Wins — conditional logit (McFadden) fitter, dependency-free.
//
// P(candidate j wins award i) = softmax_j(β·x_ij) over the award's
// candidate set. Fitted by full-batch gradient ascent on the group
// log-likelihood with L2 regularization and standardized features.
// With candidate sets built by UNIFORM sampling that includes the
// winner, plain conditional logit is a consistent estimator (McFadden
// 1978 — the sampling-correction term cancels). ~50k groups × 10
// candidates × 5 features fits in well under a minute in plain TS.
// =============================================================

export interface LogitFitResult {
  /** Coefficients on STANDARDIZED features. */
  beta: number[]
  featureMeans: number[]
  featureSds: number[]
  trainLogLik: number
  epochs: number
}

/** Deterministic PRNG (mulberry32) — the negative-sampling protocol must be
 *  reproducible or eval numbers aren't comparable across model versions. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function logSumExp(xs: number[]): number {
  const m = Math.max(...xs)
  let s = 0
  for (const x of xs) s += Math.exp(x - m)
  return m + Math.log(s)
}

/** Standardize in place using train-set moments; returns the moments. */
export function standardize(groups: number[][][]): { means: number[]; sds: number[] } {
  const d = groups[0][0].length
  const means = new Array(d).fill(0)
  const sds = new Array(d).fill(0)
  let n = 0
  for (const g of groups) for (const x of g) { n++; for (let k = 0; k < d; k++) means[k] += x[k] }
  for (let k = 0; k < d; k++) means[k] /= Math.max(1, n)
  for (const g of groups) for (const x of g) for (let k = 0; k < d; k++) sds[k] += (x[k] - means[k]) ** 2
  for (let k = 0; k < d; k++) sds[k] = Math.sqrt(sds[k] / Math.max(1, n)) || 1
  for (const g of groups) for (const x of g) for (let k = 0; k < d; k++) x[k] = (x[k] - means[k]) / sds[k]
  return { means, sds }
}

/**
 * Fit β by gradient ascent. Each group's candidate 0 is the winner.
 * Mutates nothing; expects groups ALREADY standardized.
 *
 * nonNegative: projected gradient (β clamped ≥ 0 each step). Used when every
 * feature is domain-monotone — more experience/recency/fit can never lower
 * win odds. Without it, collinear experience features split their shared
 * signal into offsetting +/− partials that predict fine but produce
 * indefensible per-feature explanations at runtime.
 */
export function fitConditionalLogit(
  groups: number[][][],
  opts: { l2?: number; learningRate?: number; epochs?: number; nonNegative?: boolean } = {},
): { beta: number[]; trainLogLik: number; epochs: number } {
  const { l2 = 1e-3, learningRate = 0.5, epochs = 200, nonNegative = false } = opts
  if (!groups.length) throw new Error('no training groups')
  const d = groups[0][0].length
  let beta = new Array(d).fill(0)

  let lastLL = -Infinity
  let epoch = 0
  for (; epoch < epochs; epoch++) {
    const grad = new Array(d).fill(0)
    let ll = 0
    for (const g of groups) {
      const utils = g.map((x) => x.reduce((s, v, k) => s + v * beta[k], 0))
      const lse = logSumExp(utils)
      ll += utils[0] - lse
      // ∂LL/∂β = x_win − Σ_k p_k x_k
      for (let j = 0; j < g.length; j++) {
        const p = Math.exp(utils[j] - lse)
        for (let k = 0; k < d; k++) grad[k] += ((j === 0 ? 1 : 0) - p) * g[j][k]
      }
    }
    ll -= (l2 / 2) * beta.reduce((s, b) => s + b * b, 0) * groups.length
    for (let k = 0; k < d; k++) grad[k] -= l2 * beta[k] * groups.length

    const step = learningRate / groups.length
    beta = beta.map((b, k) => b + step * grad[k])
    if (nonNegative) beta = beta.map((b) => Math.max(0, b))

    // Converged when the average per-group LL stops moving.
    if (Math.abs(ll - lastLL) < 1e-7 * groups.length) { lastLL = ll; epoch++; break }
    lastLL = ll
  }
  return { beta, trainLogLik: lastLL, epochs: epoch }
}

/** Utility β·x̃ for a RAW feature vector under stored standardization. */
export function utility(raw: number[], beta: number[], means: number[], sds: number[]): number {
  let u = 0
  for (let k = 0; k < raw.length; k++) u += beta[k] * ((raw[k] - means[k]) / (sds[k] || 1))
  return u
}
