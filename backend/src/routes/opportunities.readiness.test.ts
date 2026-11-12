// =============================================================
// GET /api/opportunities/:id/readiness — "Can I bid on this?".
// Verifies the checklist is built from the firm's own stored records
// (registration, certifications, bonding), plus 401 / cross-tenant 404.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let other: TestFirm
let otherAdmin: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const BASE = '/api/opportunities'
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000)

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({
    data: { consultingFirmId, title: 'Readiness Opp', agency: 'GSA', naicsCode: '238210', responseDeadline: inDays(30), ...over },
  })
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Readiness Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  other = await createTestFirm({ name: 'Readiness Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('GET /:id/readiness', () => {
  it('401 unauthenticated, 404 cross-tenant and unknown id', async () => {
    const opp = await makeOpp(firm.id)
    await request(app).get(`${BASE}/${opp.id}/readiness`).expect(401)
    await request(app).get(`${BASE}/${opp.id}/readiness`).set(H(otherAdmin.token)).expect(404)
    await request(app).get(`${BASE}/00000000-0000-0000-0000-000000000000/readiness`).set(H(admin.token)).expect(404)
  })

  it('asks the firm to fix SAM first when no registration is stored', async () => {
    const opp = await makeOpp(firm.id, { naicsCode: '541511' })
    const res = await request(app).get(`${BASE}/${opp.id}/readiness`).set(H(admin.token)).expect(200)
    expect(res.body.data.verdict).toBe('FIX_FIRST')
    const sam = res.body.data.items.find((i: { key: string }) => i.key === 'SAM')
    expect(sam.status).toBe('FAIL')
    expect(res.body.data.disclaimer).toMatch(/contracting officer/)
  })

  it('uses the stored registration, certification and bonding records', async () => {
    await prisma.registrationProfile.create({
      data: { consultingFirmId: firm.id, samStatus: 'ACTIVE', samExpiryDate: inDays(300), naicsCodes: ['238210'] },
    })
    await prisma.certification.create({
      data: { consultingFirmId: firm.id, name: 'HUBZone', expiryDate: inDays(300) },
    })
    await prisma.bondingCapacity.create({
      data: {
        consultingFirmId: firm.id, singleProjectLimit: 1_000_000, aggregateLimit: 3_000_000,
        committedAmount: 500_000, expiryDate: inDays(365), status: 'ACTIVE',
      },
    })

    const ready = await makeOpp(firm.id, { setAsideType: 'HUBZONE', estimatedValue: 600_000 })
    const r1 = await request(app).get(`${BASE}/${ready.id}/readiness`).set(H(admin.token)).expect(200)
    expect(r1.body.data.verdict).toBe('READY')
    expect(r1.body.data.items.map((i: { key: string }) => i.key)).toEqual(['DEADLINE', 'SAM', 'NAICS', 'SET_ASIDE', 'BONDING'])

    const tooBig = await makeOpp(firm.id, { setAsideType: 'HUBZONE', estimatedValue: 2_000_000 })
    const r2 = await request(app).get(`${BASE}/${tooBig.id}/readiness`).set(H(admin.token)).expect(200)
    expect(r2.body.data.verdict).toBe('NOT_ELIGIBLE')
    expect(r2.body.data.items.find((i: { key: string }) => i.key === 'BONDING').status).toBe('FAIL')
  })

  it('never reads another firm\'s records', async () => {
    // `other` has no registration; firm's ACTIVE registration must not leak into it.
    const opp = await makeOpp(other.id, { naicsCode: '541511' })
    const res = await request(app).get(`${BASE}/${opp.id}/readiness`).set(H(otherAdmin.token)).expect(200)
    expect(res.body.data.items.find((i: { key: string }) => i.key === 'SAM').status).toBe('FAIL')
  })
})
