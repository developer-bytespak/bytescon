// =============================================================
// SCW-1 confidence component tests — pure-math safety net.
//
// Freezes the scoring math in place so future edits don't silently shift
// weights, half-lives, or shrinkage strength.
// =============================================================

import { describe, expect, it } from 'vitest'
import {
  scoreAwardFrequency,
  scoreAwardRecency,
  scoreDollarVolume,
  scoreSubawardPropensity,
  scoreSdvosbGoalGap,
  composeConfidence,
  SCW1_WEIGHTS,
} from './confidence'

const NOW = Date.now()
const yearsAgo = (y: number) => new Date(NOW - y * 365.25 * 24 * 60 * 60 * 1000)

describe('SCW1_WEIGHTS', () => {
  it('sums to 1.0', () => {
    const total = Object.values(SCW1_WEIGHTS).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1.0, 9)
  })
})

describe('scoreAwardFrequency', () => {
  const ctx = { topPastAwardsCount: 10, topTotalPastValue: 100_000_000 }

  it('returns zero when prime has no past awards', () => {
    const r = scoreAwardFrequency(
      { pastAwardsCount: 0, totalPastValue: 0, mostRecentAward: null },
      ctx,
    )
    expect(r.raw).toBe(0)
    expect(r.confidence).toBe(0)
    expect(r.reasoning).toMatch(/No past awards/)
  })

  it('top scorer gets raw 1.0 with full confidence', () => {
    const r = scoreAwardFrequency(
      { pastAwardsCount: 10, totalPastValue: 1, mostRecentAward: yearsAgo(0) },
      ctx,
    )
    expect(r.raw).toBe(1)
    expect(r.confidence).toBe(1)
    expect(r.weighted).toBeCloseTo(SCW1_WEIGHTS.awardFrequency, 9)
  })

  it('low-volume primes get reduced confidence even at high normalized raw', () => {
    const r = scoreAwardFrequency(
      { pastAwardsCount: 1, totalPastValue: 1, mostRecentAward: yearsAgo(0) },
      { topPastAwardsCount: 1, topTotalPastValue: 1 },
    )
    expect(r.raw).toBe(1)         // normalized against a top-of-1, still raw=1
    expect(r.confidence).toBe(0.3) // but confidence is honest about n=1
  })
})

describe('scoreAwardRecency', () => {
  it('returns zero confidence when date is missing', () => {
    const r = scoreAwardRecency({ pastAwardsCount: 5, totalPastValue: 1, mostRecentAward: null })
    expect(r.raw).toBe(0)
    expect(r.confidence).toBe(0)
  })

  it('today yields raw ~1.0', () => {
    const r = scoreAwardRecency({ pastAwardsCount: 1, totalPastValue: 1, mostRecentAward: yearsAgo(0) })
    expect(r.raw).toBeGreaterThan(0.99)
  })

  it('2-year-old award decays to ~0.5 (half-life)', () => {
    const r = scoreAwardRecency({ pastAwardsCount: 1, totalPastValue: 1, mostRecentAward: yearsAgo(2) })
    expect(r.raw).toBeCloseTo(0.5, 1)
  })

  it('4-year-old award decays to ~0.25', () => {
    const r = scoreAwardRecency({ pastAwardsCount: 1, totalPastValue: 1, mostRecentAward: yearsAgo(4) })
    expect(r.raw).toBeCloseTo(0.25, 1)
  })
})

describe('scoreDollarVolume', () => {
  const ctx = { topPastAwardsCount: 10, topTotalPastValue: 1_000_000_000 }

  it('zero volume → zero raw', () => {
    const r = scoreDollarVolume(
      { pastAwardsCount: 0, totalPastValue: 0, mostRecentAward: null },
      ctx,
    )
    expect(r.raw).toBe(0)
  })

  it('top scorer raw is 1.0', () => {
    const r = scoreDollarVolume(
      { pastAwardsCount: 1, totalPastValue: 1_000_000_000, mostRecentAward: yearsAgo(0) },
      ctx,
    )
    expect(r.raw).toBeCloseTo(1.0, 2)
  })

  it('log scale: 100M vs 1B compresses to ~0.91 (not 0.1)', () => {
    const r = scoreDollarVolume(
      { pastAwardsCount: 1, totalPastValue: 100_000_000, mostRecentAward: yearsAgo(0) },
      ctx,
    )
    // log10(1+1e8)/log10(1+1e9) ≈ 0.889
    expect(r.raw).toBeGreaterThan(0.85)
    expect(r.raw).toBeLessThan(0.95)
  })

  it('sub-$100K volume reflects low confidence', () => {
    const r = scoreDollarVolume(
      { pastAwardsCount: 1, totalPastValue: 50_000, mostRecentAward: yearsAgo(0) },
      ctx,
    )
    expect(r.confidence).toBe(0.3)
  })
})

describe('scoreSubawardPropensity', () => {
  it('returns confidence 0 with explicit reasoning when no subaward history', () => {
    const r = scoreSubawardPropensity({
      totalAwardDollars: 10_000_000,
      totalSubawardDollars: 0,
      sampleSize: 0,
    })
    expect(r.confidence).toBe(0)
    expect(r.reasoning).toMatch(/No subaward history/)
  })

  it('Bayesian shrinkage pulls thin samples toward the prior', () => {
    // Tiny prime with 1 sub at 90% sub-spend ratio — observed ratio is high
    // but the $50M prior dominates.
    const r = scoreSubawardPropensity({
      totalAwardDollars: 1_000_000,
      totalSubawardDollars: 900_000,
      sampleSize: 1,
    })
    // Observed = 0.9; shrunk should be much closer to the 0.3 default prior.
    expect(r.raw).toBeLessThan(0.5)
    expect(r.raw).toBeGreaterThan(0.25)
  })

  it('large samples dominate the prior', () => {
    // Big prime with large evidence at 60% — shrinkage is small.
    const r = scoreSubawardPropensity({
      totalAwardDollars: 1_000_000_000,
      totalSubawardDollars: 600_000_000,
      sampleSize: 200,
    })
    expect(r.raw).toBeGreaterThan(0.55)
    expect(r.confidence).toBe(1.0)
  })
})

describe('scoreSdvosbGoalGap', () => {
  it('returns confidence 0 with explicit reasoning when data unavailable', () => {
    const r = scoreSdvosbGoalGap({ hasGoalData: false, goalPercent: null, actualPercent: null })
    expect(r.confidence).toBe(0)
    expect(r.reasoning).toMatch(/SDVOSB subaward set-aside data unavailable/)
    expect(r.reasoning).toMatch(/R4/)
  })

  it('at-goal prime maps to raw 0.5', () => {
    const r = scoreSdvosbGoalGap({ hasGoalData: true, goalPercent: 3.0, actualPercent: 3.0 })
    expect(r.raw).toBeCloseTo(0.5, 2)
  })

  it('under-goal prime (under pressure) gets higher raw', () => {
    const r = scoreSdvosbGoalGap({ hasGoalData: true, goalPercent: 3.0, actualPercent: 1.0 })
    expect(r.raw).toBeGreaterThan(0.5)
    expect(r.reasoning).toMatch(/gap \+2\.0pp/)
  })

  it('over-goal prime gets lower raw', () => {
    const r = scoreSdvosbGoalGap({ hasGoalData: true, goalPercent: 3.0, actualPercent: 6.0 })
    expect(r.raw).toBeLessThan(0.5)
    expect(r.reasoning).toMatch(/gap -3\.0pp/)
  })
})

describe('composeConfidence', () => {
  const ctx = { topPastAwardsCount: 5, topTotalPastValue: 100_000_000 }
  const strongPrime = {
    pastAwardsCount: 5,
    totalPastValue: 100_000_000,
    mostRecentAward: yearsAgo(0.5),
  }
  const noSubs = { totalAwardDollars: 100_000_000, totalSubawardDollars: 0, sampleSize: 0 }
  const noSdvosb = { hasGoalData: false, goalPercent: null, actualPercent: null }

  it('composite excludes zero-confidence components from numerator AND denominator', () => {
    // Strong prime + two zero-confidence components (no subs, no SDVOSB
    // data). The two zero-confidence weights (0.20 + 0.15 = 0.35) should
    // NOT penalize the score — they're excluded from the average entirely.
    const components = {
      awardFrequency: scoreAwardFrequency(strongPrime, ctx),
      awardRecency: scoreAwardRecency(strongPrime),
      dollarVolume: scoreDollarVolume(strongPrime, ctx),
      subawardPropensity: scoreSubawardPropensity(noSubs),
      sdvosbGoalGap: scoreSdvosbGoalGap(noSdvosb),
    }
    const result = composeConfidence(components, 'citation here')
    const expectedNumerator =
      components.awardFrequency.weighted +
      components.awardRecency.weighted +
      components.dollarVolume.weighted
    const expectedDenominator = 0.65 // 0.30 + 0.20 + 0.15
    expect(result.composite).toBeCloseTo(expectedNumerator / expectedDenominator, 6)
    expect(result.coverage).toBeCloseTo(0.65, 2)
    expect(result.citation).toBe('citation here')
  })

  it('coverage is 1.0 when every component scored', () => {
    const allScored = {
      awardFrequency: scoreAwardFrequency(strongPrime, ctx),
      awardRecency: scoreAwardRecency(strongPrime),
      dollarVolume: scoreDollarVolume(strongPrime, ctx),
      subawardPropensity: scoreSubawardPropensity({
        totalAwardDollars: 1_000_000_000,
        totalSubawardDollars: 500_000_000,
        sampleSize: 150,
      }),
      sdvosbGoalGap: scoreSdvosbGoalGap({
        hasGoalData: true, goalPercent: 3.0, actualPercent: 1.0,
      }),
    }
    const result = composeConfidence(allScored, '')
    expect(result.coverage).toBeCloseTo(1.0, 2)
  })

  it('composite is 0 when every component has confidence 0', () => {
    const noPrime = { pastAwardsCount: 0, totalPastValue: 0, mostRecentAward: null }
    const allZero = {
      awardFrequency: scoreAwardFrequency(noPrime, ctx),
      awardRecency: scoreAwardRecency(noPrime),
      dollarVolume: scoreDollarVolume(noPrime, ctx),
      subawardPropensity: scoreSubawardPropensity(noSubs),
      sdvosbGoalGap: scoreSdvosbGoalGap(noSdvosb),
    }
    const result = composeConfidence(allZero, '')
    expect(result.composite).toBe(0)
    expect(result.coverage).toBe(0)
  })

  it('top reasons rank by weighted × confidence', () => {
    // Strong prime: awardFrequency and awardRecency dominate; sdvosbGoalGap
    // is zero-confidence so its reasoning should NOT lead.
    const components = {
      awardFrequency: scoreAwardFrequency(strongPrime, ctx),
      awardRecency: scoreAwardRecency(strongPrime),
      dollarVolume: scoreDollarVolume(strongPrime, ctx),
      subawardPropensity: scoreSubawardPropensity(noSubs),
      sdvosbGoalGap: scoreSdvosbGoalGap(noSdvosb),
    }
    const result = composeConfidence(components, '')
    expect(result.topReasons).toHaveLength(3)
    // Top reason should describe past awards (frequency, weight 0.30, confidence 1.0).
    expect(result.topReasons[0]).toMatch(/past award/)
    // SDVOSB unavailability should NEVER be in top reasons when confidence is zero.
    expect(result.topReasons.join(' ')).not.toMatch(/R4/)
  })
})
