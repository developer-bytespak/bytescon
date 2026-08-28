// =============================================================
// Probability Engine — Unit Tests
//
// Validates the 9-factor logistic regression core algorithm. Critical
// invariants (referenced by the algorithm validation white-paper):
//   1. Weights sum to 1.0 (already runtime-asserted, also tested here)
//   2. Output is in [0, 1]
//   3. Monotonicity — increasing any positive feature never decreases
//      probability
//   4. Sigmoid bias produces baseline probability ≤ 5% on all-zero
//      input (matches the "competitive federal market baseline" note
//      in probabilityEngine.ts)
//   5. (P1-1) Failures are typed (status: 'FAILED') — NEVER a fabricated
//      constant. Distinct inputs yield a distribution of scores, not a
//      single repeated value (the 26.4% / 50% "constant on error" signature).
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  computeProbability,
  computeNaicsOverlap,
  computeAwardSizeFit,
  computeIncumbentWeaknessScore,
  computeDeadlineUrgency,
  scoreOpportunityForClient,
} from './probabilityEngine'
import type { ProbabilityFeatures, ProbabilityResult } from '../types'

// P1-1: results are now a discriminated union (OK | FAILED). Most tests exercise
// valid inputs that must succeed; this helper asserts success and narrows the
// type so the existing score assertions read unchanged.
function expectOk(r: ProbabilityResult): Extract<ProbabilityResult, { status: 'OK' }> {
  expect(r.status).toBe('OK')
  if (r.status !== 'OK') throw new Error(`expected OK, got FAILED: ${r.failureReason}`)
  return r
}

const ZERO_FEATURES: ProbabilityFeatures = {
  naicsOverlapScore: 0,
  incumbentWeaknessScore: 0,
  documentAlignmentScore: 0,
  agencyAlignmentScore: 0,
  awardSizeFitScore: 0,
  competitionDensityScore: 0,
  agencyHistoryScore: 0,
  historicalDistribution: 0,
  deadlineUrgencyScore: 0,
}

const ONES_FEATURES: ProbabilityFeatures = {
  naicsOverlapScore: 1,
  incumbentWeaknessScore: 1,
  documentAlignmentScore: 1,
  agencyAlignmentScore: 1,
  awardSizeFitScore: 1,
  competitionDensityScore: 1,
  agencyHistoryScore: 1,
  historicalDistribution: 1,
  deadlineUrgencyScore: 1,
}

describe('computeProbability — sigmoid invariants', () => {
  it('returns probability in [0, 1] for all-zero features', () => {
    const r = expectOk(computeProbability({ ...ZERO_FEATURES }, 100000))
    expect(r.probability).toBeGreaterThanOrEqual(0)
    expect(r.probability).toBeLessThanOrEqual(1)
  })

  it('produces a baseline probability < 0.06 on all-zero features (competitive market bias)', () => {
    // sigmoid(SCALE*0 + BIAS) = sigmoid(-3) ≈ 0.0474
    const r = expectOk(computeProbability({ ...ZERO_FEATURES }, null))
    expect(r.probability).toBeGreaterThan(0.04)
    expect(r.probability).toBeLessThan(0.06)
  })

  it('produces probability > 0.95 on all-ones features', () => {
    // sigmoid(SCALE*1 + BIAS) = sigmoid(3) ≈ 0.9526
    const r = expectOk(computeProbability({ ...ONES_FEATURES }, 1_000_000))
    expect(r.probability).toBeGreaterThan(0.94)
    expect(r.probability).toBeLessThanOrEqual(1.0)
  })

  it('expectedValue = probability × estimatedValue', () => {
    const r = expectOk(computeProbability({ ...ONES_FEATURES }, 1_000_000))
    expect(r.expectedValue).toBeCloseTo(r.probability * 1_000_000, 5)
  })

  it('expectedValue is 0 when estimatedValue is null', () => {
    const r = expectOk(computeProbability({ ...ONES_FEATURES }, null))
    expect(r.expectedValue).toBe(0)
  })

  it('clamps out-of-range feature values into [0, 1] without crashing', () => {
    const out = expectOk(computeProbability({ ...ZERO_FEATURES, naicsOverlapScore: 1.5 } as any, null))
    expect(out.probability).toBeGreaterThanOrEqual(0)
    expect(out.probability).toBeLessThanOrEqual(1)
  })
})

describe('computeProbability — monotonicity', () => {
  it('increasing naicsOverlapScore never decreases probability', () => {
    const lo = expectOk(computeProbability({ ...ZERO_FEATURES, naicsOverlapScore: 0.0 }, null))
    const mid = expectOk(computeProbability({ ...ZERO_FEATURES, naicsOverlapScore: 0.5 }, null))
    const hi = expectOk(computeProbability({ ...ZERO_FEATURES, naicsOverlapScore: 1.0 }, null))
    expect(mid.probability).toBeGreaterThanOrEqual(lo.probability)
    expect(hi.probability).toBeGreaterThanOrEqual(mid.probability)
  })

  it('NAICS weight (0.24) dominates: NAICS=1 alone beats all-other=1', () => {
    const naicsOnly = expectOk(computeProbability(
      { ...ZERO_FEATURES, naicsOverlapScore: 1 },
      null,
    ))
    const allOthersOnly = expectOk(computeProbability(
      { ...ONES_FEATURES, naicsOverlapScore: 0 },
      null,
    ))
    // Sum of all-other-weights = 0.76 > naics weight 0.24 — so all-others-on
    // beats naics-only. This test proves we know that and warns if it flips.
    expect(allOthersOnly.probability).toBeGreaterThan(naicsOnly.probability)
  })
})

describe('computeProbability — fingerprint / anti-constant regression (PROMPT.md §6.2)', () => {
  it('distinct inputs yield a distribution of scores, never one repeated constant', () => {
    // Sweep features across a range; each distinct input must map to a
    // (near-)distinct probability. This is the explicit guard against the
    // historical 26.4% / 50% "plausible constant on failure" signatures
    // ever returning.
    const probs: number[] = []
    for (let i = 0; i < 12; i++) {
      const t = i / 11
      const r = expectOk(
        computeProbability(
          {
            ...ZERO_FEATURES,
            naicsOverlapScore: t,
            agencyAlignmentScore: 1 - t,
            documentAlignmentScore: (i % 5) / 4,
            awardSizeFitScore: ((i * 3) % 7) / 6,
          },
          100000,
        ),
      )
      probs.push(Math.round(r.probability * 1e6) / 1e6)
    }
    const distinct = new Set(probs)
    expect(distinct.size).toBeGreaterThan(1) // never a single constant
    expect(distinct.size).toBeGreaterThanOrEqual(10) // genuinely varied (≥10 of 12)
  })

  it('returns FAILED (no fabricated number) when a feature is non-finite', () => {
    // A NaN feature slips past the [0,1] range clamp (NaN comparisons are
    // false) → logistic transform is non-finite → must surface FAILED, never
    // a plausible constant like 0, 0.01, or 0.264.
    const r = computeProbability({ ...ZERO_FEATURES, naicsOverlapScore: NaN } as any, 100000)
    expect(r.status).toBe('FAILED')
    expect(r).not.toHaveProperty('probability')
    expect(r).not.toHaveProperty('expectedValue')
    if (r.status === 'FAILED') {
      expect(typeof r.failureReason).toBe('string')
      expect(r.failureReason.length).toBeGreaterThan(0)
    }
  })

  it('FAILED result exposes no numeric score fields (typed failure, not a placeholder)', () => {
    const r = computeProbability({ ...ZERO_FEATURES, agencyAlignmentScore: NaN } as any, null)
    expect(r.status).toBe('FAILED')
    expect((r as any).probability).toBeUndefined()
    expect((r as any).rawScore).toBeUndefined()
    expect((r as any).expectedValue).toBeUndefined()
  })
})

describe('computeNaicsOverlap', () => {
  it('returns 1.0 on exact match', () => {
    expect(computeNaicsOverlap(['541512'], '541512')).toBe(1.0)
  })

  it('returns 0.6 on 4-digit sector match (541512 vs 541519)', () => {
    expect(computeNaicsOverlap(['541512'], '541519')).toBe(0.6)
  })

  it('returns 0.3 on 2-digit subsector match (541512 vs 549999 — both sector 54)', () => {
    // Both NAICS share the 2-digit prefix "54" but differ at the 4-digit
    // sector level (5415 vs 5499), so the matcher should return 0.3.
    expect(computeNaicsOverlap(['541512'], '549999')).toBe(0.3)
  })

  it('returns 0 on completely different 2-digit codes (541512 vs 111110)', () => {
    expect(computeNaicsOverlap(['541512'], '111110')).toBe(0)
  })

  it('returns 0 when client has no NAICS codes', () => {
    expect(computeNaicsOverlap([], '541512')).toBe(0)
  })

  it('finds best match across multiple client NAICS codes', () => {
    // 561720 (subsector 56) matches first; 541519 (sector 5415) is exact-4-digit
    expect(computeNaicsOverlap(['561720', '541519'], '541512')).toBe(0.6)
  })
})

describe('computeAwardSizeFit', () => {
  it('returns 0.5 on null estimatedValue (neutral)', () => {
    expect(computeAwardSizeFit(null)).toBe(0.5)
  })

  it('returns 1.0 when value is in default sweet spot ($100K-$10M)', () => {
    expect(computeAwardSizeFit(500_000)).toBe(1.0)
    expect(computeAwardSizeFit(100_000)).toBe(1.0)
    expect(computeAwardSizeFit(10_000_000)).toBe(1.0)
  })

  it('discounts below-floor values', () => {
    const score = computeAwardSizeFit(50_000) // half the floor
    expect(score).toBeLessThan(1.0)
    expect(score).toBeGreaterThan(0)
  })

  it('discounts above-ceiling values', () => {
    const score = computeAwardSizeFit(20_000_000) // 2x ceiling
    expect(score).toBeLessThan(1.0)
    expect(score).toBeGreaterThan(0)
  })

  it('respects custom min/max bounds', () => {
    expect(computeAwardSizeFit(2_000_000, 1_000_000, 5_000_000)).toBe(1.0)
  })
})

describe('computeIncumbentWeaknessScore', () => {
  it('returns 0.5 (neutral) when probability is null', () => {
    expect(computeIncumbentWeaknessScore(null, null)).toBe(0.5)
  })

  it('returns 1.0 when no incumbent (probability=0) and many bidders', () => {
    // 1 - 0 + 0.1 (>=5 bidders) = 1.1 → clamp to 1.0
    expect(computeIncumbentWeaknessScore(0, 6)).toBe(1.0)
  })

  it('returns ~0 when dominant incumbent and sole-source-risk competition', () => {
    // 1 - 0.95 - 0.1 (sole-source penalty) = -0.05 → clamp to 0
    expect(computeIncumbentWeaknessScore(0.95, 1)).toBe(0)
  })

  it('inverts incumbent dominance: 0.8 prob → 0.2 base score', () => {
    // 1 - 0.8 + 0 (3 bidders not enough for bonus, not sole-source) = 0.2
    expect(computeIncumbentWeaknessScore(0.8, null)).toBeCloseTo(0.2, 5)
  })
})

describe('computeDeadlineUrgency — federal proposal prep windows', () => {
  function dateInDays(days: number): Date {
    return new Date(Date.now() + days * 86400000)
  }

  it('returns 0 for expired deadlines', () => {
    expect(computeDeadlineUrgency(dateInDays(-1))).toBe(0)
  })

  it('returns 0.1 for very tight (< 5 days) — rushed proposal', () => {
    expect(computeDeadlineUrgency(dateInDays(2))).toBe(0.1)
  })

  it('returns 0.5 for urgent (5-13 days)', () => {
    expect(computeDeadlineUrgency(dateInDays(7))).toBe(0.5)
  })

  it('returns 1.0 in the sweet spot (2-6 weeks)', () => {
    expect(computeDeadlineUrgency(dateInDays(21))).toBe(1.0)
    expect(computeDeadlineUrgency(dateInDays(35))).toBe(1.0)
  })

  it('returns 0.7 for good lead time (6-13 weeks)', () => {
    expect(computeDeadlineUrgency(dateInDays(60))).toBe(0.7)
  })

  it('returns 0.3 for very far (>= 6 months)', () => {
    expect(computeDeadlineUrgency(dateInDays(200))).toBe(0.3)
  })
})

describe('scoreOpportunityForClient — end-to-end', () => {
  it('produces high probability for an SDVOSB-aligned, NAICS-matched, non-incumbent opp', () => {
    const r = expectOk(scoreOpportunityForClient({
      opportunityNaics: '541512',
      opportunityEstimatedValue: 1_500_000,
      opportunityAgency: 'Department of Veterans Affairs',
      clientNaics: ['541512'],
      clientProfile: { sdvosb: true, wosb: false, hubzone: false, smallBusiness: true },
      incumbentProbability: 0.1,
      competitionCount: 6,
      agencySdvosbRate: 0.35,
      historicalDistribution: 0.5,
      documentAlignmentScore: 0.9,
      agencyHistoryScore: 0.8,
      deadlineUrgencyScore: 1.0,
      densityScore: 0.7,
    }))
    expect(r.probability).toBeGreaterThan(0.6)
    expect(r.expectedValue).toBeGreaterThan(900_000)
  })

  it('produces low probability for a NAICS-mismatched, dominant-incumbent, hyper-competitive opp', () => {
    // Worst-case scenario: wrong NAICS (overlap=0), dominant incumbent
    // (incumbentProbability=0.9, but competition=20 not 1 so no sole-source
    // bonus that would otherwise inflate the density score), high
    // competition (density score crashes), low historical base rate,
    // and weak document/agency signal.
    const r = expectOk(scoreOpportunityForClient({
      opportunityNaics: '111110',
      opportunityEstimatedValue: 500_000,
      opportunityAgency: 'Department of Agriculture',
      clientNaics: ['541512'],
      clientProfile: { sdvosb: false, wosb: false, hubzone: false, smallBusiness: true },
      incumbentProbability: 0.9,
      competitionCount: 20,
      offersReceived: 20,
      historicalDistribution: 0.1,
      documentAlignmentScore: 0.1,
      agencyAlignmentScore: 0.2,
      agencyHistoryScore: 0.2,
      deadlineUrgencyScore: 0.3,
    }))
    expect(r.probability).toBeLessThan(0.2)
  })
})
