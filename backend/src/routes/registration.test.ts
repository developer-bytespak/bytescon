// =============================================================
// Section 5 Module 2 — Registration / Certification / Insurance routes.
// Covers create/read/update/archive, validation, auth (401), authorization
// (CONSULTANT cannot write → 403), cross-tenant isolation, health rollup, and
// audit-event creation.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp,
  createTestFirm,
  createTestUser,
  cleanupFirm,
  disconnectDb,
  TestFirm,
  TestUser,
} from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let otherFirm: TestFirm
let otherAdmin: TestUser

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` })
const iso = (d: Date) => d.toISOString()

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Reg Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  otherFirm = await createTestFirm({ name: 'Reg Other Firm' })
  otherAdmin = await createTestUser(otherFirm.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(otherFirm.id)
  await disconnectDb()
})

describe('Registration profile', () => {
  it('rejects unauthenticated access (401)', async () => {
    await request(app).get('/api/registration/profile').expect(401)
  })

  it('CONSULTANT cannot write the profile (403)', async () => {
    await request(app)
      .put('/api/registration/profile')
      .set(bearer(consultant.token))
      .send({ uei: 'ABC123', samStatus: 'ACTIVE' })
      .expect(403)
  })

  it('ADMIN upserts the profile and it persists + audits', async () => {
    const res = await request(app)
      .put('/api/registration/profile')
      .set(bearer(admin.token))
      .send({ uei: 'UEI12345', cageCode: '1A2B3', samStatus: 'ACTIVE', samExpiryDate: iso(new Date(Date.now() + 20 * 86_400_000)) })
      .expect(200)
    expect(res.body.data.uei).toBe('UEI12345')

    const got = await request(app).get('/api/registration/profile').set(bearer(admin.token)).expect(200)
    expect(got.body.data.cageCode).toBe('1A2B3')

    const audit = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'RegistrationProfile' } })
    expect(audit).toBeTruthy()
  })
})

describe('Certifications CRUD + validation', () => {
  let certId: string

  it('rejects invalid input (missing name) with 422', async () => {
    await request(app).post('/api/registration/certifications').set(bearer(admin.token)).send({ category: 'SET_ASIDE' }).expect(422)
  })

  it('ADMIN creates a certification (201)', async () => {
    const res = await request(app)
      .post('/api/registration/certifications')
      .set(bearer(admin.token))
      .send({ name: 'SDVOSB', category: 'SET_ASIDE', expiryDate: iso(new Date(Date.now() + 10 * 86_400_000)) })
      .expect(201)
    certId = res.body.data.id
    expect(res.body.data.name).toBe('SDVOSB')
  })

  it('CONSULTANT can read but not create', async () => {
    await request(app).get('/api/registration/certifications').set(bearer(consultant.token)).expect(200)
    await request(app).post('/api/registration/certifications').set(bearer(consultant.token)).send({ name: 'X' }).expect(403)
  })

  it('ADMIN updates and archives (soft-delete)', async () => {
    await request(app).put(`/api/registration/certifications/${certId}`).set(bearer(admin.token)).send({ certNumber: 'C-99' }).expect(200)
    await request(app).delete(`/api/registration/certifications/${certId}`).set(bearer(admin.token)).expect(200)
    // Archived rows are excluded by default.
    const list = await request(app).get('/api/registration/certifications').set(bearer(admin.token)).expect(200)
    expect(list.body.data.some((c: { id: string }) => c.id === certId)).toBe(false)
  })
})

describe('Insurance CRUD', () => {
  it('creates a policy with a decimal coverage amount', async () => {
    const res = await request(app)
      .post('/api/registration/insurance')
      .set(bearer(admin.token))
      .send({ policyType: 'GENERAL_LIABILITY', carrier: 'Acme', coverageAmount: 1000000, expiryDate: iso(new Date(Date.now() + 200 * 86_400_000)) })
      .expect(201)
    expect(res.body.data.policyType).toBe('GENERAL_LIABILITY')
    expect(Number(res.body.data.coverageAmount)).toBe(1000000)
  })

  it('rejects an unknown policy type (422)', async () => {
    await request(app).post('/api/registration/insurance').set(bearer(admin.token)).send({ policyType: 'NOT_A_TYPE' }).expect(422)
  })
})

describe('Health rollup', () => {
  it('summarizes SAM + certs + insurance and lists items needing attention', async () => {
    const res = await request(app).get('/api/registration/health').set(bearer(admin.token)).expect(200)
    const { summary, attention } = res.body.data
    expect(summary.total).toBeGreaterThanOrEqual(2) // SAM (expiring) + insurance (active)
    // The SAM registration expires in ~20 days → should be flagged for attention.
    expect(attention.some((i: { kind: string }) => i.kind === 'SAM_REGISTRATION')).toBe(true)
  })
})

describe('Cross-tenant isolation', () => {
  it('another firm cannot see this firm certifications, and 404s on its ids', async () => {
    const c = await prisma.certification.create({ data: { consultingFirmId: firm.id, name: 'Tenant-Only Cert' } })

    const otherList = await request(app).get('/api/registration/certifications').set(bearer(otherAdmin.token)).expect(200)
    expect(otherList.body.data.some((x: { id: string }) => x.id === c.id)).toBe(false)

    await request(app).put(`/api/registration/certifications/${c.id}`).set(bearer(otherAdmin.token)).send({ certNumber: 'X' }).expect(404)

    const otherHealth = await request(app).get('/api/registration/health').set(bearer(otherAdmin.token)).expect(200)
    expect(otherHealth.body.data.items.some((i: { id: string }) => i.id === c.id)).toBe(false)
  })
})
