import { describe, it, expect } from 'vitest'
import { fitPlatt, applyPlatt } from './plattCalibration'
import type { LabeledPrediction } from './backtest/metrics'

function seededRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('fitPlatt', () => {
  it('returns null when fewer than 20 predictions', () => {
    const tiny: LabeledPrediction[] = Array(10)
      .fill(null)
      .map((_, i) => ({ predicted: i / 10, observed: i > 5 ? 1 : 0 }))
    expect(fitPlatt(tiny)).toBeNull()
  })

  it('returns null when all labels are the same (degenerate)', () => {
    const degenerate: LabeledPrediction[] = Array(50)
      .fill(null)
      .map((_, i) => ({ predicted: i / 50, observed: 0 }))
    expect(fitPlatt(degenerate)).toBeNull()
  })

  it('improves Brier score on an overconfident model', () => {
    // Model predicts in [0.4, 0.9] but true win rate is half that.
    const rng = seededRng(42)
    const data: LabeledPrediction[] = []
    for (let i = 0; i < 500; i++) {
      const p = 0.4 + rng() * 0.5
      const observed = rng() < p * 0.5 ? 1 : 0
      data.push({ predicted: p, observed })
    }
    const params = fitPlatt(data)
    expect(params).not.toBeNull()
    expect(params!.postBrier).toBeLessThan(params!.preBrier)
  })

  it('fits near-identity when model is already well-calibrated', () => {
    // Generate predictions where P(win) ≈ predicted score.
    const rng = seededRng(7)
    const data: LabeledPrediction[] = []
    for (let i = 0; i < 500; i++) {
      const p = rng()
      const observed = rng() < p ? 1 : 0
      data.push({ predicted: p, observed })
    }
    const params = fitPlatt(data)
    expect(params).not.toBeNull()
    // A should be close to 1 (scale) and B close to 0 (bias) for
    // a well-calibrated model. Allow generous tolerance since it's random.
    expect(params!.A).toBeGreaterThan(0.5)
    expect(params!.A).toBeLessThan(2.0)
    expect(Math.abs(params!.B)).toBeLessThan(1.0)
  })

  it('exposes sampleSize and fittedAt on the returned params', () => {
    const rng = seededRng(99)
    const data: LabeledPrediction[] = Array(100)
      .fill(null)
      .map(() => ({ predicted: rng(), observed: rng() < 0.5 ? 1 : 0 }))
    const params = fitPlatt(data)
    expect(params).not.toBeNull()
    expect(params!.sampleSize).toBe(100)
    expect(new Date(params!.fittedAt).getTime()).not.toBeNaN()
  })
})

describe('applyPlatt', () => {
  const identityParams = {
    A: 1,
    B: 0,
    fittedAt: '2026-06-06T00:00:00Z',
    sampleSize: 500,
    preBrier: 0.2,
    postBrier: 0.18,
  }

  it('A=1 B=0 is near-identity (logit round-trip)', () => {
    // σ(logit(p)) = p, so identity params should reproduce the input.
    expect(applyPlatt(0.3, identityParams)).toBeCloseTo(0.3, 4)
    expect(applyPlatt(0.7, identityParams)).toBeCloseTo(0.7, 4)
    expect(applyPlatt(0.5, identityParams)).toBeCloseTo(0.5, 4)
  })

  it('positive B shifts output upward', () => {
    const upward = { ...identityParams, A: 1, B: 1 }
    expect(applyPlatt(0.5, upward)).toBeGreaterThan(0.5)
    expect(applyPlatt(0.3, upward)).toBeGreaterThan(0.3)
  })

  it('negative B shifts output downward', () => {
    const downward = { ...identityParams, A: 1, B: -1 }
    expect(applyPlatt(0.5, downward)).toBeLessThan(0.5)
    expect(applyPlatt(0.7, downward)).toBeLessThan(0.7)
  })

  it('output stays in (0, 1) for extreme inputs', () => {
    expect(applyPlatt(0.0001, identityParams)).toBeGreaterThan(0)
    expect(applyPlatt(0.9999, identityParams)).toBeLessThan(1)
    expect(applyPlatt(0, identityParams)).toBeGreaterThan(0)
    expect(applyPlatt(1, identityParams)).toBeLessThan(1)
  })

  it('monotonically maps higher raw scores to higher calibrated scores (A > 0)', () => {
    const raws = [0.1, 0.2, 0.4, 0.6, 0.8, 0.9]
    const calibrated = raws.map((r) => applyPlatt(r, identityParams))
    for (let i = 1; i < calibrated.length; i++) {
      expect(calibrated[i]).toBeGreaterThan(calibrated[i - 1])
    }
  })
})
