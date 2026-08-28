// =============================================================
// §5.1 Stage 10 / §5.2 Past Performance integration — create/edit/archive/restore,
// create-from-contract prefill + duplicate prevention, manual CPARS + honest missing
// state, private-reference redaction, search/filters, deterministic matrix scoring +
// insufficient-data, human selection preserved separately from score, master-record
// immutability on select, adaptation draft label, audit, authz + cross-tenant.
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
const B = '/api/past-performance-library'

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({ data: { consultingFirmId, title: 'PP opp', agency: 'Department of the Navy', naicsCode: '541512', description: 'cloud cybersecurity', setAsideType: 'SDVOSB', estimatedValue: 1_000_000, responseDeadline: new Date(Date.now() + 30 * 86_400_000), ...over } })
}
async function makeRecord(token: string, over: Record<string, unknown> = {}) {
  return (await request(app).post(B).set(H(token)).send({ contractNumber: 'N-' + Math.random().toString(36).slice(2, 8), customerName: 'US Navy', customerAgency: 'Department of the Navy', naicsCode: '541512', scopeSummary: 'cloud cybersecurity engineering', totalValue: 900000, performerRole: 'PRIME', periodOfPerformanceEnd: new Date(Date.now() - 200 * 86_400_000).toISOString(), referenceName: 'Jane POC', referenceEmail: 'jane@navy.mil', permissionToContact: true, ...over }).expect(201)).body.data.record
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'PP Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'PP Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('record CRUD + archive/restore + authz', () => {
  it('creates, edits, archives and restores a record; CONSULTANT cannot create', async () => {
    const r = await makeRecord(admin.token)
    expect(r.verificationStatus).toBe('DRAFT')
    await request(app).patch(`${B}/${r.id}`).set(H(admin.token)).send({ resultsOutcomes: 'Delivered on schedule (approved)' }).expect(200)
    await request(app).post(`${B}/${r.id}/archive`).set(H(admin.token)).expect(200)
    await request(app).post(`${B}/${r.id}/restore`).set(H(admin.token)).expect(200)
    await request(app).post(B).set(H(consultant.token)).send({ contractNumber: 'x', customerName: 'y' }).expect(403)
    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'PastPerformanceRecord', entityId: r.id, action: 'CREATE' } })
    expect(audit).toBeTruthy()
  })
})

describe('create-from-contract prefill + duplicate prevention', () => {
  it('prefills from a completed contract and prevents a second record for the same contract', async () => {
    const contract = await prisma.contract.create({ data: { consultingFirmId: firm.id, contractNumber: 'W912-01', title: 'Cloud Ops', agency: 'Army', awardValue: 750000, startDate: new Date('2022-01-01'), endDate: new Date('2024-01-01'), status: 'COMPLETED' } })
    const r1 = await request(app).post(`${B}/from-contract/${contract.id}`).set(H(admin.token)).expect(201)
    expect(r1.body.data.record.contractNumber).toBe('W912-01')
    expect(r1.body.data.record.contractTitle).toBe('Cloud Ops')
    expect(r1.body.data.record.verificationStatus).toBe('DRAFT')
    expect(r1.body.data.record.cparsRating).toBeNull() // never fabricated
    await request(app).post(`${B}/from-contract/${contract.id}`).set(H(admin.token)).expect(409)
  })
})

describe('private reference redaction', () => {
  it('redacts reference contact for CONSULTANT but not ADMIN', async () => {
    const r = await makeRecord(admin.token)
    const adminView = await request(app).get(`${B}/${r.id}`).set(H(admin.token)).expect(200)
    expect(adminView.body.data.record.referenceEmail).toBe('jane@navy.mil')
    const consView = await request(app).get(`${B}/${r.id}`).set(H(consultant.token)).expect(200)
    expect(consView.body.data.record.referenceEmail).toBeNull()
    expect(consView.body.data.record.referenceRedacted).toBe(true)
  })
})

describe('search + filters', () => {
  it('filters by agency and value range', async () => {
    await makeRecord(admin.token, { customerAgency: 'Department of the Air Force', totalValue: 50000 })
    const byAgency = await request(app).get(`${B}?agency=Navy`).set(H(admin.token)).expect(200)
    expect(byAgency.body.data.records.every((r: { customerAgency: string }) => /navy/i.test(r.customerAgency))).toBe(true)
    const byValue = await request(app).get(`${B}?valueMin=800000`).set(H(admin.token)).expect(200)
    expect(byValue.body.data.records.every((r: { totalValue: string }) => Number(r.totalValue) >= 800000)).toBe(true)
  })
})

describe('matrix — deterministic scoring, insufficient data, selection separate from score', () => {
  it('scores records deterministically and keeps human selection separate from the automated score', async () => {
    const opp = await makeOpp(firm.id)
    const strong = await makeRecord(admin.token)
    const weak = await makeRecord(admin.token, { customerAgency: null, naicsCode: null, scopeSummary: '' })
    await request(app).post(`${B}/matrix/${opp.id}/score`).set(H(admin.token)).expect(200)
    const matrix = await request(app).get(`${B}/matrix/${opp.id}`).set(H(admin.token)).expect(200)
    const rowStrong = matrix.body.data.rows.find((x: { record: { id: string } }) => x.record.id === strong.id)
    const rowWeak = matrix.body.data.rows.find((x: { record: { id: string } }) => x.record.id === weak.id)
    expect(rowStrong.selection.relevanceScore).toBeGreaterThanOrEqual(60)
    expect(rowStrong.selection.confidence).toBe('HIGH')
    expect(rowWeak.selection.confidence).toBe('INSUFFICIENT_DATA')

    // human select — automated score is preserved separately, master record untouched
    const beforeUpdatedAt = strong.updatedAt
    await request(app).post(`${B}/matrix/${opp.id}/select/${strong.id}`).set(H(admin.token)).send({ notes: 'lead discriminator' }).expect(200)
    const after = await request(app).get(`${B}/matrix/${opp.id}`).set(H(admin.token)).expect(200)
    const sel = after.body.data.rows.find((x: { record: { id: string } }) => x.record.id === strong.id)
    expect(sel.selection.isSelected).toBe(true)
    expect(sel.selection.relevanceScore).toBe(rowStrong.selection.relevanceScore) // score unchanged by selection
    expect(sel.record.updatedAt).toBe(beforeUpdatedAt) // master record unchanged
    const auditSel = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'PastPerformanceSelection' } })
    expect(auditSel).toBeTruthy()
    await request(app).post(`${B}/matrix/${opp.id}/deselect/${strong.id}`).set(H(admin.token)).expect(200)
  })
})

describe('adaptation draft', () => {
  it('produces an AI-labelled adaptation draft without modifying the master record', async () => {
    const r = await makeRecord(admin.token, { workPerformed: 'Delivered zero-trust across 12 enclaves' })
    const opp = await makeOpp(firm.id)
    const adapt = await request(app).post(`${B}/${r.id}/adapt`).set(H(admin.token)).send({ opportunityId: opp.id }).expect(200)
    expect(adapt.body.data.content).toContain('AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW')
    // master record is unchanged
    const master = await prisma.pastPerformanceRecord.findUnique({ where: { id: r.id } })
    expect(master?.workPerformed).toBe('Delivered zero-trust across 12 enclaves')
  })
})

describe('cross-tenant isolation', () => {
  it('blocks cross-tenant record read', async () => {
    const r = await makeRecord(admin.token)
    await request(app).get(`${B}/${r.id}`).set(H(otherAdmin.token)).expect(404)
  })
})
