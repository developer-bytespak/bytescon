// GET /api/firm/dashboard — the 30-day calendar behind the Dashboard's
// deadline timeline: notices closing per day, and the firm's own open bids
// due in that window (never another firm's, never closed ones).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let other: TestFirm
let admin: TestUser
const day = (n: number) => new Date(Date.now() + n * 86_400_000)

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Calendar Firm' })
  other = await createTestFirm({ name: 'Calendar Other Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  const opp = (consultingFirmId: string, title: string, deadline: Date) =>
    prisma.opportunity.create({ data: { consultingFirmId, title, agency: 'Department of Veterans Affairs', naicsCode: '236220', responseDeadline: deadline } })
  const a = await opp(firm.id, 'Clinic roof', day(3))
  await opp(firm.id, 'Boiler', day(3))
  const c = await opp(firm.id, 'Parking lot', day(12))
  await opp(firm.id, 'Too far', day(45))
  await opp(other.id, 'Not ours', day(3))
  await prisma.bidPursuit.create({ data: { consultingFirmId: firm.id, opportunityId: a.id, pipelineStage: 'PROPOSAL' } })
  await prisma.bidPursuit.create({ data: { consultingFirmId: firm.id, opportunityId: c.id, pipelineStage: 'NO_BID' } })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('GET /api/firm/dashboard calendar', () => {
  it("counts this firm's notices per day for 30 days and lists its open bids due", async () => {
    const res = await request(app).get('/api/firm/dashboard').set({ Authorization: `Bearer ${admin.token}` }).expect(200)
    const cal = res.body.data.calendar
    expect(cal.closingByDay.reduce((a: number, r: { count: number }) => a + r.count, 0)).toBe(3)
    expect(Math.max(...cal.closingByDay.map((r: { count: number }) => r.count))).toBe(2)
    expect(cal.bidsDue).toHaveLength(1)
    expect(cal.bidsDue[0]).toMatchObject({ title: 'Clinic roof', stage: 'PROPOSAL', agency: 'Department of Veterans Affairs' })
  })
})
