// =============================================================
// Fit signal — an explainable, coarse tier derived from win-probability.
//
// FIXES.md FIX-1: the underlying probability is NOT yet calibrated against real
// WON/LOST outcomes (calibration collapsed real scores to ~0 and is disabled).
// A precise "72/100" implies an accuracy the model has not earned. Until a
// calibration backtest on real outcomes passes, present a 3-band signal
// (Strong / Moderate / Weak) plus the factor breakdown, and gate the raw number
// behind SHOW_NUMERIC_FIT_SCORE (default OFF). This is the honest surface.
// =============================================================

export type FitTier = 'STRONG' | 'MODERATE' | 'WEAK' | 'UNSCORED'

export interface FitSignal {
  tier: FitTier
  label: string
  description: string
}

// Provisional thresholds — tune once the score is calibrated. The point is the
// coarse, honest band, not a precise cutoff.
const STRONG_MIN = 0.55
const MODERATE_MIN = 0.3

export function scoreTier(probability: number | null | undefined): FitSignal {
  if (probability == null || Number.isNaN(probability)) {
    return {
      tier: 'UNSCORED',
      label: 'Not yet scored',
      description: 'This opportunity has not been scored for this client yet.',
    }
  }
  const p = Math.max(0, Math.min(1, probability))
  if (p >= STRONG_MIN) {
    return {
      tier: 'STRONG',
      label: 'Strong fit',
      description: 'Your profile aligns well with this opportunity on the factors below.',
    }
  }
  if (p >= MODERATE_MIN) {
    return {
      tier: 'MODERATE',
      label: 'Moderate fit',
      description: 'A workable fit with some gaps — review the factors below before committing.',
    }
  }
  return {
    tier: 'WEAK',
    label: 'Weak fit',
    description: 'Limited alignment on the factors below; likely a lower-priority pursuit.',
  }
}
