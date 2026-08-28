// =============================================================
// revenueForecaster tests — concentration helpers + lognormal noise
//
// The full forecastRevenue() path needs prisma + a populated opportunity
// pipeline to exercise meaningfully; that lives in integration tests.
// These unit tests freeze the math helpers (HHI, topNShare) and verify
// the lognormal noise is unbiased (E[noise]≈1.0), which was the subject
// of an audit-finding correction.
// =============================================================

import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/database', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    opportunity: { findMany: vi.fn() },
  },
}))
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { forecastRevenue, __revenueForecasterInternals } from './revenueForecaster'
import { prisma } from '../config/database'

const { computeHHI, topNShare, gaussianRandom, mulberry32, hashSeed } = __revenueForecasterInternals

describe('revenueForecaster / computeHHI', () => {
  it('returns 0 for empty input', () => {
    expect(computeHHI([])).toBe(0)
  })

  it('returns 0 when total is 0', () => {
    expect(computeHHI([0, 0, 0])).toBe(0)
  })

  it('returns 1.0 for fully concentrated (single category)', () => {
    expect(computeHHI([100])).toBe(1)
  })

  it('returns ~0.5 for two equal categories', () => {
    // HHI = (0.5)² + (0.5)² = 0.5
    expect(computeHHI([5, 5])).toBeCloseTo(0.5, 5)
  })

  it('returns ~0.1 for ten equal categories (well diversified)', () => {
    // HHI = 10 × (0.1)² = 0.1
    expect(computeHHI(Array(10).fill(1))).toBeCloseTo(0.1, 5)
  })

  it('penalizes concentration: [80, 5, 5, 5, 5] is more concentrated than equal', () => {
    const concentrated = computeHHI([80, 5, 5, 5, 5])
    const equal = computeHHI([20, 20, 20, 20, 20])
    expect(concentrated).toBeGreaterThan(equal)
    expect(concentrated).toBeCloseTo(0.65, 1)  // 0.64 + 4×0.0025 ≈ 0.65
  })
})

describe('revenueForecaster / topNShare', () => {
  it('returns 0 for empty input', () => {
    expect(topNShare([])).toBe(0)
  })

  it('catches "2 huge + 20 tiny" concentration that HHI misses', () => {
    // Two huge clients (40 each), 20 small (1 each) → top-3 = 81/100 = 0.81
    const counts = [40, 40, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
    const top3 = topNShare(counts, 3)
    expect(top3).toBeCloseTo(0.81, 2)
    // Meanwhile, HHI for the same data is only 0.34 — top3 catches what HHI misses.
    expect(computeHHI(counts)).toBeLessThan(0.4)
  })

  it('returns 1.0 when all categories fit in topN', () => {
    expect(topNShare([10, 10], 3)).toBe(1)
    expect(topNShare([100], 3)).toBe(1)
  })

  it('default n=3 if not specified', () => {
    expect(topNShare([10, 10, 10, 10])).toBeCloseTo(0.75, 5)  // 30/40
  })

  it('handles all-equal correctly', () => {
    // 5 equal categories of 10 → top-3 share = 30/50 = 0.6
    expect(topNShare([10, 10, 10, 10, 10], 3)).toBeCloseTo(0.6, 5)
  })
})

describe('revenueForecaster / gaussianRandom + lognormal noise', () => {
  it('gaussianRandom output is approximately mean=0, var=1 over many samples', () => {
    const N = 5000
    let sum = 0
    let sumSq = 0
    for (let i = 0; i < N; i++) {
      const z = gaussianRandom()
      sum += z
      sumSq += z * z
    }
    const mean = sum / N
    const variance = sumSq / N - mean * mean
    // Loose bounds because N=5000 is not huge.
    expect(Math.abs(mean)).toBeLessThan(0.1)
    expect(variance).toBeGreaterThan(0.85)
    expect(variance).toBeLessThan(1.15)
  })

  it('lognormal noise exp(MU + SIGMA*Z) with MU=-σ²/2 is unbiased E[noise]≈1.0', () => {
    // This is the audit-correction proof: the formula in revenueForecaster.ts
    // is theoretically unbiased. We verify empirically with N samples.
    const N = 20_000
    const SIGMA = 0.2
    const MU = -(SIGMA * SIGMA) / 2

    let sum = 0
    for (let i = 0; i < N; i++) {
      sum += Math.exp(MU + SIGMA * gaussianRandom())
    }
    const mean = sum / N
    // With N=20k samples the empirical mean should be within ~1% of 1.0.
    expect(mean).toBeGreaterThan(0.985)
    expect(mean).toBeLessThan(1.015)
  })

  it('lognormal noise median is exp(MU) ≈ 0.98 (auditor confused this with mean)', () => {
    // This test documents what the auditor saw — the MEDIAN of the noise
    // distribution IS below 1.0 (exp(-0.02) ≈ 0.9802), which they mistook
    // for the mean. The mean is exactly 1.0 (test above).
    const N = 20_000
    const SIGMA = 0.2
    const MU = -(SIGMA * SIGMA) / 2

    const samples: number[] = []
    for (let i = 0; i < N; i++) {
      samples.push(Math.exp(MU + SIGMA * gaussianRandom()))
    }
    samples.sort((a, b) => a - b)
    const median = samples[Math.floor(N / 2)]
    expect(median).toBeGreaterThan(0.96)
    expect(median).toBeLessThan(1.0)
  })
})

describe('revenueForecaster / mulberry32 seeded PRNG', () => {
  it('is deterministic — same seed yields the same sequence', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b())
    }
  })

  it('different seeds diverge', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    expect(a()).not.toBe(b())
  })

  it('outputs stay in [0, 1)', () => {
    const rng = mulberry32(999)
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('hashSeed is stable and pipeline-sensitive', () => {
    expect(hashSeed('a:0.300000:100')).toBe(hashSeed('a:0.300000:100'))
    expect(hashSeed('a:0.300000:100')).not.toBe(hashSeed('a:0.300000:101'))
  })
})

describe('revenueForecaster / forecastRevenue reload-stability (drift bug)', () => {
  const mockOpps = (overrides: Array<Record<string, unknown>>) => {
    const now = new Date()
    const soon = new Date(now)
    soon.setDate(soon.getDate() + 10) // within monthsAhead window
    return overrides.map((o, i) => ({
      id: `opp-${i}`,
      estimatedValue: 1_000_000,
      probabilityScore: 0.3,
      responseDeadline: soon,
      recompeteFlag: false,
      incumbentProbability: null,
      bidDecisions: [],
      ...o,
    }))
  }

  it('returns IDENTICAL forecasts across repeated calls (the reported bug)', async () => {
    ;(prisma.opportunity.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOpps([
        { id: 'a', estimatedValue: 1_200_000, probabilityScore: 0.3 },
        { id: 'b', estimatedValue: 3_500_000, probabilityScore: 0.15 }, // the whale
        { id: 'c', estimatedValue: 400_000, probabilityScore: 0.4 },
      ])
    )

    const f1 = await forecastRevenue('firm-1')
    const f2 = await forecastRevenue('firm-1')
    const f3 = await forecastRevenue('firm-1')

    // Full deep equality — expected AND p10/p50/p90 must match every reload.
    expect(f1).toEqual(f2)
    expect(f2).toEqual(f3)
  })

  it('expected revenue equals the exact analytic Σ(prob × value)', async () => {
    // Single opp so we can compute the closed form. The service applies:
    //   value  = estimatedValue × OPTION_YEAR_FACTOR(2.5) × TIME_TO_AWARD_DISCOUNT
    //   prob   = 0.3 (above the 0.05 floor, no recompete boost)
    const OPTION_YEAR_FACTOR = 2.5
    const TIME_TO_AWARD_DISCOUNT = 1 / Math.pow(1.08, 9 / 12)
    ;(prisma.opportunity.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOpps([{ id: 'solo', estimatedValue: 1_200_000, probabilityScore: 0.3 }])
    )

    const forecast = await forecastRevenue('firm-1')
    const activeMonth = forecast.find((m) => m.expected > 0)
    const analytic = Math.round(0.3 * 1_200_000 * OPTION_YEAR_FACTOR * TIME_TO_AWARD_DISCOUNT)

    expect(activeMonth?.expected).toBe(analytic)
  })

  // Section-4 finding #1 acceptance criteria: the headline figure must be
  // deterministic for zero / one / many / missing-value / large-value inputs.
  // The one/many cases are covered above; these lock the remaining ones.

  it('zero opportunities → all-zero, stable forecast (no throw, headline = 0)', async () => {
    ;(prisma.opportunity.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const f1 = await forecastRevenue('firm-empty')
    const f2 = await forecastRevenue('firm-empty')

    expect(f1).toEqual(f2)
    expect(f1.every((m) => m.expected === 0 && m.opportunityCount === 0)).toBe(true)
    // The headline (Σ expected) a caller would show is exactly 0.
    expect(f1.reduce((s, m) => s + m.expected, 0)).toBe(0)
  })

  it('missing values (null estimatedValue / null probabilityScore) handled deterministically', async () => {
    // null estimatedValue → contributes 0 (skipped); null probabilityScore →
    // floored to 0.05. Same input must yield the same numbers every call.
    ;(prisma.opportunity.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOpps([
        { id: 'no-value', estimatedValue: null, probabilityScore: 0.4 },
        { id: 'no-prob', estimatedValue: 900_000, probabilityScore: null },
      ])
    )

    const f1 = await forecastRevenue('firm-missing')
    const f2 = await forecastRevenue('firm-missing')
    expect(f1).toEqual(f2)

    // Only the valued opp contributes; probability floored at 0.05.
    const OPTION_YEAR_FACTOR = 2.5
    const TIME_TO_AWARD_DISCOUNT = 1 / Math.pow(1.08, 9 / 12)
    const analytic = Math.round(0.05 * 900_000 * OPTION_YEAR_FACTOR * TIME_TO_AWARD_DISCOUNT)
    expect(f1.find((m) => m.expected > 0)?.expected).toBe(analytic)
  })

  it('large monetary values stay exact and deterministic (no float drift)', async () => {
    ;(prisma.opportunity.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockOpps([{ id: 'mega', estimatedValue: 2_500_000_000, probabilityScore: 0.5 }])
    )

    const f1 = await forecastRevenue('firm-large')
    const f2 = await forecastRevenue('firm-large')
    expect(f1).toEqual(f2)

    const OPTION_YEAR_FACTOR = 2.5
    const TIME_TO_AWARD_DISCOUNT = 1 / Math.pow(1.08, 9 / 12)
    const analytic = Math.round(0.5 * 2_500_000_000 * OPTION_YEAR_FACTOR * TIME_TO_AWARD_DISCOUNT)
    expect(f1.find((m) => m.expected > 0)?.expected).toBe(analytic)
    expect(Number.isFinite(f1.find((m) => m.expected > 0)!.expected)).toBe(true)
  })
})
