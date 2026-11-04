// B19 — a firm's new holiday reaches the agents without a server restart.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { prisma } from '../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../../test-utils/testClient'
import { dateKey, isWorkingDay } from '../milestones/workingDays'
import { buildWorkingCalendar, resetWorkingCalendarCache } from './workingCalendar'

let firm: TestFirm
const DAY = new Date(Date.UTC(2031, 2, 12)) // a Wednesday, no federal holiday

beforeAll(async () => {
  firm = await createTestFirm({ name: 'Holiday Refresh Firm' })
  resetWorkingCalendarCache()
})

afterEach(() => {
  vi.useRealTimers()
})

afterAll(async () => {
  await prisma.holidayCalendarEntry.deleteMany({ where: { consultingFirmId: firm.id } })
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('the working calendar', () => {
  it('picks up a new firm holiday within minutes', async () => {
    const now = new Date('2031-03-01T12:00:00Z')
    vi.useFakeTimers({ toFake: ['Date'], now })

    const before = await buildWorkingCalendar(firm.id, now)
    expect(isWorkingDay(DAY, before)).toBe(true)

    await prisma.holidayCalendarEntry.create({ data: { consultingFirmId: firm.id, date: DAY, name: 'Firm closure' } as never })

    // Still cached moments later, which is what keeps a sweep cheap.
    expect(isWorkingDay(DAY, await buildWorkingCalendar(firm.id, now))).toBe(true)

    vi.setSystemTime(new Date(now.getTime() + 6 * 60_000))
    const after = await buildWorkingCalendar(firm.id, new Date())
    expect(after.holidays.has(dateKey(DAY))).toBe(true)
    expect(isWorkingDay(DAY, after)).toBe(false)
  })
})
