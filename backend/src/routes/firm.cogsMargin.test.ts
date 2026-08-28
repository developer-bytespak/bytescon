// =============================================================
// FIX-6 — GET /api/firm/platform/cogs-margin: fleet-wide gross margin per
// tenant (subscription revenue − LLM COGS), platform-admin only.
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
let planId: string
const ORIGINAL = process.env.PLATFORM_ADMIN_EMAILS

beforeAll(async () => {
  app = buildTestApp()
  // plan:'none' — this suite attaches its own custom-priced subscription
  // below; the factory's default all_access sub would collide on the
  // one-subscription-per-firm unique constraint.
  firm = await createTestFirm({ name: 'COGS Firm', plan: 'none' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })

  const plan = await prisma.subscriptionPlan.create({
    data: {
      name: 'ent',
      slug: `ent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      monthlyPriceUsd: 500,
      annualPriceUsd: 5000,
      maxUsers: 5,
      maxClients: 50,
      aiCallsPerMonth: 1000,
      features: [],
    },
  })
  planId = plan.id

  await prisma.subscription.create({
    data: {
      consultingFirmId: firm.id,
      planId: plan.id,
      status: 'ACTIVE',
      billingCycle: 'MONTHLY',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
    },
  })

  // LLM usage this window: $10 + $15 = $25.
  await prisma.apiUsageLog.createMany({
    data: [
      { consultingFirmId: firm.id, provider: 'claude', model: 'x', task: 'DOCUMENT_ANALYSIS', estimatedCostUsd: 10 },
      { consultingFirmId: firm.id, provider: 'openai', model: 'y', task: 'BID_GUIDANCE', estimatedCostUsd: 15 },
    ],
  })
})

afterAll(async () => {
  await cleanupFirm(firm.id) // cascades subscription + api_usage_logs
  await prisma.subscriptionPlan.delete({ where: { id: planId } }).catch(() => {})
  if (ORIGINAL === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL
  await disconnectDb()
})

describe('FIX-6 — /api/firm/platform/cogs-margin', () => {
  it('rejects a non-platform-admin (403)', async () => {
    delete process.env.PLATFORM_ADMIN_EMAILS
    const res = await request(app).get('/api/firm/platform/cogs-margin').set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(403)
  })

  it('returns per-firm gross margin (revenue − LLM COGS) for a platform admin', async () => {
    process.env.PLATFORM_ADMIN_EMAILS = admin.email
    const res = await request(app)
      .get('/api/firm/platform/cogs-margin?days=30')
      .set('Authorization', `Bearer ${admin.token}`)

    expect(res.status).toBe(200)
    const row = res.body.data.firms.find((r: { firmId: string }) => r.firmId === firm.id)
    expect(row).toBeTruthy()
    expect(row.monthlyRevenueUsd).toBe(500)
    expect(row.llmCostUsd).toBe(25)
    expect(row.grossMarginUsd).toBe(475)
    expect(row.grossMarginPct).toBe(95)
  })
})
