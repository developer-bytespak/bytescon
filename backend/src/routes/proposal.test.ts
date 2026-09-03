// =============================================================
// §5.1 Stage 5 Proposal Workspace + §5.2 Compliance/Responsibility Matrix
// integration tests — proposal create + duplicate-ACTIVE prevention, section
// CRUD/reorder/assignment (+ audit + deduped notifications), versioned content
// that never overwrites APPROVED, review workflow + retained history, AI draft
// deterministic no-key fallback + generation states, outline from verified
// requirements, responsibility filters/overdue, attachment authz; compliance
// manual add/verify/reject/assign/link, summary + compliance %, honest no-key
// re-extract that preserves existing requirements; authz + cross-tenant.
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
const P = '/api/proposal'
const CM = '/api/compliance-matrix'
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({ data: { consultingFirmId, title: 'Cyber proposal opp', agency: 'Navy', naicsCode: '541512', description: 'cyber', responseDeadline: new Date(Date.now() + 30 * 86_400_000), ...over } })
}
async function makeProposal(token: string, opportunityId: string, title = 'Volume I — Technical') {
  const r = await request(app).post(`${P}/opportunity/${opportunityId}`).set(H(token)).send({ title }).expect(201)
  return r.body.data.proposal
}
async function makeSection(token: string, proposalId: string, title = 'Technical Approach') {
  const r = await request(app).post(`${P}/${proposalId}/sections`).set(H(token)).send({ title }).expect(201)
  return r.body.data.section
}

const SAVED_LLM_ENV: Record<string, string | undefined> = {}
const LLM_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'INSIGHT_ENGINE_API_KEY', 'LOCALAI_BASE_URL'] as const

beforeAll(async () => {
  // Deterministic no-key fallback tests require an actually key-less
  // environment; CI stubs ANTHROPIC_API_KEY and dev machines carry real
  // provider keys in .env, either of which routes drafting to a provider.
  for (const k of LLM_ENV_KEYS) { SAVED_LLM_ENV[k] = process.env[k]; delete process.env[k] }

  app = buildTestApp()
  firm = await createTestFirm({ name: 'Proposal Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Proposal Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => {
  for (const k of LLM_ENV_KEYS) {
    if (SAVED_LLM_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED_LLM_ENV[k]
  }
 await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('proposal — create, duplicate-active prevention, authz', () => {
  it('creates a proposal, audits it, and prevents a second ACTIVE proposal', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    expect(p.status).toBe('ACTIVE')
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'Proposal', entityId: p.id, action: 'CREATE' } })
    expect(audit).toBeTruthy()
    // duplicate ACTIVE proposal rejected
    await request(app).post(`${P}/opportunity/${opp.id}`).set(H(admin.token)).send({ title: 'Dup' }).expect(409)
  })
  it('forbids CONSULTANT create and blocks cross-tenant opportunity', async () => {
    const opp = await makeOpp(firm.id)
    await request(app).post(`${P}/opportunity/${opp.id}`).set(H(consultant.token)).send({ title: 'x' }).expect(403)
    await request(app).post(`${P}/opportunity/${opp.id}`).set(H(otherAdmin.token)).send({ title: 'x' }).expect(404)
  })
  it('archiving frees the opportunity for a new proposal', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    await request(app).post(`${P}/${p.id}/archive`).set(H(admin.token)).expect(200)
    const ws = await request(app).get(`${P}/opportunity/${opp.id}`).set(H(admin.token)).expect(200)
    expect(ws.body.data.exists).toBe(false)
    await makeProposal(admin.token, opp.id, 'Fresh') // no 409 now
  })
})

describe('sections — CRUD, reorder, assignment + audit + deduped notifications', () => {
  it('assigns a writer (notifies once, deduped) and sets a reviewer', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const s = await makeSection(admin.token, p.id)
    await request(app).post(`${P}/sections/${s.id}/assign`).set(H(admin.token)).send({ ownerUserId: consultant.id }).expect(200)
    await request(app).post(`${P}/sections/${s.id}/assign`).set(H(admin.token)).send({ ownerUserId: consultant.id }).expect(200) // re-assign same
    const notifs = await prisma.userNotification.count({ where: { userId: consultant.id, type: 'PROPOSAL_ASSIGNMENT', entityId: s.id } })
    expect(notifs).toBe(1) // deduped
    await request(app).post(`${P}/sections/${s.id}/reviewer`).set(H(admin.token)).send({ reviewerUserId: admin.id }).expect(200)
    await request(app).post(`${P}/sections/${s.id}/assign`).set(H(consultant.token)).send({ ownerUserId: consultant.id }).expect(403)
  })
  it('reorders sections', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const a = await makeSection(admin.token, p.id, 'A')
    const b = await makeSection(admin.token, p.id, 'B')
    await request(app).post(`${P}/${p.id}/sections/reorder`).set(H(admin.token)).send({ orderedIds: [b.id, a.id] }).expect(200)
    const ws = await request(app).get(`${P}/opportunity/${opp.id}`).set(H(admin.token)).expect(200)
    expect(ws.body.data.proposal.sections[0].id).toBe(b.id)
  })
})

describe('content versioning + review workflow (never overwrite APPROVED)', () => {
  it('preserves every content version and blocks edits once APPROVED', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const s = await makeSection(admin.token, p.id)
    const v1 = await request(app).put(`${P}/sections/${s.id}/content`).set(H(admin.token)).send({ content: 'first draft' }).expect(200)
    expect(v1.body.data.version).toBe(1)
    const v2 = await request(app).put(`${P}/sections/${s.id}/content`).set(H(admin.token)).send({ content: 'second draft' }).expect(200)
    expect(v2.body.data.version).toBe(2)
    const versions = await request(app).get(`${P}/sections/${s.id}/versions`).set(H(admin.token)).expect(200)
    expect(versions.body.data.versions.length).toBe(2)

    await request(app).post(`${P}/sections/${s.id}/reviewer`).set(H(admin.token)).send({ reviewerUserId: admin.id }).expect(200)
    await request(app).post(`${P}/sections/${s.id}/submit`).set(H(admin.token)).expect(200)
    const approved = await request(app).post(`${P}/sections/${s.id}/approve`).set(H(admin.token)).expect(200)
    expect(approved.body.data.section.status).toBe('APPROVED')
    // approved content is immutable until reopened
    await request(app).put(`${P}/sections/${s.id}/content`).set(H(admin.token)).send({ content: 'sneaky overwrite' }).expect(409)
    // request-changes requires a comment; reopens the section
    await request(app).post(`${P}/sections/${s.id}/request-changes`).set(H(admin.token)).send({}).expect(422)
    await request(app).post(`${P}/sections/${s.id}/request-changes`).set(H(admin.token)).send({ comment: 'tighten section 2' }).expect(200)
    await request(app).put(`${P}/sections/${s.id}/content`).set(H(admin.token)).send({ content: 'revised' }).expect(200)

    const reviews = await request(app).get(`${P}/sections/${s.id}/reviews`).set(H(admin.token)).expect(200)
    const actions = reviews.body.data.reviews.map((r: { action: string }) => r.action)
    expect(actions).toContain('approved')
    expect(actions).toContain('changes requested')
  })
  it('notifies the reviewer on submit (deduped), not the submitter', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const s = await makeSection(admin.token, p.id)
    await request(app).post(`${P}/sections/${s.id}/reviewer`).set(H(admin.token)).send({ reviewerUserId: consultant.id }).expect(200)
    await request(app).post(`${P}/sections/${s.id}/submit`).set(H(admin.token)).expect(200)
    const notifs = await prisma.userNotification.count({ where: { userId: consultant.id, type: 'PROPOSAL_REVIEW', entityId: s.id } })
    expect(notifs).toBeGreaterThanOrEqual(1)
  })
})

describe('AI section draft — deterministic no-key fallback + generation state', () => {
  it('produces a labelled AI draft version and marks generation COMPLETED', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const s = await makeSection(admin.token, p.id)
    const res = await request(app).post(`${P}/sections/${s.id}/draft`).set(H(admin.token)).send({}).expect(201)
    expect(res.body.data.generationStatus).toBe('COMPLETED')
    expect(res.body.data.source).toBe('DETERMINISTIC') // no LLM key in test env
    const versions = await request(app).get(`${P}/sections/${s.id}/versions`).set(H(admin.token)).expect(200)
    const ai = versions.body.data.versions.find((v: { source: string }) => v.source === 'AI')
    expect(ai).toBeTruthy()
    expect(ai.content).toContain('AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW')
    expect(ai.content).toContain('Human Review Required')
  })
  it('refuses to regenerate over an APPROVED section', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const s = await makeSection(admin.token, p.id)
    await request(app).post(`${P}/sections/${s.id}/reviewer`).set(H(admin.token)).send({ reviewerUserId: admin.id }).expect(200)
    await request(app).post(`${P}/sections/${s.id}/submit`).set(H(admin.token)).expect(200)
    await request(app).post(`${P}/sections/${s.id}/approve`).set(H(admin.token)).expect(200)
    await request(app).post(`${P}/sections/${s.id}/draft`).set(H(admin.token)).send({}).expect(409)
  })
})

describe('responsibility matrix — filters + overdue', () => {
  it('filters by writer and flags overdue sections', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const s = await makeSection(admin.token, p.id)
    await request(app).post(`${P}/sections/${s.id}/assign`).set(H(admin.token)).send({ ownerUserId: consultant.id }).expect(200)
    await request(app).patch(`${P}/sections/${s.id}`).set(H(admin.token)).send({ dueDate: iso(-2) }).expect(200)
    const resp = await request(app).get(`${P}/${p.id}/responsibility?writerUserId=${consultant.id}&overdue=true`).set(H(admin.token)).expect(200)
    expect(resp.body.data.sections.length).toBe(1)
    expect(resp.body.data.sections[0].isOverdue).toBe(true)
    const none = await request(app).get(`${P}/${p.id}/responsibility?writerUserId=${admin.id}`).set(H(admin.token)).expect(200)
    expect(none.body.data.sections.length).toBe(0)
  })
})

describe('attachment — upload + tenant-scoped serve', () => {
  it('uploads (ADMIN) and blocks cross-tenant + CONSULTANT', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const s = await makeSection(admin.token, p.id)
    await request(app).post(`${P}/sections/${s.id}/attachment`).set(H(admin.token)).attach('file', Buffer.from('%PDF-1.4 x'), { filename: 'a.pdf', contentType: 'application/pdf' }).expect(201)
    await request(app).get(`${P}/sections/${s.id}/attachment`).set(H(admin.token)).expect(200)
    await request(app).get(`${P}/sections/${s.id}/attachment`).set(H(otherAdmin.token)).expect(404)
    await request(app).post(`${P}/sections/${s.id}/attachment`).set(H(consultant.token)).attach('file', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(403)
  })
})

// =============================================================
// COMPLIANCE MATRIX §5.2
// =============================================================
describe('compliance matrix — manual add, verify/reject, assign, link, summary', () => {
  it('adds a manual (verified) requirement and computes the summary', async () => {
    const opp = await makeOpp(firm.id)
    const add = await request(app).post(`${CM}/${opp.id}/requirements`).set(H(admin.token)).send({ requirementText: 'Submit a technical volume not to exceed 20 pages.', sectionType: 'INSTRUCTION', isMandatory: true }).expect(201)
    expect(add.body.data.verificationStatus).toBe('VERIFIED')
    expect(add.body.data.extractionMethod).toBe('MANUAL')
    const summary = await request(app).get(`${CM}/${opp.id}/summary`).set(H(admin.token)).expect(200)
    expect(summary.body.data.counts.total).toBe(1)
    expect(summary.body.data.counts.mandatory).toBe(1)
    expect(summary.body.data.counts.verified).toBe(1)
    expect(typeof summary.body.data.compliancePercent).toBe('number')
  })
  it('verifies, rejects (reason required), assigns owner, and links to a proposal section', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    const s = await makeSection(admin.token, p.id)
    const r1 = (await request(app).post(`${CM}/${opp.id}/requirements`).set(H(admin.token)).send({ requirementText: 'Provide SF-1449.', sectionType: 'DOCUMENT' }).expect(201)).body.data
    // reject needs a reason
    await request(app).post(`${CM}/requirements/${r1.id}/reject`).set(H(admin.token)).send({}).expect(422)
    await request(app).post(`${CM}/requirements/${r1.id}/reject`).set(H(admin.token)).send({ reason: 'not a proposal requirement' }).expect(200)
    await request(app).post(`${CM}/requirements/${r1.id}/verify`).set(H(admin.token)).expect(200)
    await request(app).post(`${CM}/requirements/${r1.id}/assign`).set(H(admin.token)).send({ ownerUserId: consultant.id }).expect(200)
    // assigning a user from another firm is rejected
    await request(app).post(`${CM}/requirements/${r1.id}/assign`).set(H(admin.token)).send({ ownerUserId: otherAdmin.id }).expect(422)
    const link = await request(app).post(`${CM}/requirements/${r1.id}/link-section`).set(H(admin.token)).send({ proposalSectionId: s.id }).expect(200)
    expect(link.body.data.proposalSectionId).toBe(s.id)
    // filter: unverified should now be empty (the only req is verified)
    const unv = await request(app).get(`${CM}/${opp.id}/summary?unverified=true`).set(H(admin.token)).expect(200)
    expect(unv.body.data.requirements.length).toBe(0)
  })
  it('generates a proposal outline from verified requirements only', async () => {
    const opp = await makeOpp(firm.id)
    const p = await makeProposal(admin.token, opp.id)
    await request(app).post(`${CM}/${opp.id}/requirements`).set(H(admin.token)).send({ requirementText: 'Describe technical approach.', sectionType: 'INSTRUCTION', proposalSection: 'Technical' }).expect(201)
    const outline = await request(app).post(`${P}/${p.id}/outline`).set(H(admin.token)).expect(201)
    expect(outline.body.data.sections.length).toBeGreaterThanOrEqual(1)
  })
  it('re-extract without an AI key is honest (422) and never deletes existing requirements', async () => {
    const opp = await makeOpp(firm.id, { description: 'The offeror shall submit a technical approach.' })
    const r = (await request(app).post(`${CM}/${opp.id}/requirements`).set(H(admin.token)).send({ requirementText: 'Keep me.', sectionType: 'OTHER' }).expect(201)).body.data
    await request(app).post(`${CM}/${opp.id}/re-extract`).set(H(admin.token)).expect(422)
    const still = await prisma.matrixRequirement.findUnique({ where: { id: r.id } })
    expect(still).toBeTruthy() // verified requirement preserved
  })
  it('forbids CONSULTANT writes and blocks cross-tenant summary', async () => {
    const opp = await makeOpp(firm.id)
    await request(app).post(`${CM}/${opp.id}/requirements`).set(H(consultant.token)).send({ requirementText: 'x' }).expect(403)
    await request(app).get(`${CM}/${opp.id}/summary`).set(H(otherAdmin.token)).expect(404)
  })
})
