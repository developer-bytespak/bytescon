// The Subcontracting sync uses only the firm's own SAM.gov key, never the platform's shared one.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../config/database'
import { encryptSecret } from '../utils/fieldCrypto'
import { createTestFirm, createTestUser, cleanupFirm, disconnectDb } from '../test-utils/testClient'

const scraper = vi.hoisted(() => ({
  fetchSubnetOpportunities: vi.fn(async () => []),
  fetchSamSetAsideBroad: vi.fn(async () => []),
  enrichValueFromUsaSpending: vi.fn(async () => new Map()),
}))
vi.mock('../services/subnetScraper', () => scraper)
vi.mock('../middleware/addonGate', () => ({
  requireActiveBase: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAddon: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}))

import subcontractingRoutes from './subcontracting'

const app = express()
app.use(express.json())
app.use('/api/subcontracting', subcontractingRoutes)
const firms: string[] = []
const settled = () => new Promise((r) => setTimeout(r, 300))

beforeAll(() => { vi.stubEnv('SAM_API_KEY', 'platform-shared-key') })
beforeEach(() => Object.values(scraper).forEach((f) => f.mockClear()))
afterAll(async () => {
  vi.unstubAllEnvs()
  for (const id of firms) await cleanupFirm(id)
  await disconnectDb()
})

describe('Subcontracting sync and SAM.gov', () => {
  it('skips SAM.gov set-asides without the firm\'s own key, even when the server has one, and says so', async () => {
    const firm = await createTestFirm({ name: 'No Own Key' })
    firms.push(firm.id)
    const user = await createTestUser(firm.id, { role: 'ADMIN' })
    const res = await request(app).post('/api/subcontracting/sync').set({ Authorization: `Bearer ${user.token}` }).expect(200)
    expect(res.body.samSetAsides).toBe('needs_own_key')
    await settled()
    expect(scraper.fetchSubnetOpportunities).toHaveBeenCalled()
    expect(scraper.fetchSamSetAsideBroad).not.toHaveBeenCalled()
  })

  it('uses the firm\'s own key when it has one', async () => {
    const firm = await createTestFirm({ name: 'Own Key' })
    firms.push(firm.id)
    await prisma.consultingFirm.update({ where: { id: firm.id }, data: { samApiKey: encryptSecret('firm-own-key') } })
    const user = await createTestUser(firm.id, { role: 'ADMIN' })
    const res = await request(app).post('/api/subcontracting/sync').set({ Authorization: `Bearer ${user.token}` }).expect(200)
    expect(res.body.samSetAsides).toBe('included')
    await settled()
    expect(scraper.fetchSamSetAsideBroad).toHaveBeenCalledWith('firm-own-key', undefined)
  })
})
