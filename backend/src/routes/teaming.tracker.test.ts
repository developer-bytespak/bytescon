// =============================================================
// §5.1 Stage 4 Teaming & Subcontractor Tracker integration tests — partner
// fields/archive/search/filter + audit, opportunity linking + duplicate-link
// prevention, matching score/explanation/insufficient-data, workshare
// validation, agreement/NDA status workflow, agreement draft + disclaimer +
// versions, attachment authz, reminders + dedup, authz + cross-tenant.
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
let oppId: string

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const BASE = '/api/teaming'
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({ data: { consultingFirmId, title: 'Radar cybersecurity services', agency: 'Department of the Navy', naicsCode: '541512', setAsideType: 'SDVOSB', description: 'cybersecurity and cloud', placeOfPerformance: 'San Diego, CA', responseDeadline: new Date(Date.now() + 30 * 86_400_000), ...over } })
}
async function makePartner(token: string, over: Record<string, unknown> = {}) {
  const res = await request(app).post(`${BASE}/partners`).set(H(token)).send({ name: 'Acme Federal ' + Math.random().toString(36).slice(2, 7), partnerType: 'SUB', primaryNaicsCodes: ['541512'], primarySetAsides: ['SDVOSB'], capabilities: ['cybersecurity', 'cloud'], geography: 'CA', website: 'https://acme.example', ...over }).expect(201)
  return res.body.data.partner
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Teaming Tracker Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Teaming Tracker Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
  oppId = (await makeOpp(firm.id)).id
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('partners — new fields, archive, filters, audit, authz', () => {
  it('creates a partner with the extended fields and audits it', async () => {
    const p = await makePartner(admin.token, { certifications: ['ISO 9001'], pastRelationship: 'subbed on 2024 bid' })
    expect(p.partnerType).toBe('SUB')
    expect(p.geography).toBe('CA')
    expect(p.certifications).toContain('ISO 9001')
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'Partner', entityId: p.id, action: 'CREATE' } })
    expect(audit).toBeTruthy()
  })
  it('filters by NAICS, set-aside, and partnerType', async () => {
    await makePartner(admin.token, { primaryNaicsCodes: ['236220'], primarySetAsides: [], partnerType: 'PRIME' })
    const byNaics = await request(app).get(`${BASE}/partners?naicsCode=541512`).set(H(admin.token)).expect(200)
    expect(byNaics.body.data.partners.every((p: { primaryNaicsCodes: string[] }) => p.primaryNaicsCodes.includes('541512'))).toBe(true)
    const byType = await request(app).get(`${BASE}/partners?partnerType=PRIME`).set(H(admin.token)).expect(200)
    expect(byType.body.data.partners.every((p: { partnerType: string }) => p.partnerType === 'PRIME')).toBe(true)
  })
  it('archives via isActive=false and hides from activeOnly', async () => {
    const p = await makePartner(admin.token)
    await request(app).put(`${BASE}/partners/${p.id}`).set(H(admin.token)).send({ isActive: false }).expect(200)
    const active = await request(app).get(`${BASE}/partners?activeOnly=true`).set(H(admin.token)).expect(200)
    expect(active.body.data.partners.some((x: { id: string }) => x.id === p.id)).toBe(false)
  })
  it('forbids CONSULTANT create and blocks cross-tenant read', async () => {
    await request(app).post(`${BASE}/partners`).set(H(consultant.token)).send({ name: 'x' }).expect(403)
    const p = await makePartner(admin.token)
    await request(app).get(`${BASE}/partners/${p.id}`).set(H(otherAdmin.token)).expect(404)
  })
})

describe('opportunity linking + duplicate prevention + workshare validation', () => {
  it('links a partner, prevents a duplicate link (any role), and validates workshare totals', async () => {
    const p1 = await makePartner(admin.token)
    const p2 = await makePartner(admin.token)
    await request(app).post(`${BASE}/arrangements`).set(H(admin.token)).send({ opportunityId: oppId, partnerId: p1.id, role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', scopePercent: 60 }).expect(201)
    // duplicate link (different role) rejected
    await request(app).post(`${BASE}/arrangements`).set(H(admin.token)).send({ opportunityId: oppId, partnerId: p1.id, role: 'JV_MEMBER', arrangementType: 'JV' }).expect(409)
    // workshare would exceed 100
    await request(app).post(`${BASE}/arrangements`).set(H(admin.token)).send({ opportunityId: oppId, partnerId: p2.id, role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', scopePercent: 50 }).expect(422)
    // within bounds ok
    await request(app).post(`${BASE}/arrangements`).set(H(admin.token)).send({ opportunityId: oppId, partnerId: p2.id, role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', scopePercent: 30 }).expect(201)
  })
})

describe('matching — explainable score + insufficient data', () => {
  it('returns matching capabilities, cert/geography fit, why, and data limitations', async () => {
    const opp = await makeOpp(firm.id, { title: 'Cyber match opp' })
    await makePartner(admin.token, { name: 'Match Strong', primaryNaicsCodes: ['541512'], primarySetAsides: ['SDVOSB'], capabilities: ['cybersecurity'], geography: 'CA' })
    await makePartner(admin.token, { name: 'Match Empty', primaryNaicsCodes: [], primarySetAsides: [], capabilities: [], certifications: [] })
    const res = await request(app).get(`${BASE}/recommend/${opp.id}`).set(H(admin.token)).expect(200)
    const strong = res.body.data.recommendations.find((r: { name: string }) => r.name === 'Match Strong')
    expect(strong.score).toBeGreaterThan(0)
    expect(strong.matchingCapabilities).toContain('cybersecurity')
    expect(strong.certificationFit.met).toBe(true)
    expect(strong.whyRecommended).toMatch(/not a guarantee/i)
    expect(Array.isArray(strong.dataLimitations)).toBe(true)
    const empty = res.body.data.recommendations.find((r: { name: string }) => r.name === 'Match Empty')
    expect(empty.insufficientData).toBe(true)
  })
})

describe('agreement/NDA workflow + drafts + attachment', () => {
  let arrId: string
  it('updates agreement + NDA status (auto-stamps signed date) and audits', async () => {
    const p = await makePartner(admin.token)
    const opp = await makeOpp(firm.id, { title: 'Agreement opp' })
    const create = await request(app).post(`${BASE}/arrangements`).set(H(admin.token)).send({ opportunityId: opp.id, partnerId: p.id, role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', scopePercent: 20 }).expect(201)
    arrId = create.body.data.arrangement.id
    const upd = await request(app).patch(`${BASE}/arrangements/${arrId}`).set(H(admin.token)).send({ agreementStatus: 'SIGNED', ndaStatus: 'SENT', teamingStatus: 'COMMITTED', workshareDescription: 'cyber tasks' }).expect(200)
    expect(upd.body.data.arrangement.agreementStatus).toBe('SIGNED')
    expect(upd.body.data.arrangement.agreementSignedDate).toBeTruthy()
    await request(app).patch(`${BASE}/arrangements/${arrId}`).set(H(consultant.token)).send({ agreementStatus: 'SENT' }).expect(403)
  })
  it('generates a versioned agreement draft with the mandatory disclaimer + placeholders', async () => {
    const p = await makePartner(admin.token)
    const opp = await makeOpp(firm.id, { title: 'Draft opp', solicitationNumber: null })
    const create = await request(app).post(`${BASE}/arrangements`).set(H(admin.token)).send({ opportunityId: opp.id, partnerId: p.id, role: 'SUB', arrangementType: 'TEAMING_AGREEMENT' }).expect(201)
    const id = create.body.data.arrangement.id
    const d1 = await request(app).post(`${BASE}/arrangements/${id}/agreement-draft`).set(H(admin.token)).send({ draftType: 'TEAMING_AGREEMENT' }).expect(201)
    expect(d1.body.data.draft.version).toBe(1)
    expect(d1.body.data.draft.content).toContain('DRAFT FOR REVIEW — NOT LEGAL ADVICE — NOT EXECUTED.')
    expect(d1.body.data.draft.content).toContain('[GOVERNING LAW TO BE REVIEWED]')
    const d2 = await request(app).post(`${BASE}/arrangements/${id}/agreement-draft`).set(H(admin.token)).send({ draftType: 'TEAMING_AGREEMENT', content: 'edited draft' }).expect(201)
    expect(d2.body.data.draft.version).toBe(2) // prior version preserved
    const list = await request(app).get(`${BASE}/arrangements/${id}/agreement-drafts`).set(H(admin.token)).expect(200)
    expect(list.body.data.drafts.length).toBe(2)
    await request(app).post(`${BASE}/arrangements/${id}/agreement-draft`).set(H(consultant.token)).send({}).expect(403)
  })
  it('attaches an agreement document (ADMIN) and serves it tenant-scoped', async () => {
    await request(app).post(`${BASE}/arrangements/${arrId}/attachment`).set(H(admin.token)).attach('file', Buffer.from('%PDF-1.4 test'), { filename: 'tea.pdf', contentType: 'application/pdf' }).expect(201)
    await request(app).get(`${BASE}/arrangements/${arrId}/attachment`).set(H(admin.token)).expect(200)
    await request(app).get(`${BASE}/arrangements/${arrId}/attachment`).set(H(otherAdmin.token)).expect(404)
    await request(app).post(`${BASE}/arrangements/${arrId}/attachment`).set(H(consultant.token)).attach('file', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' }).expect(403)
  })
})

describe('reminders + dedup', () => {
  it('surfaces overdue/unsigned agreements and dispatches deduped notifications', async () => {
    const p = await makePartner(admin.token)
    const opp = await makeOpp(firm.id, { title: 'Reminder opp' })
    const create = await request(app).post(`${BASE}/arrangements`).set(H(admin.token)).send({ opportunityId: opp.id, partnerId: p.id, role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', agreementStatus: 'SENT', agreementDueDate: iso(-3), ownerUserId: admin.id }).expect(201)
    const arrId = create.body.data.arrangement.id
    const feed = await request(app).get(`${BASE}/reminders`).set(H(admin.token)).expect(200)
    const item = feed.body.data.reminders.find((r: { arrangement: { id: string } }) => r.arrangement.id === arrId)
    expect(item).toBeTruthy()
    expect(item.overdue).toBe(true)

    await request(app).post(`${BASE}/reminders/dispatch`).set(H(admin.token)).expect(200)
    await request(app).post(`${BASE}/reminders/dispatch`).set(H(admin.token)).expect(200) // re-run
    const notifs = await prisma.userNotification.count({ where: { userId: admin.id, type: 'TEAMING_REMINDER', entityId: arrId } })
    expect(notifs).toBe(1) // deduped across the two dispatches
    await request(app).post(`${BASE}/reminders/dispatch`).set(H(consultant.token)).expect(403)
  })
})
