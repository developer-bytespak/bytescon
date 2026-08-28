// =============================================================
// §7.6 — Competitive range positioning.
//
// The full boundary matrix — below p25, exactly p25, between p25 and the
// median, exactly the median, between median and p75, exactly p75, above p75,
// an extreme outlier, an insufficient cohort, and a missing price.
//
// And the wording rule that matters most: below the range is never described
// as a good price and above it is never described as a bad one.
// =============================================================
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  assessCompetitiveRange,
  pricePercentile,
  warrantsReview,
  OUTLIER_IQR_MULTIPLIER,
  COMPETITIVE_RANGE_POLICY_VERSION,
} from './competitiveRange'
import { computeDistribution, MIN_BENCHMARK_COHORT_SIZE, type BenchmarkResult } from './awardBenchmark'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const NOW = new Date('2026-08-12T00:00:00.000Z')

/**
 * A cohort of nine awards from 100k to 180k in 10k steps.
 * p25 = 120,000.00 · median = 140,000.00 · p75 = 160,000.00 · IQR = 40,000.00
 */
const AMOUNTS = ['100000.00', '110000.00', '120000.00', '130000.00', '140000.00', '150000.00', '160000.00', '170000.00', '180000.00']

function cohort(amounts: string[] = AMOUNTS): BenchmarkResult {
  const values = amounts.map((a) => D(a))
  return {
    filterLevel: 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND',
    relaxedFilters: [],
    naics: '541512',
    agency: 'DoD',
    setAside: 'SDVOSB',
    valueBandLow: D('25000.00'),
    valueBandHigh: D('400000.00'),
    periodStart: new Date('2021-08-12T00:00:00.000Z'),
    periodEnd: NOW,
    cohortSize: amounts.length,
    sourceIds: amounts.map((_, i) => `award-${i}`),
    excludedSourceIds: [],
    exclusionReasons: [],
    distribution: computeDistribution(values),
    dataSufficiency: amounts.length >= MIN_BENCHMARK_COHORT_SIZE ? 'PARTIAL' : 'INSUFFICIENT_DATA',
    limitations: [],
    included: amounts.map((a, i) => ({
      awardId: `award-${i}`, agency: 'DoD', naics: '541512', setAside: 'SDVOSB',
      awardDate: NOW, awardAmount: D(a), awardType: 'DO',
      contractNumber: `C${i}`, recipientName: `R${i}`,
    })),
    inputHash: 'hash',
  }
}

const assess = (price: string | null, benchmark = cohort()) =>
  assessCompetitiveRange({ proposedPrice: price === null ? null : D(price), benchmark })

// -------------------------------------------------------------

describe('the fixture cohort has the quartiles the matrix assumes', () => {
  it('pins p25, median and p75', () => {
    const d = cohort().distribution
    expect(d.p25!.toFixed(2)).toBe('120000.00')
    expect(d.median!.toFixed(2)).toBe('140000.00')
    expect(d.p75!.toFixed(2)).toBe('160000.00')
  })
})

describe('the boundary matrix', () => {
  it('classifies a price below p25 as BELOW_HISTORICAL_RANGE', () => {
    expect(assess('110000.00').state).toBe('BELOW_HISTORICAL_RANGE')
  })

  it('classifies a price exactly at p25 as WITHIN', () => {
    // The band is inclusive at both quartiles: p25 is inside the range.
    expect(assess('120000.00').state).toBe('WITHIN_HISTORICAL_RANGE')
  })

  it('classifies a price between p25 and the median as WITHIN', () => {
    expect(assess('130000.00').state).toBe('WITHIN_HISTORICAL_RANGE')
  })

  it('classifies a price exactly at the median as WITHIN', () => {
    expect(assess('140000.00').state).toBe('WITHIN_HISTORICAL_RANGE')
  })

  it('classifies a price between the median and p75 as WITHIN', () => {
    expect(assess('150000.00').state).toBe('WITHIN_HISTORICAL_RANGE')
  })

  it('classifies a price exactly at p75 as WITHIN', () => {
    expect(assess('160000.00').state).toBe('WITHIN_HISTORICAL_RANGE')
  })

  it('classifies a price above p75 as ABOVE_HISTORICAL_RANGE', () => {
    expect(assess('170000.00').state).toBe('ABOVE_HISTORICAL_RANGE')
  })

  it('classifies a price beyond the Tukey fence as EXTREME_OUTLIER', () => {
    // p75 160,000 + 3 × IQR 40,000 = 280,000. Anything above that is extreme.
    expect(assess('280000.01').state).toBe('EXTREME_OUTLIER')
    expect(assess('279999.99').state).toBe('ABOVE_HISTORICAL_RANGE')
  })

  it('classifies an extremely low price as EXTREME_OUTLIER too', () => {
    // p25 120,000 − 3 × 40,000 = 0. A price below that is extreme.
    const tight = cohort(['100000.00', '101000.00', '102000.00', '103000.00', '104000.00', '105000.00', '106000.00'])
    // p25 101,500 − 3 × (104,500 − 101,500) = 92,500
    expect(assessCompetitiveRange({ proposedPrice: D('50000.00'), benchmark: tight }).state).toBe('EXTREME_OUTLIER')
  })

  it('uses the documented IQR multiplier', () => {
    expect(OUTLIER_IQR_MULTIPLIER).toBe(3)
  })
})

describe('percentile honesty', () => {
  it('reports a rank-based percentile a reader can verify', () => {
    // Five of nine awards are at or below 140,000 → 56%.
    expect(assess('140000.00').percentile).toBe(56)
  })

  it('reports 100 when the price is above every award', () => {
    expect(assess('999999.00').percentile).toBe(100)
  })

  it('reports 0 when the price is below every award', () => {
    expect(assess('1.00').percentile).toBe(0)
  })

  it('returns null — never a placeholder — below the minimum cohort', () => {
    const small = cohort(['100000.00', '110000.00', '120000.00'])
    const r = assessCompetitiveRange({ proposedPrice: D('115000.00'), benchmark: small })
    expect(r.state).toBe('INSUFFICIENT_DATA')
    expect(r.percentile).toBeNull()
  })

  it('returns null one below the minimum', () => {
    const small = cohort(AMOUNTS.slice(0, MIN_BENCHMARK_COHORT_SIZE - 1))
    expect(assessCompetitiveRange({ proposedPrice: D('115000.00'), benchmark: small }).percentile).toBeNull()
  })

  it('produces a percentile at exactly the minimum', () => {
    const exact = cohort(AMOUNTS.slice(0, MIN_BENCHMARK_COHORT_SIZE))
    const r = assessCompetitiveRange({ proposedPrice: D('115000.00'), benchmark: exact })
    expect(r.percentile).not.toBeNull()
    expect(r.state).not.toBe('INSUFFICIENT_DATA')
  })

  it('computes the raw rank correctly', () => {
    const values = ['10.00', '20.00', '30.00', '40.00'].map((v) => D(v))
    expect(pricePercentile(D('25.00'), values)).toBe(50)
    expect(pricePercentile(D('40.00'), values)).toBe(100)
    expect(pricePercentile(D('5.00'), values)).toBe(0)
  })

  it('returns null for an empty sample', () => {
    expect(pricePercentile(D('10.00'), [])).toBeNull()
  })
})

describe('insufficient data is reported as such, never as a verdict', () => {
  it('states the cohort size and the minimum', () => {
    const small = cohort(['100000.00', '110000.00', '120000.00'])
    const r = assessCompetitiveRange({ proposedPrice: D('115000.00'), benchmark: small })
    expect(r.summary).toContain('Only 3 comparable public award(s)')
    expect(r.summary).toContain(`minimum ${MIN_BENCHMARK_COHORT_SIZE}`)
    expect(r.summary).toContain('no percentile or competitive-range conclusion was calculated')
  })

  it('never asserts a price is overpriced or underpriced on thin data', () => {
    const small = cohort(['100000.00'])
    const r = assessCompetitiveRange({ proposedPrice: D('999999.00'), benchmark: small })
    expect(r.summary.toLowerCase()).not.toMatch(/overpriced|underpriced|too high|too low/)
  })

  it('reports INSUFFICIENT_DATA when there is no proposed price', () => {
    const r = assess(null)
    expect(r.state).toBe('INSUFFICIENT_DATA')
    expect(r.percentile).toBeNull()
    expect(r.limitations.join(' ')).toContain('no positive proposed price')
  })

  it('reports INSUFFICIENT_DATA for a zero price', () => {
    expect(assess('0.00').state).toBe('INSUFFICIENT_DATA')
  })
})

describe('the wording never becomes a judgement', () => {
  it('says below the range is not the same as a good price', () => {
    expect(assess('110000.00').summary).toContain('Below the historical range is not the same as a good price')
  })

  it('says above the range is not the same as a bad price', () => {
    expect(assess('170000.00').summary).toContain('Above the historical range is not the same as a bad price')
  })

  it('says an extreme outlier does not by itself mean the price is wrong', () => {
    expect(assess('280000.01').summary).toContain('does not by itself mean the price is wrong')
  })

  it('never uses a verdict word in any state', () => {
    for (const price of ['110000.00', '140000.00', '170000.00', '280000.01']) {
      const summary = assess(price).summary.toLowerCase()
      expect(summary, price).not.toMatch(/overpriced|underpriced|uncompetitive|should charge|must price/)
    }
  })
})

describe('evidence', () => {
  it('carries the quartiles, the cohort size and the source list', () => {
    const r = assess('170000.00')
    expect(r.cohortSize).toBe(9)
    expect(r.p25!.toFixed(2)).toBe('120000.00')
    expect(r.median!.toFixed(2)).toBe('140000.00')
    expect(r.p75!.toFixed(2)).toBe('160000.00')
    expect(r.sourceIds).toHaveLength(9)
  })

  it('quotes the quartiles in the summary so a reader can check them', () => {
    expect(assess('170000.00').summary).toContain('p25 $120000.00, median $140000.00, p75 $160000.00')
  })

  it('carries the cohort limitations through', () => {
    const relaxed = { ...cohort(), limitations: ['The set-aside filter was relaxed.'] }
    expect(assessCompetitiveRange({ proposedPrice: D('140000.00'), benchmark: relaxed }).limitations)
      .toContain('The set-aside filter was relaxed.')
  })

  it('stamps the policy version', () => {
    expect(assess('140000.00').policyVersion).toBe(COMPETITIVE_RANGE_POLICY_VERSION)
  })
})

describe('review triggering', () => {
  it.each(['BELOW_HISTORICAL_RANGE', 'ABOVE_HISTORICAL_RANGE', 'EXTREME_OUTLIER'])(
    'flags %s for human attention',
    (state) => {
      expect(warrantsReview({ state } as never)).toBe(true)
    },
  )

  it.each(['WITHIN_HISTORICAL_RANGE', 'INSUFFICIENT_DATA'])('does not flag %s', (state) => {
    expect(warrantsReview({ state } as never)).toBe(false)
  })

  it('never treats insufficient data as though the price were out of range', () => {
    const small = cohort(['100000.00', '110000.00'])
    const r = assessCompetitiveRange({ proposedPrice: D('999999.00'), benchmark: small })
    expect(warrantsReview(r)).toBe(false)
  })
})

describe('Decimal discipline', () => {
  it('positions cent-level differences correctly', () => {
    const cents = cohort(['100.01', '100.02', '100.03', '100.04', '100.05', '100.06', '100.07'])
    const d = cents.distribution
    expect(d.p25!.toFixed(2)).toBe('100.03')
    expect(d.p75!.toFixed(2)).toBe('100.06')
    expect(assessCompetitiveRange({ proposedPrice: D('100.02'), benchmark: cents }).state).toBe('BELOW_HISTORICAL_RANGE')
    expect(assessCompetitiveRange({ proposedPrice: D('100.04'), benchmark: cents }).state).toBe('WITHIN_HISTORICAL_RANGE')
  })

  it('handles very large contract values', () => {
    const large = cohort([
      '10000000000.00', '11000000000.00', '12000000000.00', '13000000000.00',
      '14000000000.00', '15000000000.00', '16000000000.00',
    ])
    expect(assessCompetitiveRange({ proposedPrice: D('13000000000.00'), benchmark: large }).state)
      .toBe('WITHIN_HISTORICAL_RANGE')
  })
})
