// =============================================================
// §8 FINAL ACCEPTANCE — the credential-class matrix.
//
// Seven credential types now exist on one platform, all signed or stored by
// the same server. The property that must hold is simple to state and easy to
// lose: EACH CREDENTIAL WORKS IN EXACTLY ONE CLASS.
//
// This suite builds all seven for real and drives every one of them at every
// surface. Any unexpected success is a security defect, not a curiosity — a
// partner token that reaches the internal API is a subcontractor reading the
// prime's pipeline, and that exact bug was found and fixed in §8.3.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { createHash } from 'crypto'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { config } from '../config/config'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let partnerId = ''

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const PASSWORD = 'a-very-strong-password-1'

interface Credential { name: string; token: string }
const credentials: Credential[] = []

/** Every surface a credential could be pointed at, with the class that owns it. */
const SURFACES: Array<{ name: string; owner: string; call: (t: string) => request.Test }> = []

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'TOKEN Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })

  partnerId = (await prisma.partner.create({
    data: { consultingFirmId: firm.id, name: 'TOKEN Partner' }, select: { id: true },
  })).id

  // 1 — internal session
  credentials.push({ name: 'internal JWT', token: admin.token })

  // 2 — client portal
  const clientCompany = await prisma.clientCompany.create({
    data: { consultingFirmId: firm.id, name: 'TOKEN Client' },
    select: { id: true },
  })
  const clientUser = await prisma.clientPortalUser.create({
    data: {
      clientCompanyId: clientCompany.id,
      email: `token-client-${Date.now()}@client.test`,
      passwordHash: '$2b$10$dummytestpasswordhash', firstName: 'C', lastName: 'U', isActive: true,
    },
    select: { id: true, email: true },
  })
  credentials.push({
    name: 'client portal JWT',
    token: jwt.sign(
      { clientPortalUserId: clientUser.id, clientCompanyId: clientCompany.id, consultingFirmId: firm.id, role: 'CLIENT', email: clientUser.email },
      config.jwt.secret, { expiresIn: '1h', algorithm: 'HS256' },
    ),
  })

  // 3 and 4 — partner portal session, and the half-authenticated challenge
  const invited = await request(app).post('/api/partner-portal/admin/users').set(auth(admin.token))
    .send({ partnerId, email: `token-partner-${Date.now()}@ext.test`, firstName: 'P', lastName: 'U' })
  await request(app).post('/api/partner-portal/auth/accept-invite')
    .send({ token: invited.body.data.inviteToken, password: PASSWORD }).expect(200)
  const login = await request(app).post('/api/partner-portal/auth/login')
    .send({ email: invited.body.data.email, password: PASSWORD })
  credentials.push({ name: 'partner portal JWT', token: login.body.data.token })

  const { generatePartnerChallengeToken } = await import('../services/partnerPortal/partnerAccess')
  credentials.push({
    name: 'partner MFA challenge token',
    token: generatePartnerChallengeToken({
      partnerPortalUserId: invited.body.data.id, partnerId, consultingFirmId: firm.id,
      role: 'PARTNER', email: invited.body.data.email,
    }),
  })

  // 5 — public API token
  const publicToken = await request(app).post('/api/admin/mcp/tokens').set(auth(admin.token))
    .send({ name: 'token-audit-public', kind: 'PUBLIC_API', scopes: ['contracts:read', 'opportunities:read'] })
  credentials.push({ name: 'PUBLIC_API token', token: publicToken.body.data.rawToken })

  // 6 — MCP token
  const mcpToken = await request(app).post('/api/admin/mcp/tokens').set(auth(admin.token))
    .send({ name: 'token-audit-mcp' })
  credentials.push({ name: 'MCP token', token: mcpToken.body.data.rawToken })

  // 7 — a raw random string, to prove nothing accepts an unsigned bearer
  credentials.push({ name: 'unsigned random bearer', token: 'a'.repeat(48) })

  SURFACES.push(
    { name: 'internal API', owner: 'internal JWT', call: (t) => request(app).get('/api/crm/contacts').set(auth(t)) },
    { name: 'internal ERP', owner: 'internal JWT', call: (t) => request(app).get('/api/erp/purchase-orders').set(auth(t)) },
    { name: 'internal integrations', owner: 'internal JWT', call: (t) => request(app).get('/api/integrations').set(auth(t)) },
    { name: 'client portal', owner: 'client portal JWT', call: (t) => request(app).get('/api/client-portal/dashboard').set(auth(t)) },
    { name: 'partner portal', owner: 'partner portal JWT', call: (t) => request(app).get('/api/partner-portal/me').set(auth(t)) },
    { name: 'public API v1', owner: 'PUBLIC_API token', call: (t) => request(app).get('/api/v1/contracts').set(auth(t)) },
  )
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('§8 acceptance: the full credential-class matrix', () => {
  it('admits each credential at its own surface and nowhere else', async () => {
    const violations: string[] = []
    const matrix: string[] = []

    for (const credential of credentials) {
      for (const surface of SURFACES) {
        const res = await surface.call(credential.token)
        const admitted = res.status < 400
        const shouldBeAdmitted = credential.name === surface.owner
        matrix.push(`${credential.name} → ${surface.name}: ${res.status}`)
        if (admitted !== shouldBeAdmitted) {
          violations.push(`${credential.name} → ${surface.name} returned ${res.status} (expected ${shouldBeAdmitted ? 'success' : 'refusal'})`)
        }
      }
    }
    // The whole matrix is printed on failure so a regression is diagnosable
    // from the assertion alone.
    expect(violations, matrix.join('\n')).toEqual([])
  })

  it('refuses the half-authenticated partner challenge token at every data route', async () => {
    const challenge = credentials.find((c) => c.name === 'partner MFA challenge token')!
    for (const path of ['/api/partner-portal/me', '/api/partner-portal/engagements', '/api/partner-portal/documents']) {
      const res = await request(app).get(path).set(auth(challenge.token))
      expect([path, res.status]).toEqual([path, 401])
    }
  })

  it('refuses an MCP token at the public API, and sets the discriminator MCP keys on', async () => {
    const mcpToken = credentials.find((c) => c.name === 'MCP token')!
    const publicToken = credentials.find((c) => c.name === 'PUBLIC_API token')!

    expect((await request(app).get('/api/v1/contracts').set(auth(mcpToken.token))).status).toBe(401)

    // The other half of this contract — that MCP's own resolver returns null
    // for a PUBLIC_API token — is asserted in mcp/shared/tests/auth.test.ts,
    // where that resolver lives. This suite deliberately does NOT import it:
    // the backend must not depend on another package's build output, or `tsc`
    // breaks the moment that package has not been built — a fresh clone, CI,
    // or the Docker image, whose build context is ./backend alone.
    //
    // What the backend owns is setting `kind` correctly, so it asserts that.
    const hashOf = (raw: string) => createHash('sha256').update(raw, 'utf8').digest('hex')
    const publicRow = await prisma.apiToken.findUnique({ where: { tokenHash: hashOf(publicToken.token) } })
    const mcpRow = await prisma.apiToken.findUnique({ where: { tokenHash: hashOf(mcpToken.token) } })
    expect(publicRow!.kind).toBe('PUBLIC_API')
    expect(mcpRow!.kind).toBe('MCP')
    // And neither raw token is recoverable from its row.
    expect(publicRow!.tokenHash).not.toBe(publicToken.token)
    expect(mcpRow!.tokenHash).not.toBe(mcpToken.token)
  })

  it('mints an SSO session that is an ordinary internal session, not a seventh class', async () => {
    // The point of the SSO design: nothing downstream can tell how a session
    // was obtained. A token built exactly as the SSO callback builds one must
    // behave identically to a password login's token.
    const { buildJwtPayload, generateToken } = await import('../middleware/auth')
    const ssoSession = generateToken(buildJwtPayload({
      userId: admin.id, consultingFirmId: firm.id, role: 'ADMIN', email: admin.email,
    }))
    expect((await request(app).get('/api/crm/contacts').set(auth(ssoSession))).status).toBe(200)
    // And is refused everywhere an internal session is refused.
    expect((await request(app).get('/api/v1/contracts').set(auth(ssoSession))).status).toBe(401)
    expect((await request(app).get('/api/partner-portal/me').set(auth(ssoSession))).status).toBe(401)
  })

  it('refuses a token signed with the right secret but a forged role', async () => {
    // The §8.3 vulnerability in its general form: a body carrying a role the
    // platform does not issue must not authenticate.
    for (const role of ['SUPERUSER', 'CLIENT', 'PARTNER', 'SYSTEM', '']) {
      const forged = jwt.sign(
        { userId: admin.id, consultingFirmId: firm.id, role, email: admin.email },
        config.jwt.secret, { expiresIn: '1h', algorithm: 'HS256' },
      )
      const res = await request(app).get('/api/crm/contacts').set(auth(forged))
      expect([role, res.status]).toEqual([role, 401])
    }
  })

  it('refuses a token that names another firm than the account it identifies', async () => {
    const otherFirm = await createTestFirm({ name: 'TOKEN Other Firm' })
    const forged = jwt.sign(
      { userId: admin.id, consultingFirmId: otherFirm.id, role: 'ADMIN', email: admin.email },
      config.jwt.secret, { expiresIn: '1h', algorithm: 'HS256' },
    )
    // The permission layer re-reads the user and refuses when the token's firm
    // does not match the account's own.
    const res = await request(app).post('/api/crm/contacts').set(auth(forged))
      .send({ agencyName: 'GSA', fullName: 'Forged' })
    expect(res.status).toBe(403)
    await cleanupFirm(otherFirm.id)
  })
})
