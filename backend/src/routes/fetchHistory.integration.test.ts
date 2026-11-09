// The fetch history page: who can see it, what each version shows, and the breakdown.
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import request from 'supertest'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb } from '../test-utils/testClient'
import { businessTypeOf } from '../services/fetchHistory'

const DAY = 86_400_000
const inDays = (n: number) => new Date(Date.now() + n * DAY)
const app = buildTestApp()
const H = (token: string) => ({ Authorization: `Bearer ${token}` })
const firms: string[] = []

afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
  for (const id of firms) await cleanupFirm(id)
  await disconnectDb()
})

const notice = (consultingFirmId: string, id: string, naicsCode: string, deadline: Date, extra: Record<string, unknown> = {}) => ({
  consultingFirmId, samNoticeId: id, title: `Notice ${id}`, agency: 'Dept of Tests', naicsCode, status: 'ACTIVE' as const, source: 'SAM_GOV' as const,
  responseDeadline: deadline, postedDate: new Date(), isDemo: false, probabilityScore: 0, expectedValue: 0, ...extra,
})

describe('business types from NAICS', () => {
  it('uses the longest matching prefix', () => {
    expect(businessTypeOf('541512')).toBe('Information / IT')
    expect(businessTypeOf('541611')).toBe('Professional Services')
    expect(businessTypeOf('236220')).toBe('Construction')
    expect(businessTypeOf('999999')).toBeNull()
    expect(businessTypeOf('')).toBeNull()
  })
})

describe('full version: a firm sees its own fetches', () => {
  let firmId: string
  let admin: { token: string; email: string }
  let consultant: { token: string }
  let otherFirmId: string

  beforeAll(async () => {
    firmId = (await createTestFirm({ name: 'History Firm' })).id
    otherFirmId = (await createTestFirm({ name: 'Other Firm' })).id
    firms.push(firmId, otherFirmId)
    admin = await createTestUser(firmId, { role: 'ADMIN' })
    consultant = await createTestUser(firmId, { role: 'CONSULTANT' })
    const config = await prisma.opportunitySourceConfig.create({ data: { consultingFirmId: firmId, adapterKey: 'grants_gov', displayName: 'Grants.gov', category: 'GRANTS_GOV' } })
    const started = new Date(Date.now() - 60_000)
    await prisma.ingestionJob.createMany({
      data: [
        { consultingFirmId: firmId, type: 'INGEST', status: 'COMPLETE', startedAt: started, completedAt: new Date(), trigger: 'SCHEDULE', samRequests: 2, opportunitiesFound: 1500, opportunitiesNew: 40 },
        { consultingFirmId: firmId, type: 'INGEST', status: 'FAILED', startedAt: new Date(started.getTime() + 1000), completedAt: new Date(), trigger: 'SYNC_BUTTON', triggerDetail: admin.email, errorDetail: 'Sync paused: quota' },
        { consultingFirmId: firmId, type: 'ENRICH', status: 'COMPLETE', startedAt: started },
        { consultingFirmId: otherFirmId, type: 'INGEST', status: 'COMPLETE', startedAt: started, trigger: 'SCHEDULE' },
      ],
    })
    await prisma.sourceSyncRun.create({
      data: { consultingFirmId: firmId, sourceConfigId: config.id, idempotencyKey: `hist-${Date.now()}`, status: 'SUCCEEDED', startedAt: started, finishedAt: new Date(Date.now() + 60_000), recordsFetched: 25, recordsCreated: 3, pagesFetched: 1, trigger: 'SCHEDULE' },
    })
    await prisma.opportunity.createMany({
      data: [
        notice(firmId, 'h-it-open', '541512', inDays(5)),
        notice(firmId, 'h-pro-open', '541611', inDays(45)),
        notice(firmId, 'h-closed', '236220', inDays(-3)),
        notice(firmId, 'h-grant', '', inDays(100), { source: 'GRANTS_GOV', sourceConfigId: config.id }),
        notice(otherFirmId, 'h-other', '541512', inDays(5)),
      ],
    })
  })

  it('lists SAM.gov fetches and source runs with why each ran, and nothing from another firm', async () => {
    const res = await request(app).get('/api/fetch-history').set(H(admin.token)).expect(200)
    const fetches = res.body.data.fetches as Array<Record<string, unknown>>
    expect(res.body.data.scope).toBe('firm')
    expect(fetches).toHaveLength(3)
    expect(fetches.filter((f) => f.source === 'SAM.gov').map((f) => f.trigger).sort()).toEqual(['SCHEDULE', 'SYNC_BUTTON'])
    expect(fetches.find((f) => f.trigger === 'SYNC_BUTTON')).toMatchObject({ triggerDetail: admin.email, status: 'FAILED', error: 'Sync paused: quota' })
    expect(fetches.find((f) => f.source === 'Grants.gov')).toMatchObject({ kind: 'source', fetched: 25, added: 3, pages: 1 })
  })

  it('breaks down what the firm holds', async () => {
    const { holdings, accounts } = (await request(app).get('/api/fetch-history/breakdown').set(H(admin.token)).expect(200)).body.data
    expect(accounts).toBeNull()
    expect(holdings).toMatchObject({ total: 4, open: 3, closed: 1, dueWithin: { days7: 1, days30: 1, days90: 2, later: 1 } })
    const types = Object.fromEntries(holdings.byBusinessType.map((t: { key: string; count: number }) => [t.key, t.count]))
    expect(types).toEqual({ 'Information / IT': 1, 'Professional Services': 1, 'No NAICS code': 1 })
    expect(holdings.bySource.map((s: { key: string }) => s.key).sort()).toEqual(['GRANTS_GOV', 'SAM_GOV'])
  })

  it('shows the notices a fetch added, and searches all of them', async () => {
    const runs = (await request(app).get('/api/fetch-history').set(H(admin.token))).body.data.fetches
    const grants = runs.find((f: { source: string }) => f.source === 'Grants.gov')
    const added = (await request(app).get(`/api/fetch-history/notices?runKind=source&runId=${grants.id}`).set(H(admin.token)).expect(200)).body.data
    expect(added.notices.map((n: { title: string }) => n.title)).toEqual(['Notice h-grant'])
    const found = (await request(app).get('/api/fetch-history/notices?search=h-pro').set(H(admin.token)).expect(200)).body.data
    expect(found.total).toBe(1)
    expect(found.notices[0]).toMatchObject({ open: true, businessType: 'Professional Services' })
    const all = (await request(app).get('/api/fetch-history/notices').set(H(admin.token)).expect(200)).body.data
    expect(all.total).toBe(4)
  })

  it('is for admins only', async () => {
    await request(app).get('/api/fetch-history').set(H(consultant.token)).expect(403)
    await request(app).get('/api/fetch-history').expect(401)
  })
})
