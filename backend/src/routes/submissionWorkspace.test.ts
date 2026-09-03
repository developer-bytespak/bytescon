// =============================================================
// §5.1 Stage 7 Submission integration — create + duplicate prevention, checklist
// generation from verified requirements + dedupe + preserve manual items,
// readiness (completion vs readiness, mandatory + blocker gating), document
// validation, mark-ready override, submit dedupe + confirmation, status history,
// reminders dedupe, audit, authz + cross-tenant.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let other: TestFirm
let otherAdmin: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const B = '/api/submission'

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({ data: { consultingFirmId, title: 'Submission opp', agency: 'GSA', naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * 86_400_000), ...over } })
}
async function makeVerifiedRequirement(firmId: string, opportunityId: string) {
  const matrix = await prisma.complianceMatrix.upsert({ where: { opportunityId }, update: {}, create: { opportunityId, consultingFirmId: firmId } })
  return prisma.matrixRequirement.create({ data: { matrixId: matrix.id, section: 'L.1', sectionType: 'DOCUMENT', requirementText: 'Submit SF-33.', isMandatory: true, verificationStatus: 'VERIFIED' } })
}
async function makeSubmission(token: string, opportunityId: string) {
  return (await request(app).post(`${B}/opportunity/${opportunityId}`).set(H(token)).send({ title: 'Final Submission', finalDeadline: new Date(Date.now() + 5 * 86_400_000).toISOString() }).expect(201)).body.data.submission
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Submission Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Submission Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('submission — create, dup prevention, authz', () => {
  it('creates a submission, audits it, and prevents a duplicate active one', async () => {
    const opp = await makeOpp(firm.id)
    const s = await makeSubmission(admin.token, opp.id)
    expect(s.status).toBe('NOT_STARTED')
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'ProposalSubmission', entityId: s.id, action: 'CREATE' } })
    expect(audit).toBeTruthy()
    await request(app).post(`${B}/opportunity/${opp.id}`).set(H(admin.token)).send({ title: 'Dup' }).expect(409)
  })
  it('forbids CONSULTANT create and blocks cross-tenant', async () => {
    const opp = await makeOpp(firm.id)
    await request(app).post(`${B}/opportunity/${opp.id}`).set(H(consultant.token)).send({ title: 'x' }).expect(403)
    await request(app).post(`${B}/opportunity/${opp.id}`).set(H(otherAdmin.token)).send({ title: 'x' }).expect(404)
  })
})

describe('checklist generation — from verified requirements, deduped, preserves manual', () => {
  it('generates from verified requirements + proposal sections and does not duplicate on re-run', async () => {
    const opp = await makeOpp(firm.id)
    await makeVerifiedRequirement(firm.id, opp.id)
    await prisma.proposalSection.create({ data: { consultingFirmId: firm.id, opportunityId: opp.id, title: 'Technical Volume', status: 'DRAFTING' } })
    const s = await makeSubmission(admin.token, opp.id)
    const gen1 = await request(app).post(`${B}/${s.id}/generate-checklist`).set(H(admin.token)).expect(201)
    expect(gen1.body.data.added).toBeGreaterThanOrEqual(2)
    // manual item preserved across regeneration
    await request(app).post(`${B}/${s.id}/items`).set(H(admin.token)).send({ title: 'Manual signature page', itemType: 'SIGNATURE', isMandatory: true }).expect(201)
    const gen2 = await request(app).post(`${B}/${s.id}/generate-checklist`).set(H(admin.token)).expect(201)
    expect(gen2.body.data.added).toBe(0) // nothing duplicated
    const detail = await request(app).get(`${B}/${s.id}`).set(H(admin.token)).expect(200)
    expect(detail.body.data.submission.items.some((i: { title: string }) => i.title === 'Manual signature page')).toBe(true)
  })
})

describe('readiness — completion vs readiness, mandatory + blocker gating', () => {
  it('cannot mark ready with an incomplete mandatory item or an unresolved blocker; override works', async () => {
    const opp = await makeOpp(firm.id)
    const s = await makeSubmission(admin.token, opp.id)
    const item = (await request(app).post(`${B}/${s.id}/items`).set(H(admin.token)).send({ title: 'Cover letter', itemType: 'DOCUMENT', isMandatory: true }).expect(201)).body.data.item
    // incomplete mandatory → not ready
    await request(app).post(`${B}/${s.id}/mark-ready`).set(H(admin.token)).send({}).expect(409)
    // complete it → ready
    await request(app).patch(`${B}/items/${item.id}`).set(H(admin.token)).send({ status: 'COMPLETE' }).expect(200)
    const ready = await request(app).get(`${B}/${s.id}/readiness`).set(H(admin.token)).expect(200)
    expect(ready.body.data.readiness.canBeReady).toBe(true)
    expect(ready.body.data.readiness.overallPercent).toBe(100)
    // add a blocker → not ready again
    await request(app).post(`${B}/items/${item.id}/block`).set(H(admin.token)).send({ reason: 'awaiting signature' }).expect(200)
    const blocked = await request(app).get(`${B}/${s.id}/readiness`).set(H(admin.token)).expect(200)
    expect(blocked.body.data.readiness.canBeReady).toBe(false)
    // override forces READY_TO_SUBMIT (reason recorded)
    const forced = await request(app).post(`${B}/${s.id}/mark-ready`).set(H(admin.token)).send({ overrideReason: 'Leadership approved forcing readiness for demo' }).expect(200)
    expect(forced.body.data.submission.status).toBe('READY_TO_SUBMIT')
    expect(forced.body.data.submission.overrideReason).toBe('Leadership approved forcing readiness for demo')
  })
})

describe('document validation', () => {
  it('fails a required document with no attachment and passes once attached', async () => {
    const opp = await makeOpp(firm.id)
    const s = await makeSubmission(admin.token, opp.id)
    const item = (await request(app).post(`${B}/${s.id}/items`).set(H(admin.token)).send({ title: 'Vol I', itemType: 'DOCUMENT', isMandatory: true }).expect(201)).body.data.item
    const v1 = await request(app).post(`${B}/items/${item.id}/validate`).set(H(admin.token)).send({}).expect(200)
    expect(v1.body.data.item.validationState).toBe('FAILED')
    await request(app).post(`${B}/items/${item.id}/attachment`).set(H(admin.token)).attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'vol1.pdf', contentType: 'application/pdf' }).expect(201)
    const v2 = await request(app).post(`${B}/items/${item.id}/validate`).set(H(admin.token)).send({ expectedExtensions: ['pdf'] }).expect(200)
    expect(v2.body.data.item.validationState).toBe('PASSED')
    expect(v2.body.data.item.status).toBe('VALIDATED')
  })
})

describe('submit + confirmation + history + reminders', () => {
  it('records submission (no duplicate), confirmation, retains history, and dispatches deduped reminders', async () => {
    const opp = await makeOpp(firm.id)
    const s = await makeSubmission(admin.token, opp.id)
    // assign owner so reminders have a target
    await request(app).patch(`${B}/${s.id}`).set(H(admin.token)).send({ ownerUserId: admin.id, internalDeadline: new Date(Date.now() + 86_400_000).toISOString() }).expect(200)
    const sub = await request(app).post(`${B}/${s.id}/submit`).set(H(admin.token)).send({ submissionMethod: 'EMAIL', confirmationReference: 'REF-1', overrideReason: 'Client accepts submitting without checklist items' }).expect(200)
    expect(sub.body.data.submission.status).toBe('SUBMITTED')
    // duplicate submit blocked
    await request(app).post(`${B}/${s.id}/submit`).set(H(admin.token)).send({}).expect(409)
    // confirm with evidence
    const conf = await request(app).post(`${B}/${s.id}/confirm`).set(H(admin.token)).attach('file', Buffer.from('%PDF-1.4 receipt'), { filename: 'receipt.pdf', contentType: 'application/pdf' }).field('confirmationReference', 'REF-1').expect(200)
    expect(conf.body.data.submission.status).toBe('CONFIRMED')
    const hist = await request(app).get(`${B}/${s.id}/history`).set(H(admin.token)).expect(200)
    const actions = hist.body.data.history.map((h: { action: string }) => h.action)
    expect(actions).toContain('submitted')
    expect(actions).toContain('confirmed')
    // reminders suppressed once CONFIRMED
    const rem = await request(app).post(`${B}/${s.id}/reminders/dispatch`).set(H(admin.token)).expect(200)
    expect(rem.body.data.suppressed).toBe(true)
  })
  it('dispatches deadline reminders once (deduped) for an active submission', async () => {
    const opp = await makeOpp(firm.id)
    const s = await makeSubmission(admin.token, opp.id)
    await request(app).patch(`${B}/${s.id}`).set(H(admin.token)).send({ ownerUserId: admin.id, internalDeadline: new Date(Date.now() + 86_400_000).toISOString() }).expect(200)
    await request(app).post(`${B}/${s.id}/reminders/dispatch`).set(H(admin.token)).expect(200)
    await request(app).post(`${B}/${s.id}/reminders/dispatch`).set(H(admin.token)).expect(200) // re-run
    const count = await prisma.userNotification.count({ where: { userId: admin.id, type: 'SUBMISSION_REMINDER', entityId: s.id } })
    expect(count).toBeGreaterThanOrEqual(1)
    // deduped: the internal-approaching reminder for the same day is not duplicated
    const internal = await prisma.userNotification.count({ where: { userId: admin.id, entityId: s.id, dedupeKey: { contains: 'internal-approaching' } } })
    expect(internal).toBe(1)
  })
})

describe('cross-tenant isolation', () => {
  it('blocks cross-tenant submission access', async () => {
    const opp = await makeOpp(firm.id)
    const s = await makeSubmission(admin.token, opp.id)
    await request(app).get(`${B}/${s.id}`).set(H(otherAdmin.token)).expect(404)
  })
})
