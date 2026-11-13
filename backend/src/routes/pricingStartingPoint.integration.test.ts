// =============================================================
// "Use my rates" (POST /api/pricing/scenarios/:id/starting-point): a new
// price starts from the firm's Finance actual rates and its last approved
// price, never invented; only lines the scenario lacks are added.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const B = '/api/pricing'
let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let empty: TestFirm
let emptyAdmin: TestUser

const opp = (consultingFirmId: string, title: string) => prisma.opportunity.create({ data: { consultingFirmId, title, agency: 'GSA', naicsCode: '236220', responseDeadline: new Date(Date.now() + 30 * 86_400_000) } })
const workspace = async (token: string, opportunityId: string) => (await request(app).post(`${B}/opportunity/${opportunityId}`).set(H(token)).send({ title: 'Volume III — Price' }).expect(201)).body.data.workspace
const linesOf = async (scenarioId: string) => ({
  labour: await prisma.pricingLaborLine.findMany({ where: { scenarioId }, orderBy: { sortOrder: 'asc' } }),
  rates: await prisma.pricingIndirectRate.findMany({ where: { scenarioId }, orderBy: { sortOrder: 'asc' } }),
})

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Starting Point Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  empty = await createTestFirm({ name: 'No Rates Firm' })
  emptyAdmin = await createTestUser(empty.id, { role: 'ADMIN' })

  // An earlier bid, priced and approved.
  const earlier = await opp(firm.id, 'Visitor Center Roof')
  const ws = await workspace(admin.token, earlier.id)
  const sc = ws.scenarios[0].id
  await request(app).post(`${B}/scenarios/${sc}/labor`).set(H(admin.token)).send({ categoryName: 'Project Manager', personnelCount: 1, hours: 480, baseRate: 85 }).expect(201)
  await request(app).post(`${B}/scenarios/${sc}/labor`).set(H(admin.token)).send({ categoryName: 'Roofer', personnelCount: 6, hours: 960, baseRate: 45 }).expect(201)
  await request(app).post(`${B}/scenarios/${sc}/indirect`).set(H(admin.token)).send({ name: 'Fringe', rateType: 'FRINGE', percent: 25, costBase: 'DIRECT_LABOUR' }).expect(201)
  await request(app).post(`${B}/scenarios/${sc}/indirect`).set(H(admin.token)).send({ name: 'Profit', rateType: 'FEE', percent: 8, costBase: 'TOTAL_DIRECT_COST' }).expect(201)
  await request(app).post(`${B}/${ws.id}/submit`).set(H(admin.token)).expect(200)
  await request(app).post(`${B}/${ws.id}/approve`).set(H(admin.token)).expect(200)

  // Finance: the firm's final actual fringe and overhead.
  await prisma.actualIndirectRate.createMany({ data: [
    { consultingFirmId: firm.id, periodStart: new Date('2025-01-01'), periodEnd: new Date('2025-12-31'), fiscalYear: 2025, rateType: 'FRINGE', actualRate: 31.5, status: 'FINAL' },
    { consultingFirmId: firm.id, periodStart: new Date('2025-01-01'), periodEnd: new Date('2025-12-31'), fiscalYear: 2025, rateType: 'OVERHEAD', poolName: 'Field overhead', actualRate: 14.25, status: 'FINAL' },
    { consultingFirmId: firm.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-06-30'), fiscalYear: 2026, rateType: 'GA', actualRate: 99, status: 'DRAFT' },
  ] })
})
afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(empty.id)
  await disconnectDb()
})

describe('Use my rates', () => {
  it('starts a new price from Finance actual rates and the last approved price, then adds nothing twice', async () => {
    const ws = await workspace(admin.token, (await opp(firm.id, 'Laboratory Roof')).id)
    const sc = ws.scenarios[0].id
    await request(app).post(`${B}/scenarios/${sc}/starting-point`).set(H(consultant.token)).expect(403)

    const res = await request(app).post(`${B}/scenarios/${sc}/starting-point`).set(H(admin.token)).expect(201)
    expect(res.body.data.added).toEqual({ labour: 2, rates: 3 })
    expect(res.body.data.from.join(' ')).toMatch(/Finance/)
    expect(res.body.data.from.join(' ')).toMatch(/Visitor Center Roof/)

    const { labour, rates } = await linesOf(sc)
    expect(labour.map((l) => [l.categoryName, Number(l.hours), Number(l.baseRate)])).toEqual([['Project Manager', 480, 85], ['Roofer', 960, 45]])
    expect(labour[0].notes).toMatch(/adjust the hours/)
    const byType = Object.fromEntries(rates.map((r) => [r.rateType, r]))
    // Finance's final rate wins over the last price; a draft actual is ignored.
    expect(Number(byType.FRINGE.percent)).toBe(31.5)
    expect(byType.FRINGE.source).toMatch(/Finance actual rates, FY2025/)
    expect(byType.OVERHEAD).toMatchObject({ name: 'Field overhead', costBase: 'LABOUR_PLUS_FRINGE' })
    expect(Number(byType.FEE.percent)).toBe(8)
    expect(byType.FEE.source).toMatch(/Last approved price/)
    expect(byType.GA).toBeUndefined()
    expect(Number(res.body.data.totals.totalPrice ?? 0)).toBeGreaterThan(0)

    const again = await request(app).post(`${B}/scenarios/${sc}/starting-point`).set(H(admin.token)).expect(422)
    expect(again.body.error).toMatch(/already has/)
  })

  it('keeps what the scenario already has', async () => {
    const ws = await workspace(admin.token, (await opp(firm.id, 'Clinic Roof')).id)
    const sc = ws.scenarios[0].id
    await request(app).post(`${B}/scenarios/${sc}/labor`).set(H(admin.token)).send({ categoryName: 'Roofer', personnelCount: 4, hours: 500, baseRate: 50 }).expect(201)
    await request(app).post(`${B}/scenarios/${sc}/starting-point`).set(H(admin.token)).expect(201)
    const { labour } = await linesOf(sc)
    expect(labour.filter((l) => l.categoryName === 'Roofer').map((l) => Number(l.baseRate))).toEqual([50])
    expect(labour.map((l) => l.categoryName)).toContain('Project Manager')
  })

  it('says so when the firm has no rates on record', async () => {
    const ws = await workspace(emptyAdmin.token, (await opp(empty.id, 'First Bid')).id)
    const res = await request(app).post(`${B}/scenarios/${ws.scenarios[0].id}/starting-point`).set(H(emptyAdmin.token)).expect(422)
    expect(res.body.error).toMatch(/No rates on record yet/)
  })
})

describe('the competitive benchmark before any price', () => {
  it('shows the range of comparable awards up front', async () => {
    const naics = '999917'
    const agency = 'Starting Point Test Agency'
    for (const amount of [800_000, 900_000, 1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000, 1_600_000]) {
      const past = await prisma.opportunity.create({ data: { consultingFirmId: firm.id, title: 'Past award', agency, naicsCode: naics, setAsideType: 'SDVOSB', responseDeadline: new Date(Date.now() - 400 * 86_400_000), status: 'ARCHIVED' } })
      await prisma.awardHistory.create({ data: { opportunityId: past.id, awardingAgency: agency, recipientName: `R-${amount}`, awardAmount: amount, awardDate: new Date(Date.now() - 180 * 86_400_000), naics, awardType: 'DO', contractNumber: `C-${amount}-${Math.random().toString(36).slice(2, 7)}` } })
    }
    const target = await prisma.opportunity.create({ data: { consultingFirmId: firm.id, title: 'New roof', agency, naicsCode: naics, setAsideType: 'SDVOSB', responseDeadline: new Date(Date.now() + 30 * 86_400_000) } })
    const res = await request(app).get(`${B}/opportunity/${target.id}/benchmark`).set(H(admin.token)).expect(200)
    expect(res.body.data.available).toBe(true)
    const r = res.body.data.range
    expect(r.cohortSize).toBe(8)
    expect(r.p25).toBeLessThan(r.median)
    expect(r.median).toBeLessThan(r.p75)
    // Read-only: nothing stored.
    expect(await prisma.awardBenchmarkCohort.count({ where: { opportunityId: target.id } })).toBe(0)
  })
})
