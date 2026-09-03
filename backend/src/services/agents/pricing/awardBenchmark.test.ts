// =============================================================
// §7.6 — Award benchmarking.
//
// Two things are proven here.
//
// 1. THE DISTRIBUTION IS EXACT. Percentiles are pinned to controlled Decimal
//    fixtures — odd counts, even counts, duplicates, cents, and values large
//    enough that a float would have drifted.
//
// 2. THE COHORT IS HONEST. Below the minimum there is no percentile and no
//    verdict; a relaxed filter is always recorded; a vehicle ceiling is
//    excluded with a reason rather than normalised into a unit price.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../../../test-utils/testClient'
import {
  percentile,
  computeDistribution,
  assessComparability,
  buildAwardBenchmark,
  persistBenchmarkCohort,
  buildCohortHash,
  MIN_BENCHMARK_COHORT_SIZE,
  STRONG_BENCHMARK_COHORT_SIZE,
  DEFAULT_LOOKBACK_MONTHS,
  VALUE_BAND_LOW_RATIO,
  VALUE_BAND_HIGH_RATIO,
  FILTER_LADDER,
  type RawAward,
} from './awardBenchmark'

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)
const DAY = 86_400_000
const NOW = new Date('2026-08-12T00:00:00.000Z')

let firm: TestFirm
let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

// The benchmark reads PUBLIC award records across tenants by design, so this
// suite isolates itself with a NAICS and agency no other fixture uses. That
// keeps the assertions deterministic without weakening the production query.
const QA_NAICS = `99${String(process.pid).slice(-4).padStart(4, '0')}`
const QA_AGENCY = `S7-PRICE-QA Agency ${process.pid}`

beforeAll(async () => { firm = await createTestFirm({ name: 'Award Benchmark Firm' }) })
afterAll(async () => { await cleanupFirm(firm.id); await disconnectDb() })

beforeEach(async () => {
  await prisma.awardBenchmarkCohort.deleteMany({ where: { consultingFirmId: firm.id } })
  await prisma.awardHistory.deleteMany({ where: { opportunity: { consultingFirmId: firm.id } } })
  await prisma.opportunity.deleteMany({ where: { consultingFirmId: firm.id } })
})

/** A public award attached to an opportunity carrying the set-aside. */
async function makeAward(args: {
  amount: string
  agency?: string
  naics?: string
  setAside?: string
  monthsAgo?: number
  awardType?: string | null
  contractNumber?: string | null
  baseAndAllOptions?: string | null
}) {
  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id, samNoticeId: uniq('S7-PRICE-QA'),
      title: 'S7-PRICE-QA award source', agency: args.agency ?? QA_AGENCY,
      naicsCode: args.naics ?? QA_NAICS, setAsideType: args.setAside ?? 'SDVOSB',
      responseDeadline: new Date(NOW.getTime() - 400 * DAY),
      status: 'ARCHIVED', isDemo: false,
    },
  })
  const awardDate = new Date(NOW.getTime() - (args.monthsAgo ?? 6) * 30 * DAY)
  return prisma.awardHistory.create({
    data: {
      opportunityId: opp.id,
      awardingAgency: args.agency ?? QA_AGENCY,
      recipientName: uniq('S7-PRICE-QA Recipient'),
      awardAmount: new Prisma.Decimal(args.amount),
      baseAndAllOptions: args.baseAndAllOptions ? new Prisma.Decimal(args.baseAndAllOptions) : null,
      awardDate,
      naics: args.naics ?? QA_NAICS,
      awardType: args.awardType === undefined ? 'DO' : args.awardType,
      contractNumber: args.contractNumber === undefined ? uniq('C') : args.contractNumber,
    },
  })
}

const request = (over: Record<string, unknown> = {}) => ({
  consultingFirmId: firm.id,
  opportunityId: null,
  pricingWorkspaceId: null,
  pricingScenarioId: null,
  naics: QA_NAICS,
  agency: QA_AGENCY,
  setAside: 'SDVOSB',
  referencePrice: D('100000.00'),
  now: NOW,
  ...over,
})

// -------------------------------------------------------------
// Distribution — exact, pinned
// -------------------------------------------------------------

describe('percentile interpolation is exact and deterministic', () => {
  const values = (...v: string[]) => v.map((x) => D(x))

  it('returns the only value for a single-element sample', () => {
    expect(percentile(values('100.00'), 0.5)!.toFixed(2)).toBe('100.00')
  })

  it('returns null for an empty sample', () => {
    expect(percentile([], 0.5)).toBeNull()
  })

  it('pins an odd-count median to the middle element', () => {
    const v = values('10.00', '20.00', '30.00', '40.00', '50.00')
    expect(percentile(v, 0.5)!.toFixed(2)).toBe('30.00')
  })

  it('pins an even-count median to the interpolated midpoint', () => {
    const v = values('10.00', '20.00', '30.00', '40.00')
    expect(percentile(v, 0.5)!.toFixed(2)).toBe('25.00')
  })

  it('pins p25 and p75 on a four-element sample', () => {
    const v = values('10.00', '20.00', '30.00', '40.00')
    expect(percentile(v, 0.25)!.toFixed(2)).toBe('17.50')
    expect(percentile(v, 0.75)!.toFixed(2)).toBe('32.50')
  })

  it('pins the quartiles on a nine-element sample', () => {
    const v = values('1.00', '2.00', '3.00', '4.00', '5.00', '6.00', '7.00', '8.00', '9.00')
    expect(percentile(v, 0.25)!.toFixed(2)).toBe('3.00')
    expect(percentile(v, 0.5)!.toFixed(2)).toBe('5.00')
    expect(percentile(v, 0.75)!.toFixed(2)).toBe('7.00')
  })

  it('handles duplicates without shifting the median', () => {
    const v = values('5.00', '5.00', '5.00', '5.00', '5.00')
    expect(percentile(v, 0.5)!.toFixed(2)).toBe('5.00')
    expect(percentile(v, 0.25)!.toFixed(2)).toBe('5.00')
  })

  it('preserves cents exactly through interpolation', () => {
    const v = values('100.01', '100.02')
    expect(percentile(v, 0.5)!.toFixed(2)).toBe('100.02')
  })

  it('interpolates cents without float drift', () => {
    const v = values('0.10', '0.20', '0.30')
    expect(percentile(v, 0.5)!.toFixed(2)).toBe('0.20')
  })

  it('handles very large contract values exactly', () => {
    const v = values('999999999999.99', '1000000000000.01')
    expect(percentile(v, 0.5)!.toFixed(2)).toBe('1000000000000.00')
  })

  it('clamps p<=0 and p>=1 to the extremes', () => {
    const v = values('10.00', '20.00', '30.00')
    expect(percentile(v, 0)!.toFixed(2)).toBe('10.00')
    expect(percentile(v, 1)!.toFixed(2)).toBe('30.00')
  })
})

describe('computeDistribution', () => {
  it('reports min, quartiles, max and mean on a controlled sample', () => {
    const d = computeDistribution(['10.00', '20.00', '30.00', '40.00', '50.00'].map((v) => D(v)))
    expect(d.minimum!.toFixed(2)).toBe('10.00')
    expect(d.p25!.toFixed(2)).toBe('20.00')
    expect(d.median!.toFixed(2)).toBe('30.00')
    expect(d.p75!.toFixed(2)).toBe('40.00')
    expect(d.maximum!.toFixed(2)).toBe('50.00')
    expect(d.mean!.toFixed(2)).toBe('30.00')
  })

  it('is order-independent', () => {
    const a = computeDistribution(['50.00', '10.00', '30.00', '20.00', '40.00'].map((v) => D(v)))
    const b = computeDistribution(['10.00', '20.00', '30.00', '40.00', '50.00'].map((v) => D(v)))
    expect(a.median!.toFixed(2)).toBe(b.median!.toFixed(2))
    expect(a.p25!.toFixed(2)).toBe(b.p25!.toFixed(2))
  })

  it('returns all-null for an empty sample rather than zeros', () => {
    const d = computeDistribution([])
    expect(d.minimum).toBeNull()
    expect(d.median).toBeNull()
    expect(d.mean).toBeNull()
  })

  it('computes an exact cent-level mean', () => {
    const d = computeDistribution(['100.01', '100.02', '100.03'].map((v) => D(v)))
    expect(d.mean!.toFixed(2)).toBe('100.02')
  })
})

// -------------------------------------------------------------
// Comparability
// -------------------------------------------------------------

describe('award comparability', () => {
  const award = (over: Partial<RawAward> = {}): RawAward => ({
    id: 'a1', awardingAgency: 'DoD', recipientName: 'R', awardAmount: D('100000.00'),
    baseAndAllOptions: null, awardDate: NOW, naics: '541512',
    awardType: 'DO', contractNumber: 'C1', setAside: 'SDVOSB', ...over,
  })

  it('accepts an ordinary single-award record', () => {
    expect(assessComparability(award()).comparable).toBe(true)
  })

  it('excludes a zero-value award with a reason', () => {
    const r = assessComparability(award({ awardAmount: D('0') }))
    expect(r.comparable).toBe(false)
    expect(r.reason).toContain('zero or negative')
  })

  it('excludes a negative award value', () => {
    expect(assessComparability(award({ awardAmount: D('-5000') })).comparable).toBe(false)
  })

  it.each(['IDIQ', 'BPA', 'GWAC', 'MATOC'])('excludes a %s vehicle ceiling', (type) => {
    const r = assessComparability(award({ awardType: type }))
    expect(r.comparable).toBe(false)
    expect(r.reason).toContain('multi-award vehicle ceiling')
  })

  it('excludes a record whose base-and-all-options dwarfs the award amount', () => {
    const r = assessComparability(award({ awardAmount: D('100000'), baseAndAllOptions: D('900000') }))
    expect(r.comparable).toBe(false)
    expect(r.reason).toContain('multi-year ceiling')
  })

  it('accepts a record whose options are proportionate', () => {
    expect(assessComparability(award({ awardAmount: D('100000'), baseAndAllOptions: D('250000') })).comparable).toBe(true)
  })

  it('never fabricates a normalised unit price for an excluded record', () => {
    const r = assessComparability(award({ awardType: 'IDIQ' }))
    expect(r.reason).toContain('NOT_COMPARABLE')
    expect(r.reason).not.toMatch(/normalis|per year|annualis/i)
  })
})

// -------------------------------------------------------------
// Cohort construction
// -------------------------------------------------------------

describe('cohort size drives everything', () => {
  async function seed(count: number, amount = '100000.00') {
    for (let i = 0; i < count; i += 1) await makeAward({ amount })
  }

  it('reports INSUFFICIENT_DATA with zero comparable awards', async () => {
    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(0)
    expect(r.dataSufficiency).toBe('INSUFFICIENT_DATA')
    expect(r.filterLevel).toBe('NONE')
    expect(r.distribution.median).toBeNull()
  })

  it('reports INSUFFICIENT_DATA with one award', async () => {
    await seed(1)
    const r = await buildAwardBenchmark(request())
    expect(r.dataSufficiency).toBe('INSUFFICIENT_DATA')
    expect(r.distribution.median).toBeNull()
  })

  it('reports INSUFFICIENT_DATA one below the minimum', async () => {
    await seed(MIN_BENCHMARK_COHORT_SIZE - 1)
    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(MIN_BENCHMARK_COHORT_SIZE - 1)
    expect(r.dataSufficiency).toBe('INSUFFICIENT_DATA')
    expect(r.distribution.median).toBeNull()
    expect(r.limitations.join(' ')).toContain(`minimum ${MIN_BENCHMARK_COHORT_SIZE}`)
  })

  it('produces a distribution at exactly the minimum', async () => {
    await seed(MIN_BENCHMARK_COHORT_SIZE)
    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(MIN_BENCHMARK_COHORT_SIZE)
    expect(r.dataSufficiency).toBe('PARTIAL')
    expect(r.distribution.median!.toFixed(2)).toBe('100000.00')
  })

  it('stays PARTIAL one above the minimum', async () => {
    await seed(MIN_BENCHMARK_COHORT_SIZE + 1)
    const r = await buildAwardBenchmark(request())
    expect(r.dataSufficiency).toBe('PARTIAL')
  })

  it('becomes SUFFICIENT at the strong threshold', async () => {
    await seed(STRONG_BENCHMARK_COHORT_SIZE)
    const r = await buildAwardBenchmark(request())
    expect(r.dataSufficiency).toBe('SUFFICIENT')
  })

  it('says an empty cohort is not a statement about the price', async () => {
    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(0)
    // Two honest-empty paths exist (no candidates at all vs. zero comparable
    // after filtering) with different phrasings of the same doctrine; which
    // fires depends on unrelated award rows in the database. Assert the
    // invariant, not one path's wording.
    expect(r.limitations.join(' ')).toMatch(/not about the price|says nothing about whether the proposed price is right/)
  })
})

describe('cohort filters', () => {
  async function seedComparable(count: number, over: Parameters<typeof makeAward>[0] = { amount: '100000.00' }) {
    for (let i = 0; i < count; i += 1) await makeAward(over)
  }

  it('excludes a different NAICS', async () => {
    await seedComparable(MIN_BENCHMARK_COHORT_SIZE, { amount: '100000.00', naics: '236220' })
    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(0)
  })

  it('excludes an award outside the value band', async () => {
    // 4× the reference price is the ceiling; 10× is outside every rung
    // except LEVEL_4, which needs its own minimum.
    await seedComparable(MIN_BENCHMARK_COHORT_SIZE, { amount: '1000000.00' })
    const r = await buildAwardBenchmark(request({ referencePrice: D('100000.00') }))
    expect(r.filterLevel).toBe('LEVEL_4_NAICS')
    expect(r.relaxedFilters).toContain('award-value band')
  })

  it('excludes an award outside the lookback period', async () => {
    await seedComparable(MIN_BENCHMARK_COHORT_SIZE, { amount: '100000.00', monthsAgo: DEFAULT_LOOKBACK_MONTHS + 12 })
    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(0)
  })

  it('records the exact lookback window on the result', async () => {
    const r = await buildAwardBenchmark(request())
    const months = (r.periodEnd.getTime() - r.periodStart.getTime()) / (30 * DAY)
    expect(Math.round(months)).toBeGreaterThanOrEqual(DEFAULT_LOOKBACK_MONTHS - 2)
    expect(r.periodEnd.toISOString()).toBe(NOW.toISOString())
  })

  it('records the value band it applied', async () => {
    const r = await buildAwardBenchmark(request({ referencePrice: D('100000.00') }))
    expect(r.valueBandLow!.toFixed(2)).toBe(D('100000').times(VALUE_BAND_LOW_RATIO).toFixed(2))
    expect(r.valueBandHigh!.toFixed(2)).toBe(D('100000').times(VALUE_BAND_HIGH_RATIO).toFixed(2))
  })

  it('says so when no price was available to build a band from', async () => {
    const r = await buildAwardBenchmark(request({ referencePrice: null }))
    expect(r.limitations.join(' ')).toContain('could not be filtered to a comparable value band')
  })

  it('deduplicates the same public contract ingested twice', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    await makeAward({ amount: '100000.00', contractNumber: 'DUPLICATE-1' })
    await makeAward({ amount: '999999.00', contractNumber: 'DUPLICATE-1' })

    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(MIN_BENCHMARK_COHORT_SIZE + 1)
    expect(r.exclusionReasons.some((e) => e.reason.includes('duplicate of contract'))).toBe(true)
  })

  it('excludes a vehicle ceiling from the cohort and records why', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    await makeAward({ amount: '150000.00', awardType: 'IDIQ' })

    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(MIN_BENCHMARK_COHORT_SIZE)
    expect(r.exclusionReasons.some((e) => e.reason.includes('multi-award vehicle ceiling'))).toBe(true)
    expect(r.excludedSourceIds.length).toBeGreaterThan(0)
  })
})

describe('the fallback ladder is explicit', () => {
  it('declares its rungs in a fixed order', () => {
    expect(FILTER_LADDER.map((r) => r.level)).toEqual([
      'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND',
      'LEVEL_2_NAICS_AGENCY_BAND',
      'LEVEL_3_NAICS_BAND',
      'LEVEL_4_NAICS',
    ])
  })

  it('uses the strictest rung when it already has enough awards', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    const r = await buildAwardBenchmark(request())
    expect(r.filterLevel).toBe('LEVEL_1_NAICS_AGENCY_SETASIDE_BAND')
    expect(r.relaxedFilters).toEqual([])
  })

  it('relaxes the set-aside and says so', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) {
      await makeAward({ amount: '100000.00', setAside: 'WOSB' })
    }
    const r = await buildAwardBenchmark(request({ setAside: 'SDVOSB' }))
    expect(r.filterLevel).toBe('LEVEL_2_NAICS_AGENCY_BAND')
    expect(r.relaxedFilters).toContain('set-aside')
    expect(r.limitations.join(' ')).toContain('relaxed in order')
  })

  it('relaxes the agency and says so', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) {
      await makeAward({ amount: '100000.00', agency: 'S7-PRICE-QA Other Agency', setAside: 'WOSB' })
    }
    const r = await buildAwardBenchmark(request())
    expect(r.filterLevel).toBe('LEVEL_3_NAICS_BAND')
    expect(r.relaxedFilters).toEqual(['set-aside', 'agency'])
  })

  it('never hides a relaxation', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) {
      await makeAward({ amount: '100000.00', agency: 'S7-PRICE-QA Other Agency', setAside: 'WOSB' })
    }
    const r = await buildAwardBenchmark(request())
    expect(r.relaxedFilters.length).toBeGreaterThan(0)
    expect(r.limitations.some((l) => l.includes('relaxed in order'))).toBe(true)
  })
})

// -------------------------------------------------------------
// Reproducibility
// -------------------------------------------------------------

describe('a cohort is reproducible', () => {
  it('produces the same hash for the same inputs', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    const a = await buildAwardBenchmark(request())
    const b = await buildAwardBenchmark(request())
    expect(b.inputHash).toBe(a.inputHash)
    expect(b.inputHash).not.toBe('')
  })

  it('produces a different hash once a new public award appears', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    const before = await buildAwardBenchmark(request())
    await makeAward({ amount: '110000.00' })
    const after = await buildAwardBenchmark(request())
    expect(after.inputHash).not.toBe(before.inputHash)
  })

  it('is insensitive to award ordering', () => {
    const args = {
      naics: '541512', agency: 'DoD', setAside: 'SDVOSB',
      valueBandLow: D('1'), valueBandHigh: D('2'),
      periodStart: NOW, periodEnd: NOW,
      filterLevel: 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND' as const,
    }
    expect(buildCohortHash({ ...args, sourceIds: ['b', 'a'] }))
      .toBe(buildCohortHash({ ...args, sourceIds: ['a', 'b'] }))
  })

  it('reuses the cached row for an identical hash', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    const result = await buildAwardBenchmark(request())

    const first = await persistBenchmarkCohort({
      consultingFirmId: firm.id, result, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null,
    })
    const second = await persistBenchmarkCohort({
      consultingFirmId: firm.id, result, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null,
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.cohort.id).toBe(first.cohort.id)
    expect(await prisma.awardBenchmarkCohort.count({ where: { consultingFirmId: firm.id } })).toBe(1)
  })

  it('preserves the source list and the exclusion reasons as evidence', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    await makeAward({ amount: '150000.00', awardType: 'IDIQ' })
    const result = await buildAwardBenchmark(request())
    const { cohort } = await persistBenchmarkCohort({
      consultingFirmId: firm.id, result, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null,
    })

    expect(cohort.sourceIds).toHaveLength(MIN_BENCHMARK_COHORT_SIZE)
    expect(cohort.excludedSourceIds.length).toBeGreaterThan(0)
    expect(JSON.stringify(cohort.exclusionReasons)).toContain('vehicle ceiling')
    expect(cohort.algorithmVersion).toBe('award-benchmark-v1')
  })

  it('records every award in the composition so a reader can check it', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    const result = await buildAwardBenchmark(request())
    const { cohort } = await persistBenchmarkCohort({
      consultingFirmId: firm.id, result, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null,
    })
    const composition = cohort.distributionData as Array<Record<string, unknown>>
    expect(composition).toHaveLength(MIN_BENCHMARK_COHORT_SIZE)
    for (const row of composition) {
      expect(row.awardId).toBeTruthy()
      expect(row.agency).toBeTruthy()
      expect(row.awardDate).toBeTruthy()
      expect(row.awardAmount).toBe('100000.00')
    }
  })

  it('versions a materially different cohort rather than mutating the old one', async () => {
    for (let i = 0; i < MIN_BENCHMARK_COHORT_SIZE; i += 1) await makeAward({ amount: '100000.00' })
    const first = await buildAwardBenchmark(request())
    const persistedFirst = await persistBenchmarkCohort({
      consultingFirmId: firm.id, result: first, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null,
    })

    await makeAward({ amount: '120000.00' })
    const second = await buildAwardBenchmark(request())
    const persistedSecond = await persistBenchmarkCohort({
      consultingFirmId: firm.id, result: second, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null,
    })

    expect(persistedSecond.cohort.id).not.toBe(persistedFirst.cohort.id)
    expect(persistedSecond.cohort.cohortVersion).toBe(2)

    // The original evidence is untouched.
    const original = await prisma.awardBenchmarkCohort.findUniqueOrThrow({ where: { id: persistedFirst.cohort.id } })
    expect(original.cohortSize).toBe(MIN_BENCHMARK_COHORT_SIZE)
    expect(original.sourceIds).toEqual(persistedFirst.cohort.sourceIds)
  })
})

describe('Decimal discipline', () => {
  it('preserves cents through the whole cohort pipeline', async () => {
    const amounts = ['100000.01', '100000.02', '100000.03', '100000.04', '100000.05', '100000.06', '100000.07']
    for (const amount of amounts) await makeAward({ amount })

    const r = await buildAwardBenchmark(request())
    expect(r.cohortSize).toBe(7)
    expect(r.distribution.minimum!.toFixed(2)).toBe('100000.01')
    expect(r.distribution.median!.toFixed(2)).toBe('100000.04')
    expect(r.distribution.maximum!.toFixed(2)).toBe('100000.07')
  })

  it('handles very large award values without drift', async () => {
    const amounts = [
      '10000000000.01', '10000000000.02', '10000000000.03', '10000000000.04',
      '10000000000.05', '10000000000.06', '10000000000.07',
    ]
    for (const amount of amounts) await makeAward({ amount })

    const r = await buildAwardBenchmark(request({ referencePrice: D('10000000000.00') }))
    expect(r.distribution.median!.toFixed(2)).toBe('10000000000.04')
  })

  it('stores Decimal statistics exactly', async () => {
    for (const amount of ['100000.01', '100000.02', '100000.03', '100000.04', '100000.05', '100000.06', '100000.07']) {
      await makeAward({ amount })
    }
    const result = await buildAwardBenchmark(request())
    const { cohort } = await persistBenchmarkCohort({
      consultingFirmId: firm.id, result, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null,
    })
    expect(cohort.medianValue!.toFixed(2)).toBe('100000.04')
    expect(cohort.minimumValue!.toFixed(2)).toBe('100000.01')
  })
})
