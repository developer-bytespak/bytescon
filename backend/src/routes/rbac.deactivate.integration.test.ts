// =============================================================
// B4 — removing a team member (integration, live test DB).
//
// An admin could change a member's role but never remove them: a former
// employee kept access and kept a paid seat. Guards:
//   - deactivation ends the member's EXISTING session at once (without
//     relying on Redis) and frees the seat;
//   - reactivation needs a free seat, and so does adding a member directly;
//   - an admin can't deactivate themselves or the last admin, can't touch
//     another firm's members, and non-admins can't use the actions;
//   - the "accept Terms" token can't be turned into a session.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildJwtPayload, generateToken } from '../middleware/auth'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let otherFirm: TestFirm
let admin: TestUser

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const deactivate = (as: TestUser, id: string) => request(app).post(`/api/rbac/users/${id}/deactivate`).set(auth(as.token))
const reactivate = (as: TestUser, id: string) => request(app).post(`/api/rbac/users/${id}/reactivate`).set(auth(as.token))

beforeAll(() => {
  app = buildTestApp()
})

beforeEach(async () => {
  // Base plan: 3 seats.
  firm = await createTestFirm({ name: 'B4 Seats Firm', plan: 'base' })
  otherFirm = await createTestFirm({ name: 'B4 Other Firm', plan: 'base' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
})

afterEach(async () => {
  await cleanupFirm(firm?.id).catch(() => {
    // already removed
  })
  await cleanupFirm(otherFirm?.id).catch(() => {
    // already removed
  })
})

afterAll(async () => {
  await disconnectDb()
})

describe('deactivating a member', () => {
  it('ends their open session immediately and keeps the account for history', async () => {
    const member = await createTestUser(firm.id, { role: 'CONSULTANT' })
    expect((await request(app).get('/api/rbac/me').set(auth(member.token))).status).toBe(200)

    const res = await deactivate(admin, member.id)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: member.id, isActive: false })

    // Same, still-unexpired token — refused at once.
    const after = await request(app).get('/api/rbac/me').set(auth(member.token))
    expect(after.status).toBe(401)

    const row = await prisma.user.findUnique({ where: { id: member.id }, select: { isActive: true } })
    expect(row).toEqual({ isActive: false })
  })

  it('voids their unused invite / password-reset links', async () => {
    const member = await createTestUser(firm.id, { role: 'CONSULTANT' })
    await prisma.passwordResetToken.create({
      data: { userId: member.id, token: `b4-${Date.now()}-${Math.random()}`, expiresAt: new Date(Date.now() + 3_600_000) },
    })
    await deactivate(admin, member.id)
    const open = await prisma.passwordResetToken.count({ where: { userId: member.id, usedAt: null } })
    expect(open).toBe(0)
  })

  it('frees their seat; reactivating needs a free seat again', async () => {
    const a = await createTestUser(firm.id, { role: 'CONSULTANT' })
    await createTestUser(firm.id, { role: 'CONSULTANT' }) // 3 of 3 seats used
    const addFourth = () => request(app).post('/api/auth/register-user').set(auth(admin.token))
      .send({ email: `b4-${Date.now()}-${Math.random()}@test.local`, password: 'Str0ng!Passw0rd#2026', firstName: 'New', lastName: 'Hire' })

    // Full: adding directly is refused (it used to bypass the limit).
    const full = await addFourth()
    expect(full.status).toBe(403)
    expect(full.body.code).toBe('TIER_LIMIT')

    expect((await deactivate(admin, a.id)).status).toBe(200)
    expect((await addFourth()).status).toBeLessThan(300)

    // Full again — the deactivated member can't come back over the limit.
    const back = await reactivate(admin, a.id)
    expect(back.status).toBe(403)
    expect(back.body.code).toBe('TIER_LIMIT')
  })

  it('reactivation restores access with a fresh sign-in', async () => {
    const member = await createTestUser(firm.id, { role: 'CONSULTANT' })
    await deactivate(admin, member.id)
    expect((await reactivate(admin, member.id)).status).toBe(200)
    // A token minted after reactivation (what a new sign-in issues) works.
    await new Promise((r) => setTimeout(r, 1100))
    const fresh = generateToken(buildJwtPayload({ userId: member.id, consultingFirmId: firm.id, role: 'CONSULTANT', email: member.email }))
    expect((await request(app).get('/api/rbac/me').set(auth(fresh))).status).toBe(200)
  })
})

describe('deactivation rules', () => {
  it('an admin cannot deactivate themselves', async () => {
    const res = await deactivate(admin, admin.id)
    expect(res.status).toBe(422)
    const row = await prisma.user.findUnique({ where: { id: admin.id }, select: { isActive: true } })
    expect(row?.isActive).toBe(true)
  })

  it('the last active admin cannot be deactivated', async () => {
    // A non-admin who was granted the access-management permission.
    const manager = await createTestUser(firm.id, { role: 'CONTRACTS', extraPermissions: ['ADMIN_SETTINGS'] })
    const res = await deactivate(manager, admin.id)
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/last administrator/i)

    // With a second admin, the first can be removed.
    await createTestUser(firm.id, { role: 'ADMIN' })
    expect((await deactivate(manager, admin.id)).status).toBe(200)
  })

  it('cannot touch another firm’s member', async () => {
    const outsider = await createTestUser(otherFirm.id, { role: 'CONSULTANT' })
    const res = await deactivate(admin, outsider.id)
    expect(res.status).toBe(404)
    const row = await prisma.user.findUnique({ where: { id: outsider.id }, select: { isActive: true } })
    expect(row?.isActive).toBe(true)
  })

  it('non-admins cannot deactivate anyone', async () => {
    const member = await createTestUser(firm.id, { role: 'CONSULTANT' })
    const target = await createTestUser(firm.id, { role: 'VIEWER' })
    const res = await deactivate(member, target.id)
    expect(res.status).toBe(403)
  })

  it('an "accept Terms" token of a deactivated member cannot become a session', async () => {
    const member = await createTestUser(firm.id, { role: 'CONSULTANT' })
    const scoped = generateToken(buildJwtPayload({
      userId: member.id, consultingFirmId: firm.id, role: 'CONSULTANT', email: member.email, scope: 'accept_agreements',
    }))
    await deactivate(admin, member.id)
    const res = await request(app).post('/api/auth/complete-agreements').set(auth(scoped)).send({ acceptedTosVersion: 'any' })
    expect(res.status).toBe(401)
  })
})
