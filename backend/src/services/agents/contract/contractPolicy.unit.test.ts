// =============================================================
// §7.1 — Contract Administration pure-logic units.
//
// No database. Covers the threshold bands at their exact boundaries, the health
// combination rule, the option decision-date precedence (explicit always wins,
// derived is always labelled), period-of-performance state, the shared reminder
// ladder and the modification projection.
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  CEILING_CRITICAL_PCT, CEILING_WARNING_PCT, CONTRACT_POLICY_DOC,
  FUNDING_CRITICAL_PCT, FUNDING_WARNING_PCT, fundingBand, thresholdSeverity,
  thresholdStateToHealth, worstHealth, type ContractHealthState,
} from './policy'
import { resolveDecisionDate } from './optionWatch'
import { assessPeriodOfPerformance } from './popWatch'
import { decideLevel, resolveReminderRecipients, buildReminderDedupeKey } from '../../reminders/reminderPolicy'
import { computeContractAfterMod } from '../../contractModification'
import { computeBurn, D } from '../../contractFinance'
import { Prisma } from '@prisma/client'

// -------------------------------------------------------------
// Thresholds — tested at just below / exactly / just above
// -------------------------------------------------------------

describe('funding thresholds', () => {
  it('matches the Section 5 canonical low line rather than inventing one', () => {
    // computeBurn's default fundingLowThresholdPct is 0.9; the agent reuses it.
    expect(FUNDING_WARNING_PCT).toBe(0.9)
    expect(CEILING_WARNING_PCT).toBe(FUNDING_WARNING_PCT)
    expect(FUNDING_CRITICAL_PCT).toBeGreaterThan(FUNDING_WARNING_PCT)
    expect(CEILING_CRITICAL_PCT).toBe(FUNDING_CRITICAL_PCT)
  })

  it.each([
    [0.8999, 'OK'],
    [0.9, 'FUNDING_WARNING'],
    [0.9001, 'FUNDING_WARNING'],
    [0.9799, 'FUNDING_WARNING'],
    [0.98, 'FUNDING_CRITICAL'],
    [0.9801, 'FUNDING_CRITICAL'],
    [1.5, 'FUNDING_CRITICAL'],
  ])('bands funding consumption %s as %s', (pct, expected) => {
    expect(fundingBand(pct as number, 'FUNDING')).toBe(expected)
  })

  it.each([
    [0.8999, 'OK'],
    [0.9, 'CEILING_WARNING'],
    [0.98, 'CEILING_CRITICAL'],
  ])('bands ceiling consumption %s as %s', (pct, expected) => {
    expect(fundingBand(pct as number, 'CEILING')).toBe(expected)
  })

  it('reports INSUFFICIENT_DATA rather than a band for a non-finite ratio', () => {
    expect(fundingBand(Number.NaN, 'FUNDING')).toBe('INSUFFICIENT_DATA')
  })

  it('maps bands to health and severity consistently', () => {
    expect(thresholdStateToHealth('OK')).toBe('HEALTHY')
    expect(thresholdStateToHealth('FUNDING_WARNING')).toBe('ATTENTION')
    expect(thresholdStateToHealth('FUNDING_CRITICAL')).toBe('CRITICAL')
    expect(thresholdStateToHealth('DEPLETION_BEFORE_END')).toBe('CRITICAL')
    expect(thresholdSeverity('FUNDING_CRITICAL')).toBe('CRITICAL')
    expect(thresholdSeverity('FUNDING_WARNING')).toBe('MEDIUM')
  })

  it('publishes its defaults so the UI never hard-codes a number', () => {
    expect(CONTRACT_POLICY_DOC.fundingWarningPct).toBe(FUNDING_WARNING_PCT)
    expect(CONTRACT_POLICY_DOC.notes.join(' ')).toMatch(/no AI inference/i)
  })
})

describe('worstHealth', () => {
  it('lets a real problem outrank missing data', () => {
    expect(worstHealth(['HEALTHY', 'INSUFFICIENT_DATA'])).toBe('INSUFFICIENT_DATA')
    expect(worstHealth(['INSUFFICIENT_DATA', 'ATTENTION'])).toBe('ATTENTION')
    expect(worstHealth(['ATTENTION', 'CRITICAL'])).toBe('CRITICAL')
    expect(worstHealth(['HEALTHY', 'HEALTHY'])).toBe('HEALTHY')
  })

  it('is INSUFFICIENT_DATA when there is nothing to judge', () => {
    expect(worstHealth([] as ContractHealthState[])).toBe('INSUFFICIENT_DATA')
  })
})

// -------------------------------------------------------------
// Option decision-date precedence
// -------------------------------------------------------------

describe('option decision date', () => {
  const start = new Date('2026-10-01T00:00:00Z')
  const decision = new Date('2026-08-01T00:00:00Z')
  const deadline = new Date('2026-07-15T00:00:00Z')

  it('prefers an explicit exercise deadline above everything', () => {
    const r = resolveDecisionDate({ exerciseDeadline: deadline, decisionDate: decision, startDate: start })
    expect(r.basis).toBe('EXERCISE_DEADLINE')
    expect(r.date).toEqual(deadline)
  })

  it('falls back to an explicit decision date', () => {
    const r = resolveDecisionDate({ exerciseDeadline: null, decisionDate: decision, startDate: start })
    expect(r.basis).toBe('DECISION_DATE')
    expect(r.date).toEqual(decision)
  })

  it('derives an INTERNAL_RECOMMENDATION only when no explicit date exists', () => {
    const r = resolveDecisionDate({ exerciseDeadline: null, decisionDate: null, startDate: start })
    expect(r.basis).toBe('INTERNAL_RECOMMENDATION')
    // 90 days before the option start.
    expect(r.date?.toISOString().slice(0, 10)).toBe('2026-07-03')
  })

  it('returns no date at all rather than fabricating a deadline', () => {
    const r = resolveDecisionDate({ exerciseDeadline: null, decisionDate: null, startDate: null })
    expect(r.basis).toBe('NONE')
    expect(r.date).toBeNull()
  })

  it('never lets a derived date override an explicit one', () => {
    const explicit = resolveDecisionDate({ exerciseDeadline: null, decisionDate: decision, startDate: start })
    expect(explicit.basis).not.toBe('INTERNAL_RECOMMENDATION')
  })
})

// -------------------------------------------------------------
// Period of performance
// -------------------------------------------------------------

describe('period of performance', () => {
  const now = new Date('2026-06-01T00:00:00Z')
  const base = { contractId: 'c1', startDate: new Date('2026-01-01T00:00:00Z'), now, hasOpenOptionWindow: false, openDeliverableCount: 0 }

  it('is ACTIVE well before the end', () => {
    const r = assessPeriodOfPerformance({ ...base, endDate: new Date('2027-01-01T00:00:00Z') })
    expect(r.state).toBe('ACTIVE')
    expect(r.health).toBe('HEALTHY')
  })

  it('is APPROACHING_END inside the window', () => {
    const r = assessPeriodOfPerformance({ ...base, endDate: new Date('2026-07-01T00:00:00Z') })
    expect(r.state).toBe('APPROACHING_END')
    expect(r.health).toBe('ATTENTION')
    expect(r.daysRemaining).toBe(30)
  })

  it('escalates to CRITICAL when deliverables are still open near the end', () => {
    const r = assessPeriodOfPerformance({ ...base, endDate: new Date('2026-07-01T00:00:00Z'), openDeliverableCount: 2 })
    expect(r.health).toBe('CRITICAL')
    expect(r.reasons.join(' ')).toMatch(/2 deliverable\(s\) are still open/)
  })

  it('is EXPIRED after the end date', () => {
    const r = assessPeriodOfPerformance({ ...base, endDate: new Date('2026-05-01T00:00:00Z') })
    expect(r.state).toBe('EXPIRED')
    expect(r.health).toBe('CRITICAL')
  })

  it('reports OPTION_WINDOW when an option decision is open near the end', () => {
    const r = assessPeriodOfPerformance({ ...base, endDate: new Date('2026-07-01T00:00:00Z'), hasOpenOptionWindow: true })
    expect(r.state).toBe('OPTION_WINDOW')
  })

  it('is NOT_STARTED before the start date', () => {
    const r = assessPeriodOfPerformance({
      ...base, startDate: new Date('2026-09-01T00:00:00Z'), endDate: new Date('2027-09-01T00:00:00Z'),
    })
    expect(r.state).toBe('NOT_STARTED')
  })

  it('reports INSUFFICIENT_DATA rather than guessing when there is no end date', () => {
    const r = assessPeriodOfPerformance({ ...base, endDate: null })
    expect(r.state).toBe('INSUFFICIENT_DATA')
    expect(r.health).toBe('INSUFFICIENT_DATA')
    expect(r.daysRemaining).toBeNull()
  })
})

// -------------------------------------------------------------
// Shared reminder ladder (proves the §6 generalisation is intact)
// -------------------------------------------------------------

describe('shared reminder ladder', () => {
  const now = new Date('2026-06-01T12:00:00Z')
  const leads = [14, 7, 3]

  it('produces the §6.4 levels for contract deliverables too', () => {
    expect(decideLevel(new Date('2026-06-01T20:00:00Z'), now, leads)?.level).toBe('URGENT')
    expect(decideLevel(new Date('2026-06-03T12:00:00Z'), now, leads)?.level).toBe('DUE_SOON')
    expect(decideLevel(new Date('2026-06-06T12:00:00Z'), now, leads)?.level).toBe('UPCOMING')
    expect(decideLevel(new Date('2026-06-13T12:00:00Z'), now, leads)?.level).toBe('INFORMATIONAL')
  })

  it('escalates only past the configured grace period', () => {
    expect(decideLevel(new Date('2026-06-01T02:00:00Z'), now, leads, 24)?.level).toBe('OVERDUE')
    expect(decideLevel(new Date('2026-05-30T12:00:00Z'), now, leads, 24)?.level).toBe('ESCALATED')
  })

  it('is silent well outside the lead window', () => {
    expect(decideLevel(new Date('2026-09-01T12:00:00Z'), now, leads)).toBeNull()
  })

  it('walks owner → reviewer → admin only at escalation', () => {
    const t = { ownerUserId: 'owner', reviewerUserId: 'reviewer' }
    expect(resolveReminderRecipients(t, 'DUE_SOON', ['admin']).map((r) => r.role)).toEqual(['OWNER'])
    expect(resolveReminderRecipients(t, 'ESCALATED', ['admin']).map((r) => r.role)).toEqual(['OWNER', 'REVIEWER', 'ADMIN'])
  })

  it('falls back to the reviewer when nobody owns the item', () => {
    const r = resolveReminderRecipients({ ownerUserId: null, reviewerUserId: 'reviewer' }, 'DUE_SOON', [])
    expect(r).toEqual([{ userId: 'reviewer', role: 'REVIEWER', isEscalation: false }])
  })

  it('returns nobody when there is nobody to tell', () => {
    expect(resolveReminderRecipients({ ownerUserId: null, reviewerUserId: null }, 'DUE_SOON', [])).toEqual([])
  })

  it('never lists the same user twice', () => {
    const r = resolveReminderRecipients({ ownerUserId: 'u1', reviewerUserId: 'u1' }, 'ESCALATED', ['u1'])
    expect(r).toHaveLength(1)
  })

  it('deduplicates per day, and namespaces domains apart', () => {
    const a = buildReminderDedupeKey({ prefix: 'contract-deliverable-reminder', entityId: 'd1', userId: 'u1', level: 'OVERDUE', channel: 'IN_APP', now })
    const sameDay = buildReminderDedupeKey({ prefix: 'contract-deliverable-reminder', entityId: 'd1', userId: 'u1', level: 'OVERDUE', channel: 'IN_APP', now: new Date('2026-06-01T23:59:00Z') })
    const nextDay = buildReminderDedupeKey({ prefix: 'contract-deliverable-reminder', entityId: 'd1', userId: 'u1', level: 'OVERDUE', channel: 'IN_APP', now: new Date('2026-06-02T00:01:00Z') })
    const milestone = buildReminderDedupeKey({ prefix: 'milestone-reminder', entityId: 'd1', userId: 'u1', level: 'OVERDUE', channel: 'IN_APP', now })
    expect(a).toBe(sameDay)
    expect(a).not.toBe(nextDay)
    expect(a).not.toBe(milestone)
  })

  it('keeps the §6.4 milestone key format byte-identical', () => {
    const key = buildReminderDedupeKey({ prefix: 'milestone-reminder', entityId: 'm1', userId: 'u1', level: 'URGENT', channel: 'IN_APP', now })
    expect(key).toBe('milestone-reminder:m1:u1:URGENT:IN_APP:2026-06-01')
  })
})

// -------------------------------------------------------------
// Decimal correctness on the Section 5 formulas the agent consumes
// -------------------------------------------------------------

describe('decimal financial correctness', () => {
  const now = new Date('2026-06-30T00:00:00Z')
  const dates = [new Date('2026-06-01T00:00:00Z')]

  it('keeps funded and ceiling remaining as DISTINCT figures', () => {
    const r = computeBurn({ funded: D(150000), ceiling: D(600000), expended: D(1700), expenditureDates: dates, now, endDate: null })
    expect(r.remainingFunded).toBe('148300.00')
    expect(r.remainingCeiling).toBe('598300.00')
    expect(r.remainingFunded).not.toBe(r.remainingCeiling)
  })

  it('is exact to the cent', () => {
    const r = computeBurn({ funded: D('100.10'), ceiling: null, expended: D('0.03'), expenditureDates: dates, now, endDate: null })
    expect(r.remainingFunded).toBe('100.07')
  })

  it('handles very large contract values without float drift', () => {
    const r = computeBurn({ funded: D('999999999.99'), ceiling: null, expended: D('0.01'), expenditureDates: dates, now, endDate: null })
    expect(r.remainingFunded).toBe('999999999.98')
  })

  it('suppresses any projection when nothing has been expended', () => {
    const r = computeBurn({ funded: D(150000), ceiling: D(600000), expended: D(0), expenditureDates: [], now, endDate: null })
    expect(r.estimatedDepletionDate).toBeNull()
    expect(r.insufficientData).toBe(true)
    expect(r.reason).toMatch(/No recognized expenditure/)
  })

  it('suppresses a projection when the history is under 7 days', () => {
    const r = computeBurn({
      funded: D(150000), ceiling: null, expended: D(5000),
      expenditureDates: [new Date('2026-06-28T00:00:00Z')], now, endDate: null,
    })
    expect(r.estimatedDepletionDate).toBeNull()
    expect(r.insufficientData).toBe(true)
    expect(r.reason).toMatch(/too short/)
  })

  it('projects once there is a real burn history', () => {
    const r = computeBurn({ funded: D(30000), ceiling: null, expended: D(3000), expenditureDates: dates, now, endDate: null })
    expect(r.burnRatePerDay).not.toBeNull()
    expect(r.estimatedDepletionDate).not.toBeNull()
    expect(r.insufficientData).toBe(false)
  })

  it('is deterministic across repeated calculation', () => {
    const args = { funded: D(150000), ceiling: D(600000), expended: D(1700), expenditureDates: dates, now, endDate: null }
    expect(computeBurn(args)).toEqual(computeBurn(args))
  })
})

// -------------------------------------------------------------
// Modification projection — never a write
// -------------------------------------------------------------

describe('modification projection', () => {
  it('projects the totals a modification WOULD produce', () => {
    const after = computeContractAfterMod(
      { fundedValue: new Prisma.Decimal(150000), ceilingValue: new Prisma.Decimal(600000), startDate: null, endDate: null },
      { fundingChange: new Prisma.Decimal(25000), ceilingChange: null, startDateChange: null, endDateChange: null },
    )
    expect(after.fundedValue?.toFixed(2)).toBe('175000.00')
    // Untouched fields stay exactly as they were.
    expect(after.ceilingValue?.toFixed(2)).toBe('600000.00')
  })

  it('handles a negative (deobligating) modification', () => {
    const after = computeContractAfterMod(
      { fundedValue: new Prisma.Decimal(150000), ceilingValue: null, startDate: null, endDate: null },
      { fundingChange: new Prisma.Decimal(-50000), ceilingChange: null, startDateChange: null, endDateChange: null },
    )
    expect(after.fundedValue?.toFixed(2)).toBe('100000.00')
  })
})
