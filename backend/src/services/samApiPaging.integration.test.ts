// SAM.gov's paging: the offset is a page number, and a pull stops where it should.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import axios from 'axios'
import { prisma } from '../config/database'
import { createTestFirm, cleanupFirm, disconnectDb } from '../test-utils/testClient'
import { samApiService } from './samApi'

vi.mock('axios', async (original) => {
  const actual = await original<typeof import('axios')>()
  return { ...actual, default: { ...actual.default, get: vi.fn() } }
})
const get = vi.mocked(axios.get)

const DAY = 86_400_000
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

afterAll(() => disconnectDb())
