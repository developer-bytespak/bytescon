// =============================================================
// §7.9 — the intelligence engines, with no database and no provider.
//
// These pin the honesty rules the whole slice rests on: a bid decision is not
// an outcome, pending never enters the denominator, below the minimum sample
// no rate exists at all, one procurement counts once, and an unmeasurable
// segment is never ranked above a measured one.
// =============================================================
import { describe, it, expect } from 'vitest'
import { computeEMA, detectDirection } from '../../trendAnalysis'
import { wilsonInterval } from '../../scoring/confidenceInterval'
import { hhi } from '../../scoring/portfolioValue'
import {
  analyseWinLoss,
  analyseOutcomeTrend,
  buildSegment,
  dedupeOutcomes,
  declineEscalationReason,
  valueBandFor,
  MIN_WIN_LOSS_SAMPLE_SIZE,
  MIN_TREND_PERIODS,
  CONFIRMED_OUTCOMES,
  NON_CONTEST_OUTCOMES,
  VALUE_BANDS,
  UNKNOWN_KEY,
  type OutcomeObservation,
} from './winLossAnalysis'
import {
  scoreSegment,
  rankRecommendations,
  buildRationale,
  CAPACITY_MULTIPLIER,
  TREND_MULTIPLIER,
  MAX_RECOMMENDATIONS,
  type CaptureInput,
} from './captureFocus'
import {
  buildRoadmap,
  canonicalGapKey,
  CATEGORY_SEVERITY,
  MIN_RECURRENCE,
  type GapObservation,
} from './capabilityRoadmap'

const DAY = 86_400_000
const NOW = new Date('2026-08-12T12:00:00.000Z')
const PERIOD_START = new Date('2024-08-12T00:00:00.000Z')

const obs = (over: Partial<OutcomeObservation> = {}): OutcomeObservation => ({
  outcomeId: `o-${Math.random().toString(36).slice(2, 8)}`,
  pursuitKey: `opp-${Math.random().toString(36).slice(2, 8)}`,
  outcome: 'WON',
  recordedAt: new Date('2026-06-01T00:00:00.000Z'),
  submittedAt: new Date('2026-03-01T00:00:00.000Z'),
  agency: 'Department of Defense',
  naicsCode: '541512',
  contractVehicle: 'GSA MAS',
  setAside: 'SDVOSB',
  estimatedValue: 500_000,
  ...over,
})

const many = (n: number, over: Partial<OutcomeObservation> = {}) =>
  Array.from({ length: n }, (_, i) => obs({ outcomeId: `o${i}`, pursuitKey: `opp${i}`, ...over }))

const analyse = (observations: OutcomeObservation[]) =>
  analyseWinLoss({ observations, periodStart: PERIOD_START, periodEnd: NOW })

// =============================================================
// What counts as an outcome
// =============================================================

describe('outcome truth', () => {
  it('counts only WON and LOST as confirmed outcomes', () => {
    expect(CONFIRMED_OUTCOMES).toEqual(['WON', 'LOST'])
  })

  it('treats NO_AWARD and WITHDRAWN as no contest, not as losses', () => {
    expect(NON_CONTEST_OUTCOMES).toEqual(['NO_AWARD', 'WITHDRAWN'])
    const r = analyse([
      ...many(4, { outcome: 'WON' }),
      ...many(4, { outcome: 'LOST' }).map((o, i) => ({ ...o, outcomeId: `l${i}`, pursuitKey: `lp${i}` })),
      obs({ outcomeId: 'na', pursuitKey: 'nap', outcome: 'NO_AWARD' }),
      obs({ outcomeId: 'wd', pursuitKey: 'wdp', outcome: 'WITHDRAWN' }),
    ])
    expect(r.overall.wins).toBe(4)
    expect(r.overall.losses).toBe(4)
    expect(r.nonContestExcluded).toBe(2)
    expect(r.limitations.join(' ')).toContain('No contest was decided')
  })

  it('reports a submitted pursuit with no outcome as pending, never as a loss', () => {
    const r = analyse([obs({ outcome: null }), obs({ outcome: null, outcomeId: 'p2', pursuitKey: 'pp2' })])
    expect(r.overall.pending).toBe(2)
    expect(r.overall.losses).toBe(0)
    expect(r.overall.sampleSize).toBe(0)
  })

  it('excludes pending from the denominator — 5W/5L/10P is a sample of ten', () => {
    const r = analyse([
      ...many(5, { outcome: 'WON' }).map((o, i) => ({ ...o, outcomeId: `w${i}`, pursuitKey: `wp${i}` })),
      ...many(5, { outcome: 'LOST' }).map((o, i) => ({ ...o, outcomeId: `l${i}`, pursuitKey: `lp${i}` })),
      ...many(10, { outcome: null }).map((o, i) => ({ ...o, outcomeId: `p${i}`, pursuitKey: `pp${i}` })),
    ])
    expect(r.overall.sampleSize).toBe(10)
    expect(r.overall.pending).toBe(10)
    expect(r.overall.winRate).toBe(0.5)
  })
})

// =============================================================
// The sample gate
// =============================================================

describe('minimum sample policy', () => {
  it('reuses the platform-wide minimum of 8', () => {
    expect(MIN_WIN_LOSS_SAMPLE_SIZE).toBe(8)
  })

  it('reports no outcomes at all as INSUFFICIENT_DATA with no rate', () => {
    const r = analyse([])
    expect(r.overall.sampleSize).toBe(0)
    expect(r.overall.winRate).toBeNull()
    expect(r.overall.dataSufficiency).toBe('INSUFFICIENT_DATA')
  })

  it('reports no rate one below the minimum', () => {
    const r = analyse(many(MIN_WIN_LOSS_SAMPLE_SIZE - 1, { outcome: 'WON' }))
    expect(r.overall.sampleSize).toBe(7)
    expect(r.overall.winRate).toBeNull()
    expect(r.overall.intervalLower).toBeNull()
    expect(r.overall.intervalUpper).toBeNull()
    expect(r.overall.dataSufficiency).toBe('PARTIAL')
  })

  it('reports a rate at exactly the minimum', () => {
    const r = analyse(many(MIN_WIN_LOSS_SAMPLE_SIZE, { outcome: 'WON' }))
    expect(r.overall.sampleSize).toBe(8)
    expect(r.overall.winRate).toBe(1)
    expect(r.overall.dataSufficiency).toBe('SUFFICIENT')
  })

  it('still reports a rate one above the minimum', () => {
    const r = analyse(many(MIN_WIN_LOSS_SAMPLE_SIZE + 1, { outcome: 'LOST' }))
    expect(r.overall.sampleSize).toBe(9)
    expect(r.overall.winRate).toBe(0)
    expect(r.overall.dataSufficiency).toBe('SUFFICIENT')
  })

  it('never reports 0% as a placeholder for an unmeasured segment', () => {
    const r = analyse([obs({ outcome: 'LOST' })])
    expect(r.overall.winRate).toBeNull()
    expect(r.overall.winRate).not.toBe(0)
  })

  it('says exactly how many more outcomes are needed', () => {
    const r = analyse(many(3, { outcome: 'WON' }))
    expect(r.overall.limitations.join(' ')).toContain('5 more confirmed outcome(s) needed')
  })
})

// =============================================================
// Wilson
// =============================================================

describe('Wilson interval', () => {
  it('uses the canonical implementation, not a second formula', () => {
    const r = analyse([
      ...many(5, { outcome: 'WON' }).map((o, i) => ({ ...o, outcomeId: `w${i}`, pursuitKey: `wp${i}` })),
      ...many(5, { outcome: 'LOST' }).map((o, i) => ({ ...o, outcomeId: `l${i}`, pursuitKey: `lp${i}` })),
    ])
    const canonical = wilsonInterval(5, 10)!
    expect(r.overall.intervalLower).toBe(Number(canonical.low.toFixed(5)))
    expect(r.overall.intervalUpper).toBe(Number(canonical.high.toFixed(5)))
  })

  it('brackets the point estimate', () => {
    const r = analyse([
      ...many(6, { outcome: 'WON' }).map((o, i) => ({ ...o, outcomeId: `w${i}`, pursuitKey: `wp${i}` })),
      ...many(4, { outcome: 'LOST' }).map((o, i) => ({ ...o, outcomeId: `l${i}`, pursuitKey: `lp${i}` })),
    ])
    expect(r.overall.intervalLower!).toBeLessThan(r.overall.winRate!)
    expect(r.overall.intervalUpper!).toBeGreaterThan(r.overall.winRate!)
  })

  it('keeps 0/n and n/n inside [0,1]', () => {
    const allLost = analyse(many(10, { outcome: 'LOST' }))
    expect(allLost.overall.intervalLower).toBe(0)
    expect(allLost.overall.intervalUpper!).toBeGreaterThan(0)
    const allWon = analyse(many(10, { outcome: 'WON' }))
    expect(allWon.overall.intervalUpper).toBe(1)
    expect(allWon.overall.intervalLower!).toBeLessThan(1)
  })

  it('narrows as the sample grows', () => {
    const small = analyse([
      ...many(4, { outcome: 'WON' }).map((o, i) => ({ ...o, outcomeId: `w${i}`, pursuitKey: `wp${i}` })),
      ...many(4, { outcome: 'LOST' }).map((o, i) => ({ ...o, outcomeId: `l${i}`, pursuitKey: `lp${i}` })),
    ])
    const large = analyse([
      ...many(50, { outcome: 'WON' }).map((o, i) => ({ ...o, outcomeId: `W${i}`, pursuitKey: `WP${i}` })),
      ...many(50, { outcome: 'LOST' }).map((o, i) => ({ ...o, outcomeId: `L${i}`, pursuitKey: `LP${i}` })),
    ])
    const width = (s: typeof small) => s.overall.intervalUpper! - s.overall.intervalLower!
    expect(width(large)).toBeLessThan(width(small))
  })

  it('reports no interval below the minimum even though the maths would run', () => {
    expect(wilsonInterval(1, 1)).not.toBeNull()
    expect(analyse([obs({ outcome: 'WON' })]).overall.intervalLower).toBeNull()
  })
})

// =============================================================
// Deduplication
// =============================================================

describe('outcome deduplication', () => {
  it('counts one procurement once even when several records describe it', () => {
    const { unique, collapsed } = dedupeOutcomes([
      obs({ outcomeId: 'a', pursuitKey: 'same-opp', outcome: 'WON' }),
      obs({ outcomeId: 'b', pursuitKey: 'same-opp', outcome: 'WON' }),
      obs({ outcomeId: 'c', pursuitKey: 'same-opp', outcome: 'WON' }),
    ])
    expect(unique).toHaveLength(1)
    expect(collapsed).toBe(2)
  })

  it('prefers a decided record over a pending one for the same contest', () => {
    const { unique } = dedupeOutcomes([
      obs({ outcomeId: 'pending', pursuitKey: 'k', outcome: null }),
      obs({ outcomeId: 'decided', pursuitKey: 'k', outcome: 'WON' }),
    ])
    expect(unique[0].outcomeId).toBe('decided')
  })

  it('prefers the later correction when both are decided', () => {
    const { unique } = dedupeOutcomes([
      obs({ outcomeId: 'old', pursuitKey: 'k', outcome: 'WON', recordedAt: new Date('2026-01-01') }),
      obs({ outcomeId: 'corrected', pursuitKey: 'k', outcome: 'LOST', recordedAt: new Date('2026-06-01') }),
    ])
    expect(unique[0].outcomeId).toBe('corrected')
    expect(unique[0].outcome).toBe('LOST')
  })

  it('keeps genuinely different contests apart', () => {
    const { unique, collapsed } = dedupeOutcomes([obs({ pursuitKey: 'a' }), obs({ pursuitKey: 'b' })])
    expect(unique).toHaveLength(2)
    expect(collapsed).toBe(0)
  })

  it('reports the collapse so the sample is never silently reduced', () => {
    const r = analyse([
      obs({ outcomeId: 'a', pursuitKey: 'dup', outcome: 'WON' }),
      obs({ outcomeId: 'b', pursuitKey: 'dup', outcome: 'WON' }),
    ])
    expect(r.duplicatesCollapsed).toBe(1)
    expect(r.limitations.join(' ')).toContain('no contest is counted twice')
  })
})

// =============================================================
// Segments
// =============================================================

describe('segmentation', () => {
  const mixed = () => [
    ...many(8, { outcome: 'WON', agency: 'DoD', naicsCode: '541512' }).map((o, i) => ({ ...o, outcomeId: `w${i}`, pursuitKey: `wp${i}` })),
    ...many(2, { outcome: 'LOST', agency: 'DHS', naicsCode: '541519' }).map((o, i) => ({ ...o, outcomeId: `l${i}`, pursuitKey: `lp${i}` })),
  ]

  it('measures a sufficient agency and only counts an insufficient one', () => {
    const r = analyse(mixed())
    const dod = r.agencies.find((a) => a.segmentKey === 'DoD')!
    const dhs = r.agencies.find((a) => a.segmentKey === 'DHS')!
    expect(dod.dataSufficiency).toBe('SUFFICIENT')
    expect(dod.winRate).toBe(1)
    expect(dhs.dataSufficiency).toBe('PARTIAL')
    expect(dhs.winRate).toBeNull()
    expect(dhs.losses).toBe(2)
  })

  it('never ranks an insufficient segment above a measured one', () => {
    const r = analyse(mixed())
    expect(r.agencies[0].segmentKey).toBe('DoD')
  })

  it('groups a missing dimension as unknown rather than guessing', () => {
    const r = analyse(many(3, { agency: null, naicsCode: null, contractVehicle: null, setAside: null }))
    expect(r.agencies[0].segmentKey).toBe(UNKNOWN_KEY)
    expect(r.naics[0].segmentKey).toBe(UNKNOWN_KEY)
    expect(r.vehicles[0].segmentKey).toBe(UNKNOWN_KEY)
    expect(r.setAsides[0].segmentKey).toBe(UNKNOWN_KEY)
    expect(r.agencies[0].limitations.join(' ')).toContain('not recorded')
  })

  it('segments across every required dimension', () => {
    const r = analyse(mixed())
    expect(r.agencies.length).toBeGreaterThan(0)
    expect(r.naics.length).toBeGreaterThan(0)
    expect(r.vehicles.length).toBeGreaterThan(0)
    expect(r.setAsides.length).toBeGreaterThan(0)
    expect(r.valueBands.length).toBeGreaterThan(0)
  })

  it('does not double count one outcome inside a single dimension', () => {
    const r = analyse(mixed())
    const total = r.agencies.reduce((s, a) => s + a.sampleSize, 0)
    expect(total).toBe(r.overall.sampleSize)
  })

  it('records the source outcome ids so a reader can verify', () => {
    const r = analyse(many(8, { outcome: 'WON' }))
    expect(r.overall.sourceOutcomeIds).toHaveLength(8)
  })
})

// =============================================================
// Value bands
// =============================================================

describe('value bands', () => {
  it.each([
    [0, 'UNDER_250K'], [249_999, 'UNDER_250K'], [250_000, '250K_1M'], [999_999, '250K_1M'],
    [1_000_000, '1M_5M'], [4_999_999, '1M_5M'], [5_000_000, '5M_25M'], [24_999_999, '5M_25M'],
    [25_000_000, 'OVER_25M'], [100_000_000, 'OVER_25M'],
  ])('places %i in %s', (value, key) => {
    expect(valueBandFor(value).key).toBe(key)
  })

  it('never classifies a missing value as $0', () => {
    expect(valueBandFor(null).key).toBe('UNKNOWN_VALUE')
    expect(valueBandFor(undefined).key).toBe('UNKNOWN_VALUE')
    expect(valueBandFor(null).key).not.toBe('UNDER_250K')
  })

  it('defines exactly five bands plus unknown', () => {
    expect(VALUE_BANDS).toHaveLength(5)
  })
})

// =============================================================
// HHI
// =============================================================

describe('concentration', () => {
  it('uses the canonical implementation', () => {
    expect(hhi([100])).toBe(1)
    expect(hhi([50, 50])).toBe(0.5)
    expect(hhi([25, 25, 25, 25])).toBe(0.25)
  })

  it('reports a dominant segment as concentrated', () => {
    expect(hhi([900, 50, 50])!).toBeGreaterThan(0.25)
  })

  it('returns null when there is nothing to measure', () => {
    expect(hhi([])).toBeNull()
    expect(hhi([0, 0])).toBeNull()
  })
})

// =============================================================
// Trend
// =============================================================

describe('outcome trend', () => {
  const quarterly = (specs: Array<{ date: string; wins: number; losses: number }>) =>
    specs.flatMap(({ date, wins, losses }, qi) => [
      ...Array.from({ length: wins }, (_, i) => obs({ outcomeId: `q${qi}w${i}`, pursuitKey: `q${qi}wp${i}`, outcome: 'WON', recordedAt: new Date(date) })),
      ...Array.from({ length: losses }, (_, i) => obs({ outcomeId: `q${qi}l${i}`, pursuitKey: `q${qi}lp${i}`, outcome: 'LOST', recordedAt: new Date(date) })),
    ])

  const trend = (o: OutcomeObservation[]) => analyseOutcomeTrend(o, computeEMA, detectDirection)

  it('states no trend below the minimum period count', () => {
    const t = trend(quarterly([{ date: '2026-01-15', wins: 6, losses: 2 }]))
    expect(t.state).toBe('INSUFFICIENT_DATA')
    expect(t.limitations.join(' ')).toContain(`${MIN_TREND_PERIODS} are required`)
  })

  it('ignores a quarter whose sample is below the minimum', () => {
    const t = trend(quarterly([
      { date: '2025-02-15', wins: 1, losses: 1 },
      { date: '2025-05-15', wins: 6, losses: 2 },
      { date: '2025-08-15', wins: 5, losses: 3 },
    ]))
    expect(t.periodsWithSufficientSample).toBe(2)
    expect(t.state).toBe('INSUFFICIENT_DATA')
  })

  it('detects a sustained decline across three qualifying quarters', () => {
    const t = trend(quarterly([
      { date: '2025-02-15', wins: 8, losses: 0 },
      { date: '2025-05-15', wins: 5, losses: 3 },
      { date: '2025-08-15', wins: 2, losses: 6 },
      { date: '2025-11-15', wins: 1, losses: 7 },
    ]))
    expect(t.state).toBe('DECLINING')
    expect(t.consecutiveDecline).toBe(true)
  })

  it('does not call one noisy quarter a decline', () => {
    const t = trend(quarterly([
      { date: '2025-02-15', wins: 4, losses: 4 },
      { date: '2025-05-15', wins: 2, losses: 6 },
      { date: '2025-08-15', wins: 4, losses: 4 },
    ]))
    expect(t.consecutiveDecline).toBe(false)
  })

  it('detects improvement', () => {
    const t = trend(quarterly([
      { date: '2025-02-15', wins: 1, losses: 7 },
      { date: '2025-05-15', wins: 4, losses: 4 },
      { date: '2025-08-15', wins: 7, losses: 1 },
    ]))
    expect(t.state).toBe('IMPROVING')
  })

  it('reports the numbers and no diagnosis in the decline wording', () => {
    const t = trend(quarterly([
      { date: '2025-02-15', wins: 8, losses: 0 },
      { date: '2025-05-15', wins: 5, losses: 3 },
      { date: '2025-08-15', wins: 2, losses: 6 },
    ]))
    const overall = analyse(quarterly([{ date: '2025-08-15', wins: 8, losses: 2 }])).overall
    const reason = declineEscalationReason(t, overall)
    expect(reason).toContain('consecutive quarters')
    expect(reason).toContain('changed no decision, weight or pursuit')
    expect(reason).not.toMatch(/because|caused by|due to poor/i)
  })
})

// =============================================================
// Capture focus
// =============================================================

describe('capture focus', () => {
  const measured = (over: Partial<CaptureInput> = {}): CaptureInput => ({
    segment: buildSegment('AGENCY', 'DoD', 'Department of Defense', [
      ...many(6, { outcome: 'WON' }).map((o, i) => ({ ...o, outcomeId: `w${i}`, pursuitKey: `wp${i}` })),
      ...many(4, { outcome: 'LOST' }).map((o, i) => ({ ...o, outcomeId: `l${i}`, pursuitKey: `lp${i}` })),
    ]),
    pipeline: { expectedValue: 1_000_000, opportunityCount: 5, excludedCount: 0, valueSourceNote: 'canonical hierarchy' },
    capacity: { state: 'AVAILABLE', detail: 'No clustering detected.', conflictCount: 0 },
    trend: null,
    publicBenchmarkNote: null,
    ...over,
  })

  it('scores a segment with a sufficient sample, value and capacity', () => {
    const r = scoreSegment(measured())
    expect(r.scoreState).toBe('SCORED')
    expect(r.score).toBe(600_000)
    expect(r.rationale).toContain('10 confirmed outcomes')
  })

  it('refuses to score an insufficient sample, however attractive the value', () => {
    const r = scoreSegment(measured({
      segment: buildSegment('AGENCY', 'DHS', 'DHS', many(2, { outcome: 'WON' })),
      pipeline: { expectedValue: 50_000_000, opportunityCount: 20, excludedCount: 0, valueSourceNote: 'x' },
    }))
    expect(r.scoreState).toBe('EXPLORATORY')
    expect(r.score).toBeNull()
    expect(r.rank).toBeNull()
    expect(r.rationale).toContain('below the 8 required')
  })

  it('refuses to score when no value is known', () => {
    const r = scoreSegment(measured({
      pipeline: { expectedValue: null, opportunityCount: 0, excludedCount: 3, valueSourceNote: 'x' },
    }))
    expect(r.scoreState).toBe('EXPLORATORY')
    expect(r.rationale).toContain('No usable pipeline value')
  })

  it('discounts a constrained capacity but never rewards unknown capacity', () => {
    expect(CAPACITY_MULTIPLIER.CONSTRAINED).toBeLessThan(1)
    expect(CAPACITY_MULTIPLIER.INSUFFICIENT_DATA).toBe(1)
    expect(CAPACITY_MULTIPLIER.INSUFFICIENT_DATA).toBeLessThanOrEqual(CAPACITY_MULTIPLIER.AVAILABLE)
  })

  it('says plainly that unknown capacity is not available capacity', () => {
    const r = scoreSegment(measured({
      capacity: { state: 'INSUFFICIENT_DATA', detail: 'none', conflictCount: 0 },
    }))
    expect(r.rationale).toContain('treated as unknown rather than as available capacity')
  })

  it('applies a supported trend and leaves an unsupported one neutral', () => {
    expect(TREND_MULTIPLIER.INSUFFICIENT_DATA).toBe(1)
    expect(TREND_MULTIPLIER.DECLINING).toBeLessThan(1)
    expect(TREND_MULTIPLIER.IMPROVING).toBeGreaterThan(1)
  })

  it('ranks only scored segments and never against exploratory ones', () => {
    const ranked = rankRecommendations([
      measured(),
      measured({
        segment: buildSegment('AGENCY', 'Lucky', 'Lucky', many(1, { outcome: 'WON' })),
        pipeline: { expectedValue: 99_000_000, opportunityCount: 1, excludedCount: 0, valueSourceNote: 'x' },
      }),
    ])
    expect(ranked[0].segmentKey).toBe('DoD')
    expect(ranked[0].rank).toBe(1)
    expect(ranked[1].rank).toBeNull()
    expect(ranked[1].scoreState).toBe('EXPLORATORY')
  })

  it('produces no recommendation for a segment with no evidence at all', () => {
    const empty = rankRecommendations([measured({
      segment: buildSegment('AGENCY', 'Empty', 'Empty', []),
      pipeline: { expectedValue: null, opportunityCount: 0, excludedCount: 0, valueSourceNote: 'x' },
    })])
    expect(empty).toHaveLength(0)
  })

  it('caps the number of recommendations', () => {
    const inputs = Array.from({ length: MAX_RECOMMENDATIONS + 5 }, (_, i) =>
      measured({ segment: buildSegment('AGENCY', `A${i}`, `A${i}`, many(10, { outcome: 'WON' })) }))
    expect(rankRecommendations(inputs)).toHaveLength(MAX_RECOMMENDATIONS)
  })

  it('never persists a recommendation without evidence', () => {
    const r = scoreSegment(measured())
    expect(Object.keys(r.evidence).length).toBeGreaterThan(0)
    expect(r.evidence).toHaveProperty('winLoss')
    expect(r.evidence).toHaveProperty('expectedValue')
    expect(r.evidence).toHaveProperty('capacity')
  })

  it('is deterministic — same inputs, same hash and same rationale', () => {
    const a = scoreSegment(measured())
    const b = scoreSegment(measured())
    expect(b.inputHash).toBe(a.inputHash)
    expect(b.rationale).toBe(a.rationale)
  })

  it('changes the fingerprint when the evidence materially changes', () => {
    const a = scoreSegment(measured())
    const b = scoreSegment(measured({
      pipeline: { expectedValue: 2_000_000, opportunityCount: 6, excludedCount: 0, valueSourceNote: 'x' },
    }))
    expect(b.inputHash).not.toBe(a.inputHash)
  })

  it('states that acting is a human decision', () => {
    expect(buildRationale(measured(), 'SCORED')).toContain('Acting on it is a human decision')
  })

  it('never presents a public award share as the firm’s win rate', () => {
    const r = scoreSegment(measured({
      publicBenchmarkNote: 'A comparable public cohort of 12 award(s) exists for context. Public awards show who won, not who bid, so this is not a competitor win rate.',
    }))
    expect(r.rationale).toContain('not a competitor win rate')
  })
})

// =============================================================
// Capability roadmap
// =============================================================

describe('capability roadmap', () => {
  const gap = (over: Partial<GapObservation> = {}): GapObservation => ({
    assessmentId: `a-${Math.random().toString(36).slice(2, 8)}`,
    opportunityId: `opp-${Math.random().toString(36).slice(2, 8)}`,
    category: 'MISSING_CAPABILITY',
    rawLabel: 'Cloud migration',
    opportunityValue: 1_000_000,
    partnerCoverage: false,
    partnerNames: [],
    isActivePursuit: true,
    ...over,
  })

  it('reports nothing when there are no gaps', () => {
    const r = buildRoadmap([])
    expect(r.items).toHaveLength(0)
    expect(r.totalGapsObserved).toBe(0)
  })

  it('does not promote a gap seen once', () => {
    const r = buildRoadmap([gap()])
    expect(r.items).toHaveLength(0)
    expect(r.nonRecurringGaps).toBe(1)
    expect(r.limitations.join(' ')).toContain(`recurring across at least ${MIN_RECURRENCE}`)
  })

  it('promotes a recurring gap and sums only its known value', () => {
    const r = buildRoadmap([
      gap({ opportunityValue: 1_000_000 }),
      gap({ opportunityValue: 500_000 }),
      gap({ opportunityValue: null }),
    ])
    expect(r.items).toHaveLength(1)
    expect(r.items[0].knownAffectedValue).toBe(1_500_000)
    expect(r.items[0].unknownValueCount).toBe(1)
  })

  it('never converts a missing value to zero', () => {
    const r = buildRoadmap([gap({ opportunityValue: null }), gap({ opportunityValue: null })])
    expect(r.items[0].knownAffectedValue).toBe(0)
    expect(r.items[0].unknownValueCount).toBe(2)
    expect(r.items[0].dataSufficiency).toBe('INSUFFICIENT_DATA')
    expect(r.items[0].limitations.join(' ')).toContain('rather than assumed to be zero')
  })

  it('folds case and punctuation into one canonical key', () => {
    expect(canonicalGapKey('MISSING_CERTIFICATION', 'ISO 27001')).toBe(canonicalGapKey('MISSING_CERTIFICATION', 'iso-27001'))
  })

  it('never merges genuinely different capabilities that share words', () => {
    expect(canonicalGapKey('MISSING_ELIGIBILITY', 'Secret facility clearance'))
      .not.toBe(canonicalGapKey('MISSING_ELIGIBILITY', 'Top Secret facility clearance'))
    const r = buildRoadmap([
      gap({ category: 'MISSING_ELIGIBILITY', rawLabel: 'Secret facility clearance' }),
      gap({ category: 'MISSING_ELIGIBILITY', rawLabel: 'Secret facility clearance' }),
      gap({ category: 'MISSING_ELIGIBILITY', rawLabel: 'Top Secret facility clearance' }),
      gap({ category: 'MISSING_ELIGIBILITY', rawLabel: 'Top Secret facility clearance' }),
    ])
    expect(r.items).toHaveLength(2)
  })

  it('never merges the same words across different categories', () => {
    expect(canonicalGapKey('MISSING_CAPABILITY', 'Cloud')).not.toBe(canonicalGapKey('CAPACITY', 'Cloud'))
  })

  it('ranks eligibility and certification gaps as critical', () => {
    expect(CATEGORY_SEVERITY.MISSING_ELIGIBILITY).toBe('CRITICAL')
    expect(CATEGORY_SEVERITY.MISSING_CERTIFICATION).toBe('CRITICAL')
    expect(CATEGORY_SEVERITY.GEOGRAPHY).toBe('MINOR')
  })

  it('orders critical gaps above major ones regardless of value', () => {
    const r = buildRoadmap([
      gap({ category: 'MISSING_CAPABILITY', rawLabel: 'Big money gap', opportunityValue: 90_000_000 }),
      gap({ category: 'MISSING_CAPABILITY', rawLabel: 'Big money gap', opportunityValue: 90_000_000 }),
      gap({ category: 'MISSING_ELIGIBILITY', rawLabel: 'Clearance', opportunityValue: 1 }),
      gap({ category: 'MISSING_ELIGIBILITY', rawLabel: 'Clearance', opportunityValue: 1 }),
    ])
    expect(r.items[0].severity).toBe('CRITICAL')
  })

  it('suggests partner coverage when partners actually cover the gap', () => {
    const r = buildRoadmap([
      gap({ partnerCoverage: true, partnerNames: ['Acme'] }),
      gap({ partnerCoverage: true, partnerNames: ['Acme'] }),
    ])
    expect(r.items[0].recommendation).toBe('INVESTIGATE_PARTNER_COVERAGE')
    expect(r.items[0].partnerNames).toEqual(['Acme'])
  })

  it('suggests investigation rather than directing an acquisition', () => {
    const r = buildRoadmap([gap(), gap()])
    expect(r.items[0].recommendation).toBe('INVESTIGATE_CAPABILITY_DEVELOPMENT')
    expect(JSON.stringify(r)).not.toMatch(/\backquire this capability\b|\bmust invest\b|\brequired investment\b/i)
  })

  it('invents no development cost or ROI', () => {
    const r = buildRoadmap([gap(), gap()])
    expect(JSON.stringify(r)).not.toMatch(/\broi\b|development cost|payback/i)
  })

  it('is deterministic across identical inputs', () => {
    const input = [gap({ assessmentId: 'a1', opportunityId: 'o1' }), gap({ assessmentId: 'a2', opportunityId: 'o2' })]
    expect(buildRoadmap(input).items[0].inputHash).toBe(buildRoadmap(input).items[0].inputHash)
  })

  it('counts distinct opportunities, not repeated assessments', () => {
    const r = buildRoadmap([
      gap({ assessmentId: 'a1', opportunityId: 'same' }),
      gap({ assessmentId: 'a2', opportunityId: 'same' }),
    ])
    expect(r.items[0].affectedOpportunityCount).toBe(1)
  })
})

// =============================================================
// Period policy
// =============================================================

describe('analysis period', () => {
  it('excludes an outcome older than the window and says so', () => {
    const r = analyse([
      ...many(8, { outcome: 'WON' }).map((o, i) => ({ ...o, outcomeId: `w${i}`, pursuitKey: `wp${i}` })),
      obs({ outcomeId: 'ancient', pursuitKey: 'ancient', outcome: 'WON', recordedAt: new Date('2019-01-01'), submittedAt: new Date('2018-12-01') }),
    ])
    expect(r.overall.sampleSize).toBe(8)
    expect(r.limitations.join(' ')).toContain('Historical records are not modified')
  })

  it('records the period it analysed', () => {
    const r = analyse(many(3))
    expect(r.periodStart).toEqual(PERIOD_START)
    expect(r.periodEnd).toEqual(NOW)
  })
})
