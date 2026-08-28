// =============================================================
// §7.9 — Confirmed win/loss analysis.
//
// WHAT COUNTS AS AN OUTCOME, AND WHAT DOES NOT
// ------------------------------------------------------------
// The only confirmed participation outcome in this platform is
// `SubmissionRecord.outcome`, set by a person when the agency announces the
// award. WON and LOST are the two confirmed states.
//
// Deliberately NOT treated as outcomes:
//   · a BidDecision of BID or NO_BID — a decision to bid is not a result
//   · a submitted proposal with no award notice — that is PENDING, not a loss
//   · NO_AWARD — the solicitation was cancelled; nobody lost to a competitor
//   · WITHDRAWN — the firm withdrew before evaluation; no contest occurred
//   · an AUTO_EXPIRED or unpursued opportunity — never entered
//
// PENDING NEVER ENTERS THE DENOMINATOR. Five wins, five losses and ten pending
// is a sample of ten, not twenty.
//
// Below the minimum confirmed sample, no rate and no interval is produced at
// all — not zero, not a placeholder. `winRate: null` is the honest value.
// =============================================================
import { createHash } from 'crypto'
import { Prisma, SubmissionOutcome } from '@prisma/client'
import { wilsonInterval, CONFIDENCE_METHOD, MIN_BIN_SAMPLES } from '../../scoring/confidenceInterval'

export const WIN_LOSS_ALGORITHM_VERSION = 'intelligence-winloss-v1'

/**
 * Confirmed outcomes required before any rate is stated.
 *
 * Reused, not reinvented: `MIN_BIN_SAMPLES` (8) is the platform's existing
 * confidence-interval minimum, and `evidenceStats.MIN_SAMPLE_FOR_PROBABLE` is
 * independently also 8. One number, defined once, used by backend and UI alike.
 */
export const MIN_WIN_LOSS_SAMPLE_SIZE = MIN_BIN_SAMPLES

/** How far back a routine analysis looks. Stated on every result. */
export const ANALYSIS_LOOKBACK_MONTHS = 36

/** The two outcomes that represent a decided contest. */
export const CONFIRMED_OUTCOMES: SubmissionOutcome[] = ['WON', 'LOST']

/**
 * Outcomes that are recorded but are NOT a decided contest.
 *
 * Excluding them is a judgement worth stating: a cancelled solicitation is not
 * a loss, and withdrawing before evaluation is not a loss either. Counting
 * them would understate the firm's win rate against real competition.
 */
export const NON_CONTEST_OUTCOMES: SubmissionOutcome[] = ['NO_AWARD', 'WITHDRAWN']

export type DataSufficiency = 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT_DATA'
export type SegmentType = 'OVERALL' | 'AGENCY' | 'NAICS' | 'CONTRACT_VEHICLE' | 'SET_ASIDE' | 'VALUE_BAND'

/** The key used when a dimension genuinely is not recorded. Never guessed. */
export const UNKNOWN_KEY = 'UNKNOWN'

// -------------------------------------------------------------
// Value bands
// -------------------------------------------------------------

/**
 * One deterministic contract-value band policy, defined once.
 *
 * A missing value is NOT $0 — it is `UNKNOWN_VALUE`, because a solicitation
 * with no published estimate is not a micro-purchase.
 */
export const VALUE_BANDS = [
  { key: 'UNDER_250K', label: 'Under $250K', min: 0, max: 250_000 },
  { key: '250K_1M', label: '$250K – $1M', min: 250_000, max: 1_000_000 },
  { key: '1M_5M', label: '$1M – $5M', min: 1_000_000, max: 5_000_000 },
  { key: '5M_25M', label: '$5M – $25M', min: 5_000_000, max: 25_000_000 },
  { key: 'OVER_25M', label: 'Over $25M', min: 25_000_000, max: Number.POSITIVE_INFINITY },
] as const

export const UNKNOWN_VALUE_BAND = { key: 'UNKNOWN_VALUE', label: 'Value not recorded' } as const

/**
 * Band for a value. Boundaries are inclusive at the LOWER edge, so exactly
 * $250,000 is the first dollar of the 250K–1M band.
 */
export function valueBandFor(value: number | null | undefined): { key: string; label: string } {
  if (value == null || !Number.isFinite(value)) return UNKNOWN_VALUE_BAND
  for (const band of VALUE_BANDS) {
    if (value >= band.min && value < band.max) return { key: band.key, label: band.label }
  }
  return UNKNOWN_VALUE_BAND
}

// -------------------------------------------------------------
// Inputs
// -------------------------------------------------------------

/**
 * One confirmed or pending participation outcome.
 *
 * `outcomeId` is the canonical identity — the SubmissionRecord id. `pursuitKey`
 * is the real-world contest (the opportunity), used to collapse duplicate
 * records that describe the same procurement.
 */
export interface OutcomeObservation {
  outcomeId: string
  /** The real-world contest. Two records with the same key are one outcome. */
  pursuitKey: string
  outcome: SubmissionOutcome | null
  recordedAt: Date | null
  submittedAt: Date | null
  agency: string | null
  naicsCode: string | null
  contractVehicle: string | null
  setAside: string | null
  estimatedValue: number | null
}

export interface SegmentResult {
  segmentType: SegmentType
  segmentKey: string
  segmentLabel: string
  wins: number
  losses: number
  pending: number
  sampleSize: number
  minimumSampleSize: number
  /** Null below the minimum sample. Never 0 as a placeholder. */
  winRate: number | null
  intervalLower: number | null
  intervalUpper: number | null
  dataSufficiency: DataSufficiency
  sourceOutcomeIds: string[]
  limitations: string[]
  algorithmVersion: string
  inputHash: string
}

export interface WinLossAnalysis {
  periodStart: Date
  periodEnd: Date
  minimumSampleSize: number
  method: string
  algorithmVersion: string
  overall: SegmentResult
  agencies: SegmentResult[]
  naics: SegmentResult[]
  vehicles: SegmentResult[]
  setAsides: SegmentResult[]
  valueBands: SegmentResult[]
  /** Records dropped as duplicate descriptions of one real contest. */
  duplicatesCollapsed: number
  /** Outcomes recorded but excluded because no contest was decided. */
  nonContestExcluded: number
  limitations: string[]
}

// -------------------------------------------------------------
// Deduplication
// -------------------------------------------------------------

/**
 * Collapse records that describe the same real-world contest.
 *
 * A firm can hold several rows referencing one procurement — a submission
 * record, an imported award, a contract. Counting each would inflate the
 * sample and, worse, could count one win three times. The most recently
 * decided record wins; a decided record always beats a pending one.
 */
export function dedupeOutcomes(observations: OutcomeObservation[]): {
  unique: OutcomeObservation[]
  collapsed: number
} {
  const byContest = new Map<string, OutcomeObservation>()
  let collapsed = 0

  for (const obs of observations) {
    const existing = byContest.get(obs.pursuitKey)
    if (!existing) {
      byContest.set(obs.pursuitKey, obs)
      continue
    }
    collapsed += 1
    const existingDecided = existing.outcome != null
    const candidateDecided = obs.outcome != null
    if (!existingDecided && candidateDecided) {
      byContest.set(obs.pursuitKey, obs)
      continue
    }
    if (existingDecided && candidateDecided) {
      // A later correction supersedes an earlier record of the same contest.
      const a = existing.recordedAt?.getTime() ?? 0
      const b = obs.recordedAt?.getTime() ?? 0
      if (b > a) byContest.set(obs.pursuitKey, obs)
    }
  }

  return { unique: [...byContest.values()], collapsed }
}

// -------------------------------------------------------------
// Segment computation
// -------------------------------------------------------------

function segmentHash(type: SegmentType, key: string, ids: string[], wins: number, losses: number, pending: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ type, key, ids: [...ids].sort(), wins, losses, pending, v: WIN_LOSS_ALGORITHM_VERSION }))
    .digest('hex')
}

/**
 * Build one segment from its observations.
 *
 * The sample-size gate is applied BEFORE any statistic is produced. Wilson can
 * technically run on n=1; reporting that interval would imply a confidence the
 * firm has not earned, so below the minimum nothing is reported at all.
 */
export function buildSegment(
  segmentType: SegmentType,
  segmentKey: string,
  segmentLabel: string,
  observations: OutcomeObservation[],
): SegmentResult {
  const wins = observations.filter((o) => o.outcome === 'WON')
  const losses = observations.filter((o) => o.outcome === 'LOST')
  const pending = observations.filter((o) => o.outcome === null)
  const confirmed = [...wins, ...losses]
  const sampleSize = confirmed.length
  const limitations: string[] = []

  const sufficient = sampleSize >= MIN_WIN_LOSS_SAMPLE_SIZE
  let winRate: number | null = null
  let intervalLower: number | null = null
  let intervalUpper: number | null = null

  if (sufficient) {
    winRate = Number((wins.length / sampleSize).toFixed(5))
    const interval = wilsonInterval(wins.length, sampleSize)
    if (interval) {
      intervalLower = Number(interval.low.toFixed(5))
      intervalUpper = Number(interval.high.toFixed(5))
    }
  } else {
    limitations.push(
      `${sampleSize} confirmed outcome(s) are available for this segment. ` +
        `${MIN_WIN_LOSS_SAMPLE_SIZE} are required before a win-rate conclusion is reported — ` +
        `${MIN_WIN_LOSS_SAMPLE_SIZE - sampleSize} more confirmed outcome(s) needed.`,
    )
  }

  if (pending.length > 0) {
    limitations.push(
      `${pending.length} submitted pursuit(s) in this segment have no recorded outcome yet. They are counted as pending and are excluded from the win-rate denominator.`,
    )
  }

  if (segmentKey === UNKNOWN_KEY) {
    limitations.push('This dimension is not recorded on the underlying outcomes, so these results are grouped as unknown rather than attributed to a value.')
  }

  const sourceOutcomeIds = confirmed.map((o) => o.outcomeId).sort()

  return {
    segmentType,
    segmentKey,
    segmentLabel,
    wins: wins.length,
    losses: losses.length,
    pending: pending.length,
    sampleSize,
    minimumSampleSize: MIN_WIN_LOSS_SAMPLE_SIZE,
    winRate,
    intervalLower,
    intervalUpper,
    dataSufficiency: sufficient ? 'SUFFICIENT' : sampleSize > 0 ? 'PARTIAL' : 'INSUFFICIENT_DATA',
    sourceOutcomeIds,
    limitations,
    algorithmVersion: WIN_LOSS_ALGORITHM_VERSION,
    inputHash: segmentHash(segmentType, segmentKey, sourceOutcomeIds, wins.length, losses.length, pending.length),
  }
}

/** Group observations by a dimension, then build a segment for each group. */
function segmentsBy(
  observations: OutcomeObservation[],
  segmentType: SegmentType,
  keyOf: (o: OutcomeObservation) => { key: string; label: string },
): SegmentResult[] {
  const groups = new Map<string, { label: string; items: OutcomeObservation[] }>()
  for (const o of observations) {
    const { key, label } = keyOf(o)
    const g = groups.get(key) ?? { label, items: [] }
    g.items.push(o)
    groups.set(key, g)
  }
  return [...groups.entries()]
    .map(([key, g]) => buildSegment(segmentType, key, g.label, g.items))
    // Sufficient segments first, then by sample size. An insufficient segment
    // is never ranked above a measured one on the strength of a fake zero.
    .sort((a, b) => {
      if (a.dataSufficiency === 'SUFFICIENT' && b.dataSufficiency !== 'SUFFICIENT') return -1
      if (b.dataSufficiency === 'SUFFICIENT' && a.dataSufficiency !== 'SUFFICIENT') return 1
      if (b.sampleSize !== a.sampleSize) return b.sampleSize - a.sampleSize
      return a.segmentKey.localeCompare(b.segmentKey)
    })
}

/**
 * The full win/loss picture.
 *
 * Pure: it takes observations the caller has already scoped to one tenant and
 * returns a report. It is given no means to widen the scope.
 */
export function analyseWinLoss(args: {
  observations: OutcomeObservation[]
  periodStart: Date
  periodEnd: Date
}): WinLossAnalysis {
  const limitations: string[] = []

  const inPeriod = args.observations.filter((o) => {
    const at = o.recordedAt ?? o.submittedAt
    return at == null || (at >= args.periodStart && at <= args.periodEnd)
  })
  if (inPeriod.length < args.observations.length) {
    limitations.push(
      `${args.observations.length - inPeriod.length} outcome(s) fall outside the ${ANALYSIS_LOOKBACK_MONTHS}-month analysis window and are excluded. Historical records are not modified.`,
    )
  }

  const nonContest = inPeriod.filter((o) => o.outcome != null && NON_CONTEST_OUTCOMES.includes(o.outcome))
  if (nonContest.length > 0) {
    limitations.push(
      `${nonContest.length} recorded outcome(s) are NO_AWARD or WITHDRAWN. No contest was decided, so they are excluded from wins and losses rather than counted as losses.`,
    )
  }

  const contestable = inPeriod.filter((o) => o.outcome == null || CONFIRMED_OUTCOMES.includes(o.outcome))
  const { unique, collapsed } = dedupeOutcomes(contestable)
  if (collapsed > 0) {
    limitations.push(`${collapsed} duplicate record(s) describing an already-counted procurement were collapsed, so no contest is counted twice.`)
  }

  const overall = buildSegment('OVERALL', 'OVERALL', 'All confirmed outcomes', unique)
  limitations.push(...overall.limitations)

  return {
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    minimumSampleSize: MIN_WIN_LOSS_SAMPLE_SIZE,
    method: CONFIDENCE_METHOD,
    algorithmVersion: WIN_LOSS_ALGORITHM_VERSION,
    overall,
    agencies: segmentsBy(unique, 'AGENCY', (o) => ({ key: o.agency ?? UNKNOWN_KEY, label: o.agency ?? 'Agency not recorded' })),
    naics: segmentsBy(unique, 'NAICS', (o) => ({ key: o.naicsCode ?? UNKNOWN_KEY, label: o.naicsCode ?? 'NAICS not recorded' })),
    vehicles: segmentsBy(unique, 'CONTRACT_VEHICLE', (o) => ({ key: o.contractVehicle ?? UNKNOWN_KEY, label: o.contractVehicle ?? 'Vehicle not recorded' })),
    setAsides: segmentsBy(unique, 'SET_ASIDE', (o) => ({ key: o.setAside ?? UNKNOWN_KEY, label: o.setAside ?? 'Set-aside not recorded' })),
    valueBands: segmentsBy(unique, 'VALUE_BAND', (o) => valueBandFor(o.estimatedValue)),
    duplicatesCollapsed: collapsed,
    nonContestExcluded: nonContest.length,
    limitations: [...new Set(limitations)],
  }
}

// -------------------------------------------------------------
// Trend over confirmed outcomes
// -------------------------------------------------------------

export type TrendState = 'IMPROVING' | 'STABLE' | 'DECLINING' | 'INSUFFICIENT_DATA'

/** Periods of confirmed history required before any trend is stated. */
export const MIN_TREND_PERIODS = 3

export interface OutcomeTrend {
  state: TrendState
  method: string
  periods: Array<{ period: string; wins: number; losses: number; sampleSize: number; winRate: number | null; ema: number | null }>
  periodsWithSufficientSample: number
  /** True only when the last two sufficient periods both fell. */
  consecutiveDecline: boolean
  changePercent: number | null
  limitations: string[]
}

/**
 * Split confirmed outcomes into calendar quarters and smooth with the canonical
 * EMA.
 *
 * Quarters rather than months on purpose: at a minimum of 8 confirmed outcomes
 * per period, monthly buckets would almost never qualify, and reporting a
 * trend built from unqualified months would be exactly the noise §27 forbids.
 */
export function analyseOutcomeTrend(
  observations: OutcomeObservation[],
  emaFn: (values: number[], span?: number) => number[],
  directionFn: (ema: number[]) => { direction: 'up' | 'down' | 'flat'; changePercent: number },
): OutcomeTrend {
  const limitations: string[] = []
  const confirmed = observations.filter((o) => o.outcome != null && CONFIRMED_OUTCOMES.includes(o.outcome))

  const byQuarter = new Map<string, OutcomeObservation[]>()
  for (const o of confirmed) {
    const at = o.recordedAt ?? o.submittedAt
    if (!at) continue
    const key = `${at.getUTCFullYear()}-Q${Math.floor(at.getUTCMonth() / 3) + 1}`
    byQuarter.set(key, [...(byQuarter.get(key) ?? []), o])
  }

  const periods = [...byQuarter.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, items]) => {
      const wins = items.filter((o) => o.outcome === 'WON').length
      const losses = items.filter((o) => o.outcome === 'LOST').length
      const sampleSize = wins + losses
      return {
        period,
        wins,
        losses,
        sampleSize,
        winRate: sampleSize >= MIN_WIN_LOSS_SAMPLE_SIZE ? Number((wins / sampleSize).toFixed(5)) : null,
        ema: null as number | null,
      }
    })

  const sufficient = periods.filter((p) => p.winRate !== null)

  if (sufficient.length < MIN_TREND_PERIODS) {
    limitations.push(
      `${sufficient.length} quarter(s) have at least ${MIN_WIN_LOSS_SAMPLE_SIZE} confirmed outcomes; ${MIN_TREND_PERIODS} are required before a trend is stated. A single quarter moving is not a trend.`,
    )
    return {
      state: 'INSUFFICIENT_DATA',
      method: 'ema-span-3',
      periods,
      periodsWithSufficientSample: sufficient.length,
      consecutiveDecline: false,
      changePercent: null,
      limitations,
    }
  }

  const values = sufficient.map((p) => p.winRate!)
  const ema = emaFn(values, 3)
  sufficient.forEach((p, i) => { p.ema = Number(ema[i].toFixed(5)) })
  const { direction, changePercent } = directionFn(ema)

  // Two consecutive falls in the smoothed series. One bad quarter is not a
  // decline, and the escalation depends on this being genuinely consecutive.
  const consecutiveDecline =
    ema.length >= 3 && ema[ema.length - 1] < ema[ema.length - 2] && ema[ema.length - 2] < ema[ema.length - 3]

  return {
    state: direction === 'up' ? 'IMPROVING' : direction === 'down' ? 'DECLINING' : 'STABLE',
    method: 'ema-span-3',
    periods,
    periodsWithSufficientSample: sufficient.length,
    consecutiveDecline,
    changePercent: Number(changePercent.toFixed(2)),
    limitations,
  }
}

/** Wording for a supported win-rate decline. Reports the numbers only. */
export function declineEscalationReason(trend: OutcomeTrend, overall: SegmentResult): string {
  const last = trend.periods.filter((p) => p.winRate !== null).slice(-3)
  return (
    `The confirmed win rate has fallen across ${last.length} consecutive quarters with a sufficient sample: ` +
    last.map((p) => `${p.period} ${(p.winRate! * 100).toFixed(1)}% (${p.wins}W/${p.losses}L)`).join(', ') + '. ' +
    `Overall confirmed sample is ${overall.sampleSize} outcome(s). ` +
    'This is a measurement, not a diagnosis — the agent has changed no decision, weight or pursuit.'
  )
}

/** Convert a rate to the Decimal(6,5) the model stores. Null stays null. */
export function rateToDecimal(rate: number | null): Prisma.Decimal | null {
  return rate === null ? null : new Prisma.Decimal(rate.toFixed(5))
}
