// =============================================================
// §7.4 — Borderline policy, pure.
//
// No database. This is the decision rule the whole agent rests on, so it is
// tested at every boundary the policy names: below the band, the exact lower
// edge, inside, the decision threshold, the exact upper edge, above, interval
// crossing and not crossing, wide and narrow intervals, and each non-probability
// input on its own and in combination.
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  BORDERLINE_BAND, BORDERLINE_LOWER, BORDERLINE_POLICY_VERSION, BORDERLINE_UPPER,
  DECISION_BOUNDARY, MAX_USEFUL_INTERVAL_WIDTH, STRONG_BID_PROBABILITY, STRONG_NO_BID_PROBABILITY,
  detectStageContradiction, evaluateBorderline, type BorderlineInput,
} from './borderlinePolicy'
import { BID_THRESHOLD, CONDITIONAL_THRESHOLD } from '../../scorecardScoring'

/** A clean, decisive input. Every test perturbs exactly one field. */
const clean = (over: Partial<BorderlineInput> = {}): BorderlineInput => ({
  finalProbability: 80,
  intervalLower: 72,
  intervalUpper: 88,
  confidenceState: 'HIGH',
  dataSufficiency: 'SUFFICIENT',
  capabilityGapSeverity: 'NONE',
  capacityState: 'AVAILABLE',
  complianceBlockers: 0,
  complianceHumanReviewItems: 0,
  scorecardScore: 78,
  ...over,
})

describe('policy constants come from Section 5, not from thin air', () => {
  it('uses Section 5\'s conditional threshold as the decision boundary', () => {
    expect(DECISION_BOUNDARY).toBe(CONDITIONAL_THRESHOLD)
    expect(CONDITIONAL_THRESHOLD).toBe(50)
  })

  it('re-exports Section 5\'s scorecard bands rather than restating them', () => {
    expect(BID_THRESHOLD).toBe(70)
  })

  it('pins the band, interval limit and strength thresholds', () => {
    expect(BORDERLINE_BAND).toBe(10)
    expect(BORDERLINE_LOWER).toBe(40)
    expect(BORDERLINE_UPPER).toBe(60)
    expect(MAX_USEFUL_INTERVAL_WIDTH).toBe(40)
    expect(STRONG_BID_PROBABILITY).toBe(70)
    expect(STRONG_NO_BID_PROBABILITY).toBe(25)
  })

  it('stamps its version on every outcome', () => {
    expect(evaluateBorderline(clean()).policyVersion).toBe(BORDERLINE_POLICY_VERSION)
  })
})

describe('the probability band', () => {
  it('recommends a strong no-bid clearly below the band', () => {
    const r = evaluateBorderline(clean({ finalProbability: 15, intervalLower: 8, intervalUpper: 22 }))
    expect(r.recommendation).toBe('RECOMMEND_NO_BID')
    expect(r.strength).toBe('STRONG')
    expect(r.isBorderline).toBe(false)
  })

  it('is borderline at the EXACT lower edge of the band', () => {
    const r = evaluateBorderline(clean({ finalProbability: BORDERLINE_LOWER, intervalLower: 35, intervalUpper: 45 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('PROBABILITY_NEAR_BOUNDARY')
  })

  it('is not borderline one point below the band', () => {
    const r = evaluateBorderline(clean({ finalProbability: BORDERLINE_LOWER - 1, intervalLower: 34, intervalUpper: 44 }))
    expect(r.recommendation).toBe('RECOMMEND_NO_BID')
    expect(r.isBorderline).toBe(false)
  })

  it('is borderline inside the band', () => {
    const r = evaluateBorderline(clean({ finalProbability: 45, intervalLower: 40, intervalUpper: 50 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
  })

  it('is borderline exactly AT the decision threshold', () => {
    const r = evaluateBorderline(clean({ finalProbability: DECISION_BOUNDARY, intervalLower: 45, intervalUpper: 55 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('PROBABILITY_NEAR_BOUNDARY')
  })

  it('is borderline at the EXACT upper edge of the band', () => {
    const r = evaluateBorderline(clean({ finalProbability: BORDERLINE_UPPER, intervalLower: 55, intervalUpper: 65 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
  })

  it('is not borderline one point above the band', () => {
    const r = evaluateBorderline(clean({ finalProbability: BORDERLINE_UPPER + 1, intervalLower: 56, intervalUpper: 66 }))
    expect(r.recommendation).toBe('RECOMMEND_BID')
    expect(r.isBorderline).toBe(false)
  })

  it('recommends a strong bid clearly above the band', () => {
    const r = evaluateBorderline(clean({ finalProbability: 85, intervalLower: 78, intervalUpper: 92 }))
    expect(r.recommendation).toBe('RECOMMEND_BID')
    expect(r.strength).toBe('STRONG')
  })

  it('calls a bid MODERATE below the strong threshold', () => {
    const r = evaluateBorderline(clean({ finalProbability: 65, intervalLower: 62, intervalUpper: 68 }))
    expect(r.recommendation).toBe('RECOMMEND_BID')
    expect(r.strength).toBe('MODERATE')
  })

  it('calls a no-bid MODERATE above the strong threshold', () => {
    const r = evaluateBorderline(clean({ finalProbability: 32, intervalLower: 28, intervalUpper: 36 }))
    expect(r.recommendation).toBe('RECOMMEND_NO_BID')
    expect(r.strength).toBe('MODERATE')
  })

  it('never calls a decision STRONG on low confidence', () => {
    const r = evaluateBorderline(clean({ finalProbability: 85, confidenceState: 'LOW', intervalLower: 78, intervalUpper: 92 }))
    expect(r.strength).toBe('MODERATE')
  })
})

describe('the confidence interval', () => {
  it('is borderline when the interval crosses the boundary', () => {
    // A confident-looking 62% whose interval spans the line.
    const r = evaluateBorderline(clean({ finalProbability: 62, intervalLower: 45, intervalUpper: 79 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('INTERVAL_CROSSES_BOUNDARY')
  })

  it('is not borderline when the interval stays on one side', () => {
    const r = evaluateBorderline(clean({ finalProbability: 70, intervalLower: 62, intervalUpper: 78 }))
    expect(r.recommendation).toBe('RECOMMEND_BID')
    expect(r.reasonCodes).not.toContain('INTERVAL_CROSSES_BOUNDARY')
  })

  it('treats an interval touching the boundary exactly as crossing it', () => {
    const r = evaluateBorderline(clean({ finalProbability: 70, intervalLower: DECISION_BOUNDARY, intervalUpper: 85 }))
    expect(r.reasonCodes).toContain('INTERVAL_CROSSES_BOUNDARY')
  })

  it('is borderline when the interval is wider than the useful limit', () => {
    const r = evaluateBorderline(clean({ finalProbability: 80, intervalLower: 55, intervalUpper: 99 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('INTERVAL_TOO_WIDE')
  })

  it('accepts an interval exactly at the width limit', () => {
    const r = evaluateBorderline(clean({ finalProbability: 80, intervalLower: 60, intervalUpper: 60 + MAX_USEFUL_INTERVAL_WIDTH }))
    expect(r.reasonCodes).not.toContain('INTERVAL_TOO_WIDE')
  })

  it('is borderline when no interval could be produced', () => {
    const r = evaluateBorderline(clean({ intervalLower: null, intervalUpper: null }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('INTERVAL_UNAVAILABLE')
  })

  it('never renders a fake full-range interval as usable', () => {
    const r = evaluateBorderline(clean({ finalProbability: 80, intervalLower: 0, intervalUpper: 100 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toEqual(expect.arrayContaining(['INTERVAL_CROSSES_BOUNDARY', 'INTERVAL_TOO_WIDE']))
  })
})

describe('non-probability inputs can make a confident number borderline', () => {
  it('a CRITICAL capability gap overrides a strong probability', () => {
    const r = evaluateBorderline(clean({ capabilityGapSeverity: 'CRITICAL' }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('CRITICAL_CAPABILITY_GAP')
  })

  it('a MAJOR capability gap is borderline too', () => {
    const r = evaluateBorderline(clean({ capabilityGapSeverity: 'MAJOR' }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('MAJOR_CAPABILITY_GAP')
  })

  it('a MINOR gap alone does not force review', () => {
    const r = evaluateBorderline(clean({ capabilityGapSeverity: 'MINOR' }))
    expect(r.recommendation).toBe('RECOMMEND_BID')
  })

  it('a capacity conflict forces review', () => {
    const r = evaluateBorderline(clean({ capacityState: 'OVER_CAPACITY' }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('CAPACITY_CONFLICT')
  })

  it('UNKNOWN capacity forces review and is never read as available', () => {
    const r = evaluateBorderline(clean({ capacityState: 'INSUFFICIENT_DATA' }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('CAPACITY_UNKNOWN')
  })

  it('NEAR_CAPACITY alone does not force review', () => {
    expect(evaluateBorderline(clean({ capacityState: 'NEAR_CAPACITY' })).recommendation).toBe('RECOMMEND_BID')
  })

  it('a compliance blocker forces review', () => {
    const r = evaluateBorderline(clean({ complianceBlockers: 1 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('COMPLIANCE_BLOCKER')
  })

  it('a compliance human-review item forces review', () => {
    const r = evaluateBorderline(clean({ complianceHumanReviewItems: 2 }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('COMPLIANCE_HUMAN_REVIEW')
  })

  it('combines multiple uncertainties, in a stable order', () => {
    const r = evaluateBorderline(clean({
      finalProbability: 48, intervalLower: 20, intervalUpper: 76,
      capabilityGapSeverity: 'CRITICAL', capacityState: 'OVER_CAPACITY',
      complianceBlockers: 2, complianceHumanReviewItems: 1,
    }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toEqual([
      'COMPLIANCE_BLOCKER',
      'CRITICAL_CAPABILITY_GAP',
      'CAPACITY_CONFLICT',
      'PROBABILITY_NEAR_BOUNDARY',
      'INTERVAL_CROSSES_BOUNDARY',
      'INTERVAL_TOO_WIDE',
      'COMPLIANCE_HUMAN_REVIEW',
    ])
    expect(r.reasons).toHaveLength(r.reasonCodes.length)
  })
})

describe('insufficient data', () => {
  it('reports INSUFFICIENT_DATA when there is no probability at all', () => {
    const r = evaluateBorderline(clean({ finalProbability: null }))
    expect(r.recommendation).toBe('INSUFFICIENT_DATA')
    expect(r.strength).toBe('NONE')
    expect(r.reasonCodes).toContain('INSUFFICIENT_EVIDENCE')
  })

  it('reports INSUFFICIENT_DATA when the model had no data at all', () => {
    const r = evaluateBorderline(clean({ dataSufficiency: 'NONE' }))
    expect(r.recommendation).toBe('INSUFFICIENT_DATA')
  })

  it('never silently converts insufficient data into a no-bid', () => {
    const r = evaluateBorderline(clean({ finalProbability: null }))
    expect(r.recommendation).not.toBe('RECOMMEND_NO_BID')
    expect(r.recommendation).not.toBe('RECOMMEND_BID')
  })

  it('treats insufficient probability data plus no interval as borderline, not decisive', () => {
    const r = evaluateBorderline(clean({ dataSufficiency: 'INSUFFICIENT', confidenceState: 'INSUFFICIENT_DATA', intervalLower: null, intervalUpper: null }))
    expect(r.recommendation).toBe('BORDERLINE_REVIEW')
    expect(r.reasonCodes).toContain('INSUFFICIENT_EVIDENCE')
  })
})

describe('determinism', () => {
  it('produces an identical outcome for identical input', () => {
    const input = clean({ finalProbability: 52, capabilityGapSeverity: 'MAJOR' })
    expect(evaluateBorderline(input)).toEqual(evaluateBorderline(input))
  })

  it('never returns a reason without matching text', () => {
    const r = evaluateBorderline(clean({ finalProbability: 50, capacityState: 'INSUFFICIENT_DATA' }))
    expect(r.reasons.every((s) => s.length > 0)).toBe(true)
    expect(r.reasons).toHaveLength(r.reasonCodes.length)
  })
})

describe('stage contradiction', () => {
  const noBid = evaluateBorderline(clean({ finalProbability: 12, intervalLower: 6, intervalUpper: 18 }))

  it('flags a late-stage pursuit whose evidence now says no-bid', () => {
    const r = detectStageContradiction({
      pipelineStage: 'PROPOSAL', outcome: noBid, finalProbability: 12,
      capabilityGapSeverity: 'NONE', complianceBlockers: 0,
    })
    expect(r.contradicts).toBe(true)
    expect(r.reason).toContain('has not changed the stage or any decision')
  })

  it('does not flag an early-stage pursuit', () => {
    const r = detectStageContradiction({
      pipelineStage: 'QUALIFICATION', outcome: noBid, finalProbability: 12,
      capabilityGapSeverity: 'NONE', complianceBlockers: 0,
    })
    expect(r.contradicts).toBe(false)
  })

  it('flags a late-stage pursuit with a compliance blocker', () => {
    const r = detectStageContradiction({
      pipelineStage: 'SUBMITTED', outcome: evaluateBorderline(clean()), finalProbability: 80,
      capabilityGapSeverity: 'NONE', complianceBlockers: 1,
    })
    expect(r.contradicts).toBe(true)
  })

  it('flags a late-stage pursuit with a critical capability gap', () => {
    const r = detectStageContradiction({
      pipelineStage: 'CAPTURE', outcome: evaluateBorderline(clean()), finalProbability: 80,
      capabilityGapSeverity: 'CRITICAL', complianceBlockers: 0,
    })
    expect(r.contradicts).toBe(true)
  })

  it('does not flag a healthy late-stage pursuit', () => {
    const r = detectStageContradiction({
      pipelineStage: 'PROPOSAL', outcome: evaluateBorderline(clean()), finalProbability: 85,
      capabilityGapSeverity: 'NONE', complianceBlockers: 0,
    })
    expect(r.contradicts).toBe(false)
    expect(r.reason).toBeNull()
  })
})
