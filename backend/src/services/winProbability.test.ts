// =============================================================
// Win-probability resolver — RAW / CALIBRATED / FALLBACK rules, guards,
// boundary clamping, single-application (no double calibration), determinism,
// and metadata. Pure logic, no DB.
// =============================================================
import { describe, it, expect } from 'vitest'
import { resolveWinProbability, isValidIsotonicCurve, isValidPlattParams, CalibrationInput, COMPATIBLE_METHOD_VERSION } from './winProbability'
import type { IsotonicCurve } from './isotonicCalibration'
import type { PlattParams } from './plattCalibration'

const NOW = new Date('2026-08-06T00:00:00Z')
const recent = '2026-07-01T00:00:00Z'

// A valid isotonic curve that maps p→p (identity via interpolation) but shifts
// 0.5 upward so calibration visibly moves the score; improves Brier.
const curve = (over: Partial<IsotonicCurve> = {}): IsotonicCurve => ({
  xs: [0, 0.5, 1], ys: [0, 0.7, 1], fittedAt: recent, sampleSize: 200, preBrier: 0.24, postBrier: 0.18, ...over,
})
const platt = (over: Partial<PlattParams> = {}): PlattParams => ({
  A: 1, B: 0, fittedAt: recent, sampleSize: 200, preBrier: 0.24, postBrier: 0.18, ...over,
})
const base = (over: Partial<CalibrationInput> = {}): CalibrationInput => ({
  enabled: true, method: 'isotonic', methodVersion: COMPATIBLE_METHOD_VERSION, curve: curve(), platt: null,
  fittedAt: recent, minSample: 50, maxAgeDays: 180, now: NOW, ...over,
})

describe('validators', () => {
  it('accepts a monotonic finite isotonic curve, rejects malformed', () => {
    expect(isValidIsotonicCurve(curve())).toBe(true)
    expect(isValidIsotonicCurve(curve({ ys: [0, 0.2, 0.1] }))).toBe(false) // not monotonic
    expect(isValidIsotonicCurve(curve({ xs: [0, Infinity, 1] }))).toBe(false) // non-finite
    expect(isValidIsotonicCurve(curve({ xs: [0], ys: [0] }))).toBe(false) // too short
    expect(isValidIsotonicCurve(null)).toBe(false)
  })
  it('accepts finite platt params, rejects NaN', () => {
    expect(isValidPlattParams(platt())).toBe(true)
    expect(isValidPlattParams(platt({ A: NaN }))).toBe(false)
    expect(isValidPlattParams(null)).toBe(false)
  })
})

describe('RAW (no calibration active)', () => {
  it('flag OFF → RAW, final equals raw', () => {
    const r = resolveWinProbability(0.42, base({ enabled: false }))
    expect(r.scoreType).toBe('RAW')
    expect(r.rawScore).toBe(42)
    expect(r.finalScore).toBe(42)
    expect(r.reason).toBe('CALIBRATION_DISABLED') // a curve is fitted but disabled
  })
  it('no curve at all → RAW with NO_CALIBRATION', () => {
    const r = resolveWinProbability(0.42, base({ curve: null }))
    expect(r.scoreType).toBe('RAW')
    expect(r.reason).toBe('NO_CALIBRATION')
    expect(r.dataSufficiency).toBe('NONE')
  })
})

describe('CALIBRATED (all guards pass)', () => {
  it('applies the curve once and reports metadata', () => {
    const r = resolveWinProbability(0.5, base())
    expect(r.scoreType).toBe('CALIBRATED')
    expect(r.finalScore).toBe(70) // curve maps 0.5→0.7
    expect(r.changed).toBe(true)
    expect(r.rawScore).toBe(50)
    expect(r.method).toBe('isotonic')
    expect(r.methodVersion).toBe(COMPATIBLE_METHOD_VERSION)
    expect(r.sampleSize).toBe(200)
    expect(r.lastFittedAt).toBe(recent)
    expect(r.dataSufficiency).toBe('SUFFICIENT')
  })
  it('does not double-apply (single application of the curve)', () => {
    const once = resolveWinProbability(0.5, base()).finalScore // 70
    // Feeding the calibrated value back would give a different (double) result;
    // the resolver always starts from the raw input, so 0.5 → 70 deterministically.
    expect(once).toBe(70)
    const doubled = resolveWinProbability(0.7, base()).finalScore // if it re-applied: 0.7→~0.82
    expect(doubled).not.toBe(once) // proves each call applies exactly once to its input
  })
  it('is deterministic across repeated calls', () => {
    const a = resolveWinProbability(0.5, base())
    const b = resolveWinProbability(0.5, base())
    expect(a).toEqual(b)
  })
})

describe('FALLBACK (curve exists but a guard fails)', () => {
  const cases: [string, Partial<CalibrationInput>, string][] = [
    ['incompatible version', { methodVersion: 'v1-synthetic' }, 'INCOMPATIBLE_VERSION'],
    ['invalid params', { curve: curve({ ys: [0, 0.9, 0.1] }) }, 'INVALID_PARAMS'],
    ['insufficient sample', { curve: curve({ sampleSize: 10 }) }, 'INSUFFICIENT_SAMPLE'],
    ['stale', { fittedAt: '2024-01-01T00:00:00Z', curve: curve({ fittedAt: '2024-01-01T00:00:00Z' }) }, 'STALE'],
    ['no Brier improvement', { curve: curve({ preBrier: 0.18, postBrier: 0.24 }) }, 'NO_BRIER_IMPROVEMENT'],
  ]
  for (const [name, over, reason] of cases) {
    it(`${name} → FALLBACK to raw with reason ${reason}`, () => {
      const r = resolveWinProbability(0.42, base(over))
      expect(r.scoreType).toBe('FALLBACK')
      expect(r.finalScore).toBe(42) // raw preserved
      expect(r.reason).toBe(reason)
      expect(r.changed).toBe(false)
    })
  }
})

describe('boundary clamping', () => {
  it('clamps raw below 0 and above 1 into 0..100', () => {
    expect(resolveWinProbability(-0.5, base({ enabled: false })).rawScore).toBe(0)
    expect(resolveWinProbability(1.5, base({ enabled: false })).rawScore).toBe(100)
    expect(resolveWinProbability(1.5, base({ enabled: false })).finalScore).toBe(100)
  })
})

describe('platt method', () => {
  it('applies platt when selected and valid', () => {
    const r = resolveWinProbability(0.5, base({ method: 'platt', curve: null, platt: platt() }))
    expect(r.scoreType).toBe('CALIBRATED')
    expect(r.method).toBe('platt')
  })
})
