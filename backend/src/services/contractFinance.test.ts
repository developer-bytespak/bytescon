// =============================================================
// Section 5 Module 9 — finance calculations must be decimal-safe and honest
// about insufficient data. Clock-injected, no floating-point drift.
// =============================================================
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import {
  sumFunding, recognizedExpenditure, lineAmount, rateForWorkDate, periodsOverlap, computeBurn, receivablesAging, rateVariance, D,
} from './contractFinance'

const NOW = new Date('2026-08-04T00:00:00.000Z')
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000)

describe('sumFunding', () => {
  it('sums non-voided signed amounts, ignores voided', () => {
    const r = sumFunding([
      { amount: 100000, isVoided: false },
      { amount: -20000, isVoided: false }, // reduction
      { amount: 50000, isVoided: true }, // voided → excluded
    ])
    expect(r.toFixed(2)).toBe('80000.00')
  })
})

describe('recognizedExpenditure', () => {
  it('adds approved labor billing + approved cost amounts, decimal-exact', () => {
    const r = recognizedExpenditure([{ billingAmount: '0.10' }, { billingAmount: '0.20' }], [{ amount: '1000000.05' }])
    expect(r.toFixed(2)).toBe('1000000.35') // 0.1 + 0.2 + 1000000.05 (no 0.30000000000000004)
  })
})

describe('lineAmount', () => {
  it('hours × rate rounded to cents; null rate → null', () => {
    expect(lineAmount('8.00', '150.5555')?.toFixed(2)).toBe('1204.44')
    expect(lineAmount(8, null)).toBeNull()
  })
})

describe('rateForWorkDate', () => {
  const rates = [
    { categoryName: 'SE', rateType: 'BILLING', billingRate: 100, costRate: 60, effectiveStart: days(-100), effectiveEnd: days(-10), isActive: true },
    { categoryName: 'SE', rateType: 'BILLING', billingRate: 120, costRate: 70, effectiveStart: days(-9), effectiveEnd: null, isActive: true },
  ]
  it('picks the rate whose window contains the work date', () => {
    expect(rateForWorkDate(rates, 'SE', days(-50))?.billingRate).toBe(100)
    expect(rateForWorkDate(rates, 'SE', days(-1))?.billingRate).toBe(120)
  })
  it('returns null when no category/date matches', () => {
    expect(rateForWorkDate(rates, 'PM', days(-1))).toBeNull()
    expect(rateForWorkDate(rates, 'SE', days(-200))).toBeNull()
  })
})

describe('periodsOverlap', () => {
  it('detects overlap incl. open-ended windows', () => {
    expect(periodsOverlap(days(0), days(10), days(5), days(15))).toBe(true)
    expect(periodsOverlap(days(0), days(10), days(11), days(20))).toBe(false)
    expect(periodsOverlap(days(0), null, days(100), days(200))).toBe(true) // open-ended a covers everything after 0
  })
})

describe('computeBurn — insufficient-data honesty', () => {
  const base = { funded: D(100000), ceiling: D(200000), now: NOW, endDate: days(365) }
  it('no expenditure → insufficientData, no depletion forecast', () => {
    const r = computeBurn({ ...base, expended: D(0), expenditureDates: [] })
    expect(r.insufficientData).toBe(true)
    expect(r.estimatedDepletionDate).toBeNull()
    expect(r.remainingFunded).toBe('100000.00')
  })
  it('history too short (< 7 days) → no burn projection', () => {
    const r = computeBurn({ ...base, expended: D(5000), expenditureDates: [days(-3)] })
    expect(r.insufficientData).toBe(true)
    expect(r.burnRatePerDay).toBeNull()
  })
  it('sufficient history → burn rate + depletion date computed', () => {
    // 30k expended over ~30 days → ~1000/day → remaining 70k → ~70 days to deplete
    const r = computeBurn({ ...base, expended: D(30000), expenditureDates: [days(-30), days(-1)] })
    expect(r.insufficientData).toBe(false)
    expect(Number(r.burnRatePerDay)).toBeGreaterThan(0)
    expect(r.estimatedDepletionDate).not.toBeNull()
    expect(r.expendedPct).toBeCloseTo(0.3, 2)
  })
  it('flags FUNDING_LOW at/above 90% expended', () => {
    const r = computeBurn({ ...base, expended: D(95000), expenditureDates: [days(-40), days(-1)] })
    expect(r.warning === 'FUNDING_LOW' || r.warning === 'DEPLETION_BEFORE_END' || r.warning === 'CEILING_LOW').toBe(true)
  })
})

describe('receivablesAging', () => {
  it('buckets outstanding balances by overdue age', () => {
    const r = receivablesAging([
      { dueDate: days(10), outstanding: D(1000) }, // current (future due)
      { dueDate: days(-15), outstanding: D(2000) }, // 1-30
      { dueDate: days(-45), outstanding: D(3000) }, // 31-60
      { dueDate: days(-120), outstanding: D(4000) }, // 90+
      { dueDate: days(-5), outstanding: D(0) }, // paid → excluded
    ], NOW)
    expect(r.current).toBe('1000.00')
    expect(r.d1_30).toBe('2000.00')
    expect(r.d31_60).toBe('3000.00')
    expect(r.d90plus).toBe('4000.00')
    expect(r.totalOutstanding).toBe('10000.00')
  })
})

describe('rateVariance', () => {
  it('computes explainable variance vs a baseline', () => {
    const v = rateVariance(120, 100)
    expect(v.difference).toBe('20.0000')
    expect(v.variancePct).toBe(20)
    expect(v.severity).toBe('HIGH')
  })
  it('no baseline → severity NONE, null variance', () => {
    const v = rateVariance(120, null)
    expect(v.expected).toBeNull()
    expect(v.severity).toBe('NONE')
  })
})
