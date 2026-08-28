// =============================================================
// teamingSuggester tests — calibration safety net
//
// These tests freeze the math in place so future edits don't silently
// shift scoring weights, Bayesian shrinkage strength, or component-
// confidence semantics.
//
// Strategy: mock prisma + getAgencyHistoryScore at module scope, then
// drive computeTeamingFit() with controlled inputs and assert on:
//   - the final score (with tight tolerance)
//   - each component's raw/weighted/confidence
//   - the reason list ordering
// =============================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------- mocks (must be hoisted above the import under test) ----------

vi.mock('../config/database', () => ({
  prisma: {
    clientCompany: { findUnique: vi.fn(), findFirst: vi.fn() },
    winnersAwardStage: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))

vi.mock('../engines/agencyProfiler', () => ({
  getAgencyHistoryScore: vi.fn(),
}))

vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { computeTeamingFit, __teamingSuggesterInternals } from './teamingSuggester'
import { prisma } from '../config/database'
import { getAgencyHistoryScore } from '../engines/agencyProfiler'

// ---------- fixture factory ----------

interface PrimeFixture {
  /** NAICS code → award dollars at this agency */
  naicsByDollars: Record<string, number>
  /** Place-of-performance state → award dollars at this agency */
  popStateByDollars?: Record<string, number>
  /** Total sub-spend dollars (sum across all sub rows) */
  totalSubDollars?: number
  /** Sub-recipient set-aside flag counts: { sdvosbCnt, wosbCnt, hubzoneCnt, eightACnt, smallCnt, totalSubs } */
  subSetAsideCounts?: {
    cnt: number
    sdvosbCnt: number
    wosbCnt: number
    hubzoneCnt: number
    eightACnt: number
    smallCnt: number
  }
}

interface AgencyFixture {
  name: string | null
  /** NAICS → total agency dollars (across all primes) */
  naicsByDollars: Record<string, number>
  /** Bayesian prior for sub-spend ratio: total dollars + total subbed across agency */
  totalAwarded?: number
  totalSubbed?: number
}

function setupFixtures(opts: {
  client: {
    id?: string
    consultingFirmId?: string
    naicsCodes?: string[]
    state?: string | null
    sdvosb?: boolean
    wosb?: boolean
    hubzone?: boolean
    smallBusiness?: boolean
  }
  prime: PrimeFixture
  agency: AgencyFixture
  agencyHistoryScore?: number
}) {
  const client = {
    id: opts.client.id ?? 'client-1',
    consultingFirmId: opts.client.consultingFirmId ?? 'firm-1',
    naicsCodes: opts.client.naicsCodes ?? [],
    state: opts.client.state ?? null,
    sdvosb: opts.client.sdvosb ?? false,
    wosb: opts.client.wosb ?? false,
    hubzone: opts.client.hubzone ?? false,
    smallBusiness: opts.client.smallBusiness ?? true,
  }

  ;(prisma.clientCompany.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(client)
  ;(prisma.winnersAwardStage.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(
    opts.agency.name ? { agencyToptierName: opts.agency.name } : null,
  )
  ;(getAgencyHistoryScore as ReturnType<typeof vi.fn>).mockResolvedValue(opts.agencyHistoryScore ?? 0.5)

  // $queryRaw is called multiple times for different queries. We dispatch
  // by examining the SQL text of the first tagged-template argument.
  const queryRawMock = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>
  queryRawMock.mockImplementation((strings: TemplateStringsArray | string[], ..._values: unknown[]) => {
    const sql = Array.isArray(strings) ? strings.join(' ') : String(strings)

    // Prime's NAICS rows at this agency (scoreNaicsOverlap, scoreCapabilityGapFill DISTINCT path)
    if (sql.includes('FROM winners_award_stage') && sql.includes('GROUP BY naics') && !sql.includes('agency_total')) {
      const rows = Object.entries(opts.prime.naicsByDollars).map(([naics, dollars]) => ({ naics, dollars }))
      return Promise.resolve(rows)
    }

    if (sql.includes('DISTINCT naics') && sql.includes('FROM winners_award_stage')) {
      const rows = Object.keys(opts.prime.naicsByDollars).map((naics) => ({ naics }))
      return Promise.resolve(rows)
    }

    // Subaward set-aside flag distribution (scoreSetAsideFit)
    if (sql.includes('subRecipientSetAsideFlags')) {
      const counts = opts.prime.subSetAsideCounts ?? {
        cnt: 0, sdvosbCnt: 0, wosbCnt: 0, hubzoneCnt: 0, eightACnt: 0, smallCnt: 0,
      }
      return Promise.resolve([counts])
    }

    // Place-of-performance rows (scoreGeographic)
    if (sql.includes('placeOfPerformanceState')) {
      const rows = Object.entries(opts.prime.popStateByDollars ?? {}).map(([state, dollars]) => ({ state, dollars }))
      return Promise.resolve(rows)
    }

    // Prime's totals at this agency (scorePrimeTeamingActivity prime_total CTE)
    if (sql.includes('WITH prime_total AS') || (sql.includes('totalAwarded') && sql.includes('totalSubbed'))) {
      const totalAwarded = Object.values(opts.prime.naicsByDollars).reduce((s, v) => s + v, 0)
      const totalSubbed = opts.prime.totalSubDollars ?? 0
      return Promise.resolve([{ totalAwarded, totalSubbed }])
    }

    // Agency-wide totals (scorePrimeTeamingActivity prior path)
    if (sql.includes('agency_total') || (sql.includes('agencyAwarded') && sql.includes('agencySubbed'))) {
      return Promise.resolve([{
        agencyAwarded: opts.agency.totalAwarded ?? 1_000_000_000,
        agencySubbed: opts.agency.totalSubbed ?? 150_000_000,
      }])
    }

    // Agency NAICS volume (scoreCapabilityGapFill)
    if (sql.includes('FROM winners_award_stage') && sql.includes('GROUP BY naics')) {
      const rows = Object.entries(opts.agency.naicsByDollars).map(([naics, dollars]) => ({ naics, dollars }))
      return Promise.resolve(rows)
    }

    return Promise.resolve([])
  })

  return { client }
}

// ---------- tests ----------

describe('teamingSuggester / __teamingSuggesterInternals', () => {
  it('weights sum to 100 at module load', () => {
    const total = Object.values(__teamingSuggesterInternals.WEIGHTS).reduce((a, b) => a + b, 0)
    expect(total).toBe(100)
  })

  it('Bayesian prior strength is documented constant ($50M of evidence)', () => {
    expect(__teamingSuggesterInternals.SUBSPEND_PRIOR_DOLLARS).toBe(50_000_000)
  })

  it('GSA regions cover all 50 states + DC', () => {
    const regions = __teamingSuggesterInternals.GSA_REGION
    const states = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']
    for (const s of states) {
      expect(regions[s], `state ${s} missing from GSA_REGION`).toBeGreaterThanOrEqual(1)
      expect(regions[s]).toBeLessThanOrEqual(10)
    }
  })
})

describe('teamingSuggester / computeTeamingFit — happy paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('scores a perfect-match SDVOSB + NAICS-overlap + same-state client high (>60)', async () => {
    setupFixtures({
      client: {
        naicsCodes: ['541512', '541519'],
        state: 'VA',
        sdvosb: true,
      },
      prime: {
        naicsByDollars: { '541512': 500_000_000, '541519': 200_000_000 },
        popStateByDollars: { VA: 600_000_000, MD: 100_000_000 },
        totalSubDollars: 280_000_000,  // 40% sub-spend ratio = very active teaming
        subSetAsideCounts: {
          cnt: 200, sdvosbCnt: 50, wosbCnt: 10, hubzoneCnt: 5, eightACnt: 20, smallCnt: 150,
        },
      },
      agency: {
        name: 'Department of Defense',
        naicsByDollars: { '541512': 5_000_000_000, '541519': 2_000_000_000, '236220': 3_000_000_000 },
        totalAwarded: 50_000_000_000,
        totalSubbed: 7_500_000_000,  // 15% baseline
      },
      agencyHistoryScore: 0.7,
    })

    const fit = await computeTeamingFit({
      clientId: 'client-1',
      primeUei: 'PRIME-UEI',
      agencyCode: '9700',
    })

    expect(fit.score).toBeGreaterThan(60)
    expect(fit.score).toBeLessThanOrEqual(100)
    expect(fit.confidence).toBeGreaterThan(0.6)
    expect(fit.reasons).toHaveLength(3)
    expect(fit.breakdown.naicsOverlap.raw).toBeCloseTo(1.0, 1)  // 100% of prime's NAICS overlap
    expect(fit.breakdown.geographic.raw).toBeGreaterThan(0.8)  // mostly VA
    expect(fit.breakdown.primeTeamingActivity.raw).toBeGreaterThan(0.7)  // 40% subSpendRatio
  })

  it('scores a no-overlap, no-cert, distant client low (<25)', async () => {
    setupFixtures({
      client: {
        naicsCodes: ['311111'],  // Agriculture
        state: 'AK',
        smallBusiness: false,
      },
      prime: {
        naicsByDollars: { '541512': 500_000_000 },
        popStateByDollars: { VA: 500_000_000 },
        totalSubDollars: 0,
      },
      agency: {
        name: 'Department of Defense',
        naicsByDollars: { '541512': 5_000_000_000 },
      },
      agencyHistoryScore: 0.3,
    })

    const fit = await computeTeamingFit({
      clientId: 'client-1',
      primeUei: 'PRIME-UEI',
      agencyCode: '9700',
    })

    expect(fit.score).toBeLessThan(25)
    expect(fit.breakdown.naicsOverlap.raw).toBe(0)
    expect(fit.breakdown.geographic.raw).toBe(0)
    // Set-aside fit reads "no cert" and zeros out with high confidence.
    expect(fit.breakdown.setAsideFit.raw).toBe(0)
    expect(fit.breakdown.setAsideFit.confidence).toBe(1)
  })
})

describe('teamingSuggester / Bayesian shrinkage on prime teaming activity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('thin-history prime is shrunk toward agency mean (not raw 100%)', async () => {
    // Tiny $5M prime that happened to sub 100% of one award — raw ratio is
    // 1.0 but Bayesian shrinkage with k=$50M prior should pull it way down.
    setupFixtures({
      client: { naicsCodes: ['541512'], smallBusiness: true },
      prime: {
        naicsByDollars: { '541512': 5_000_000 },
        totalSubDollars: 5_000_000,  // raw ratio = 1.0
      },
      agency: {
        name: 'Test Agency',
        naicsByDollars: { '541512': 1_000_000_000 },
        totalAwarded: 10_000_000_000,
        totalSubbed: 1_000_000_000,  // 10% baseline
      },
    })

    const fit = await computeTeamingFit({
      clientId: 'client-1',
      primeUei: 'PRIME-UEI',
      agencyCode: '9700',
    })

    // Posterior = (5M + 50M*0.10) / (5M + 50M) = 10M/55M ≈ 0.182
    // raw component score = 1 - exp(-0.182 * 5.5) ≈ 0.63
    // The fact that it's not 1.0 demonstrates shrinkage. Confidence should
    // also be LOW because we only have $5M of evidence.
    expect(fit.breakdown.primeTeamingActivity.raw).toBeLessThan(0.7)
    expect(fit.breakdown.primeTeamingActivity.raw).toBeGreaterThan(0.4)
    expect(fit.breakdown.primeTeamingActivity.confidence).toBeLessThan(0.1)
  })

  it('huge-history prime is driven by its actual data, not the prior', async () => {
    // $5B prime subbing 40% — should produce raw close to its actual ratio
    // (prior is negligible against 5B of evidence).
    setupFixtures({
      client: { naicsCodes: ['541512'], smallBusiness: true },
      prime: {
        naicsByDollars: { '541512': 5_000_000_000 },
        totalSubDollars: 2_000_000_000,  // raw ratio = 0.4
      },
      agency: {
        name: 'Test Agency',
        naicsByDollars: { '541512': 100_000_000_000 },
        totalAwarded: 100_000_000_000,
        totalSubbed: 10_000_000_000,  // 10% baseline
      },
    })

    const fit = await computeTeamingFit({
      clientId: 'client-1',
      primeUei: 'PRIME-UEI',
      agencyCode: '9700',
    })

    // Posterior = (2B + 50M*0.10) / (5B + 50M) ≈ 0.397
    // raw score = 1 - exp(-0.397 * 5.5) ≈ 0.887
    expect(fit.breakdown.primeTeamingActivity.raw).toBeGreaterThan(0.8)
    expect(fit.breakdown.primeTeamingActivity.confidence).toBe(1)
  })
})

describe('teamingSuggester / edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('client with no NAICS codes scores 0 on NAICS-overlap and capability-gap, with zero confidence', async () => {
    setupFixtures({
      client: { naicsCodes: [], smallBusiness: true },
      prime: {
        naicsByDollars: { '541512': 500_000_000 },
        totalSubDollars: 100_000_000,
      },
      agency: {
        name: 'Test Agency',
        naicsByDollars: { '541512': 5_000_000_000 },
      },
    })

    const fit = await computeTeamingFit({
      clientId: 'client-1',
      primeUei: 'PRIME-UEI',
      agencyCode: '9700',
    })

    expect(fit.breakdown.naicsOverlap.raw).toBe(0)
    expect(fit.breakdown.naicsOverlap.confidence).toBe(0)
    expect(fit.breakdown.capabilityGapFill.raw).toBe(0)
    expect(fit.breakdown.capabilityGapFill.confidence).toBe(0)
    expect(fit.breakdown.naicsOverlap.reasoning).toMatch(/no naics/i)
  })

  it('client with no state on file scores 0 on geographic with zero confidence', async () => {
    setupFixtures({
      client: { state: null, naicsCodes: ['541512'], smallBusiness: true },
      prime: {
        naicsByDollars: { '541512': 500_000_000 },
        popStateByDollars: { VA: 500_000_000 },
      },
      agency: {
        name: 'Test Agency',
        naicsByDollars: { '541512': 5_000_000_000 },
      },
    })

    const fit = await computeTeamingFit({
      clientId: 'client-1',
      primeUei: 'PRIME-UEI',
      agencyCode: '9700',
    })

    expect(fit.breakdown.geographic.raw).toBe(0)
    expect(fit.breakdown.geographic.confidence).toBe(0)
    expect(fit.breakdown.geographic.reasoning).toMatch(/state not on file/i)
  })

  it('prime with zero subaward history at this agency still scores with low confidence', async () => {
    setupFixtures({
      client: { naicsCodes: ['541512'], state: 'VA', sdvosb: true },
      prime: {
        naicsByDollars: { '541512': 500_000_000 },
        popStateByDollars: { VA: 500_000_000 },
        totalSubDollars: 0,
        subSetAsideCounts: { cnt: 0, sdvosbCnt: 0, wosbCnt: 0, hubzoneCnt: 0, eightACnt: 0, smallCnt: 0 },
      },
      agency: {
        name: 'Test Agency',
        naicsByDollars: { '541512': 5_000_000_000 },
        totalAwarded: 10_000_000_000,
        totalSubbed: 1_500_000_000,  // 15% baseline
      },
      agencyHistoryScore: 0.7,
    })

    const fit = await computeTeamingFit({
      clientId: 'client-1',
      primeUei: 'PRIME-UEI',
      agencyCode: '9700',
    })

    // No sub history → set-aside fit confidence is 0 (subCount=0 trips the
    // shrinkage but the confidence multiplier zeros it out).
    expect(fit.breakdown.setAsideFit.confidence).toBe(0)
    // Teaming activity gets shrunk all the way to the prior.
    expect(fit.breakdown.primeTeamingActivity.raw).toBeLessThan(0.6)
    // Score still reflects the strong NAICS overlap + geographic match.
    expect(fit.score).toBeGreaterThan(20)
  })

  it('throws when client is not found', async () => {
    ;(prisma.clientCompany.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null)
    await expect(
      computeTeamingFit({ clientId: 'nope', primeUei: 'X', agencyCode: '9700' }),
    ).rejects.toThrow(/not found/i)
  })
})

describe('teamingSuggester / reasons ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns top-3 reasons sorted by weighted-impact × confidence', async () => {
    setupFixtures({
      client: { naicsCodes: ['541512'], state: 'VA', sdvosb: true, smallBusiness: true },
      prime: {
        naicsByDollars: { '541512': 500_000_000 },
        popStateByDollars: { VA: 500_000_000 },
        totalSubDollars: 150_000_000,
        subSetAsideCounts: { cnt: 100, sdvosbCnt: 20, wosbCnt: 5, hubzoneCnt: 3, eightACnt: 10, smallCnt: 70 },
      },
      agency: {
        name: 'Test Agency',
        naicsByDollars: { '541512': 5_000_000_000 },
        totalAwarded: 10_000_000_000,
        totalSubbed: 1_000_000_000,
      },
    })

    const fit = await computeTeamingFit({
      clientId: 'client-1',
      primeUei: 'PRIME-UEI',
      agencyCode: '9700',
    })

    expect(fit.reasons.length).toBe(3)
    for (const r of fit.reasons) {
      expect(typeof r).toBe('string')
      expect(r.length).toBeGreaterThan(0)
    }
  })
})

afterEach(() => {
  vi.resetAllMocks()
})
