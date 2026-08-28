// =============================================================
// §7.6 — Historical price positioning.
//
// WHAT THIS DOES AND DOES NOT SAY
// It states where a proposed price sits against comparable PUBLIC awards.
// It does not say the price is right, wrong, good or bad. BELOW_HISTORICAL_RANGE
// is not praise and ABOVE_HISTORICAL_RANGE is not criticism — a price above the
// historical range may be entirely correct for a richer scope, and a price
// below it may be a loss-maker. The verdict is positional, and every message
// this module produces is worded to keep that distinction.
//
// Below the minimum cohort size the answer is INSUFFICIENT_DATA and the
// percentile is null. Never 0th, never 50th, never 100th as a placeholder.
//
// Deterministic throughout. No LLM.
// =============================================================
import { Prisma } from '@prisma/client'
import { MIN_BENCHMARK_COHORT_SIZE, type BenchmarkResult, type DataSufficiency } from './awardBenchmark'

export const COMPETITIVE_RANGE_POLICY_VERSION = 'competitive-range-v1'

/**
 * An outlier is judged by distance from the quartiles in IQR units — Tukey's
 * rule — rather than by an arbitrary percentage, so a tight cohort and a wide
 * one are each judged on their own spread.
 */
export const OUTLIER_IQR_MULTIPLIER = 3

export type RangeState =
  | 'BELOW_HISTORICAL_RANGE'
  | 'WITHIN_HISTORICAL_RANGE'
  | 'ABOVE_HISTORICAL_RANGE'
  | 'EXTREME_OUTLIER'
  | 'INSUFFICIENT_DATA'

export interface RangeAssessment {
  state: RangeState
  /** Null unless the cohort met the minimum and the price is known. */
  percentile: number | null
  proposedPrice: Prisma.Decimal | null
  cohortSize: number
  p25: Prisma.Decimal | null
  median: Prisma.Decimal | null
  p75: Prisma.Decimal | null
  minimum: Prisma.Decimal | null
  maximum: Prisma.Decimal | null
  dataSufficiency: DataSufficiency
  sourceIds: string[]
  /** Plain-language positioning statement. Never a verdict on the price. */
  summary: string
  limitations: string[]
  policyVersion: string
}

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)

/**
 * The share of cohort awards at or below the proposed price, 0–100.
 *
 * A rank-based figure rather than an interpolation, because "62% of comparable
 * awards came in at or below this price" is a statement a reader can check
 * against the source list.
 */
export function pricePercentile(proposed: Prisma.Decimal, sortedAscending: Prisma.Decimal[]): number | null {
  if (sortedAscending.length === 0) return null
  const atOrBelow = sortedAscending.filter((v) => D(v).lessThanOrEqualTo(D(proposed))).length
  return Math.round((atOrBelow / sortedAscending.length) * 100)
}

/**
 * Position a proposed price against a cohort.
 *
 * Precedence: no price → INSUFFICIENT_DATA; cohort under the minimum →
 * INSUFFICIENT_DATA; outside the Tukey fence → EXTREME_OUTLIER; below p25 or
 * above p75 → the corresponding range state; otherwise WITHIN.
 */
export function assessCompetitiveRange(args: {
  proposedPrice: Prisma.Decimal | null
  benchmark: BenchmarkResult
}): RangeAssessment {
  const { benchmark } = args
  const limitations = [...benchmark.limitations]
  const values = benchmark.included.map((a) => D(a.awardAmount)).sort((a, b) => (a.lessThan(b) ? -1 : a.greaterThan(b) ? 1 : 0))

  const base = {
    percentile: null as number | null,
    proposedPrice: args.proposedPrice,
    cohortSize: benchmark.cohortSize,
    p25: benchmark.distribution.p25,
    median: benchmark.distribution.median,
    p75: benchmark.distribution.p75,
    minimum: benchmark.distribution.minimum,
    maximum: benchmark.distribution.maximum,
    dataSufficiency: benchmark.dataSufficiency,
    sourceIds: benchmark.sourceIds,
    limitations,
    policyVersion: COMPETITIVE_RANGE_POLICY_VERSION,
  }

  if (args.proposedPrice === null || D(args.proposedPrice).lessThanOrEqualTo(0)) {
    limitations.push('The scenario records no positive proposed price, so it cannot be positioned against the historical distribution.')
    return { ...base, state: 'INSUFFICIENT_DATA', summary: 'No proposed price is available to position.' }
  }

  if (benchmark.cohortSize < MIN_BENCHMARK_COHORT_SIZE) {
    return {
      ...base,
      state: 'INSUFFICIENT_DATA',
      summary:
        `Only ${benchmark.cohortSize} comparable public award(s) were available (minimum ${MIN_BENCHMARK_COHORT_SIZE}); ` +
        'no percentile or competitive-range conclusion was calculated.',
    }
  }

  const p25 = benchmark.distribution.p25
  const p75 = benchmark.distribution.p75
  const median = benchmark.distribution.median
  if (!p25 || !p75 || !median) {
    return {
      ...base,
      state: 'INSUFFICIENT_DATA',
      summary: 'The cohort distribution could not be computed, so no positioning was produced.',
    }
  }

  const proposed = D(args.proposedPrice)
  const percentile = pricePercentile(proposed, values)
  const iqr = D(p75).minus(D(p25))
  const lowerFence = D(p25).minus(iqr.times(OUTLIER_IQR_MULTIPLIER))
  const upperFence = D(p75).plus(iqr.times(OUTLIER_IQR_MULTIPLIER))

  const money = (v: Prisma.Decimal) => `$${D(v).toFixed(2)}`
  const evidence =
    `Positioned against ${benchmark.cohortSize} comparable public award(s) ` +
    `(p25 ${money(p25)}, median ${money(median)}, p75 ${money(p75)}).`

  if (proposed.lessThan(lowerFence) || proposed.greaterThan(upperFence)) {
    return {
      ...base,
      state: 'EXTREME_OUTLIER',
      percentile,
      summary:
        `${money(proposed)} falls more than ${OUTLIER_IQR_MULTIPLIER}× the interquartile range outside the historical quartiles. ${evidence} ` +
        'This is a statement about historical position; it does not by itself mean the price is wrong.',
    }
  }

  if (proposed.lessThan(D(p25))) {
    return {
      ...base,
      state: 'BELOW_HISTORICAL_RANGE',
      percentile,
      summary:
        `${money(proposed)} sits below the 25th percentile of comparable awards. ${evidence} ` +
        'Below the historical range is not the same as a good price — it may indicate an under-scoped or loss-making bid.',
    }
  }

  if (proposed.greaterThan(D(p75))) {
    return {
      ...base,
      state: 'ABOVE_HISTORICAL_RANGE',
      percentile,
      summary:
        `${money(proposed)} sits above the 75th percentile of comparable awards. ${evidence} ` +
        'Above the historical range is not the same as a bad price — a richer scope may justify it.',
    }
  }

  return {
    ...base,
    state: 'WITHIN_HISTORICAL_RANGE',
    percentile,
    summary: `${money(proposed)} sits within the interquartile range of comparable awards. ${evidence}`,
  }
}

/** Does this positioning warrant a human's attention? */
export function warrantsReview(assessment: RangeAssessment): boolean {
  return (
    assessment.state === 'BELOW_HISTORICAL_RANGE' ||
    assessment.state === 'ABOVE_HISTORICAL_RANGE' ||
    assessment.state === 'EXTREME_OUTLIER'
  )
}
