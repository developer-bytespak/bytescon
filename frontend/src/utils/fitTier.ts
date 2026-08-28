// Mirror of backend utils/scoreTier — the honest fit signal (FIXES.md FIX-1).
// The win-probability is not yet calibrated on real WON/LOST outcomes, so the
// customer-facing surface is a coarse tier + factor breakdown, and the raw
// 0-100 number is shown only when the backend flag SHOW_NUMERIC_FIT_SCORE is on.

export type FitTier = 'STRONG' | 'MODERATE' | 'WEAK' | 'UNSCORED'

export function fitTier(probability: number | null | undefined): { tier: FitTier; label: string } {
  if (probability == null || Number.isNaN(probability)) return { tier: 'UNSCORED', label: 'Not yet scored' }
  const p = Math.max(0, Math.min(1, probability))
  if (p >= 0.55) return { tier: 'STRONG', label: 'Strong fit' }
  if (p >= 0.3) return { tier: 'MODERATE', label: 'Moderate fit' }
  return { tier: 'WEAK', label: 'Weak fit' }
}

/**
 * Customer-facing fit string. Honest tier by default; appends the raw 0-100 only
 * when `showNumeric` (the backend flag) is on.
 */
export function fitDisplay(probability: number | null | undefined, showNumeric = false): string {
  const t = fitTier(probability)
  if (t.tier === 'UNSCORED') return 'not yet scored'
  if (showNumeric && probability != null) {
    return `${t.label} · ${Math.round(Math.max(0, Math.min(1, probability)) * 100)}/100`
  }
  return t.label
}
