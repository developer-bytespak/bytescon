// =============================================================
// GB-105 — Agency View v2 profile endpoint tests
//
// Verifies the four SQL-aggregated datasets returned by
// GET /api/agency/:agencyCode/profile against seeded multi-agency
// award data, the fiscal-year window, the PSC rollup (validating
// GB-102 end to end), and a query-count guard against N+1.
//
// winners_award_stage is platform-wide (not tenant-scoped), so we
// isolate by seeding synthetic agency codes that cannot collide with
// real USAspending data, and clean up by refreshBatchId.
// =============================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import express, { Express } from 'express'
import request from 'supertest'
import { prisma } from '../config/database'
import { errorHandler, notFoundHandler } from '../middleware/errorHandler'
import agencyRoutes from './agency'
import { createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

const BATCH = `gb105-test-${Date.now()}`
const AGENCY_A = `AGCYTEST_A_${Date.now()}`
const AGENCY_B = `AGCYTEST_B_${Date.now()}`

let app: Express
let firm: TestFirm
let user: TestUser

function buildApp(): Express {
  const a = express()
  a.use(express.json())
  a.use('/api/agency', agencyRoutes)
  a.use(notFoundHandler)
  a.use(errorHandler)
  return a
}

interface SeedRow {
  agency: string
  fy: number
  naics: string
  psc: string
  setAside: string | null
  dollars: number
  recompete?: boolean
}

let seq = 0
async function seed(rows: SeedRow[]) {
  await prisma.winnersAwardStage.createMany({
    data: rows.map((r) => {
      seq += 1
      return {
        usaspendingAwardId: `${BATCH}-${seq}`,
        refreshBatchId: BATCH,
        agencyToptierCode: r.agency,
        agencyToptierName: r.agency === AGENCY_A ? 'Test Agency Alpha' : 'Test Agency Bravo',
        naics: r.naics,
        pscCode: r.psc,
        setAsideType: r.setAside,
        totalObligation: r.dollars,
        fiscalYear: r.fy,
        isRecompete: r.recompete ?? false,
      }
    }),
  })
}

async function getProfile(agency: string, windowYears?: number) {
  const q = windowYears ? `?windowYears=${windowYears}` : ''
  return request(app)
    .get(`/api/agency/${agency}/profile${q}`)
    .set('Authorization', `Bearer ${user.token}`)
}

beforeAll(async () => {
  app = buildApp()
  firm = await createTestFirm({ name: 'GB105 Firm' })
  user = await createTestUser(firm.id, { role: 'ADMIN' })

  // Agency A: FY2023–2025. 488510 recurs (FY2023 + FY2025); 484121 only FY2024.
  await seed([
    { agency: AGENCY_A, fy: 2025, naics: '488510', psc: 'V112', setAside: 'SDVOSBC', dollars: 100 },
    { agency: AGENCY_A, fy: 2025, naics: '488510', psc: 'V112', setAside: 'SDVOSBC', dollars: 200 },
    { agency: AGENCY_A, fy: 2024, naics: '484121', psc: 'R425', setAside: null, dollars: 300, recompete: true },
    { agency: AGENCY_A, fy: 2023, naics: '488510', psc: 'V112', setAside: null, dollars: 50 },
  ])
  // Agency B: distinct NAICS/PSC, used for isolation + N+1 volume contrast.
  await seed([{ agency: AGENCY_B, fy: 2025, naics: '541614', psc: 'D399', setAside: 'WOSB', dollars: 999 }])
})

afterAll(async () => {
  await prisma.winnersAwardStage.deleteMany({ where: { refreshBatchId: BATCH } }).catch(() => {})
  await cleanupFirm(firm?.id).catch(() => {})
  await disconnectDb()
})

describe('GET /api/agency/:agencyCode/profile', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get(`/api/agency/${AGENCY_A}/profile`)
    expect(res.status).toBe(401)
    expect(res.body.success).toBe(false)
  })

  it('aggregates spend and activity over the default window', async () => {
    const res = await getProfile(AGENCY_A)
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.window.fyStart).toBe(2023)
    expect(d.window.fyEnd).toBe(2025)
    expect(d.spendActivity.totalDollars).toBe(650) // 100+200+300+50
    expect(d.spendActivity.totalAwards).toBe(4)
    expect(d.spendActivity.byFiscalYear).toHaveLength(3)
  })

  it('ranks top NAICS with correct counts and dollar share', async () => {
    const res = await getProfile(AGENCY_A)
    const naics = res.body.data.topClassifications.topNaics
    expect(naics[0].code).toBe('488510')
    expect(naics[0].count).toBe(3)
    expect(naics[0].dollars).toBe(350)
    expect(naics[0].dollarShare).toBeCloseTo(350 / 650, 5)
    expect(naics[1].code).toBe('484121')
  })

  it('populates the top PSC list (validates GB-102 pscCode end to end)', async () => {
    const res = await getProfile(AGENCY_A)
    const psc = res.body.data.topClassifications.topPsc
    expect(psc.map((p: { code: string }) => p.code)).toEqual(['V112', 'R425'])
    expect(psc[0].dollars).toBe(350)
    expect(psc[0].count).toBe(3)
  })

  it('breaks down set-aside utilization', async () => {
    const res = await getProfile(AGENCY_A)
    const sa = res.body.data.setAsideUtilization as { setAsideType: string; dollars: number }[]
    const none = sa.find((s) => s.setAsideType === 'NONE')
    const sdvosb = sa.find((s) => s.setAsideType === 'SDVOSBC')
    expect(none?.dollars).toBe(350) // 300 + 50
    expect(sdvosb?.dollars).toBe(300) // 100 + 200
  })

  it('flags NAICS recurring across >=2 fiscal years', async () => {
    const res = await getProfile(AGENCY_A)
    const rec = res.body.data.recurringPatterns as { naics: string; yearsActive: number }[]
    const codes = rec.map((r) => r.naics)
    expect(codes).toContain('488510') // FY2023 + FY2025
    expect(codes).not.toContain('484121') // FY2024 only
    expect(rec.find((r) => r.naics === '488510')?.yearsActive).toBe(2)
  })

  it('narrows results when windowYears=1', async () => {
    const res = await getProfile(AGENCY_A, 1)
    const d = res.body.data
    expect(d.window.fyStart).toBe(2025)
    expect(d.spendActivity.totalDollars).toBe(300) // FY2025 only: 100+200
    expect(d.spendActivity.totalAwards).toBe(2)
  })

  it('does not bleed data across agencies', async () => {
    const res = await getProfile(AGENCY_A)
    const naics = res.body.data.topClassifications.topNaics.map((n: { code: string }) => n.code)
    expect(naics).not.toContain('541614') // belongs to AGENCY_B
  })

  it('excludes malformed NAICS/PSC codes (the "[object Object]" corruption) from every aggregation', async () => {
    // Fresh agency code — the other agencies' profiles are already cached.
    const agency = `AGCYTEST_CORRUPT_${Date.now()}`
    await seed([
      { agency, fy: 2025, naics: '488510', psc: 'V112', setAside: null, dollars: 100 },
      { agency, fy: 2024, naics: '488510', psc: 'V112', setAside: null, dollars: 50 },
    ])
    // Legacy-ingest garbage: object coerced with String(). Recurs across FYs
    // and dwarfs the real rows — exactly the shape that topped the live page.
    await seed([
      { agency, fy: 2025, naics: '[object Object]', psc: '[object Object]', setAside: null, dollars: 9_000_000 },
      { agency, fy: 2024, naics: '[object Object]', psc: '[object Object]', setAside: null, dollars: 9_000_000 },
    ])

    const res = await getProfile(agency)
    expect(res.status).toBe(200)
    const d = res.body.data
    const naicsCodes = d.topClassifications.topNaics.map((n: { code: string }) => n.code)
    const pscCodes = d.topClassifications.topPsc.map((p: { code: string }) => p.code)
    const recurring = d.recurringPatterns.map((r: { naics: string }) => r.naics)
    expect(naicsCodes).toEqual(['488510'])
    expect(pscCodes).toEqual(['V112'])
    expect(recurring).toEqual(['488510'])
    // The corrupt rows' dollars still count toward overall spend — the award
    // is real, only its classification is unusable.
    expect(d.spendActivity.totalAwards).toBe(4)
  })

  it('issues a constant number of queries regardless of row volume (no N+1)', async () => {
    const spy = vi.spyOn(prisma, '$queryRaw')

    // Fresh agency codes => cold cache for both calls.
    const small = `AGCYTEST_N1S_${Date.now()}`
    const large = `AGCYTEST_N1L_${Date.now()}`
    await seed([{ agency: small, fy: 2025, naics: '488510', psc: 'V112', setAside: null, dollars: 10 }])
    await seed(
      Array.from({ length: 40 }, (_, i) => ({
        agency: large,
        fy: 2023 + (i % 3),
        naics: `4885${10 + (i % 5)}`,
        psc: `V1${10 + (i % 5)}`,
        setAside: i % 2 ? 'SDVOSBC' : null,
        dollars: 10 + i,
      })),
    )

    spy.mockClear()
    await getProfile(small)
    const smallCount = spy.mock.calls.length

    spy.mockClear()
    await getProfile(large)
    const largeCount = spy.mock.calls.length

    expect(smallCount).toBeGreaterThan(0)
    expect(largeCount).toBe(smallCount)
    spy.mockRestore()
  })
})
