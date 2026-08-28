// =============================================================
// Probability Layers — additive refinement of decisionEngine output
//
// These layers run AFTER the 7-factor logistic + Bayesian Beta-Binomial
// calibration in decisionEngine.ts. They DO NOT replace any existing
// math; they apply optional multiplicative adjustments and expose
// uncertainty information that the base engine omits.
//
// Each layer is independently togglable via env flag so individual
// signals can be tuned or disabled without redeploying. The wrapper
// applyAdditiveLayers() is the only entry point.
//
// Layers shipped here:
//   A. Set-aside alignment boost — when client certifications match
//      the opportunity's set-aside type, apply a small positive
//      multiplier. The 7-factor model removed set-aside as a feature
//      (delegated to the compliance gate) but the compliance gate is
//      a binary go/no-go and does not reward a STRONG fit between
//      certs and set-aside — that signal is recovered here.
//
//   B. Credible interval — exposes a 95% credible interval around the
//      Bayesian posterior so the frontend can show uncertainty when
//      the client's historical sample is small. Pure exposure, does
//      not change the point estimate.
//
// Per repository rules in `.claude/rules/rules.md`:
//   - decisionEngine.ts is "already implemented — do not reinvent".
//   - These layers are additive; the existing 7-factor model and
//     Beta-Binomial shrinkage in decisionEngine.ts stay untouched.
//   - All multipliers documented; no hidden state.
// =============================================================

/**
 * Client certifications used for set-aside alignment matching.
 */
export interface ClientCertifications {
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBusiness: boolean
}

/**
 * Result of the additive-layer pass. `probability` is the post-layer
 * value, clamped to [0.01, 0.95] to match the existing engine's bounds.
 * `credibleInterval` is non-null only when Bayesian calibration data
 * was sufficient (totalWon + totalLost > 0).
 */
export interface AdditiveLayersResult {
  probability: number
  layersApplied: string[]
  credibleInterval: { low: number; high: number; widthPct: number } | null
  setAsideMatch: 'FULL' | 'PARTIAL' | 'NONE' | 'OPEN'
}

const ENV = process.env

function flagEnabled(name: string, defaultValue = true): boolean {
  const raw = ENV[name]
  if (raw === undefined) return defaultValue
  return raw === '1' || raw.toLowerCase() === 'true'
}

const MULTIPLIER_CAP = 0.95
const MULTIPLIER_FLOOR = 0.01

/**
 * Layer A — set-aside alignment boost.
 *
 * Conservative bounds chosen to avoid over-weighting a single signal:
 *   - FULL match (cert exactly matches set-aside) → +5%
 *   - PARTIAL match (related cert but not exact)  → +2%
 *   - NO match                                    → no change
 *   - OPEN competition (setAside = NONE)          → no change
 *
 * Bounds revisitable once outcome-feedback (Gap 1 in the audit) is in
 * place and we can backtest per-tenant.
 */
export function setAsideAlignmentBoost(
  setAsideType: string | null | undefined,
  cert: ClientCertifications,
): { multiplier: number; match: AdditiveLayersResult['setAsideMatch']; label: string } {
  const normalized = (setAsideType ?? '').toUpperCase().trim()

  if (!normalized || normalized === 'NONE') {
    return { multiplier: 1.0, match: 'OPEN', label: 'Open competition — no set-aside alignment boost applied' }
  }

  // Full match — exact cert ↔ set-aside type pair.
  // SAM.gov set-aside codes covered: SDVOSBC, WOSB, EDWOSB, HZC, 8A/8AN, SBA/SBP, VSA.
  if (
    (normalized === 'SDVOSBC' || normalized === 'SDVOSB' || normalized === 'VSA') &&
    cert.sdvosb
  ) {
    return { multiplier: 1.05, match: 'FULL', label: 'SDVOSB cert matches set-aside (+5%)' }
  }
  if (normalized === 'WOSB' && cert.wosb) {
    return { multiplier: 1.05, match: 'FULL', label: 'WOSB cert matches set-aside (+5%)' }
  }
  if (normalized === 'EDWOSB' && cert.wosb) {
    // EDWOSB is a stricter subset of WOSB. Without a dedicated EDWOSB cert
    // flag on the client we can only confirm partial alignment.
    return { multiplier: 1.02, match: 'PARTIAL', label: 'WOSB cert partially aligns with EDWOSB set-aside (+2%)' }
  }
  if (normalized === 'HZC' && cert.hubzone) {
    return { multiplier: 1.05, match: 'FULL', label: 'HUBZone cert matches set-aside (+5%)' }
  }
  if ((normalized === 'SBA' || normalized === 'SBP') && cert.smallBusiness) {
    return { multiplier: 1.05, match: 'FULL', label: 'Small business cert matches set-aside (+5%)' }
  }
  if ((normalized === '8A' || normalized === '8AN') && cert.smallBusiness) {
    // 8(a) is a stricter program inside small-business. Without a
    // dedicated 8(a) flag we treat any small-business cert as partial.
    return { multiplier: 1.02, match: 'PARTIAL', label: 'Small-business cert partially aligns with 8(a) set-aside (+2%)' }
  }

  // Set-aside present but no matching cert. Don't penalize here —
  // compliance gate already filters ineligible bids; this layer is
  // purely a positive signal.
  return { multiplier: 1.0, match: 'NONE', label: `No client certification matches set-aside ${normalized}` }
}

/**
 * Layer B — credible interval via normal approximation to Beta(α, β).
 *
 * The Bayesian Beta-Binomial calibration in decisionEngine yields a
 * posterior Beta(α, β) where:
 *   α = (raw_p × k) + totalWon
 *   β = ((1 - raw_p) × k) + totalLost
 *
 * Mean = α/(α+β); variance = αβ / [(α+β)² × (α+β+1)].
 *
 * For sample sizes ≥ 10 the normal approximation is accurate to within
 * ~1%; for smaller samples it slightly over-covers (wider CI) which is
 * the conservative direction for a UI showing uncertainty.
 *
 * Returns null when alpha+beta ≤ 0 (degenerate — the caller should not
 * have invoked credible-interval computation in that case).
 */
export function credibleInterval95(
  alpha: number,
  beta: number,
): { low: number; high: number; widthPct: number } | null {
  if (!(alpha > 0) || !(beta > 0)) return null
  const n = alpha + beta
  const mean = alpha / n
  const variance = (alpha * beta) / (n * n * (n + 1))
  const stddev = Math.sqrt(variance)
  const Z_95 = 1.96
  const low = Math.max(0, mean - Z_95 * stddev)
  const high = Math.min(1, mean + Z_95 * stddev)
  return {
    low: Number(low.toFixed(4)),
    high: Number(high.toFixed(4)),
    widthPct: Number(((high - low) * 100).toFixed(1)),
  }
}

/**
 * Wrapper — orchestrates all enabled layers and produces the final
 * post-layer probability + telemetry. Pure function; safe to call from
 * decisionEngine.ts after Bayesian calibration completes.
 *
 * The `posteriorAlpha` / `posteriorBeta` inputs come straight from the
 * Beta-Binomial block in decisionEngine. Pass null/null when no
 * historical data was available (new client) — credible-interval
 * computation is skipped in that case.
 */
export function applyAdditiveLayers(args: {
  baseProbability: number
  setAsideType: string | null | undefined
  certifications: ClientCertifications
  posteriorAlpha: number | null
  posteriorBeta: number | null
}): AdditiveLayersResult {
  const layers: string[] = []
  let probability = args.baseProbability

  let setAsideMatch: AdditiveLayersResult['setAsideMatch'] = 'OPEN'

  if (flagEnabled('ENABLE_PROBABILITY_LAYER_SETASIDE', true)) {
    const boost = setAsideAlignmentBoost(args.setAsideType, args.certifications)
    if (boost.multiplier !== 1.0) {
      probability = probability * boost.multiplier
      layers.push(boost.label)
    }
    setAsideMatch = boost.match
  }

  // Clamp to engine bounds. Matches decisionEngine.ts line 318.
  probability = Math.min(Math.max(probability, MULTIPLIER_FLOOR), MULTIPLIER_CAP)

  let credible: AdditiveLayersResult['credibleInterval'] = null
  if (
    flagEnabled('ENABLE_PROBABILITY_LAYER_CREDIBLE_INTERVAL', true) &&
    args.posteriorAlpha !== null &&
    args.posteriorBeta !== null
  ) {
    credible = credibleInterval95(args.posteriorAlpha, args.posteriorBeta)
    if (credible) {
      layers.push(`95% credible interval: ${(credible.low * 100).toFixed(0)}%–${(credible.high * 100).toFixed(0)}%`)
    }
  }

  return {
    probability,
    layersApplied: layers,
    credibleInterval: credible,
    setAsideMatch,
  }
}
