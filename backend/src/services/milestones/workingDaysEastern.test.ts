// B20 — a deadline in the evening, US Eastern, belongs to that Eastern day.
import { describe, it, expect } from 'vitest'
import { addWorkingDays, dateKey, isWorkingDay, isoWeekday, makeCalendar, toUtcDateOnly } from './workingDays'

const calendar = makeCalendar()

describe('which calendar day an instant belongs to', () => {
  it('keeps 9 pm Eastern on its Eastern date, in winter and in summer', () => {
    // Thu 5 Nov 2026 21:00 EST = Fri 6 Nov 02:00 UTC
    expect(dateKey(new Date('2026-11-06T02:00:00Z'))).toBe('2026-11-05')
    // Thu 6 Aug 2026 21:00 EDT = Fri 7 Aug 01:00 UTC
    expect(dateKey(new Date('2026-08-07T01:00:00Z'))).toBe('2026-08-06')
  })

  it('moves to the next day at Eastern midnight', () => {
    expect(dateKey(new Date('2026-11-06T04:59:00Z'))).toBe('2026-11-05')
    expect(dateKey(new Date('2026-11-06T05:01:00Z'))).toBe('2026-11-06')
  })

  it('leaves a date with no time on the date it names', () => {
    expect(dateKey(new Date('2026-11-06T00:00:00.000Z'))).toBe('2026-11-06')
    expect(toUtcDateOnly(new Date(Date.UTC(2026, 10, 6))).toISOString()).toBe('2026-11-06T00:00:00.000Z')
  })

  it('uses the same day for the weekday check', () => {
    // Fri 6 Nov 21:00 EST = Sat 7 Nov 02:00 UTC: still a Friday, still a working day.
    const fridayEvening = new Date('2026-11-07T02:00:00Z')
    expect(isoWeekday(fridayEvening)).toBe(5)
    expect(isWorkingDay(fridayEvening, calendar)).toBe(true)
    // Sun 8 Nov 21:00 EST = Mon 9 Nov 02:00 UTC: still a Sunday.
    expect(isWorkingDay(new Date('2026-11-09T02:00:00Z'), calendar)).toBe(false)
  })

  it('counts working days from the Eastern date, not a day late', () => {
    // Thu 9 pm Eastern plus one working day is Friday.
    expect(dateKey(addWorkingDays(new Date('2026-11-06T02:00:00Z'), 1, calendar))).toBe('2026-11-06')
  })
})
