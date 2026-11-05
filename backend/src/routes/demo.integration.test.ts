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
import { runAgentScheduler } from '../services/agents/scheduler'
import { generateWithRouter } from '../services/llm/llmRouter'
import { AiLimitError } from '../utils/errors'
import { firmHasClientPortal } from '../middleware/clientPortalGate'
import { demoFileGuard } from '../middleware/demoFileGuard'
import { createDemoAccount, DEMO_PROPOSAL_TOKENS, ensureDemoOperator, purgeExpiredDemoAccounts, assignDemoBusinessTypes } from '../services/demoAccounts'
import { regionForState, US_REGIONS, US_STATES } from '../services/demoSampleData'
import { businessTypeByKey, DEFAULT_BUSINESS_TYPE, DEMO_BUSINESS_TYPES, type DemoBusinessType } from '../services/demoBusinessTypes'

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
    expect(clients.map((c) => c.name).sort()).toEqual(region.clientPrefixes.map((prefix, i) => `${prefix} ${DEFAULT_BUSINESS_TYPE.clientSuffixes[i]}`).sort())
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
    expect(clients.map((c) => c.name)).toContain('Ohio Ridgeline Technologies')
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
    expect(open).toHaveLength(12)
    const fresh = open.filter((o) => o.bidPursuits.length === 0)
    expect(fresh).toHaveLength(8)
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
  const post = (body: Record<string, unknown>) => request(app).post('/api/demo/accounts').set(H(operator.token)).send({
    companyName: 'Type Test', contactName: 'Pat Lee', email: uniqEmail('type'), ...body,
  })

  it('has 12 complete types, in the sectors the app already uses', () => {
    expect(DEMO_BUSINESS_TYPES).toHaveLength(12)
    for (const type of DEMO_BUSINESS_TYPES) {
      expect(new Set(type.opportunities).size).toBe(12)
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
    expect(opportunities).toHaveLength(18)
    for (const opportunity of opportunities) expect(sectorMatches(type, opportunity.naicsCode)).toBe(true)
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId: firmId } })
    for (const client of clients) expect(client.naicsCodes.every((code) => sectorMatches(type, code))).toBe(true)
    expect(opportunities.filter((o) => o.status === 'ACTIVE' && (o.probabilityScore ?? 0) > 0)).toHaveLength(12)
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firmId } })).demoBusinessType).toBe(key)
  }, 60_000)

  it('refuses an unknown type', async () => {
    demoSite()
    await post({ businessType: 'NOPE' }).expect(422)
  })

  it('hides opportunities from other businesses in the list, even ones added later', async () => {
    demoSite()
    const res = await post({ businessType: 'HEALTH' }).expect(201)
    const firmId = res.body.data.firmId
    created.push(firmId)
    const member = await createTestUser(firmId, { role: 'ADMIN' })
    const stray = await prisma.opportunity.create({ data: { consultingFirmId: firmId, title: 'Stray IT Work', agency: 'DHS', naicsCode: '541512', samNoticeId: uniqEmail('stray'), responseDeadline: new Date(Date.now() + 30 * DAY), isDemo: false } })
    const list = await request(app).get('/api/opportunities?limit=100').set(H(member.token)).expect(200)
    const items = (list.body.data?.items ?? list.body.data ?? []) as Array<{ id: string }>
    expect(items.length).toBeGreaterThan(0)
    expect(items.some((item) => item.id === stray.id)).toBe(false)
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
    expect(opportunities).toHaveLength(18)
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
    expect(tour.openOpportunities).toBe(12)
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
