// =============================================================
// §6.4D — Escalating reminder levels.
//
// Under test: correct level per time-to-due, escalation only after the grace
// period, and dedupe keys that make repeat runs on the same day a no-op.
// =============================================================
import { describe, it, expect } from 'vitest'
import { ReminderLevel } from '@prisma/client'
import { decideLevel, buildReminderKey, SUPPRESSING_STATUSES, DEFAULT_ESCALATION_HOURS } from './reminderEngine'

const NOW = new Date('2026-06-01T12:00:00Z')
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3600_000)
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 86400_000)
const LEADS = [14, 7, 3, 1]

describe('decideLevel', () => {
  it('returns URGENT inside 24 hours', () => {
    expect(decideLevel(hoursFromNow(6), NOW, LEADS)?.level).toBe(ReminderLevel.URGENT)
    expect(decideLevel(hoursFromNow(23), NOW, LEADS)?.level).toBe(ReminderLevel.URGENT)
  })

  it('returns DUE_SOON inside three days', () => {
    expect(decideLevel(daysFromNow(2), NOW, LEADS)?.level).toBe(ReminderLevel.DUE_SOON)
  })

  it('returns UPCOMING on a lead day of a week or less', () => {
    expect(decideLevel(daysFromNow(6), NOW, LEADS)?.level).toBe(ReminderLevel.UPCOMING)
  })

  it('returns INFORMATIONAL on a longer lead day', () => {
    expect(decideLevel(daysFromNow(12), NOW, LEADS)?.level).toBe(ReminderLevel.INFORMATIONAL)
  })

  it('returns nothing outside every configured lead day', () => {
    expect(decideLevel(daysFromNow(40), NOW, LEADS)).toBeNull()
  })

  it('returns OVERDUE immediately after the due time', () => {
    const decision = decideLevel(hoursFromNow(-2), NOW, LEADS)
    expect(decision?.level).toBe(ReminderLevel.OVERDUE)
    expect(decision?.reason).toMatch(/Overdue by 2 hours/)
  })

  it('escalates only after the grace period', () => {
    expect(decideLevel(hoursFromNow(-(DEFAULT_ESCALATION_HOURS - 1)), NOW, LEADS)?.level).toBe(ReminderLevel.OVERDUE)
    expect(decideLevel(hoursFromNow(-(DEFAULT_ESCALATION_HOURS + 1)), NOW, LEADS)?.level).toBe(ReminderLevel.ESCALATED)
  })

  it('honours a per-milestone escalation window', () => {
    expect(decideLevel(hoursFromNow(-5), NOW, LEADS, 4)?.level).toBe(ReminderLevel.ESCALATED)
    expect(decideLevel(hoursFromNow(-5), NOW, LEADS, 72)?.level).toBe(ReminderLevel.OVERDUE)
  })

  it('respects a custom lead-day policy', () => {
    expect(decideLevel(daysFromNow(25), NOW, [30])?.level).toBe(ReminderLevel.INFORMATIONAL)
    expect(decideLevel(daysFromNow(25), NOW, [14])).toBeNull()
  })

  it('is deterministic', () => {
    expect(decideLevel(daysFromNow(2), NOW, LEADS)).toEqual(decideLevel(daysFromNow(2), NOW, LEADS))
  })
})

describe('buildReminderKey', () => {
  it('produces one key per milestone/user/level/channel/day', () => {
    const key = buildReminderKey('m1', 'u1', ReminderLevel.URGENT, 'IN_APP', NOW)
    expect(key).toBe('milestone-reminder:m1:u1:URGENT:IN_APP:2026-06-01')
  })

  it('is stable within a day, so a repeat run cannot re-send', () => {
    const morning = buildReminderKey('m1', 'u1', ReminderLevel.URGENT, 'IN_APP', new Date('2026-06-01T01:00:00Z'))
    const evening = buildReminderKey('m1', 'u1', ReminderLevel.URGENT, 'IN_APP', new Date('2026-06-01T23:00:00Z'))
    expect(morning).toBe(evening)
  })

  it('differs across days, levels, users and channels', () => {
    const base = buildReminderKey('m1', 'u1', ReminderLevel.URGENT, 'IN_APP', NOW)
    expect(base).not.toBe(buildReminderKey('m1', 'u1', ReminderLevel.URGENT, 'IN_APP', new Date('2026-06-02T12:00:00Z')))
    expect(base).not.toBe(buildReminderKey('m1', 'u1', ReminderLevel.OVERDUE, 'IN_APP', NOW))
    expect(base).not.toBe(buildReminderKey('m1', 'u2', ReminderLevel.URGENT, 'IN_APP', NOW))
    expect(base).not.toBe(buildReminderKey('m1', 'u1', ReminderLevel.URGENT, 'EMAIL', NOW))
  })
})

describe('suppressing statuses', () => {
  it('suppresses reminders for completed, cancelled and waived milestones', () => {
    expect(SUPPRESSING_STATUSES).toContain('COMPLETE')
    expect(SUPPRESSING_STATUSES).toContain('CANCELLED')
    expect(SUPPRESSING_STATUSES).toContain('WAIVED')
    // An at-risk or missed milestone must still remind.
    expect(SUPPRESSING_STATUSES).not.toContain('AT_RISK')
    expect(SUPPRESSING_STATUSES).not.toContain('MISSED')
  })
})
