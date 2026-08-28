// =============================================================
// §6.2C / §6.2D — Retention and competitor statistics.
//
// The headline rule under test: award share is NEVER labelled a bid win rate
// when bid-participation data is unavailable. Also: no percentage without a
// denominator, and a single ambiguous record never produces a retention rate.
// =============================================================
import { describe, it, expect } from 'vitest'
import { RateBasis } from '@prisma/client'
import {
  computeRetention,
  computeCompetitorStat,
  normalizeCompanyName,
  BASIS_LABELS,
  MIN_SAMPLE_FOR_RATE,
  type AwardObservation,
} from './evidenceStats'

const award = (over: Partial<AwardObservation> = {}): AwardObservation => ({
  contractNumber: 'W15P7T-20-C-0001',
  recipientName: 'Acme Systems Inc.',
  recipientUei: 'ABC123',
  agency: 'Department of Defense',
  naics: '541512',
  psc: 'D310',
  awardDate: new Date('2020-01-01T00:00:00Z'),
  awardAmount: 1_000_000,
  ...over,
})

describe('normalizeCompanyName', () => {
  it('strips corporate suffixes so the same company matches itself', () => {
    expect(normalizeCompanyName('Acme Systems Inc.')).toBe(normalizeCompanyName('ACME SYSTEMS, LLC'))
    expect(normalizeCompanyName('Beta Technologies Corporation')).toBe('beta')
  })
})

describe('computeRetention — no percentage without a denominator', () => {
  it('returns a null rate when a single ambiguous record is all that exists', () => {
    const result = computeRetention(normalizeCompanyName('Acme Systems Inc.'), [award()])
    expect(result.retentionRate).toBeNull()
    expect(result.basis).toBe(RateBasis.INSUFFICIENT_DATA)
    expect(result.explanation).toMatch(/a single award record does not establish/i)
  })

  it('excludes contracts seen only once from the denominator', () => {
    const result = computeRetention(normalizeCompanyName('Acme Systems Inc.'), [
      award({ contractNumber: 'C-1' }),
      award({ contractNumber: 'C-2' }),
      award({ contractNumber: 'C-3' }),
    ])
    expect(result.sampleSize).toBe(0)
    expect(result.retentionRate).toBeNull()
  })

  it('computes a rate once enough re-competes are observed', () => {
    const acme = normalizeCompanyName('Acme Systems Inc.')
    const observations: AwardObservation[] = []
    // Three retained re-competes and one lost.
    for (const n of ['C-1', 'C-2', 'C-3']) {
      observations.push(award({ contractNumber: n, awardDate: new Date('2018-01-01T00:00:00Z') }))
      observations.push(award({ contractNumber: n, awardDate: new Date('2023-01-01T00:00:00Z') }))
    }
    observations.push(award({ contractNumber: 'C-4', awardDate: new Date('2018-01-01T00:00:00Z') }))
    observations.push(award({ contractNumber: 'C-4', recipientName: 'Rival Group LLC', awardDate: new Date('2023-01-01T00:00:00Z') }))

    const result = computeRetention(acme, observations)
    expect(result.retainedCount).toBe(3)
    expect(result.lostRecompeteCount).toBe(1)
    expect(result.sampleSize).toBe(4)
    expect(result.retentionRate).toBe(0.75)
    // Derived from awards, so it is award-share based — never a "win rate".
    expect(result.basis).toBe(RateBasis.OBSERVED_AWARD_SHARE)
    expect(result.explanation).toMatch(/observed outcomes rather than confirmed bid participation/i)
  })

  it('ignores contracts whose first holder is a different company', () => {
    const result = computeRetention(normalizeCompanyName('Acme Systems Inc.'), [
      award({ contractNumber: 'C-9', recipientName: 'Other Co', awardDate: new Date('2018-01-01T00:00:00Z') }),
      award({ contractNumber: 'C-9', awardDate: new Date('2023-01-01T00:00:00Z') }),
    ])
    expect(result.sampleSize).toBe(0)
  })

  it('produces identical output for identical input', () => {
    const observations = [award({ contractNumber: 'C-1' }), award({ contractNumber: 'C-1', awardDate: new Date('2023-01-01') })]
    const key = normalizeCompanyName('Acme Systems Inc.')
    expect(computeRetention(key, observations)).toEqual(computeRetention(key, observations))
  })
})

describe('computeCompetitorStat — the labelling rule', () => {
  it('NEVER reports a win rate when no bid-participation data exists', () => {
    const result = computeCompetitorStat(6, 20, { wins: 0, losses: 0 })
    expect(result.basis).toBe(RateBasis.OBSERVED_AWARD_SHARE)
    expect(result.confirmedWinRate).toBeNull()
    expect(result.observedAwardShare).toBe(0.3)
    expect(result.basisLabel).toBe('Observed award share')
    expect(result.basisLabel).not.toMatch(/win rate/i)
    expect(result.explanation).toMatch(/not a win rate/i)
  })

  it('uses a confirmed win rate ONLY when real bid participation is recorded', () => {
    const result = computeCompetitorStat(6, 20, { wins: 4, losses: 6 })
    expect(result.basis).toBe(RateBasis.CONFIRMED_WIN_RATE)
    expect(result.confirmedWinRate).toBe(0.4)
    expect(result.observedAwardShare).toBeNull()
    expect(result.basisLabel).toBe('Confirmed win rate')
    expect(result.confirmedBids).toBe(10)
  })

  it('falls back to award frequency when the comparable pool is too small', () => {
    const result = computeCompetitorStat(2, 2, { wins: 0, losses: 0 })
    expect(result.basis).toBe(RateBasis.HISTORICAL_AWARD_FREQUENCY)
    expect(result.basisLabel).toBe('Historical award frequency')
    expect(result.confirmedWinRate).toBeNull()
    expect(result.observedAwardShare).toBeNull()
  })

  it('reports bid-participation data unavailable when nothing is known', () => {
    const result = computeCompetitorStat(0, 0, { wins: 0, losses: 0 })
    expect(result.basis).toBe(RateBasis.INSUFFICIENT_DATA)
    expect(result.basisLabel).toBe('Bid-participation data unavailable')
  })

  it('requires at least the minimum confirmed bids before claiming a win rate', () => {
    const belowThreshold = computeCompetitorStat(6, 20, { wins: 1, losses: 1 })
    expect(belowThreshold.confirmedBids).toBeLessThan(MIN_SAMPLE_FOR_RATE)
    expect(belowThreshold.basis).not.toBe(RateBasis.CONFIRMED_WIN_RATE)
  })

  it('always carries a denominator alongside any stated rate', () => {
    const share = computeCompetitorStat(6, 20, { wins: 0, losses: 0 })
    expect(share.sampleSize).toBe(20)
    expect(share.explanation).toContain('20')

    const confirmed = computeCompetitorStat(6, 20, { wins: 4, losses: 6 })
    expect(confirmed.sampleSize).toBe(10)
    expect(confirmed.explanation).toContain('10')
  })
})

describe('BASIS_LABELS', () => {
  it('exposes the exact user-facing wording for every basis', () => {
    expect(BASIS_LABELS).toEqual({
      CONFIRMED_WIN_RATE: 'Confirmed win rate',
      OBSERVED_AWARD_SHARE: 'Observed award share',
      HISTORICAL_AWARD_FREQUENCY: 'Historical award frequency',
      INSUFFICIENT_DATA: 'Bid-participation data unavailable',
    })
  })

  it('never describes an award-derived figure as a win rate', () => {
    for (const basis of [RateBasis.OBSERVED_AWARD_SHARE, RateBasis.HISTORICAL_AWARD_FREQUENCY, RateBasis.INSUFFICIENT_DATA]) {
      expect(BASIS_LABELS[basis].toLowerCase()).not.toContain('win rate')
    }
  })
})
