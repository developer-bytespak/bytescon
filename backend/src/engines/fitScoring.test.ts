// =============================================================
// Fit Score — Unit Tests
//
// Validates the 6-factor weighted composite that produces a 0-100
// "can this client execute this contract" score. Critical invariants:
//   - Output is always in [0, 100]
//   - Breakdown subscores all in [0, 100]
//   - NAICS exact match dominates (25% weight)
//   - Penalty history meaningfully discounts the score
// =============================================================
import { describe, it, expect } from 'vitest'
import { computeFitScore } from './fitScoring'

const NEAR_FUTURE = new Date(Date.now() + 30 * 86400000) // 30 days out — sweet spot

const STRONG_CLIENT = {
  naicsCodes: ['541512'],
  sdvosb: true,
  wosb: false,
  hubzone: false,
  smallBusiness: true,
  state: 'VA',
  performanceStats: {
    totalWon: 8,
    totalLost: 2,
    totalSubmitted: 10,
    completionRate: 0.95,
    totalPenalties: 0,
  },
}

const STRONG_OPP = {
  naicsCode: '541512',
  estimatedValue: 1_500_000,
  responseDeadline: NEAR_FUTURE,
  placeOfPerformance: 'Arlington, VA',
  historicalAvgAward: 1_200_000,
}

describe('computeFitScore — invariants', () => {
  it('returns total and breakdown in [0, 100]', () => {
    const r = computeFitScore(STRONG_CLIENT, STRONG_OPP)
    expect(r.total).toBeGreaterThanOrEqual(0)
    expect(r.total).toBeLessThanOrEqual(100)
    Object.values(r.breakdown).forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    })
  })

  it('returns integer total + breakdown', () => {
    const r = computeFitScore(STRONG_CLIENT, STRONG_OPP)
    expect(Number.isInteger(r.total)).toBe(true)
    Object.values(r.breakdown).forEach((v) => {
      expect(Number.isInteger(v)).toBe(true)
    })
  })
})

describe('computeFitScore — strong vs weak', () => {
  it('strong-fit client+opp scores >= 90', () => {
    const r = computeFitScore(STRONG_CLIENT, STRONG_OPP)
    expect(r.total).toBeGreaterThanOrEqual(90)
  })

  it('NAICS-mismatched opportunity scores significantly lower', () => {
    const mismatch = computeFitScore(STRONG_CLIENT, { ...STRONG_OPP, naicsCode: '111110' })
    const matched = computeFitScore(STRONG_CLIENT, STRONG_OPP)
    expect(matched.total - mismatch.total).toBeGreaterThanOrEqual(15)
  })

  it('client with no NAICS codes scores naicsDepth = 0', () => {
    const r = computeFitScore({ ...STRONG_CLIENT, naicsCodes: [] }, STRONG_OPP)
    expect(r.breakdown.naicsDepth).toBe(0)
  })

  it('client with no performance stats gets neutral baseline (~40) on past performance', () => {
    const r = computeFitScore({ ...STRONG_CLIENT, performanceStats: null }, STRONG_OPP)
    expect(r.breakdown.pastPerformance).toBeGreaterThanOrEqual(35)
    expect(r.breakdown.pastPerformance).toBeLessThanOrEqual(50)
  })
})

describe('computeFitScore — capacity fit ratio thresholds', () => {
  it('scores 100 when contract is in 0.5x-2x of historical avg', () => {
    const r = computeFitScore(STRONG_CLIENT, {
      ...STRONG_OPP,
      estimatedValue: 1_500_000,
      historicalAvgAward: 1_000_000,
    })
    expect(r.breakdown.capacityFit).toBe(100)
  })

  it('discounts when contract is much larger than historical (10x+)', () => {
    const r = computeFitScore(STRONG_CLIENT, {
      ...STRONG_OPP,
      estimatedValue: 50_000_000,
      historicalAvgAward: 1_000_000,
    })
    expect(r.breakdown.capacityFit).toBeLessThanOrEqual(30)
  })

  it('returns 50 (neutral) when estimatedValue is null', () => {
    const r = computeFitScore(STRONG_CLIENT, { ...STRONG_OPP, estimatedValue: null })
    expect(r.breakdown.capacityFit).toBe(50)
  })
})

describe('computeFitScore — geographic fit', () => {
  it('returns 100 when state appears in placeOfPerformance', () => {
    const r = computeFitScore({ ...STRONG_CLIENT, state: 'VA' }, { ...STRONG_OPP, placeOfPerformance: 'Reston, VA' })
    expect(r.breakdown.geographicFit).toBe(100)
  })

  it('returns 80 for nationwide / remote contracts', () => {
    const r = computeFitScore({ ...STRONG_CLIENT, state: 'CA' }, { ...STRONG_OPP, placeOfPerformance: 'NATIONWIDE' })
    expect(r.breakdown.geographicFit).toBe(80)
  })

  it('rewards DC-area cluster cross-state matches', () => {
    const r = computeFitScore({ ...STRONG_CLIENT, state: 'MD' }, { ...STRONG_OPP, placeOfPerformance: 'Crystal City, VA' })
    expect(r.breakdown.geographicFit).toBe(75)
  })

  it('returns 40 when state is unrelated to placeOfPerformance', () => {
    const r = computeFitScore({ ...STRONG_CLIENT, state: 'CA' }, { ...STRONG_OPP, placeOfPerformance: 'Boston, MA' })
    expect(r.breakdown.geographicFit).toBe(40)
  })
})

describe('computeFitScore — resource readiness (deadline window)', () => {
  function deadline(days: number) {
    return { ...STRONG_OPP, responseDeadline: new Date(Date.now() + days * 86400000) }
  }

  it('returns 100 with > 45 days lead time', () => {
    const r = computeFitScore(STRONG_CLIENT, deadline(60))
    expect(r.breakdown.resourceReadiness).toBe(100)
  })

  it('returns 5 (near-zero) when deadline is < 3 days', () => {
    const r = computeFitScore(STRONG_CLIENT, deadline(1))
    expect(r.breakdown.resourceReadiness).toBe(5)
  })

  it('monotonically degrades as deadline approaches', () => {
    const far = computeFitScore(STRONG_CLIENT, deadline(60)).breakdown.resourceReadiness
    const near = computeFitScore(STRONG_CLIENT, deadline(20)).breakdown.resourceReadiness
    const tight = computeFitScore(STRONG_CLIENT, deadline(8)).breakdown.resourceReadiness
    expect(far).toBeGreaterThan(near)
    expect(near).toBeGreaterThan(tight)
  })
})

describe('computeFitScore — financial strength penalty drag', () => {
  function withPenalties(amount: number) {
    return {
      ...STRONG_CLIENT,
      performanceStats: { ...STRONG_CLIENT.performanceStats!, totalPenalties: amount },
    }
  }

  it('returns 100 with zero penalties', () => {
    const r = computeFitScore(withPenalties(0), STRONG_OPP)
    expect(r.breakdown.financialStrength).toBe(100)
  })

  it('drops to 30 with > $100K in penalties', () => {
    const r = computeFitScore(withPenalties(150_000), STRONG_OPP)
    expect(r.breakdown.financialStrength).toBe(30)
  })

  it('total fit score meaningfully decreases with high penalties', () => {
    const clean = computeFitScore(withPenalties(0), STRONG_OPP).total
    const penalized = computeFitScore(withPenalties(200_000), STRONG_OPP).total
    expect(clean - penalized).toBeGreaterThanOrEqual(5)
  })
})

describe('computeFitScore — relevant past-performance blend (flag-gated input)', () => {
  // A mid-tier client so the past-performance factor has headroom to move
  // in both directions when the structured relevance signal is supplied.
  const MID_CLIENT = {
    ...STRONG_CLIENT,
    performanceStats: {
      totalWon: 1,
      totalLost: 1,
      totalSubmitted: 2,
      completionRate: 0.5,
      totalPenalties: 0,
    },
  }

  it('is a no-op when no relevant signal is supplied (back-compat)', () => {
    const without = computeFitScore(MID_CLIENT, STRONG_OPP).breakdown.pastPerformance
    const withZero = computeFitScore(
      { ...MID_CLIENT, relevantPastPerformance: { matchedCount: 0, avgCparsScore: 100 } },
      STRONG_OPP
    ).breakdown.pastPerformance
    expect(withZero).toBe(without)
  })

  it('lifts the past-performance factor for strong, relevant CPARS history', () => {
    const base = computeFitScore(MID_CLIENT, STRONG_OPP).breakdown.pastPerformance
    const boosted = computeFitScore(
      { ...MID_CLIENT, relevantPastPerformance: { matchedCount: 3, avgCparsScore: 100 } },
      STRONG_OPP
    ).breakdown.pastPerformance
    expect(boosted).toBeGreaterThan(base)
  })

  it('penalises sub-baseline (marginal) relevant CPARS history', () => {
    const base = computeFitScore(MID_CLIENT, STRONG_OPP).breakdown.pastPerformance
    const dragged = computeFitScore(
      { ...MID_CLIENT, relevantPastPerformance: { matchedCount: 2, avgCparsScore: 30 } },
      STRONG_OPP
    ).breakdown.pastPerformance
    expect(dragged).toBeLessThan(base)
  })

  it('keeps the factor within [0, 100] even with max boost', () => {
    const r = computeFitScore(
      { ...STRONG_CLIENT, relevantPastPerformance: { matchedCount: 99, avgCparsScore: 100 } },
      STRONG_OPP
    )
    expect(r.breakdown.pastPerformance).toBeLessThanOrEqual(100)
    expect(r.breakdown.pastPerformance).toBeGreaterThanOrEqual(0)
  })
})
