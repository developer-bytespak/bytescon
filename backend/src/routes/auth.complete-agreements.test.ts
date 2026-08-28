// =============================================================
// Integration: POST /api/auth/complete-agreements
// Sprint 3.3 — covers the gate-2 completion endpoint shipped in 97c792b2.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { Express } from 'express'
import {
  buildTestApp,
  createTestFirm,
  createTestUser,
  cleanupFirm,
  disconnectDb,
  TestFirm,
  TestUser,
} from '../test-utils/factories'
import { prisma } from '../config/database'
import { config } from '../config/config'

let app: Express
let firm: TestFirm
let user: TestUser
let tosVersion: string

beforeAll(async () => {
  app = buildTestApp()
  // Test fixture: ensure a current TOS exists so the route's
  // getCurrentLegalVersions() helper finds something. Idempotent.
  const tos = await prisma.termsOfServiceVersion.upsert({
    where: { version: 'test-1.0' },
    create: {
      version: 'test-1.0',
      title: 'Test ToS',
      body: 'Test ToS body',
      contentHash: 'a'.repeat(64),
      effectiveAt: new Date(),
      isCurrent: true,
    },
    update: { isCurrent: true },
  })
  // Mark all other ToS rows non-current so this test's row is THE current one
  await prisma.termsOfServiceVersion.updateMany({
    where: { id: { not: tos.id } },
    data: { isCurrent: false },
  })
  tosVersion = tos.version
})

beforeEach(async () => {
  firm = await createTestFirm({ name: 'Agreement Test Firm' })
  user = await createTestUser(firm.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firm?.id).catch(() => {})
  await disconnectDb()
})

function makeScopedToken(): string {
  return jwt.sign(
    {
      userId: user.id,
      consultingFirmId: firm.id,
      role: 'ADMIN',
      email: user.email,
      scope: 'accept_agreements',
    },
    config.jwt.secret,
    { expiresIn: '15m' },
  )
}

describe('POST /api/auth/complete-agreements', () => {
  it('accepts scoped accept_agreements token + records UserAgreement rows', async () => {
    const scopedToken = makeScopedToken()
    const res = await request(app)
      .post('/api/auth/complete-agreements')
      .set('Authorization', `Bearer ${scopedToken}`)
      .send({ acceptedTosVersion: tosVersion })

    // GA: agreements recorded → full session issued immediately (no questionnaire gate).
    expect(res.status).toBe(200)
    expect(res.body.success).toBe(true)
    expect(res.body.data.token).toBeTruthy()

    const tosRow = await prisma.userAgreement.findUnique({
      where: { userId_documentType_version: { userId: user.id, documentType: 'TOS', version: tosVersion } },
    })
    expect(tosRow).toBeTruthy()
  })

  it('returns 409 TOS_VERSION_MISMATCH when stale ToS version is sent', async () => {
    const scopedToken = makeScopedToken()
    const res = await request(app)
      .post('/api/auth/complete-agreements')
      .set('Authorization', `Bearer ${scopedToken}`)
      .send({ acceptedTosVersion: '0.0.0-stale' })
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('TOS_VERSION_MISMATCH')
  })

  it('rejects unauthenticated calls with 401', async () => {
    const res = await request(app)
      .post('/api/auth/complete-agreements')
      .send({ acceptedTosVersion: tosVersion })
    expect(res.status).toBe(401)
  })
})
