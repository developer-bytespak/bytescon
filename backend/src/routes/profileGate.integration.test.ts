// =============================================================
// Complete-profile gate (services/profileGate.ts): profile status, a
// contractor's My Company, and scoring / decisions / AI / proposals refused
// with PROFILE_INCOMPLETE until the profile they use is complete.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, createCompleteClient, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'
import { completeClientIds } from '../services/profileGate'

let app: Express
let consulting: TestFirm
let consultingAdmin: TestUser
let emptyFirm: TestFirm
let emptyAdmin: TestUser
let contractor: TestFirm
let contractorAdmin: TestUser
let completeId: string
let incompleteId: string
let selfId: string

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const makeOpp = (consultingFirmId: string) => prisma.opportunity.create({
  data: { consultingFirmId, title: 'Gate Opp', agency: 'GSA', naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * 864e5) },
})

beforeAll(async () => {
  app = buildTestApp()
  consulting = await createTestFirm({ name: 'Gate Consulting' })
  consultingAdmin = await createTestUser(consulting.id, { role: 'ADMIN' })
  completeId = (await createCompleteClient(consulting.id, { name: 'Complete Co' })).id
  incompleteId = (await prisma.clientCompany.create({ data: { consultingFirmId: consulting.id, name: 'Half Done Co', naicsCodes: ['541512'] } })).id

  emptyFirm = await createTestFirm({ name: 'Gate No Complete Clients' })
  emptyAdmin = await createTestUser(emptyFirm.id, { role: 'ADMIN' })
  await prisma.clientCompany.create({ data: { consultingFirmId: emptyFirm.id, name: 'Only Incomplete Co' } })

  contractor = await createTestFirm({ name: 'Gate Contractor' })
  await prisma.consultingFirm.update({ where: { id: contractor.id }, data: { accountType: 'CONTRACTOR' } })
  selfId = (await prisma.clientCompany.create({ data: { consultingFirmId: contractor.id, name: 'Gate Contractor', isSelf: true } })).id
  contractorAdmin = await createTestUser(contractor.id, { role: 'ADMIN' })
})

afterAll(async () => {
  for (const f of [consulting, emptyFirm, contractor]) await cleanupFirm(f.id)
  await disconnectDb()
})

describe('profile status', () => {
  it('lists each client of a consulting firm with what is missing', async () => {
    const res = await request(app).get('/api/profile/status').set(H(consultingAdmin.token)).expect(200)
    const { data } = res.body
    expect(data).toMatchObject({ accountType: 'CONSULTING', complete: false, incompleteCount: 1 })
    const half = data.clients.find((c: { name: string }) => c.name === 'Half Done Co')
    expect(half.complete).toBe(false)
    expect(half.missing.map((m: { key: string }) => m.key)).toEqual(['state', 'uei', 'samRegStatus', 'setAsideStatus', 'capabilityKeywords', 'pastPerformance'])
    expect(data.clients.find((c: { name: string }) => c.name === 'Complete Co').complete).toBe(true)
    expect(data.fields.required.length).toBe(8)
  })

  it('shows a contractor only its own company, pointing to Registration for those fields', async () => {
    const res = await request(app).get('/api/profile/status').set(H(contractorAdmin.token)).expect(200)
    expect(res.body.data.clients).toHaveLength(1)
    const own = res.body.data.clients[0]
    expect(own).toMatchObject({ isSelf: true, complete: false })
    expect(own.missing.find((m: { key: string }) => m.key === 'uei').where).toBe('REGISTRATION')
    expect(own.missing.find((m: { key: string }) => m.key === 'capabilityKeywords').where).toBe('PROFILE')
  })
})

describe('blocking until the profile is complete', () => {
  it('refuses scoring and bid decisions for an incomplete client, with the missing fields', async () => {
    const opp = await makeOpp(consulting.id)
    const score = await request(app).post(`/api/opportunities/${opp.id}/score`).set(H(consultingAdmin.token)).send({ clientCompanyId: incompleteId })
    expect(score.status).toBe(422)
    expect(score.body.code).toBe('PROFILE_INCOMPLETE')
    expect(score.body.error).toBe('Complete the profile for Half Done Co first.')
    expect(score.body.details.clientCompanyId).toBe(incompleteId)
    expect(score.body.details.missing.length).toBeGreaterThan(0)

    const decide = await request(app).post('/api/decision/run').set(H(consultingAdmin.token)).send({ opportunityId: opp.id, clientCompanyId: incompleteId })
    expect(decide.status).toBe(422)
  })

  it('still scores a client whose profile is complete', async () => {
    const opp = await makeOpp(consulting.id)
    const score = await request(app).post(`/api/opportunities/${opp.id}/score`).set(H(consultingAdmin.token)).send({ clientCompanyId: completeId })
    expect(score.status).toBe(200)
  })

  it('refuses opportunity-level AI work when no client is complete', async () => {
    const opp = await makeOpp(emptyFirm.id)
    for (const path of [`/api/compliance-matrix/${opp.id}/generate`, `/api/compliance-matrix/${opp.id}/bid-guidance`, `/api/proposal-assist/${opp.id}/outline`]) {
      const res = await request(app).post(path).set(H(emptyAdmin.token)).send({})
      expect([path, res.status, res.body.code]).toEqual([path, 422, 'PROFILE_INCOMPLETE'])
    }
    const portfolio = await request(app).post('/api/decision/run-all').set(H(emptyAdmin.token))
    expect(portfolio.status).toBe(422)
    expect(portfolio.body.error).toBe('Complete at least one client profile first.')
  })

  it('refuses a proposal draft for a named incomplete client', async () => {
    const opp = await makeOpp(consulting.id)
    const res = await request(app).post(`/api/proposal-assist/${opp.id}/draft`).set(H(consultingAdmin.token)).send({ clientCompanyId: incompleteId })
    expect(res.status).toBe(422)
  })

  it('tells a contractor to complete its own company profile', async () => {
    const opp = await makeOpp(contractor.id)
    const res = await request(app).post(`/api/compliance-matrix/${opp.id}/generate`).set(H(contractorAdmin.token)).send({})
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('Complete your company profile first.')
    expect(res.body.details.isSelf).toBe(true)
  })

  it('leaves background scoring only the complete clients', async () => {
    const ready = await completeClientIds(consulting.id, [completeId, incompleteId])
    expect([...ready]).toEqual([completeId])
  })
})

describe('client forms confirm the set-aside status', () => {
  it('records the confirmation on create and on edit', async () => {
    const created = await request(app).post('/api/clients').set(H(consultingAdmin.token))
      .send({ name: 'Confirmed Co', setAsideStatusConfirmed: true, annualRevenue: 2_500_000 }).expect(201)
    const row = await prisma.clientCompany.findUniqueOrThrow({ where: { id: created.body.data.id } })
    expect(row.setAsideStatusConfirmedAt).not.toBeNull()
    expect(Number(row.annualRevenue)).toBe(2_500_000)

    const plain = await prisma.clientCompany.findUniqueOrThrow({ where: { id: incompleteId } })
    expect(plain.setAsideStatusConfirmedAt).toBeNull()
    await request(app).put(`/api/clients/${incompleteId}`).set(H(consultingAdmin.token))
      .send({ setAsideStatusConfirmed: true, updatedAt: plain.updatedAt.toISOString() }).expect(200)
    expect((await prisma.clientCompany.findUniqueOrThrow({ where: { id: incompleteId } })).setAsideStatusConfirmedAt).not.toBeNull()
  })
})

describe('My Company (contractor)', () => {
  it('is refused to a consulting firm', async () => {
    await request(app).get('/api/profile/my-company').set(H(consultingAdmin.token)).expect(403)
    await request(app).put('/api/profile/my-company').set(H(consultingAdmin.token)).send({ city: 'X' }).expect(403)
  })

  it('refuses fields kept in Registration', async () => {
    const res = await request(app).put('/api/profile/my-company').set(H(contractorAdmin.token)).send({ uei: 'NOPE' })
    expect(res.status).toBe(422)
  })

  it('becomes complete from Registration, My Company and a past-performance project, and then unblocks', async () => {
    await request(app).put('/api/registration/profile').set(H(contractorAdmin.token))
      .send({ samStatus: 'ACTIVE', uei: 'GATEUEI00001', naicsCodes: ['541512'], setAsideCerts: [] }).expect(200)
    const saved = await request(app).put('/api/profile/my-company').set(H(contractorAdmin.token))
      .send({ state: 'TX', city: 'Austin', capabilityKeywords: ['fiber', 'structured cabling'], employeeCount: 14 }).expect(200)
    expect(saved.body.data.status.missing.map((m: { key: string }) => m.key)).toEqual(['pastPerformance'])

    // A firm-wide past-performance project counts for a contractor's own company.
    await prisma.pastPerformanceRecord.create({ data: { consultingFirmId: contractor.id, contractNumber: 'GATE-PP-1', customerName: 'Army' } })
    const mine = await request(app).get('/api/profile/my-company').set(H(contractorAdmin.token)).expect(200)
    expect(mine.body.data.status.complete).toBe(true)
    expect(mine.body.data.company.id).toBe(selfId)

    const opp = await makeOpp(contractor.id)
    const score = await request(app).post(`/api/opportunities/${opp.id}/score`).set(H(contractorAdmin.token)).send({ clientCompanyId: selfId })
    expect(score.status).toBe(200)
  })
})
