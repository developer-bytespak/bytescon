// =============================================================
// Section 4 #6 — a fitted calibration curve must not report as "applied/active"
// unless the ENABLE_PROBABILITY_CALIBRATION flag is on (it only affects scores
// then). This is the honest-status derivation behind the AdminBacktest label.
// =============================================================
import { describe, it, expect } from 'vitest'
import { deriveCalibrationStatus } from './calibrationStatus'

describe('deriveCalibrationStatus', () => {
  it('nothing fitted → neither fitted nor applied, regardless of flag', () => {
    expect(deriveCalibrationStatus(false, false, false)).toEqual({ fitted: false, applied: false })
    expect(deriveCalibrationStatus(false, false, true)).toEqual({ fitted: false, applied: false })
  })

  it('curve fitted but flag OFF → fitted, NOT applied (the misleading case)', () => {
    expect(deriveCalibrationStatus(true, false, false)).toEqual({ fitted: true, applied: false })
  })

  it('curve fitted and flag ON → fitted AND applied', () => {
    expect(deriveCalibrationStatus(true, false, true)).toEqual({ fitted: true, applied: true })
  })

  it('platt fitted counts as fitted', () => {
    expect(deriveCalibrationStatus(false, true, false)).toEqual({ fitted: true, applied: false })
    expect(deriveCalibrationStatus(false, true, true)).toEqual({ fitted: true, applied: true })
  })
})
