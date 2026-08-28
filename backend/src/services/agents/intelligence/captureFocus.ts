// =============================================================
// §7.9 — Capture focus.
//
// Ranks segments worth concentrating capture effort on, from three things the
// platform already computes: the firm's own confirmed win rate, the canonical
// expected pipeline value, and real capacity evidence.
//
// THE DATA GATE IS THE POINT
// ------------------------------------------------------------
// A segment whose confirmed outcome sample is below the minimum is NOT scored.
// It may still be surfaced as EXPLORATORY so a genuinely promising area is not
// hidden, but it carries no score and no rank, and it is never ranked against
// a measured segment. Substituting a public award share for the firm's own win
// rate — and calling the result a capture score — would be the worst possible
// version of this feature.
//
// Nothing here computes value or probability. `portfolioValue` owns the value
// hierarchy and its exclusions; `winLossAnalysis` owns the win rate. This
// module combines them and explains itself.
// =============================================================
import { createHash } from 'crypto'
import {
  MIN_WIN_LOSS_SAMPLE_SIZE,
  type SegmentResult,
  type SegmentType,
  type DataSufficiency,
  type OutcomeTrend,
} from './winLossAnalysis'

export const CAPTURE_ALGORITHM_VERSION = 'intelligence-capture-v1'

/** How many recommendations one run will surface. */
export const MAX_RECOMMENDATIONS = 10

/** A trend multiplier, applied only when the trend is actually supported. */
export const TREND_MULTIPLIER: Record<string, number> = {
  IMPROVING: 1.15,
  STABLE: 1,
  DECLINING: 0.85,
  INSUFFICIENT_DATA: 1,
}

export type ScoreState = 'SCORED' | 'EXPLORATORY' | 'INSUFFICIENT_DATA'

export type CapacityState = 'AVAILABLE' | 'CONSTRAINED' | 'INSUFFICIENT_DATA'

/**
 * Capacity multipliers.
 *
 * Note there is no bonus for `INSUFFICIENT_DATA`: not knowing whether the firm
 * has capacity is not evidence that it does. Absence of assignments is not
 * available capacity, so unknown is neutral, never favourable.
 */
export const CAPACITY_MULTIPLIER: Record<CapacityState, number> = {
  AVAILABLE: 1,
  CONSTRAINED: 0.7,
  INSUFFICIENT_DATA: 1,
}

export interface SegmentPipeline {
  /** Canonical expected value from portfolioValue. Null when unknown. */
  expectedValue: number | null
  opportunityCount: number
  /** Opportunities portfolioValue excluded, e.g. for having no usable value. */
  excludedCount: number
  valueSourceNote: string
}

export interface CapacityEvidence {
  state: CapacityState
  detail: string
  conflictCount: number
}

export interface CaptureInput {
  segment: SegmentResult
  pipeline: SegmentPipeline
  capacity: CapacityEvidence
  trend: OutcomeTrend | null
  /** Public benchmark context, if a cohort was available. Never a win rate. */
  publicBenchmarkNote: string | null
}

export interface CaptureRecommendationResult {
  segmentType: SegmentType
  segmentKey: string
  segmentLabel: string
  score: number | null
  scoreState: ScoreState
  rank: number | null
  rationale: string
  evidence: Record<string, unknown>
  sampleSize: number
  dataSufficiency: DataSufficiency
  inputHash: string
  algorithmVersion: string
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
const money = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

/**
 * Build the deterministic rationale.
 *
 * Every number in this sentence comes from a structured field above it. There
 * is no model, no persuasion and no claim the evidence does not carry.
 */
export function buildRationale(input: CaptureInput, scoreState: ScoreState): string {
  const { segment, pipeline, capacity, trend } = input
  const parts: string[] = []

  if (segment.sampleSize >= MIN_WIN_LOSS_SAMPLE_SIZE && segment.winRate !== null) {
    parts.push(
      `${segment.segmentLabel} has ${segment.sampleSize} confirmed outcomes: ${segment.wins} wins and ${segment.losses} losses, ` +
        `a confirmed win rate of ${pct(segment.winRate)}` +
        (segment.intervalLower !== null && segment.intervalUpper !== null
          ? ` with a 95% interval of ${pct(segment.intervalLower)} to ${pct(segment.intervalUpper)}.`
          : '.'),
    )
  } else {
    parts.push(
      `${segment.segmentLabel} has ${segment.sampleSize} confirmed outcome(s), below the ${MIN_WIN_LOSS_SAMPLE_SIZE} required for a win-rate conclusion. ` +
        `${MIN_WIN_LOSS_SAMPLE_SIZE - segment.sampleSize} more confirmed outcome(s) are needed.`,
    )
  }

  if (segment.pending > 0) {
    parts.push(`${segment.pending} submitted pursuit(s) are still awaiting an outcome and are excluded from that denominator.`)
  }

  parts.push(
    pipeline.expectedValue !== null
      ? `Qualified pipeline expected value in this segment is ${money(pipeline.expectedValue)} across ${pipeline.opportunityCount} opportunity(ies)` +
          (pipeline.excludedCount > 0 ? `, with ${pipeline.excludedCount} excluded for having no usable value.` : '.')
      : `No usable pipeline value is recorded for this segment${pipeline.excludedCount > 0 ? ` (${pipeline.excludedCount} opportunity(ies) excluded)` : ''}, so expected value could not be established.`,
  )

  parts.push(
    capacity.state === 'INSUFFICIENT_DATA'
      ? 'Capacity evidence is unavailable, which is treated as unknown rather than as available capacity.'
      : `Capacity evidence: ${capacity.detail}`,
  )

  if (trend && trend.state !== 'INSUFFICIENT_DATA') {
    parts.push(`The confirmed win-rate trend across ${trend.periodsWithSufficientSample} qualifying quarter(s) is ${trend.state.toLowerCase()}.`)
  } else if (trend) {
    parts.push('There is not yet enough quarterly outcome history to state a trend.')
  }

  if (input.publicBenchmarkNote) parts.push(input.publicBenchmarkNote)

  parts.push(
    scoreState === 'SCORED'
      ? 'Recommendation confidence is based on the firm’s own confirmed outcomes.'
      : scoreState === 'EXPLORATORY'
        ? 'This segment is surfaced for exploration only. It carries no comparable score, because the outcome sample cannot support one.'
        : 'There is not enough evidence to recommend anything for this segment yet.',
  )

  parts.push('This is advice. Acting on it is a human decision — nothing in the pipeline, scoring or pursuit records has been changed.')

  return parts.join(' ')
}

/**
 * Score one segment, or refuse to.
 *
 * The score is expected value × confirmed win rate × trend × capacity. Each
 * factor is a real measured quantity; none is a default that flatters an
 * unmeasured segment.
 */
export function scoreSegment(input: CaptureInput): CaptureRecommendationResult {
  const { segment, pipeline, capacity, trend } = input

  const sampleSufficient = segment.sampleSize >= MIN_WIN_LOSS_SAMPLE_SIZE && segment.winRate !== null
  const valueKnown = pipeline.expectedValue !== null && pipeline.expectedValue > 0

  let scoreState: ScoreState
  let score: number | null = null

  if (sampleSufficient && valueKnown) {
    scoreState = 'SCORED'
    const trendFactor = trend ? (TREND_MULTIPLIER[trend.state] ?? 1) : 1
    score = Number(
      (pipeline.expectedValue! * segment.winRate! * trendFactor * CAPACITY_MULTIPLIER[capacity.state]).toFixed(4),
    )
  } else if (segment.sampleSize > 0 || valueKnown) {
    // Something real is here, but not enough to score against measured peers.
    scoreState = 'EXPLORATORY'
  } else {
    scoreState = 'INSUFFICIENT_DATA'
  }

  const evidence: Record<string, unknown> = {
    winLoss: {
      wins: segment.wins,
      losses: segment.losses,
      pending: segment.pending,
      sampleSize: segment.sampleSize,
      minimumSampleSize: MIN_WIN_LOSS_SAMPLE_SIZE,
      winRate: segment.winRate,
      intervalLower: segment.intervalLower,
      intervalUpper: segment.intervalUpper,
      sourceOutcomeIds: segment.sourceOutcomeIds.slice(0, 50),
    },
    expectedValue: {
      value: pipeline.expectedValue,
      opportunityCount: pipeline.opportunityCount,
      excludedCount: pipeline.excludedCount,
      valueSource: pipeline.valueSourceNote,
    },
    capacity: { state: capacity.state, detail: capacity.detail, conflictCount: capacity.conflictCount },
    trend: trend
      ? { state: trend.state, periodsWithSufficientSample: trend.periodsWithSufficientSample, method: trend.method }
      : { state: 'INSUFFICIENT_DATA' },
    publicBenchmark: input.publicBenchmarkNote,
    limitations: [...segment.limitations, ...(trend?.limitations ?? [])],
    scoreFormula: 'expectedValue × confirmedWinRate × trendFactor × capacityFactor',
    algorithmVersion: CAPTURE_ALGORITHM_VERSION,
  }

  const inputHash = createHash('sha256')
    .update(JSON.stringify({
      type: segment.segmentType,
      key: segment.segmentKey,
      w: segment.wins,
      l: segment.losses,
      p: segment.pending,
      ev: pipeline.expectedValue,
      cap: capacity.state,
      trend: trend?.state ?? null,
      state: scoreState,
      v: CAPTURE_ALGORITHM_VERSION,
    }))
    .digest('hex')

  return {
    segmentType: segment.segmentType,
    segmentKey: segment.segmentKey,
    segmentLabel: segment.segmentLabel,
    score,
    scoreState,
    rank: null,
    rationale: buildRationale(input, scoreState),
    evidence,
    sampleSize: segment.sampleSize,
    dataSufficiency: segment.dataSufficiency,
    inputHash,
    algorithmVersion: CAPTURE_ALGORITHM_VERSION,
  }
}

/**
 * Rank a set of segments.
 *
 * Only SCORED segments get a rank. Exploratory ones follow, unranked and in a
 * stable order, so a segment with one lucky win never appears above a segment
 * measured across twenty outcomes.
 */
export function rankRecommendations(inputs: CaptureInput[]): CaptureRecommendationResult[] {
  const scored = inputs.map(scoreSegment)

  const ranked = scored
    .filter((r) => r.scoreState === 'SCORED')
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((r, i) => ({ ...r, rank: i + 1 }))

  const exploratory = scored
    .filter((r) => r.scoreState === 'EXPLORATORY')
    .sort((a, b) => b.sampleSize - a.sampleSize || a.segmentKey.localeCompare(b.segmentKey))

  // A segment with no evidence at all produces no recommendation.
  return [...ranked, ...exploratory].slice(0, MAX_RECOMMENDATIONS)
}
