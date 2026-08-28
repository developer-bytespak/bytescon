// =============================================================
// §6.4C — Working-day calculations.
//
// Pure date arithmetic over a configurable working week plus a holiday
// calendar. All maths is done in UTC on date-only values so a schedule never
// drifts a day because of the server's timezone.
// =============================================================

/** ISO weekday numbers: 1 = Monday … 7 = Sunday. */
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5]

export function toUtcDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

export function isoWeekday(date: Date): number {
  const day = date.getUTCDay()
  return day === 0 ? 7 : day
}

export function dateKey(date: Date): string {
  return toUtcDateOnly(date).toISOString().slice(0, 10)
}

export interface WorkingCalendar {
  workingDays: number[]
  /** Set of YYYY-MM-DD non-working dates. */
  holidays: Set<string>
}

export function makeCalendar(workingDays: number[] = DEFAULT_WORKING_DAYS, holidayDates: Date[] = []): WorkingCalendar {
  return {
    workingDays: workingDays.length > 0 ? workingDays : DEFAULT_WORKING_DAYS,
    holidays: new Set(holidayDates.map(dateKey)),
  }
}

export function isWorkingDay(date: Date, calendar: WorkingCalendar): boolean {
  if (!calendar.workingDays.includes(isoWeekday(date))) return false
  return !calendar.holidays.has(dateKey(date))
}

const DAY = 86400000

/** Nearest working day at or before `date`. */
export function previousWorkingDay(date: Date, calendar: WorkingCalendar, maxLookback = 400): Date {
  let cursor = toUtcDateOnly(date)
  for (let i = 0; i < maxLookback; i++) {
    if (isWorkingDay(cursor, calendar)) return cursor
    cursor = new Date(cursor.getTime() - DAY)
  }
  return cursor
}

/** Nearest working day at or after `date`. */
export function nextWorkingDay(date: Date, calendar: WorkingCalendar, maxLookahead = 400): Date {
  let cursor = toUtcDateOnly(date)
  for (let i = 0; i < maxLookahead; i++) {
    if (isWorkingDay(cursor, calendar)) return cursor
    cursor = new Date(cursor.getTime() + DAY)
  }
  return cursor
}

/**
 * Move `count` working days from `from`. Negative counts move backwards, which
 * is how a working-backward schedule is built. The starting day is not counted.
 */
export function addWorkingDays(from: Date, count: number, calendar: WorkingCalendar): Date {
  let cursor = toUtcDateOnly(from)
  if (count === 0) return previousWorkingDay(cursor, calendar)
  const step = count > 0 ? DAY : -DAY
  let remaining = Math.abs(count)
  let guard = 0
  while (remaining > 0 && guard < 4000) {
    cursor = new Date(cursor.getTime() + step)
    if (isWorkingDay(cursor, calendar)) remaining--
    guard++
  }
  return cursor
}

/** Inclusive working-day count between two dates. Negative when b precedes a. */
export function workingDaysBetween(a: Date, b: Date, calendar: WorkingCalendar): number {
  const start = toUtcDateOnly(a)
  const end = toUtcDateOnly(b)
  if (start.getTime() === end.getTime()) return 0
  const backwards = end < start
  let cursor = backwards ? end : start
  const target = backwards ? start : end
  let count = 0
  let guard = 0
  while (cursor < target && guard < 4000) {
    cursor = new Date(cursor.getTime() + DAY)
    if (isWorkingDay(cursor, calendar)) count++
    guard++
  }
  return backwards ? -count : count
}

/**
 * US federal holidays for one year, computed from the observance rules rather
 * than hard-coded per year, so the calendar never silently goes stale.
 * Saturday holidays observe Friday; Sunday holidays observe Monday.
 */
export function usFederalHolidays(year: number): Array<{ date: Date; name: string }> {
  const fixed = (month: number, day: number, name: string) => ({ date: observed(new Date(Date.UTC(year, month, day))), name })

  // nth weekday of a month; n = -1 means the last one.
  const nth = (month: number, weekday: number, n: number, name: string) => {
    if (n > 0) {
      const first = new Date(Date.UTC(year, month, 1))
      const offset = (weekday - isoWeekday(first) + 7) % 7
      return { date: new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7)), name }
    }
    const last = new Date(Date.UTC(year, month + 1, 0))
    const offset = (isoWeekday(last) - weekday + 7) % 7
    return { date: new Date(Date.UTC(year, month + 1, 0 - offset)), name }
  }

  function observed(date: Date): Date {
    const weekday = isoWeekday(date)
    if (weekday === 6) return new Date(date.getTime() - DAY) // Saturday → Friday
    if (weekday === 7) return new Date(date.getTime() + DAY) // Sunday → Monday
    return date
  }

  return [
    fixed(0, 1, "New Year's Day"),
    nth(0, 1, 3, 'Birthday of Martin Luther King, Jr.'),
    nth(1, 1, 3, "Washington's Birthday"),
    nth(4, 1, -1, 'Memorial Day'),
    fixed(5, 19, 'Juneteenth National Independence Day'),
    fixed(6, 4, 'Independence Day'),
    nth(8, 1, 1, 'Labor Day'),
    nth(9, 1, 2, 'Columbus Day'),
    fixed(10, 11, 'Veterans Day'),
    nth(10, 4, 4, 'Thanksgiving Day'),
    fixed(11, 25, 'Christmas Day'),
  ]
}

/** Federal holidays across a span of years, for building a calendar. */
export function usFederalHolidayRange(startYear: number, endYear: number): Array<{ date: Date; name: string }> {
  const out: Array<{ date: Date; name: string }> = []
  for (let y = startYear; y <= endYear; y++) out.push(...usFederalHolidays(y))
  return out
}
