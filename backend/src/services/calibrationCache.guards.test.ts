// A curve must pass the same checks wherever it is applied. A live decision used
// to check only the Brier improvement, while a stored score also required enough
// samples and a recent fit, so the two could disagree about the same curve.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const findFirst = vi.fn()
vi.mock('../config/database', () => ({ prisma: { backtestRun: { findFirst: (...a: unknown[]) => findFirst(...a) } } }))

import { calibrateProbability, refreshCalibrationCache } from './calibrationCache'

const curve = (over: Record<string, unknown> = {}) => ({
  xs: [0, 1], ys: [0.9, 0.9], sampleSize: 500, preBrier: 0.3, postBrier: 0.2,
  fittedAt: new Date().toISOString(), ...over,
})
const load = (over: Record<string, unknown> = {}) => {
  findFirst.mockResolvedValue({ id: 'run', calibrationCurve: curve(over), completedAt: new Date() })
  return refreshCalibrationCache()
}

describe('calibrateProbability guards', () => {
  beforeEach(() => { process.env.ENABLE_PROBABILITY_CALIBRATION = 'true'; delete process.env.CALIBRATION_METHOD })
  afterEach(() => { delete process.env.ENABLE_PROBABILITY_CALIBRATION })

  it('applies a good, recent curve with enough samples', async () => {
    await load()
    expect(calibrateProbability(0.2)).toBeCloseTo(0.9)
  })

  it('ignores a curve with too few samples', async () => {
    await load({ sampleSize: 49 })
    expect(calibrateProbability(0.2)).toBe(0.2)
  })

  it('ignores a stale curve', async () => {
    await load({ fittedAt: new Date(Date.now() - 181 * 86_400_000).toISOString() })
    expect(calibrateProbability(0.2)).toBe(0.2)
  })

  it('ignores a curve that made calibration worse', async () => {
    await load({ preBrier: 0.2, postBrier: 0.3 })
    expect(calibrateProbability(0.2)).toBe(0.2)
  })
})
