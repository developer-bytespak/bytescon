// =============================================================
// §5.1 Stage 3 — GET /api/opportunities/:id/win-probability endpoint. Verifies
// the single-source-of-truth metadata (RAW while calibration is off), the
// unscored + cross-tenant states, and deterministic repeated calls.
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

async function makeOpp(consultingFirmId: string, over: Record<string, unknown> = {}) {
  return prisma.opportunity.create({
    data: { consultingFirmId, title: 'WP Opp', agency: 'GSA', naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * 86_400_000), ...over },
  })
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'WinProb Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  other = await createTestFirm({ name: 'WinProb Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('GET /:id/win-probability', () => {
  it('returns RAW metadata for a scored opportunity (calibration off by default)', async () => {
    const opp = await makeOpp(firm.id, { probabilityScore: 0.42, isScored: true })
    const res = await request(app).get(`${BASE}/${opp.id}/win-probability`).set(H(admin.token)).expect(200)
    expect(res.body.data.scored).toBe(true)
    expect(res.body.data.rawScore).toBe(42)
    expect(res.body.data.finalScore).toBe(42)
    expect(res.body.data.scoreType).toBe('RAW')
    // metadata shape present
    expect(res.body.data).toHaveProperty('method')
    expect(res.body.data).toHaveProperty('reason')
    expect(res.body.data).toHaveProperty('dataSufficiency')
  })

  it('is deterministic across repeated calls', async () => {
    const opp = await makeOpp(firm.id, { probabilityScore: 0.777, isScored: true })
    const a = await request(app).get(`${BASE}/${opp.id}/win-probability`).set(H(admin.token)).expect(200)
    const b = await request(app).get(`${BASE}/${opp.id}/win-probability`).set(H(admin.token)).expect(200)
    expect(a.body.data).toEqual(b.body.data)
    expect(a.body.data.finalScore).toBe(78)
  })

  it('reports scored:false for an unscored opportunity', async () => {
    const opp = await makeOpp(firm.id, { probabilityScore: 0, isScored: false })
    const res = await request(app).get(`${BASE}/${opp.id}/win-probability`).set(H(admin.token)).expect(200)
    expect(res.body.data.scored).toBe(false)
    expect(res.body.data.finalScore).toBeNull()
  })

  it('401 unauthenticated, 404 cross-tenant', async () => {
    const opp = await makeOpp(firm.id, { probabilityScore: 0.5, isScored: true })
    await request(app).get(`${BASE}/${opp.id}/win-probability`).expect(401)
    await request(app).get(`${BASE}/${opp.id}/win-probability`).set(H(otherAdmin.token)).expect(404)
  })
})
