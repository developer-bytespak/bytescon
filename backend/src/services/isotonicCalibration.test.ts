import { describe, it, expect } from 'vitest'
import { fitIsotonic, applyIsotonic, applyIsotonicBatch } from './isotonicCalibration'
import type { LabeledPrediction } from './backtest/metrics'

function seededRng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

describe('fitIsotonic', () => {
  it('returns null when fewer than 20 predictions', () => {
    const tiny: LabeledPrediction[] = Array(10).fill(null).map((_, i) => ({
      predicted: i / 10, observed: i > 5 ? 1 : 0,
    }))
    expect(fitIsotonic(tiny)).toBeNull()
  })

  it('produces a monotonic non-decreasing curve', () => {
    const rng = seededRng(1)
    const data: LabeledPrediction[] = []
    for (let i = 0; i < 200; i++) {
      const p = rng()
      // True rate is p+noise; threshold at p > 0.5 + noise
      const observed = rng() < p ? 1 : 0
      data.push({ predicted: p, observed })
    }
    const curve = fitIsotonic(data)
    expect(curve).not.toBeNull()
    for (let i = 1; i < curve!.ys.length; i++) {
      expect(curve!.ys[i]).toBeGreaterThanOrEqual(curve!.ys[i - 1])
    }
  })

  it('improves Brier score for a miscalibrated model (overconfident-positive)', () => {
    // Simulate: model predicts uniformly in [0.3, 0.9] but true rate is lower.
    const rng = seededRng(2)
    const data: LabeledPrediction[] = []
    for (let i = 0; i < 400; i++) {
      const p = 0.3 + rng() * 0.6
      // True win rate = p * 0.5 (model overconfident by 2x)
      const observed = rng() < p * 0.5 ? 1 : 0
      data.push({ predicted: p, observed })
    }
    const curve = fitIsotonic(data)
    expect(curve).not.toBeNull()
    expect(curve!.postBrier).toBeLessThan(curve!.preBrier)
  })

  it('flattens when input is pure noise (no signal)', () => {
    // Random labels uncorrelated with predicted.
    const rng = seededRng(3)
    const data: LabeledPrediction[] = []
    for (let i = 0; i < 200; i++) {
      data.push({ predicted: rng(), observed: rng() < 0.5 ? 1 : 0 })
    }
    const curve = fitIsotonic(data)
    expect(curve).not.toBeNull()
    // ys should all be very close to base rate ~0.5; spread should be small
    const yMax = Math.max(...curve!.ys)
    const yMin = Math.min(...curve!.ys)
    expect(yMax - yMin).toBeLessThan(0.5)
  })
})

describe('applyIsotonic', () => {
  const curve = {
    xs: [0.1, 0.3, 0.5, 0.7, 0.9],
    ys: [0.05, 0.2, 0.5, 0.8, 0.95],
    fittedAt: '2026-05-28T00:00:00Z',
    sampleSize: 100,
    preBrier: 0.25,
    postBrier: 0.18,
  }

  it('returns first y for inputs below curve range', () => {
    expect(applyIsotonic(0.0, curve)).toBe(0.05)
    expect(applyIsotonic(-0.5, curve)).toBe(0.05)
  })

  it('returns last y for inputs above curve range', () => {
    expect(applyIsotonic(1.0, curve)).toBe(0.95)
    expect(applyIsotonic(2.0, curve)).toBe(0.95)
  })

  it('hits exact breakpoints', () => {
    expect(applyIsotonic(0.1, curve)).toBe(0.05)
    expect(applyIsotonic(0.5, curve)).toBe(0.5)
    expect(applyIsotonic(0.9, curve)).toBe(0.95)
  })

  it('linearly interpolates between breakpoints', () => {
    // midpoint between (0.3, 0.2) and (0.5, 0.5) is (0.4, 0.35)
    expect(applyIsotonic(0.4, curve)).toBeCloseTo(0.35, 6)
    // 75% of way from (0.5, 0.5) to (0.7, 0.8) is (0.65, 0.725)
    expect(applyIsotonic(0.65, curve)).toBeCloseTo(0.725, 6)
  })

  it('handles single-breakpoint curve gracefully', () => {
    const flat = { ...curve, xs: [0.5], ys: [0.6] }
    expect(applyIsotonic(0.0, flat)).toBe(0.6)
    expect(applyIsotonic(0.5, flat)).toBe(0.6)
    expect(applyIsotonic(1.0, flat)).toBe(0.6)
  })

  it('handles empty curve gracefully (returns raw)', () => {
    const empty = { ...curve, xs: [], ys: [] }
    expect(applyIsotonic(0.42, empty)).toBe(0.42)
  })
})

describe('applyIsotonicBatch', () => {
  it('applies curve to every prediction in input', () => {
    const curve = {
      xs: [0.0, 1.0],
      ys: [0.0, 0.5],
      fittedAt: '2026-05-28T00:00:00Z',
      sampleSize: 100,
      preBrier: 0,
      postBrier: 0,
    }
    const input: LabeledPrediction[] = [
      { predicted: 0.0, observed: 1 },
      { predicted: 1.0, observed: 0 },
      { predicted: 0.5, observed: 1 },
    ]
    const out = applyIsotonicBatch(input, curve)
    expect(out[0].predicted).toBeCloseTo(0.0, 6)
    expect(out[1].predicted).toBeCloseTo(0.5, 6)
    expect(out[2].predicted).toBeCloseTo(0.25, 6)
    // Observed labels preserved.
    expect(out.map((p) => p.observed)).toEqual([1, 0, 1])
  })
})
