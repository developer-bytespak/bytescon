// =============================================================
// Matching v2 (GB-101 + GB-102) — opportunity↔client relevance/fit score
//
// Fixes three structural defects in the legacy match score:
//   1. Denominator inflation — the composite is renormalized over only the
//      dimensions present and comparable for THIS pair. Absent dimensions
//      (e.g. PSC the firm hasn't registered, an opportunity with no PSC,
//      a contract with no estimated value) are excluded from BOTH the
//      numerator and the denominator. A firm is never divided by points it
//      cannot reach.
//   2. Exact-match-only NAICS — NAICS is credited on a graduated curve
//      (exact → 6/5/4/3/2-digit prefix), and the firm's full registered set
//      (primary + secondary) is considered. A valid adjacent code is never
//      zeroed.
//   3. Zero-multiplier gating — every dimension is an additive weighted
//      contribution. There are no multiplicative gates here. Hard eligibility
//      (set-aside ineligibility) is enforced upstream by the compliance gate
//      (services/decisionEngine.ts), not as a silent score multiplier.
//
// Weights are injected from config (config.matching.weights) so tuning needs
// no code change, and they need not sum to 1 — renormalization handles that.
// =============================================================
import {
  MatchScoreV2Output,
  MatchV2Dimension,
  MatchV2DimensionResult,
  MatchV2Weights,
} from '../types'

export interface MatchV2Client {
  naicsCodes: string[]
  pscCodes: string[]
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBusiness: boolean
  state?: string | null
  performanceStats?: {
    totalWon: number
    totalLost: number
    totalSubmitted: number
    completionRate: number
  } | null
}

export interface MatchV2Opportunity {
  naicsCode: string
  psc?: string | null
  estimatedValue: number | null
  placeOfPerformance?: string | null
  historicalAvgAward?: number | null
  setAsideType?: string | null
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
}

// NAICS codes carry zero information when blank or the "000000" placeholder
// the ingestion mapper writes when SAM omits the code.
function isUsableNaics(code: string | null | undefined): boolean {
  if (!code) return false
  const t = code.trim()
  return t.length > 0 && t !== '000000'
}

// ─── NAICS dimension: graduated prefix + secondary codes ─────
// Best score across ALL of the firm's registered codes (primary + secondary),
// so an adjacent or secondary NAICS still earns graduated, nonzero credit.
export function scoreNaicsDimension(clientNaics: string[], oppNaics: string): number {
  const opp = (oppNaics ?? '').trim()
  let best = 0
  for (const raw of clientNaics) {
    const c = (raw ?? '').trim()
    if (!isUsableNaics(c)) continue
    let s = 0
    if (c === opp) s = 1.0
    else if (c.substring(0, 5) === opp.substring(0, 5)) s = 0.85
    else if (c.substring(0, 4) === opp.substring(0, 4)) s = 0.6
    else if (c.substring(0, 3) === opp.substring(0, 3)) s = 0.45
    else if (c.substring(0, 2) === opp.substring(0, 2)) s = 0.3
    if (s > best) best = s
  }
  return best
}

// ─── PSC dimension: exact + family (first 2 chars) ───────────
// Parallel federal classification axis to NAICS. Exact code → full credit;
// same PSC family (first 2 characters) → partial credit.
export function scorePscDimension(clientPscCodes: string[], oppPsc: string): number {
  const opp = (oppPsc ?? '').trim().toUpperCase()
  if (opp.length === 0) return 0
  const oppFamily = opp.substring(0, 2)
  let best = 0
  for (const raw of clientPscCodes) {
    const c = (raw ?? '').trim().toUpperCase()
    if (c.length === 0) continue
    let s = 0
    if (c === opp) s = 1.0
    else if (c.substring(0, 2) === oppFamily) s = 0.5
    if (s > best) best = s
  }
  return best
}

// ─── Award-size dimension: contract value vs client capacity ──
// Mirrors the legacy capacity-fit thresholds, expressed in 0-1.
export function scoreAwardSizeDimension(
  estimatedValue: number,
  historicalAvgAward: number | null
): number {
  const reference = historicalAvgAward && historicalAvgAward > 0 ? historicalAvgAward : 500000
  const ratio = estimatedValue / reference
  if (ratio >= 0.5 && ratio <= 2.0) return 1.0
  if (ratio >= 0.25 && ratio < 0.5) return 0.75
  if (ratio > 2.0 && ratio <= 5.0) return 0.65
  if (ratio > 5.0 && ratio <= 10.0) return 0.4
  if (ratio > 10.0) return 0.2
  return 0.6 // very small contract vs capacity — still executable
}

// ─── Geography dimension ─────────────────────────────────────
export function scoreGeographyDimension(
  clientState: string,
  placeOfPerformance: string
): number {
  const pop = placeOfPerformance.toUpperCase()
  if (
    pop.includes('NATIONWIDE') ||
    pop.includes('NATIONAL') ||
    pop.includes('CONUS') ||
    pop.includes('REMOTE') ||
    pop.includes('N/A')
  ) {
    return 0.8
  }
  const state = clientState.toUpperCase()
  if (pop.includes(state)) return 1.0
  const dcStates = ['DC', 'VA', 'MD', 'PA', 'DE', 'WV', 'NJ']
  if (dcStates.includes(state) && dcStates.some((s) => pop.includes(s))) return 0.75
  return 0.4
}

// ─── Past-performance dimension ──────────────────────────────
export function scorePastPerformanceDimension(
  stats: NonNullable<MatchV2Client['performanceStats']>
): number {
  const decided = stats.totalWon + stats.totalLost
  const winRate = decided > 0 ? stats.totalWon / decided : 0.5
  const completion = clamp01(stats.completionRate || 0)
  return clamp01(0.7 * winRate + 0.3 * completion)
}

// ─── Set-aside alignment dimension ───────────────────────────
// Additive signal only — NOT an eligibility gate. Substring match keeps this
// resilient to the exact set-aside vocabulary (SDVOSB / WOSB / EDWOSB /
// HUBZONE / SMALL_BUSINESS / TOTAL_SMALL_BUSINESS / SBA_8A / VOSB / INDIAN).
export function scoreSetAsideAlignmentDimension(
  setAsideType: string,
  certs: { sdvosb: boolean; wosb: boolean; hubzone: boolean; smallBusiness: boolean }
): number {
  const t = setAsideType.toUpperCase()
  // SDVOSB ⊂ VOSB: a service-disabled veteran-owned firm also satisfies VOSB.
  if (t.includes('SDVOSB')) return certs.sdvosb ? 1.0 : 0.2
  if (t.includes('VOSB')) return certs.sdvosb ? 1.0 : 0.2
  if (t.includes('HUBZONE')) return certs.hubzone ? 1.0 : 0.2
  if (t.includes('WOSB')) return certs.wosb ? 1.0 : 0.2 // covers EDWOSB
  if (t.includes('8A') || t.includes('SMALL_BUSINESS')) return certs.smallBusiness ? 1.0 : 0.2
  return 0.2 // restricted set-aside the firm has no obvious claim to
}

// ─── Composite: dynamic renormalization over present dimensions ──
export function computeMatchScoreV2(
  client: MatchV2Client,
  opportunity: MatchV2Opportunity,
  weights: MatchV2Weights
): MatchScoreV2Output {
  const dims: Record<MatchV2Dimension, MatchV2DimensionResult> = {
    naics: { raw: 0, weight: weights.naics, present: false },
    psc: { raw: 0, weight: weights.psc, present: false },
    awardSize: { raw: 0, weight: weights.awardSize, present: false },
    geography: { raw: 0, weight: weights.geography, present: false },
    pastPerformance: { raw: 0, weight: weights.pastPerformance, present: false },
    setAsideAlignment: { raw: 0, weight: weights.setAsideAlignment, present: false },
  }

  // NAICS — present when the firm has at least one usable code and the
  // opportunity carries a usable NAICS.
  const hasClientNaics = client.naicsCodes.some((c) => isUsableNaics(c))
  if (hasClientNaics && isUsableNaics(opportunity.naicsCode)) {
    dims.naics.present = true
    dims.naics.raw = clamp01(scoreNaicsDimension(client.naicsCodes, opportunity.naicsCode))
  }

  // PSC — present only when both sides carry a PSC. Absent → excluded
  // (non-penalizing), which is what proves this is renormalization, not
  // inflation: a null PSC must not lower the pair's score.
  const hasClientPsc = client.pscCodes.some((c) => (c ?? '').trim().length > 0)
  if (hasClientPsc && (opportunity.psc ?? '').trim().length > 0) {
    dims.psc.present = true
    dims.psc.raw = clamp01(scorePscDimension(client.pscCodes, opportunity.psc as string))
  }

  // Award size — present when the opportunity states a dollar value.
  if (opportunity.estimatedValue != null) {
    dims.awardSize.present = true
    dims.awardSize.raw = clamp01(
      scoreAwardSizeDimension(opportunity.estimatedValue, opportunity.historicalAvgAward ?? null)
    )
  }

  // Geography — present when both the firm's state and the place of
  // performance are known.
  if (client.state && opportunity.placeOfPerformance) {
    dims.geography.present = true
    dims.geography.raw = clamp01(
      scoreGeographyDimension(client.state, opportunity.placeOfPerformance)
    )
  }

  // Past performance — present only when the firm has a decided or submitted
  // record. A brand-new firm with no history is excluded (not penalized).
  const stats = client.performanceStats
  if (stats && stats.totalWon + stats.totalLost + stats.totalSubmitted > 0) {
    dims.pastPerformance.present = true
    dims.pastPerformance.raw = clamp01(scorePastPerformanceDimension(stats))
  }

  // Set-aside alignment — present only when the opportunity is set aside.
  const setAside = (opportunity.setAsideType ?? '').trim().toUpperCase()
  if (setAside.length > 0 && setAside !== 'NONE') {
    dims.setAsideAlignment.present = true
    dims.setAsideAlignment.raw = clamp01(
      scoreSetAsideAlignmentDimension(setAside, {
        sdvosb: client.sdvosb,
        wosb: client.wosb,
        hubzone: client.hubzone,
        smallBusiness: client.smallBusiness,
      })
    )
  }

  const dimensionsPresent = (Object.keys(dims) as MatchV2Dimension[]).filter(
    (k) => dims[k].present
  )

  let numerator = 0
  let denominator = 0
  for (const k of dimensionsPresent) {
    numerator += dims[k].weight * dims[k].raw
    denominator += dims[k].weight
  }

  const total = denominator > 0 ? Math.round((numerator / denominator) * 100) : 0

  return {
    total: Math.max(0, Math.min(100, total)),
    breakdown: dims,
    dimensionsPresent,
  }
}
