// =============================================================
// §6.2H — Confidence / prediction intervals.
//
// Under test: no artificially narrow intervals, an explicit
// "INSUFFICIENT DATA — INTERVAL NOT AVAILABLE" path, correct Wilson maths, and
// confidence downgrades for incomplete or unlike-training data.
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  wilsonInterval,
  buildBins,
  findBin,
  computeConfidenceInterval,
  featureCompleteness,
  INTERVAL_UNAVAILABLE_LABEL,
  MIN_BIN_SAMPLES,
  CONFIDENCE_METHOD,
  type CalibrationBin,
} from './confidenceInterval'

function samples(count: number, winRate: number, predicted: number) {
  return Array.from({ length: count }, (_, i) => ({
    predicted,
    observed: i < Math.round(count * winRate) ? 1 : 0,
  }))
}

describe('wilsonInterval', () => {
  it('never collapses to zero width at p = 0', () => {
    const interval = wilsonInterval(0, 20)!
    expect(interval.low).toBe(0)
    expect(interval.high).toBeGreaterThan(0)
  })

  it('never collapses to zero width at p = 1', () => {
    const interval = wilsonInterval(20, 20)!
    expect(interval.high).toBe(1)
    expect(interval.low).toBeLessThan(1)
  })

  it('is narrower with more data at the same rate', () => {
    const small = wilsonInterval(5, 10)!
    const large = wilsonInterval(500, 1000)!
    expect(large.high - large.low).toBeLessThan(small.high - small.low)
  })

  it('stays inside [0,1]', () => {
    for (const [k, n] of [[0, 3], [3, 3], [1, 2], [7, 9]]) {
      const interval = wilsonInterval(k, n)!
      expect(interval.low).toBeGreaterThanOrEqual(0)
      expect(interval.high).toBeLessThanOrEqual(1)
    }
  })

  it('returns null for a non-positive sample size', () => {
    expect(wilsonInterval(0, 0)).toBeNull()
    expect(wilsonInterval(1, -5)).toBeNull()
  })
})

describe('buildBins / findBin', () => {
  it('places predictions in the right decile and counts wins', () => {
    const bins = buildBins([
      { predicted: 0.05, observed: 0 },
      { predicted: 0.15, observed: 1 },
      { predicted: 0.15, observed: 0 },
      { predicted: 1, observed: 1 },
    ])
    expect(bins[0].count).toBe(1)
    expect(bins[1].count).toBe(2)
    expect(bins[1].wins).toBe(1)
    // p = 1 lands in the final bin, not out of range.
    expect(bins[9].count).toBe(1)
  })

  it('finds the bin containing a probability, including the p = 1 edge', () => {
    const bins = buildBins([])
    expect(findBin(bins, 0.34)?.lower).toBeCloseTo(0.3, 5)
    expect(findBin(bins, 1)?.upper).toBe(1)
  })
})

describe('computeConfidenceInterval — insufficient data', () => {
  const thinBins: CalibrationBin[] = buildBins(samples(3, 0.5, 0.55))

  it('returns no interval and the exact required label', () => {
    const result = computeConfidenceInterval({
      pointEstimate: 0.55, bins: thinBins, tenantSampleSize: 3,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 1,
    })
    expect(result.available).toBe(false)
    expect(result.lower).toBeNull()
    expect(result.upper).toBeNull()
    expect(result.confidence).toBe('INSUFFICIENT_DATA')
    expect(result.unavailableLabel).toBe(INTERVAL_UNAVAILABLE_LABEL)
    expect(result.unavailableLabel).toBe('INSUFFICIENT DATA — INTERVAL NOT AVAILABLE')
    expect(result.reason).toContain(`minimum ${MIN_BIN_SAMPLES}`)
  })

  it('reports no interval when the matching bin is empty', () => {
    const result = computeConfidenceInterval({
      pointEstimate: 0.95, bins: thinBins, tenantSampleSize: 3,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 1,
    })
    expect(result.available).toBe(false)
    expect(result.binSampleSize).toBe(0)
  })
})

describe('computeConfidenceInterval — with data', () => {
  const bins = buildBins(samples(200, 0.5, 0.55))

  it('produces a bounded interval bracketing the point estimate', () => {
    const result = computeConfidenceInterval({
      pointEstimate: 0.55, bins, tenantSampleSize: 200,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 1,
    })
    expect(result.available).toBe(true)
    expect(result.lower!).toBeLessThanOrEqual(result.point)
    expect(result.upper!).toBeGreaterThanOrEqual(result.point)
    expect(result.lower!).toBeGreaterThanOrEqual(0)
    expect(result.upper!).toBeLessThanOrEqual(1)
    expect(result.method).toBe(CONFIDENCE_METHOD)
  })

  it('reports HIGH confidence only with a large tenant sample', () => {
    const high = computeConfidenceInterval({
      pointEstimate: 0.55, bins, tenantSampleSize: 200,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 1,
    })
    expect(high.confidence).toBe('HIGH')

    const medium = computeConfidenceInterval({
      pointEstimate: 0.55, bins, tenantSampleSize: 40,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 1,
    })
    expect(medium.confidence).toBe('MEDIUM')

    const low = computeConfidenceInterval({
      pointEstimate: 0.55, bins, tenantSampleSize: 12,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 1,
    })
    expect(low.confidence).toBe('LOW')
  })

  it('downgrades confidence when model inputs are incomplete', () => {
    const result = computeConfidenceInterval({
      pointEstimate: 0.55, bins, tenantSampleSize: 200,
      modelVersion: 'test', dataCompleteness: 0.4, trainingSimilarity: 1,
    })
    expect(result.confidence).toBe('LOW')
    expect(result.reason).toMatch(/inputs are only 40% complete/)
  })

  it('downgrades confidence when the record is unlike the training data', () => {
    const result = computeConfidenceInterval({
      pointEstimate: 0.55, bins, tenantSampleSize: 200,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 0.1,
    })
    expect(result.confidence).toBe('LOW')
    expect(result.reason).toMatch(/very unlike the historical record/)
  })

  it('clamps the band rather than exceeding [0,1] near the edges', () => {
    const edgeBins = buildBins(samples(200, 0.98, 0.97))
    const result = computeConfidenceInterval({
      pointEstimate: 0.99, bins: edgeBins, tenantSampleSize: 200,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 1,
    })
    expect(result.upper!).toBeLessThanOrEqual(1)
    expect(result.lower!).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic', () => {
    const input = {
      pointEstimate: 0.55, bins, tenantSampleSize: 200,
      modelVersion: 'test', dataCompleteness: 1, trainingSimilarity: 1,
    }
    expect(computeConfidenceInterval(input)).toEqual(computeConfidenceInterval(input))
  })
})

describe('featureCompleteness', () => {
  it('reports the fraction of expected inputs actually present', () => {
    expect(featureCompleteness({ a: 1, b: null, c: '', d: 'x' }, ['a', 'b', 'c', 'd'])).toBe(0.5)
    expect(featureCompleteness({}, [])).toBe(0)
    expect(featureCompleteness({ a: 0 }, ['a'])).toBe(1)
  })
})
