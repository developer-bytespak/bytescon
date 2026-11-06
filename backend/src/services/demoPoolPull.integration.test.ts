// The on-demand pull: SAM.gov's paging, keeping the place between pulls, and the request budget.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import axios from 'axios'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb } from '../test-utils/testClient'
import { samApiService } from './samApi'
import { closeInterruptedPoolPulls, ensurePoolFirm, fillDemoAccount, poolPullStatus, startPoolPull, syncDemoPool, type PoolIngest } from './demoOpportunityPool'
import { ensureDemoPoolAdmin } from './demoAccounts'
import { demoAccessOf } from './demoAccess'

vi.mock('axios', async (original) => {
  const actual = await original<typeof import('axios')>()
  return { ...actual, default: { ...actual.default, get: vi.fn() } }
})
const get = vi.mocked(axios.get)

const DAY = 86_400_000
const uniqEmail = (name: string) => `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@demo-test.local`
const inDays = (n: number) => new Date(Date.now() + n * DAY)
const record = (id: string) => ({ noticeId: id, title: `Notice ${id}`, postedDate: '2026-11-01', responseDeadLine: inDays(30).toISOString(), naicsCode: '541512', type: 'Solicitation', active: 'Yes' })
const samPage = (ids: string[], total: number) => ({ data: { opportunitiesData: ids.map(record), totalRecords: total } })
const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${i}`)
const offsets = () => get.mock.calls.map(([, config]) => (config as { params: { offset: number } }).params.offset)

describe('paging through SAM.gov', () => {
  let firmId: string
  beforeEach(async () => {
    get.mockReset()
    vi.stubEnv('SAM_API_KEY', 'test-key')
    firmId = (await createTestFirm({ name: 'Paging Firm' })).id
  })
  afterAll(() => vi.unstubAllEnvs())

  it('asks for page 0, 1, 2, since the offset is a page number', async () => {
    get.mockImplementation(async (_url, config) => samPage(ids(`p${(config as { params: { offset: number } }).params.offset}`, 2), 6))
    const stats = await samApiService.searchAndIngest({ limit: 2, maxPages: 3 }, firmId)
    expect(offsets()).toEqual([0, 1, 2])
    expect(stats).toMatchObject({ found: 6, ingested: 6, requests: 3, nextPage: null, total: 6 })
    await cleanupFirm(firmId)
  }, 30_000)

  it("doesn't spend a request once the last page has been seen", async () => {
    get.mockResolvedValue(samPage(ids('only', 2), 2))
    const stats = await samApiService.searchAndIngest({ limit: 2, maxPages: 3 }, firmId)
    expect(get).toHaveBeenCalledTimes(1)
    expect(stats).toMatchObject({ requests: 1, nextPage: null })
    await cleanupFirm(firmId)
  })

  it('stops at three requests when a caller sets no limit, and says where it stopped', async () => {
    get.mockImplementation(async (_url, config) => samPage(ids(`d${(config as { params: { offset: number } }).params.offset}`, 2), 100))
    const stats = await samApiService.searchAndIngest({ limit: 2 }, firmId)
    expect(get).toHaveBeenCalledTimes(3)
    expect(stats).toMatchObject({ requests: 3, nextPage: 3, total: 100 })
    await cleanupFirm(firmId)
  }, 30_000)

  it('sends the deadline filter, and leaves the daily pull alone when asked to', async () => {
    get.mockResolvedValue(samPage(ids('w', 1), 1))
    const from = new Date(Date.UTC(2026, 10, 7))
    await samApiService.searchAndIngest({ limit: 2, deadlineFrom: from, keepWatermark: true }, firmId)
    expect((get.mock.calls[0][1] as { params: Record<string, unknown> }).params).toMatchObject({ rdlfrom: '11/07/2026', rdlto: '11/06/2027' })
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firmId } })).lastIngestedAt).toBeNull()
    await cleanupFirm(firmId)
  })

  it('keeps asking without a filter by default', async () => {
    get.mockResolvedValue(samPage(ids('n', 1), 1))
    await samApiService.searchAndIngest({ limit: 2 }, firmId)
    expect((get.mock.calls[0][1] as { params: Record<string, unknown> }).params.rdlfrom).toBeUndefined()
    expect((await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firmId } })).lastIngestedAt).not.toBeNull()
    await cleanupFirm(firmId)
  })
})

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
  it('still adds 200 at a time and only what the account lacks', async () => {
    const pool = await ensurePoolFirm()
    const firm = await createTestFirm({ name: 'Fill Firm' })
    await prisma.consultingFirm.update({ where: { id: firm.id }, data: { demoBusinessType: 'IT' } })
    await prisma.opportunity.createMany({
      data: ids('fillcap', 205).map((id) => ({ consultingFirmId: pool.id, samNoticeId: id, title: id, agency: 'Test Agency', naicsCode: '541512', status: 'ACTIVE' as const, source: 'SAM_GOV' as const, responseDeadline: inDays(20), postedDate: new Date(), isDemo: false, probabilityScore: 0, expectedValue: 0 })),
    })
    expect(await fillDemoAccount(firm.id)).toBe(200)
    expect(await fillDemoAccount(firm.id)).toBe(5)
    expect(await fillDemoAccount(firm.id)).toBe(0)
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: pool.id, samNoticeId: { startsWith: 'fillcap' } } })
    await cleanupFirm(firm.id)
  }, 60_000)
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

afterAll(() => disconnectDb())
