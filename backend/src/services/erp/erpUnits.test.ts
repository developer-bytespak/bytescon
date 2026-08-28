// =============================================================
// §8.2 — Pure ERP units: thresholds, backlog, allocation overlap.
// =============================================================
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { budgetThresholdFor, type BudgetVsActualResult } from './budgetVsActual'
import { computeBacklog } from './financialSummary'
import { allocationOverlaps } from './capacityPlanning'

const D = (v: string | number) => new Prisma.Decimal(v)

const result = (budget: string | null, actual: string, committed: string): BudgetVsActualResult =>
  ({
    contractId: 'c1', budgetId: budget ? 'b1' : null, budgetVersion: budget ? 1 : null,
    budgetStatus: budget ? 'ACTIVE' : null, hasBudget: budget !== null, dataNote: '',
    totals: {
      budget, actual, committed,
      remaining: null, variance: null, variancePercent: null, overBudget: false,
    },
    byCategory: [], byClin: [],
    actualBreakdown: { labor: '0.00', nonLabor: '0.00', subcontract: '0.00' },
  }) as BudgetVsActualResult

describe('budget thresholds', () => {
  it('returns null without a budget — there is nothing to breach', () => {
    expect(budgetThresholdFor(result(null, '50000.00', '0.00'))).toBeNull()
  })

  it('returns null for a zero budget rather than dividing by zero', () => {
    expect(budgetThresholdFor(result('0.00', '10.00', '0.00'))).toBeNull()
  })

  it('counts committed money toward consumption, not just actual', () => {
    // 70% spent + 25% committed = 95% consumed, which is CRITICAL, not WARNING.
    const t = budgetThresholdFor(result('100000.00', '70000.00', '25000.00'))
    expect(t?.key).toBe('CRITICAL')
    expect(t?.consumedPct).toBe(95)
  })

  it('bands 80, 90 and 100 exactly at the boundary', () => {
    expect(budgetThresholdFor(result('100.00', '79.99', '0.00'))).toBeNull()
    expect(budgetThresholdFor(result('100.00', '80.00', '0.00'))?.key).toBe('WARNING')
    expect(budgetThresholdFor(result('100.00', '90.00', '0.00'))?.key).toBe('CRITICAL')
    expect(budgetThresholdFor(result('100.00', '100.00', '0.00'))?.key).toBe('EXCEEDED')
  })

  it('keeps cent precision when banding', () => {
    const t = budgetThresholdFor(result('10.33', '10.33', '0.00'))
    expect(t?.key).toBe('EXCEEDED')
    expect(t?.consumedPct).toBe(100)
  })
})

describe('backlog', () => {
  it('is null when contract value is unknown — never zero', () => {
    expect(computeBacklog(null, D('1000'))).toBeNull()
  })

  it('is contract value less actual incurred', () => {
    expect(computeBacklog(D('99999999.99'), D('0.01'))!.toFixed(2)).toBe('99999999.98')
  })

  it('floors at zero rather than reporting negative future work', () => {
    expect(computeBacklog(D('100.00'), D('250.00'))!.toFixed(2)).toBe('0.00')
  })

  it('holds cents exactly across awkward values', () => {
    expect(computeBacklog(D('10.33'), D('0.10'))!.toFixed(2)).toBe('10.23')
    expect(computeBacklog(D('0.10'), D('0.01'))!.toFixed(2)).toBe('0.09')
  })

  it('is exactly zero when everything is spent, not a rounding artefact', () => {
    expect(computeBacklog(D('99999999.99'), D('99999999.99'))!.toFixed(2)).toBe('0.00')
  })
})

describe('allocation overlap', () => {
  const d = (s: string) => new Date(s)

  it('detects a genuine overlap', () => {
    expect(allocationOverlaps(d('2027-01-01'), d('2027-06-30'), d('2027-03-01'), d('2027-09-30'))).toBe(true)
  })

  it('does not treat adjacent periods as overlapping', () => {
    expect(allocationOverlaps(d('2027-01-01'), d('2027-06-30'), d('2027-06-30'), d('2027-12-31'))).toBe(false)
  })

  it('treats an open-ended allocation as overlapping everything after it starts', () => {
    expect(allocationOverlaps(d('2027-01-01'), null, d('2030-01-01'), null)).toBe(true)
    expect(allocationOverlaps(d('2027-01-01'), null, d('2020-01-01'), d('2021-01-01'))).toBe(false)
  })

  it('is symmetric', () => {
    const a: [Date, Date | null] = [d('2027-01-01'), d('2027-06-30')]
    const b: [Date, Date | null] = [d('2027-05-01'), null]
    expect(allocationOverlaps(...a, ...b)).toBe(allocationOverlaps(...b, ...a))
  })
})
