// =============================================================
// Market Score — Unit Tests
//
// Validates the 5-factor weighted composite measuring opportunity
// attractiveness independent of client capability.
// =============================================================
import { describe, it, expect } from 'vitest'
import { computeMarketScore } from './marketScoring'

describe('computeMarketScore — invariants', () => {
  it('returns total + breakdown in [0, 100]', () => {
    const r = computeMarketScore({
      offersReceived: 4,
      incumbentProbability: 0.3,
      estimatedValue: 1_000_000,
      noticeType: 'Solicitation',
    })
    expect(r.total).toBeGreaterThanOrEqual(0)
    expect(r.total).toBeLessThanOrEqual(100)
    Object.values(r.breakdown).forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    })
  })

  it('returns integers', () => {
    const r = computeMarketScore({})
    expect(Number.isInteger(r.total)).toBe(true)
    Object.values(r.breakdown).forEach((v) => expect(Number.isInteger(v)).toBe(true))
  })

  it('returns reasonable defaults when all inputs are null/undefined', () => {
    const r = computeMarketScore({})
    expect(r.total).toBeGreaterThan(0)
    expect(r.total).toBeLessThan(70) // Optimism bias is mild — defaults around 50-55
  })
})

describe('computeMarketScore — competition density (30% weight)', () => {
  it('scores 95 for sole-source / 1 bidder', () => {
    const r = computeMarketScore({ offersReceived: 1 })
    expect(r.breakdown.competitionDensity).toBe(95)
  })

  it('scores 70 for moderately competed (4-5 bidders)', () => {
    const r = computeMarketScore({ offersReceived: 5 })
    expect(r.breakdown.competitionDensity).toBe(70)
  })

  it('scores 15 for very crowded markets (>20 bidders)', () => {
    const r = computeMarketScore({ offersReceived: 25 })
    expect(r.breakdown.competitionDensity).toBe(15)
  })

  it('prefers offersReceived over competitionCount when both present', () => {
    const a = computeMarketScore({ offersReceived: 2, competitionCount: 20 })
    const b = computeMarketScore({ competitionCount: 20 })
    expect(a.breakdown.competitionDensity).toBeGreaterThan(b.breakdown.competitionDensity)
  })

  it('treats competitionCount (historical distinct winners) as market fragmentation, not per-solicitation bidders', () => {
    // A lone historical winner is neutral (entrenchment is handled by the
    // incumbent factor); many distinct winners = a more accessible market.
    const lone = computeMarketScore({ competitionCount: 1 })
    const fragmented = computeMarketScore({ competitionCount: 25 })
    expect(lone.breakdown.competitionDensity).toBe(50)
    expect(fragmented.breakdown.competitionDensity).toBeGreaterThan(lone.breakdown.competitionDensity)
  })

  it('uses historicalAvgAward for value fit when estimatedValue is null', () => {
    const neutral = computeMarketScore({})
    const proxied = computeMarketScore({ historicalAvgAward: 2_000_000 }) // sweet spot
    expect(neutral.breakdown.contractValueFit).toBe(50)
    expect(proxied.breakdown.contractValueFit).toBe(95)
  })
})

describe('computeMarketScore — incumbent strength (25% weight)', () => {
  it('scores 95 when incumbent probability is < 0.15 (fragmented)', () => {
    const r = computeMarketScore({ incumbentProbability: 0.05 })
    expect(r.breakdown.incumbentStrength).toBe(95)
  })

  it('scores 22 when dominant incumbent (>= 0.75)', () => {
    const r = computeMarketScore({ incumbentProbability: 0.85 })
    expect(r.breakdown.incumbentStrength).toBe(22)
  })

  it('boosts by ~12 on recompete signal when incumbent < 0.65', () => {
    const without = computeMarketScore({ incumbentProbability: 0.5 })
    const withRecompete = computeMarketScore({ incumbentProbability: 0.5, recompeteFlag: true })
    expect(withRecompete.breakdown.incumbentStrength - without.breakdown.incumbentStrength).toBeGreaterThanOrEqual(10)
  })

  it('does NOT apply recompete boost when incumbent is dominant (>= 0.65)', () => {
    const without = computeMarketScore({ incumbentProbability: 0.8 })
    const withRecompete = computeMarketScore({ incumbentProbability: 0.8, recompeteFlag: true })
    expect(withRecompete.breakdown.incumbentStrength).toBe(without.breakdown.incumbentStrength)
  })
})

describe('computeMarketScore — contract value fit (20% weight)', () => {
  it('scores 95 in the SDVOSB/small-biz sweet spot ($500K-$5M)', () => {
    const r = computeMarketScore({ estimatedValue: 2_000_000 })
    expect(r.breakdown.contractValueFit).toBe(95)
  })

  it('scores 25 on large primes (>$50M)', () => {
    const r = computeMarketScore({ estimatedValue: 75_000_000 })
    expect(r.breakdown.contractValueFit).toBe(25)
  })

  it('scores 75 on micro-prime range ($150K-$500K)', () => {
    const r = computeMarketScore({ estimatedValue: 300_000 })
    expect(r.breakdown.contractValueFit).toBe(75)
  })

  it('scores 50 (neutral) when estimatedValue is null', () => {
    const r = computeMarketScore({ estimatedValue: null })
    expect(r.breakdown.contractValueFit).toBe(50)
  })
})

describe('computeMarketScore — agency buying patterns (15% weight)', () => {
  it('scores 95 for SDVOSB client with high agency SDVOSB rate (>15%)', () => {
    const r = computeMarketScore({
      agencySdvosbRate: 0.20,
      clientProfile: { sdvosb: true, wosb: false, hubzone: false, smallBusiness: true },
    })
    expect(r.breakdown.agencyBuyingPatterns).toBe(95)
  })

  it('scores ~90 for small biz client with > 35% small-biz spend', () => {
    const r = computeMarketScore({
      agencySmallBizRate: 0.40,
      clientProfile: { sdvosb: false, wosb: false, hubzone: false, smallBusiness: true },
    })
    expect(r.breakdown.agencyBuyingPatterns).toBe(90)
  })

  it('returns 50 (neutral) when no rate data', () => {
    const r = computeMarketScore({})
    expect(r.breakdown.agencyBuyingPatterns).toBe(50)
  })
})

describe('computeMarketScore — timing advantage (10% weight)', () => {
  it('scores 85 for sources sought / RFI', () => {
    const r = computeMarketScore({ noticeType: 'Sources Sought' })
    expect(r.breakdown.timingAdvantage).toBe(85)
  })

  it('scores 72 for presolicitation', () => {
    const r = computeMarketScore({ noticeType: 'Presolicitation' })
    expect(r.breakdown.timingAdvantage).toBe(72)
  })

  it('scores 30 for award notice (late stage)', () => {
    const r = computeMarketScore({ noticeType: 'Award Notice' })
    expect(r.breakdown.timingAdvantage).toBe(30)
  })

  it('scores 15 for sole source J&A', () => {
    const r = computeMarketScore({ noticeType: 'Sole Source J&A' })
    expect(r.breakdown.timingAdvantage).toBe(15)
  })

  it('adds +10 timing bonus on recompete', () => {
    const without = computeMarketScore({ noticeType: 'Solicitation' })
    const withRecompete = computeMarketScore({ noticeType: 'Solicitation', recompeteFlag: true })
    expect(withRecompete.breakdown.timingAdvantage - without.breakdown.timingAdvantage).toBe(10)
  })
})

describe('computeMarketScore — composite scenarios', () => {
  it('produces a strong overall score (>= 80) for a low-competition fragmented sweet-spot SDVOSB market', () => {
    const r = computeMarketScore({
      offersReceived: 2,
      incumbentProbability: 0.1,
      estimatedValue: 1_500_000,
      agencySdvosbRate: 0.18,
      clientProfile: { sdvosb: true, wosb: false, hubzone: false, smallBusiness: true },
      noticeType: 'Sources Sought',
      recompeteFlag: true,
    })
    expect(r.total).toBeGreaterThanOrEqual(80)
  })

  it('produces a low overall score (<= 35) for a hyper-competitive dominant-incumbent mega-prime', () => {
    const r = computeMarketScore({
      offersReceived: 30,
      incumbentProbability: 0.92,
      estimatedValue: 80_000_000,
      noticeType: 'Award Notice',
      clientProfile: { sdvosb: false, wosb: false, hubzone: false, smallBusiness: true },
    })
    expect(r.total).toBeLessThanOrEqual(35)
  })
})
