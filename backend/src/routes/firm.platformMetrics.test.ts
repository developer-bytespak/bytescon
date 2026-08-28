// =============================================================
// GET /api/firm/platform/metrics — operator "prove-it" dashboard (platform admin).
// Platform-wide aggregates over a shared test DB, so assertions are lower-bounds
// + shape/auth, not exact totals.
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
const ORIGINAL_PA = process.env.PLATFORM_ADMIN_EMAILS

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Metrics Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  const client = await prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name: 'Metrics Client' } })
  const past = new Date(Date.now() - 7 * 86_400_000)

  const mk = async (title: string, outcome: 'WON' | 'LOST') => {
    const opp = await prisma.opportunity.create({
      data: { consultingFirmId: firm.id, title, agency: 'GSA', naicsCode: '541512', responseDeadline: past },
    })
    await prisma.submissionRecord.create({
      data: { consultingFirmId: firm.id, clientCompanyId: client.id, opportunityId: opp.id, outcome, outcomeRecordedAt: new Date() },
    })
  }
  await mk('Won bid', 'WON')
  await mk('Lost bid', 'LOST')
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  if (ORIGINAL_PA === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL_PA
  await disconnectDb()
})

describe('FIX / platform metrics — /api/firm/platform/metrics', () => {
  it('rejects a non-platform-admin (403)', async () => {
    delete process.env.PLATFORM_ADMIN_EMAILS
    const res = await request(app).get('/api/firm/platform/metrics').set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(403)
  })

  it('returns win-rate, capture-rate, MRR and activity for a platform admin', async () => {
    process.env.PLATFORM_ADMIN_EMAILS = admin.email
    const res = await request(app).get('/api/firm/platform/metrics').set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.activeFirms).toBeGreaterThanOrEqual(1)
    expect(d.outcomes.won).toBeGreaterThanOrEqual(1)
    expect(d.outcomes.lost).toBeGreaterThanOrEqual(1)
    expect(typeof d.outcomes.winRatePct).toBe('number')
    expect(typeof d.outcomes.captureRatePct).toBe('number')
    expect(typeof d.subscriptions.mrrUsd).toBe('number')
    expect(d.activity30d.submissions).toBeGreaterThanOrEqual(2)
  })
})
