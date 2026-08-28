// =============================================================
// §6.4C — Working-day maths and working-backward schedules.
//
// Under test: weekends and holidays are skipped, an impossible schedule is
// reported rather than compressed, overdue phases are flagged, complexity
// scaling is bounded, and generation is fully deterministic.
// =============================================================
import { describe, it, expect } from 'vitest'
import { MilestoneType } from '@prisma/client'
import {
  addWorkingDays,
  isWorkingDay,
  makeCalendar,
  nextWorkingDay,
  previousWorkingDay,
  usFederalHolidays,
  workingDaysBetween,
  dateKey,
} from './workingDays'
import {
  generateSchedule,
  complexityMultiplier,
  DEFAULT_PHASES,
  type ComplexityInputs,
  type PhaseTemplate,
} from './scheduleGenerator'

const utc = (s: string) => new Date(`${s}T00:00:00Z`)

describe('usFederalHolidays', () => {
  it('computes the 2027 observance rules rather than hard-coding dates', () => {
    const holidays = usFederalHolidays(2027)
    const byName = Object.fromEntries(holidays.map((h) => [h.name, dateKey(h.date)]))
    // 2027-01-01 is a Friday — observed on the day.
    expect(byName["New Year's Day"]).toBe('2027-01-01')
    // 2027-07-04 is a Sunday — observed Monday the 5th.
    expect(byName['Independence Day']).toBe('2027-07-05')
    // Thanksgiving 2027 = 4th Thursday of November = the 25th.
    expect(byName['Thanksgiving Day']).toBe('2027-11-25')
    // Memorial Day = last Monday in May 2027 = the 31st.
    expect(byName['Memorial Day']).toBe('2027-05-31')
    expect(holidays).toHaveLength(11)
  })

  it('moves a Saturday holiday to the preceding Friday', () => {
    // 2027-12-25 is a Saturday → observed Friday the 24th.
    const christmas = usFederalHolidays(2027).find((h) => h.name === 'Christmas Day')!
    expect(dateKey(christmas.date)).toBe('2027-12-24')
  })
})

describe('working-day helpers', () => {
  const calendar = makeCalendar(undefined, usFederalHolidays(2027).map((h) => h.date))

  it('treats weekends and holidays as non-working days', () => {
    expect(isWorkingDay(utc('2027-03-15'), calendar)).toBe(true)  // Monday
    expect(isWorkingDay(utc('2027-03-13'), calendar)).toBe(false) // Saturday
    expect(isWorkingDay(utc('2027-03-14'), calendar)).toBe(false) // Sunday
    expect(isWorkingDay(utc('2027-07-05'), calendar)).toBe(false) // observed holiday
  })

  it('moves backwards over weekends', () => {
    // Monday 2027-03-15 minus 1 working day = Friday 2027-03-12.
    expect(dateKey(addWorkingDays(utc('2027-03-15'), -1, calendar))).toBe('2027-03-12')
    // Minus 5 working days = Monday 2027-03-08.
    expect(dateKey(addWorkingDays(utc('2027-03-15'), -5, calendar))).toBe('2027-03-08')
  })

  it('skips a holiday when moving forward', () => {
    // Friday 2027-07-02 plus 1 working day skips the weekend AND the observed
    // Independence Day on Monday the 5th → Tuesday the 6th.
    expect(dateKey(addWorkingDays(utc('2027-07-02'), 1, calendar))).toBe('2027-07-06')
  })

  it('snaps to the nearest working day in each direction', () => {
    expect(dateKey(previousWorkingDay(utc('2027-03-14'), calendar))).toBe('2027-03-12')
    expect(dateKey(nextWorkingDay(utc('2027-03-13'), calendar))).toBe('2027-03-15')
  })

  it('counts working days between two dates, signed', () => {
    expect(workingDaysBetween(utc('2027-03-08'), utc('2027-03-15'), calendar)).toBe(5)
    expect(workingDaysBetween(utc('2027-03-15'), utc('2027-03-08'), calendar)).toBe(-5)
    expect(workingDaysBetween(utc('2027-03-15'), utc('2027-03-15'), calendar)).toBe(0)
  })
})

describe('complexityMultiplier', () => {
  const baseInputs: ComplexityInputs = {
    proposalSectionCount: 5,
    complianceRequirementCount: 10,
    pricingScenarioCount: 1,
    teamSize: 5,
    requiredReviewCycles: 2,
    partnerCount: 0,
    requiredDocumentCount: 3,
    concurrentPursuits: 0,
  }

  it('returns 1 for a simple pursuit', () => {
    expect(complexityMultiplier(baseInputs)).toBe(1)
  })

  it('increases with scale and is bounded at 2.5', () => {
    const complex = complexityMultiplier({
      proposalSectionCount: 80, complianceRequirementCount: 400, pricingScenarioCount: 6,
      teamSize: 1, requiredReviewCycles: 5, partnerCount: 5,
      requiredDocumentCount: 40, concurrentPursuits: 8,
    })
    expect(complex).toBeGreaterThan(1)
    expect(complex).toBeLessThanOrEqual(2.5)
  })

  it('is deterministic', () => {
    expect(complexityMultiplier(baseInputs)).toBe(complexityMultiplier(baseInputs))
  })
})

describe('generateSchedule', () => {
  const calendar = makeCalendar(undefined, usFederalHolidays(2027).map((h) => h.date))
  const deadline = utc('2027-06-30')

  it('places every phase on a working day, before the deadline', () => {
    const result = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04') })
    expect(result.phases).toHaveLength(DEFAULT_PHASES.length)
    for (const phase of result.phases) {
      expect(isWorkingDay(phase.start, calendar), `${phase.key} start`).toBe(true)
      expect(isWorkingDay(phase.end, calendar), `${phase.key} end`).toBe(true)
      expect(phase.end.getTime()).toBeLessThan(deadline.getTime())
      expect(phase.start.getTime()).toBeLessThanOrEqual(phase.end.getTime())
    }
  })

  it('orders phases so earlier work comes first', () => {
    const result = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04') })
    const keys = result.phases.map((p) => p.key)
    expect(keys.indexOf('bid_decision')).toBeLessThan(keys.indexOf('first_draft'))
    expect(keys.indexOf('first_draft')).toBeLessThan(keys.indexOf('red_team'))
    expect(keys.indexOf('red_team')).toBeLessThan(keys.indexOf('submission_buffer'))
  })

  it('is FEASIBLE with plenty of runway', () => {
    const result = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04') })
    expect(result.isFeasible).toBe(true)
    expect(result.infeasibilityReason).toBeNull()
    expect(result.overdueCount).toBe(0)
  })

  it('reports an impossible schedule instead of silently compressing it', () => {
    // Only a handful of working days remain before the deadline.
    const result = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-06-25') })
    expect(result.isFeasible).toBe(false)
    expect(result.infeasibilityReason).toMatch(/shortfall of \d+ working day/)
    expect(result.overdueCount).toBeGreaterThan(0)
  })

  it('flags phases whose dates have already passed as overdue', () => {
    const result = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-06-01') })
    expect(result.phases.some((p) => p.isOverdue)).toBe(true)
    expect(result.overdueCount).toBe(result.phases.filter((p) => p.isOverdue).length)
  })

  it('stretches the schedule when the complexity multiplier rises', () => {
    const simple = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04'), multiplier: 1 })
    const complex = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04'), multiplier: 2 })
    expect(complex.phases[0].start.getTime()).toBeLessThan(simple.phases[0].start.getTime())
    expect(complex.workingDaysRequired).toBeGreaterThan(simple.workingDaysRequired)
  })

  it('honours the minimum buffer before the deadline', () => {
    const noBuffer = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04'), minBufferDays: 0 })
    const buffered = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04'), minBufferDays: 5 })
    const lastNoBuffer = noBuffer.phases[noBuffer.phases.length - 1].end
    const lastBuffered = buffered.phases[buffered.phases.length - 1].end
    expect(lastBuffered.getTime()).toBeLessThan(lastNoBuffer.getTime())
  })

  it('is deterministic for identical inputs', () => {
    const a = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04') })
    const b = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04') })
    expect(a.phases.map((p) => dateKey(p.end))).toEqual(b.phases.map((p) => dateKey(p.end)))
    expect(a.isFeasible).toBe(b.isFeasible)
  })

  it('accepts a custom template', () => {
    const custom: PhaseTemplate[] = [
      { key: 'only', milestoneType: MilestoneType.READY_TO_SUBMIT, label: 'Only phase', offsetWorkingDays: 3, durationWorkingDays: 1 },
    ]
    const result = generateSchedule(deadline, custom, calendar, { now: utc('2027-01-04') })
    expect(result.phases).toHaveLength(1)
    expect(result.phases[0].label).toBe('Only phase')
  })

  it('preserves dependency metadata for the UI', () => {
    const result = generateSchedule(deadline, DEFAULT_PHASES, calendar, { now: utc('2027-01-04') })
    expect(result.phases.find((p) => p.key === 'red_team')?.dependsOn).toBe('first_draft')
    expect(result.phases.find((p) => p.key === 'pink_team')?.optional).toBe(true)
  })
})
