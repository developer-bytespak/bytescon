// =============================================================
// The demo site: an operator creates accounts, each has every feature and its own
// sample data until it expires, and nobody else gets in. Files can't move in or
// out, and nothing is emailed.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'
import { getEntitlements, computeMonthlyTokenGrant } from '../services/entitlementService'
import { getFirmPlan, DEMO_AI_CALLS_PER_MONTH } from '../middleware/tierGate'
import { forgetUserStanding } from '../services/userStanding'
import { demoFileGuard } from '../middleware/demoFileGuard'
import { createDemoAccount, DEMO_PROPOSAL_TOKENS, ensureDemoOperator, purgeExpiredDemoAccounts } from '../services/demoAccounts'
import { US_REGIONS } from '../services/demoSampleData'

const uniqEmail = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@demo-test.local`
const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const DAY = 86_400_000

let app: Express
let operatorFirm: TestFirm
let operator: TestUser
let otherFirm: TestFirm
let otherUser: TestUser
const created: string[] = []

const makeAccount = async (days?: number) => {
  const account = await createDemoAccount({ companyName: 'Acme Federal', contactName: 'Pat Lee', email: uniqEmail('client'), days })
  created.push(account.firmId)
  return account
}
const login = (email: string, password: string) => request(app).post('/api/auth/login').send({ email, password })

beforeAll(async () => {
  app = buildTestApp()
  // Sign-in reads the current Terms, and a fresh CI database has none. Same
  // fixture row as auth.complete-agreements.test.ts, so they can run together.
  await prisma.termsOfServiceVersion.upsert({
    where: { version: 'test-1.0' },
    create: { version: 'test-1.0', title: 'Test ToS', body: 'Test ToS body', contentHash: 'a'.repeat(64), effectiveAt: new Date(), isCurrent: true },
    update: { isCurrent: true },
  })
  operatorFirm = await createTestFirm({ name: 'Demo Operators' })
  operator = await createTestUser(operatorFirm.id, { role: 'ADMIN' })
  otherFirm = await createTestFirm({ name: 'Not A Demo Firm' })
  otherUser = await createTestUser(otherFirm.id, { role: 'ADMIN' })
})

afterEach(() => vi.unstubAllEnvs())

afterAll(async () => {
  for (const id of created) await cleanupFirm(id)
  await cleanupFirm(operatorFirm.id)
  await cleanupFirm(otherFirm.id)
  await disconnectDb()
})

const demoSite = () => {
  vi.stubEnv('APP_ENV', 'demo')
  vi.stubEnv('PLATFORM_ADMIN_EMAILS', operator.email)
}

describe('creating an account', () => {
  it('expires in 14 days by default, and honours a chosen length', async () => {
    const standard = await makeAccount()
    expect(Math.round((standard.expiresAt.getTime() - Date.now()) / DAY)).toBe(14)
    const short = await makeAccount(3)
    expect(Math.round((short.expiresAt.getTime() - Date.now()) / DAY)).toBe(3)
  })

  it('refuses a silly length or a duplicate email', async () => {
    const email = uniqEmail('dup')
    await expect(createDemoAccount({ companyName: 'A', contactName: 'B', email, days: 0 })).rejects.toThrow(/Days must/)
    await expect(createDemoAccount({ companyName: 'A', contactName: 'B', email, days: 91 })).rejects.toThrow(/Days must/)
    const first = await createDemoAccount({ companyName: 'A', contactName: 'B', email })
    created.push(first.firmId)
    await expect(createDemoAccount({ companyName: 'C', contactName: 'D', email })).rejects.toThrow(/already exists/)
  })

  it('starts with its own sample data on every main screen', async () => {
    const { firmId } = await makeAccount()
    const where = { where: { consultingFirmId: firmId } }
    expect(await prisma.clientCompany.count(where)).toBe(3)
    expect(await prisma.opportunity.count(where)).toBeGreaterThanOrEqual(8)
    expect(await prisma.bidPursuit.count(where)).toBeGreaterThan(0)
    expect(await prisma.proposal.count(where)).toBe(1)
    expect(await prisma.proposalSection.count(where)).toBeGreaterThan(0)
    expect(await prisma.contract.count(where)).toBe(1)
    expect(await prisma.partner.count(where)).toBeGreaterThan(0)
    // Flagged rows are hidden from normal lists, so sample rows must not be.
    expect(await prisma.opportunity.count({ where: { consultingFirmId: firmId, isDemo: true } })).toBe(0)
  })

  it('gives two accounts separate data', async () => {
    const a = await makeAccount()
    const b = await makeAccount()
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: a.firmId } })
    expect(await prisma.opportunity.count({ where: { consultingFirmId: b.firmId } })).toBeGreaterThanOrEqual(8)
  })
})

describe('what an account can use', () => {
  it('has every feature with a limited AI allowance until it expires', async () => {
    const { firmId } = await makeAccount()
    const ents = await getEntitlements(firmId)
    expect(ents.allAccess).toBe(true)
    expect(ents.source).toBe('demo')
    expect(computeMonthlyTokenGrant(ents)).toBe(0)
    expect((await getFirmPlan(firmId)).aiCallsPerMonth).toBe(DEMO_AI_CALLS_PER_MONTH)
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firmId } })).proposalTokens).toBe(DEMO_PROPOSAL_TOKENS)
  })

  it('loses them when it expires', async () => {
    const { firmId } = await makeAccount()
    await prisma.consultingFirm.update({ where: { id: firmId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } })
    const ents = await getEntitlements(firmId)
    expect(ents.allAccess).toBe(false)
    expect(ents.baseActive).toBe(false)
  })
})

describe('signing in on the demo site', () => {
  it('lets an active account straight in, with no email check or MFA', async () => {
    demoSite()
    const { email, password } = await makeAccount()
    const res = await login(email, password)
    expect(res.status).toBe(200)
    expect(res.body.data?.token ?? res.body.token).toBeTruthy()
  })

  it('shows the demo-ended message after expiry', async () => {
    demoSite()
    const { email, password, firmId } = await makeAccount()
    await prisma.consultingFirm.update({ where: { id: firmId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } })
    const res = await login(email, password)
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('DEMO_EXPIRED')
    expect(res.body.error).toMatch(/demo has ended/i)
  })

  it('does not reveal an expired account to someone without the password', async () => {
    demoSite()
    const { email, firmId } = await makeAccount()
    await prisma.consultingFirm.update({ where: { id: firmId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } })
    expect((await login(email, 'wrong-password')).status).toBe(401)
  })

  it('ends a session already open when the demo ends', async () => {
    const { email, password, firmId } = await makeAccount()
    demoSite()
    const token = (await login(email, password)).body
    const jwt = token.data?.token ?? token.token
    expect((await request(app).get('/api/demo/status').set(H(jwt))).status).toBe(200)

    await request(app).post(`/api/demo/accounts/${firmId}/end`).set(H(operator.token)).expect(200)
    expect((await request(app).get('/api/demo/status').set(H(jwt))).status).toBe(401)
  })

  it('keeps out any account that is not a demo account', async () => {
    demoSite()
    forgetUserStanding(otherUser.id)
    expect((await request(app).get('/api/demo/status').set(H(otherUser.token))).status).toBe(401)
  })

  it('refuses a correct password from an account that is not a demo account', async () => {
    demoSite()
    const { email, password, firmId } = await makeAccount()
    await prisma.consultingFirm.update({ where: { id: firmId }, data: { demoExpiresAt: null } })
    const res = await login(email, password)
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid credentials')
  })

  it('closes public sign-up', async () => {
    demoSite()
    const res = await request(app).post('/api/auth/register-firm').send({ firmName: 'X', contactEmail: uniqEmail('x') })
    expect(res.status).toBe(403)
  })

  it('changes nothing outside the demo site', async () => {
    forgetUserStanding(otherUser.id)
    expect((await request(app).get('/api/demo/status').set(H(otherUser.token))).status).toBe(200)
  })
})

describe('the operator screen', () => {
  it('is closed to everyone but operators', async () => {
    demoSite()
    const { email, password } = await makeAccount()
    const client = (await login(email, password)).body
    const jwt = client.data?.token ?? client.token
    expect((await request(app).get('/api/demo/accounts').set(H(jwt))).status).toBe(403)
    expect((await request(app).post('/api/demo/accounts').set(H(jwt)).send({ companyName: 'x', contactName: 'y', email: uniqEmail('z') })).status).toBe(403)
  })

  it('creates an account and shows its password once', async () => {
    demoSite()
    const email = uniqEmail('made')
    const res = await request(app).post('/api/demo/accounts').set(H(operator.token)).send({ companyName: 'Beta LLC', contactName: 'Sam Roe', email, days: 7 })
    expect(res.status).toBe(201)
    created.push(res.body.data.firmId)
    expect(res.body.data.password.length).toBeGreaterThanOrEqual(12)
    expect((await login(email, res.body.data.password)).status).toBe(200)

    const list = await request(app).get('/api/demo/accounts').set(H(operator.token))
    const row = list.body.data.accounts.find((a: { email: string }) => a.email === email)
    expect(row.companyName).toBe('Beta LLC')
    expect(row.expired).toBe(false)
    expect(JSON.stringify(list.body)).not.toContain(res.body.data.password)
  })

  it('reopens an expired demo, and replaces a lost password', async () => {
    demoSite()
    const { email, password, firmId } = await makeAccount()
    await prisma.consultingFirm.update({ where: { id: firmId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } })
    await request(app).post(`/api/demo/accounts/${firmId}/extend`).set(H(operator.token)).send({ days: 5 }).expect(200)
    expect((await login(email, password)).status).toBe(200)

    const reset = await request(app).post(`/api/demo/accounts/${firmId}/reset-password`).set(H(operator.token)).expect(200)
    expect((await login(email, password)).status).toBe(401)
    expect((await login(email, reset.body.data.password)).status).toBe(200)
  })

  it('cannot change a firm that is not a demo account', async () => {
    demoSite()
    await request(app).post(`/api/demo/accounts/${otherFirm.id}/end`).set(H(operator.token)).expect(404)
    await request(app).post(`/api/demo/accounts/${otherFirm.id}/reset-password`).set(H(operator.token)).expect(404)
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: otherFirm.id } })).demoExpiresAt).toBeNull()
  })
})

describe('choosing a state on the operator form', () => {
  const post = (body: Record<string, unknown>) => request(app).post('/api/demo/accounts').set(H(operator.token)).send({
    companyName: 'State Firm Test', contactName: 'Pat Lee', email: uniqEmail('state'), ...body,
  })

  it('starts the account with that state\'s invented companies', async () => {
    demoSite()
    const region = US_REGIONS.find((r) => r.state === 'TX')!
    const res = await post({ state: 'TX' }).expect(201)
    created.push(res.body.data.firmId)
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId: res.body.data.firmId } })
    expect(clients.map((c) => c.name).sort()).toEqual([...region.clients].sort())
    expect(clients.every((c) => c.state === 'TX')).toBe(true)
    const opportunity = await prisma.opportunity.findFirstOrThrow({ where: { consultingFirmId: res.body.data.firmId } })
    expect(opportunity.placeOfPerformance).toBe(region.placeOfPerformance)
  }, 60_000)

  it('refuses a state it has no companies for, and creates nothing', async () => {
    demoSite()
    const email = uniqEmail('badstate')
    await post({ email, state: 'ZZ' }).expect(422)
    expect(await prisma.user.findUnique({ where: { email } })).toBeNull()
  })

  it('has no way to create accounts in bulk', async () => {
    demoSite()
    await request(app).post('/api/demo/accounts/standard').set(H(operator.token)).expect(404)
  })
})

describe('the operator login at startup', () => {
  const email = () => uniqEmail('operator')

  it('is created from the settings, and can sign in', async () => {
    const address = email()
    vi.stubEnv('APP_ENV', 'demo')
    vi.stubEnv('PLATFORM_ADMIN_EMAILS', address)
    vi.stubEnv('DEMO_ADMIN_EMAIL', address)
    vi.stubEnv('DEMO_ADMIN_PASSWORD', 'a-long-operator-password')
    await ensureDemoOperator()
    const user = await prisma.user.findUniqueOrThrow({ where: { email: address }, include: { consultingFirm: true } })
    expect(await bcrypt.compare('a-long-operator-password', user.passwordHash)).toBe(true)
    expect(user.role).toBe('ADMIN')
    expect(user.isEmailVerified).toBe(true)
    expect(user.consultingFirm.isOwnerComp).toBe(true)

    // A restart must not reset the password someone may have changed.
    vi.stubEnv('DEMO_ADMIN_PASSWORD', 'a-different-long-password')
    await ensureDemoOperator()
    const again = await prisma.user.findUniqueOrThrow({ where: { email: address } })
    expect(again.passwordHash).toBe(user.passwordHash)
    await prisma.user.delete({ where: { email: address } })
  })

  it('refuses a short password or an address that is not an operator', async () => {
    const address = email()
    vi.stubEnv('APP_ENV', 'demo')
    vi.stubEnv('PLATFORM_ADMIN_EMAILS', 'someone-else@demo-test.local')
    vi.stubEnv('DEMO_ADMIN_EMAIL', address)
    vi.stubEnv('DEMO_ADMIN_PASSWORD', 'short')
    await expect(ensureDemoOperator()).rejects.toThrow(/12 characters/)
    vi.stubEnv('DEMO_ADMIN_PASSWORD', 'a-long-operator-password')
    await expect(ensureDemoOperator()).rejects.toThrow(/PLATFORM_ADMIN_EMAILS/)
  })
})

describe('removing old accounts', () => {
  it('deletes a demo 30 days after it ended, and keeps everything else', async () => {
    const old = await makeAccount()
    const recent = await makeAccount()
    await prisma.consultingFirm.update({ where: { id: old.firmId }, data: { demoExpiresAt: new Date(Date.now() - 31 * DAY) } })
    await prisma.consultingFirm.update({ where: { id: recent.firmId }, data: { demoExpiresAt: new Date(Date.now() - 29 * DAY) } })

    await purgeExpiredDemoAccounts()

    expect(await prisma.consultingFirm.findUnique({ where: { id: old.firmId } })).toBeNull()
    expect(await prisma.user.findUnique({ where: { email: old.email } })).toBeNull()
    expect(await prisma.consultingFirm.findUnique({ where: { id: recent.firmId } })).not.toBeNull()
    expect(await prisma.consultingFirm.findUnique({ where: { id: otherFirm.id } })).not.toBeNull()
  })
})

describe('no files in the demo', () => {
  const guarded = express()
  guarded.use(demoFileGuard)
  guarded.post('/upload', (_req, res) => { res.json({ reached: true }) })
  guarded.get('/download', (_req, res) => { res.download('/etc/hosts') })
  guarded.get('/sendfile', (_req, res) => { res.sendFile('/etc/hosts') })
  guarded.get('/attachment', (_req, res, next) => {
    try { res.attachment('report.csv').send('a,b') } catch (err) { next(err) }
  })
  guarded.get('/csv', (_req, res, next) => {
    try { res.setHeader('Content-Disposition', 'attachment; filename="x.csv"'); res.send('a,b') } catch (err) { next(err) }
  })
  guarded.get('/json', (_req, res) => { res.json({ ok: true }) })
  guarded.post('/json', express.json(), (req, res) => { res.json(req.body) })
  guarded.use((err: { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    void _next
    res.status(err.statusCode ?? 500).json({ code: err.code })
  })

  it('refuses every upload', async () => {
    const res = await request(guarded).post('/upload').attach('file', Buffer.from('hello'), 'a.pdf')
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('DEMO_NO_FILES')
  })

  it.each(['/download', '/sendfile', '/attachment', '/csv'])('refuses a file sent by %s', async (path) => {
    const res = await request(guarded).get(path)
    expect(res.status).toBe(403)
    expect(res.headers['content-disposition']).toBeUndefined()
  })

  it('leaves normal requests alone', async () => {
    await request(guarded).get('/json').expect(200)
    const res = await request(guarded).post('/json').send({ a: 1 })
    expect(res.body).toEqual({ a: 1 })
  })
})
