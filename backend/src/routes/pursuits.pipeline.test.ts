// =============================================================
// Section 5.2 — Opportunity Pipeline Tracker integration tests.
// Pipeline list (filter/sort/pagination/stageCounts/overdue/bidDecision),
// stage transitions (valid + invalid), owner assignment (ADMIN-gated),
// next-action updates, audit logging, cross-tenant isolation, and
// no-duplication. Dates use fixed offsets (controlled clock).
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
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
const BASE = '/api/pursuits'

async function makeOpp(consultingFirmId: string, over: Partial<{ title: string; agency: string; solicitationNumber: string; estimatedValue: number }> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId,
      title: over.title ?? 'Pipeline Opp',
      agency: over.agency ?? 'GSA',
      naicsCode: '541512',
      responseDeadline: new Date(Date.now() + 20 * 86_400_000),
      solicitationNumber: over.solicitationNumber,
      estimatedValue: over.estimatedValue ?? 250000,
    },
  })
}

async function makePursuit(
  consultingFirmId: string,
  opportunityId: string,
  over: Partial<{ pipelineStage: string; priority: string; ownerUserId: string; nextActionDueAt: Date | null; nextAction: string }> = {},
) {
  return prisma.bidPursuit.create({
    data: {
      consultingFirmId,
      opportunityId,
      pipelineStage: (over.pipelineStage ?? 'IDENTIFIED') as never,
      priority: (over.priority ?? 'MEDIUM') as never,
      ownerUserId: over.ownerUserId ?? null,
      nextAction: over.nextAction ?? null,
      nextActionDueAt: over.nextActionDueAt ?? null,
    },
  })
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Pipeline Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Pipeline Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
  const cc = await createTestClient(firm.id)
  clientCompanyId = cc.id
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(other.id)
  await disconnectDb()
})

describe('GET /api/pursuits/pipeline — list, filter, sort, paginate', () => {
  it('401 unauthenticated', async () => {
    await request(app).get(`${BASE}/pipeline`).expect(401)
  })

  it('returns firm pursuits with stageCounts and excludes ARCHIVED by default', async () => {
    const o1 = await makeOpp(firm.id, { title: 'Alpha radar', agency: 'DoD', solicitationNumber: 'SOL-A1' })
    const o2 = await makeOpp(firm.id, { title: 'Beta logistics', agency: 'GSA' })
    const oArch = await makeOpp(firm.id, { title: 'Archived one' })
    await makePursuit(firm.id, o1.id, { pipelineStage: 'QUALIFICATION', priority: 'HIGH', ownerUserId: admin.id })
    await makePursuit(firm.id, o2.id, { pipelineStage: 'CAPTURE', priority: 'LOW' })
    await makePursuit(firm.id, oArch.id, { pipelineStage: 'ARCHIVED' })

    const res = await request(app).get(`${BASE}/pipeline`).set(H(admin.token)).expect(200)
    expect(res.body.success).toBe(true)
    const titles = res.body.data.items.map((i: { opportunity: { title: string } }) => i.opportunity.title)
    expect(titles).toContain('Alpha radar')
    expect(titles).not.toContain('Archived one')
    expect(res.body.data.stageCounts.ARCHIVED).toBeGreaterThanOrEqual(1)
    expect(res.body.data.stageCounts.QUALIFICATION).toBeGreaterThanOrEqual(1)

    const withArch = await request(app).get(`${BASE}/pipeline?includeArchived=true`).set(H(admin.token)).expect(200)
    expect(withArch.body.data.items.map((i: { opportunity: { title: string } }) => i.opportunity.title)).toContain('Archived one')
  })

  it('filters by stage, priority, owner, unassigned, and keyword search', async () => {
    const byStage = await request(app).get(`${BASE}/pipeline?stage=CAPTURE`).set(H(admin.token)).expect(200)
    expect(byStage.body.data.items.every((i: { pipelineStage: string }) => i.pipelineStage === 'CAPTURE')).toBe(true)

    const byPriority = await request(app).get(`${BASE}/pipeline?priority=HIGH`).set(H(admin.token)).expect(200)
    expect(byPriority.body.data.items.every((i: { priority: string }) => i.priority === 'HIGH')).toBe(true)

    const byOwner = await request(app).get(`${BASE}/pipeline?ownerUserId=${admin.id}`).set(H(admin.token)).expect(200)
    expect(byOwner.body.data.items.every((i: { ownerUserId: string }) => i.ownerUserId === admin.id)).toBe(true)

    const unassigned = await request(app).get(`${BASE}/pipeline?ownerUserId=unassigned`).set(H(admin.token)).expect(200)
    expect(unassigned.body.data.items.every((i: { ownerUserId: string | null }) => i.ownerUserId === null)).toBe(true)

    const search = await request(app).get(`${BASE}/pipeline?q=radar`).set(H(admin.token)).expect(200)
    expect(search.body.data.items.map((i: { opportunity: { title: string } }) => i.opportunity.title)).toContain('Alpha radar')
  })

  it('rejects an invalid filter value with 422', async () => {
    await request(app).get(`${BASE}/pipeline?stage=BOGUS`).set(H(admin.token)).expect(422)
    await request(app).get(`${BASE}/pipeline?priority=URGENT`).set(H(admin.token)).expect(422)
  })

  it('flags overdue next-actions and supports the overdue filter', async () => {
    const o = await makeOpp(firm.id, { title: 'Overdue opp' })
    const p = await makePursuit(firm.id, o.id, { pipelineStage: 'CAPTURE', nextActionDueAt: new Date(Date.now() - 2 * 86_400_000) })
    const res = await request(app).get(`${BASE}/pipeline?overdue=true`).set(H(admin.token)).expect(200)
    const found = res.body.data.items.find((i: { id: string }) => i.id === p.id)
    expect(found).toBeTruthy()
    expect(found.isOverdue).toBe(true)
  })

  it('paginates with a stable deterministic order', async () => {
    const p1 = await request(app).get(`${BASE}/pipeline?limit=2&page=1&sortBy=lastActivityAt&order=desc`).set(H(admin.token)).expect(200)
    const p1again = await request(app).get(`${BASE}/pipeline?limit=2&page=1&sortBy=lastActivityAt&order=desc`).set(H(admin.token)).expect(200)
    expect(p1.body.data.items.map((i: { id: string }) => i.id)).toEqual(p1again.body.data.items.map((i: { id: string }) => i.id))
    expect(p1.body.data.limit).toBe(2)
    expect(p1.body.data.items.length).toBeLessThanOrEqual(2)
  })

  it('surfaces the linked bid/no-bid decision and filters by it', async () => {
    const o = await makeOpp(firm.id, { title: 'Decided opp' })
    const p = await makePursuit(firm.id, o.id, { pipelineStage: 'PROPOSAL' })
    await prisma.bidDecision.create({
      data: { consultingFirmId: firm.id, clientCompanyId, opportunityId: o.id, decision: 'GO', recommendation: 'BID_PRIME', winProbability: 0.6 },
    })
    const res = await request(app).get(`${BASE}/pipeline?bidDecision=GO`).set(H(admin.token)).expect(200)
    const found = res.body.data.items.find((i: { id: string }) => i.id === p.id)
    expect(found.bidDecision.decision).toBe('GO')
    expect(found.bidDecision.recommendation).toBe('BID_PRIME')
  })
})

describe('PATCH /api/pursuits/:id/stage — validated transitions + audit', () => {
  it('applies a valid transition and writes an audit event', async () => {
    const o = await makeOpp(firm.id, { title: 'Stage opp' })
    const p = await makePursuit(firm.id, o.id, { pipelineStage: 'IDENTIFIED' })
    const res = await request(app).patch(`${BASE}/${p.id}/stage`).set(H(admin.token)).send({ stage: 'QUALIFICATION', reason: 'shortlisted' }).expect(200)
    expect(res.body.data.pipelineStage).toBe('QUALIFICATION')
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'BidPursuit', entityId: p.id, action: 'UPDATE' } })
    expect(audit).toBeTruthy()
  })

  it('rejects an impossible transition with 422 and lists allowed targets', async () => {
    const o = await makeOpp(firm.id, { title: 'Bad stage opp' })
    const p = await makePursuit(firm.id, o.id, { pipelineStage: 'IDENTIFIED' })
    const res = await request(app).patch(`${BASE}/${p.id}/stage`).set(H(admin.token)).send({ stage: 'AWARDED' }).expect(422)
    expect(res.body.code).toBe('INVALID_TRANSITION')
    expect(res.body.data.allowedTargets).toContain('QUALIFICATION')
    const still = await prisma.bidPursuit.findUnique({ where: { id: p.id } })
    expect(still?.pipelineStage).toBe('IDENTIFIED')
  })

  it('returns 404 for a pursuit in another firm (no cross-tenant leak)', async () => {
    const o = await makeOpp(firm.id, { title: 'Tenant opp' })
    const p = await makePursuit(firm.id, o.id, { pipelineStage: 'IDENTIFIED' })
    await request(app).patch(`${BASE}/${p.id}/stage`).set(H(otherAdmin.token)).send({ stage: 'QUALIFICATION' }).expect(404)
  })
})

describe('PATCH /api/pursuits/:id/assign — ADMIN-gated owner assignment', () => {
  it('lets an ADMIN assign and clear the owner', async () => {
    const o = await makeOpp(firm.id, { title: 'Assign opp' })
    const p = await makePursuit(firm.id, o.id)
    const assigned = await request(app).patch(`${BASE}/${p.id}/assign`).set(H(admin.token)).send({ ownerUserId: consultant.id }).expect(200)
    expect(assigned.body.data.ownerUserId).toBe(consultant.id)
    expect(assigned.body.data.owner.email).toBe(consultant.email)
    const cleared = await request(app).patch(`${BASE}/${p.id}/assign`).set(H(admin.token)).send({ ownerUserId: null }).expect(200)
    expect(cleared.body.data.ownerUserId).toBeNull()
  })

  it('forbids a CONSULTANT from assigning owners (403)', async () => {
    const o = await makeOpp(firm.id, { title: 'Assign gate opp' })
    const p = await makePursuit(firm.id, o.id)
    await request(app).patch(`${BASE}/${p.id}/assign`).set(H(consultant.token)).send({ ownerUserId: admin.id }).expect(403)
  })

  it('rejects an owner from another firm (422)', async () => {
    const o = await makeOpp(firm.id, { title: 'Foreign owner opp' })
    const p = await makePursuit(firm.id, o.id)
    await request(app).patch(`${BASE}/${p.id}/assign`).set(H(admin.token)).send({ ownerUserId: otherAdmin.id }).expect(422)
  })
})

describe('PATCH /api/pursuits/:id/next-action — next action, notes, priority', () => {
  it('updates fields and reflects overdue state', async () => {
    const o = await makeOpp(firm.id, { title: 'Next action opp' })
    const p = await makePursuit(firm.id, o.id, { pipelineStage: 'CAPTURE' })
    const res = await request(app)
      .patch(`${BASE}/${p.id}/next-action`)
      .set(H(admin.token))
      .send({ nextAction: 'Draft pink team', nextActionDueAt: iso(-1), priority: 'CRITICAL', notes: 'tight timeline' })
      .expect(200)
    expect(res.body.data.nextAction).toBe('Draft pink team')
    expect(res.body.data.priority).toBe('CRITICAL')
    expect(res.body.data.isOverdue).toBe(true)
  })

  it('rejects an empty payload with 422', async () => {
    const o = await makeOpp(firm.id, { title: 'Empty payload opp' })
    const p = await makePursuit(firm.id, o.id)
    await request(app).patch(`${BASE}/${p.id}/next-action`).set(H(admin.token)).send({}).expect(422)
  })
})

describe('role gating — CONSULTANT is read-only', () => {
  it('lets a CONSULTANT read the pipeline but not mutate it', async () => {
    const o = await makeOpp(firm.id, { title: 'Readonly opp' })
    const p = await makePursuit(firm.id, o.id, { pipelineStage: 'IDENTIFIED' })
    await request(app).get(`${BASE}/pipeline`).set(H(consultant.token)).expect(200)
    await request(app).patch(`${BASE}/${p.id}/stage`).set(H(consultant.token)).send({ stage: 'QUALIFICATION' }).expect(403)
    await request(app).patch(`${BASE}/${p.id}/next-action`).set(H(consultant.token)).send({ priority: 'HIGH' }).expect(403)
    await request(app).patch(`${BASE}/${p.id}/assign`).set(H(consultant.token)).send({ ownerUserId: admin.id }).expect(403)
  })
})

describe('tenant isolation + no duplication', () => {
  it('never returns another firm rows in the pipeline', async () => {
    const o = await makeOpp(other.id, { title: 'Other firm only' })
    await makePursuit(other.id, o.id, { pipelineStage: 'CAPTURE' })
    const res = await request(app).get(`${BASE}/pipeline?includeArchived=true`).set(H(admin.token)).expect(200)
    expect(res.body.data.items.every((i: { consultingFirmId: string }) => i.consultingFirmId === firm.id)).toBe(true)
  })

  it('prevents a second pursuit for the same firm+opportunity', async () => {
    const o = await makeOpp(firm.id, { title: 'No dup opp' })
    await makePursuit(firm.id, o.id)
    await expect(makePursuit(firm.id, o.id)).rejects.toThrow()
  })
})
