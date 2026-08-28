// =============================================================
// SCW-2 subaward analysis — service tests
//
// Coverage:
//   - identifier handling: UEI vs name path branches both call the right SQL
//   - happy aggregation: total$, avg sub size, sample size populated
//   - empty path: zero subaward rows produces explicit warnings, null
//     dollar fields, sampleSize=0
//   - "no silent failures" warning ALWAYS includes the R4 explanation
//   - cache hit: a fresh row is returned without re-running the aggregation
//   - cache expiry: stale row triggers a recompute
// =============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../config/database', () => ({
  prisma: {
    scwSubawardAnalysis: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    $queryRaw: vi.fn(),
  },
}))

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { analyzeSubawards } from './subawardAnalysis'
import { prisma } from '../../config/database'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('identifier handling', () => {
  it('accepts a UEI and queries by recipientUei', async () => {
    ;(prisma.scwSubawardAnalysis.findUnique as any).mockResolvedValue(null)
    ;(prisma.$queryRaw as any).mockResolvedValue([
      { total_sub_dollars: '1500000', total_award_dollars: '10000000', sample_size: BigInt(5), distinct_subs: BigInt(3) },
    ])
    ;(prisma.scwSubawardAnalysis.upsert as any).mockResolvedValue({})

    const r = await analyzeSubawards({ primeUei: 'ABC123DEF456' })

    expect(r.primeUei).toBe('ABC123DEF456')
    expect(r.primeName).toBeNull()
    expect(prisma.$queryRaw).toHaveBeenCalled()
  })

  it('accepts a name and queries by recipientName', async () => {
    ;(prisma.scwSubawardAnalysis.findUnique as any).mockResolvedValue(null)
    ;(prisma.$queryRaw as any).mockResolvedValue([
      { total_sub_dollars: null, total_award_dollars: null, sample_size: BigInt(0), distinct_subs: BigInt(0) },
    ])
    ;(prisma.scwSubawardAnalysis.upsert as any).mockResolvedValue({})

    const r = await analyzeSubawards({ primeName: 'HENSEL PHELPS CONSTRUCTION CO.' })

    expect(r.primeName).toBe('HENSEL PHELPS CONSTRUCTION CO.')
    expect(r.primeUei).toBeNull()
  })

  it('throws when neither identifier is supplied', async () => {
    await expect(analyzeSubawards({})).rejects.toThrow(/requires either primeUei or primeName/)
  })
})

describe('happy aggregation', () => {
  it('computes total $, avg sub size, sample size', async () => {
    ;(prisma.scwSubawardAnalysis.findUnique as any).mockResolvedValue(null)
    ;(prisma.$queryRaw as any).mockResolvedValue([
      { total_sub_dollars: '900000', total_award_dollars: '5000000', sample_size: BigInt(4), distinct_subs: BigInt(3) },
    ])
    ;(prisma.scwSubawardAnalysis.upsert as any).mockResolvedValue({})

    const r = await analyzeSubawards({ primeName: 'TEST PRIME' })

    expect(r.totalSubawardDollars).toBe(900_000)
    expect(r.averageSubSize).toBe(225_000) // 900k / 4
    expect(r.dataQuality.sampleSize).toBe(4)
  })
})

describe('empty path — no silent failures', () => {
  it('zero subaward rows produces null totals and explicit warnings', async () => {
    ;(prisma.scwSubawardAnalysis.findUnique as any).mockResolvedValue(null)
    ;(prisma.$queryRaw as any).mockResolvedValue([
      { total_sub_dollars: null, total_award_dollars: null, sample_size: BigInt(0), distinct_subs: BigInt(0) },
    ])
    ;(prisma.scwSubawardAnalysis.upsert as any).mockResolvedValue({})

    const r = await analyzeSubawards({ primeName: 'COLD START PRIME' })

    expect(r.totalSubawardDollars).toBeNull()
    expect(r.averageSubSize).toBeNull()
    expect(r.dataQuality.sampleSize).toBe(0)
    expect(r.dataQuality.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('No subaward history available'),
      ]),
    )
  })

  it('R4 limitation warning always present, regardless of sample size', async () => {
    ;(prisma.scwSubawardAnalysis.findUnique as any).mockResolvedValue(null)
    ;(prisma.$queryRaw as any).mockResolvedValue([
      { total_sub_dollars: '1', total_award_dollars: '1', sample_size: BigInt(1), distinct_subs: BigInt(1) },
    ])
    ;(prisma.scwSubawardAnalysis.upsert as any).mockResolvedValue({})

    const r = await analyzeSubawards({ primeName: 'FOO' })

    const warnings = r.dataQuality.warnings.join(' | ')
    expect(warnings).toMatch(/SDVOSB.*small-business.*NAICS/)
    expect(warnings).toMatch(/R4/)
  })

  it('null fields are surfaced as null, never silently zero', async () => {
    ;(prisma.scwSubawardAnalysis.findUnique as any).mockResolvedValue(null)
    ;(prisma.$queryRaw as any).mockResolvedValue([
      { total_sub_dollars: '1000000', total_award_dollars: '5000000', sample_size: BigInt(10), distinct_subs: BigInt(5) },
    ])
    ;(prisma.scwSubawardAnalysis.upsert as any).mockResolvedValue({})

    const r = await analyzeSubawards({ primeName: 'PRIME' })

    expect(r.smallBusinessSubAwardPercent).toBeNull()
    expect(r.sdvosbSubAwardPercent).toBeNull()
    expect(r.topNaicsSubbed).toBeNull()
    expect(r.sdvosbGoalGap.actualPercent).toBeNull()
    expect(r.sdvosbGoalGap.source).toBe('unknown')
    expect(r.sdvosbGoalGap.underPressure).toBe(false)
  })
})

describe('caching', () => {
  it('returns a fresh cache row without recomputing', async () => {
    const cachedAt = new Date()
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000) // +1d
    ;(prisma.scwSubawardAnalysis.findUnique as any).mockResolvedValue({
      id: 'cache-1',
      primeKey: 'name:HENSEL PHELPS CONSTRUCTION CO.',
      primeUei: null,
      primeName: 'HENSEL PHELPS CONSTRUCTION CO.',
      lookbackYears: 3,
      totalSubawardDollars: '750000',
      averageSubSize: '187500',
      sampleSize: 4,
      smallBusinessPercent: null,
      sdvosbPercent: null,
      topNaicsSubbed: null,
      sdvosbGoalGap: {
        fiscalYear: 'FY26', goalPercent: null, actualPercent: null,
        gapPercent: null, underPressure: false, source: 'unknown',
      },
      dataQuality: { sampleSize: 4, warnings: ['cached warning'] },
      computedAt: cachedAt,
      expiresAt,
    })

    const r = await analyzeSubawards({ primeName: 'HENSEL PHELPS CONSTRUCTION CO.' })

    expect(r.fromCache).toBe(true)
    expect(r.totalSubawardDollars).toBe(750_000)
    expect(r.averageSubSize).toBe(187_500)
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
    expect(prisma.scwSubawardAnalysis.upsert).not.toHaveBeenCalled()
  })

  it('stale cache row triggers recompute', async () => {
    const expiresAt = new Date(Date.now() - 60 * 60 * 1000) // expired 1h ago
    ;(prisma.scwSubawardAnalysis.findUnique as any).mockResolvedValue({
      id: 'cache-stale',
      primeKey: 'name:PRIME',
      primeUei: null,
      primeName: 'PRIME',
      lookbackYears: 3,
      totalSubawardDollars: '1',
      averageSubSize: '1',
      sampleSize: 1,
      smallBusinessPercent: null,
      sdvosbPercent: null,
      topNaicsSubbed: null,
      sdvosbGoalGap: null,
      dataQuality: { sampleSize: 1, warnings: [] },
      computedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      expiresAt,
    })
    ;(prisma.$queryRaw as any).mockResolvedValue([
      { total_sub_dollars: '999', total_award_dollars: '999', sample_size: BigInt(2), distinct_subs: BigInt(1) },
    ])
    ;(prisma.scwSubawardAnalysis.upsert as any).mockResolvedValue({})

    const r = await analyzeSubawards({ primeName: 'PRIME' })

    expect(r.fromCache).toBe(false)
    expect(r.totalSubawardDollars).toBe(999)
    expect(prisma.$queryRaw).toHaveBeenCalled()
    expect(prisma.scwSubawardAnalysis.upsert).toHaveBeenCalled()
  })
})
