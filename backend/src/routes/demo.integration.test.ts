// =============================================================
// The demo site: an operator creates accounts, each has every feature and its own
// sample data until it expires, and nobody else gets in. Files can't move in or
// out, and nothing is emailed.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import express from 'express'
import bcrypt from 'bcryptjs'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'
import { getEntitlements, computeMonthlyTokenGrant } from '../services/entitlementService'
import { getFirmPlan, DEMO_AI_CALLS_PER_MONTH } from '../middleware/tierGate'
import { forgetUserStanding } from '../services/userStanding'
import { runAgentScheduler } from '../services/agents/scheduler'
import { generateWithRouter } from '../services/llm/llmRouter'
import { AiLimitError } from '../utils/errors'
import { firmHasClientPortal } from '../middleware/clientPortalGate'
import { demoFileGuard } from '../middleware/demoFileGuard'
import { createDemoAccount, DEMO_PROPOSAL_TOKENS, ensureDemoOperator, purgeExpiredDemoAccounts, assignDemoBusinessTypes } from '../services/demoAccounts'
import { regionForState, US_REGIONS, US_STATES } from '../services/demoSampleData'
import { businessTypeByKey, DEFAULT_BUSINESS_TYPE, DEMO_BUSINESS_TYPES, type DemoBusinessType } from '../services/demoBusinessTypes'
import { closeInterruptedPoolPulls, ensurePoolFirm, fillDemoAccount, poolPullStatus, startPoolPull, syncDemoPool, type PoolIngest } from '../services/demoOpportunityPool'
import { ensureDemoPoolAdmin } from '../services/demoAccounts'
import { demoAccessOf } from '../services/demoAccess'
import { OPERATOR_FIRM_EMAIL } from '../services/demoFirms'

const uniqEmail = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@demo-test.local`
const H = (t: string) => ({ Authorization: `Bearer ${t}` })
// The company profile Demo Admin requires: a consulting firm's first client, or a contractor's own company.
const PROFILE = {
  clientName: 'Real Client Co', naicsCodes: ['238210'], uei: 'REALUEI00001', samRegStatus: 'Active',
  capabilityKeywords: ['fiber'], sdvosb: true, smallBusiness: true,
}
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
// Demo accounts take the whole pool, so each test starts with an empty one
// (test database only); a test adds the pool notices it needs.
beforeEach(async () => {
  await prisma.opportunity.deleteMany({ where: { consultingFirmId: (await ensurePoolFirm()).id } })
})

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
    expect(await prisma.proposal.count(where)).toBe(2)
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
    const res = await request(app).post('/api/demo/accounts').set(H(operator.token)).send({ profile: PROFILE, companyName: 'Beta LLC', contactName: 'Sam Roe', email, days: 7 })
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
  const post = (body: Record<string, unknown>) => request(app).post('/api/demo/accounts').set(H(operator.token)).send({ profile: PROFILE, companyName: 'State Firm Test', contactName: 'Pat Lee', email: uniqEmail('state'), ...body,
  })

  it('starts the account with that state\'s invented companies', async () => {
    demoSite()
    const region = US_REGIONS.find((r) => r.state === 'TX')!
    const res = await post({ state: 'TX' }).expect(201)
    created.push(res.body.data.firmId)
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId: res.body.data.firmId } })
    // The operator's client comes first; the other two are that state's invented companies.
    const invented = region.clientPrefixes.map((prefix, i) => `${prefix} ${DEFAULT_BUSINESS_TYPE.clientSuffixes[i]}`).slice(1)
    expect(clients.map((c) => c.name).sort()).toEqual([PROFILE.clientName, ...invented].sort())
    expect(clients.every((c) => c.state === 'TX')).toBe(true)
    const opportunities = await prisma.opportunity.findMany({ where: { consultingFirmId: res.body.data.firmId } })
    expect(opportunities.length).toBeGreaterThan(0)
    for (const opportunity of opportunities) expect(opportunity.placeOfPerformance).toBe(region.placeOfPerformance)
  }, 60_000)

  it('has unique companies for all 50 states and DC', () => {
    expect(US_STATES).toHaveLength(51)
    expect(new Set(US_STATES.map((s) => s.code)).size).toBe(51)
    const names = US_STATES.flatMap((s) => { const r = regionForState(s.code)!; return r.clientPrefixes })
    expect(new Set(names).size).toBe(names.length)
  })

  it('starts a state without hand-named companies with its own names', async () => {
    demoSite()
    const res = await post({ state: 'OH' }).expect(201)
    created.push(res.body.data.firmId)
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId: res.body.data.firmId } })
    expect(clients.map((c) => c.name)).toContain('Ohio Crosspoint Secure Systems')
    expect(clients.every((c) => c.state === 'OH' && c.city === 'Columbus')).toBe(true)
  }, 60_000)

  it('accepts a place typed under Other, and refuses it blank or odd', async () => {
    demoSite()
    const res = await post({ state: 'OTHER', otherLocation: '  Puerto   Rico ' }).expect(201)
    created.push(res.body.data.firmId)
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId: res.body.data.firmId } })
    expect(clients.map((c) => c.name)).toContain('Puerto Rico Crosspoint Secure Systems')
    expect(clients.every((c) => c.state === 'Puerto Rico')).toBe(true)
    await post({ state: 'OTHER', otherLocation: '' }).expect(422)
    await post({ state: 'OTHER', otherLocation: '<script>' }).expect(422)
  }, 60_000)

  it('lists the states for the form', async () => {
    demoSite()
    const res = await request(app).get('/api/demo/accounts').set(H(operator.token)).expect(200)
    expect(res.body.data.states).toHaveLength(51)
    expect(res.body.data.states[0]).toEqual({ code: 'AL', name: 'Alabama' })
  })

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

describe('portals once a demo ends', () => {
  const PASSWORD = 'a-very-strong-password-1'
  const partnerOf = async (firmId: string) => {
    const partner = await prisma.partner.findFirstOrThrow({ where: { consultingFirmId: firmId } })
    const email = uniqEmail('partner')
    await prisma.partnerPortalUser.create({
      data: { consultingFirmId: firmId, partnerId: partner.id, email, firstName: 'Ext', lastName: 'User', passwordHash: await bcrypt.hash(PASSWORD, 4), acceptedAt: new Date() },
    })
    return email
  }
  const partnerLogin = (email: string) => request(app).post('/api/partner-portal/auth/login').send({ email, password: PASSWORD })

  it('stops a partner signing in, and ends their open session', async () => {
    demoSite()
    const account = await makeAccount()
    const email = await partnerOf(account.firmId)
    const { body } = await partnerLogin(email).expect(200)
    await request(app).get('/api/partner-portal/me').set(H(body.data.token)).expect(200)

    await prisma.consultingFirm.update({ where: { id: account.firmId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } })
    await partnerLogin(email).expect(401)
    await request(app).get('/api/partner-portal/me').set(H(body.data.token)).expect(401)
  }, 60_000)

  it('keeps out partners of a firm that is not a demo account', async () => {
    demoSite()
    const partner = await prisma.partner.create({ data: { consultingFirmId: otherFirm.id, name: 'Copied Partner' } })
    const email = uniqEmail('copied')
    await prisma.partnerPortalUser.create({
      data: { consultingFirmId: otherFirm.id, partnerId: partner.id, email, firstName: 'Ext', lastName: 'User', passwordHash: await bcrypt.hash(PASSWORD, 4), acceptedAt: new Date() },
    })
    await partnerLogin(email).expect(401)
    vi.unstubAllEnvs()
    await partnerLogin(email).expect(200)
  })

  it('closes the client portal for expired and non-demo firms', async () => {
    demoSite()
    const account = await makeAccount()
    expect(await firmHasClientPortal(account.firmId)).toBe(true)
    await prisma.consultingFirm.update({ where: { id: account.firmId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } })
    expect(await firmHasClientPortal(account.firmId)).toBe(false)
    expect(await firmHasClientPortal(otherFirm.id)).toBe(false)
  })
})

describe('the AI limit', () => {
  const ask = (firmId: string) => generateWithRouter({ systemPrompt: 'x', userPrompt: 'y', maxTokens: 10 }, firmId, { task: 'AI_ASSISTANT', useCache: false })
  const useUp = (firmId: string, calls: number) => prisma.apiUsageLog.createMany({
    data: Array.from({ length: calls }, () => ({ consultingFirmId: firmId, provider: 'openai', model: 'm', task: 'AI_ASSISTANT', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, cacheHit: false })),
  })
  const noKeys = () => {
    vi.stubEnv('OPENAI_API_KEY', '')
    vi.stubEnv('ANTHROPIC_API_KEY', '')
  }

  it('lets a demo account call the AI until the limit, then refuses', async () => {
    demoSite()
    noKeys()
    const account = await makeAccount()
    await useUp(account.firmId, DEMO_AI_CALLS_PER_MONTH - 1)
    // Reaches the provider step: only the missing key stops it here.
    await expect(ask(account.firmId)).rejects.toThrow('NO_LLM_KEY')
    await useUp(account.firmId, 1)
    await expect(ask(account.firmId)).rejects.toBeInstanceOf(AiLimitError)
  })

  it('covers the chat assistant, which has no check of its own', async () => {
    demoSite()
    const account = await makeAccount()
    await useUp(account.firmId, DEMO_AI_CALLS_PER_MONTH)
    // A token, not a sign-in: this file's sign-ins are close to the login rate limit.
    const member = await createTestUser(account.firmId, { role: 'ADMIN' })
    const res = await request(app).post('/api/assistant/chat').set(H(member.token)).send({ message: 'Hello' })
    expect(res.status).toBe(429)
    expect(res.body.code).toBe('AI_LIMIT')
  })

  it('does not apply outside the demo', async () => {
    noKeys()
    const account = await makeAccount()
    await useUp(account.firmId, DEMO_AI_CALLS_PER_MONTH + 1)
    await expect(ask(account.firmId)).rejects.toThrow('NO_LLM_KEY')
  })
})

describe('the sample work in a new account', () => {
  it('has real bids behind its numbers, and the key screens have content', async () => {
    demoSite()
    const account = await makeAccount()
    const firm = { consultingFirmId: account.firmId }

    const submissions = await prisma.submissionRecord.findMany({ where: firm })
    expect(submissions).toHaveLength(6)
    const stats = await prisma.performanceStats.findMany({ where: { clientCompany: firm } })
    const sum = (key: 'totalSubmitted' | 'totalWon' | 'totalLost') => stats.reduce((total, s) => total + s[key], 0)
    expect(sum('totalSubmitted')).toBe(submissions.length)
    expect(sum('totalWon')).toBe(submissions.filter((s) => s.outcome === 'WON').length)
    expect(sum('totalLost')).toBe(submissions.filter((s) => s.outcome === 'LOST').length)
    for (const s of stats) expect(s.completionRate).toBeLessThanOrEqual(1)

    expect(await prisma.contractInvoice.count({ where: firm })).toBe(3)
    expect(await prisma.contractDeliverable.count({ where: firm })).toBe(3)
    expect(await prisma.timeEntry.count({ where: firm })).toBe(4)
    expect(await prisma.pastPerformanceRecord.count({ where: firm })).toBe(3)
    expect(await prisma.personnel.count({ where: firm })).toBe(3)
    expect(await prisma.governmentContact.count({ where: firm })).toBe(1)
    expect(await prisma.userNotification.count({ where: firm })).toBe(2)
    const narrative = await prisma.capabilityNarrative.findFirstOrThrow({ where: firm })
    expect(narrative.currentApprovedVersionId).toBeTruthy()
  }, 60_000)

  it('makes a funnel that narrows, even when clients have several decisions', async () => {
    demoSite()
    const account = await makeAccount()
    const member = await createTestUser(account.firmId, { role: 'ADMIN' })
    const res = await request(app).get('/api/analytics/pipeline-analysis').set(H(member.token)).expect(200)
    const stage = (from: string) => res.body.data.markovChain.find((s: { from: string }) => s.from === from)
    expect(stage('Submitted').toCount).toBe(2) // won
    expect(stage('Submitted').fromCount).toBe(6)
    expect(stage('Scored').toCount).toBeLessThanOrEqual(stage('Scored').fromCount)
    expect(stage('Bid').toCount).toBeGreaterThanOrEqual(stage('Submitted').toCount)
  }, 60_000)

  it('can generate an outline on every sample proposal', async () => {
    demoSite()
    const account = await makeAccount()
    const member = await createTestUser(account.firmId, { role: 'ADMIN' })
    const proposals = await prisma.proposal.findMany({ where: { consultingFirmId: account.firmId } })
    expect(proposals).toHaveLength(2)
    for (const proposal of proposals) {
      const res = await request(app).post(`/api/proposal/${proposal.id}/outline`).set(H(member.token)).send({})
      expect(res.status).toBeLessThan(300)
    }
  }, 60_000)
})

describe('when a demo ends during a session', () => {
  it('says why, so the login page can explain it', async () => {
    demoSite()
    const account = await makeAccount()
    const member = await createTestUser(account.firmId, { role: 'ADMIN' })
    await prisma.consultingFirm.update({ where: { id: account.firmId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } })
    forgetUserStanding(member.id)
    const res = await request(app).get('/api/opportunities').set(H(member.token)).expect(401)
    expect(res.body.code).toBe('DEMO_EXPIRED')
    expect(res.body.error).toContain('demo has ended')
  })
})

describe('scheduled agents on the demo', () => {
  const scheduleFor = (consultingFirmId: string) => prisma.agentSchedule.create({
    data: { consultingFirmId, agentKey: 'OPPORTUNITY', isEnabled: true, scheduleType: 'INTERVAL', intervalMinutes: 60, nextRunAt: new Date(Date.now() - 60_000) },
  })

  it('run only for demo accounts that have not ended', async () => {
    demoSite()
    const open = await makeAccount()
    const ended = await makeAccount()
    await prisma.consultingFirm.update({ where: { id: ended.firmId }, data: { demoExpiresAt: new Date(Date.now() - 1000) } })
    await Promise.all([scheduleFor(open.firmId), scheduleFor(ended.firmId), scheduleFor(otherFirm.id)])

    const counted = async (firmId: string) => (await runAgentScheduler(new Date(), 50, { consultingFirmId: firmId })).due
    expect(await counted(open.firmId)).toBe(1)
    expect(await counted(ended.firmId)).toBe(0)
    expect(await counted(otherFirm.id)).toBe(0)
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: otherFirm.id } })
  }, 60_000)
})

describe('the pipeline in a demo account', () => {
    const openPipeline = async (token: string) =>
    (await request(app).get('/api/pursuits/pipeline?limit=200').set(H(token)).expect(200)).body.data as { items: Array<{ pipelineStage: string; opportunityId: string; opportunity: { title: string } }>; stageCounts: Record<string, number> }

  it('starts with work in every column', async () => {
    demoSite()
    const account = await makeAccount()
    const member = await createTestUser(account.firmId, { role: 'ADMIN' })
    const { stageCounts } = await openPipeline(member.token)
    for (const stage of ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED']) expect(stageCounts[stage]).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('adds any opportunity without a card to Identified when opened, and keeps cards in their column', async () => {
    demoSite()
    const account = await makeAccount()
    const member = await createTestUser(account.firmId, { role: 'ADMIN' })
    const open = await prisma.opportunity.findMany({ where: { consultingFirmId: account.firmId, status: 'ACTIVE' }, include: { bidPursuits: true } })
    expect(open).toHaveLength(20)
    const fresh = open.filter((o) => o.bidPursuits.length === 0)
    expect(fresh).toHaveLength(16)
    for (const opportunity of open) {
      await request(app).get(`/api/opportunities/${opportunity.id}`).set(H(member.token)).expect(200)
    }
    const { items } = await openPipeline(member.token)
    const stageOf = (id: string) => items.find((item) => item.opportunityId === id)?.pipelineStage
    for (const opportunity of fresh) expect(stageOf(opportunity.id)).toBe('IDENTIFIED')
    const proposal = items.find((item) => item.opportunity.title === 'Security Operations Center Support')
    expect(proposal?.pipelineStage).toBe('PROPOSAL')
  }, 60_000)
})

describe('business types', () => {
  const sectorMatches = (type: DemoBusinessType, naics: string | null) => type.naicsPrefixes.some((prefix) => (naics ?? '').startsWith(prefix))
  const post = (body: Record<string, unknown>) => request(app).post('/api/demo/accounts').set(H(operator.token)).send({ profile: PROFILE, companyName: 'Type Test', contactName: 'Pat Lee', email: uniqEmail('type'), ...body,
  })

  it('has 12 complete types, in the sectors the app already uses', () => {
    expect(DEMO_BUSINESS_TYPES).toHaveLength(12)
    for (const type of DEMO_BUSINESS_TYPES) {
      expect(new Set(type.opportunities).size).toBe(20)
      expect(new Set(type.pastBids).size).toBe(6)
      for (const code of type.naicsCodes) expect(sectorMatches(type, code)).toBe(true)
    }
  })

  it.each(DEMO_BUSINESS_TYPES.map((type) => [type.key, type] as const))('builds a %s account whose whole list matches', async (key, type) => {
    demoSite()
    const res = await post({ businessType: key, state: 'OH' }).expect(201)
    const firmId = res.body.data.firmId
    created.push(firmId)
    const opportunities = await prisma.opportunity.findMany({ where: { consultingFirmId: firmId } })
    expect(opportunities).toHaveLength(26)
    for (const opportunity of opportunities) expect(sectorMatches(type, opportunity.naicsCode)).toBe(true)
    // The invented clients fit the type; the operator's own client keeps its NAICS codes.
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId: firmId } })
    expect(clients.find((c) => c.name === PROFILE.clientName)?.naicsCodes).toEqual(PROFILE.naicsCodes)
    for (const client of clients.filter((c) => c.name !== PROFILE.clientName)) expect(client.naicsCodes.every((code) => sectorMatches(type, code))).toBe(true)
    expect(opportunities.filter((o) => o.status === 'ACTIVE' && (o.probabilityScore ?? 0) > 0)).toHaveLength(20)
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firmId } })).demoBusinessType).toBe(key)
  }, 60_000)

  it('refuses an unknown type', async () => {
    demoSite()
    await post({ businessType: 'NOPE' }).expect(422)
  })

  it('shows every notice, and "Matches my business type" narrows the list to the business', async () => {
    demoSite()
    const res = await post({ businessType: 'HEALTH' }).expect(201)
    const firmId = res.body.data.firmId
    created.push(firmId)
    const member = await createTestUser(firmId, { role: 'ADMIN' })
    const stray = await prisma.opportunity.create({ data: { consultingFirmId: firmId, title: 'Stray IT Work', agency: 'DHS', naicsCode: '541512', samNoticeId: uniqEmail('stray'), responseDeadline: new Date(Date.now() + 30 * DAY), isDemo: false } })
    const ids = async (query: string) => {
      const list = await request(app).get(`/api/opportunities?limit=100${query}`).set(H(member.token)).expect(200)
      return ((list.body.data?.items ?? list.body.data ?? []) as Array<{ id: string }>).map((i) => i.id)
    }
    expect(await ids('')).toContain(stray.id)
    const health = await ids('&match=business')
    expect(health.length).toBeGreaterThan(0)
    expect(health).not.toContain(stray.id)
    const options = await request(app).get('/api/opportunities/match-options').set(H(member.token)).expect(200)
    expect(options.body.data.businessType).toMatchObject({ label: 'Health Care' })
  }, 60_000)

  it('gives older accounts a random type and matching data, keeping logins, and only once', async () => {
    demoSite()
    const account = await makeAccount()
    const firm = { consultingFirmId: account.firmId }
    // An account from before business types, with a stage someone chose and work added.
    await prisma.consultingFirm.update({ where: { id: account.firmId }, data: { demoBusinessType: null } })
    const before = await prisma.user.findUniqueOrThrow({ where: { email: account.email } })
    const opened = await prisma.opportunity.findFirstOrThrow({ where: { ...firm, status: 'ACTIVE', bidPursuits: { none: {} } } })
    await prisma.bidPursuit.create({ data: { ...firm, opportunityId: opened.id, pipelineStage: 'CAPTURE' } })

    await assignDemoBusinessTypes()

    const { demoBusinessType } = await prisma.consultingFirm.findUniqueOrThrow({ where: { id: account.firmId } })
    const type = businessTypeByKey(demoBusinessType) as DemoBusinessType
    expect(type).toBeTruthy()
    expect((await prisma.user.findUniqueOrThrow({ where: { email: account.email } })).passwordHash).toBe(before.passwordHash)
    const opportunities = await prisma.opportunity.findMany({ where: firm })
    expect(opportunities).toHaveLength(26)
    for (const opportunity of opportunities) expect(sectorMatches(type, opportunity.naicsCode)).toBe(true)
    expect(await prisma.clientCompany.count({ where: firm })).toBe(3)

    const ids = opportunities.map((o) => o.id).sort()
    await assignDemoBusinessTypes()
    expect((await prisma.opportunity.findMany({ where: firm })).map((o) => o.id).sort()).toEqual(ids)
  }, 120_000)

  it('leaves firms that are not demo accounts alone', async () => {
    demoSite()
    await assignDemoBusinessTypes()
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: otherFirm.id } })).demoBusinessType).toBeNull()
  }, 120_000)
})

describe('the tour data', () => {
  it('names the account\'s own top opportunity, proposal and contract', async () => {
    demoSite()
    const account = await makeAccount()
    const member = await createTestUser(account.firmId, { role: 'ADMIN' })
    const { body } = await request(app).get('/api/demo/tour').set(H(member.token)).expect(200)
    const tour = body.data
    expect(tour.clients).toBe(3)
    expect(tour.openOpportunities).toBe(20)
    expect(tour.topOpportunity.winProbability).toBeGreaterThan(0)
    expect(['BID_PRIME', 'BID_SUB']).toContain(tour.topOpportunity.recommendation)
    expect(tour.proposal.sections).toBe(3)
    expect(tour.proposal.verifiedRequirements).toBe(5)
    expect(tour.contract.awardValue).toBe(2_400_000)
    // It never reaches into another account.
    const other = await makeAccount()
    const otherOpp = await prisma.opportunity.findMany({ where: { consultingFirmId: other.firmId }, select: { id: true } })
    expect(otherOpp.map((o) => o.id)).not.toContain(tour.topOpportunity.id)
  }, 60_000)
})

describe('real notices from the shared pool', () => {
  const TEST_PREFIX = 'TESTPOOL-'
  const poolNotice = async (naicsCode: string, title: string, daysAhead = 30, postedDaysAgo = 1) => {
    const pool = await ensurePoolFirm()
    return prisma.opportunity.create({
      data: {
        consultingFirmId: pool.id, samNoticeId: `${TEST_PREFIX}${uniqEmail('n')}`, title, agency: 'Department of Testing', naicsCode,
        status: daysAhead > 0 ? 'ACTIVE' : 'EXPIRED', responseDeadline: new Date(Date.now() + daysAhead * DAY), postedDate: new Date(Date.now() - postedDaysAgo * DAY),
        sourceUrl: 'https://sam.gov/opp/test/view', setAsideType: 'SBA', isScored: false,
      },
    })
  }
  const invented = (firmId: string) => prisma.opportunity.findMany({ where: { consultingFirmId: firmId, samNoticeId: { startsWith: 'DEMO-' } }, include: { bidPursuits: true } })
  afterEach(async () => {
    const pool = await ensurePoolFirm()
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: pool.id, samNoticeId: { startsWith: TEST_PREFIX } } })
  })

  it('keeps the invented notices while the pool has nothing for the business', async () => {
    demoSite()
    const account = await makeAccount()
    expect(await fillDemoAccount(account.firmId)).toBe(0)
    expect(await invented(account.firmId)).toHaveLength(26)
  }, 60_000)

  it('keeps the list at twenty: real notices first, invented ones for the shortfall', async () => {
    demoSite()
    await poolNotice('621111', 'Clinic Staffing', 30, 3)
    await poolNotice('621610', 'Home Health Visits', 30, 1)
    await poolNotice('541512', 'Network Support', 30, 1)
    await poolNotice('621111', 'Old Clinic Work', -1, 40)
    const res = await request(app).post('/api/demo/accounts').set(H(operator.token)).send({ profile: PROFILE, companyName: 'Pool Test', contactName: 'Pat Lee', email: uniqEmail('pool'), businessType: 'HEALTH', state: 'OH' }).expect(201)
    const firmId = res.body.data.firmId
    created.push(firmId)
    const open = () => prisma.opportunity.findMany({ where: { consultingFirmId: firmId, status: 'ACTIVE', responseDeadline: { gte: new Date() } }, include: { bidPursuits: true } })
    const isReal = (o: { samNoticeId: string | null }) => !o.samNoticeId?.startsWith('DEMO-')
    let list = await open()
    expect(list).toHaveLength(20)
    // Every open notice in the pool, not only the business type's.
    expect(list.filter(isReal).map((o) => o.title).sort()).toEqual(['Clinic Staffing', 'Home Health Visits', 'Network Support'])
    expect(list.filter(isReal).every((o) => o.source === 'SAM_GOV' && !o.isDemo && o.sourceUrl?.startsWith('https://sam.gov/'))).toBe(true)
    expect(list.filter((o) => o.bidPursuits.length > 0)).toHaveLength(4)

    // Another real one arrives: still twenty, one invented spare gone.
    await poolNotice('621511', 'Lab Testing', 30, 0)
    expect(await fillDemoAccount(firmId)).toBe(1)
    list = await open()
    expect(list).toHaveLength(20)
    expect(list.filter(isReal)).toHaveLength(4)

    // Enough real ones: every invented spare goes, the pipeline ones stay.
    for (let i = 0; i < 20; i++) await poolNotice('621111', `Clinic Work ${i}`, 30, 0)
    expect(await fillDemoAccount(firmId)).toBe(20)
    list = await open()
    expect(list.filter(isReal)).toHaveLength(24)
    expect(list.filter((o) => !isReal(o)).map((o) => o.bidPursuits[0]?.pipelineStage).sort()).toEqual(['CAPTURE', 'IDENTIFIED', 'PROPOSAL', 'QUALIFICATION'])

    // Real ones expire: invented ones come back to make twenty, without repeating titles.
    await prisma.opportunity.updateMany({ where: { consultingFirmId: firmId, title: { startsWith: 'Clinic Work' } }, data: { status: 'EXPIRED' } })
    expect(await fillDemoAccount(firmId)).toBe(0)
    list = await open()
    expect(list).toHaveLength(20)
    expect(new Set(list.map((o) => o.title)).size).toBe(20)
  }, 90_000)

  it('tops up from the pool on Sync Contracts even when SAM.gov cannot be reached', async () => {
    demoSite()
    vi.stubEnv('SAM_API_KEY', '')
    const pool = await ensurePoolFirm()
    await prisma.consultingFirm.update({ where: { id: pool.id }, data: { lastIngestedAt: null } })
    await poolNotice('811310', 'Forklift Repair')
    const res = await request(app).post('/api/demo/accounts').set(H(operator.token)).send({ profile: PROFILE, companyName: 'Sync Test', contactName: 'Pat Lee', email: uniqEmail('sync'), businessType: 'OTHER_SERVICES', state: 'OH' }).expect(201)
    const firmId = res.body.data.firmId
    created.push(firmId)
    const member = await createTestUser(firmId, { role: 'ADMIN' })
    await poolNotice('811210', 'Radio Bench Repair')
    const { body } = await request(app).post('/api/jobs/ingest').set(H(member.token)).send({}).expect(200)
    let job = null as null | { status: string; opportunitiesNew: number | null; errorDetail: string | null }
    for (let i = 0; i < 100 && job?.status !== 'COMPLETE' && job?.status !== 'FAILED'; i++) {
      await new Promise((r) => setTimeout(r, 100))
      job = await prisma.ingestionJob.findUniqueOrThrow({ where: { id: body.data.jobId } })
    }
    expect(job?.status).toBe('COMPLETE')
    expect(job?.opportunitiesNew).toBe(1)
    expect(job?.errorDetail).toContain('could not be reached')
    expect(await prisma.opportunity.count({ where: { consultingFirmId: firmId, title: 'Radio Bench Repair' } })).toBe(1)
  }, 60_000)

  it('keeps an invented notice the client opened, and real ones land in Identified when opened', async () => {
    demoSite()
    const account = await makeAccount()
    const member = await createTestUser(account.firmId, { role: 'ADMIN' })
    const opened = await prisma.opportunity.findFirstOrThrow({ where: { consultingFirmId: account.firmId, samNoticeId: { startsWith: 'DEMO-' }, status: 'ACTIVE', bidPursuits: { none: {} } } })
    await request(app).get(`/api/opportunities/${opened.id}`).set(H(member.token)).expect(200)
    await poolNotice('541512', 'Zero Trust Support')
    expect(await fillDemoAccount(account.firmId)).toBe(1)
    expect(await prisma.opportunity.findUnique({ where: { id: opened.id } })).not.toBeNull()
    const real = await prisma.opportunity.findFirstOrThrow({ where: { consultingFirmId: account.firmId, title: 'Zero Trust Support' } })
    await request(app).get(`/api/opportunities/${real.id}`).set(H(member.token)).expect(200)
    const { body } = await request(app).get('/api/pursuits/pipeline?limit=200').set(H(member.token)).expect(200)
    expect(body.data.items.find((item: { opportunityId: string }) => item.opportunityId === real.id)?.pipelineStage).toBe('IDENTIFIED')
  }, 60_000)

  it('pulls through the SAM.gov service with a three-request cap, looking back 30 days the first time and skipping while fresh', async () => {
    const pool = await ensurePoolFirm()
    await prisma.consultingFirm.update({ where: { id: pool.id }, data: { lastIngestedAt: null } })
    const calls: Array<{ params: Record<string, unknown>; firmId: string }> = []
    const ingest = (async (params: Record<string, unknown>, firmId: string) => {
      calls.push({ params, firmId })
      await prisma.consultingFirm.update({ where: { id: firmId }, data: { lastIngestedAt: new Date() } })
      return { success: true, found: 7, ingested: 5, errors: 0 }
    }) as unknown as PoolIngest
    expect(await syncDemoPool({ ingest })).toEqual({ found: 7, ingested: 5, skipped: false })
    expect(calls[0].firmId).toBe(pool.id)
    expect(calls[0].params).toMatchObject({ limit: 1000, maxPages: 3 })
    expect(Math.round((Date.now() - (calls[0].params.sinceDate as Date).getTime()) / DAY)).toBe(30)
    expect(await syncDemoPool({ ingest })).toEqual({ found: 0, ingested: 0, skipped: true })
    expect(calls).toHaveLength(1)
    expect(await syncDemoPool({ ingest, force: true })).toMatchObject({ skipped: false })
    expect(calls[1].params.sinceDate).toBeUndefined()
    await prisma.ingestionJob.deleteMany({ where: { consultingFirmId: pool.id } })
  })

  it('shows operators how the last pull went', async () => {
    demoSite()
    const pool = await ensurePoolFirm()
    const failing = (async () => { throw new Error('SAM.gov API key rejected (HTTP 401)') }) as unknown as PoolIngest
    await expect(syncDemoPool({ ingest: failing, force: true })).rejects.toThrow(/rejected/)
    const res = await request(app).get('/api/demo/accounts').set(H(operator.token)).expect(200)
    expect(res.body.data.pool.ok).toBe(false)
    expect(res.body.data.pool.error).toContain('rejected')
    await prisma.ingestionJob.deleteMany({ where: { consultingFirmId: pool.id } })
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

  it('gets one business type and the same data as a client, once', async () => {
    const address = email()
    vi.stubEnv('APP_ENV', 'demo')
    vi.stubEnv('PLATFORM_ADMIN_EMAILS', address)
    vi.stubEnv('DEMO_ADMIN_EMAIL', address)
    vi.stubEnv('DEMO_ADMIN_PASSWORD', 'a-long-operator-password')
    await ensureDemoOperator()
    const { consultingFirmId } = await prisma.user.findUniqueOrThrow({ where: { email: address } })
    created.push(consultingFirmId)
    await prisma.consultingFirm.update({ where: { id: consultingFirmId }, data: { demoBusinessType: null } })

    await assignDemoBusinessTypes()
    const client = await makeAccount()
    const count = (id: string) => Promise.all([
      prisma.opportunity.count({ where: { consultingFirmId: id } }),
      prisma.bidPursuit.count({ where: { consultingFirmId: id } }),
      prisma.contract.count({ where: { consultingFirmId: id } }),
      prisma.submissionRecord.count({ where: { consultingFirmId: id } }),
      prisma.proposal.count({ where: { consultingFirmId: id } }),
      prisma.clientCompany.count({ where: { consultingFirmId: id } }),
    ])
    expect(await count(consultingFirmId)).toEqual(await count(client.firmId))
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: consultingFirmId } })).demoBusinessType).toBeTruthy()
  }, 120_000)

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

// Everything that writes to the shared SAM.gov pool lives in this file: test files run
// at the same time against one database, and pool notices from another file would be
// copied into accounts the tests above are checking.
describe('the pool: on-demand pulls, the pool administrator and the fetch history', () => {
  const inDays = (n: number) => new Date(Date.now() + n * DAY)
  const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`)

  describe('pulling on demand', () => {
    let poolId: string
    const clearJobs = () => prisma.ingestionJob.deleteMany({ where: { consultingFirmId: poolId } })
    const fakeIngest = (pages: Array<{ nextPage: number | null; total: number }>, calls: Array<Record<string, unknown>> = []) =>
      (async (params: Record<string, unknown> & { onPage: (p: unknown) => Promise<void> }) => {
        calls.push(params)
        let requests = 0
        for (const page of pages) { requests++; await params.onPage({ requests, nextPage: page.nextPage, total: page.total }) }
        return { success: true, found: requests * 1000, ingested: requests * 900, errors: 0, requests }
      }) as unknown as PoolIngest

    beforeEach(async () => {
      vi.stubEnv('APP_ENV', 'demo')
      poolId = (await ensurePoolFirm()).id
      await clearJobs()
    })
    afterAll(async () => {
      vi.unstubAllEnvs()
      await clearJobs()
    })

    it('continues from where the last pull stopped, over the same window', async () => {
      const first: Array<Record<string, unknown>> = []
      await (await startPoolPull(2, { ingest: fakeIngest([{ nextPage: 1, total: 8631 }, { nextPage: 2, total: 8631 }], first) })).run()
      let status = await poolPullStatus()
      expect(status.progress).toMatchObject({ nextPage: 2, totalPages: 9, finishedAt: null })
      expect(status.lastPull).toMatchObject({ ok: true, found: 2000, added: 1800, requests: 2 })
      expect(first[0]).toMatchObject({ page: 0, maxPages: 2, keepWatermark: true, limit: 1000 })

      const second: Array<Record<string, unknown>> = []
      await (await startPoolPull(1, { ingest: fakeIngest([{ nextPage: 3, total: 8631 }], second) })).run()
      status = await poolPullStatus()
      expect(second[0].page).toBe(2)
      expect((second[0].postedTo as Date).getTime()).toBe((first[0].postedTo as Date).getTime())
      expect(status.requestsUsedToday).toBe(3)
    })

    it('never spends the requests kept for the daily pull', async () => {
      await prisma.ingestionJob.create({ data: { consultingFirmId: poolId, type: 'INGEST', status: 'COMPLETE', startedAt: new Date(), samRequests: 5 } })
      expect((await poolPullStatus()).requestsAvailable).toBe(2)
      const { requests } = await startPoolPull(4, { ingest: fakeIngest([]) })
      expect(requests).toBe(2)
      await clearJobs()
      await prisma.ingestionJob.create({ data: { consultingFirmId: poolId, type: 'INGEST', status: 'COMPLETE', startedAt: new Date(), samRequests: 7 } })
      await expect(startPoolPull(1, { ingest: fakeIngest([]) })).rejects.toThrow(/used up/)
    })

    it('counts only today, in UTC', async () => {
      await prisma.ingestionJob.create({ data: { consultingFirmId: poolId, type: 'INGEST', status: 'COMPLETE', startedAt: inDays(-2), samRequests: 7 } })
      expect((await poolPullStatus()).requestsUsedToday).toBe(0)
    })

    it('refuses a second pull while one runs, unless that one died with a restart', async () => {
      await startPoolPull(1, { ingest: fakeIngest([]) })
      await expect(startPoolPull(1, { ingest: fakeIngest([]) })).rejects.toThrow(/already running/)
      await prisma.ingestionJob.updateMany({ where: { consultingFirmId: poolId }, data: { startedAt: new Date(Date.now() - 31 * 60_000) } })
      await expect(startPoolPull(1, { ingest: fakeIngest([]) })).resolves.toBeTruthy()
    })

    it('a restart closes a pull it interrupted, keeping its place', async () => {
      const stuck = await startPoolPull(2, { ingest: fakeIngest([]) })
      expect((await poolPullStatus()).running).toBe(true)
      await closeInterruptedPoolPulls()
      const status = await poolPullStatus()
      expect(status.running).toBe(false)
      expect(status.lastPull?.error).toMatch(/restart/)
      expect(status.progress?.nextPage).toBe(0)
      expect(stuck.requests).toBe(2)
      await expect(startPoolPull(1, { ingest: fakeIngest([]) })).resolves.toBeTruthy()
    })

    it('keeps its place and its count when SAM.gov fails part-way', async () => {
      const failing = (async (params: { onPage: (p: unknown) => Promise<void> }) => {
        await params.onPage({ requests: 1, nextPage: 1, total: 8631 })
        throw new Error('Sync paused: quota reached')
      }) as unknown as PoolIngest
      await (await startPoolPull(3, { ingest: failing })).run()
      const status = await poolPullStatus()
      expect(status.running).toBe(false)
      expect(status.lastPull).toMatchObject({ ok: false, requests: 2 })
      expect(status.lastPull?.error).toMatch(/quota/)
      expect(status.progress?.nextPage).toBe(1)
      const next: Array<Record<string, unknown>> = []
      await (await startPoolPull(1, { ingest: fakeIngest([{ nextPage: 2, total: 8631 }], next) })).run()
      expect(next[0].page).toBe(1)
    })

    it("won't fetch the same notices again for a week once every page is in", async () => {
      await (await startPoolPull(1, { ingest: fakeIngest([{ nextPage: null, total: 900 }]) })).run()
      expect((await poolPullStatus()).progress?.finishedAt).toBeTruthy()
      await expect(startPoolPull(1, { ingest: fakeIngest([]) })).rejects.toThrow(/Every open notice/)
      const later = new Date(Date.now() + 8 * DAY)
      const calls: Array<Record<string, unknown>> = []
      await (await startPoolPull(1, { ingest: fakeIngest([], calls), now: later })).run()
      expect(calls[0].page).toBe(0)
    })

    it('runs one pool pull at a time, so startup and the daily job never both spend requests', async () => {
      await prisma.consultingFirm.update({ where: { id: poolId }, data: { lastIngestedAt: inDays(-2) } })
      let calls = 0
      const slow = (async () => { calls++; await new Promise((r) => setTimeout(r, 200)); return { found: 1, ingested: 1, errors: 0, requests: 1 } }) as unknown as PoolIngest
      const results = await Promise.all([syncDemoPool({ ingest: slow, trigger: 'RESTART' }), syncDemoPool({ ingest: slow, trigger: 'SCHEDULE' })])
      expect(calls).toBe(1)
      expect(results.filter((r) => r.skipped)).toHaveLength(1)
      await clearJobs()
      await startPoolPull(1, { ingest: fakeIngest([]) })
      expect(await syncDemoPool({ ingest: slow, force: true })).toMatchObject({ skipped: true })
      expect(calls).toBe(1)
    })

    it("doesn't move the daily pull's starting point, and the daily pull uses the deadline filter", async () => {
      const before = inDays(-1)
      await prisma.consultingFirm.update({ where: { id: poolId }, data: { lastIngestedAt: before } })
      const calls: Array<Record<string, unknown>> = []
      const ingest = (async (params: Record<string, unknown>) => { calls.push(params); return { found: 1, ingested: 1, errors: 0, requests: 1 } }) as unknown as PoolIngest
      await syncDemoPool({ ingest })
      expect(calls[0].deadlineFrom).toBeInstanceOf(Date)
      expect(calls[0].keepWatermark).toBeUndefined()
      expect((await poolPullStatus()).requestsUsedToday).toBe(1)
    })
  })

  describe('filling an account from a large pool', () => {
    it('copies everything the account lacks at once, and only that', async () => {
      const pool = await ensurePoolFirm()
      const firm = await createTestFirm({ name: 'Fill Firm' })
      await prisma.consultingFirm.update({ where: { id: firm.id }, data: { demoBusinessType: 'IT' } })
      await prisma.opportunity.createMany({
        data: ids('fillcap', 205).map((id) => ({ consultingFirmId: pool.id, samNoticeId: id, title: id, agency: 'Test Agency', naicsCode: '541512', status: 'ACTIVE' as const, source: 'SAM_GOV' as const, responseDeadline: inDays(20), postedDate: new Date(), isDemo: false, probabilityScore: 0, expectedValue: 0 })),
      })
      expect(await fillDemoAccount(firm.id)).toBeGreaterThanOrEqual(205)
      expect(await prisma.opportunity.count({ where: { consultingFirmId: firm.id, samNoticeId: { startsWith: 'fillcap' } } })).toBe(205)
      expect(await fillDemoAccount(firm.id)).toBe(0)
      await prisma.opportunity.deleteMany({ where: { consultingFirmId: pool.id, samNoticeId: { startsWith: 'fillcap' } } })
      await cleanupFirm(firm.id)
    }, 60_000)
  })

  describe("the operators' account", () => {
    const app = buildTestApp()
    const naics = ['541512', '236220', '524210', '999999']

    it('gives operators and clients the whole pool', async () => {
      vi.stubEnv('APP_ENV', 'demo')
      const pool = await ensurePoolFirm()
      const operators = await prisma.consultingFirm.upsert({
        where: { contactEmail: OPERATOR_FIRM_EMAIL },
        update: { demoBusinessType: 'FINANCE' },
        create: { name: 'Bytescon Demo Operators', contactEmail: OPERATOR_FIRM_EMAIL, isOwnerComp: true, demoBusinessType: 'FINANCE' },
      })
      const user = await createTestUser(operators.id, { role: 'ADMIN' })
      vi.stubEnv('PLATFORM_ADMIN_EMAILS', user.email)
      const client = await createTestFirm({ name: 'Finance Client' })
      await prisma.consultingFirm.update({ where: { id: client.id }, data: { demoBusinessType: 'FINANCE' } })
      await prisma.opportunity.createMany({
        data: ids('whole', 1205).map((id, i) => ({ consultingFirmId: pool.id, samNoticeId: id, title: id, agency: 'Test Agency', naicsCode: naics[i % naics.length], status: 'ACTIVE' as const, source: 'SAM_GOV' as const, responseDeadline: inDays(20), postedDate: new Date(), isDemo: false, probabilityScore: 0, expectedValue: 0 })),
      })
      const mine = { samNoticeId: { startsWith: 'whole-' } }

      await fillDemoAccount(operators.id)
      expect(await prisma.opportunity.count({ where: { consultingFirmId: operators.id, ...mine } })).toBe(1205)
      expect(await fillDemoAccount(operators.id)).toBe(0)
      const seen = await request(app).get('/api/opportunities?search=whole-&limit=1').set({ Authorization: `Bearer ${user.token}` }).expect(200)
      expect(seen.body.meta.total).toBe(1205)

      await fillDemoAccount(client.id)
      const copied = await prisma.opportunity.findMany({ where: { consultingFirmId: client.id, ...mine }, select: { naicsCode: true } })
      // Everything, its own business (finance, 52…) included.
      expect(copied.length).toBe(1205)
      expect(copied.some((o) => o.naicsCode?.startsWith('52'))).toBe(true)
      expect(copied.some((o) => !o.naicsCode?.startsWith('52'))).toBe(true)

      await prisma.opportunity.deleteMany({ where: mine })
      await prisma.user.delete({ where: { id: user.id } })
      await cleanupFirm(client.id)
      vi.unstubAllEnvs()
    }, 120_000)
  })

  describe('the pool administrator', () => {
    const app = buildTestApp()
    const H = (token: string) => ({ Authorization: `Bearer ${token}` })

    it('is the only login that can see or start a pull', async () => {
      vi.stubEnv('APP_ENV', 'demo')
      const firm = await createTestFirm({ name: 'Pool Admin Firm' })
      const admin = await createTestUser(firm.id, { role: 'ADMIN' })
      const operator = await createTestUser(firm.id, { role: 'ADMIN' })
      vi.stubEnv('PLATFORM_ADMIN_EMAILS', operator.email)
      vi.stubEnv('DEMO_POOL_ADMIN_EMAIL', admin.email)
      await prisma.ingestionJob.deleteMany({ where: { consultingFirmId: (await ensurePoolFirm()).id } })

      const seen = await request(app).get('/api/demo/pool').set(H(admin.token)).expect(200)
      expect(seen.body.data.dailyRequests).toBe(10)
      await request(app).get('/api/demo/pool').set(H(operator.token)).expect(403)
      await request(app).post('/api/demo/pool/pull').set(H(operator.token)).send({ requests: 1 }).expect(403)
      await request(app).post('/api/demo/pool/pull').set(H(admin.token)).send({ requests: 9 }).expect(422)
      await request(app).get('/api/demo/accounts').set(H(admin.token)).expect(403)

      const status = await request(app).get('/api/demo/status').set(H(admin.token)).expect(200)
      expect(status.body.data).toMatchObject({ isPoolAdmin: true, isOperator: false })
      expect((await request(app).get('/api/demo/status').set(H(operator.token)).expect(200)).body.data.isPoolAdmin).toBe(false)
      expect(demoAccessOf(admin.email, null)).toBe('ACTIVE')
      vi.unstubAllEnvs()
      await cleanupFirm(firm.id)
    })

    it('nobody can pull when the setting is empty', async () => {
      vi.stubEnv('APP_ENV', 'demo')
      vi.stubEnv('DEMO_POOL_ADMIN_EMAIL', '')
      const firm = await createTestFirm({ name: 'No Pool Admin' })
      const user = await createTestUser(firm.id, { role: 'ADMIN' })
      vi.stubEnv('PLATFORM_ADMIN_EMAILS', user.email)
      await request(app).get('/api/demo/pool').set(H(user.token)).expect(403)
      vi.unstubAllEnvs()
      await cleanupFirm(firm.id)
    })

    it('is created once from the settings; a short password is logged, never fatal', async () => {
      const email = uniqEmail('pool-admin')
      vi.stubEnv('APP_ENV', 'demo')
      vi.stubEnv('DEMO_POOL_ADMIN_EMAIL', email)
      vi.stubEnv('DEMO_POOL_ADMIN_PASSWORD', 'short')
      await expect(ensureDemoPoolAdmin()).resolves.toBeUndefined()
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull()
      vi.stubEnv('DEMO_POOL_ADMIN_PASSWORD', 'a-long-pool-admin-password')
      await ensureDemoPoolAdmin()
      const user = await prisma.user.findUniqueOrThrow({ where: { email } })
      await ensureDemoPoolAdmin()
      expect((await prisma.user.findUniqueOrThrow({ where: { email } })).passwordHash).toBe(user.passwordHash)
      await prisma.user.delete({ where: { email } })
      vi.unstubAllEnvs()
    })
  })

  describe('demo: the pool administrator sees the pool', () => {
    it('shows pool fetches with their triggers, and refuses everyone else', async () => {
      const poolFirm = await ensurePoolFirm()
      await prisma.ingestionJob.deleteMany({ where: { consultingFirmId: poolFirm.id } })
      const firm = await createTestFirm({ name: 'Demo Admins' })
      created.push(firm.id)
      const poolAdmin = await createTestUser(firm.id, { role: 'ADMIN' })
      const operator = await createTestUser(firm.id, { role: 'ADMIN' })
      vi.stubEnv('APP_ENV', 'demo')
      vi.stubEnv('PLATFORM_ADMIN_EMAILS', operator.email)
      vi.stubEnv('DEMO_POOL_ADMIN_EMAIL', poolAdmin.email)

      const ingest = (async () => ({ found: 10, ingested: 4, errors: 0, requests: 1 })) as unknown as PoolIngest
      await syncDemoPool({ ingest, force: true, trigger: 'RESTART' })
      await syncDemoPool({ ingest, force: true, trigger: 'SYNC_BUTTON', triggerDetail: 'Acme Federal' })
      await (await startPoolPull(1, { ingest: (async () => ({ found: 1000, ingested: 900, errors: 0 })) as unknown as PoolIngest, by: poolAdmin.email })).run()

      const res = await request(app).get('/api/fetch-history').set(H(poolAdmin.token)).expect(200)
      expect(res.body.data.scope).toBe('pool')
      const triggers = res.body.data.fetches.map((f: { trigger: string; triggerDetail: string | null }) => `${f.trigger}:${f.triggerDetail ?? ''}`)
      expect(triggers.sort()).toEqual([`ON_DEMAND:${poolAdmin.email}`, 'RESTART:', 'SYNC_BUTTON:Acme Federal'])
      const breakdown = (await request(app).get('/api/fetch-history/breakdown').set(H(poolAdmin.token)).expect(200)).body.data
      expect(Array.isArray(breakdown.accounts)).toBe(true)

      await request(app).get('/api/fetch-history').set(H(operator.token)).expect(403)
      expect((await request(app).get('/api/fetch-history/access').set(H(operator.token)).expect(200)).body.data.allowed).toBe(false)
      expect((await request(app).get('/api/fetch-history/access').set(H(poolAdmin.token)).expect(200)).body.data.allowed).toBe(true)
      vi.stubEnv('DEVELOPER_ADMIN_EMAIL', operator.email)
      await request(app).get('/api/fetch-history').set(H(operator.token)).expect(403)
      await prisma.ingestionJob.deleteMany({ where: { consultingFirmId: poolFirm.id } })
    }, 60_000)
  })
})

describe('account type on the operator screen', () => {
  const clientsOf = (firmId: string) => prisma.clientCompany.findMany({ where: { consultingFirmId: firmId }, orderBy: { createdAt: 'asc' } })

  it('creates a consulting firm by default, with its sample clients', async () => {
    demoSite()
    const res = await request(app).post('/api/demo/accounts').set(H(operator.token))
      .send({ profile: PROFILE, companyName: 'Default Type LLC', contactName: 'Sam Roe', email: uniqEmail('default-type') })
    expect(res.status).toBe(201)
    created.push(res.body.data.firmId)
    const firm = await prisma.consultingFirm.findUniqueOrThrow({ where: { id: res.body.data.firmId } })
    expect(firm.accountType).toBe('CONSULTING')
    const clients = await clientsOf(firm.id)
    expect(clients).toHaveLength(3)
    expect(clients.some((c) => c.isSelf)).toBe(false)
  })

  it('creates a contractor whose sample data all belongs to its own company', async () => {
    demoSite()
    const email = uniqEmail('contractor')
    const res = await request(app).post('/api/demo/accounts').set(H(operator.token))
      .send({ profile: PROFILE, companyName: 'ARK Demo Construction', contactName: 'Hari Test', email, accountType: 'CONTRACTOR' })
    expect(res.status).toBe(201)
    const firmId = res.body.data.firmId
    created.push(firmId)

    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firmId } })).accountType).toBe('CONTRACTOR')
    const clients = await clientsOf(firmId)
    expect(clients).toHaveLength(1)
    expect(clients[0]).toMatchObject({ isSelf: true, name: 'ARK Demo Construction', sdvosb: true })
    expect(clients[0].naicsCodes.length).toBeGreaterThan(0)
    const profile = await prisma.registrationProfile.findUniqueOrThrow({ where: { consultingFirmId: firmId } })
    expect(profile.samStatus).toBe('ACTIVE')
    expect(profile.naicsCodes).toEqual(clients[0].naicsCodes)
    // Past bids, past performance and stats are the company's own; no client document requests.
    expect(await prisma.submissionRecord.count({ where: { consultingFirmId: firmId, clientCompanyId: { not: clients[0].id } } })).toBe(0)
    expect(await prisma.submissionRecord.count({ where: { consultingFirmId: firmId } })).toBeGreaterThan(0)
    expect(await prisma.performanceStats.count({ where: { clientCompanyId: clients[0].id } })).toBe(1)
    expect(await prisma.documentRequirement.count({ where: { consultingFirmId: firmId } })).toBe(0)

    const member = await createTestUser(firmId, { role: 'ADMIN' })
    const profileRes = await request(app).get('/api/auth/profile').set(H(member.token))
    expect(JSON.stringify(profileRes.body)).toContain('"accountType":"CONTRACTOR"')

    const list = await request(app).get('/api/demo/accounts').set(H(operator.token))
    expect(list.body.data.accounts.find((a: { firmId: string }) => a.firmId === firmId).accountType).toBe('CONTRACTOR')
  })

  it('switches a consulting account to contractor and back without losing clients', async () => {
    demoSite()
    const { firmId } = await makeAccount()
    const before = await clientsOf(firmId)
    expect(before).toHaveLength(3)

    const toContractor = await request(app).post(`/api/demo/accounts/${firmId}/account-type`).set(H(operator.token)).send({ accountType: 'CONTRACTOR' })
    expect(toContractor.status).toBe(200)
    expect(toContractor.body.data).toMatchObject({ changed: true, archivedClients: 3 })
    let clients = await clientsOf(firmId)
    const self = clients.find((c) => c.isSelf)!
    expect(self).toMatchObject({ name: 'Acme Federal', archivedAt: null })
    // Started from the first client's codes, so scoring has something to use.
    expect(self.naicsCodes).toEqual(before[0].naicsCodes)
    expect(clients.filter((c) => !c.isSelf).every((c) => c.archivedAt !== null)).toBe(true)
    expect((await prisma.registrationProfile.findUniqueOrThrow({ where: { consultingFirmId: firmId } })).naicsCodes).toEqual(before[0].naicsCodes)

    // Same type again changes nothing.
    const again = await request(app).post(`/api/demo/accounts/${firmId}/account-type`).set(H(operator.token)).send({ accountType: 'CONTRACTOR' })
    expect(again.body.data.changed).toBe(false)

    const toConsulting = await request(app).post(`/api/demo/accounts/${firmId}/account-type`).set(H(operator.token)).send({ accountType: 'CONSULTING' })
    expect(toConsulting.status).toBe(200)
    expect(toConsulting.body.data).toMatchObject({ changed: true, restoredClients: 3 })
    clients = await clientsOf(firmId)
    expect(clients.filter((c) => !c.isSelf).every((c) => c.archivedAt === null)).toBe(true)
    expect(clients.find((c) => c.isSelf)?.archivedAt).not.toBeNull()
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firmId } })).accountType).toBe('CONSULTING')
  })

  it('does not restore a client that was archived before the switch', async () => {
    demoSite()
    const { firmId } = await makeAccount()
    const [first] = await clientsOf(firmId)
    await prisma.clientCompany.update({ where: { id: first.id }, data: { archivedAt: new Date() } })
    await request(app).post(`/api/demo/accounts/${firmId}/account-type`).set(H(operator.token)).send({ accountType: 'CONTRACTOR' }).expect(200)
    await request(app).post(`/api/demo/accounts/${firmId}/account-type`).set(H(operator.token)).send({ accountType: 'CONSULTING' }).expect(200)
    expect((await prisma.clientCompany.findUniqueOrThrow({ where: { id: first.id } })).archivedAt).not.toBeNull()
  })

  it('refuses a bad type, a firm that is not a demo account, and anyone but operators', async () => {
    demoSite()
    const { firmId } = await makeAccount()
    expect((await request(app).post(`/api/demo/accounts/${firmId}/account-type`).set(H(operator.token)).send({ accountType: 'OTHER' })).status).toBe(422)
    expect((await request(app).post(`/api/demo/accounts/${otherFirm.id}/account-type`).set(H(operator.token)).send({ accountType: 'CONTRACTOR' })).status).toBe(404)
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: otherFirm.id } })).accountType).toBe('CONSULTING')
    const member = await createTestUser(firmId, { role: 'ADMIN' })
    expect((await request(app).post(`/api/demo/accounts/${firmId}/account-type`).set(H(member.token)).send({ accountType: 'CONTRACTOR' })).status).toBe(403)
  })
})

describe('the operator enters the company profile', () => {
  const post = (body: Record<string, unknown>) => request(app).post('/api/demo/accounts').set(H(operator.token)).send({
    companyName: 'Profile Firm', contactName: 'Pat Lee', email: uniqEmail('profile'), state: 'TX', ...body,
  })
  const statusFor = async (firmId: string) => {
    const member = await createTestUser(firmId, { role: 'ADMIN' })
    return (await request(app).get('/api/profile/status').set(H(member.token)).expect(200)).body.data
  }

  it('refuses an account without the profile, or with parts missing, and creates nothing', async () => {
    demoSite()
    const email = uniqEmail('no-profile')
    expect((await post({ email }).expect(422)).body.error).toMatch(/company profile/i)
    const partial = await post({ email, profile: { ...PROFILE, uei: '', capabilityKeywords: [] } }).expect(422)
    expect(partial.body.error).toMatch(/UEI/)
    expect(partial.body.error).toMatch(/Capability keywords/)
    expect((await post({ email, profile: { ...PROFILE, clientName: '' } }).expect(422)).body.error).toMatch(/Client company name/)
    expect((await post({ email, profile: { ...PROFILE, uei: 'SHORT' } }).expect(422)).body.error).toMatch(/UEI must be exactly 12/)
    expect(await prisma.user.count({ where: { email } })).toBe(0)
  })

  it('makes it a consulting firm\'s first client, complete from the start, beside two samples', async () => {
    demoSite()
    const res = await post({ profile: { ...PROFILE, clientName: 'Lone Star Cabling', city: 'Austin', hubzone: true } }).expect(201)
    created.push(res.body.data.firmId)
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId: res.body.data.firmId } })
    expect(clients).toHaveLength(3)
    expect(clients.find((c) => c.name === 'Lone Star Cabling')).toMatchObject({
      uei: 'REALUEI00001', naicsCodes: ['238210'], samRegStatus: 'Active', capabilityKeywords: ['fiber'],
      state: 'TX', city: 'Austin', sdvosb: true, hubzone: true, wosb: false, isSelf: false,
    })
    const status = await statusFor(res.body.data.firmId)
    expect(status.clients.find((c: { name: string }) => c.name === 'Lone Star Cabling').complete).toBe(true)
  }, 60_000)

  it('makes it a contractor\'s own company and registration, complete from the start', async () => {
    demoSite()
    const res = await post({ companyName: 'Hari Field Services', accountType: 'CONTRACTOR', profile: { ...PROFILE, clientName: undefined, samRegStatus: 'Inactive', sdvosb: false, eightA: true } }).expect(201)
    const firmId = res.body.data.firmId
    created.push(firmId)
    const [self] = await prisma.clientCompany.findMany({ where: { consultingFirmId: firmId } })
    expect(self).toMatchObject({ isSelf: true, name: 'Hari Field Services', uei: 'REALUEI00001', eightA: true, sdvosb: false, samRegStatus: 'Inactive' })
    const registration = await prisma.registrationProfile.findUniqueOrThrow({ where: { consultingFirmId: firmId } })
    expect(registration).toMatchObject({ uei: 'REALUEI00001', naicsCodes: ['238210'], setAsideCerts: ['SBA_8A'], samStatus: 'EXPIRED' })
    // The sample certification records match the set-asides ticked: 8(a), and no SDVOSB.
    const certs = (await prisma.certification.findMany({ where: { consultingFirmId: firmId } })).map((c) => c.name).sort()
    expect(certs).toEqual(['8(a) Certification', 'ISO 9001:2015'])
    expect((await statusFor(firmId)).complete).toBe(true)
  }, 60_000)
})

describe('no single sign-on on the demo', () => {
  it('shows no SSO button and refuses every SSO route, so SSO cannot add users or outlive the demo', async () => {
    demoSite()
    const discover = await request(app).get('/api/sso/discover').query({ email: 'someone@client.test' }).expect(200)
    expect(discover.body.data).toEqual({ available: false })
    const start = await request(app).post('/api/sso/start').send({ consultingFirmId: operatorFirm.id }).expect(403)
    expect(start.body.code).toBe('DEMO_NO_SSO')
    await request(app).get('/api/sso/callback').expect(403)
    await request(app).get('/api/sso/admin/connection').set(H(operator.token)).expect(403)
  })
})
