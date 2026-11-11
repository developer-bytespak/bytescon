// =============================================================
// Contractor accounts (ConsultingFirm.accountType = CONTRACTOR): sign-up
// creates the firm's own company record, client management and client-portal
// logins are refused, the own-company record follows the registration
// profile, and consulting accounts are unaffected.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../config/database'
import { config } from '../config/config'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let tosVersion: string
let contractor: TestFirm
let contractorAdmin: TestUser
let consulting: TestFirm
let consultingAdmin: TestUser
const signedUpFirmIds: string[] = []

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const uniq = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

beforeAll(async () => {
  app = buildTestApp()
  const current = await prisma.termsOfServiceVersion.findFirst({ where: { isCurrent: true } })
  tosVersion = current?.version ?? (await prisma.termsOfServiceVersion.create({
    data: { version: 'test-1.0', title: 'Test ToS', body: 'Test ToS body', contentHash: 'a'.repeat(64), effectiveAt: new Date(), isCurrent: true },
  })).version

  contractor = await createTestFirm({ name: 'Contractor Co' })
  await prisma.consultingFirm.update({ where: { id: contractor.id }, data: { accountType: 'CONTRACTOR' } })
  await prisma.clientCompany.create({ data: { consultingFirmId: contractor.id, name: 'Contractor Co', isSelf: true } })
  contractorAdmin = await createTestUser(contractor.id, { role: 'ADMIN' })

  consulting = await createTestFirm({ name: 'Consulting Co' })
  consultingAdmin = await createTestUser(consulting.id, { role: 'ADMIN' })
})

afterAll(async () => {
  for (const id of [contractor.id, consulting.id, ...signedUpFirmIds]) await cleanupFirm(id)
  await disconnectDb()
})

function signUp(accountType?: 'CONSULTING' | 'CONTRACTOR') {
  const email = `${uniq('signup')}@test.local`
  return request(app).post('/api/auth/register-firm').send({
    firmName: 'ARK Telecom Test', contactEmail: email, firstName: 'Hari', lastName: 'Test',
    password: 'Contractor-Test-Pass-1!', acceptedTosVersion: tosVersion,
    ...(accountType ? { accountType } : {}),
  })
}

describe('sign-up', () => {
  it('creates a contractor firm with its own company record', async () => {
    const res = await signUp('CONTRACTOR')
    expect(res.status).toBe(201)
    const firm = await prisma.consultingFirm.findFirstOrThrow({ where: { contactEmail: res.body.data.email } })
    signedUpFirmIds.push(firm.id)
    expect(firm.accountType).toBe('CONTRACTOR')
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId: firm.id } })
    expect(clients).toHaveLength(1)
    expect(clients[0]).toMatchObject({ isSelf: true, name: 'ARK Telecom Test', isActive: true })
  })

  it('defaults to a consulting firm with no clients', async () => {
    const res = await signUp()
    expect(res.status).toBe(201)
    const firm = await prisma.consultingFirm.findFirstOrThrow({ where: { contactEmail: res.body.data.email } })
    signedUpFirmIds.push(firm.id)
    expect(firm.accountType).toBe('CONSULTING')
    expect(await prisma.clientCompany.count({ where: { consultingFirmId: firm.id } })).toBe(0)
  })

  it('rejects an unknown account type', async () => {
    const res = await signUp('SOMETHING' as 'CONTRACTOR')
    expect(res.status).toBe(422)
  })
})

describe('session', () => {
  it('returns the account type in the session and profile', async () => {
    const scoped = jwt.sign(
      { userId: contractorAdmin.id, consultingFirmId: contractor.id, role: 'ADMIN', email: contractorAdmin.email, scope: 'accept_agreements' },
      config.jwt.secret, { expiresIn: '15m' },
    )
    const session = await request(app).post('/api/auth/complete-agreements').set(H(scoped)).send({ acceptedTosVersion: tosVersion })
    expect(session.status).toBe(200)
    expect(session.body.data.firm.accountType).toBe('CONTRACTOR')

    const profile = await request(app).get('/api/auth/profile').set(H(contractorAdmin.token)).expect(200)
    expect(JSON.stringify(profile.body)).toContain('"accountType":"CONTRACTOR"')
  })
})

describe('client management on a contractor account', () => {
  it('refuses adding, importing, editing, archiving and deleting clients', async () => {
    const self = await prisma.clientCompany.findFirstOrThrow({ where: { consultingFirmId: contractor.id, isSelf: true } })
    const add = await request(app).post('/api/clients').set(H(contractorAdmin.token)).send({ name: 'Another Client' })
    expect(add.status).toBe(403)
    expect(add.body.error ?? add.body.message).toMatch(/Contractor accounts/)
    expect((await request(app).post('/api/clients/import-csv').set(H(contractorAdmin.token))).status).toBe(403)
    expect((await request(app).put(`/api/clients/${self.id}`).set(H(contractorAdmin.token)).send({ name: 'Renamed' })).status).toBe(403)
    expect((await request(app).patch(`/api/clients/${self.id}/archive`).set(H(contractorAdmin.token))).status).toBe(403)
    expect((await request(app).delete(`/api/clients/${self.id}`).set(H(contractorAdmin.token))).status).toBe(403)
    expect(await prisma.clientCompany.count({ where: { consultingFirmId: contractor.id } })).toBe(1)
  })

  it('refuses creating client-portal logins', async () => {
    const self = await prisma.clientCompany.findFirstOrThrow({ where: { consultingFirmId: contractor.id, isSelf: true } })
    const res = await request(app).post('/api/client-portal/auth/register').set(H(contractorAdmin.token))
      .send({ clientCompanyId: self.id, email: `${uniq('portal')}@test.local`, password: 'Portal-Test-Pass-1!' })
    expect(res.status).toBe(403)
    expect(await prisma.clientPortalUser.count({ where: { clientCompanyId: self.id } })).toBe(0)
  })

  it('refuses sending a proposal or price volume to a client for review', async () => {
    const id = '00000000-0000-0000-0000-000000000000'
    const proposal = await request(app).post(`/api/proposal/${id}/send-to-client`).set(H(contractorAdmin.token)).send({})
    expect(proposal.status).toBe(403)
    const pricing = await request(app).post(`/api/pricing/${id}/send-to-client`).set(H(contractorAdmin.token)).send({})
    expect(pricing.status).toBe(403)
    // A consulting firm passes this guard and reaches the normal checks.
    const consultingSend = await request(app).post(`/api/proposal/${id}/send-to-client`).set(H(consultingAdmin.token)).send({})
    expect(consultingSend.status).not.toBe(403)
  })

  it('still lets a consulting account add clients', async () => {
    const res = await request(app).post('/api/clients').set(H(consultingAdmin.token)).send({ name: 'Real Client LLC' })
    expect(res.status).toBe(201)
  })
})

describe('own company record follows the registration profile', () => {
  it('copies NAICS, identifiers, SAM status and set-asides on save', async () => {
    await request(app).put('/api/registration/profile').set(H(contractorAdmin.token)).send({
      samStatus: 'ACTIVE', samExpiryDate: '2027-06-01T00:00:00.000Z', uei: 'ARKUEI123456', cageCode: '9ARK1',
      naicsCodes: ['238210'], setAsideCerts: ['HUBZONE'],
    }).expect(200)
    const self = await prisma.clientCompany.findFirstOrThrow({ where: { consultingFirmId: contractor.id, isSelf: true } })
    expect(self).toMatchObject({ uei: 'ARKUEI123456', cage: '9ARK1', naicsCodes: ['238210'], hubzone: true, samRegStatus: 'Active' })
  })

  it('picks up a new certification and drops it when archived', async () => {
    const cert = await request(app).post('/api/registration/certifications').set(H(contractorAdmin.token))
      .send({ name: 'SDVOSB', expiryDate: '2028-01-01T00:00:00.000Z' }).expect(201)
    expect((await prisma.clientCompany.findFirstOrThrow({ where: { consultingFirmId: contractor.id, isSelf: true } })).sdvosb).toBe(true)
    await request(app).delete(`/api/registration/certifications/${cert.body.data.id}`).set(H(contractorAdmin.token)).expect(200)
    expect((await prisma.clientCompany.findFirstOrThrow({ where: { consultingFirmId: contractor.id, isSelf: true } })).sdvosb).toBe(false)
  })

  it('never creates a self client for a consulting firm', async () => {
    await request(app).put('/api/registration/profile').set(H(consultingAdmin.token)).send({ samStatus: 'ACTIVE', naicsCodes: ['541511'] }).expect(200)
    expect(await prisma.clientCompany.count({ where: { consultingFirmId: consulting.id, isSelf: true } })).toBe(0)
  })
})
