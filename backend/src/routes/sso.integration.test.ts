// =============================================================
// §8.5 — Enterprise SSO.
//
// No identity provider is configured on this deployment, so the IdP is a
// deterministic fixture: tokens are minted here and signed with the tenant's
// own client secret (HS256), which is exactly the verification path the code
// takes for a symmetric provider. That proves the platform's half — state,
// nonce, issuer, audience, expiry, tenant binding, provisioning, enforcement —
// and proves nothing about any real provider, which is stated rather than
// implied.
//
// The sharp claims are the negative ones: a token from another issuer, for
// another audience, with a stale nonce, or belonging to another tenant must
// not authenticate anybody.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import type { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'
import {
  consumeSsoState, passwordLoginAllowed, resolveSsoUser, startSsoLogin, validateIdTokenClaims,
} from '../services/sso/ssoService'
import { verifyIdTokenSignature } from '../services/sso/idTokenVerifier'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser, adminB: TestUser, financeA: TestUser
let memberA: TestUser

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

const ISSUER_A = 'https://idp-a.example.com'
const ISSUER_B = 'https://idp-b.example.com'
const CLIENT_A = 'client-a'
const CLIENT_B = 'client-b'
const SECRET_A = 'sso-client-secret-firm-a-0001'
const SECRET_B = 'sso-client-secret-firm-b-0002'
const SHARED_DOMAIN = 'shared-domain.test'

function idToken(over: Record<string, unknown> = {}, secret = SECRET_A): string {
  return jwt.sign({
    iss: ISSUER_A,
    aud: CLIENT_A,
    sub: 'idp-subject-1',
    nonce: 'nonce',
    email: `person@${SHARED_DOMAIN}`,
    email_verified: true,
    given_name: 'Pat',
    family_name: 'Person',
    exp: Math.floor(Date.now() / 1000) + 300,
    ...over,
  }, secret, { algorithm: 'HS256' })
}

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: ISSUER_A, aud: CLIENT_A, sub: 'idp-subject-1', nonce: 'nonce',
    email: `person@${SHARED_DOMAIN}`, email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 300, ...over,
  }
}

async function configure(firmId: string, over: Record<string, unknown> = {}) {
  const base = {
    consultingFirmId: firmId,
    providerType: 'OIDC' as const,
    enabled: true,
    issuer: firmId === firmA.id ? ISSUER_A : ISSUER_B,
    clientId: firmId === firmA.id ? CLIENT_A : CLIENT_B,
    authorizationUrl: `${firmId === firmA.id ? ISSUER_A : ISSUER_B}/authorize`,
    tokenUrl: `${firmId === firmA.id ? ISSUER_A : ISSUER_B}/token`,
    allowedEmailDomains: [SHARED_DOMAIN],
    autoProvision: false,
    defaultRole: 'VIEWER',
  }
  return prisma.firmSsoConfig.upsert({
    where: { consultingFirmId: firmId },
    create: { ...base, ...over },
    update: { ...base, ...over },
  })
}

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'SSO Firm A' })
  firmB = await createTestFirm({ name: 'SSO Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
  financeA = await createTestUser(firmA.id, { role: 'FINANCE' })
  memberA = await createTestUser(firmA.id, { role: 'CONSULTANT', email: `person@${SHARED_DOMAIN}` })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  await prisma.ssoIdentity.deleteMany({ where: { consultingFirmId: { in: [firmA.id, firmB.id] } } })
  await prisma.ssoLoginState.deleteMany({ where: { consultingFirmId: { in: [firmA.id, firmB.id] } } })
})

// -------------------------------------------------------------
// Configuration
// -------------------------------------------------------------

describe('§8.5 SSO configuration', () => {
  it('never returns the client secret, only whether one is stored', async () => {
    const saved = await request(app).put('/api/sso/admin/config').set(auth(adminA.token)).send({
      providerType: 'OIDC', issuer: ISSUER_A, clientId: CLIENT_A, clientSecret: SECRET_A,
      authorizationUrl: `${ISSUER_A}/authorize`, tokenUrl: `${ISSUER_A}/token`,
      allowedEmailDomains: [SHARED_DOMAIN], enabled: true,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.data.clientSecretConfigured).toBe(true)
    expect(JSON.stringify(saved.body)).not.toContain(SECRET_A)

    const read = await request(app).get('/api/sso/admin/config').set(auth(adminA.token))
    expect(JSON.stringify(read.body)).not.toContain(SECRET_A)
  })

  it('refuses ADMIN as the automatic provisioning role', async () => {
    const res = await request(app).put('/api/sso/admin/config').set(auth(adminA.token))
      .send({ autoProvision: true, defaultRole: 'ADMIN' })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/cannot be the automatic provisioning role/i)
  })

  it('refuses an unknown role and an incomplete enable', async () => {
    expect((await request(app).put('/api/sso/admin/config').set(auth(adminA.token))
      .send({ defaultRole: 'SUPERUSER' })).status).toBe(422)
    expect((await request(app).put('/api/sso/admin/config').set(auth(adminB.token))
      .send({ enabled: true })).status).toBe(422)
  })

  it('refuses the whole surface without SSO_MANAGE', async () => {
    const res = await request(app).get('/api/sso/admin/config').set(auth(financeA.token))
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/SSO_MANAGE/)
  })

  it('writes no secret into the audit trail', async () => {
    const rows = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firmA.id, entityType: 'FirmSsoConfig' },
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(JSON.stringify(rows)).not.toContain(SECRET_A)
  })
})

// -------------------------------------------------------------
// State and nonce
// -------------------------------------------------------------

describe('§8.5 SSO state and nonce', () => {
  beforeEach(async () => { await configure(firmA.id) })

  it('mints a single-use state bound to the tenant', async () => {
    const start = await startSsoLogin(firmA.id, 'https://app.test/callback')
    const consumed = await consumeSsoState(start.state)
    expect(consumed.consultingFirmId).toBe(firmA.id)
    expect(consumed.nonce).toBe(start.nonce)
    await expect(consumeSsoState(start.state)).rejects.toThrow(/invalid or has expired/i)
  })

  it('refuses a state it never minted', async () => {
    await expect(consumeSsoState(crypto.randomBytes(32).toString('base64url')))
      .rejects.toThrow(/invalid or has expired/i)
  })

  it('refuses an expired state', async () => {
    const start = await startSsoLogin(firmA.id, 'https://app.test/callback')
    await prisma.ssoLoginState.updateMany({
      where: { consultingFirmId: firmA.id, consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(consumeSsoState(start.state)).rejects.toThrow(/invalid or has expired/i)
  })

  it('stores only the hash of the state', async () => {
    const start = await startSsoLogin(firmA.id, 'https://app.test/callback')
    const rows = await prisma.ssoLoginState.findMany({ where: { consultingFirmId: firmA.id } })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.stateHash).not.toBe(start.state)
  })

  it('refuses to start when SSO is disabled', async () => {
    await configure(firmA.id, { enabled: false })
    await expect(startSsoLogin(firmA.id, 'https://app.test/callback')).rejects.toThrow(/not enabled/i)
  })
})

// -------------------------------------------------------------
// Claim validation
// -------------------------------------------------------------

describe('§8.5 ID token claims', () => {
  const base = { expectedIssuer: ISSUER_A, expectedAudience: CLIENT_A, expectedNonce: 'nonce' }

  it('accepts a well-formed token', () => {
    expect(() => validateIdTokenClaims({ claims: claims(), ...base })).not.toThrow()
  })

  it('refuses another issuer', () => {
    expect(() => validateIdTokenClaims({ claims: claims({ iss: ISSUER_B }), ...base })).toThrow(/unexpected issuer/i)
  })

  it('refuses another audience', () => {
    expect(() => validateIdTokenClaims({ claims: claims({ aud: CLIENT_B }), ...base })).toThrow(/different application/i)
  })

  it('refuses a replayed nonce', () => {
    expect(() => validateIdTokenClaims({ claims: claims({ nonce: 'stale' }), ...base })).toThrow(/does not match this sign-in/i)
  })

  it('refuses an expired token', () => {
    expect(() => validateIdTokenClaims({
      claims: claims({ exp: Math.floor(Date.now() / 1000) - 10 }), ...base,
    })).toThrow(/expired/i)
  })

  it('refuses a token with no subject', () => {
    expect(() => validateIdTokenClaims({ claims: claims({ sub: '' }), ...base })).toThrow(/no subject/i)
  })
})

// -------------------------------------------------------------
// Signature verification — never optional
// -------------------------------------------------------------

describe('§8.5 ID token signature', () => {
  const config = { issuer: ISSUER_A, clientId: CLIENT_A, clientSecretEnc: SECRET_A, jwksUri: null }

  it('accepts a token signed with the configured secret', async () => {
    await expect(verifyIdTokenSignature(idToken(), config)).resolves.toBeUndefined()
  })

  it('refuses a token signed with a different secret', async () => {
    await expect(verifyIdTokenSignature(idToken({}, 'some-other-secret'), config))
      .rejects.toThrow(/signature is not valid/i)
  })

  it('refuses an unsigned token', async () => {
    const unsigned = jwt.sign(claims(), '', { algorithm: 'none' } as never)
    await expect(verifyIdTokenSignature(unsigned, config)).rejects.toThrow(/unsupported signature algorithm/i)
  })

  it('refuses when no verification key is configured at all', async () => {
    await expect(verifyIdTokenSignature(idToken(), { ...config, clientSecretEnc: null }))
      .rejects.toThrow(/no verification key/i)
  })
})

// -------------------------------------------------------------
// User resolution, provisioning and tenant binding
// -------------------------------------------------------------

describe('§8.5 SSO account linking', () => {
  beforeEach(async () => { await configure(firmA.id); await configure(firmB.id) })

  it('links an existing member on first login, then reuses the link', async () => {
    const first = await resolveSsoUser(firmA.id, claims())
    expect(first.userId).toBe(memberA.id)
    expect(first.provisioned).toBe(false)

    const identity = await prisma.ssoIdentity.findUnique({
      where: { issuer_subject: { issuer: ISSUER_A, subject: 'idp-subject-1' } },
    })
    expect(identity!.userId).toBe(memberA.id)
    expect(identity!.consultingFirmId).toBe(firmA.id)

    const second = await resolveSsoUser(firmA.id, claims({ email: 'changed@elsewhere.test' }))
    // The link wins over the email, which is the point.
    expect(second.userId).toBe(memberA.id)
  })

  it('refuses an unverified email', async () => {
    await expect(resolveSsoUser(firmA.id, claims({ email_verified: false })))
      .rejects.toThrow(/has not verified/i)
  })

  it('refuses a domain the tenant did not allow', async () => {
    await expect(resolveSsoUser(firmA.id, claims({ email: 'someone@not-allowed.test' })))
      .rejects.toThrow(/domain is not allowed/i)
  })

  it('refuses an unknown user when provisioning is off', async () => {
    await expect(resolveSsoUser(firmA.id, claims({ sub: 'nobody', email: `nobody@${SHARED_DOMAIN}` })))
      .rejects.toThrow(/does not create accounts automatically/i)
    expect(await prisma.user.count({ where: { email: `nobody@${SHARED_DOMAIN}` } })).toBe(0)
  })

  it('provisions with the configured default role when the tenant allows it', async () => {
    await configure(firmA.id, { autoProvision: true, defaultRole: 'VIEWER' })
    const email = `new-${Date.now()}@${SHARED_DOMAIN}`
    const result = await resolveSsoUser(firmA.id, claims({ sub: `sub-${Date.now()}`, email }))
    expect(result.provisioned).toBe(true)
    const created = await prisma.user.findUnique({ where: { id: result.userId } })
    expect(created!.role).toBe('VIEWER')
    expect(created!.consultingFirmId).toBe(firmA.id)
    expect(created!.isEmailVerified).toBe(true)
  })

  it('never authenticates one tenant with another tenant’s subject', async () => {
    // Firm A binds the subject.
    await resolveSsoUser(firmA.id, claims())
    // The same issuer and subject presented for Firm B must not work, even
    // though both firms share the email domain.
    await expect(resolveSsoUser(firmB.id, claims())).rejects.toThrow(/not a member of this organization/i)
  })

  it('never links a user who belongs to a different firm', async () => {
    await configure(firmB.id, { allowedEmailDomains: [SHARED_DOMAIN], autoProvision: false })
    // memberA's address is allowed for Firm B's domain list, but memberA is a
    // Firm A user, so Firm B must not adopt them.
    await expect(resolveSsoUser(firmB.id, claims({ iss: ISSUER_B, sub: 'b-subject' })))
      .rejects.toThrow(/does not create accounts automatically/i)
    const identities = await prisma.ssoIdentity.findMany({ where: { userId: memberA.id } })
    for (const identity of identities) expect(identity.consultingFirmId).toBe(firmA.id)
  })

  it('refuses a deactivated account', async () => {
    await resolveSsoUser(firmA.id, claims())
    await prisma.user.update({ where: { id: memberA.id }, data: { isActive: false } })
    await expect(resolveSsoUser(firmA.id, claims())).rejects.toThrow(/no longer active/i)
    await prisma.user.update({ where: { id: memberA.id }, data: { isActive: true } })
  })
})

// -------------------------------------------------------------
// Enforcement and break-glass
// -------------------------------------------------------------

describe('§8.5 SSO enforcement', () => {
  it('allows password login when SSO is off or unenforced', async () => {
    await configure(firmA.id, { enabled: false })
    expect((await passwordLoginAllowed(firmA.id, memberA.email)).allowed).toBe(true)
    await configure(firmA.id, { enabled: true, enforced: false })
    expect((await passwordLoginAllowed(firmA.id, memberA.email)).allowed).toBe(true)
  })

  it('refuses password login when enforced, except for a break-glass account', async () => {
    await configure(firmA.id, { enabled: true, enforced: true, breakGlassEmails: [adminA.email] })
    expect((await passwordLoginAllowed(firmA.id, memberA.email)).allowed).toBe(false)
    expect((await passwordLoginAllowed(firmA.id, adminA.email)).allowed).toBe(true)
  })

  it('refuses to lock a firm out of its own tenant when no break-glass account is named', async () => {
    await configure(firmA.id, { enabled: true, enforced: true, breakGlassEmails: [] })
    const decision = await passwordLoginAllowed(firmA.id, memberA.email)
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toMatch(/no break-glass account/i)
  })

  it('applies one firm’s enforcement to that firm only', async () => {
    await configure(firmA.id, { enabled: true, enforced: true, breakGlassEmails: [adminA.email] })
    expect((await passwordLoginAllowed(firmB.id, adminB.email)).allowed).toBe(true)
  })

  it('returns SSO_REQUIRED from the login route rather than a generic failure', async () => {
    const password = 'a-strong-enough-password-1'
    const bcrypt = await import('bcryptjs')
    const user = await prisma.user.create({
      data: {
        consultingFirmId: firmA.id, email: `enforced-${Date.now()}@${SHARED_DOMAIN}`,
        passwordHash: await bcrypt.default.hash(password, 10),
        firstName: 'En', lastName: 'Forced', role: 'CONSULTANT', isActive: true, isEmailVerified: true,
      },
    })
    await configure(firmA.id, { enabled: true, enforced: true, breakGlassEmails: [adminA.email] })
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('SSO_REQUIRED')
    await configure(firmA.id, { enabled: true, enforced: false })
  })
})

// -------------------------------------------------------------
// Discovery leaks nothing
// -------------------------------------------------------------

describe('§8.5 SSO discovery', () => {
  beforeEach(async () => { await configure(firmA.id, { enabled: true }) })

  it('says only whether SSO is available for a domain', async () => {
    const res = await request(app).get('/api/sso/discover').query({ email: `anyone@${SHARED_DOMAIN}` })
    expect(res.status).toBe(200)
    expect(res.body.data.available).toBe(true)
    expect(Object.keys(res.body.data).sort()).toEqual(['available', 'consultingFirmId', 'displayName'])
  })

  it('reveals nothing about whether an address has an account', async () => {
    const known = await request(app).get('/api/sso/discover').query({ email: memberA.email })
    const unknown = await request(app).get('/api/sso/discover').query({ email: `nobody@${SHARED_DOMAIN}` })
    expect(known.body).toEqual(unknown.body)
  })

  it('answers unavailable for a domain nobody configured', async () => {
    const res = await request(app).get('/api/sso/discover').query({ email: 'someone@unconfigured.test' })
    expect(res.body.data).toEqual({ available: false })
  })
})
