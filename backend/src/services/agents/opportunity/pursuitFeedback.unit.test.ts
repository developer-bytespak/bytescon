// =============================================================
// §7.2 — Pursuit-preference learning, pure derivation.
//
// No database. Covers the exact pursued/ignored mapping, the minimum-sample
// policy at threshold-1 / threshold / threshold+1, the adjustment bounds,
// renormalisation, determinism and the fingerprint.
// =============================================================
import { describe, it, expect } from 'vitest'
import { PipelineStage, PursuitSource, PursuitStatus } from '@prisma/client'
import {
  computeInputHash,
  computePursuitFeedback,
  labelPursuit,
  IGNORED_STAGES,
  NEUTRAL_STAGES,
  PURSUED_STAGES,
  type LabelledSample,
} from './pursuitFeedback'
import {
  LEARNABLE_DIMENSIONS,
  MAX_WEIGHT_ADJUSTMENT_PCT,
  MIN_FEEDBACK_CLASS_SIZE,
  MIN_FEEDBACK_SAMPLE_SIZE,
  baseWeights,
} from './policy'
import { DIMENSION_WEIGHTS } from '../../capabilityMatch'

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

function sample(id: string, label: 'PURSUED' | 'IGNORED', score: number): LabelledSample {
  const scores: LabelledSample['scores'] = {}
  for (const key of LEARNABLE_DIMENSIONS) scores[key] = score
  return { opportunityId: id, label, basis: 'test', scores }
}

/** A balanced sample of `total` records where pursued score high, ignored low. */
function balanced(total: number, pursuedShare = 0.5): LabelledSample[] {
  const pursuedCount = Math.round(total * pursuedShare)
  return [
    ...Array.from({ length: pursuedCount }, (_, i) => sample(`p-${String(i).padStart(3, '0')}`, 'PURSUED', 80)),
    ...Array.from({ length: total - pursuedCount }, (_, i) => sample(`i-${String(i).padStart(3, '0')}`, 'IGNORED', 20)),
  ]
}

// -------------------------------------------------------------
// Pursued vs ignored mapping
// -------------------------------------------------------------

describe('pursued vs ignored mapping', () => {
  const base = { status: PursuitStatus.REVIEWING, source: PursuitSource.USER }

  it.each(PURSUED_STAGES)('treats capture stage %s as PURSUED', (stage) => {
    expect(labelPursuit({ ...base, pipelineStage: stage })).toBe('PURSUED')
  })

  it('treats a LOST pursuit as pursued, because losing is an outcome not a preference', () => {
    expect(labelPursuit({ ...base, pipelineStage: PipelineStage.LOST })).toBe('PURSUED')
    expect(PURSUED_STAGES).toContain(PipelineStage.LOST)
    expect(IGNORED_STAGES).not.toContain(PipelineStage.LOST)
  })

  it('treats NO_BID as an explicit negative preference', () => {
    expect(labelPursuit({ ...base, pipelineStage: PipelineStage.NO_BID })).toBe('IGNORED')
  })

  it('treats a user-declared pass as a negative preference', () => {
    expect(
      labelPursuit({ pipelineStage: PipelineStage.IDENTIFIED, status: PursuitStatus.PASSED, source: PursuitSource.USER }),
    ).toBe('IGNORED')
  })

  it('does NOT treat a system AUTO_EXPIRED pass as a preference signal', () => {
    expect(
      labelPursuit({ pipelineStage: PipelineStage.IDENTIFIED, status: PursuitStatus.PASSED, source: PursuitSource.AUTO_EXPIRED }),
    ).toBeNull()
  })

  it.each(NEUTRAL_STAGES)('excludes housekeeping stage %s when nothing was declared', (stage) => {
    expect(labelPursuit({ pipelineStage: stage, status: PursuitStatus.REVIEWING, source: PursuitSource.USER })).toBeNull()
  })

  it('does not treat ARCHIVED alone as disinterest', () => {
    expect(
      labelPursuit({ pipelineStage: PipelineStage.ARCHIVED, status: PursuitStatus.REVIEWING, source: PursuitSource.USER }),
    ).toBeNull()
    expect(IGNORED_STAGES).not.toContain(PipelineStage.ARCHIVED)
  })

  it('counts a SUBMITTED declaration as pursued even before the stage moves', () => {
    expect(
      labelPursuit({ pipelineStage: PipelineStage.IDENTIFIED, status: PursuitStatus.SUBMITTED, source: PursuitSource.USER }),
    ).toBe('PURSUED')
  })
})

// -------------------------------------------------------------
// Minimum sample policy — the product decision, tested at the boundary
// -------------------------------------------------------------

describe('minimum sample policy', () => {
  it('is a named, exported product policy rather than a scattered magic number', () => {
    expect(MIN_FEEDBACK_SAMPLE_SIZE).toBe(20)
    expect(MIN_FEEDBACK_CLASS_SIZE).toBe(3)
  })

  it('reports INSUFFICIENT_DATA one record below the threshold', () => {
    const result = computePursuitFeedback(balanced(MIN_FEEDBACK_SAMPLE_SIZE - 1))
    expect(result.sufficient).toBe(false)
    expect(result.sampleSize).toBe(MIN_FEEDBACK_SAMPLE_SIZE - 1)
    expect(result.confidenceState).toBe('INSUFFICIENT_DATA')
    expect(result.insufficientReason).toContain(String(MIN_FEEDBACK_SAMPLE_SIZE))
  })

  it('proposes nothing below the threshold — the weights are the untouched baseline', () => {
    const result = computePursuitFeedback(balanced(MIN_FEEDBACK_SAMPLE_SIZE - 1))
    expect(result.proposedWeights).toEqual(baseWeights())
    expect(result.proposedWeights).toEqual({ ...DIMENSION_WEIGHTS })
  })

  it('becomes sufficient exactly AT the threshold', () => {
    const result = computePursuitFeedback(balanced(MIN_FEEDBACK_SAMPLE_SIZE))
    expect(result.sufficient).toBe(true)
    expect(result.sampleSize).toBe(MIN_FEEDBACK_SAMPLE_SIZE)
    expect(result.insufficientReason).toBeNull()
  })

  it('stays sufficient one record above the threshold', () => {
    const result = computePursuitFeedback(balanced(MIN_FEEDBACK_SAMPLE_SIZE + 1))
    expect(result.sufficient).toBe(true)
    expect(result.sampleSize).toBe(MIN_FEEDBACK_SAMPLE_SIZE + 1)
  })

  it('refuses a one-sided sample however large, because there is no contrast to learn from', () => {
    const onlyPursued = Array.from({ length: 100 }, (_, i) => sample(`p-${i}`, 'PURSUED', 80))
    const result = computePursuitFeedback(onlyPursued)
    expect(result.sufficient).toBe(false)
    expect(result.insufficientReason).toContain('one-sided')
    expect(result.proposedWeights).toEqual(baseWeights())
  })

  it('records the threshold in force on the computation itself', () => {
    expect(computePursuitFeedback(balanced(30)).minimumSampleSize).toBe(MIN_FEEDBACK_SAMPLE_SIZE)
  })
})

// -------------------------------------------------------------
// Bounds and renormalisation
// -------------------------------------------------------------

describe('learned adjustments are bounded', () => {
  it('never moves a dimension by more than the configured fraction of its base weight', () => {
    // Maximum possible contrast: pursued score 100, ignored score 0.
    const extreme: LabelledSample[] = [
      ...Array.from({ length: 15 }, (_, i) => sample(`p-${i}`, 'PURSUED', 100)),
      ...Array.from({ length: 15 }, (_, i) => sample(`i-${i}`, 'IGNORED', 0)),
    ]
    const result = computePursuitFeedback(extreme)
    for (const d of result.dimensions) {
      const maxMove = d.baseWeight * MAX_WEIGHT_ADJUSTMENT_PCT
      expect(Math.abs(d.adjustedWeight - d.baseWeight)).toBeLessThanOrEqual(maxMove + 1e-9)
    }
  })

  it('never zeroes a dimension out and never lets one dominate', () => {
    const extreme: LabelledSample[] = [
      ...Array.from({ length: 15 }, (_, i) => sample(`p-${i}`, 'PURSUED', 100)),
      ...Array.from({ length: 15 }, (_, i) => sample(`i-${i}`, 'IGNORED', 0)),
    ]
    const result = computePursuitFeedback(extreme)
    for (const key of LEARNABLE_DIMENSIONS) {
      expect(result.proposedWeights[key]).toBeGreaterThan(0)
      expect(result.proposedWeights[key]).toBeLessThan(1)
    }
  })

  it('renormalises the proposed weights back to 1 so the score stays on the same scale', () => {
    const result = computePursuitFeedback(balanced(40))
    const total = LEARNABLE_DIMENSIONS.reduce((s, k) => s + result.proposedWeights[k], 0)
    expect(total).toBeCloseTo(1, 4)
  })

  it('only ever adjusts dimensions the production matcher understands', () => {
    const result = computePursuitFeedback(balanced(40))
    expect(Object.keys(result.proposedWeights).sort()).toEqual([...LEARNABLE_DIMENSIONS].sort())
    expect(result.dimensions.map((d) => d.dimension).sort()).toEqual([...LEARNABLE_DIMENSIONS].sort())
  })

  it('preserves the baseline verbatim on every computation', () => {
    const result = computePursuitFeedback(balanced(40))
    expect(result.baselineWeights).toEqual({ ...DIMENSION_WEIGHTS })
  })
})

// -------------------------------------------------------------
// Absent evidence
// -------------------------------------------------------------

describe('absent evidence is absent, not zero', () => {
  it('leaves a dimension at its base weight when one side has too few scores', () => {
    // Drop geography from EVERY ignored record so the class falls below the minimum.
    const stripped = balanced(40).map((s) => {
      if (s.label !== 'IGNORED') return s
      const scores = { ...s.scores }
      delete scores.geography
      return { ...s, scores }
    })
    const result = computePursuitFeedback(stripped)
    const geo = result.dimensions.find((d) => d.dimension === 'geography')!
    expect(geo.delta).toBeNull()
    expect(geo.adjustedWeight).toBe(geo.baseWeight)
    expect(geo.explanation).toContain('Not assessed')
  })

  it('reports PARTIAL sufficiency when only some dimensions moved', () => {
    const stripped = balanced(40).map((s) => {
      if (s.label !== 'IGNORED') return s
      const scores = { ...s.scores }
      delete scores.vehicle
      return { ...s, scores }
    })
    expect(computePursuitFeedback(stripped).dataSufficiency).toBe('PARTIAL')
  })

  it('proposes no change when the firm prefers every dimension equally', () => {
    // A uniform contrast across all eight dimensions is no RELATIVE preference:
    // every weight scales by the same factor and renormalisation returns the
    // set to the base model. Preferring everything equally means preferring
    // nothing in particular, and the algorithm says so rather than inventing a
    // difference.
    const uniform = balanced(40)
    const result = computePursuitFeedback(uniform)
    expect(result.sufficient).toBe(true)
    expect(result.dimensions.every((d) => d.delta === 0.6)).toBe(true)
    for (const key of LEARNABLE_DIMENSIONS) {
      expect(result.proposedWeights[key]).toBeCloseTo(DIMENSION_WEIGHTS[key], 5)
    }
  })

  it('moves only the dimensions the firm actually differentiates on', () => {
    const uneven: LabelledSample[] = []
    for (let i = 0; i < 30; i++) {
      const pursued = i < 15
      const scores: LabelledSample['scores'] = {}
      for (const key of LEARNABLE_DIMENSIONS) scores[key] = 50
      scores.capability = pursued ? 90 : 20
      uneven.push({ opportunityId: `u-${String(i).padStart(3, '0')}`, label: pursued ? 'PURSUED' : 'IGNORED', basis: 'test', scores })
    }
    const result = computePursuitFeedback(uneven)
    const capability = result.dimensions.find((d) => d.dimension === 'capability')!
    const psc = result.dimensions.find((d) => d.dimension === 'psc')!

    expect(capability.proposedWeight).toBeGreaterThan(capability.baseWeight)
    // Everything else is relatively de-emphasised by renormalisation only.
    expect(psc.adjustedWeight).toBe(psc.baseWeight)
    expect(psc.proposedWeight).toBeLessThan(psc.baseWeight)
  })

  it('reports no preference when both classes score identically', () => {
    const flat: LabelledSample[] = [
      ...Array.from({ length: 15 }, (_, i) => sample(`p-${i}`, 'PURSUED', 50)),
      ...Array.from({ length: 15 }, (_, i) => sample(`i-${i}`, 'IGNORED', 50)),
    ]
    const result = computePursuitFeedback(flat)
    expect(result.dimensions.every((d) => d.delta === 0)).toBe(true)
    expect(result.proposedWeights).toEqual(baseWeights())
  })
})

// -------------------------------------------------------------
// Determinism
// -------------------------------------------------------------

describe('determinism', () => {
  it('produces an identical result for identical input', () => {
    const samples = balanced(40)
    expect(computePursuitFeedback(samples)).toEqual(computePursuitFeedback(samples))
  })

  it('produces an identical fingerprint for identical input', () => {
    const samples = balanced(40)
    expect(computeInputHash(samples, baseWeights())).toBe(computeInputHash(samples, baseWeights()))
  })

  it('changes the fingerprint when a label flips', () => {
    const samples = balanced(40)
    const flipped = samples.map((s, i) => (i === 0 ? { ...s, label: 'IGNORED' as const } : s))
    expect(computeInputHash(flipped, baseWeights())).not.toBe(computeInputHash(samples, baseWeights()))
  })

  it('changes the fingerprint when the baseline changes', () => {
    const samples = balanced(40)
    const other = { ...baseWeights(), naics: 0.25 }
    expect(computeInputHash(samples, other)).not.toBe(computeInputHash(samples, baseWeights()))
  })

  it('confidence rises with sample size and never claims more than the data supports', () => {
    expect(computePursuitFeedback(balanced(20)).confidenceState).toBe('LOW')
    expect(computePursuitFeedback(balanced(30)).confidenceState).toBe('MEDIUM')
    expect(computePursuitFeedback(balanced(60)).confidenceState).toBe('HIGH')
  })
})

// -------------------------------------------------------------
// Explanation honesty
// -------------------------------------------------------------

describe('explanations', () => {
  it('states the observed means and the bound rather than asserting a conclusion', () => {
    const result = computePursuitFeedback(balanced(40))
    const capability = result.dimensions.find((d) => d.dimension === 'capability')!
    expect(capability.explanation).toContain('80')
    expect(capability.explanation).toContain('20')
    expect(capability.explanation).toContain(`${Math.round(MAX_WEIGHT_ADJUSTMENT_PCT * 100)}%`)
  })

  it('says plainly that production matching is unchanged until applied', () => {
    expect(computePursuitFeedback(balanced(40)).summary).toContain('unchanged until an administrator applies it')
  })
})
