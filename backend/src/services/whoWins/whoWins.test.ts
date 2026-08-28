// =============================================================
// Who-Wins v1 — unit + integration tests.
//
// Covers the math that must not silently regress (shrinkage identity,
// E[1/K] vs 1/E[K], logit blending, leakage-safe time filtering,
// coefficient recovery on synthetic data) and the DB round trip
// (ingest-shaped rows → priors → ladder lookup → train → eval →
// runtime prior).
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../../config/database'
import { parseCsv } from './csv'
import { bucketFromFpdsCode, bucketFromOpportunitySetAside } from './setAside'
import { shrink, buildPriors, lookupPrior } from './priorBuilder'
import { fitConditionalLogit, mulberry32, standardize, utility } from './conditionalLogit'
import { countBefore, buildHistories, candidateFeatures, trainAndEvaluate, activateModel, DEFAULT_TRAINING_CONFIG } from './whoWinsTrainer'
import { getPublicWinPrior, blendWithPrior, resetWhoWinsCaches } from './publicWinPrior'

const VERSION = `test-${Date.now()}`

afterAll(async () => {
  await prisma.publicAwardTraining.deleteMany({ where: { ingestBatchId: { startsWith: 'whowins-test' } } })
  await prisma.publicWinPrior.deleteMany({ where: { modelVersion: VERSION } })
  await prisma.whoWinsModel.deleteMany({ where: { version: VERSION } })
  await prisma.$disconnect()
})

describe('csv parser', () => {
  it('handles quoted fields with commas, escaped quotes, and embedded newlines', () => {
    const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\nplain,2,3\n')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ a: 'x, y', b: 'say "hi"', c: 'line1\nline2' })
    expect(rows[1]).toEqual({ a: 'plain', b: '2', c: '3' })
  })

  it('parses a trailing row without a final newline', () => {
    const rows = parseCsv('h1,h2\nv1,v2')
    expect(rows).toEqual([{ h1: 'v1', h2: 'v2' }])
  })
})

describe('set-aside bucketing', () => {
  it('maps FPDS codes and app-canonical values into the same buckets', () => {
    expect(bucketFromFpdsCode('SDVOSBC')).toBe('SDVOSB')
    expect(bucketFromFpdsCode('HZC')).toBe('HUBZONE')
    expect(bucketFromFpdsCode('8A')).toBe('SBA_8A')
    expect(bucketFromFpdsCode('SBA')).toBe('SMALL_BUSINESS')
    expect(bucketFromFpdsCode('NONE')).toBe('NONE')
    expect(bucketFromFpdsCode('ISBEE')).toBe('OTHER')
    expect(bucketFromOpportunitySetAside('SDVOSB')).toBe('SDVOSB')
    expect(bucketFromOpportunitySetAside('TOTAL_SMALL_BUSINESS')).toBe('SMALL_BUSINESS')
    expect(bucketFromOpportunitySetAside(null)).toBe('NONE')
  })
})

describe('shrinkage + base-rate math', () => {
  it('pseudo-count shrinkage interpolates observation and parent by sample size', () => {
    expect(shrink(0.5, 0, 0.2, 25)).toBe(0.2)               // no data → parent
    expect(shrink(0.5, 25, 0.2, 25)).toBeCloseTo(0.35, 10)  // n = m → midpoint
    expect(shrink(0.5, 100000, 0.2, 25)).toBeCloseTo(0.5, 3) // n ≫ m → observation
  })

  it('E[1/K] differs from 1/E[K] when K varies (Jensen) — we use E[1/K]', () => {
    const K = [1, 9] // mean K = 5
    const meanInv = K.reduce((s, k) => s + 1 / k, 0) / K.length // (1 + 1/9)/2 ≈ 0.5556
    const invMean = 1 / (K.reduce((s, k) => s + k, 0) / K.length) // 0.2
    expect(meanInv).toBeGreaterThan(invMean)
    expect(meanInv).toBeCloseTo(0.5556, 3)
  })

  it('blends in log-odds space with clamping', () => {
    expect(blendWithPrior(0.5, 0.2, 1)).toBeCloseTo(0.2, 6)   // w=1 → prior
    expect(blendWithPrior(0.5, 0.2, 0)).toBeCloseTo(0.5, 6)   // w=0 → heuristic
    const mid = blendWithPrior(0.5, 0.2, 0.75)
    expect(mid).toBeGreaterThan(0.2)
    expect(mid).toBeLessThan(0.5)
    // Extreme heuristic values are clamped before logit — no ±Infinity.
    expect(Number.isFinite(blendWithPrior(1, 0.2, 0.5))).toBe(true)
    expect(Number.isFinite(blendWithPrior(0, 0.2, 0.5))).toBe(true)
  })
})

describe('time-filtered features (leakage guard)', () => {
  it('countBefore is strict — same-timestamp awards do not count as history', () => {
    expect(countBefore([10, 20, 30], 20)).toBe(1)
    expect(countBefore([10, 20, 30], 31)).toBe(3)
    expect(countBefore([], 5)).toBe(0)
  })

  it('candidateFeatures sees only history strictly before the award', () => {
    const mk = (d: string, amt: number) => ({
      naicsCode: '541512', agencyCode: '097', setAsideCode: 'NONE', offersReceived: 3,
      recipientUei: 'AAAAAAAAAAA1', recipientParentUei: null,
      obligatedAmount: amt, actionDate: new Date(d), fiscalYear: 2024,
    })
    const histories = buildHistories([mk('2024-01-01', 100000), mk('2024-06-01', 200000)])
    const award = { naics4: '5415', agencyCode: '097', bucket: 'NONE', amount: 150000, time: new Date('2024-03-01').getTime() }
    const feats = candidateFeatures(histories, 'AAAAAAAAAAA1', award)
    expect(feats[0]).toBeCloseTo(Math.log1p(1), 6) // only the January award
    const unknown = candidateFeatures(histories, 'ZZZZZZZZZZZ9', award)
    expect(unknown).toEqual([0, 0, 0, -3, 0])
  })
})

describe('conditional logit', () => {
  it('recovers coefficient signs from synthetic choice data', () => {
    // Winner utility driven by feature 0 (positive) and feature 1 (negative).
    const rand = mulberry32(42)
    const trueBeta = [1.5, -1.0, 0]
    const groups: number[][][] = []
    for (let g = 0; g < 2000; g++) {
      const cands = Array.from({ length: 5 }, () => [rand() * 2, rand() * 2, rand() * 2])
      const utils = cands.map((x) => x.reduce((s, v, k) => s + v * trueBeta[k], 0))
      // Sample the winner from the softmax, then rotate it to index 0.
      const m = Math.max(...utils)
      const ps = utils.map((u) => Math.exp(u - m))
      const total = ps.reduce((a, b) => a + b, 0)
      let r = rand() * total, winner = 0
      for (let j = 0; j < ps.length; j++) { r -= ps[j]; if (r <= 0) { winner = j; break } }
      groups.push([cands[winner], ...cands.filter((_, j) => j !== winner)])
    }
    standardize(groups)
    const fit = fitConditionalLogit(groups, { epochs: 300 })
    expect(fit.beta[0]).toBeGreaterThan(0.5)
    expect(fit.beta[1]).toBeLessThan(-0.3)
    expect(Math.abs(fit.beta[2])).toBeLessThan(0.2)
  })

  it('utility standardizes raw features with stored moments', () => {
    expect(utility([10], [2], [10], [5])).toBe(0)
    expect(utility([15], [2], [10], [5])).toBe(2)
  })

  it('nonNegative projection clamps negative coefficients to zero', () => {
    // Same generator as the recovery test — feature 1 truly hurts winners.
    const rand = mulberry32(43)
    const trueBeta = [1.5, -1.0]
    const groups: number[][][] = []
    for (let g = 0; g < 800; g++) {
      const cands = Array.from({ length: 5 }, () => [rand() * 2, rand() * 2])
      const utils = cands.map((x) => x.reduce((s, v, k) => s + v * trueBeta[k], 0))
      const m = Math.max(...utils)
      const ps = utils.map((u) => Math.exp(u - m))
      const total = ps.reduce((a, b) => a + b, 0)
      let r = rand() * total, winner = 0
      for (let j = 0; j < ps.length; j++) { r -= ps[j]; if (r <= 0) { winner = j; break } }
      groups.push([cands[winner], ...cands.filter((_, j) => j !== winner)])
    }
    standardize(groups)
    const fit = fitConditionalLogit(groups, { epochs: 300, nonNegative: true })
    expect(fit.beta[0]).toBeGreaterThan(0.5)
    expect(fit.beta[1]).toBe(0) // clamped, never negative
  })
})

// =============================================================
// DB integration: synthetic corpus → priors → train → runtime prior.
// Structure: two NAICS markets; a small set of repeat winners takes
// most awards (incumbency-dominant, like the real market), offers 2-8.
// =============================================================
describe('end-to-end on a synthetic corpus', () => {
  beforeAll(async () => {
    const rand = mulberry32(7)
    const rows: object[] = []
    const naicsBySeg: Record<string, string> = { A: '541512', B: '236220' }
    const ueis = (seg: string) => Array.from({ length: 20 }, (_, i) => `${seg === 'A' ? 'AA' : 'BB'}${String(i).padStart(10, '0')}`)
    for (const seg of ['A', 'B'] as const) {
      const pool = ueis(seg)
      const incumbents = pool.slice(0, 4)
      for (let i = 0; i < 400; i++) {
        // 75% of awards go to one of 4 repeat winners.
        const uei = rand() < 0.75 ? incumbents[Math.floor(rand() * incumbents.length)] : pool[4 + Math.floor(rand() * 16)]
        const fy = 2022 + Math.floor(rand() * 5) // 2022..2026
        const month = 1 + Math.floor(rand() * 9)
        rows.push({
          awardKey: `whowins-test:${seg}:${i}`,
          piid: `TEST${seg}${i}`,
          naicsCode: naicsBySeg[seg],
          agencyCode: '097',
          agencyName: 'Department of Test',
          setAsideCode: rand() < 0.3 ? 'SDVOSBC' : 'NONE',
          extentCompetedCode: 'A',
          offersReceived: 2 + Math.floor(rand() * 7),
          recipientUei: uei,
          recipientParentUei: null,
          recipientName: `Vendor ${uei.slice(-2)}`,
          recipientStateCode: 'TX',
          obligatedAmount: 50_000 + Math.floor(rand() * 950_000),
          actionDate: new Date(Date.UTC(fy, month, 1 + Math.floor(rand() * 27))),
          fiscalYear: fy,
          ingestBatchId: 'whowins-test-batch',
        })
      }
    }
    await prisma.publicAwardTraining.deleteMany({ where: { ingestBatchId: { startsWith: 'whowins-test' } } })
    await prisma.publicAwardTraining.createMany({ data: rows as any, skipDuplicates: true })
  })

  it('builds priors and walks the lookup ladder', async () => {
    const built = await buildPriors(VERSION)
    expect(built.segments).toBeGreaterThan(4)

    const exact = await lookupPrior(VERSION, '541512', 'NONE')
    expect(exact).not.toBeNull()
    expect(exact!.shrunkMeanInvOffers).toBeGreaterThan(0.1) // K∈[2,8] ⇒ E[1/K]∈[0.125,0.5]
    expect(exact!.shrunkMeanInvOffers).toBeLessThan(0.55)

    // Unknown NAICS-6 falls back up the ladder instead of returning null.
    const fallback = await lookupPrior(VERSION, '541999', 'NONE')
    expect(fallback).not.toBeNull()
    expect(['NAICS4', 'NAICS2', 'GLOBAL']).toContain(fallback!.segmentLevel)
  })

  it('trains, beats the random baseline out-of-time, and serves a runtime prior', async () => {
    const { eval: report } = await trainAndEvaluate(VERSION, {
      ...DEFAULT_TRAINING_CONFIG,
      minSegmentWinners: 5,
      seed: 99,
    })
    expect(report.testGroups).toBeGreaterThan(50)
    // Incumbency-dominant synthetic market: the model must beat random.
    expect(report.topOneAccuracy).toBeGreaterThan(report.baselines.randomTopOne)
    expect(report.pairwiseAuc).toBeGreaterThan(0.55)

    await activateModel(VERSION)
    resetWhoWinsCaches()

    // A client with real public history in the segment.
    const strong = await getPublicWinPrior({
      opportunityNaics: '541512',
      opportunitySetAside: 'NONE',
      opportunityAgencyName: 'Department of Test',
      opportunityEstimatedValue: 300_000,
      clientUei: 'AA0000000000',
    })
    expect(strong).not.toBeNull()
    expect(strong!.pWin).toBeGreaterThan(0.01)
    expect(strong!.pWin).toBeLessThan(0.95)
    expect(strong!.adjustmentOdds).toBeGreaterThanOrEqual(1 / 3)
    expect(strong!.adjustmentOdds).toBeLessThanOrEqual(3)

    // A client with no public history gets a bounded below-typical prior.
    const unproven = await getPublicWinPrior({
      opportunityNaics: '541512',
      opportunitySetAside: 'NONE',
      opportunityAgencyName: null,
      opportunityEstimatedValue: 300_000,
      clientUei: null,
    })
    expect(unproven).not.toBeNull()
    expect(unproven!.adjustmentOdds).toBeLessThanOrEqual(strong!.adjustmentOdds)
  })
})
