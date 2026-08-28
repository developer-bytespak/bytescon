// =============================================================
// Scorecard scoring unit tests — determinism, weighted total, threshold
// boundaries, weight validation. Pure logic, no DB.
// =============================================================
import { describe, it, expect } from 'vitest'
import { computeScorecard, validateWeights, isValidScore, DEFAULT_CRITERIA, ScoringCriterion } from './scorecardScoring'

const crit = (key: string, weight: number, score: number | null, required = true): ScoringCriterion => ({ key, weight, score, required })

describe('validateWeights', () => {
  it('accepts active weights summing to exactly 100', () => {
    expect(validateWeights([{ weight: 60 }, { weight: 40 }])).toBeNull()
  })
  it('rejects totals other than 100', () => {
    expect(validateWeights([{ weight: 60 }, { weight: 30 }])).toMatch(/total exactly 100/i)
    expect(validateWeights([{ weight: 60 }, { weight: 50 }])).toMatch(/total exactly 100/i)
  })
  it('rejects negative and non-integer weights', () => {
    expect(validateWeights([{ weight: -10 }, { weight: 110 }])).toMatch(/negative/i)
    expect(validateWeights([{ weight: 50.5 }, { weight: 49.5 }])).toMatch(/whole numbers/i)
  })
  it('ignores inactive criteria in the sum', () => {
    expect(validateWeights([{ weight: 100 }, { weight: 999, isActive: false }])).toBeNull()
  })
  it('default criteria sum to exactly 100', () => {
    expect(validateWeights(DEFAULT_CRITERIA.map((c) => ({ weight: c.weight })))).toBeNull()
  })
})

describe('isValidScore', () => {
  it('accepts integers 0..100, rejects out-of-range and non-integers', () => {
    expect(isValidScore(0)).toBe(true)
    expect(isValidScore(100)).toBe(true)
    expect(isValidScore(-1)).toBe(false)
    expect(isValidScore(101)).toBe(false)
    expect(isValidScore(50.5)).toBe(false)
  })
})

describe('computeScorecard — weighted total', () => {
  it('computes a deterministic integer weighted total', () => {
    // 60@70 + 40@50 = (60*70 + 40*50)/100 = (4200+2000)/100 = 62
    const r = computeScorecard([crit('a', 60, 70), crit('b', 40, 50)])
    expect(r.totalScore).toBe(62)
    expect(r.complete).toBe(true)
  })
  it('is stable across repeated calls (determinism)', () => {
    const input = [crit('a', 33, 77), crit('b', 33, 41), crit('c', 34, 88)]
    const a = computeScorecard(input)
    const b = computeScorecard(input)
    expect(a).toEqual(b)
  })
  it('rounds half-up deterministically', () => {
    // 50@45 + 50@46 = (2250+2300)/100 = 45.5 → 46
    expect(computeScorecard([crit('a', 50, 45), crit('b', 50, 46)]).totalScore).toBe(46)
  })
})

describe('computeScorecard — recommendation thresholds (scorecard-v1)', () => {
  const one = (score: number) => computeScorecard([crit('a', 100, score)])
  it('BID at the 70 boundary and above', () => {
    expect(one(70).recommendation).toBe('BID')
    expect(one(85).recommendation).toBe('BID')
  })
  it('CONDITIONAL from 50 up to 69', () => {
    expect(one(50).recommendation).toBe('CONDITIONAL')
    expect(one(69).recommendation).toBe('CONDITIONAL')
  })
  it('NO_BID below 50', () => {
    expect(one(49).recommendation).toBe('NO_BID')
    expect(one(0).recommendation).toBe('NO_BID')
  })
  it('REVIEW_REQUIRED when a required criterion is unscored, regardless of total', () => {
    const r = computeScorecard([crit('a', 50, 100), crit('b', 50, null, true)])
    expect(r.recommendation).toBe('REVIEW_REQUIRED')
    expect(r.complete).toBe(false)
    expect(r.missingRequiredKeys).toEqual(['b'])
  })
  it('optional unscored criteria do not force REVIEW_REQUIRED', () => {
    const r = computeScorecard([crit('a', 100, 80), crit('b', 0, null, false)])
    expect(r.recommendation).toBe('BID')
    expect(r.complete).toBe(true)
  })
})
