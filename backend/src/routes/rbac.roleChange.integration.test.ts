// =============================================================
// B7 — a role change applies at once (integration, live test DB).
//
// Session tokens carry the role from sign-in and last hours. Role checks
// (`requireRole`, `req.user.role`) used to trust that copy, so a demoted admin
// kept admin powers until the token expired. Guards:
//   - every request uses the role the account holds now, even when the Redis
//     revocation cutoff is missing (Redis is fail-open);
//   - a role change also ends the member's sessions, so they sign in again
//     with screens that match the new role; a permission-only change does not;
//   - members with granular roles (FINANCE, VIEWER, …) can be issued a session.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildJwtPayload, generateToken } from '../middleware/auth'
import { redis } from '../config/redis'
import { forgetUserStanding } from '../services/userStanding'
import { ROLES } from '../services/rbac/permissions'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
/** An ADMIN-only route (`requireRole('ADMIN')`). */
const adminOnly = (token: string) => request(app).get('/api/firm/audit-log/export?days=1').set(auth(token))
const setRole = (as: TestUser, id: string, body: Record<string, unknown>) =>
  request(app).put(`/api/rbac/users/${id}`).set(auth(as.token)).send(body)

/** Simulates free-plan Redis losing the revocation cutoff. */
async function dropRevocationCutoff(userId: string) {
  const keys = await redis.keys(`*${userId}*`)
  if (keys.length) await redis.del(...keys)
}

beforeAll(() => {
  app = buildTestApp()
})

beforeEach(async () => {
  firm = await createTestFirm({ name: 'B7 Role Change Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
})

afterEach(async () => {
  await cleanupFirm(firm?.id).catch(() => {
    // already removed
  })
})

afterAll(async () => {
  await disconnectDb()
})

describe('demoting an admin', () => {
  it('removes admin powers from their existing session at once', async () => {
    const second = await createTestUser(firm.id, { role: 'ADMIN' })
    expect((await adminOnly(second.token)).status).toBe(200)

    expect((await setRole(admin, second.id, { role: 'CONSULTANT' })).status).toBe(200)

    const after = await adminOnly(second.token)
    expect(after.status).not.toBe(200)
  })

  it('still refuses admin routes when the Redis sign-out record is lost', async () => {
    const second = await createTestUser(firm.id, { role: 'ADMIN' })
    expect((await setRole(admin, second.id, { role: 'CONSULTANT' })).status).toBe(200)
    await dropRevocationCutoff(second.id)
    forgetUserStanding(second.id)

    // The old token still says ADMIN; the account now says CONSULTANT.
    const after = await adminOnly(second.token)
    expect(after.status).toBe(403)
  })

  it('ends their sessions so they sign in again with the new role', async () => {
    const second = await createTestUser(firm.id, { role: 'ADMIN' })
    // A session signed in a minute ago (the cutoff ends tokens issued before it).
    const earlier = generateToken({
      ...buildJwtPayload({ userId: second.id, consultingFirmId: firm.id, role: 'ADMIN', email: second.email }),
      iat: Math.floor(Date.now() / 1000) - 60,
    })
    expect((await request(app).get('/api/rbac/me').set(auth(earlier))).status).toBe(200)
    expect((await setRole(admin, second.id, { role: 'CONSULTANT' })).status).toBe(200)
    expect((await request(app).get('/api/rbac/me').set(auth(earlier))).status).toBe(401)
  })
})

describe('the role used for each request', () => {
  it('is the role on the account, not the one in the token', async () => {
    // A token minted while the member was a consultant, after they were promoted.
    const member = await createTestUser(firm.id, { role: 'CONSULTANT' })
    await prisma.user.update({ where: { id: member.id }, data: { role: 'ADMIN' } })
    forgetUserStanding(member.id)
    expect((await adminOnly(member.token)).status).toBe(200)
  })

  it('does not sign anyone out when only extra permissions change', async () => {
    const member = await createTestUser(firm.id, { role: 'CONTRACTS' })
    const res = await setRole(admin, member.id, { extraPermissions: ['FINANCE_READ'] })
    expect(res.status).toBe(200)
    expect((await request(app).get('/api/rbac/me').set(auth(member.token))).status).toBe(200)
  })

  it('is recorded in the audit log', async () => {
    const second = await createTestUser(firm.id, { role: 'ADMIN' })
    await setRole(admin, second.id, { role: 'VIEWER' })
    const entry = await prisma.auditEvent.findFirst({
      where: { consultingFirmId: firm.id, entityType: 'User', entityId: second.id, action: 'UPDATE' },
    })
    expect(entry?.rationale).toMatch(/ADMIN → VIEWER/)
  })
})

describe('sessions for every internal role', () => {
  it.each(ROLES)('can issue a session token for %s', (role) => {
    const payload = buildJwtPayload({ userId: 'u', consultingFirmId: 'f', role, email: 'x@example.com' })
    expect(payload.role).toBe(role)
    expect(generateToken(payload)).toEqual(expect.any(String))
  })

  it.each(['CLIENT', 'PARTNER', 'SUPERUSER'])('still refuses a session token for %s', (role) => {
    expect(() => buildJwtPayload({ userId: 'u', consultingFirmId: 'f', role, email: 'x@example.com' })).toThrow(
      /Unrecognized user role/,
    )
  })

  it('lets a FINANCE member use the app with a real session token', async () => {
    const member = await createTestUser(firm.id, { role: 'FINANCE' })
    const token = generateToken(
      buildJwtPayload({ userId: member.id, consultingFirmId: firm.id, role: 'FINANCE', email: member.email }),
    )
    const res = await request(app).get('/api/rbac/me').set(auth(token))
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('FINANCE')
  })
})
