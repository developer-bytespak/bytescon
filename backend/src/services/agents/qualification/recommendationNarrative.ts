// =============================================================
// §7.4 — Deterministic recommendation narrative.
//
// FULLY DETERMINISTIC. This module contains no prompt, makes no LLM call, and
// imports nothing from the LLM layer. It is a pure template renderer over
// structured evidence that has already been computed elsewhere.
//
// THE RULE IT ENFORCES
// The narrative may only REPEAT values its structured input already carries. It
// may not compute a new number, derive a new percentage, name a competitor or
// incumbent the evidence did not name, assert a pricing comparison, or add a
// recommendation of its own. Every sentence below is either fixed wording or a
// direct interpolation of an input field. A test asserts byte-identical output
// for identical input.
//
// Why this and not the existing BID_GUIDANCE LLM task: a bid/no-bid rationale
// is decision evidence that has to be reproducible and auditable. A model that
// paraphrases could quietly introduce a figure nobody computed, which is the
// one failure mode this agent cannot have.
// =============================================================
import type { BorderlineOutcome, RecommendationResult, RecommendationStrength } from './borderlinePolicy'

export const NARRATIVE_VERSION = 'qualification-narrative-v1'

export interface NarrativeInput {
  outcome: BorderlineOutcome
  opportunityTitle: string
  /** 0–100, or null. Rendered verbatim; never recomputed. */
  finalProbability: number | null
  rawProbability: number | null
  /** RAW | CALIBRATED | FALLBACK, verbatim from the canonical stack. */
  probabilityMode: string | null
  probabilityReason: string | null
  intervalLower: number | null
  intervalUpper: number | null
  confidenceState: string
  scorecardScore: number | null
  matchScore: number | null
  capabilityGapSeverity: string
  criticalGaps: string[]
  capacityState: string
  capacityDetail: string | null
  pastPerformanceCount: number
  incumbent: {
    name: string | null
    retentionNumerator: number | null
    retentionDenominator: number | null
    retentionRatePct: number | null
    available: boolean
    limitation: string | null
  }
  competitors: Array<{
    name: string
    awardsObserved: number
    totalObserved: number
    observedAwardSharePct: number | null
    /** True only when the denominator is confirmed bid participation. */
    isConfirmedWinRate: boolean
  }>
  pricing: { availability: string; detail: string | null }
  compliance: { blockers: number; humanReviewItems: number; available: boolean }
  dataLimitations: string[]
}

const RESULT_HEADLINE: Record<RecommendationResult, string> = {
  RECOMMEND_BID: 'Bid.',
  RECOMMEND_NO_BID: 'Do not bid.',
  BORDERLINE_REVIEW: 'Borderline — human review required.',
  INSUFFICIENT_DATA: 'Insufficient data — no recommendation.',
}

const STRENGTH_SUFFIX: Record<RecommendationStrength, string> = {
  STRONG: ' The supporting evidence is strong.',
  MODERATE: ' The supporting evidence is moderate.',
  WEAK: ' The supporting evidence is weak.',
  NONE: '',
}

/**
 * Render the narrative.
 *
 * Deliberately free of any timestamp so the same normalised evidence always
 * produces the same bytes — which is what makes the recommendation's inputHash
 * meaningful and the output diffable across versions.
 */
export function renderRecommendationNarrative(input: NarrativeInput): string {
  const lines: string[] = []

  lines.push('Recommendation:')
  lines.push(RESULT_HEADLINE[input.outcome.recommendation] + STRENGTH_SUFFIX[input.outcome.strength])
  lines.push('')
  lines.push('Why:')
  for (const point of buildWhy(input)) lines.push(`- ${point}`)

  const limitations = buildLimitations(input)
  if (limitations.length > 0) {
    lines.push('')
    lines.push('Limitations:')
    for (const point of limitations) lines.push(`- ${point}`)
  }

  lines.push('')
  lines.push('This is an agent recommendation. A bid or no-bid decision is recorded only by a person.')

  return lines.join('\n')
}

/** Every bullet is a direct restatement of an input field. */
function buildWhy(input: NarrativeInput): string[] {
  const out: string[] = []

  if (input.matchScore !== null) {
    out.push(`Capability match for "${input.opportunityTitle}" scores ${input.matchScore}.`)
  }

  if (input.finalProbability !== null) {
    const mode = input.probabilityMode ?? 'RAW'
    const interval =
      input.intervalLower !== null && input.intervalUpper !== null
        ? ` with a ${input.intervalLower}–${input.intervalUpper}% confidence interval`
        : ', with no confidence interval available'
    out.push(`Win probability is ${input.finalProbability}% (${mode})${interval}.`)
    if (mode !== 'RAW' && input.rawProbability !== null && input.rawProbability !== input.finalProbability) {
      out.push(`The uncalibrated score was ${input.rawProbability}%; calibration moved it to ${input.finalProbability}%.`)
    }
  } else {
    out.push('No win probability could be computed from the available evidence.')
  }

  if (input.scorecardScore !== null) {
    out.push(`The qualification scorecard totals ${input.scorecardScore}.`)
  }

  // The policy's own reasons, verbatim. The narrative adds nothing to them.
  for (const reason of input.outcome.reasons) out.push(reason)

  if (input.capabilityGapSeverity === 'NONE') {
    out.push('No unresolved capability gap was found.')
  } else if (input.criticalGaps.length > 0) {
    out.push(`Capability gap severity is ${input.capabilityGapSeverity}: ${input.criticalGaps.join('; ')}.`)
  } else {
    out.push(`Capability gap severity is ${input.capabilityGapSeverity}.`)
  }

  if (input.capacityDetail) out.push(input.capacityDetail)

  out.push(
    input.pastPerformanceCount > 0
      ? `${input.pastPerformanceCount} relevant past-performance record(s) exist.`
      : 'No relevant past-performance record was found.',
  )

  // Incumbent — numerator and denominator always shown, never a bare rate.
  if (input.incumbent.available && input.incumbent.retentionDenominator !== null) {
    const who = input.incumbent.name ? `Incumbent ${input.incumbent.name}` : 'The identified incumbent'
    out.push(
      `${who} retained ${input.incumbent.retentionNumerator} of ${input.incumbent.retentionDenominator} comparable award(s)` +
        (input.incumbent.retentionRatePct !== null ? `, an observed retention rate of ${input.incumbent.retentionRatePct}%.` : '.'),
    )
  } else if (input.incumbent.name) {
    out.push(`An incumbent (${input.incumbent.name}) is recorded, but there is not enough award history to state a retention rate.`)
  }

  // Competitors — the wording rule is enforced structurally.
  for (const c of input.competitors) {
    if (c.isConfirmedWinRate && c.observedAwardSharePct !== null) {
      out.push(`${c.name} has a confirmed win rate of ${c.observedAwardSharePct}% across ${c.totalObserved} confirmed bid(s).`)
    } else if (c.observedAwardSharePct !== null) {
      out.push(
        `${c.name} holds an observed award share of ${c.observedAwardSharePct}% ` +
          `(${c.awardsObserved} of ${c.totalObserved} observed awards). This is not a win rate — confirmed bid participation is unavailable.`,
      )
    } else {
      out.push(`${c.name} appears in the award evidence, but there is not enough data to state a share.`)
    }
  }

  if (input.compliance.available) {
    out.push(
      input.compliance.blockers > 0
        ? `${input.compliance.blockers} compliance blocker(s) affect this pursuit.`
        : 'No compliance blocker was recorded for this pursuit.',
    )
  }

  return out
}

function buildLimitations(input: NarrativeInput): string[] {
  const out: string[] = []

  if (input.probabilityMode === 'RAW' && input.probabilityReason) {
    out.push(`Probability is RAW: ${input.probabilityReason}`)
  } else if (input.probabilityMode === 'FALLBACK' && input.probabilityReason) {
    out.push(`Probability used a fallback: ${input.probabilityReason}`)
  }

  if (input.intervalLower === null || input.intervalUpper === null) {
    out.push('No statistically defensible confidence interval could be produced for this probability.')
  }

  if (!input.incumbent.available && input.incumbent.limitation) {
    out.push(input.incumbent.limitation)
  }

  if (input.competitors.length === 0) {
    out.push('No competitor award evidence is available for this opportunity.')
  } else if (input.competitors.every((c) => !c.isConfirmedWinRate)) {
    out.push('Confirmed competitor bid participation is unavailable, so no competitor win rate can be stated.')
  }

  if (input.pricing.availability !== 'AVAILABLE') {
    out.push(input.pricing.detail ?? `Pricing evidence is ${input.pricing.availability}.`)
  }

  if (!input.compliance.available) {
    out.push('No Compliance Agent status is available for this pursuit, so compliance evidence did not contribute.')
  } else if (input.compliance.humanReviewItems > 0) {
    out.push(`${input.compliance.humanReviewItems} compliance item(s) are awaiting a human or legal review.`)
  }

  if (input.capacityState === 'INSUFFICIENT_DATA') {
    out.push('Capacity could not be assessed from recorded data. This is not the same as having capacity.')
  }

  for (const limitation of input.dataLimitations) out.push(limitation)

  // Deduplicate while preserving order, so a limitation reported by two sources
  // is stated once.
  return [...new Set(out)]
}
