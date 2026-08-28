// =============================================================
// §7.2 — Shared agent working calendar.
//
// Lifted VERBATIM out of §7.1's optionWatch when the Opportunity Agent became
// the second agent needing working-day arithmetic. Same behaviour, same cache,
// same holiday sources — optionWatch now imports it and re-exports it, so every
// existing §7.1 caller and test is unaffected.
//
// Extracted rather than duplicated for the reason the §7.1 brief gave when it
// generalised the reminder ladder: two agents computing "how many working days
// away is this" must not drift apart.
// =============================================================
import { prisma } from '../../config/database'
import {
  makeCalendar,
  usFederalHolidayRange,
  type WorkingCalendar,
} from '../milestones/workingDays'

let calendarCache: { key: string; calendar: WorkingCalendar } | null = null

/**
 * Working calendar spanning the years in play, seeded with US federal holidays
 * plus any firm-specific non-working days already recorded in §6.4.
 */
export async function buildWorkingCalendar(consultingFirmId: string, now: Date): Promise<WorkingCalendar> {
  const year = now.getUTCFullYear()
  const key = `${consultingFirmId}:${year}`
  if (calendarCache?.key === key) return calendarCache.calendar

  const federal = usFederalHolidayRange(year - 1, year + 3).map((h) => h.date)
  const firmEntries = await prisma.holidayCalendarEntry
    .findMany({
      where: { OR: [{ consultingFirmId }, { consultingFirmId: null }] },
      select: { date: true },
    })
    .catch(() => [] as Array<{ date: Date }>)

  const calendar = makeCalendar(undefined, [...federal, ...firmEntries.map((e) => e.date)])
  calendarCache = { key, calendar }
  return calendar
}

/** Test seam: clears the module-level cache between suites. */
export function resetWorkingCalendarCache(): void {
  calendarCache = null
}
