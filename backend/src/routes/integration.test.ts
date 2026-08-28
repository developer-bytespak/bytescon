// =============================================================
// Integration tests — full Express stack against real Postgres
//
// Per engineering.md Rule 4: tenant isolation is non-negotiable.
// These tests prove that firm A cannot read firm B data via any route.
// =============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
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

beforeAll(async () => {
  app = buildTestApp()
})

beforeEach(async () => {
  // Fresh firms per test for clean state
  firmA = await createTestFirm({ name: 'Firm Alpha' })
  firmB = await createTestFirm({ name: 'Firm Bravo' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
})

afterAll(async () => {
  // Cleanup any leftover test firms
  await cleanupFirm(firmA?.id).catch(() => {})
  await cleanupFirm(firmB?.id).catch(() => {})
  await disconnectDb()
})

// -------------------------------------------------------------
// Health + API contract
// -------------------------------------------------------------

describe('GET /health', () => {
  it('returns 200 with healthy status', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('healthy')
  })
})

// -------------------------------------------------------------
// Auth — JWT enforcement
// -------------------------------------------------------------

describe('Auth — JWT enforcement', () => {
  it('rejects requests with no Authorization header', async () => {
    const res = await request(app).get('/api/firm')
    expect(res.status).toBe(401)
    expect(res.body.success).toBe(false)
    expect(res.body.code).toBe('UNAUTHORIZED')
  })

  it('rejects requests with malformed Bearer token', async () => {
    const res = await request(app)
      .get('/api/firm')
      .set('Authorization', 'NotBearer xyz')
    expect(res.status).toBe(401)
  })

  it('rejects requests with invalid JWT signature', async () => {
    const res = await request(app)
      .get('/api/firm')
      .set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.bogus.signature')
    expect(res.status).toBe(401)
  })

  it('accepts valid JWT', async () => {
    const res = await request(app)
      .get('/api/firm')
      .set('Authorization', `Bearer ${adminA.token}`)
    expect(res.status).toBe(200)
  })
})

// -------------------------------------------------------------
// Tenant Isolation — CRITICAL
// -------------------------------------------------------------

describe('Tenant Isolation — firm A cannot access firm B data', () => {
  it('GET /api/firm returns only the caller firm', async () => {
    const resA = await request(app)
      .get('/api/firm')
      .set('Authorization', `Bearer ${adminA.token}`)
    expect(resA.status).toBe(200)
    expect(resA.body.data.id).toBe(firmA.id)
    expect(resA.body.data.name).toBe('Firm Alpha')
    expect(resA.body.data.id).not.toBe(firmB.id)
  })

  it('GET /api/branding/:firmId leaks no internal fields cross-firm', async () => {
    // Branding is INTENTIONALLY public (no auth required) — used by client portal
    // before login. Verify it returns only public-safe fields.
    const res = await request(app).get(`/api/branding/${firmB.id}`)
    expect(res.status).toBe(200)
    expect(res.body.data.firmId).toBe(firmB.id)
    expect(res.body.data).not.toHaveProperty('contactEmail')
    expect(res.body.data).not.toHaveProperty('stripeCustomerId')
    expect(res.body.data).not.toHaveProperty('stripeSubscriptionId')
    expect(res.body.data).not.toHaveProperty('anthropicApiKey')
    expect(res.body.data).not.toHaveProperty('openaiApiKey')
    expect(res.body.data).not.toHaveProperty('samApiKey')
  })

  it('admin A cannot update firm B branding', async () => {
    // PUT /api/branding/admin/update updates the CALLER's firm, not arbitrary
    const res = await request(app)
      .put('/api/branding/admin/update')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ displayName: 'Hijacked!' })
    expect(res.status).toBe(200)

    // Verify firm B branding is untouched
    const firmBCheck = await request(app).get(`/api/branding/${firmB.id}`)
    expect(firmBCheck.body.data.displayName).not.toBe('Hijacked!')
  })
})

// -------------------------------------------------------------
// Branding API — public + admin endpoints
// -------------------------------------------------------------

describe('Branding API', () => {
  it('GET /api/branding/:firmId returns 404 for unknown firm', async () => {
    const res = await request(app).get('/api/branding/nonexistent-firm-id')
    expect(res.status).toBe(404)
    expect(res.body.success).toBe(false)
  })

  it('GET /api/branding/by-host/:host returns defaults for unknown host', async () => {
    const res = await request(app).get('/api/branding/by-host/random.example.com')
    expect(res.status).toBe(200)
    expect(res.body.data.firmId).toBeNull()
    expect(res.body.data.displayName).toBe('Bytescon')
  })

  it('GET /api/branding/by-host rejects malformed hosts', async () => {
    const res = await request(app).get('/api/branding/by-host/not-a-host')
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('VALIDATION_ERROR')
  })

  it('PUT /api/branding/admin/update requires ADMIN role', async () => {
    const consultant = await createTestUser(firmA.id, { role: 'CONSULTANT' })
    const res = await request(app)
      .put('/api/branding/admin/update')
      .set('Authorization', `Bearer ${consultant.token}`)
      .send({ displayName: 'should fail' })
    expect(res.status).toBe(403)
  })

  it('PUT /api/branding/admin/subdomain rejects reserved subdomains', async () => {
    const res = await request(app)
      .put('/api/branding/admin/subdomain')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ subdomain: 'api' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('VALIDATION_ERROR')
  })

  it('PUT /api/branding/admin/subdomain rejects invalid format', async () => {
    const res = await request(app)
      .put('/api/branding/admin/subdomain')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ subdomain: 'Bad-Format!' })
    expect(res.status).toBe(422)
  })

  it('PUT /api/branding/admin/subdomain accepts valid subdomain', async () => {
    const res = await request(app)
      .put('/api/branding/admin/subdomain')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ subdomain: `test-${Date.now()}` })
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
  })
})

// -------------------------------------------------------------
// Stripe Webhook — signature verification
// -------------------------------------------------------------

describe('Stripe Webhook — signature verification', () => {
  it('rejects webhook with missing signature header', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .send({ test: true })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('BAD_REQUEST')
  })

  it('rejects webhook with invalid signature', async () => {
    const res = await request(app)
      .post('/api/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 't=123,v1=fakesignature')
      .send({ test: true })
    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_SIGNATURE')
  })
})

// -------------------------------------------------------------
// Billing — tier configuration check
// -------------------------------------------------------------

describe('Billing — tier configuration', () => {
  it('GET /api/billing/stripe/catalog returns tier list', async () => {
    const res = await request(app)
      .get('/api/billing/stripe/catalog')
      .set('Authorization', `Bearer ${adminA.token}`)
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(Array.isArray(res.body.data.tiers)).toBe(true)
    expect(res.body.data.tiers).toHaveLength(2)
    expect(res.body.data.tiers.map((t: any) => t.slug)).toEqual(['base', 'all_access'])
  })

  it('POST /api/billing/stripe/checkout/subscription rejects unknown tier', async () => {
    const res = await request(app)
      .post('/api/billing/stripe/checkout/subscription')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({ tier: 'nonexistent', successUrl: 'http://x', cancelUrl: 'http://x' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('VALIDATION_ERROR')
  })

  it('POST /api/billing/stripe/checkout/subscription requires ADMIN', async () => {
    const consultant = await createTestUser(firmA.id, { role: 'CONSULTANT' })
    const res = await request(app)
      .post('/api/billing/stripe/checkout/subscription')
      .set('Authorization', `Bearer ${consultant.token}`)
      .send({ tier: 'starter', successUrl: 'http://x', cancelUrl: 'http://x' })
    expect(res.status).toBe(403)
  })
})

// -------------------------------------------------------------
// Response Contract — all endpoints follow { success, data, error?, code? }
// -------------------------------------------------------------

describe('Response Contract', () => {
  it('error responses always include success:false + error + code', async () => {
    const res = await request(app)
      .get('/api/branding/nonexistent-firm-id')
    expect(res.body).toHaveProperty('success', false)
    expect(res.body).toHaveProperty('error')
    expect(res.body).toHaveProperty('code')
    expect(typeof res.body.code).toBe('string')
  })

  it('success responses include success:true + data', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    // /health is a special case (legacy shape, not required to follow contract)
    // Test a real API endpoint instead
    const apiRes = await request(app)
      .get('/api/branding/by-host/random.example.com')
    expect(apiRes.body).toHaveProperty('success', true)
    expect(apiRes.body).toHaveProperty('data')
  })
})

// -------------------------------------------------------------
// Module Gating — a base-plan firm must NOT reach add-on module routes;
// they reject with 403 ADDON_REQUIRED. A firm with no subscription at all
// rejects with 402 PLAN_REQUIRED before any module gate runs.
// -------------------------------------------------------------

describe('Module Gating — base plan rejects add-on features', () => {
  it('rejects compliance-matrix (contract_analysis module) with ADDON_REQUIRED for a base-only firm', async () => {
    const baseFirm = await createTestFirm({ plan: 'base' })
    const baseAdmin = await createTestUser(baseFirm.id, { role: 'ADMIN' })
    const res = await request(app)
      .post('/api/compliance-matrix/00000000-0000-0000-0000-000000000000/bid-guidance')
      .set('Authorization', `Bearer ${baseAdmin.token}`)
      .send({})
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ADDON_REQUIRED')
    expect(res.body.addon).toBe('contract_analysis')
    await cleanupFirm(baseFirm.id)
  })

  it('rejects opportunity search with PLAN_REQUIRED for a firm with no subscription', async () => {
    const lockedFirm = await createTestFirm({ plan: 'none' })
    const lockedAdmin = await createTestUser(lockedFirm.id, { role: 'ADMIN' })
    const res = await request(app)
      .get('/api/opportunities')
      .set('Authorization', `Bearer ${lockedAdmin.token}`)
    expect(res.status).toBe(402)
    expect(res.body.code).toBe('PLAN_REQUIRED')
    await cleanupFirm(lockedFirm.id)
  })

  it('lets an all_access firm through module gates (404 on missing opportunity, not 403)', async () => {
    const res = await request(app)
      .post('/api/compliance-matrix/00000000-0000-0000-0000-000000000000/bid-guidance')
      .set('Authorization', `Bearer ${adminA.token}`)
      .send({})
    expect([404, 422]).toContain(res.status)
  })
})

// -------------------------------------------------------------
// Client Portal — separate JWT scope, never confusable with consultant JWT
// -------------------------------------------------------------

describe('Client Portal — JWT scope isolation', () => {
  it('consultant JWT cannot access /api/client-portal endpoints', async () => {
    // Consultant token has role=ADMIN, no clientPortalUserId. Client-portal middleware
    // (authenticateClientJWT) requires role=CLIENT and rejects everything else.
    const res = await request(app)
      .get('/api/client-portal/dashboard')
      .set('Authorization', `Bearer ${adminA.token}`)
    expect([401, 403]).toContain(res.status)
  })

  it('unauthenticated request to /api/client-portal/dashboard is 401', async () => {
    const res = await request(app).get('/api/client-portal/dashboard')
    expect(res.status).toBe(401)
  })
})

// -------------------------------------------------------------
// Beta Access — public unauthenticated waitlist signup
// -------------------------------------------------------------

describe('Beta Access — public waitlist endpoint', () => {
  it('POST /api/beta/request accepts a valid signup', async () => {
    const res = await request(app)
      .post('/api/beta/request')
      .send({
        email: `beta-${Date.now()}@example.com`,
        firmName: 'Acme Federal Services',
        naicsFocus: '541512',
      })
    // Either 201 (created) or 200 (idempotent re-signup) — must not be 401/403/500.
    expect([200, 201]).toContain(res.status)
    expect(res.body.success).toBe(true)
  })

  it('POST /api/beta/request rejects missing email with 422', async () => {
    const res = await request(app)
      .post('/api/beta/request')
      .send({ firmName: 'Missing Email Firm' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('VALIDATION_ERROR')
  })

  it('POST /api/beta/request rejects malformed email with 422', async () => {
    const res = await request(app)
      .post('/api/beta/request')
      .send({ email: 'not-an-email', firmName: 'Acme' })
    expect(res.status).toBe(422)
  })
})
