// =============================================================
// Security regression suite — covers paths the review flagged as untested:
//   - C2: a scoped 'accept_agreements' token must be REJECTED on data routes.
//   - Tenant isolation: cross-tenant IDOR on GET /api/clients/:id.
//   - C1: /api/billing/subscribe must block paid-tier self-grant (no payment).
// Runs against the isolated bytescon_platform_test DB.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../config/database'
import { config } from '../config/config'
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
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let adminB: TestUser
let clientAId: string
const createdPlanIds: string[] = []

// A single-purpose scoped completion token, exactly like login gate-2 issues.
function scopedToken(u: TestUser): string {
  return jwt.sign(
    { userId: u.id, consultingFirmId: u.consultingFirmId, email: u.email, role: u.role, scope: 'accept_agreements' },
    config.jwt.secret,
    { expiresIn: '1h' },
  )
}

async function makePlan(name: string, priceUsd: number): Promise<string> {
  const plan = await prisma.subscriptionPlan.create({
    data: {
      name,
      slug: `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      monthlyPriceUsd: priceUsd,
      annualPriceUsd: priceUsd * 10,
      maxUsers: 5,
      maxClients: 50,
      aiCallsPerMonth: 100,
      features: [],
    },
  })
  createdPlanIds.push(plan.id)
  return plan.id
}

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Sec Firm A' })
  firmB = await createTestFirm({ name: 'Sec Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
  const client = await prisma.clientCompany.create({
    data: { consultingFirmId: firmA.id, name: 'Firm A Confidential Client' },
  })
  clientAId = client.id
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  for (const id of createdPlanIds) {
    await prisma.subscriptionPlan.delete({ where: { id } }).catch(() => {})
  }
  await disconnectDb()
})

describe('C2 — scoped accept_agreements token rejected on data routes', () => {
  it('rejects a scoped token on GET /api/clients (403)', async () => {
    const res = await request(app).get('/api/clients').set('Authorization', `Bearer ${scopedToken(adminA)}`)
    expect(res.status).toBe(403)
  })

  it('allows the same user with a FULL session token (200)', async () => {
    const res = await request(app).get('/api/clients').set('Authorization', `Bearer ${adminA.token}`)
    expect(res.status).toBe(200)
  })
})

describe('Tenant isolation — cross-tenant IDOR on GET /api/clients/:id', () => {
  it('firm A admin can read firm A client (200)', async () => {
    const res = await request(app).get(`/api/clients/${clientAId}`).set('Authorization', `Bearer ${adminA.token}`)
    expect(res.status).toBe(200)
  })

  it('firm B admin CANNOT read firm A client — not leaked (404)', async () => {
    const res = await request(app).get(`/api/clients/${clientAId}`).set('Authorization', `Bearer ${adminB.token}`)
    expect(res.status).toBe(404)
  })
})

describe('C1 — /api/billing/subscribe blocks paid-tier self-grant', () => {
  it('rejects activating a PAID plan with no payment (402 PAYMENT_REQUIRED)', async () => {
    const planId = await makePlan('enterprise', 499)
    const res = await request(app)
      .post('/api/billing/subscribe')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ planId })
    expect(res.status).toBe(402)
    expect(res.body.code).toBe('PAYMENT_REQUIRED')
  })

  it('allows activating a FREE plan (200)', async () => {
    const planId = await makePlan('starter', 0)
    const res = await request(app)
      .post('/api/billing/subscribe')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ planId })
    expect(res.status).toBe(200)
  })
})

// -------------------------------------------------------------
// /subscription/reactivate must not be a second self-grant path.
// It previously wrote status:'ACTIVE' unconditionally, so any firm ADMIN
// could revive an expired-trial or CANCELED subscription for free — and
// entitlementService reads status==='ACTIVE' as full paid access.
// -------------------------------------------------------------
describe('/api/billing/subscription/reactivate cannot self-grant a paid plan', () => {
  async function setSubscription(firmId: string, planId: string, status: string) {
    return prisma.subscription.upsert({
      where: { consultingFirmId: firmId },
      create: {
        consultingFirmId: firmId,
        planId,
        status: status as never,
        cancelAtPeriodEnd: true,
        currentPeriodStart: new Date(Date.now() - 30 * 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      },
      update: { planId, status: status as never, cancelAtPeriodEnd: true },
    })
  }

  it('refuses to reactivate a CANCELED subscription (402 PLAN_REQUIRED)', async () => {
    const planId = await makePlan('reactivate-canceled', 99)
    await setSubscription(firmB.id, planId, 'CANCELED')

    const res = await request(app)
      .put('/api/billing/subscription/reactivate')
      .set('Authorization', `Bearer ${adminB.token}`)
    expect(res.status).toBe(402)
    expect(res.body.code).toBe('PLAN_REQUIRED')

    // The status must be untouched — no free upgrade to ACTIVE.
    const after = await prisma.subscription.findUnique({ where: { consultingFirmId: firmB.id } })
    expect(after?.status).toBe('CANCELED')
  })

  it('refuses to reactivate a PAST_DUE subscription (402 PLAN_REQUIRED)', async () => {
    const planId = await makePlan('reactivate-pastdue', 99)
    await setSubscription(firmB.id, planId, 'PAST_DUE')

    const res = await request(app)
      .put('/api/billing/subscription/reactivate')
      .set('Authorization', `Bearer ${adminB.token}`)
    expect(res.status).toBe(402)

    const after = await prisma.subscription.findUnique({ where: { consultingFirmId: firmB.id } })
    expect(after?.status).toBe('PAST_DUE')
  })

  it('un-cancels an ACTIVE subscription without rewriting its status', async () => {
    const planId = await makePlan('reactivate-active', 99)
    await setSubscription(firmB.id, planId, 'ACTIVE')

    const res = await request(app)
      .put('/api/billing/subscription/reactivate')
      .set('Authorization', `Bearer ${adminB.token}`)
    expect(res.status).toBe(200)

    const after = await prisma.subscription.findUnique({ where: { consultingFirmId: firmB.id } })
    expect(after?.cancelAtPeriodEnd).toBe(false)
    expect(after?.status).toBe('ACTIVE')
  })
})
