// =============================================================
// GET /api/firm/platform/funnel — FIX-5 activation funnel, retention
// cohorts, and the north-star metric (platform admin).
// Platform-wide aggregates over a shared test DB, so assertions are
// lower-bounds + shape/auth, not exact totals — except stage ORDERING
// and this firm's own contribution, which are exact.
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
  firm = await createTestFirm({ name: 'Funnel Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  const client = await prisma.clientCompany.create({ data: { consultingFirmId: firm.id, name: 'Funnel Client' } })

  // Walk this firm through every funnel stage.
  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id,
      title: 'Funnel Opp',
      agency: 'GSA',
      naicsCode: '541512',
      responseDeadline: new Date(Date.now() + 20 * 86_400_000),
      isScored: true,
      probabilityScore: 0.4,
      savedProposalDraftAt: new Date(),
    },
  })
  await prisma.bidDecision.create({
    data: { consultingFirmId: firm.id, clientCompanyId: client.id, opportunityId: opp.id, decision: 'GO' },
  })
  await prisma.submissionRecord.create({
    data: {
      consultingFirmId: firm.id,
      clientCompanyId: client.id,
      opportunityId: opp.id,
      outcome: 'WON',
      outcomeRecordedAt: new Date(),
    },
  })
  // Retained: the admin logged in recently.
  await prisma.user.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } })
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  if (ORIGINAL_PA === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL_PA
  await disconnectDb()
})

describe('FIX-5 funnel — /api/firm/platform/funnel', () => {
  it('rejects a non-platform-admin (403)', async () => {
    delete process.env.PLATFORM_ADMIN_EMAILS
    const res = await request(app).get('/api/firm/platform/funnel').set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(403)
  })

  it('returns the activation funnel with the canonical stage order', async () => {
    process.env.PLATFORM_ADMIN_EMAILS = admin.email
    const res = await request(app).get('/api/firm/platform/funnel').set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
    const d = res.body.data

    expect(d.activation.stages.map((s: { key: string }) => s.key)).toEqual([
      'signedUp',
      'firstOpportunityScored',
      'firstBidDecision',
      'firstProposalDraft',
      'firstOutcomeLogged',
    ])
    expect(d.activation.totalFirms).toBeGreaterThanOrEqual(1)
    // This firm reached every stage, so each stage has at least one firm.
    for (const s of d.activation.stages) {
      expect(s.firms).toBeGreaterThanOrEqual(1)
      // A stage can never have more firms than exist.
      expect(s.firms).toBeLessThanOrEqual(d.activation.totalFirms)
    }
    // Median days is 0-or-positive when present (clamped against backfill).
    const scored = d.activation.stages.find((s: { key: string }) => s.key === 'firstOpportunityScored')
    expect(scored.medianDaysFromSignup).toBeGreaterThanOrEqual(0)
  })

  it('returns 6 signup cohorts with this month retained', async () => {
    process.env.PLATFORM_ADMIN_EMAILS = admin.email
    const res = await request(app).get('/api/firm/platform/funnel').set('Authorization', `Bearer ${admin.token}`)
    const cohorts = res.body.data.cohorts as { month: string; firms: number; activeLast30d: number }[]
    expect(cohorts).toHaveLength(6)
    // This firm signed up "now" → current month cohort exists, has us, and
    // counts us as active (admin lastLoginAt was just set).
    const thisMonth = cohorts[cohorts.length - 1]
    expect(thisMonth.firms).toBeGreaterThanOrEqual(1)
    expect(thisMonth.activeLast30d).toBeGreaterThanOrEqual(1)
  })

  it('returns the north-star metric with an 8-week trend', async () => {
    process.env.PLATFORM_ADMIN_EMAILS = admin.email
    const res = await request(app).get('/api/firm/platform/funnel').set('Authorization', `Bearer ${admin.token}`)
    const ns = res.body.data.northStar
    expect(ns.outcomesLogged30d).toBeGreaterThanOrEqual(1)
    expect(ns.weeklyTrend).toHaveLength(8)
    // The outcome we just logged lands in the current (last) week bucket.
    expect(ns.weeklyTrend[ns.weeklyTrend.length - 1].outcomes).toBeGreaterThanOrEqual(1)
  })
})
