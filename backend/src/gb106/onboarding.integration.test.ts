// =============================================================
// GB-106 — integration: the module mounted with the REAL auth guard
// (authenticateJWT + enforceTenantScope + host tenant adapter), exercised
// over HTTP against the live Postgres. Proves:
//   - admin/tenant routes are denied without a valid token (real guard,
//     not the module placeholder)
//   - the migration tables exist and are additive (column-count check)
//   - GET /plan returns a scored plan with the verification queue populated
//   - PUT /progress persists tenant-scoped progress
// =============================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express, { Express } from 'express'
import request from 'supertest'
import { prisma } from '../config/database'
import { errorHandler, notFoundHandler } from '../middleware/errorHandler'
import { authenticateJWT } from '../middleware/auth'
import { enforceTenantScope } from '../middleware/tenant'
import { resolveOnboardingTenant, OnboardingRequest } from '../middleware/onboardingTenant'
import { mountGB106 } from './mount.gb106'
import type { OnboardingPrisma } from './services/onboarding.service'
import { createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let user: TestUser

function buildApp(): Express {
  const a = express()
  a.use(express.json())
  a.use('/api/onboarding', authenticateJWT, enforceTenantScope, resolveOnboardingTenant)
  mountGB106({
    app: a,
    prisma: prisma as unknown as OnboardingPrisma,
    basePath: '/api/onboarding',
    resolveTenant: (req) => (req as OnboardingRequest).onboardingProfile ?? null,
  })
  a.use(notFoundHandler)
  a.use(errorHandler)
  return a
}

beforeAll(async () => {
  app = buildApp()
  firm = await createTestFirm({ name: 'GB106 Firm' })
  user = await createTestUser(firm.id, { role: 'ADMIN' })
  // Ensure the reference catalog is present (idempotent upsert via the service).
  await new (await import('./services/onboarding.service')).OnboardingService(
    prisma as unknown as OnboardingPrisma,
  ).seedPrograms()
})

afterAll(async () => {
  await prisma.onboardingProgress.deleteMany({ where: { tenantId: firm?.id } }).catch(() => {})
  await cleanupFirm(firm?.id).catch(() => {})
  await disconnectDb()
})

describe('GB-106 migration (additive tables)', () => {
  it('created onboarding_programs and onboarding_progress with the expected columns', async () => {
    const rows = await prisma.$queryRaw<{ table_name: string; cols: bigint }[]>`
      SELECT table_name, COUNT(*) as cols
      FROM information_schema.columns
      WHERE table_name IN ('onboarding_programs', 'onboarding_progress')
      GROUP BY table_name
    `
    const byTable = Object.fromEntries(rows.map((r) => [r.table_name, Number(r.cols)]))
    expect(byTable['onboarding_programs']).toBe(22)
    expect(byTable['onboarding_progress']).toBe(9)
  })
})

describe('GB-106 mounted routes behind the real auth guard', () => {
  it('denies GET /plan without a token (real guard, not placeholder)', async () => {
    const res = await request(app).get('/api/onboarding/plan')
    expect(res.status).toBe(401)
  })

  it('denies PUT /progress without a token', async () => {
    const res = await request(app).put('/api/onboarding/progress').send({ programCode: 'SAM_REG', status: 'IN_PROGRESS' })
    expect(res.status).toBe(401)
  })

  it('returns a scored plan with the verification queue populated', async () => {
    const res = await request(app).get('/api/onboarding/plan').set('Authorization', `Bearer ${user.token}`)
    expect(res.status).toBe(200)
    expect(res.body.tenantId).toBe(firm.id)
    expect(Array.isArray(res.body.programs)).toBe(true)
    expect(res.body.programs.length).toBeGreaterThanOrEqual(8)
    expect(res.body.unverifiedProgramCodes).toContain('TMSS_2_0')
    expect(res.body.unverifiedProgramCodes).toContain('POLARIS_SDVOSB')
  })

  it('lists the raw program catalog', async () => {
    const res = await request(app).get('/api/onboarding/programs').set('Authorization', `Bearer ${user.token}`)
    expect(res.status).toBe(200)
    expect(res.body.programs.length).toBeGreaterThanOrEqual(8)
  })

  it('persists tenant-scoped progress via PUT /progress', async () => {
    const res = await request(app)
      .put('/api/onboarding/progress')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ programCode: 'SAM_REG', status: 'IN_PROGRESS', notes: 'started' })
    expect(res.status).toBe(200)

    const row = await prisma.onboardingProgress.findUnique({
      where: { tenantId_programCode: { tenantId: firm.id, programCode: 'SAM_REG' } },
    })
    expect(row?.status).toBe('IN_PROGRESS')
  })

  it('rejects an invalid progress status', async () => {
    const res = await request(app)
      .put('/api/onboarding/progress')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ programCode: 'SAM_REG', status: 'BOGUS' })
    expect(res.status).toBe(400)
  })
})
