// The State & Municipal sync: only working portals are called, and the page is told why the rest aren't.
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest'
import { prisma } from '../config/database'
import { createTestFirm, cleanupFirm, disconnectDb } from '../test-utils/testClient'

const scrapers = vi.hoisted(() => ({
  scrapeNYSCR: vi.fn(),
  scrapeTXESBD: vi.fn(),
  scrapeFLVBS: vi.fn(),
  scrapeVAeVA: vi.fn(),
  scrapeGAGPR: vi.fn(),
  scrapeNCIPS: vi.fn(),
  scrapeOHProcurement: vi.fn(),
  scrapeILBidBuy: vi.fn(),
  scrapeCAeProcure: vi.fn(),
  scrapeMDEmma: vi.fn(),
  scrapePAeMarketplace: vi.fn(),
  scrapeSamGovByState: vi.fn(),
  scrapeUSAspendingContracts: vi.fn(),
  TOP_20_STATES: [],
}))
vi.mock('../services/stateProcurementScraper', () => scrapers)

import { syncStateMunicipalData, UNAVAILABLE_PORTALS } from './stateMunicipal'

const bid = (n: number) => ({ title: `NY bid ${n}`, agency: 'NYS DOT', state: 'NY', contractLevel: 'STATE', solicitationNumber: `NY-${Date.now()}-${n}`, responseDeadline: new Date(Date.now() + 5 * 86_400_000) })
const firms: string[] = []

beforeEach(() => {
  Object.values(scrapers).forEach((f) => typeof f === 'function' && (f as ReturnType<typeof vi.fn>).mockReset())
  scrapers.scrapeNYSCR.mockResolvedValue([bid(1), bid(2)])
  for (const k of ['scrapeFLVBS', 'scrapeCAeProcure', 'scrapeMDEmma', 'scrapePAeMarketplace', 'scrapeSamGovByState'] as const) scrapers[k].mockResolvedValue([])
})
afterAll(async () => {
  vi.unstubAllEnvs()
  for (const id of firms) await cleanupFirm(id)
  await disconnectDb()
})

describe('State & Municipal sync', () => {
  it('calls only working portals, and says why each other one gave nothing', async () => {
    for (const v of ['PORTAL_FL_USER', 'PORTAL_FL_PASS', 'PORTAL_CA_USER', 'PORTAL_CA_PASS', 'PORTAL_MD_USER', 'PORTAL_MD_PASS', 'PORTAL_PA_USER', 'PORTAL_PA_PASS']) vi.stubEnv(v, '')
    const firm = await createTestFirm({ name: 'State Sync Firm' })
    firms.push(firm.id)
    const summary = await syncStateMunicipalData(firm.id)

    expect(summary.bySource).toEqual({ nyscr: 2 })
    expect(summary.created).toBe(2)
    for (const [key, reason] of Object.entries(UNAVAILABLE_PORTALS)) expect(summary.unavailable[key]).toBe(reason)
    for (const key of ['fl', 'ca', 'md', 'pa']) expect(summary.unavailable[key]).toBe('needs portal login')
    expect(summary.unavailable.sam).toMatch(/own SAM.gov key/)

    for (const k of ['scrapeTXESBD', 'scrapeVAeVA', 'scrapeGAGPR', 'scrapeNCIPS', 'scrapeOHProcurement', 'scrapeILBidBuy', 'scrapeUSAspendingContracts', 'scrapeFLVBS', 'scrapeSamGovByState'] as const) {
      expect(scrapers[k]).not.toHaveBeenCalled()
    }
    expect(await prisma.stateMunicipalOpportunity.count({ where: { consultingFirmId: firm.id } })).toBe(2)
  })

  it('tries a login portal once its login is set', async () => {
    vi.stubEnv('PORTAL_FL_USER', 'vendor')
    vi.stubEnv('PORTAL_FL_PASS', 'secret')
    const firm = await createTestFirm({ name: 'State Sync Login Firm' })
    firms.push(firm.id)
    const summary = await syncStateMunicipalData(firm.id)
    expect(scrapers.scrapeFLVBS).toHaveBeenCalledOnce()
    expect(summary.bySource.fl).toBe(0)
    expect(summary.unavailable.fl).toBeUndefined()
  })
})
