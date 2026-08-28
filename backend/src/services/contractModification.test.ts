// =============================================================
// Section 5 Module 8D — contract modification math must be decimal-safe and the
// apply-guard must prevent double application.
// =============================================================
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { computeContractAfterMod, canApplyModification } from './contractModification'

const D = (v: number | string) => new Prisma.Decimal(v)

describe('computeContractAfterMod', () => {
  it('sets values from null base when a funding/ceiling change is applied', () => {
    const after = computeContractAfterMod(
      { fundedValue: null, ceilingValue: null, startDate: null, endDate: null },
      { fundingChange: 100000, ceilingChange: 250000 },
    )
    expect(after.fundedValue?.toString()).toBe('100000')
    expect(after.ceilingValue?.toString()).toBe('250000')
  })

  it('adds to existing values with decimal precision (no float drift)', () => {
    const after = computeContractAfterMod(
      { fundedValue: D('0.1'), ceilingValue: D('1000000.05'), startDate: null, endDate: null },
      { fundingChange: D('0.2'), ceilingChange: D('0.10') },
    )
    expect(after.fundedValue?.toString()).toBe('0.3') // 0.1 + 0.2 exactly, not 0.30000000000000004
    expect(after.ceilingValue?.toString()).toBe('1000000.15')
  })

  it('leaves a field unchanged when its delta is null/undefined', () => {
    const after = computeContractAfterMod(
      { fundedValue: D('500'), ceilingValue: D('900'), startDate: null, endDate: null },
      { fundingChange: 100 },
    )
    expect(after.fundedValue?.toString()).toBe('600')
    expect(after.ceilingValue?.toString()).toBe('900') // unchanged
  })

  it('applies date changes when present, else keeps prior dates', () => {
    const s = new Date('2027-01-01T00:00:00Z')
    const e = new Date('2027-12-31T00:00:00Z')
    const after = computeContractAfterMod(
      { fundedValue: null, ceilingValue: null, startDate: new Date('2026-01-01Z'), endDate: new Date('2026-12-31Z') },
      { endDateChange: e },
    )
    expect(after.startDate?.toISOString()).toBe(new Date('2026-01-01Z').toISOString()) // unchanged
    expect(after.endDate?.toISOString()).toBe(e.toISOString())
    expect(s).toBeInstanceOf(Date)
  })
})

describe('canApplyModification', () => {
  it('allows apply from DRAFT or RECORDED when not yet applied', () => {
    expect(canApplyModification('DRAFT', null).ok).toBe(true)
    expect(canApplyModification('RECORDED', null).ok).toBe(true)
  })
  it('blocks re-apply once appliedAt is set or status is APPLIED', () => {
    expect(canApplyModification('RECORDED', new Date()).ok).toBe(false)
    expect(canApplyModification('APPLIED', null).ok).toBe(false)
  })
  it('blocks applying a VOIDED modification', () => {
    expect(canApplyModification('VOIDED', null).ok).toBe(false)
  })
})
