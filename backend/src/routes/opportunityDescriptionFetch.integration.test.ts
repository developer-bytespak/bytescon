// =============================================================
// Opening a notice whose description is still only SAM.gov's link queues it
// for the description fetcher (services/gb107), once, and only with a key.
// The page gets the notice's contacts and attachments, never the raw link.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const LINK = 'https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=fetch-test'
let app: Express
let firm: TestFirm
let admin: TestUser

const notice = (over: Record<string, unknown> = {}) => prisma.opportunity.create({
  data: { consultingFirmId: firm.id, title: 'Linked notice', agency: 'GSA', naicsCode: '238210', samNoticeId: `n-${Math.random().toString(36).slice(2)}`, description: LINK, responseDeadline: new Date(Date.now() + 20 * 86_400_000), ...over },
})
const open = async (id: string) => (await request(app).get(`/api/opportunities/${id}`).set(H(admin.token)).expect(200)).body.data
const statusOf = async (id: string) => (await prisma.opportunity.findUniqueOrThrow({ where: { id } })).descriptionEnrichmentStatus

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Description Fetch Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
})
afterEach(() => vi.unstubAllEnvs())
afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('fetching the description when a notice is opened', () => {
  it('queues it once, and the page says it is being fetched instead of showing the link', async () => {
    vi.stubEnv('SAM_GOV_API_KEY', 'test-key')
    const o = await notice({
      pointOfContact: [{ type: 'primary', fullName: 'Pat Officer', email: 'pat@agency.test' }],
      resourceLinks: ['https://sam.gov/api/prod/opps/v3/opportunities/resources/files/f1/download?api_key=SECRET'],
    })
    const data = await open(o.id)
    expect(data.description).toBeNull()
    expect(data).toMatchObject({ descriptionPending: true, descriptionFetch: 'fetching', pocName: 'Pat Officer', pocEmail: 'pat@agency.test' })
    expect(data.attachments).toHaveLength(1)
    expect(JSON.stringify(data.attachments)).not.toMatch(/SECRET/)
    expect(await statusOf(o.id)).toBe('QUEUED')
  })

  it('does not requeue a notice SAM.gov had no description for', async () => {
    vi.stubEnv('SAM_GOV_API_KEY', 'test-key')
    const o = await notice({ descriptionEnrichmentStatus: 'NOT_FOUND' })
    expect((await open(o.id)).descriptionFetch).toBe('unavailable')
    expect(await statusOf(o.id)).toBe('NOT_FOUND')
  })

  it('without a SAM.gov key: does not queue, and says it is unavailable', async () => {
    vi.stubEnv('SAM_GOV_API_KEY', '')
    vi.stubEnv('SAM_API_KEY', '')
    const o = await notice()
    expect((await open(o.id)).descriptionFetch).toBe('unavailable')
    expect(await statusOf(o.id)).toBeNull()
  })

  it('leaves a real description alone', async () => {
    const o = await notice({ description: 'Replace the roof of building 12.' })
    const data = await open(o.id)
    expect(data).toMatchObject({ description: 'Replace the roof of building 12.', descriptionPending: false, descriptionFetch: null })
    expect(await statusOf(o.id)).toBeNull()
  })
})
