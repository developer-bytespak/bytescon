// =============================================================
// Approving an outreach draft means someone reviewed it, so the server requires
// every checklist item to come back confirmed. The screen enforcing this alone
// could be bypassed by calling the API directly.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let other: TestFirm
let admin: TestUser
let otherAdmin: TestUser
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const CHECKLIST = ['Verify the award figure', 'Confirm the recipient']

async function makeDraft(firmId: string) {
  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firmId, samNoticeId: `scw-approve-${Date.now()}-${Math.random()}`, title: 'Outreach', agency: 'DoD',
      naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * 86_400_000), status: 'ACTIVE',
    },
  })
  return prisma.scwOutreachDraft.create({
    data: {
      consultingFirmId: firmId, opportunityId: opp.id, primeName: 'Prime Co', outreachType: 'cold_first_touch',
      subject: 'Teaming', body: 'Hello', factsCited: [], reviewChecklist: CHECKLIST,
    },
  })
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'SCW Approve Firm' })
  other = await createTestFirm({ name: 'SCW Approve Other Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await prisma.scwOutreachDraft.deleteMany({ where: { consultingFirmId: { in: [firm.id, other.id] } } })
  await cleanupFirm(firm.id)
  await cleanupFirm(other.id)
  await disconnectDb()
})

const approve = (id: string, token: string, body: object = {}) =>
  request(app).patch(`/api/scw/outreach/drafts/${id}/approve`).set(auth(token)).send(body)

describe('PATCH /api/scw/outreach/drafts/:id/approve', () => {
  it('refuses when nothing was confirmed, and leaves the draft unapproved', async () => {
    const draft = await makeDraft(firm.id)
    const res = await approve(draft.id, admin.token)
    expect(res.status).toBe(422)
    expect(res.body.error).toContain('Verify the award figure')
    expect((await prisma.scwOutreachDraft.findUniqueOrThrow({ where: { id: draft.id } })).humanApprovedAt).toBeNull()
  })

  it('refuses when an item is missing', async () => {
    const draft = await makeDraft(firm.id)
    const res = await approve(draft.id, admin.token, { acknowledgedChecklist: [CHECKLIST[0]] })
    expect(res.status).toBe(422)
    expect(res.body.error).toContain(CHECKLIST[1])
    expect(res.body.error).not.toContain(CHECKLIST[0])
  })

  it('approves once every item is confirmed', async () => {
    const draft = await makeDraft(firm.id)
    const res = await approve(draft.id, admin.token, { acknowledgedChecklist: CHECKLIST })
    expect(res.status).toBe(200)
    expect(res.body.data.requiresHumanReview).toBe(false)
    expect(res.body.data.humanApprovedById).toBe(admin.id)
  })

  it('does not rewrite who approved a draft already approved', async () => {
    const draft = await makeDraft(firm.id)
    const firstApprover = await createTestUser(firm.id, { role: 'ADMIN' })
    const first = await approve(draft.id, firstApprover.token, { acknowledgedChecklist: CHECKLIST })
    const second = await approve(draft.id, admin.token, { acknowledgedChecklist: CHECKLIST })
    expect(second.status).toBe(200)
    expect(second.body.data.humanApprovedById).toBe(firstApprover.id)
    expect(second.body.data.humanApprovedAt).toBe(first.body.data.humanApprovedAt)
  })

  it('cannot reach another firm’s draft', async () => {
    const draft = await makeDraft(firm.id)
    const res = await approve(draft.id, otherAdmin.token, { acknowledgedChecklist: CHECKLIST })
    expect(res.status).toBe(404)
  })
})
