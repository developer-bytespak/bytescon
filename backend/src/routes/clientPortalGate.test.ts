// =============================================================
// Client-portal entitlement gate (integration, live test DB).
// The portal is a firm add-on ('client_portal'): when the owning
// firm's entitlement lapses, its EXTERNAL CLIENT users must be
// locked out of every client-facing route — including login —
// with a neutral PORTAL_UNAVAILABLE (no billing details leaked to
// someone who can't fix them). Firm-side callers on the dual-auth
// thread routes get the standard ADDON_REQUIRED upsell instead.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
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
} from '../test-utils/testClient'

let app: Express
let firm: TestFirm

let seq = 0
const uniq = (prefix: string) => `${prefix}-${Date.now()}-${process.pid}-${++seq}`

const CLIENT_PASSWORD = 'portal-test-pw-1234'

interface PortalClient {
  clientCompanyId: string
  portalUserId: string
  email: string
  token: string
}

async function createPortalClient(consultingFirmId: string): Promise<PortalClient> {
  const company = await prisma.clientCompany.create({
    data: { consultingFirmId, name: uniq('Client Co') },
  })
  const email = `${uniq('portal-user')}@test.local`
  const user = await prisma.clientPortalUser.create({
    data: {
      clientCompanyId: company.id,
      email,
      passwordHash: await bcrypt.hash(CLIENT_PASSWORD, 4),
      firstName: 'Portal',
      lastName: 'Client',
    },
  })
  const token = jwt.sign(
    { clientPortalUserId: user.id, clientCompanyId: company.id, role: 'CLIENT', email },
    config.jwt.secret,
    { expiresIn: '1h', algorithm: 'HS256' },
  )
  return { clientCompanyId: company.id, portalUserId: user.id, email, token }
}

async function grantClientPortalAddon(consultingFirmId: string) {
  await prisma.consultingFirm.update({
    where: { id: consultingFirmId },
    data: { purchasedAddons: { push: 'client_portal' } },
  })
}

beforeAll(() => {
  app = buildTestApp()
})

afterEach(async () => {
  await cleanupFirm(firm?.id).catch(() => {
    // firm may already be gone when a test cleaned up itself
  })
})

afterAll(async () => {
  await disconnectDb()
})

describe('client portal gate — firm WITHOUT the client_portal add-on', () => {
  let client: PortalClient

  beforeEach(async () => {
    // base plan only: baseActive but no add-ons
    firm = await createTestFirm({ name: 'Ungated Portal Firm', plan: 'base' })
    client = await createPortalClient(firm.id)
  })

  it('blocks client login with a neutral PORTAL_UNAVAILABLE', async () => {
    const res = await request(app)
      .post('/api/client-portal/auth/login')
      .send({ email: client.email, password: CLIENT_PASSWORD })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PORTAL_UNAVAILABLE')
    // neutral message — no add-on name or price leaked to the client
    expect(res.body.error).not.toMatch(/\$\d|add-on|Billing/i)
  })

  it('still rejects bad credentials as 401, not 403 (no account probing)', async () => {
    const res = await request(app)
      .post('/api/client-portal/auth/login')
      .send({ email: client.email, password: 'wrong-password' })
    expect(res.status).toBe(401)
  })

  it.each([
    ['GET', '/api/client-portal/dashboard'],
    ['GET', '/api/client-portal/rewards'],
    ['GET', '/api/client-portal/opportunities'],
    ['GET', '/api/client-portal/uploads'],
    ['GET', '/api/client-deliverables/list'],
  ])('blocks %s %s for an existing session token', async (method, path) => {
    const res = await (request(app) as any)
      [method.toLowerCase()](path)
      .set('Authorization', `Bearer ${client.token}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PORTAL_UNAVAILABLE')
  })

  it('blocks the dual-auth thread routes for the client side', async () => {
    const res = await request(app)
      .get(`/api/client-deliverables/${uniq('deliverable')}/comments`)
      .set('Authorization', `Bearer ${client.token}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('PORTAL_UNAVAILABLE')
  })

  it('gives firm-side callers the ADDON_REQUIRED upsell on dual-auth routes', async () => {
    const admin = await createTestUser(firm.id, { role: 'ADMIN' })
    const res = await request(app)
      .get(`/api/client-deliverables/${uniq('deliverable')}/comments`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('ADDON_REQUIRED')
    expect(res.body.addon).toBe('client_portal')
  })
})

describe('client portal gate — entitled firms pass', () => {
  it('base plan + purchased client_portal add-on: login and dashboard work', async () => {
    firm = await createTestFirm({ name: 'Addon Portal Firm', plan: 'base' })
    await grantClientPortalAddon(firm.id)
    const client = await createPortalClient(firm.id)

    const login = await request(app)
      .post('/api/client-portal/auth/login')
      .send({ email: client.email, password: CLIENT_PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body.data.token).toBeTruthy()

    const dash = await request(app)
      .get('/api/client-portal/dashboard')
      .set('Authorization', `Bearer ${client.token}`)
    expect(dash.status).toBe(200)
  })

  it('all-access firm passes without an explicit add-on purchase', async () => {
    firm = await createTestFirm({ name: 'All Access Portal Firm', plan: 'all_access' })
    const client = await createPortalClient(firm.id)

    const dash = await request(app)
      .get('/api/client-portal/dashboard')
      .set('Authorization', `Bearer ${client.token}`)
    expect(dash.status).toBe(200)

    const list = await request(app)
      .get('/api/client-deliverables/list')
      .set('Authorization', `Bearer ${client.token}`)
    expect(list.status).toBe(200)
  })
})

// §8.3 — archiving a client must end its people's portal access, and restoring
// the client must NOT quietly hand it back.
//
// Both halves matter. The first is the security property: a client you closed
// out cannot keep signing in. The second is the honesty property: an admin who
// restores a company should not assume the portal came back with it.
describe('archiving a client and its portal access', () => {
  it('signs the portal users out and refuses their live token', async () => {
    firm = await createTestFirm({ name: uniq('Archive Firm') })
    await grantClientPortalAddon(firm.id)
    const admin = await createTestUser(firm.id, { role: 'ADMIN' })
    const client = await createPortalClient(firm.id)

    // The token works before archiving.
    await request(app).get('/api/client-portal/dashboard')
      .set('Authorization', `Bearer ${client.token}`).expect(200)

    await request(app).patch(`/api/clients/${client.clientCompanyId}/archive`)
      .set('Authorization', `Bearer ${admin.token}`).expect(200)

    const after = await prisma.clientPortalUser.findUnique({ where: { id: client.portalUserId } })
    expect(after!.isActive).toBe(false)

    const blocked = await request(app).get('/api/client-portal/dashboard')
      .set('Authorization', `Bearer ${client.token}`)
    expect(blocked.status).not.toBe(200)
  })

  it('leaves portal users inactive when the client is restored', async () => {
    firm = await createTestFirm({ name: uniq('Restore Firm') })
    await grantClientPortalAddon(firm.id)
    const admin = await createTestUser(firm.id, { role: 'ADMIN' })
    const client = await createPortalClient(firm.id)

    await request(app).patch(`/api/clients/${client.clientCompanyId}/archive`)
      .set('Authorization', `Bearer ${admin.token}`).expect(200)
    await request(app).patch(`/api/clients/${client.clientCompanyId}/restore`)
      .set('Authorization', `Bearer ${admin.token}`).expect(200)

    const company = await prisma.clientCompany.findUnique({ where: { id: client.clientCompanyId } })
    expect(company!.isActive).toBe(true)
    expect(company!.archivedAt).toBeNull()

    // Letting the company back is not the same decision as letting its people
    // back in, so access stays off until someone reactivates each person.
    const user = await prisma.clientPortalUser.findUnique({ where: { id: client.portalUserId } })
    expect(user!.isActive).toBe(false)
  })
})
