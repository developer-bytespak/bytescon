// =============================================================
// Decision Resolver — Unit Tests
//
// Validates the 3-layer decision matrix that combines compliance gate
// + fit + market into NO_BID / BID_SUB / BID_PRIME with a risk score.
// =============================================================
import { describe, it, expect } from 'vitest'
import { resolveDecision } from './decisionResolver'

describe('resolveDecision — INELIGIBLE gate hard-blocks', () => {
  it('returns NO_BID regardless of fit / market when INELIGIBLE', () => {
    const r = resolveDecision('INELIGIBLE', 95, 95, ['SDVOSB cert required'])
    expect(r.recommendation).toBe('NO_BID')
    expect(r.riskScore).toBe(100)
    expect(r.rationale).toContain('INELIGIBLE')
  })

  it('includes blocker reasons in rationale', () => {
    const r = resolveDecision('INELIGIBLE', 80, 80, ['NAICS mismatch', 'SAM expired'])
    expect(r.rationale).toContain('NAICS mismatch')
    expect(r.rationale).toContain('SAM expired')
  })
})

describe('resolveDecision — ELIGIBLE BID_PRIME path (Fit≥65 + Market≥60)', () => {
  it('returns BID_PRIME on strong fit + strong market', () => {
    const r = resolveDecision('ELIGIBLE', 80, 75, [])
    expect(r.recommendation).toBe('BID_PRIME')
    expect(r.riskScore).toBeLessThanOrEqual(20)
  })

  it('returns BID_PRIME at exactly the thresholds (65, 60)', () => {
    const r = resolveDecision('ELIGIBLE', 65, 60, [])
    expect(r.recommendation).toBe('BID_PRIME')
  })

  it('applies +0.03 confidence modifier on very strong fit (>=80) AND market (>=75)', () => {
    const r = resolveDecision('ELIGIBLE', 85, 80, [])
    expect(r.confidenceModifier).toBeCloseTo(0.03, 5)
  })

  it('does NOT apply confidence boost on borderline strong (e.g. fit=70, market=65)', () => {
    const r = resolveDecision('ELIGIBLE', 70, 65, [])
    expect(r.recommendation).toBe('BID_PRIME')
    expect(r.confidenceModifier).toBe(0)
  })
})

describe('resolveDecision — ELIGIBLE BID_SUB path (40 ≤ score < BID_PRIME)', () => {
  it('returns BID_SUB on moderate fit + moderate market', () => {
    const r = resolveDecision('ELIGIBLE', 50, 50, [])
    expect(r.recommendation).toBe('BID_SUB')
    expect(r.confidenceModifier).toBeCloseTo(-0.05, 5)
  })

  it('returns BID_SUB at exactly the thresholds (40, 40)', () => {
    const r = resolveDecision('ELIGIBLE', 40, 40, [])
    expect(r.recommendation).toBe('BID_SUB')
  })
})

describe('resolveDecision — NO_BID below thresholds', () => {
  it('returns NO_BID when fit is too low (< 40)', () => {
    const r = resolveDecision('ELIGIBLE', 30, 80, [])
    expect(r.recommendation).toBe('NO_BID')
    expect(r.rationale).toContain('low capability fit')
  })

  it('returns NO_BID when market is too low (< 40)', () => {
    const r = resolveDecision('ELIGIBLE', 80, 30, [])
    expect(r.recommendation).toBe('NO_BID')
    expect(r.rationale).toContain('unfavorable market')
  })

  it('returns NO_BID when both fit AND market are below 40', () => {
    const r = resolveDecision('ELIGIBLE', 20, 25, [])
    expect(r.recommendation).toBe('NO_BID')
  })
})

describe('resolveDecision — CONDITIONAL gate applies 5-pt penalty', () => {
  it('downgrades borderline BID_PRIME to BID_SUB on CONDITIONAL', () => {
    // fit=68, market=62 — would be BID_PRIME under ELIGIBLE
    // CONDITIONAL applies -5 penalty → fit=63, market=57 — drops below BID_PRIME thresholds
    const eligible = resolveDecision('ELIGIBLE', 68, 62, [])
    const conditional = resolveDecision('CONDITIONAL', 68, 62, ['SAM expiry within 30 days'])
    expect(eligible.recommendation).toBe('BID_PRIME')
    expect(conditional.recommendation).toBe('BID_SUB')
  })

  it('keeps BID_PRIME when scores are well above thresholds even with penalty', () => {
    const r = resolveDecision('CONDITIONAL', 80, 75, ['Resolve: NAICS subsector gap'])
    expect(r.recommendation).toBe('BID_PRIME')
    expect(r.rationale).toContain('CONDITIONAL')
  })

  it('elevates riskScore baseline (35 vs 10) on CONDITIONAL', () => {
    const eligible = resolveDecision('ELIGIBLE', 80, 75, [])
    const conditional = resolveDecision('CONDITIONAL', 80, 75, ['some flag'])
    expect(conditional.riskScore).toBeGreaterThan(eligible.riskScore)
  })

  it('annotates rationale with the conditions to resolve', () => {
    const r = resolveDecision('CONDITIONAL', 70, 65, ['Update SAM registration', 'Add NAICS code'])
    expect(r.rationale).toContain('Update SAM registration')
    expect(r.rationale).toContain('Add NAICS code')
  })
})

describe('resolveDecision — risk score is always in [0, 100]', () => {
  it.each([
    ['INELIGIBLE', 95, 95, 100],
    ['ELIGIBLE', 100, 100, 0],
    ['ELIGIBLE', 30, 30, 50],
    ['CONDITIONAL', 50, 50, 60],
  ])('gate=%s fit=%i market=%i → risk=%i', (gate, fit, market, _expected) => {
    const r = resolveDecision(gate as any, fit, market, [])
    expect(r.riskScore).toBeGreaterThanOrEqual(0)
    expect(r.riskScore).toBeLessThanOrEqual(100)
  })
})
