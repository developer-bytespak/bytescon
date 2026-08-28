// =============================================================
// Decision Resolver — Combines all 3 scoring layers into a recommendation
//
// Decision Matrix:
// ┌────────────┬──────────┬──────────────┬──────────────┐
// │ Gate       │ Fit ≥ 65 │ Market ≥ 60  │ Result       │
// ├────────────┼──────────┼──────────────┼──────────────┤
// │ INELIGIBLE │ (any)    │ (any)        │ NO_BID       │
// │ ELIGIBLE   │ Yes      │ Yes          │ BID_PRIME    │
// │ ELIGIBLE   │ ≥40      │ ≥40          │ BID_SUB      │
// │ CONDITIONAL│ Yes      │ Yes*         │ BID_PRIME    │ (* 5-pt penalty applied)
// │ CONDITIONAL│ ≥40      │ ≥40*         │ BID_SUB      │ (* 5-pt penalty applied)
// │ (any)      │ < 40     │ < 40         │ NO_BID       │
// └────────────┴──────────┴──────────────┴──────────────┘
// =============================================================

type Recommendation = 'NO_BID' | 'BID_SUB' | 'BID_PRIME'
type ComplianceGate = 'ELIGIBLE' | 'CONDITIONAL' | 'INELIGIBLE'

export interface DecisionResolverOutput {
  recommendation: Recommendation
  rationale: string
  confidenceModifier: number  // additive modifier to win probability (-0.10 to +0.05)
  riskScore: number           // 0-100, higher = riskier
}

export function resolveDecision(
  gate: ComplianceGate,
  fitScore: number,
  marketScore: number,
  complianceFlags: string[]
): DecisionResolverOutput {

  // ── Layer 1: Hard block ────────────────────────────────────
  if (gate === 'INELIGIBLE') {
    return {
      recommendation: 'NO_BID',
      rationale: `Compliance gate: INELIGIBLE — ${complianceFlags.join('; ')}`,
      confidenceModifier: 0,
      riskScore: 100,
    }
  }

  // ── Conditional penalty — reduces effective scores by 5 pts ─
  const penalty = gate === 'CONDITIONAL' ? 5 : 0
  const adjFit = fitScore - penalty
  const adjMarket = marketScore - penalty

  // Base risk from compliance status
  let riskScore = gate === 'CONDITIONAL' ? 35 : 10

  // ── BID_PRIME decision ─────────────────────────────────────
  if (adjFit >= 65 && adjMarket >= 60) {
    const conditionalNote = gate === 'CONDITIONAL'
      ? ` (CONDITIONAL — resolve: ${complianceFlags.join(', ')})`
      : ''
    return {
      recommendation: 'BID_PRIME',
      rationale:
        `Strong capability fit (${fitScore}/100) and market position (${marketScore}/100)${conditionalNote}`,
      confidenceModifier: adjFit >= 80 && adjMarket >= 75 ? 0.03 : 0,
      riskScore: clampRisk(riskScore + (adjFit < 75 ? 15 : 0) + (adjMarket < 70 ? 10 : 0)),
    }
  }

  // ── BID_SUB decision ──────────────────────────────────────
  if (adjFit >= 40 && adjMarket >= 40) {
    const conditionalNote = gate === 'CONDITIONAL'
      ? ` (CONDITIONAL — resolve: ${complianceFlags.join(', ')})`
      : ''
    return {
      recommendation: 'BID_SUB',
      rationale:
        `Moderate fit (${fitScore}/100) and market (${marketScore}/100) — subcontract teaming recommended${conditionalNote}`,
      confidenceModifier: -0.05, // Sub-bid has inherent uncertainty discount
      riskScore: clampRisk(riskScore + 25),
    }
  }

  // ── NO_BID ────────────────────────────────────────────────
  const reasons: string[] = []
  if (fitScore < 40) reasons.push(`low capability fit (${fitScore}/100)`)
  if (marketScore < 40) reasons.push(`unfavorable market conditions (${marketScore}/100)`)

  return {
    recommendation: 'NO_BID',
    rationale: `Below pursuit threshold — ${reasons.join(', ')}`,
    confidenceModifier: 0,
    riskScore: clampRisk(riskScore + 40),
  }
}

function clampRisk(v: number): number {
  return Math.max(0, Math.min(100, v))
}
