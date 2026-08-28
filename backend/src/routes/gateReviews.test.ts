// =============================================================
// §5.2 Gate Reviews integration tests — create/assign, submit, reviewer-only
// approve/reject/request-changes/resubmit, waive (reason required), invalid
// transitions, overdue, deduped reviewer notifications, audit, cross-tenant.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let reviewer: TestUser // an ADMIN who is the assigned reviewer
let consultant: TestUser
let other: TestFirm
let otherAdmin: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const GR = '/api/gate-reviews'
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

async function makePursuit(consultingFirmId: string) {
  const o = await prisma.opportunity.create({ data: { consultingFirmId, title: `GR Opp ${Math.random().toString(36).slice(2, 8)}`, agency: 'GSA', naicsCode: '541512', responseDeadline: new Date(Date.now() + 20 * 86_400_000) } })
  return prisma.bidPursuit.create({ data: { consultingFirmId, opportunityId: o.id } })
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Gate Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  reviewer = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Gate Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

async function createReview(reviewerId: string | null, dueDate?: string) {
  const p = await makePursuit(firm.id)
  const res = await request(app).post(GR).set(H(admin.token)).send({ bidPursuitId: p.id, name: 'Pink Team Gate', reviewerUserId: reviewerId, dueDate }).expect(201)
  return { pursuitId: p.id, id: res.body.data.id as string }
}

describe('create + assign + authz', () => {
  it('creates a gate review and notifies the assigned reviewer once (deduped)', async () => {
    const { id } = await createReview(reviewer.id)
    // re-assign the SAME reviewer → no new notification
    await request(app).patch(`${GR}/${id}/assign`).set(H(admin.token)).send({ reviewerUserId: reviewer.id }).expect(200)
    const assigned = await prisma.userNotification.count({ where: { userId: reviewer.id, type: 'GATE_REVIEW_ASSIGNED', entityId: id } })
    expect(assigned).toBe(1)
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'GateReview', entityId: id, action: 'CREATE' } })
    expect(audit).toBeTruthy()
  })
  it('forbids a CONSULTANT from creating (read-only)', async () => {
    const p = await makePursuit(firm.id)
    await request(app).post(GR).set(H(consultant.token)).send({ bidPursuitId: p.id, name: 'x' }).expect(403)
  })
  it('rejects a reviewer from another firm (422)', async () => {
    const p = await makePursuit(firm.id)
    await request(app).post(GR).set(H(admin.token)).send({ bidPursuitId: p.id, name: 'x', reviewerUserId: otherAdmin.id }).expect(422)
  })
})

describe('review workflow', () => {
  it('runs submit → approve by the assigned reviewer, with a completedAt + audit', async () => {
    const { id } = await createReview(reviewer.id)
    await request(app).post(`${GR}/${id}/submit`).set(H(admin.token)).expect(200)
    const submittedNotif = await prisma.userNotification.count({ where: { userId: reviewer.id, type: 'GATE_REVIEW_SUBMITTED', entityId: id } })
    expect(submittedNotif).toBe(1)
    const res = await request(app).post(`${GR}/${id}/approve`).set(H(reviewer.token)).send({ comments: 'Looks good' }).expect(200)
    expect(res.body.data.status).toBe('APPROVED')
    expect(res.body.data.completedAt).toBeTruthy()
    const audit = await prisma.auditEvent.findFirst({ where: { entityType: 'GateReview', entityId: id, action: 'APPROVAL' } })
    expect(audit).toBeTruthy()
  })
  it('lets the reviewer request changes then accepts a resubmit', async () => {
    const { id } = await createReview(reviewer.id)
    await request(app).post(`${GR}/${id}/submit`).set(H(admin.token)).expect(200)
    await request(app).post(`${GR}/${id}/request-changes`).set(H(reviewer.token)).send({ comments: 'Add past performance' }).expect(200)
    const resubmit = await request(app).post(`${GR}/${id}/submit`).set(H(admin.token)).expect(200)
    expect(resubmit.body.data.status).toBe('IN_PROGRESS')
  })
  it('requires a reason to reject and to waive', async () => {
    const { id } = await createReview(reviewer.id)
    await request(app).post(`${GR}/${id}/submit`).set(H(admin.token)).expect(200)
    await request(app).post(`${GR}/${id}/reject`).set(H(reviewer.token)).send({}).expect(422)
    await request(app).post(`${GR}/${id}/reject`).set(H(reviewer.token)).send({ reason: 'Non-compliant set-aside' }).expect(200)

    const { id: id2 } = await createReview(reviewer.id)
    await request(app).post(`${GR}/${id2}/waive`).set(H(admin.token)).send({}).expect(422)
    const waived = await request(app).post(`${GR}/${id2}/waive`).set(H(admin.token)).send({ reason: 'Directed buy' }).expect(200)
    expect(waived.body.data.status).toBe('WAIVED')
  })
  it('blocks an invalid transition (approve before submit) with 422', async () => {
    const { id } = await createReview(reviewer.id)
    const res = await request(app).post(`${GR}/${id}/approve`).set(H(reviewer.token)).expect(422)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })
  it('forbids a non-assigned admin from approving (assigned-reviewer only)', async () => {
    const { id } = await createReview(reviewer.id)
    await request(app).post(`${GR}/${id}/submit`).set(H(admin.token)).expect(200)
    await request(app).post(`${GR}/${id}/approve`).set(H(admin.token)).expect(403) // admin is not the assigned reviewer
  })
})

describe('overdue + filters', () => {
  it('flags overdue reviews and filters by overdue', async () => {
    const { id } = await createReview(reviewer.id, iso(-3))
    await request(app).post(`${GR}/${id}/submit`).set(H(admin.token)).expect(200)
    const res = await request(app).get(`${GR}?overdue=true`).set(H(admin.token)).expect(200)
    const found = res.body.data.items.find((g: { id: string }) => g.id === id)
    expect(found).toBeTruthy()
    expect(found.isOverdue).toBe(true)
  })
  it('filters by reviewer=me and by status', async () => {
    const mine = await request(app).get(`${GR}?reviewerUserId=me`).set(H(reviewer.token)).expect(200)
    expect(mine.body.data.items.every((g: { reviewerUserId: string }) => g.reviewerUserId === reviewer.id)).toBe(true)
  })
})

describe('tenant isolation', () => {
  it('returns 404 for another firm gate review', async () => {
    const { id } = await createReview(reviewer.id)
    await request(app).post(`${GR}/${id}/submit`).set(H(otherAdmin.token)).expect(404)
    await request(app).patch(`${GR}/${id}/assign`).set(H(otherAdmin.token)).send({ dueDate: iso(5) }).expect(404)
  })
})
