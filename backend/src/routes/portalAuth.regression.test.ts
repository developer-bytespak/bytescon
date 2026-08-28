// =============================================================
// Client-portal / dual-auth security regressions.
//
// Covers three defects found by the 2026-07-29 pre-handoff diagnostic, all of
// which were reachable in production:
//
//  1. `authenticateAny` (clientDeliverables.ts) never inspected `payload.scope`,
//     so the MFA-challenge and accept-agreements tokens minted by login's gating
//     flow — which already carry role ADMIN and consultingFirmId — were accepted
//     as full firm sessions on the deliverable comment routes. Holding only a
//     password, with no second factor, granted read+write there.
//  2. `revokeClientTokens` had zero call sites, so deactivating a portal user or
//     resetting their password left their 24h JWT valid.
//  3. `ClientCompany.isActive` was never consulted on the portal side, so
//     soft-deleting a client left all of its contacts able to log in.
//
// Runs against the isolated bytescon_platform_test DB.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
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
let firm: TestFirm
let admin: TestUser
let clientCompanyId: string
let portalUserId: string
let portalToken: string
let deliverableId: string

/** Exactly what login's MFA gate hands back before the second factor. */
function mfaChallengeToken(u: TestUser): string {
  return jwt.sign(
    {
      userId: u.id,
      consultingFirmId: u.consultingFirmId,
      email: u.email,
      role: u.role,
      scope: 'mfa_challenge',
    },
    config.jwt.secret,
    { expiresIn: '8h' },
  )
}

function agreementsToken(u: TestUser): string {
  return jwt.sign(
    {
      userId: u.id,
      consultingFirmId: u.consultingFirmId,
      email: u.email,
      role: u.role,
      scope: 'accept_agreements',
    },
    config.jwt.secret,
    { expiresIn: '1h' },
  )
}

function clientToken(userId: string, companyId: string, email: string): string {
  return jwt.sign(
    { clientPortalUserId: userId, clientCompanyId: companyId, role: 'CLIENT', email },
    config.jwt.secret,
    { expiresIn: '24h' },
  )
}

/**
 * A client token whose `iat` is deliberately in the past.
 *
 * The Redis revocation cutoff is compared with second granularity, so a token
 * minted in the same second as the revocation would NOT look stale and the test
 * would pass for the wrong reason. Signing an explicit iat/exp (hence no
 * `expiresIn`, which jsonwebtoken refuses alongside an explicit exp) removes
 * that race.
 */
function agedClientToken(userId: string, companyId: string, email: string): string {
  const now = Math.floor(Date.now() / 1000)
  return jwt.sign(
    {
      clientPortalUserId: userId,
      clientCompanyId: companyId,
      role: 'CLIENT',
      email,
      iat: now - 120,
      exp: now + 86_400,
    },
    config.jwt.secret,
    { algorithm: 'HS256' },
  )
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Portal Auth Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })

  const company = await prisma.clientCompany.create({
    data: { consultingFirmId: firm.id, name: 'Portal Auth Client', isActive: true },
  })
  clientCompanyId = company.id

  const portalUser = await prisma.clientPortalUser.create({
    data: {
      clientCompanyId: company.id,
      email: `portal-${Date.now()}@example.test`,
      passwordHash: await bcrypt.hash('correct-horse-battery', 12),
      firstName: 'Pat',
      lastName: 'Portal',
      isActive: true,
    },
  })
  portalUserId = portalUser.id
  portalToken = clientToken(portalUser.id, company.id, portalUser.email)

  // Comment threads hang off ClientDocument (the DeliverableComment.deliverable
  // relation), not a separate deliverable model.
  const deliverable = await prisma.clientDocument.create({
    data: {
      consultingFirmId: firm.id,
      clientCompanyId: company.id,
      title: 'Regression deliverable',
      fileName: 'regression.pdf',
      fileType: 'application/pdf',
      storageKey: `test/regression-${Date.now()}.pdf`,
    },
  })
  deliverableId = deliverable.id
})

// Restore both flags after every test. These tests deliberately flip isActive,
// and a mid-test failure would otherwise leave the DB dirty and make a LATER
// test pass for the wrong reason (a 401 caused by leftover state rather than by
// the control under test).
afterEach(async () => {
  await prisma.clientPortalUser
    .update({ where: { id: portalUserId }, data: { isActive: true } })
    .catch(() => {})
  await prisma.clientCompany
    .update({ where: { id: clientCompanyId }, data: { isActive: true } })
    .catch(() => {})
})

afterAll(async () => {
  await prisma.deliverableComment.deleteMany({ where: { deliverableId } }).catch(() => {})
  await prisma.clientDocument.deleteMany({ where: { consultingFirmId: firm.id } }).catch(() => {})
  await cleanupFirm(firm.id)
  await disconnectDb()
})

// -------------------------------------------------------------
describe('authenticateAny rejects scoped (pre-MFA / pre-ToS) tokens', () => {
  const commentPath = () => `/api/client-deliverables/${deliverableId}/comments`

  it('rejects an mfa_challenge token on comment READ (403)', async () => {
    const res = await request(app).get(commentPath()).set('Authorization', `Bearer ${mfaChallengeToken(admin)}`)
    expect(res.status).toBe(403)
  })

  it('rejects an mfa_challenge token on comment WRITE (403) — no comment created', async () => {
    const before = await prisma.deliverableComment.count({ where: { deliverableId } })
    const res = await request(app)
      .post(commentPath())
      .set('Authorization', `Bearer ${mfaChallengeToken(admin)}`)
      .send({ body: 'injected by a pre-MFA token' })
    expect(res.status).toBe(403)
    expect(await prisma.deliverableComment.count({ where: { deliverableId } })).toBe(before)
  })

  it('rejects an accept_agreements token too (403)', async () => {
    const res = await request(app).get(commentPath()).set('Authorization', `Bearer ${agreementsToken(admin)}`)
    expect(res.status).toBe(403)
  })

  it('still allows the same admin with a FULL session token', async () => {
    const res = await request(app).get(commentPath()).set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)
  })

  it('still allows the client portal user', async () => {
    const res = await request(app).get(commentPath()).set('Authorization', `Bearer ${portalToken}`)
    expect(res.status).toBe(200)
  })
})

// -------------------------------------------------------------
describe('portal access revocation actually revokes', () => {
  it('a deactivated portal user is refused even holding a valid unexpired token', async () => {
    // Baseline: the token works.
    const ok = await request(app).get('/api/client-portal/dashboard').set('Authorization', `Bearer ${portalToken}`)
    expect(ok.status).toBe(200)

    await prisma.clientPortalUser.update({ where: { id: portalUserId }, data: { isActive: false } })

    const denied = await request(app).get('/api/client-portal/dashboard').set('Authorization', `Bearer ${portalToken}`)
    expect(denied.status).toBe(401)

    await prisma.clientPortalUser.update({ where: { id: portalUserId }, data: { isActive: true } })
  })

  it('a deactivated portal user is refused on the dual-auth comment routes too', async () => {
    await prisma.clientPortalUser.update({ where: { id: portalUserId }, data: { isActive: false } })
    const res = await request(app)
      .get(`/api/client-deliverables/${deliverableId}/comments`)
      .set('Authorization', `Bearer ${portalToken}`)
    expect(res.status).toBe(401)
    await prisma.clientPortalUser.update({ where: { id: portalUserId }, data: { isActive: true } })
  })

  it('soft-deleting the CLIENT COMPANY also cuts off its contacts', async () => {
    await prisma.clientCompany.update({ where: { id: clientCompanyId }, data: { isActive: false } })

    const res = await request(app).get('/api/client-portal/dashboard').set('Authorization', `Bearer ${portalToken}`)
    expect(res.status).toBe(401)

    await prisma.clientCompany.update({ where: { id: clientCompanyId }, data: { isActive: true } })
  })

  it('a soft-deleted CLIENT COMPANY also cuts off the dual-auth comment routes', async () => {
    // The gap an adversarial review caught: authenticateAny checked the portal
    // user's own isActive but not the company's, so a contact of a deleted
    // client kept comment read/write while being locked out of the portal.
    await prisma.clientCompany.update({ where: { id: clientCompanyId }, data: { isActive: false } })
    try {
      const res = await request(app)
        .get(`/api/client-deliverables/${deliverableId}/comments`)
        .set('Authorization', `Bearer ${portalToken}`)
      expect(res.status).toBe(401)
    } finally {
      await prisma.clientCompany.update({ where: { id: clientCompanyId }, data: { isActive: true } })
    }
  })

  it('admin password reset invalidates the OLD token while the account stays active', async () => {
    // Proves revocation itself works, independently of the isActive check: the
    // account is still active afterwards, so only the Redis cutoff can be what
    // rejects the old token. Deleting the revokeClientTokens call fails this.
    const old = agedClientToken(portalUserId, clientCompanyId, 'aged@example.test')

    const before = await request(app).get('/api/client-portal/dashboard').set('Authorization', `Bearer ${old}`)
    expect(before.status).toBe(200)

    const reset = await request(app)
      .put(`/api/client-portal/admin/users/${portalUserId}/reset-password`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ newPassword: 'a-new-temporary-password' })
    expect(reset.status).toBe(200)

    const after = await request(app).get('/api/client-portal/dashboard').set('Authorization', `Bearer ${old}`)
    expect(after.status).toBe(401)

    // The account must still be active — otherwise this test would pass even
    // with revocation removed.
    const acct = await prisma.clientPortalUser.findUnique({ where: { id: portalUserId } })
    expect(acct?.isActive).toBe(true)
  })

  it('refuses to reset a password for a contact of an inactive client', async () => {
    await prisma.clientCompany.update({ where: { id: clientCompanyId }, data: { isActive: false } })
    try {
      const res = await request(app)
        .put(`/api/client-portal/admin/users/${portalUserId}/reset-password`)
        .set('Authorization', `Bearer ${admin.token}`)
        .send({ newPassword: 'should-not-apply' })
      expect(res.status).toBe(409)
      expect(res.body.code).toBe('CLIENT_INACTIVE')
    } finally {
      await prisma.clientCompany.update({ where: { id: clientCompanyId }, data: { isActive: true } })
    }
  })

  it('DELETE /api/clients/:id deactivates the company AND its portal users', async () => {
    const company = await prisma.clientCompany.create({
      data: { consultingFirmId: firm.id, name: 'To Be Deleted', isActive: true },
    })
    const contact = await prisma.clientPortalUser.create({
      data: {
        clientCompanyId: company.id,
        email: `deleted-${Date.now()}@example.test`,
        passwordHash: await bcrypt.hash('pw', 12),
        firstName: 'Gone',
        lastName: 'Contact',
        isActive: true,
      },
    })

    const res = await request(app).delete(`/api/clients/${company.id}`).set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(200)

    const after = await prisma.clientPortalUser.findUnique({ where: { id: contact.id } })
    expect(after?.isActive).toBe(false)

    const token = clientToken(contact.id, company.id, contact.email)
    const denied = await request(app).get('/api/client-portal/dashboard').set('Authorization', `Bearer ${token}`)
    expect(denied.status).toBe(401)
  })
})
