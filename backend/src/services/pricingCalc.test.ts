// =============================================================
// Pricing calc engine — decimal-safe, deterministic build-up, escalation,
// circular-base rejection.
// =============================================================
import { describe, it, expect } from 'vitest'
import { computePricing, laborLineAmount, escalateRate, otherCostLineTotal, validateRateBase } from './pricingCalc'

describe('laborLineAmount + escalation', () => {
  it('computes hours × rate with escalation, decimal-safe', () => {
    expect(laborLineAmount({ hours: 100, baseRate: 50 }).toString()).toBe('5000')
    expect(laborLineAmount({ hours: 100, baseRate: 50, escalationPct: 10 }).toString()).toBe('5500')
    // fractional, HALF_UP to cents
    expect(laborLineAmount({ hours: 3, baseRate: 33.333, escalationPct: 0 }).toString()).toBe('100')
  })
  it('escalateRate = previous × (1 + pct/100)', () => {
    expect(escalateRate(100, 3).toString()).toBe('103')
    expect(escalateRate('50.00', '2.5').toString()).toBe('51.25')
  })
  it('otherCostLineTotal = quantity × unitCost', () => {
    expect(otherCostLineTotal(4, 250).toString()).toBe('1000')
  })
})

describe('validateRateBase — circular prevention', () => {
  it('accepts supported pairings and rejects circular ones', () => {
    expect(validateRateBase('FRINGE', 'DIRECT_LABOUR')).toBe(true)
    expect(validateRateBase('FRINGE', 'TOTAL_DIRECT_COST')).toBe(false) // circular
    expect(validateRateBase('FRINGE', 'LABOUR_PLUS_FRINGE')).toBe(false) // circular
    expect(validateRateBase('OVERHEAD', 'LABOUR_PLUS_FRINGE')).toBe(true)
    expect(validateRateBase('OVERHEAD', 'TOTAL_DIRECT_COST')).toBe(false) // circular
    expect(validateRateBase('GA', 'TOTAL_DIRECT_COST')).toBe(true)
    expect(validateRateBase('GA', 'NONSENSE_BASE')).toBe(false)
  })
})

describe('computePricing — full deterministic build-up', () => {
  it('matches a hand-calculated wrap', () => {
    const t = computePricing(
      [{ hours: 1000, baseRate: 100 }], // DL = 100000
      [
        { rateType: 'FRINGE', percent: 30, costBase: 'DIRECT_LABOUR' }, // 30000
        { rateType: 'OVERHEAD', percent: 50, costBase: 'LABOUR_PLUS_FRINGE' }, // 50% of 130000 = 65000
        { rateType: 'GA', percent: 10, costBase: 'TOTAL_DIRECT_COST' }, // 10% of 220000 = 22000
        { rateType: 'FEE', percent: 8, costBase: 'TOTAL_DIRECT_COST' }, // 8% of subtotal 242000 = 19360
      ],
      [
        { costCategory: 'TRAVEL', quantity: 1, unitCost: 5000 }, // ODC 5000
        { costCategory: 'SUBCONTRACTOR', quantity: 1, unitCost: 20000 }, // subK 20000
      ],
    )
    expect(t.totalDirectLabor.toString()).toBe('100000')
    expect(t.totalFringe.toString()).toBe('30000')
    expect(t.totalOverhead.toString()).toBe('65000')
    expect(t.totalOdc.toString()).toBe('5000')
    expect(t.totalSubcontractor.toString()).toBe('20000')
    expect(t.totalGA.toString()).toBe('22000')
    expect(t.subtotalBeforeFee.toString()).toBe('242000')
    expect(t.totalFee.toString()).toBe('19360')
    expect(t.totalPrice.toString()).toBe('261360')
    expect(t.unsupportedRates).toBe(0)
  })

  it('excludes inactive lines and drops circular rates (counts them)', () => {
    const t = computePricing(
      [
        { hours: 100, baseRate: 100 }, // 10000
        { hours: 100, baseRate: 999, isActive: false }, // excluded
      ],
      [
        { rateType: 'FRINGE', percent: 25, costBase: 'DIRECT_LABOUR' }, // 2500
        { rateType: 'OVERHEAD', percent: 50, costBase: 'TOTAL_DIRECT_COST' }, // circular → dropped
      ],
      [],
    )
    expect(t.totalDirectLabor.toString()).toBe('10000')
    expect(t.totalFringe.toString()).toBe('2500')
    expect(t.totalOverhead.toString()).toBe('0') // circular overhead dropped
    expect(t.unsupportedRates).toBe(1)
  })

  it('keeps cents precise across fractional rates', () => {
    const t = computePricing(
      [{ hours: 37.5, baseRate: 82.17 }], // 3081.375 → 3081.38
      [{ rateType: 'FRINGE', percent: 31.75, costBase: 'DIRECT_LABOUR' }], // 3081.38 × 0.3175 = 978.34
      [],
    )
    expect(t.totalDirectLabor.toString()).toBe('3081.38')
    expect(t.totalFringe.toString()).toBe('978.34')
  })

  it('returns all-zero for an empty scenario', () => {
    const t = computePricing([], [], [])
    expect(t.totalPrice.toString()).toBe('0')
    expect(t.subtotalBeforeFee.toString()).toBe('0')
  })
})
