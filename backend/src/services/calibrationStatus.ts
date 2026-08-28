// =============================================================
// Calibration status derivation (Section 4 #6)
//
// Separates two states the UI previously conflated:
//   - fitted:  a calibration curve has been computed and cached
//   - applied: that curve is actually adjusting production win-probabilities,
//              which only happens when ENABLE_PROBABILITY_CALIBRATION is on
//
// Pure + dependency-free so the truth table is trivially unit-testable.
// =============================================================

export interface CalibrationStatusFlags {
  fitted: boolean
  applied: boolean
}

export function deriveCalibrationStatus(
  hasCurve: boolean,
  hasPlatt: boolean,
  flagOn: boolean,
): CalibrationStatusFlags {
  const fitted = hasCurve || hasPlatt
  return { fitted, applied: fitted && flagOn }
}
