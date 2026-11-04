// B17 — a score is calibrated once, when read, never also when computed.
import { describe, it, expect, vi } from 'vitest'

const calibrate = vi.fn((p: number) => Math.min(1, p + 0.2))
vi.mock('../services/calibrationCache', () => ({ calibrateProbability: (p: number) => calibrate(p) }))

import { computeProbability } from './probabilityEngine'

const features: Parameters<typeof computeProbability>[0] = {
  naicsOverlapScore: 0.8, incumbentWeaknessScore: 0.5, documentAlignmentScore: 0.5, agencyAlignmentScore: 0.5,
  awardSizeFitScore: 0.5, competitionDensityScore: 0.5, agencyHistoryScore: 0.5, historicalDistribution: 0.5,
  deadlineUrgencyScore: 0.5,
}

describe('computeProbability', () => {
  it('returns the raw model output, with no calibration applied', () => {
    const result = computeProbability(features, 1000)
    expect(result.status).toBe('OK')
    if (result.status !== 'OK') return
    const raw = 1 / (1 + Math.exp(-(6 * result.rawScore - 3)))
    expect(result.probability).toBeCloseTo(raw, 6)
    expect(calibrate).not.toHaveBeenCalled()
  })
})
