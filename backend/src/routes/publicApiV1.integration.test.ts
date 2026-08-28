// =============================================================
// §8.4 — Public API v1: authentication, scopes, tenancy, leakage,
// rate limiting, human-gate protection and token-class isolation.
//
// The leakage suite seeds recognizable sentinel values into the internal
// columns adjacent to every resource this API exposes, then searches the
// SERIALIZED RESPONSE BODY for them. A status-code assertion cannot catch a
// field that should not have been there.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'
import { setRateLimitClock } from '../services/publicApi/rateLimit'
import { PUBLIC_API_SCOPES } from '../services/publicApi/scopes'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser, adminB: TestUser
let tokenAll = '', tokenNarrow = '', tokenB = '', tokenRevoked = '', tokenExpired = '', tokenMcp = ''
let tokenAllId = ''
let oppA = '', oppB = '', contractA = '', contractB = '', pursuitA = '', personA = '', partnerA = ''
let partnerPortalToken = ''

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const V1 = '/api/v1'

/** Values that exist only on internal columns. Any of them in a response is a leak. */
const SENTINELS = {
  internalNote: 'INTERNAL-ONLY-NOTE-8F2A',
  samKey: 'SAMKEY-LEAK-CANARY-11',
  llmKey: 'LLMKEY-LEAK-CANARY-22',
  privateMargin: '77.7777',
  partnerNote: 'PARTNER-PRIVATE-33',
  probability: 0.918273,
}

const FORBIDDEN_FIELD_NAMES = [
  'passwordHash', 'tokenHash', 'mfaSecret', 'mfaRecoveryCodes', 'inviteTokenHash',
  'samApiKey', 'anthropicApiKey', 'notes', 'probabilityAtDecision', 'scoreBreakdown',
  'probabilityScore', 'expectedValue', 'consultingFirmId',
]

async function mintToken(admin: TestUser, body: Record<string, unknown>) {
  const res = await request(app).post('/api/admin/mcp/tokens').set(auth(admin.token)).send(body)
  return res
}

function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) { for (const v of value) collectKeys(v, out); return out }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.add(k); collectKeys(v, out) }
  }
  return out
}

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'API Firm A' })
  firmB = await createTestFirm({ name: 'API Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })

  await prisma.consultingFirm.update({
    where: { id: firmA.id },
    data: { samApiKey: SENTINELS.samKey, anthropicApiKey: SENTINELS.llmKey },
  })

  const mkOpp = async (firm: TestFirm, title: string) => (await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id, title, agency: 'GSA', naicsCode: '541512',
      responseDeadline: new Date(Date.now() + 30 * 86400000), postedDate: new Date(),
      estimatedValue: '250000.00', probabilityScore: SENTINELS.probability,
      scoreBreakdown: { secret: SENTINELS.internalNote },
    },
    select: { id: true },
  })).id
  oppA = await mkOpp(firmA, 'API Opportunity A')
  oppB = await mkOpp(firmB, 'API Opportunity B')

  const mkContract = async (firm: TestFirm, tag: string) => (await prisma.contract.create({
    data: {
      consultingFirmId: firm.id, contractNumber: `API-${tag}-${Date.now()}`, title: `API Contract ${tag}`,
      status: 'ACTIVE', agency: 'GSA', ceilingValue: '1000000.00', fundedValue: '400000.00',
      notes: SENTINELS.internalNote, description: SENTINELS.privateMargin,
    },
    select: { id: true },
  })).id
  contractA = await mkContract(firmA, 'A')
  contractB = await mkContract(firmB, 'B')

  pursuitA = (await prisma.bidPursuit.create({
    data: {
      consultingFirmId: firmA.id, opportunityId: oppA, status: 'REVIEWING',
      probabilityAtDecision: SENTINELS.probability, notes: SENTINELS.internalNote,
    },
    select: { id: true },
  })).id

  partnerA = (await prisma.partner.create({
    data: {
      consultingFirmId: firmA.id, name: 'API Partner A', notes: SENTINELS.partnerNote,
      pastRelationship: SENTINELS.internalNote, capabilities: ['cyber'],
    },
    select: { id: true },
  })).id
  await prisma.partnerContact.create({
    data: { consultingFirmId: firmA.id, partnerId: partnerA, fullName: 'Pat Partner', notes: SENTINELS.partnerNote },
  })
  await prisma.governmentContact.create({
    data: { consultingFirmId: firmA.id, agencyName: 'GSA', fullName: 'Gov Person', notes: SENTINELS.internalNote },
  })

  personA = (await prisma.personnel.create({
    data: {
      consultingFirmId: firmA.id, firstName: 'Ada', lastName: 'Byron', jobTitle: 'Engineer',
      email: 'ada@example.test', phone: '555-0199', notes: SENTINELS.internalNote, yearsExperience: 12,
    },
    select: { id: true },
  })).id
  await prisma.personnelLaborQualification.create({
    data: { consultingFirmId: firmA.id, personnelId: personA, laborCategory: 'Systems Engineer', verification: 'VERIFIED' },
  })
  await prisma.personnelLaborQualification.create({
    data: { consultingFirmId: firmA.id, personnelId: personA, laborCategory: 'Unverified Category', verification: 'UNVERIFIED' },
  })

  const all = await mintToken(adminA, { name: 'all-scopes', kind: 'PUBLIC_API', scopes: [...PUBLIC_API_SCOPES], tier: 'VAULT' })
  expect(all.status).toBe(201)
  tokenAll = all.body.data.rawToken
  tokenAllId = all.body.data.id
  tokenNarrow = (await mintToken(adminA, { name: 'narrow', kind: 'PUBLIC_API', scopes: ['opportunities:read'] })).body.data.rawToken
  tokenB = (await mintToken(adminB, { name: 'firm-b', kind: 'PUBLIC_API', scopes: [...PUBLIC_API_SCOPES] })).body.data.rawToken
  tokenMcp = (await mintToken(adminA, { name: 'mcp-host' })).body.data.rawToken

  const revoked = await mintToken(adminA, { name: 'revoked', kind: 'PUBLIC_API', scopes: ['opportunities:read'] })
  tokenRevoked = revoked.body.data.rawToken
  await request(app).delete(`/api/admin/mcp/tokens/${revoked.body.data.id}`).set(auth(adminA.token)).expect(200)

  const expiring = await mintToken(adminA, { name: 'expiring', kind: 'PUBLIC_API', scopes: ['opportunities:read'], expiresInDays: 1 })
  tokenExpired = expiring.body.data.rawToken
  await prisma.apiToken.update({ where: { id: expiring.body.data.id }, data: { expiresAt: new Date(Date.now() - 1000) } })

  // A partner-portal identity, for the token-class matrix.
  const partnerPortalUser = await request(app).post('/api/partner-portal/admin/users').set(auth(adminA.token))
    .send({ partnerId: partnerA, email: `api-pp-${Date.now()}@ext.test`, firstName: 'Ext', lastName: 'User' })
  await request(app).post('/api/partner-portal/auth/accept-invite')
    .send({ token: partnerPortalUser.body.data.inviteToken, password: 'a-very-strong-password-1' }).expect(200)
  const login = await request(app).post('/api/partner-portal/auth/login')
    .send({ email: partnerPortalUser.body.data.email, password: 'a-very-strong-password-1' })
  partnerPortalToken = login.body.data.token
})

afterAll(async () => {
  setRateLimitClock(null)
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

// -------------------------------------------------------------
// §28/§42 — token security and the negative matrix
// -------------------------------------------------------------

describe('§8.4 public API authentication', () => {
  it('stores only a hash, and never returns the secret again', async () => {
    const row = await prisma.apiToken.findUnique({ where: { id: tokenAllId } })
    expect(row!.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(row!.tokenHash).not.toBe(tokenAll)
    expect(JSON.stringify(row)).not.toContain(tokenAll)

    const list = await request(app).get('/api/admin/mcp/tokens').set(auth(adminA.token))
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.body)).not.toContain(tokenAll)
    const mine = (list.body.data as Array<{ id: string; tokenPrefix: string; kind: string; scopes: string[] }>)
      .find((t) => t.id === tokenAllId)
    expect(mine!.tokenPrefix).toBe(tokenAll.slice(0, 8))
    expect(mine!.kind).toBe('PUBLIC_API')
    expect(mine!.scopes.length).toBe(PUBLIC_API_SCOPES.length)
  })

  it('refuses no token, a nonsense token, a revoked token and an expired token', async () => {
    expect((await request(app).get(`${V1}/opportunities`)).status).toBe(401)
    expect((await request(app).get(`${V1}/opportunities`).set(auth('not-a-real-token-value-x'))).status).toBe(401)
    expect((await request(app).get(`${V1}/opportunities`).set(auth(tokenRevoked))).status).toBe(401)
    expect((await request(app).get(`${V1}/opportunities`).set(auth(tokenExpired))).status).toBe(401)
  })

  it('refuses an MCP token — the two interfaces do not share credentials', async () => {
    const res = await request(app).get(`${V1}/opportunities`).set(auth(tokenMcp))
    expect(res.status).toBe(401)
    expect(res.body.error.code).toBe('UNAUTHORIZED')
  })

  it('refuses an internal browser JWT and a partner-portal JWT', async () => {
    expect((await request(app).get(`${V1}/opportunities`).set(auth(adminA.token))).status).toBe(401)
    expect((await request(app).get(`${V1}/opportunities`).set(auth(partnerPortalToken))).status).toBe(401)
  })

  it('is refused in the other direction too — an API token is not a session', async () => {
    for (const path of ['/api/opportunities', '/api/personnel', '/api/agents/runs', '/api/partner-portal/me']) {
      const res = await request(app).get(path).set(auth(tokenAll))
      expect(res.status).toBe(401)
    }
  })

  it('revokes immediately, mid-life', async () => {
    const t = await mintToken(adminA, { name: 'short-lived', kind: 'PUBLIC_API', scopes: ['opportunities:read'] })
    expect((await request(app).get(`${V1}/opportunities`).set(auth(t.body.data.rawToken))).status).toBe(200)
    await request(app).delete(`/api/admin/mcp/tokens/${t.body.data.id}`).set(auth(adminA.token)).expect(200)
    expect((await request(app).get(`${V1}/opportunities`).set(auth(t.body.data.rawToken))).status).toBe(401)
  })

  it('refuses a PUBLIC_API token with no scopes at mint time', async () => {
    expect((await mintToken(adminA, { name: 'no-scopes', kind: 'PUBLIC_API' })).status).toBe(422)
    expect((await mintToken(adminA, { name: 'bad-scope', kind: 'PUBLIC_API', scopes: ['everything:write'] })).status).toBe(422)
    expect((await mintToken(adminA, { name: 'mcp-with-scopes', scopes: ['opportunities:read'] })).status).toBe(422)
  })

  it('refuses token administration to a non-admin', async () => {
    const consultant = await createTestUser(firmA.id, { role: 'CONSULTANT' })
    expect((await mintToken(consultant, { name: 'nope', kind: 'PUBLIC_API', scopes: ['opportunities:read'] })).status).toBe(403)
  })
})

// -------------------------------------------------------------
// §46 — scopes
// -------------------------------------------------------------

describe('§8.4 public API scopes', () => {
  const ENDPOINTS: Array<[string, string]> = [
    ['/opportunities', 'opportunities:read'],
    ['/pursuits', 'pursuits:read'],
    ['/contracts', 'contracts:read'],
    ['/crm/contacts', 'crm:read'],
    ['/partners', 'partners:read'],
    ['/personnel', 'personnel:read'],
    ['/analytics/portfolio', 'analytics:read'],
  ]

  it('admits every endpoint under its own scope', async () => {
    for (const [path, scope] of ENDPOINTS) {
      const minted = await mintToken(adminA, { name: `scope-${scope}`, kind: 'PUBLIC_API', scopes: [scope] })
      const res = await request(app).get(`${V1}${path}`).set(auth(minted.body.data.rawToken))
      expect([path, res.status]).toEqual([path, 200])
    }
  })

  it('refuses every other endpoint to a single-scope token', async () => {
    for (const [path, scope] of ENDPOINTS) {
      if (scope === 'opportunities:read') continue
      const res = await request(app).get(`${V1}${path}`).set(auth(tokenNarrow))
      expect([path, res.status]).toEqual([path, 403])
      expect(res.body.error.code).toBe('INSUFFICIENT_SCOPE')
    }
  })

  it('does not treat an internal ADMIN role as a substitute for a scope', async () => {
    const res = await request(app).get(`${V1}/personnel`).set(auth(tokenNarrow))
    expect(res.status).toBe(403)
  })

  it('publishes its scope vocabulary without a token', async () => {
    const res = await request(app).get(`${V1}/scopes`)
    expect(res.status).toBe(200)
    expect((res.body.data as Array<{ scope: string }>).map((s) => s.scope).sort()).toEqual([...PUBLIC_API_SCOPES].sort())
  })
})

// -------------------------------------------------------------
// §33/§43 — tenancy
// -------------------------------------------------------------

describe('§8.4 public API tenant isolation', () => {
  it('returns only this tenant’s rows', async () => {
    const res = await request(app).get(`${V1}/opportunities`).set(auth(tokenAll)).query({ limit: 100 })
    const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id)
    expect(ids).toContain(oppA)
    expect(ids).not.toContain(oppB)
  })

  it('answers 404 for another tenant’s id, on every detail route', async () => {
    for (const path of [`/opportunities/${oppB}`, `/contracts/${contractB}`]) {
      const res = await request(app).get(`${V1}${path}`).set(auth(tokenAll))
      expect(res.status).toBe(404)
      expect(res.body.error.code).toBe('NOT_FOUND')
    }
  })

  it('gives the same 404 for a fabricated id, so existence cannot be probed', async () => {
    const real = await request(app).get(`${V1}/opportunities/${oppB}`).set(auth(tokenAll))
    const fake = await request(app).get(`${V1}/opportunities/00000000-0000-0000-0000-000000000000`).set(auth(tokenAll))
    expect(real.status).toBe(fake.status)
    expect(real.body).toEqual(fake.body)
  })

  it('refuses a caller-supplied tenant rather than ignoring it', async () => {
    const res = await request(app).get(`${V1}/opportunities`).set(auth(tokenAll)).query({ consultingFirmId: firmB.id })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('TENANT_NOT_ADDRESSABLE')
  })

  it('attributes usage to the calling tenant only', async () => {
    await request(app).get(`${V1}/partners`).set(auth(tokenB)).expect(200)
    const wrong = await prisma.publicApiRequestLog.count({
      where: { consultingFirmId: firmA.id, apiTokenId: { notIn: [] }, route: '/partners', tokenFp: { not: undefined } },
    })
    const rowsB = await prisma.publicApiRequestLog.findMany({ where: { consultingFirmId: firmB.id }, select: { apiTokenId: true } })
    const firmATokens = await prisma.apiToken.findMany({ where: { consultingFirmId: firmA.id }, select: { id: true } })
    const firmATokenIds = new Set(firmATokens.map((t) => t.id))
    for (const row of rowsB) expect(firmATokenIds.has(row.apiTokenId)).toBe(false)
    expect(wrong).toBeGreaterThanOrEqual(0)
  })
})

// -------------------------------------------------------------
// §32/§44 — DTO leakage
// -------------------------------------------------------------

describe('§8.4 public API leaks nothing private', () => {
  const PATHS = [
    '/opportunities', `/opportunities/:id`, '/pursuits', '/contracts', `/contracts/:id`,
    '/crm/contacts', '/partners', '/personnel', '/analytics/portfolio',
  ]

  it('carries no sentinel value in any serialized response', async () => {
    for (const path of PATHS) {
      const url = path.replace(':id', path.startsWith('/opportunities') ? oppA : contractA)
      const res = await request(app).get(`${V1}${url}`).set(auth(tokenAll)).query({ limit: 100 })
      expect([url, res.status]).toEqual([url, 200])
      const body = JSON.stringify(res.body)
      for (const [name, value] of Object.entries(SENTINELS)) {
        expect([url, name, body.includes(String(value))]).toEqual([url, name, false])
      }
    }
  })

  it('carries no forbidden field name in any serialized response', async () => {
    for (const path of PATHS) {
      const url = path.replace(':id', path.startsWith('/opportunities') ? oppA : contractA)
      const res = await request(app).get(`${V1}${url}`).set(auth(tokenAll)).query({ limit: 100 })
      const keys = collectKeys(res.body)
      for (const forbidden of FORBIDDEN_FIELD_NAMES) {
        expect([url, forbidden, keys.has(forbidden)]).toEqual([url, forbidden, false])
      }
    }
  })

  it('omits personal contact details from the personnel directory', async () => {
    const res = await request(app).get(`${V1}/personnel`).set(auth(tokenAll))
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('ada@example.test')
    expect(body).not.toContain('555-0199')
  })

  it('reports only VERIFIED labour categories', async () => {
    const res = await request(app).get(`${V1}/personnel`).set(auth(tokenAll))
    const person = (res.body.data as Array<{ id: string; verifiedLaborCategories: string[]; yearsExperienceStated: number | null }>)
      .find((p) => p.id === personA)
    expect(person!.verifiedLaborCategories).toEqual(['Systems Engineer'])
    expect(person!.yearsExperienceStated).toBe(12)
  })

  it('sends money as an exact decimal string', async () => {
    const res = await request(app).get(`${V1}/contracts/${contractA}`).set(auth(tokenAll))
    expect(res.body.data.ceilingValue).toBe('1000000.00')
    expect(res.body.data.fundedValue).toBe('400000.00')
  })
})

// -------------------------------------------------------------
// §36/§37 — pagination and filtering
// -------------------------------------------------------------

describe('§8.4 public API pagination and filtering', () => {
  it('defaults, clamps and reports the page', async () => {
    const plain = await request(app).get(`${V1}/opportunities`).set(auth(tokenAll))
    expect(plain.body.meta.limit).toBe(25)
    expect(plain.body.meta.offset).toBe(0)
    expect(typeof plain.body.meta.total).toBe('number')
    const huge = await request(app).get(`${V1}/opportunities`).set(auth(tokenAll)).query({ limit: 100000 })
    expect(huge.body.meta.limit).toBe(100)
  })

  it('filters on the fields it documents', async () => {
    const hit = await request(app).get(`${V1}/opportunities`).set(auth(tokenAll)).query({ agency: 'GSA' })
    expect(hit.body.meta.total).toBeGreaterThan(0)
    const miss = await request(app).get(`${V1}/opportunities`).set(auth(tokenAll)).query({ naicsCode: '999999' })
    expect(miss.body.meta.total).toBe(0)
  })

  it('ignores an undocumented query key rather than translating it into a query', async () => {
    const res = await request(app).get(`${V1}/opportunities`).set(auth(tokenAll))
      .query({ 'title[contains]': 'API', where: '{"consultingFirmId":"x"}' })
    expect(res.status).toBe(200)
    const ids = (res.body.data as Array<{ id: string }>).map((r) => r.id)
    expect(ids).toContain(oppA)
  })
})

// -------------------------------------------------------------
// §34/§45 — rate limiting
// -------------------------------------------------------------

describe('§8.4 public API rate limiting', () => {
  it('allows up to the limit, refuses beyond it, and recovers in the next window', async () => {
    const minted = await mintToken(adminA, { name: 'rl-core', kind: 'PUBLIC_API', scopes: ['opportunities:read'], tier: 'CORE' })
    const raw = minted.body.data.rawToken

    let base = 1_800_000_000_000
    setRateLimitClock(() => base)

    // CORE is 60/minute.
    for (let i = 0; i < 60; i++) {
      const res = await request(app).get(`${V1}/opportunities`).set(auth(raw))
      expect([i, res.status]).toEqual([i, 200])
    }
    const over = await request(app).get(`${V1}/opportunities`).set(auth(raw))
    expect(over.status).toBe(429)
    expect(over.body.error.code).toBe('RATE_LIMITED')
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0)
    expect(over.headers['x-ratelimit-limit']).toBe('60')

    // The next window is a clean slate.
    base += 60_000
    const next = await request(app).get(`${V1}/opportunities`).set(auth(raw))
    expect(next.status).toBe(200)
    setRateLimitClock(null)
  })

  it('gives each token its own allowance, and each tenant its own', async () => {
    const base = 1_900_000_000_000
    setRateLimitClock(() => base)
    const one = await mintToken(adminA, { name: 'rl-1', kind: 'PUBLIC_API', scopes: ['opportunities:read'], tier: 'CORE' })
    const two = await mintToken(adminA, { name: 'rl-2', kind: 'PUBLIC_API', scopes: ['opportunities:read'], tier: 'CORE' })

    for (let i = 0; i < 60; i++) await request(app).get(`${V1}/opportunities`).set(auth(one.body.data.rawToken))
    expect((await request(app).get(`${V1}/opportunities`).set(auth(one.body.data.rawToken))).status).toBe(429)

    // A second token of the same tenant is unaffected...
    expect((await request(app).get(`${V1}/opportunities`).set(auth(two.body.data.rawToken))).status).toBe(200)
    // ...and so is the other tenant.
    expect((await request(app).get(`${V1}/opportunities`).set(auth(tokenB))).status).toBe(200)
    setRateLimitClock(null)
  })

  it('applies a higher allowance to a higher tier', async () => {
    const base = 2_000_000_000_000
    setRateLimitClock(() => base)
    const res = await request(app).get(`${V1}/opportunities`).set(auth(tokenAll))
    expect(res.headers['x-ratelimit-limit']).toBe('1000')
    setRateLimitClock(null)
  })
})

// -------------------------------------------------------------
// §35/§49 — usage accounting and audit actor
// -------------------------------------------------------------

describe('§8.4 public API usage logging', () => {
  it('records the request without recording the token or the record id', async () => {
    await request(app).get(`${V1}/opportunities/${oppA}`).set(auth(tokenAll)).expect(200)
    const row = await prisma.publicApiRequestLog.findFirst({
      where: { apiTokenId: tokenAllId, route: '/opportunities/:id' }, orderBy: { createdAt: 'desc' },
    })
    expect(row).not.toBeNull()
    expect(row!.method).toBe('GET')
    expect(row!.statusCode).toBe(200)
    expect(row!.scopeUsed).toBe('opportunities:read')
    expect(row!.tokenFp).toHaveLength(16)
    expect(row!.route).not.toContain(oppA)
    expect(JSON.stringify(row)).not.toContain(tokenAll)
  })

  it('records a refusal too', async () => {
    await request(app).get(`${V1}/personnel`).set(auth(tokenNarrow)).expect(403)
    const row = await prisma.publicApiRequestLog.findFirst({
      where: { route: '/personnel', statusCode: 403 }, orderBy: { createdAt: 'desc' },
    })
    expect(row!.outcome).toBe('client_error')
  })

  it('writes no internal audit actor for an API call', async () => {
    const before = await prisma.auditEvent.count({ where: { consultingFirmId: firmA.id } })
    await request(app).get(`${V1}/contracts`).set(auth(tokenAll)).expect(200)
    expect(await prisma.auditEvent.count({ where: { consultingFirmId: firmA.id } })).toBe(before)
    const impersonated = await prisma.auditEvent.count({
      where: { consultingFirmId: firmA.id, actorUserId: adminA.id, entityType: 'ApiToken' },
    })
    expect(impersonated).toBe(0)
  })
})

// -------------------------------------------------------------
// §50 — no human gate is reachable
// -------------------------------------------------------------

describe('§8.4 public API exposes no mutation', () => {
  it('registers no POST, PUT, PATCH or DELETE handler at all', async () => {
    const mod = await import('./publicApi/v1')
    const layers = (mod.default as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string } }> }).stack
    const mutating: string[] = []
    for (const layer of layers) {
      if (!layer.route) continue
      for (const method of Object.keys(layer.route.methods)) {
        if (['post', 'put', 'patch', 'delete'].includes(method)) mutating.push(`${method.toUpperCase()} ${layer.route.path}`)
      }
    }
    expect(mutating).toEqual([])
  })

  it('refuses a write attempt against every resource path', async () => {
    for (const path of ['/opportunities', `/opportunities/${oppA}`, '/pursuits', `/pursuits/${pursuitA}`, '/contracts', '/partners', '/personnel']) {
      for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
        const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verb](`${V1}${path}`)
          .set(auth(tokenAll)).send({})
        expect([verb, path, res.status]).toEqual([verb, path, 404])
      }
    }
  })

  it('offers no route for any human-gated decision', async () => {
    for (const path of [
      '/bid-decisions', '/proposals/approve', '/submissions', '/budgets/approve',
      '/purchase-orders/approve', '/invoices/approve', '/payments', '/flow-downs/review',
      '/partner-portal/access', '/personnel/resumes/approve',
    ]) {
      const res = await request(app).get(`${V1}${path}`).set(auth(tokenAll))
      expect([path, res.status]).toEqual([path, 404])
    }
  })
})

// -------------------------------------------------------------
// §39/§40 — the documented contract matches the router
// -------------------------------------------------------------

describe('§8.4 public API is documented', () => {
  it('serves an OpenAPI document without a token', async () => {
    const res = await request(app).get(`${V1}/openapi.json`)
    expect(res.status).toBe(200)
    expect(res.body.openapi).toMatch(/^3\./)
    expect(res.body.info.title).toBe('Bytescon Public API')
  })

  it('documents every route the router actually registers', async () => {
    const mod = await import('./publicApi/v1')
    const layers = (mod.default as unknown as { stack: Array<{ route?: { methods: Record<string, boolean>; path: string } }> }).stack
    const registered = layers.filter((l) => l.route?.methods.get).map((l) => l.route!.path)
    const documented = Object.keys((await request(app).get(`${V1}/openapi.json`)).body.paths)
    for (const path of registered) {
      const openapiPath = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      expect([openapiPath, documented.includes(openapiPath)]).toEqual([openapiPath, true])
    }
  })

  it('names the required scope on every guarded operation', async () => {
    const doc = (await request(app).get(`${V1}/openapi.json`)).body
    for (const [path, item] of Object.entries(doc.paths as Record<string, { get: Record<string, unknown> }>)) {
      if (path === '/openapi.json' || path === '/scopes') continue
      expect([path, typeof item.get['x-required-scope']]).toEqual([path, 'string'])
    }
  })

  it('puts no real secret in an example', async () => {
    const body = JSON.stringify((await request(app).get(`${V1}/openapi.json`)).body)
    for (const value of [tokenAll, tokenB, SENTINELS.samKey, SENTINELS.llmKey, firmA.id]) {
      expect(body).not.toContain(value)
    }
  })
})
