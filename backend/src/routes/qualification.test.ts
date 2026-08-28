// =============================================================
// §5.2 Bid Qualification integration tests — criterion config + weight
// validation, scorecard scoring, deterministic recommendation, decision
// workflow (BID/NO_BID/override/reassess), pipeline sync, history, audit,
// notifications, authz + cross-tenant isolation. Controlled offsets for dates.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let admin2: TestUser
let consultant: TestUser
let other: TestFirm
let otherAdmin: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const QUAL = '/api/qualification'

async function makePursuit(consultingFirmId: string, stage = 'IDENTIFIED', ownerUserId: string | null = null) {
  const o = await prisma.opportunity.create({ data: { consultingFirmId, title: `Qual Opp ${Math.random().toString(36).slice(2, 8)}`, agency: 'GSA', naicsCode: '541512', responseDeadline: new Date(Date.now() + 20 * 86_400_000) } })
  return prisma.bidPursuit.create({ data: { consultingFirmId, opportunityId: o.id, pipelineStage: stage as never, ownerUserId } })
}

// Start the scorecard and score every criterion so the card is "complete".
async function startAndScoreAll(pursuitId: string, token: string, score = 80) {
  await request(app).post(`${QUAL}/${pursuitId}/start`).set(H(token)).expect(201)
  const sc = await request(app).get(`${QUAL}/${pursuitId}`).set(H(token)).expect(200)
  for (const c of sc.body.data.scorecard.criteria) {
    await request(app).patch(`${QUAL}/${pursuitId}/criteria/${c.key}`).set(H(token)).send({ score }).expect(200)
  }
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Qual Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  admin2 = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Qual Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('criterion config + weight validation', () => {
  it('seeds default criteria totalling exactly 100 on first read', async () => {
    const res = await request(app).get(`${QUAL}/criteria/config`).set(H(admin.token)).expect(200)
    expect(res.body.data.totalWeight).toBe(100)
    expect(res.body.data.criteria.length).toBeGreaterThanOrEqual(5)
  })
  it('accepts a valid reconfiguration (weights total 100)', async () => {
    const res = await request(app).put(`${QUAL}/criteria/config`).set(H(admin.token)).send({ criteria: [
      { key: 'fit', name: 'Fit', weight: 60, required: true }, { key: 'risk', name: 'Risk', weight: 40, required: false },
    ] }).expect(200)
    expect(res.body.data.criteria.reduce((s: number, c: { weight: number }) => s + c.weight, 0)).toBe(100)
    // restore defaults for later tests
    await request(app).put(`${QUAL}/criteria/config`).set(H(admin.token)).send({ criteria: [
      { key: 'capability_fit', name: 'Capability fit', weight: 40, required: true },
      { key: 'competition', name: 'Competition', weight: 30, required: true },
      { key: 'eligibility', name: 'Eligibility', weight: 30, required: true },
    ] }).expect(200)
  })
  it('rejects invalid totals, negatives, and duplicate keys', async () => {
    await request(app).put(`${QUAL}/criteria/config`).set(H(admin.token)).send({ criteria: [{ key: 'a', name: 'A', weight: 60 }, { key: 'b', name: 'B', weight: 30 }] }).expect(422)
    await request(app).put(`${QUAL}/criteria/config`).set(H(admin.token)).send({ criteria: [{ key: 'a', name: 'A', weight: -5 }, { key: 'b', name: 'B', weight: 105 }] }).expect(422)
    await request(app).put(`${QUAL}/criteria/config`).set(H(admin.token)).send({ criteria: [{ key: 'a', name: 'A', weight: 50 }, { key: 'a', name: 'B', weight: 50 }] }).expect(422)
  })
  it('forbids a CONSULTANT from reconfiguring (read-only)', async () => {
    await request(app).put(`${QUAL}/criteria/config`).set(H(consultant.token)).send({ criteria: [{ key: 'a', name: 'A', weight: 100 }] }).expect(403)
  })
})

describe('scorecard scoring + recommendation', () => {
  it('starts qualification, advancing pipeline IDENTIFIED → QUALIFICATION', async () => {
    const p = await makePursuit(firm.id, 'IDENTIFIED')
    await request(app).post(`${QUAL}/${p.id}/start`).set(H(admin.token)).expect(201)
    const pursuit = await prisma.bidPursuit.findUnique({ where: { id: p.id } })
    expect(pursuit?.pipelineStage).toBe('QUALIFICATION')
  })
  it('validates scores and computes a deterministic weighted total', async () => {
    const p = await makePursuit(firm.id)
    await request(app).post(`${QUAL}/${p.id}/start`).set(H(admin.token)).expect(201)
    await request(app).patch(`${QUAL}/${p.id}/criteria/capability_fit`).set(H(admin.token)).send({ score: 150 }).expect(422)
    const r1 = await request(app).patch(`${QUAL}/${p.id}/criteria/capability_fit`).set(H(admin.token)).send({ score: 80, evidence: 'strong past work' }).expect(200)
    expect(r1.body.data.computed.recommendation).toBe('REVIEW_REQUIRED') // required criteria still unscored
    const r2 = await request(app).get(`${QUAL}/${p.id}`).set(H(admin.token)).expect(200)
    const r3 = await request(app).get(`${QUAL}/${p.id}`).set(H(admin.token)).expect(200)
    expect(r2.body.data.computed.totalScore).toBe(r3.body.data.computed.totalScore) // deterministic
  })
  it('recommends BID when all required criteria score high', async () => {
    const p = await makePursuit(firm.id)
    await startAndScoreAll(p.id, admin.token, 85)
    const res = await request(app).get(`${QUAL}/${p.id}`).set(H(admin.token)).expect(200)
    expect(res.body.data.computed.complete).toBe(true)
    expect(res.body.data.computed.recommendation).toBe('BID')
  })
  it('forbids a CONSULTANT from scoring but allows reading', async () => {
    const p = await makePursuit(firm.id)
    await request(app).post(`${QUAL}/${p.id}/start`).set(H(admin.token)).expect(201)
    await request(app).get(`${QUAL}/${p.id}`).set(H(consultant.token)).expect(200)
    await request(app).patch(`${QUAL}/${p.id}/criteria/capability_fit`).set(H(consultant.token)).send({ score: 50 }).expect(403)
  })
})

describe('decision workflow + pipeline sync + override', () => {
  it('records a BID decision and advances the pipeline to CAPTURE, writing history + audit', async () => {
    const p = await makePursuit(firm.id)
    await startAndScoreAll(p.id, admin.token, 85) // → BID recommendation
    const res = await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'BID' }).expect(200)
    expect(res.body.data.scorecard.status).toBe('BID')
    expect(res.body.data.scorecard.isOverride).toBe(false)
    const pursuit = await prisma.bidPursuit.findUnique({ where: { id: p.id } })
    expect(pursuit?.pipelineStage).toBe('CAPTURE')
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'Scorecard', entityId: res.body.data.scorecard.id, action: 'APPROVAL' } })
    expect(audit).toBeTruthy()
    const hist = await request(app).get(`${QUAL}/${p.id}/history`).set(H(admin.token)).expect(200)
    expect(hist.body.data.total).toBeGreaterThanOrEqual(2) // start + decision
  })
  it('requires an override reason when the decision differs from the recommendation', async () => {
    const p = await makePursuit(firm.id)
    await startAndScoreAll(p.id, admin.token, 85) // recommends BID
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'NO_BID' }).expect(422) // override, no reason
    const ok = await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'NO_BID', overrideReason: 'Leadership pulled resourcing' }).expect(200)
    expect(ok.body.data.scorecard.isOverride).toBe(true)
    expect(ok.body.data.scorecard.overrideReason).toMatch(/resourcing/i)
    const pursuit = await prisma.bidPursuit.findUnique({ where: { id: p.id } })
    expect(pursuit?.pipelineStage).toBe('NO_BID')
  })
  it('rejects whitespace-only override reasons', async () => {
    const p = await makePursuit(firm.id)
    await startAndScoreAll(p.id, admin.token, 85)
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'DEFERRED', overrideReason: '   ' }).expect(422)
  })
  it('blocks deciding before required criteria are complete', async () => {
    const p = await makePursuit(firm.id)
    await request(app).post(`${QUAL}/${p.id}/start`).set(H(admin.token)).expect(201)
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'BID' }).expect(422)
  })
  it('prevents a duplicate final decision (409) until reassessed, retaining history', async () => {
    const p = await makePursuit(firm.id)
    await startAndScoreAll(p.id, admin.token, 85)
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'BID' }).expect(200)
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'BID' }).expect(409)
    await request(app).post(`${QUAL}/${p.id}/reassess`).set(H(admin.token)).send({ reason: 'new info' }).expect(200)
    const hist = await request(app).get(`${QUAL}/${p.id}/history`).set(H(admin.token)).expect(200)
    expect(hist.body.data.total).toBeGreaterThanOrEqual(3) // start + decision + reassess
    // reassessment lets a new decision be recorded
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'BID' }).expect(200)
  })
  it('will not decide a pursuit already SUBMITTED/AWARDED (409)', async () => {
    const p = await makePursuit(firm.id, 'SUBMITTED')
    await request(app).post(`${QUAL}/${p.id}/start`).set(H(admin.token)).expect(201)
    // score all then attempt decision
    const sc = await request(app).get(`${QUAL}/${p.id}`).set(H(admin.token)).expect(200)
    for (const c of sc.body.data.scorecard.criteria) await request(app).patch(`${QUAL}/${p.id}/criteria/${c.key}`).set(H(admin.token)).send({ score: 80 }).expect(200)
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(admin.token)).send({ decision: 'NO_BID', overrideReason: 'x' }).expect(409)
  })
  it('forbids a CONSULTANT from deciding (unauthorized override path)', async () => {
    const p = await makePursuit(firm.id)
    await startAndScoreAll(p.id, admin.token, 85)
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(consultant.token)).send({ decision: 'BID' }).expect(403)
  })
})

describe('review submission + notifications', () => {
  it('submits for review, assigns a reviewer, and notifies them once (deduped)', async () => {
    const p = await makePursuit(firm.id)
    await startAndScoreAll(p.id, admin.token, 80)
    await request(app).post(`${QUAL}/${p.id}/submit-review`).set(H(admin.token)).send({ reviewerUserId: admin2.id }).expect(200)
    // resubmit (idempotent notify)
    await request(app).post(`${QUAL}/${p.id}/submit-review`).set(H(admin.token)).send({ reviewerUserId: admin2.id }).expect(200)
    const notifs = await request(app).get('/api/notifications').set(H(admin2.token)).expect(200)
    const forThis = notifs.body.data.items.filter((n: { entityType: string; title: string }) => n.entityType === 'Scorecard' && /submitted for your review/i.test(n.title))
    expect(forThis.length).toBe(1) // deduped
  })
  it('blocks submit-review while required criteria are incomplete', async () => {
    const p = await makePursuit(firm.id)
    await request(app).post(`${QUAL}/${p.id}/start`).set(H(admin.token)).expect(201)
    await request(app).post(`${QUAL}/${p.id}/submit-review`).set(H(admin.token)).send({}).expect(422)
  })
})

describe('tenant isolation', () => {
  it('returns 404 for another firm scorecard / decision (no leak)', async () => {
    const p = await makePursuit(firm.id)
    await startAndScoreAll(p.id, admin.token, 85)
    await request(app).get(`${QUAL}/${p.id}`).set(H(otherAdmin.token)).expect(404)
    await request(app).post(`${QUAL}/${p.id}/decision`).set(H(otherAdmin.token)).send({ decision: 'BID' }).expect(404)
    await request(app).post(`${QUAL}/${p.id}/start`).set(H(otherAdmin.token)).expect(404)
  })
})
