// =============================================================
// §6.2E — Pricing sensitivity.
//
// Under test: monotonicity, the UNVALIDATED_SCENARIO_ANALYSIS label when the
// tenant lacks outcome data, honest handling of a missing benchmark, boundary
// behaviour, decimal safety, and determinism.
// =============================================================
import { describe, it, expect } from 'vitest'
import { SensitivityValidity } from '@prisma/client'
import {
  computeSensitivity,
  probabilityAtPosition,
  verifyMonotonic,
  MIN_SAMPLES_FOR_CALIBRATED,
  DEFAULT_PRICE_ELASTICITY,
  UNVALIDATED_LABEL,
  MIN_REPORTED_PROBABILITY,
  MAX_REPORTED_PROBABILITY,
  type ScenarioInput,
} from './pricingSensitivity'

const scenarios: ScenarioInput[] = [
  { id: 's1', name: 'Aggressive', totalPrice: '900000.00' },
  { id: 's2', name: 'Target', totalPrice: '1000000.00', isBase: true },
  { id: 's3', name: 'Conservative', totalPrice: '1150000.00' },
]

const base = {
  scenarios,
  benchmarkValue: '1000000.00',
  benchmarkSource: 'OPPORTUNITY_ESTIMATE',
  baseProbability: 0.4,
  tenantSampleSize: 0,
}

describe('probabilityAtPosition', () => {
  it('is strictly decreasing in price position', () => {
    const low = probabilityAtPosition(0.4, 0, -0.1)
    const mid = probabilityAtPosition(0.4, 0, 0)
    const high = probabilityAtPosition(0.4, 0, 0.1)
    expect(low).toBeGreaterThan(mid)
    expect(mid).toBeGreaterThan(high)
  })

  it('returns the base probability at the base position', () => {
    expect(probabilityAtPosition(0.4, 0.05, 0.05)).toBeCloseTo(0.4, 3)
  })

  it('never reports 0% or 100% — no price makes an award impossible or certain', () => {
    const veryHigh = probabilityAtPosition(0.4, 0, 50)
    const veryLow = probabilityAtPosition(0.4, 0, -50)
    expect(veryHigh).toBeGreaterThanOrEqual(MIN_REPORTED_PROBABILITY)
    expect(veryHigh).toBeLessThanOrEqual(MAX_REPORTED_PROBABILITY)
    expect(veryLow).toBeGreaterThanOrEqual(MIN_REPORTED_PROBABILITY)
    expect(veryLow).toBeLessThanOrEqual(MAX_REPORTED_PROBABILITY)
    expect(veryHigh).toBeGreaterThan(0)
    expect(veryLow).toBeLessThan(1)
  })

  it('honours a custom elasticity', () => {
    const gentle = probabilityAtPosition(0.4, 0, 0.2, 0.5)
    const steep = probabilityAtPosition(0.4, 0, 0.2, 5)
    expect(steep).toBeLessThan(gentle)
    expect(DEFAULT_PRICE_ELASTICITY).toBeGreaterThan(0)
  })
})

describe('computeSensitivity — monotonicity', () => {
  it('produces a monotonically non-increasing curve', () => {
    const result = computeSensitivity(base)
    expect(result.isMonotonic).toBe(true)
    expect(verifyMonotonic(result.points)).toBe(true)
    for (let i = 1; i < result.points.length; i++) {
      expect(result.points[i].probability).toBeLessThanOrEqual(result.points[i - 1].probability)
    }
  })

  it('orders points by price ascending', () => {
    const result = computeSensitivity(base)
    expect(result.points.map((p) => p.label)).toEqual(['Aggressive', 'Target', 'Conservative'])
  })
})

describe('computeSensitivity — honest validity labelling', () => {
  it('labels the analysis UNVALIDATED_SCENARIO_ANALYSIS without enough tenant data', () => {
    const result = computeSensitivity({ ...base, tenantSampleSize: 5 })
    expect(result.validity).toBe(SensitivityValidity.UNVALIDATED_SCENARIO_ANALYSIS)
    expect(result.validity).toBe(UNVALIDATED_LABEL)
    expect(result.assumptions.some((a) => a.includes('UNVALIDATED_SCENARIO_ANALYSIS'))).toBe(true)
  })

  it('only claims CALIBRATED once the tenant has enough outcomes', () => {
    const result = computeSensitivity({ ...base, tenantSampleSize: MIN_SAMPLES_FOR_CALIBRATED })
    expect(result.validity).toBe(SensitivityValidity.CALIBRATED)
  })

  it('never claims a price guarantees an award', () => {
    const result = computeSensitivity(base)
    expect(result.assumptions.some((a) => /No price guarantees an award/i.test(a))).toBe(true)
  })

  it('states that labour-rate sensitivity is not inferred', () => {
    const result = computeSensitivity(base)
    expect(result.assumptions.some((a) => /Labour-rate sensitivity is NOT inferred/i.test(a))).toBe(true)
  })

  it('records the benchmark and its source in the assumptions', () => {
    const result = computeSensitivity(base)
    expect(result.assumptions[0]).toContain('OPPORTUNITY_ESTIMATE')
    expect(result.assumptions[0]).toContain('1000000.00')
  })
})

describe('computeSensitivity — boundaries', () => {
  it('returns INSUFFICIENT_DATA with no scenarios', () => {
    const result = computeSensitivity({ ...base, scenarios: [] })
    expect(result.validity).toBe(SensitivityValidity.INSUFFICIENT_DATA)
    expect(result.points).toEqual([])
  })

  it('produces no price effect at all when there is no benchmark', () => {
    const result = computeSensitivity({ ...base, benchmarkValue: null, benchmarkSource: null })
    expect(result.validity).toBe(SensitivityValidity.INSUFFICIENT_DATA)
    // Every scenario sits at the same probability — no differences invented.
    expect(new Set(result.points.map((p) => p.probability)).size).toBe(1)
    expect(result.assumptions.some((a) => /No price effect is implied/i.test(a))).toBe(true)
  })

  it('treats a zero or negative benchmark as no benchmark', () => {
    for (const value of ['0.00', '-5.00']) {
      const result = computeSensitivity({ ...base, benchmarkValue: value })
      expect(result.validity).toBe(SensitivityValidity.INSUFFICIENT_DATA)
    }
  })

  it('keeps prices as decimal strings rather than lossy numbers', () => {
    const result = computeSensitivity(base)
    for (const point of result.points) {
      expect(typeof point.price).toBe('string')
    }
    expect(result.points.map((p) => p.price)).toContain('1150000.00')
  })

  it('computes price position and percent-of-benchmark correctly', () => {
    const result = computeSensitivity(base)
    const conservative = result.points.find((p) => p.label === 'Conservative')!
    expect(conservative.pricePosition).toBeCloseTo(0.15, 5)
    expect(conservative.percentOfBenchmark).toBeCloseTo(115, 2)
  })

  it('applies interval half-widths when supplied', () => {
    const result = computeSensitivity({ ...base, intervalLowerHalfWidth: 0.1, intervalUpperHalfWidth: 0.1 })
    for (const point of result.points) {
      expect(point.lower).not.toBeNull()
      expect(point.upper).not.toBeNull()
      expect(point.lower!).toBeLessThanOrEqual(point.probability)
      expect(point.upper!).toBeGreaterThanOrEqual(point.probability)
      expect(point.lower!).toBeGreaterThanOrEqual(0)
      expect(point.upper!).toBeLessThanOrEqual(1)
    }
  })

  it('leaves interval bounds null when no interval is available', () => {
    const result = computeSensitivity(base)
    expect(result.points.every((p) => p.lower === null && p.upper === null)).toBe(true)
  })
})

describe('computeSensitivity — determinism', () => {
  it('produces identical output for identical input', () => {
    expect(computeSensitivity(base)).toEqual(computeSensitivity(base))
  })
})

describe('verifyMonotonic', () => {
  it('detects a non-monotonic curve', () => {
    expect(verifyMonotonic([
      { label: 'a', price: '1', pricePosition: 0, percentOfBenchmark: 100, probability: 0.3, lower: null, upper: null, scenarioId: null, isBase: false },
      { label: 'b', price: '2', pricePosition: 1, percentOfBenchmark: 200, probability: 0.6, lower: null, upper: null, scenarioId: null, isBase: false },
    ])).toBe(false)
  })
})
