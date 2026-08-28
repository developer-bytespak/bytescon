// =============================================================
// §5.1 Opportunity Monitoring & Data Quality — server-side filters (agency,
// NAICS, source, status, owner, pipeline-stage, bid/no-bid, keyword, combined),
// invalid-filter 422s, stable ordering + pagination, source/classification
// fields, manual create + protection, dedup + amendment idempotency, and
// cross-tenant isolation. Uses the live Express app + real Postgres.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'
import { createTestClient } from '../test-utils/factories'

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let other: TestFirm
let otherAdmin: TestUser
let clientCompanyId: string

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const BASE = '/api/opportunities'
const future = (days: number) => new Date(Date.now() + days * 86_400_000)

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId, title: 'Opp ' + Math.random().toString(36).slice(2, 8), agency: 'Department of the Navy',
      naicsCode: '541512', responseDeadline: future(30), setAsideType: 'NONE', marketCategory: 'SERVICES',
      probabilityScore: 0, isScored: false, ...over,
    },
  })
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Monitoring Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Monitoring Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
  clientCompanyId = (await createTestClient(firm.id)).id
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('classification + source/status filters', () => {
  it('hides demo by default, includes with includeDemo, and exposes classification fields', async () => {
    const live = await makeOpp(firm.id, { title: 'LIVE Navy', source: 'SAM_GOV', samNoticeId: 'N-live-1', sourceUrl: 'https://sam.gov/opp/x/view' })
    await makeOpp(firm.id, { title: 'DEMO Navy', source: 'DEMO', isDemo: true, sourceUrl: null })

    const def = await request(app).get(BASE).set(H(admin.token)).expect(200)
    const titles = def.body.data.map((o: { title: string }) => o.title)
    expect(titles).toContain('LIVE Navy')
    expect(titles).not.toContain('DEMO Navy')
    const liveRow = def.body.data.find((o: { id: string }) => o.id === live.id)
    expect(liveRow.source).toBe('SAM_GOV')
    expect(liveRow.hasValidSourceLink).toBe(true)
    expect(liveRow.isAmended).toBe(false)

    const withDemo = await request(app).get(`${BASE}?includeDemo=true`).set(H(admin.token)).expect(200)
    const demoRow = withDemo.body.data.find((o: { title: string }) => o.title === 'DEMO Navy')
    expect(demoRow.source).toBe('DEMO')
    expect(demoRow.hasValidSourceLink).toBe(false) // demo never renders a gov link
  })

  it('filters by source (MANUAL only)', async () => {
    const man = await makeOpp(firm.id, { title: 'MANUAL entry', source: 'MANUAL' })
    const res = await request(app).get(`${BASE}?source=MANUAL`).set(H(admin.token)).expect(200)
    expect(res.body.data.every((o: { source: string }) => o.source === 'MANUAL')).toBe(true)
    expect(res.body.data.some((o: { id: string }) => o.id === man.id)).toBe(true)
    const manRow = res.body.data.find((o: { id: string }) => o.id === man.id)
    expect(manRow.hasValidSourceLink).toBe(false) // manual w/o sourceUrl
  })

  it('filters by status incl. CANCELLED', async () => {
    const cancelled = await makeOpp(firm.id, { title: 'Cancelled buy', status: 'CANCELLED' })
    const res = await request(app).get(`${BASE}?status=CANCELLED`).set(H(admin.token)).expect(200)
    expect(res.body.data.every((o: { status: string }) => o.status === 'CANCELLED')).toBe(true)
    expect(res.body.data.some((o: { id: string }) => o.id === cancelled.id)).toBe(true)
  })
})

describe('agency / NAICS / keyword / combined filters', () => {
  it('filters and combines correctly', async () => {
    await makeOpp(firm.id, { title: 'Army Radar', agency: 'Department of the Army', naicsCode: '541330' })
    const byAgency = await request(app).get(`${BASE}?agency=Army`).set(H(admin.token)).expect(200)
    expect(byAgency.body.data.every((o: { agency: string }) => /army/i.test(o.agency))).toBe(true)
    const byNaics = await request(app).get(`${BASE}?naicsCode=5413`).set(H(admin.token)).expect(200)
    expect(byNaics.body.data.every((o: { naicsCode: string }) => o.naicsCode.startsWith('5413'))).toBe(true)
    const combined = await request(app).get(`${BASE}?agency=Army&naicsCode=5413`).set(H(admin.token)).expect(200)
    expect(combined.body.data.every((o: { agency: string; naicsCode: string }) => /army/i.test(o.agency) && o.naicsCode.startsWith('5413'))).toBe(true)
    const byKeyword = await request(app).get(`${BASE}?search=Radar`).set(H(admin.token)).expect(200)
    expect(byKeyword.body.data.some((o: { title: string }) => /radar/i.test(o.title))).toBe(true)
  })
})

describe('owner / pipeline-stage / bid-no-bid filters', () => {
  it('filters by pursuit owner, pipeline stage, and bid decision', async () => {
    const opp = await makeOpp(firm.id, { title: 'Owned+Decided' })
    await prisma.bidPursuit.create({ data: { consultingFirmId: firm.id, opportunityId: opp.id, ownerUserId: admin.id, pipelineStage: 'CAPTURE' as never } })
    await prisma.bidDecision.create({ data: { consultingFirmId: firm.id, clientCompanyId, opportunityId: opp.id, decision: 'GO' } })

    const byOwner = await request(app).get(`${BASE}?ownerUserId=${admin.id}`).set(H(admin.token)).expect(200)
    expect(byOwner.body.data.some((o: { id: string }) => o.id === opp.id)).toBe(true)
    const byStage = await request(app).get(`${BASE}?pipelineStage=CAPTURE`).set(H(admin.token)).expect(200)
    expect(byStage.body.data.some((o: { id: string }) => o.id === opp.id)).toBe(true)
    const byDecision = await request(app).get(`${BASE}?bidDecision=GO`).set(H(admin.token)).expect(200)
    expect(byDecision.body.data.some((o: { id: string }) => o.id === opp.id)).toBe(true)
  })
})

describe('invalid filters', () => {
  it('rejects malformed enum filters with 422', async () => {
    await request(app).get(`${BASE}?status=NOPE`).set(H(admin.token)).expect(422)
    await request(app).get(`${BASE}?source=NOPE`).set(H(admin.token)).expect(422)
    await request(app).get(`${BASE}?pipelineStage=NOPE`).set(H(admin.token)).expect(422)
    await request(app).get(`${BASE}?bidDecision=NOPE`).set(H(admin.token)).expect(422)
  })
})

describe('stable ordering + pagination', () => {
  it('returns a deterministic order across identical requests', async () => {
    // Several rows tie on probabilityScore 0 → secondary id sort makes order stable.
    for (let i = 0; i < 5; i++) await makeOpp(firm.id, { title: `Tie ${i}`, probabilityScore: 0 })
    const a = await request(app).get(`${BASE}?limit=50&sortBy=probability&sortOrder=desc`).set(H(admin.token)).expect(200)
    const b = await request(app).get(`${BASE}?limit=50&sortBy=probability&sortOrder=desc`).set(H(admin.token)).expect(200)
    expect(a.body.data.map((o: { id: string }) => o.id)).toEqual(b.body.data.map((o: { id: string }) => o.id))
  })
  it('paginates with disjoint pages and a correct total', async () => {
    const p1 = await request(app).get(`${BASE}?limit=2&page=1`).set(H(admin.token)).expect(200)
    const p2 = await request(app).get(`${BASE}?limit=2&page=2`).set(H(admin.token)).expect(200)
    expect(p1.body.meta.limit).toBe(2)
    expect(p1.body.data.length).toBeLessThanOrEqual(2)
    const ids1 = new Set(p1.body.data.map((o: { id: string }) => o.id))
    expect(p2.body.data.every((o: { id: string }) => !ids1.has(o.id))).toBe(true)
    expect(p1.body.meta.total).toBe(p2.body.meta.total)
  })
})

describe('manual create + dedup + amendments', () => {
  it('creates a manual opportunity (ADMIN), forbids CONSULTANT, validates payload', async () => {
    const res = await request(app).post(`${BASE}/manual`).set(H(admin.token)).send({ title: 'Hand Entered', agency: 'GSA', responseDeadline: future(20).toISOString(), naicsCode: '541512' }).expect(201)
    expect(res.body.data.source).toBe('MANUAL')
    expect(res.body.data.isDemo).toBe(false)
    await request(app).post(`${BASE}/manual`).set(H(consultant.token)).send({ title: 'x', agency: 'y', responseDeadline: future(1).toISOString() }).expect(403)
    await request(app).post(`${BASE}/manual`).set(H(admin.token)).send({ agency: 'no title' }).expect(422)
  })
  it('prevents duplicate opportunities on the same (firm, samNoticeId)', async () => {
    await makeOpp(firm.id, { samNoticeId: 'DUP-1' })
    await expect(makeOpp(firm.id, { samNoticeId: 'DUP-1' })).rejects.toThrow()
  })
  it('surfaces amendment count without duplicating the opportunity (idempotent amendment upsert)', async () => {
    const opp = await makeOpp(firm.id, { title: 'Amended', samNoticeId: 'AMD-1' })
    const amendmentId = 'AMD-1_0001'
    for (let i = 0; i < 2; i++) {
      await prisma.amendment.upsert({
        where: { id: amendmentId },
        update: { title: 'Amendment 0001' },
        create: { id: amendmentId, opportunityId: opp.id, amendmentNo: '0001', amendmentNumber: '0001', title: 'Amendment 0001' },
      })
    }
    const amendments = await prisma.amendment.count({ where: { opportunityId: opp.id } })
    expect(amendments).toBe(1) // upsert idempotent
    const res = await request(app).get(`${BASE}?search=Amended`).set(H(admin.token)).expect(200)
    const row = res.body.data.find((o: { id: string }) => o.id === opp.id)
    expect(row.isAmended).toBe(true)
    expect(row.amendmentCount).toBe(1)
  })
})

describe('cross-tenant isolation', () => {
  it('never returns another firm opportunities and 404s a foreign detail', async () => {
    const foreign = await makeOpp(other.id, { title: 'Other firm only', samNoticeId: 'OTHER-1' })
    const list = await request(app).get(`${BASE}?includeDemo=true&showExpired=true&limit=100`).set(H(admin.token)).expect(200)
    expect(list.body.data.every((o: { consultingFirmId: string }) => o.consultingFirmId === firm.id)).toBe(true)
    await request(app).get(`${BASE}/${foreign.id}`).set(H(admin.token)).expect(404)
  })
})
