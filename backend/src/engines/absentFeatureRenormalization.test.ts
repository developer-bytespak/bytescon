// =============================================================
// Absent-feature renormalization + NAICS placeholder handling.
//
// Guards the fix for the "every opportunity scores ~0.31" defect. Measured on
// production before the fix: ~25 of 50 sampled opportunities returned EXACTLY
// 0.3092 and most of the rest 0.4081 — the two differing only by whether the
// client shared a 2-digit NAICS sector (0.24 weight x 0.3 subsector score =
// 0.072 of z, exactly the observed gap). The cause was seven of nine features
// falling back to a neutral constant when their source data was missing.
// =============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../services/calibrationCache', () => ({
  calibrateProbability: (p: number) => p,
}))
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const RENORM = { on: true }
vi.mock('../config/config', () => ({
  config: {
    get scoring() {
      return { renormalizeAbsentFeatures: RENORM.on }
    },
  },
}))

import { scoreOpportunityForClient, hasUsableNaics, computeNaicsOverlap } from './probabilityEngine'

const CLIENT = {
  clientNaics: ['541611', '561990'],
  clientProfile: { sdvosb: true, wosb: false, hubzone: false, smallBusiness: true },
}

/** The real-world shape: a SAM notice with nothing enriched yet. */
function bareOpportunity(over: Record<string, unknown> = {}) {
  return {
    opportunityNaics: '332618',
    opportunityEstimatedValue: null,
    opportunityAgency: 'DEPT OF DEFENSE',
    ...CLIENT,
    ...over,
  }
}

function ok(r: ReturnType<typeof scoreOpportunityForClient>) {
  if (r.status !== 'OK') throw new Error(`expected OK, got FAILED: ${r.failureReason}`)
  return r
}

beforeEach(() => { RENORM.on = true })
afterEach(() => { RENORM.on = true })

describe('hasUsableNaics', () => {
  it('rejects the synthesized placeholder at any width', () => {
    for (const c of ['000000', '00000', '0000', '00', '0']) {
      expect(hasUsableNaics(c), c).toBe(false)
    }
  })

  it('rejects blanks and non-numeric junk', () => {
    for (const c of ['', '   ', null, undefined, '-', 'N/A']) {
      expect(hasUsableNaics(c as string)).toBe(false)
    }
  })

  it('accepts real codes including the 5-digit values SAM returns', () => {
    for (const c of ['541611', '53119', '81392', '11']) {
      expect(hasUsableNaics(c), c).toBe(true)
    }
  })

  it('accepts codes with stray formatting', () => {
    expect(hasUsableNaics('541611 ')).toBe(true)
    expect(hasUsableNaics('54-1611')).toBe(true)
  })
})

describe('flag OFF reproduces the previous arithmetic exactly', () => {
  it('still returns the documented ~0.3092 constant for a bare unmatched opportunity', () => {
    RENORM.on = false
    // Reproduces the production observation: no NAICS match, nothing enriched,
    // deadline inside 5 days (urgency 0.1) -> z = 0.366 -> p = 0.3092.
    const r = ok(scoreOpportunityForClient(bareOpportunity({ deadlineUrgencyScore: 0.1 })))
    expect(r.rawScore).toBeCloseTo(0.366, 3)
    expect(r.probability).toBeCloseTo(0.3092, 4)
    expect(r.absentFeatures).toEqual([])
  })

  it('reproduces the second observed cluster when only a 2-digit sector matches', () => {
    RENORM.on = false
    // Client has 561990; opportunity 562119 shares the "56" subsector -> 0.3.
    const r = ok(scoreOpportunityForClient(
      bareOpportunity({ opportunityNaics: '562119', deadlineUrgencyScore: 0.1 })
    ))
    expect(r.probability).toBeCloseTo(0.4081, 4)
    // The gap between the clusters is exactly the NAICS weight x subsector score.
    expect(r.rawScore - 0.366).toBeCloseTo(0.24 * 0.3, 4)
  })
})

describe('flag ON: absent features are excluded, not defaulted', () => {
  it('reports exactly which features had no data', () => {
    const r = ok(scoreOpportunityForClient(bareOpportunity()))
    // Everything except naicsOverlapScore — the opportunity has a real code, so
    // its 0 (no match against this client) is evidence and stays in the mean.
    expect(new Set(r.absentFeatures)).toEqual(new Set([
      'incumbentWeaknessScore',
      'documentAlignmentScore',
      'agencyAlignmentScore',
      'awardSizeFitScore',
      'competitionDensityScore',
      'historicalDistribution',
      'agencyHistoryScore',
      'deadlineUrgencyScore',
    ]))
  })

  it('scores a genuinely poor fit far lower than the old constant', () => {
    const before = (() => { RENORM.on = false; return ok(scoreOpportunityForClient(bareOpportunity({ deadlineUrgencyScore: 0.1 }))) })()
    RENORM.on = true
    const after = ok(scoreOpportunityForClient(bareOpportunity({ deadlineUrgencyScore: 0.1 })))

    expect(before.probability).toBeCloseTo(0.3092, 4)
    expect(after.probability).toBeLessThan(before.probability)
    // A no-match NAICS with nothing else known should read as a long shot.
    expect(after.probability).toBeLessThan(0.15)
  })

  it('keeps a real NAICS mismatch as evidence rather than discarding it', () => {
    // Opportunity has a real code that does not match -> naicsOverlapScore 0 is
    // information and must stay in the denominator.
    const mismatch = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '332618' })))
    expect(mismatch.absentFeatures).not.toContain('naicsOverlapScore')
  })

  it('treats a placeholder NAICS as absent rather than as a real code', () => {
    const placeholder = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '000000' })))
    expect(placeholder.absentFeatures).toContain('naicsOverlapScore')

    // With a partly-enriched record the distinction is visible in the score:
    // an unknown domain drops NAICS out of the mean, while a known mismatch
    // holds a 0 in it and drags the result down.
    const enriched = { deadlineUrgencyScore: 1.0, documentAlignmentScore: 0.8 }
    const unknown = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '000000', ...enriched })))
    const mismatch = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '332618', ...enriched })))
    expect(unknown.probability).toBeGreaterThan(mismatch.probability)
  })

  it('treats an empty NAICS the same as the placeholder', () => {
    const a = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '' })))
    const b = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '000000' })))
    expect(a.probability).toBeCloseTo(b.probability, 10)
  })

  it('treats a client with no usable NAICS as absent, not as a mismatch', () => {
    const r = ok(scoreOpportunityForClient(bareOpportunity({ clientNaics: ['000000', ''] })))
    expect(r.absentFeatures).toContain('naicsOverlapScore')
  })

  it('falls back to the model prior, not a failure, when nothing at all is known', () => {
    // Permanent data absence must not be a typed failure: scoringWorker retries
    // FAILED through BullMQ, which would loop forever on an unscoreable record.
    const r = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '' })))
    expect(r.absentFeatures).toHaveLength(9)
    expect(r.rawScore).toBe(0)
    expect(r.probability).toBeCloseTo(0.0474, 4)
    expect(r.naicsSignal).toBe(false)
  })

  it('spreads scores across fit quality instead of clustering', () => {
    const exact = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '541611' })))
    const sector = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '541990' })))
    const none = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: '332618' })))

    expect(exact.probability).toBeGreaterThan(sector.probability)
    expect(sector.probability).toBeGreaterThan(none.probability)
    // The whole point: a real spread, not three values inside a hair of each other.
    expect(exact.probability - none.probability).toBeGreaterThan(0.3)
  })

  it('does not exclude a feature that was explicitly supplied as zero', () => {
    const r = ok(scoreOpportunityForClient(bareOpportunity({
      documentAlignmentScore: 0,
      agencyHistoryScore: 0,
      historicalDistribution: 0,
    })))
    expect(r.absentFeatures).not.toContain('documentAlignmentScore')
    expect(r.absentFeatures).not.toContain('agencyHistoryScore')
    expect(r.absentFeatures).not.toContain('historicalDistribution')
  })

  it('keeps a fully-enriched pair identical under both flag states', () => {
    const full = bareOpportunity({
      opportunityEstimatedValue: 500_000,
      incumbentProbability: 0.4,
      documentAlignmentScore: 0.8,
      agencyAlignmentScore: 0.6,
      historicalDistribution: 0.5,
      agencyHistoryScore: 0.7,
      deadlineUrgencyScore: 1.0,
      densityScore: 0.5,
    })
    RENORM.on = false
    const off = ok(scoreOpportunityForClient(full))
    RENORM.on = true
    const on = ok(scoreOpportunityForClient(full))

    // Nothing is absent, so renormalization is a no-op — this is the property
    // that makes the flag safe to flip for well-enriched tenants.
    expect(on.absentFeatures).toEqual([])
    expect(on.probability).toBeCloseTo(off.probability, 10)
  })

  it('never returns a probability outside the model range', () => {
    for (const naics of ['541611', '332618', '000000', '']) {
      const r = ok(scoreOpportunityForClient(bareOpportunity({ opportunityNaics: naics })))
      expect(r.probability).toBeGreaterThanOrEqual(0.0474)
      expect(r.probability).toBeLessThanOrEqual(0.9526)
    }
  })
})

describe('computeNaicsOverlap is unchanged by this work', () => {
  it('still grades exact / 4-digit / 2-digit / none', () => {
    expect(computeNaicsOverlap(['541611'], '541611')).toBe(1.0)
    expect(computeNaicsOverlap(['541611'], '541619')).toBe(0.6) // shares "5416"
    expect(computeNaicsOverlap(['541611'], '541990')).toBe(0.3) // shares only "54"
    expect(computeNaicsOverlap(['541611'], '332618')).toBe(0)
  })
})
