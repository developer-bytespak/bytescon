// =============================================================
// §6.2A — Transparent scoring.
//
// Composes the EXISTING win-probability resolver (§5.1 Stage 3) with the new
// per-tenant calibration (§6.2B) and confidence intervals (§6.2H) into one
// explained result.
//
// Calibration is applied EXACTLY ONCE. Precedence is explicit:
//   tenant calibration (fitted on this firm's own verified outcomes) wins over
//   the platform-wide curve, because it is the more specific model. When the
//   tenant model is absent, stale or invalid, the existing global resolution
//   runs unchanged. The two are never stacked.
//
// What is deliberately NOT exposed: raw model coefficients, other tenants'
// data, and any internal identifier that would leak implementation detail. The
// explanation is written for a business user.
// =============================================================
import { applyPlatt } from '../plattCalibration'
import {
  resolveStoredProbability,
  type ScoreType,
  type DataSufficiency,
  type WinProbabilityResult,
} from '../winProbability'
import {
  getActiveTenantCalibration,
  normalizeProbability,
  type ActiveTenantCalibration,
} from './tenantCalibration'
import {
  computeConfidenceInterval,
  buildBins,
  featureCompleteness,
  type IntervalResult,
  type CalibrationBin,
} from './confidenceInterval'

export const SCORING_MODEL_VERSION = 'section6-scoring-v1'

/** The model inputs the explanation reports on. */
export const EXPECTED_FEATURE_KEYS = [
  'naicsCode', 'agency', 'setAsideType', 'estimatedValue', 'responseDeadline',
  'competitionCount', 'incumbentProbability', 'historicalAwardCount',
] as const

export interface FactorContribution {
  key: string
  label: string
  /** Signed contribution in probability points. Null when not assessable. */
  contribution: number | null
  direction: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'ABSENT'
  explanation: string
}

export interface CalibrationMetadata {
  applied: 'TENANT' | 'GLOBAL' | 'NONE'
  tenantVersion: number | null
  tenantSampleSize: number | null
  tenantBrier: number | null
  tenantBaselineBrier: number | null
  globalMethod: string | null
  globalMethodVersion: string | null
  globalSampleSize: number | null
  reason: string
}

export interface ExplainedScore {
  rawScore: number
  finalScore: number
  scoreType: ScoreType
  modelVersion: string
  factors: FactorContribution[]
  positiveDrivers: FactorContribution[]
  negativeDrivers: FactorContribution[]
  missingInputs: string[]
  dataQuality: {
    completeness: number
    sufficiency: DataSufficiency
    note: string
  }
  calibration: CalibrationMetadata
  interval: IntervalResult
  lastCalculatedAt: string
  /** Plain-language summary suitable for a business user. */
  explanation: string
}

export interface ScoreInputs {
  /** Persisted RAW model probability (0-1 or legacy 0-100). */
  rawProbability: number
  scoreBreakdown: unknown
  naicsCode: string | null
  agency: string | null
  setAsideType: string | null
  estimatedValue: unknown
  responseDeadline: Date | null
  competitionCount: number | null
  incumbentProbability: number | null
  historicalAwardCount: number | null
  isEnriched: boolean
}

const FACTOR_LABELS: Record<string, string> = {
  naicsCode: 'NAICS alignment',
  agency: 'Agency history',
  setAsideType: 'Set-aside fit',
  estimatedValue: 'Contract size fit',
  responseDeadline: 'Preparation window',
  competitionCount: 'Expected competition',
  incumbentProbability: 'Incumbent strength',
  historicalAwardCount: 'Historical award volume',
}

/**
 * Derive factor contributions from the persisted scoreBreakdown when the
 * scoring engine wrote one, falling back to a presence/absence report.
 *
 * Contributions are reported only when the engine actually recorded them —
 * they are never back-solved or invented.
 */
export function deriveFactors(inputs: ScoreInputs): { factors: FactorContribution[]; missingInputs: string[] } {
  const breakdown = (inputs.scoreBreakdown ?? null) as Record<string, unknown> | null
  const recorded = breakdown && typeof breakdown === 'object'
    ? ((breakdown.featureBreakdown ?? breakdown.factors ?? breakdown) as Record<string, unknown>)
    : null

  const presence: Record<string, unknown> = {
    naicsCode: inputs.naicsCode,
    agency: inputs.agency,
    setAsideType: inputs.setAsideType,
    estimatedValue: inputs.estimatedValue,
    responseDeadline: inputs.responseDeadline,
    competitionCount: inputs.competitionCount,
    incumbentProbability: inputs.incumbentProbability,
    historicalAwardCount: inputs.historicalAwardCount,
  }

  const missingInputs: string[] = []
  const factors: FactorContribution[] = []

  for (const key of EXPECTED_FEATURE_KEYS) {
    const label = FACTOR_LABELS[key] ?? key
    const value = presence[key]
    const isPresent = value !== null && value !== undefined && value !== ''

    if (!isPresent) {
      missingInputs.push(label)
      factors.push({
        key, label, contribution: null, direction: 'ABSENT',
        explanation: `${label} could not be assessed because this input is missing from the notice or from your records. It is excluded from the score rather than counted as zero.`,
      })
      continue
    }

    const rawContribution = recorded && typeof recorded[key] === 'number' ? (recorded[key] as number) : null
    if (rawContribution === null) {
      factors.push({
        key, label, contribution: null, direction: 'NEUTRAL',
        explanation: `${label} was available, but the scoring run did not record a separate contribution for it.`,
      })
      continue
    }

    // Breakdown values are stored on the 0-1 probability scale.
    const points = Number((rawContribution * 100).toFixed(2))
    factors.push({
      key, label, contribution: points,
      direction: points > 0.5 ? 'POSITIVE' : points < -0.5 ? 'NEGATIVE' : 'NEUTRAL',
      explanation: `${label} moved the estimate by ${points > 0 ? '+' : ''}${points} points.`,
    })
  }

  return { factors, missingInputs }
}

export interface ExplainOptions {
  now?: Date
  /** Tenant outcome samples, used to build the interval's calibration bins. */
  outcomeSamples?: Array<{ predicted: number; observed: number }>
  precomputedBins?: CalibrationBin[]
  tenantCalibration?: ActiveTenantCalibration | null
  /** 0..1 similarity of this record to the tenant's training data. */
  trainingSimilarity?: number
}

/**
 * Produce the fully explained score. Pure with respect to its inputs — all
 * database reads happen in explainOpportunityScore below.
 */
export function explainScore(inputs: ScoreInputs, options: ExplainOptions = {}): ExplainedScore {
  const now = options.now ?? new Date()
  const rawProb = normalizeProbability(inputs.rawProbability)

  // Existing global resolution — unchanged behaviour.
  const global: WinProbabilityResult = resolveStoredProbability(rawProb, now)

  const tenant = options.tenantCalibration ?? null
  const tenantUsable = Boolean(tenant && !tenant.isStale)

  let finalScore = global.finalScore
  let scoreType: ScoreType = global.scoreType
  let appliedLayer: CalibrationMetadata['applied'] = global.scoreType === 'CALIBRATED' ? 'GLOBAL' : 'NONE'
  let calibrationReason: string

  if (tenantUsable && tenant) {
    // Tenant model wins — applied ONCE to the RAW probability, never on top of
    // the globally calibrated value.
    finalScore = Math.round(Math.min(1, Math.max(0, applyPlatt(rawProb, tenant.params))) * 100)
    scoreType = 'CALIBRATED'
    appliedLayer = 'TENANT'
    calibrationReason =
      `Calibrated on your firm's own ${tenant.sampleSize} verified outcome(s) (version ${tenant.version}). ` +
      `This model beat the uncalibrated baseline on held-out data (Brier ${tenant.brierScore} vs ${tenant.baselineBrierScore}), which is why it is active. ` +
      'Your firm-specific model takes precedence over the platform-wide curve; the two are never combined.'
  } else if (tenant?.isStale) {
    calibrationReason =
      `Your firm's calibration (version ${tenant.version}) is older than its staleness window and is no longer applied. ` +
      `The score shown is ${global.scoreType === 'CALIBRATED' ? 'the platform-wide calibrated estimate' : 'the uncalibrated model estimate'}. Refit to reactivate it.`
  } else if (global.scoreType === 'CALIBRATED') {
    calibrationReason = 'Adjusted by the platform-wide calibration curve. Your firm does not yet have enough verified outcomes for a firm-specific model.'
  } else if (global.scoreType === 'FALLBACK') {
    calibrationReason = `The platform-wide calibration was not applied (${global.reason}). The uncalibrated model estimate is shown instead.`
  } else {
    calibrationReason = 'No calibration is applied. This is the raw model estimate, shown as-is rather than adjusted by a model we cannot yet justify.'
  }

  const { factors, missingInputs } = deriveFactors(inputs)
  const completeness = featureCompleteness(
    {
      naicsCode: inputs.naicsCode, agency: inputs.agency, setAsideType: inputs.setAsideType,
      estimatedValue: inputs.estimatedValue, responseDeadline: inputs.responseDeadline,
      competitionCount: inputs.competitionCount, incumbentProbability: inputs.incumbentProbability,
      historicalAwardCount: inputs.historicalAwardCount,
    },
    [...EXPECTED_FEATURE_KEYS],
  )

  const bins = options.precomputedBins ?? buildBins(options.outcomeSamples ?? [])
  const interval = computeConfidenceInterval({
    pointEstimate: finalScore / 100,
    bins,
    tenantSampleSize: tenant?.sampleSize ?? (options.outcomeSamples?.length ?? 0),
    modelVersion: SCORING_MODEL_VERSION,
    dataCompleteness: completeness,
    trainingSimilarity: options.trainingSimilarity ?? (inputs.isEnriched ? 0.7 : 0.35),
  })

  const positiveDrivers = factors.filter((f) => f.direction === 'POSITIVE').sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0))
  const negativeDrivers = factors.filter((f) => f.direction === 'NEGATIVE').sort((a, b) => (a.contribution ?? 0) - (b.contribution ?? 0))

  const explanation = buildPlainLanguage(finalScore, scoreType, positiveDrivers, negativeDrivers, missingInputs, interval, calibrationReason)

  return {
    rawScore: global.rawScore,
    finalScore,
    scoreType,
    modelVersion: SCORING_MODEL_VERSION,
    factors,
    positiveDrivers,
    negativeDrivers,
    missingInputs,
    dataQuality: {
      completeness,
      sufficiency: global.dataSufficiency,
      note: missingInputs.length === 0
        ? 'All model inputs were available for this opportunity.'
        : `${missingInputs.length} of ${EXPECTED_FEATURE_KEYS.length} model inputs were unavailable: ${missingInputs.join(', ')}. Those factors are excluded from the estimate, not scored as zero.`,
    },
    calibration: {
      applied: appliedLayer,
      tenantVersion: tenant?.version ?? null,
      tenantSampleSize: tenant?.sampleSize ?? null,
      tenantBrier: tenant?.brierScore ?? null,
      tenantBaselineBrier: tenant?.baselineBrierScore ?? null,
      globalMethod: global.method,
      globalMethodVersion: global.methodVersion,
      globalSampleSize: global.sampleSize,
      reason: calibrationReason,
    },
    interval,
    lastCalculatedAt: now.toISOString(),
    explanation,
  }
}

function buildPlainLanguage(
  finalScore: number,
  scoreType: ScoreType,
  positives: FactorContribution[],
  negatives: FactorContribution[],
  missing: string[],
  interval: IntervalResult,
  calibrationReason: string,
): string {
  const parts: string[] = []
  parts.push(`This opportunity scores ${finalScore}% on our win-probability model.`)

  if (interval.available && interval.lower !== null && interval.upper !== null) {
    parts.push(`Allowing for uncertainty, the likely range is ${Math.round(interval.lower * 100)}%–${Math.round(interval.upper * 100)}% (${interval.confidence.toLowerCase()} confidence).`)
  } else {
    parts.push(`${interval.unavailableLabel}. ${interval.reason}`)
  }

  if (positives.length > 0) {
    parts.push(`Working in your favour: ${positives.slice(0, 3).map((f) => f.label.toLowerCase()).join(', ')}.`)
  }
  if (negatives.length > 0) {
    parts.push(`Working against you: ${negatives.slice(0, 3).map((f) => f.label.toLowerCase()).join(', ')}.`)
  }
  if (missing.length > 0) {
    parts.push(`${missing.length} input(s) were unavailable (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}), so the estimate rests on less information than usual.`)
  }

  parts.push(calibrationReason)
  parts.push('This is a decision-support estimate based on your records and historical federal award data. It is not a prediction of the award.')
  return parts.join(' ')
}

// -------------------------------------------------------------
// Database-facing wrapper
// -------------------------------------------------------------

/** Loads what explainScore needs and returns the explained score. */
export async function explainOpportunityScore(
  consultingFirmId: string,
  opportunity: {
    probabilityScore: number
    scoreBreakdown: unknown
    naicsCode: string
    agency: string
    setAsideType: string
    estimatedValue: unknown
    responseDeadline: Date
    competitionCount: number | null
    incumbentProbability: number | null
    historicalAwardCount: number | null
    isEnriched: boolean
  },
  outcomeSamples: Array<{ predicted: number; observed: number }>,
  now: Date = new Date(),
): Promise<ExplainedScore> {
  const tenantCalibration = await getActiveTenantCalibration(consultingFirmId, now)
  return explainScore(
    {
      rawProbability: opportunity.probabilityScore,
      scoreBreakdown: opportunity.scoreBreakdown,
      naicsCode: opportunity.naicsCode || null,
      agency: opportunity.agency || null,
      setAsideType: opportunity.setAsideType || null,
      estimatedValue: opportunity.estimatedValue,
      responseDeadline: opportunity.responseDeadline,
      competitionCount: opportunity.competitionCount,
      incumbentProbability: opportunity.incumbentProbability,
      historicalAwardCount: opportunity.historicalAwardCount,
      isEnriched: opportunity.isEnriched,
    },
    { now, outcomeSamples, tenantCalibration },
  )
}
