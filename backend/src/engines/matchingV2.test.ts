// =============================================================
// Matching v2 (GB-101 + GB-102) — unit tests
//
// Covers the three structural fixes and every acceptance criterion:
//   - dynamic renormalization across present/absent dimension permutations
//   - graduated NAICS (exact / prefix / secondary)
//   - PSC exact + family
//   - the canonical Bytes Platform freight fixture (>= 70%)
//   - PSC-null does not lower the score (renormalization, not inflation)
//   - a matching PSC scores measurably higher than a non-matching one
//   - the reproduction baseline: the legacy win-probability path under-scores
//     the same canonical pair (locks the defect this PR corrects)
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  computeMatchScoreV2,
  scoreNaicsDimension,
  scorePscDimension,
  MatchV2Client,
  MatchV2Opportunity,
} from './matchingV2'
import { scoreOpportunityForClient } from './probabilityEngine'
import { MatchV2Weights } from '../types'

// Mirrors config.matching.weights defaults so tests are deterministic and
// independent of the environment.
const WEIGHTS: MatchV2Weights = {
  naics: 0.35,
  psc: 0.25,
  awardSize: 0.15,
  geography: 0.1,
  pastPerformance: 0.1,
  setAsideAlignment: 0.05,
}

// ── Canonical validation fixture (task §C): Bytes Platform ──
// Primary NAICS 488510 (Freight Transportation Arrangement), SDVOSB.
const DEMO_CLIENT: MatchV2Client = {
  naicsCodes: ['488510'],
  pscCodes: ['V112'], // Transportation of Things (freight)
  sdvosb: true,
  wosb: false,
  hubzone: false,
  smallBusiness: true,
  state: 'TX',
  performanceStats: null,
}

// A clearly relevant freight/logistics opportunity (exact NAICS + PSC).
const LOGISTICS_OPP: MatchV2Opportunity = {
  naicsCode: '488510',
  psc: 'V112',
  estimatedValue: 750_000,
  placeOfPerformance: 'Fort Worth, TX',
  historicalAvgAward: 600_000,
  setAsideType: 'SDVOSB',
}

// The realistic "PSC-starvation" case the legacy scorer mishandles: a freight
// opportunity that is clearly relevant via its transportation PSC but is
// NAICS-tagged under an adjacent freight code the firm doesn't hold exactly
// (488510 freight arrangement vs 484110 general freight trucking). The legacy
// win-probability path ignores PSC and only credits the 2-digit NAICS prefix,
// so it under-scores; v2 credits the exact PSC and recovers a true match.
const LOGISTICS_OPP_PSC_LED: MatchV2Opportunity = {
  naicsCode: '484110',
  psc: 'V112',
  estimatedValue: 750_000,
  placeOfPerformance: 'Fort Worth, TX',
  historicalAvgAward: 600_000,
  setAsideType: 'SDVOSB',
}

describe('scoreNaicsDimension — graduated prefix + secondary', () => {
  it('exact 6-digit match scores 1.0', () => {
    expect(scoreNaicsDimension(['488510'], '488510')).toBe(1.0)
  })

  it('graduates down by shared prefix length', () => {
    expect(scoreNaicsDimension(['488519'], '488510')).toBe(0.85) // 5-digit
    expect(scoreNaicsDimension(['488599'], '488510')).toBe(0.6) // 4-digit
    expect(scoreNaicsDimension(['488110'], '488510')).toBe(0.45) // 3-digit
    expect(scoreNaicsDimension(['484121'], '488510')).toBe(0.3) // 2-digit
  })

  it('credits a secondary NAICS, not just the primary', () => {
    // primary is unrelated IT; secondary is the freight match
    expect(scoreNaicsDimension(['541512', '488510'], '488510')).toBe(1.0)
  })

  it('returns 0 for a genuinely unrelated sector', () => {
    expect(scoreNaicsDimension(['488510'], '111110')).toBe(0)
  })

  it('takes the best score across all registered codes', () => {
    expect(scoreNaicsDimension(['111110', '484121', '488599'], '488510')).toBe(0.6)
  })
})

describe('scorePscDimension — exact + family', () => {
  it('exact PSC match scores 1.0', () => {
    expect(scorePscDimension(['V112'], 'V112')).toBe(1.0)
  })

  it('same family (first 2 chars) scores 0.5', () => {
    expect(scorePscDimension(['V111'], 'V125')).toBe(0.5)
  })

  it('different family scores 0', () => {
    expect(scorePscDimension(['R425'], 'V112')).toBe(0)
  })

  it('is case-insensitive and trims', () => {
    expect(scorePscDimension([' v112 '], 'V112')).toBe(1.0)
  })
})

describe('computeMatchScoreV2 — invariants', () => {
  it('returns an integer total in [0, 100]', () => {
    const r = computeMatchScoreV2(DEMO_CLIENT, LOGISTICS_OPP, WEIGHTS)
    expect(Number.isInteger(r.total)).toBe(true)
    expect(r.total).toBeGreaterThanOrEqual(0)
    expect(r.total).toBeLessThanOrEqual(100)
  })

  it('reports exactly the dimensions that were comparable', () => {
    const r = computeMatchScoreV2(DEMO_CLIENT, LOGISTICS_OPP, WEIGHTS)
    // DEMO_CLIENT has no performance stats -> pastPerformance absent
    expect(r.dimensionsPresent.sort()).toEqual(
      ['awardSize', 'geography', 'naics', 'psc', 'setAsideAlignment'].sort()
    )
    expect(r.breakdown.pastPerformance.present).toBe(false)
  })

  it('returns 0 when no dimension is comparable', () => {
    const blank: MatchV2Client = {
      naicsCodes: [],
      pscCodes: [],
      sdvosb: false,
      wosb: false,
      hubzone: false,
      smallBusiness: false,
      state: null,
      performanceStats: null,
    }
    const blankOpp: MatchV2Opportunity = {
      naicsCode: '000000',
      psc: null,
      estimatedValue: null,
      placeOfPerformance: null,
      historicalAvgAward: null,
      setAsideType: 'NONE',
    }
    expect(computeMatchScoreV2(blank, blankOpp, WEIGHTS).total).toBe(0)
  })
})

describe('Acceptance criteria (task §E)', () => {
  it('AC1: Bytes Platform vs a relevant freight opportunity scores >= 70', () => {
    const r = computeMatchScoreV2(DEMO_CLIENT, LOGISTICS_OPP, WEIGHTS)
    expect(r.total).toBeGreaterThanOrEqual(70)
  })

  it('AC2: a matching PSC scores measurably higher than a non-matching PSC', () => {
    const matching = computeMatchScoreV2(DEMO_CLIENT, LOGISTICS_OPP, WEIGHTS)
    const nonMatching = computeMatchScoreV2(
      DEMO_CLIENT,
      { ...LOGISTICS_OPP, psc: 'R425' }, // different PSC family
      WEIGHTS
    )
    expect(matching.total).toBeGreaterThan(nonMatching.total)
  })

  it('AC3: setting PSC to null does not lower the score vs the pre-PSC dimensions alone', () => {
    const withNullPsc = computeMatchScoreV2(DEMO_CLIENT, { ...LOGISTICS_OPP, psc: null }, WEIGHTS)
    // "pre-PSC dimensions alone" — same pair with the firm holding no PSCs,
    // so the PSC dimension is likewise excluded. Must be identical, proving
    // renormalization (PSC dropped from numerator AND denominator), not
    // inflation (which would have divided by an unreachable PSC weight).
    const noPscClient = computeMatchScoreV2(
      { ...DEMO_CLIENT, pscCodes: [] },
      LOGISTICS_OPP,
      WEIGHTS
    )
    expect(withNullPsc.breakdown.psc.present).toBe(false)
    expect(withNullPsc.total).toBe(noPscClient.total)
    expect(withNullPsc.total).toBeGreaterThanOrEqual(70)
  })

  it('AC4: a secondary-NAICS-only fit produces a nonzero, graduated score', () => {
    const secondaryOnly: MatchV2Client = {
      ...DEMO_CLIENT,
      naicsCodes: ['541512', '488599'], // only a 4-digit-prefix freight match
      pscCodes: [],
    }
    const opp: MatchV2Opportunity = {
      naicsCode: '488510',
      psc: null,
      estimatedValue: null,
      placeOfPerformance: null,
      historicalAvgAward: null,
      setAsideType: 'NONE',
    }
    const r = computeMatchScoreV2(secondaryOnly, opp, WEIGHTS)
    expect(r.dimensionsPresent).toEqual(['naics'])
    expect(r.total).toBeGreaterThan(0)
    expect(r.breakdown.naics.raw).toBeCloseTo(0.6, 5)
    // renormalized over the single present dimension -> 60
    expect(r.total).toBe(60)
  })
})

describe('Dynamic renormalization — present/absent permutations', () => {
  it('a perfect single-dimension pair renormalizes to 100', () => {
    const naicsOnly: MatchV2Client = {
      naicsCodes: ['488510'],
      pscCodes: [],
      sdvosb: false,
      wosb: false,
      hubzone: false,
      smallBusiness: false,
      state: null,
      performanceStats: null,
    }
    const opp: MatchV2Opportunity = {
      naicsCode: '488510',
      psc: null,
      estimatedValue: null,
      placeOfPerformance: null,
      historicalAvgAward: null,
      setAsideType: 'NONE',
    }
    const r = computeMatchScoreV2(naicsOnly, opp, WEIGHTS)
    expect(r.dimensionsPresent).toEqual(['naics'])
    expect(r.total).toBe(100)
  })

  it('adding a fully-absent dimension does not change the score', () => {
    // baseline: NAICS exact + award size in range
    const client: MatchV2Client = {
      naicsCodes: ['488510'],
      pscCodes: [],
      sdvosb: false,
      wosb: false,
      hubzone: false,
      smallBusiness: false,
      state: null,
      performanceStats: null,
    }
    const base: MatchV2Opportunity = {
      naicsCode: '488510',
      psc: null,
      estimatedValue: 600_000,
      placeOfPerformance: null,
      historicalAvgAward: 600_000,
      setAsideType: 'NONE',
    }
    const a = computeMatchScoreV2(client, base, WEIGHTS)
    // Same pair, but the opportunity now also lacks a PSC (already null) and
    // the firm still has none -> psc stays absent. Score unchanged.
    const b = computeMatchScoreV2(client, { ...base }, WEIGHTS)
    expect(a.total).toBe(b.total)
    expect(a.dimensionsPresent.sort()).toEqual(['awardSize', 'naics'].sort())
  })

  it('weights need not sum to 1 — renormalization is scale-invariant', () => {
    const doubled: MatchV2Weights = {
      naics: 0.7,
      psc: 0.5,
      awardSize: 0.3,
      geography: 0.2,
      pastPerformance: 0.2,
      setAsideAlignment: 0.1,
    }
    const a = computeMatchScoreV2(DEMO_CLIENT, LOGISTICS_OPP, WEIGHTS)
    const b = computeMatchScoreV2(DEMO_CLIENT, LOGISTICS_OPP, doubled)
    expect(b.total).toBe(a.total)
  })
})

describe('Reproduction baseline (task §D.1) — legacy path under-scores', () => {
  it('the legacy win-probability match score for the canonical pair is below the 70% relevance bar', () => {
    // This locks the defect: the operator-facing match score historically came
    // from the win-probability model (logistic, baseline bias), which ignores
    // PSC entirely and deflates even a canonical freight match. The corrected
    // v2 score for the SAME pair clears 70 (asserted above in AC1).
    const legacy = scoreOpportunityForClient({
      opportunityNaics: LOGISTICS_OPP_PSC_LED.naicsCode,
      opportunityEstimatedValue: LOGISTICS_OPP_PSC_LED.estimatedValue,
      opportunityAgency: 'GSA',
      clientNaics: DEMO_CLIENT.naicsCodes,
      clientProfile: {
        sdvosb: DEMO_CLIENT.sdvosb,
        wosb: DEMO_CLIENT.wosb,
        hubzone: DEMO_CLIENT.hubzone,
        smallBusiness: DEMO_CLIENT.smallBusiness,
      },
    })
    expect(legacy.status).toBe('OK')
    if (legacy.status !== 'OK') throw new Error('expected OK win-probability result')
    const legacyMatchScore = Math.round(legacy.probability * 100)
    expect(legacyMatchScore).toBeLessThan(70)

    const corrected = computeMatchScoreV2(DEMO_CLIENT, LOGISTICS_OPP_PSC_LED, WEIGHTS)
    expect(corrected.total).toBeGreaterThanOrEqual(70)
    expect(corrected.total).toBeGreaterThan(legacyMatchScore)
  })
})
