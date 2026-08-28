// =============================================================
// Who-Wins — set-aside bucketing.
//
// Two vocabularies map into one bucket space:
//   1. FPDS type_of_set_aside_code (training data, e.g. SDVOSBC, HZC, 8A)
//   2. The app's canonical opportunity.setAsideType (from samApi.ts, e.g.
//      SDVOSB, HUBZONE, SBA_8A)
// Buckets keep segments dense enough to estimate while preserving the
// competition-structure differences that matter (sole-source variants are
// already excluded upstream by the extent_competed filter).
// =============================================================

export type SetAsideBucket =
  | 'NONE'
  | 'SMALL_BUSINESS'
  | 'SDVOSB'
  | 'WOSB'
  | 'HUBZONE'
  | 'SBA_8A'
  | 'OTHER'

export const SET_ASIDE_BUCKETS: SetAsideBucket[] = [
  'NONE', 'SMALL_BUSINESS', 'SDVOSB', 'WOSB', 'HUBZONE', 'SBA_8A', 'OTHER',
]

/** FPDS type_of_set_aside_code → bucket (training-data side). */
export function bucketFromFpdsCode(code: string | null | undefined): SetAsideBucket {
  const c = (code ?? '').trim().toUpperCase()
  if (!c || c === 'NONE') return 'NONE'
  if (c === 'SBA' || c === 'SBP' || c === 'ESB' || c === 'RSB') return 'SMALL_BUSINESS'
  if (c.startsWith('SDVOSB') || c === 'VSA' || c === 'VSS') return 'SDVOSB'
  if (c.startsWith('WOSB') || c.startsWith('EDWOSB')) return 'WOSB'
  if (c === 'HZC' || c === 'HZS') return 'HUBZONE'
  if (c === '8A' || c === '8AN' || c === 'HS3') return 'SBA_8A'
  return 'OTHER' // ISBEE, IEE, LAS, BI, ...
}

/** App-canonical opportunity.setAsideType → bucket (scoring side). */
export function bucketFromOpportunitySetAside(setAsideType: string | null | undefined): SetAsideBucket {
  const s = (setAsideType ?? '').trim().toUpperCase()
  if (!s || s === 'NONE') return 'NONE'
  if (s === 'SMALL_BUSINESS' || s === 'TOTAL_SMALL_BUSINESS') return 'SMALL_BUSINESS'
  if (s === 'SDVOSB' || s === 'VOSB') return 'SDVOSB'
  if (s === 'WOSB' || s === 'EDWOSB') return 'WOSB'
  if (s === 'HUBZONE') return 'HUBZONE'
  if (s === 'SBA_8A') return 'SBA_8A'
  return 'OTHER' // INDIAN, LOCAL_AREA, ...
}
