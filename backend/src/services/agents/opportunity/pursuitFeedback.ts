// =============================================================
// §7.2 — Pursuit-preference learning.
//
// Learns what kinds of opportunity a firm CHOOSES TO PURSUE. It is deliberately
// not a win/loss model: a pursuit the firm lost was still a pursuit, and the
// question "what do they go after?" is a different question from "what do they
// win?". Win/loss learning belongs to the scoring and intelligence layer and is
// not touched here.
//
// SAFETY PROPERTIES, all enforced in this file and covered by tests:
//  * DETERMINISTIC — pure arithmetic over stored records; identical evidence
//    produces an identical inputHash and therefore the identical signal row.
//  * BOUNDED — one dimension may move at most MAX_WEIGHT_ADJUSTMENT_PCT of its
//    own base weight, so preference can re-rank but can never zero a dimension
//    out or let one dominate.
//  * ADVISORY — generating a signal changes NOTHING. Production matching keeps
//    the base weights until a human ADMIN applies the signal.
//  * TENANT-PRIVATE — every query is scoped by consultingFirmId; no aggregate
//    is ever computed across firms.
//  * REVERTIBLE — the baseline is preserved verbatim on the row, so a revert
//    restores exactly what was in force rather than recalculating it.
//
// It performs ZERO LLM calls. Classification of pursued vs ignored comes from
// the firm's own recorded workflow state, not from a model's opinion.
// =============================================================
import { createHash } from 'crypto'
import {
  AgentConfidenceState,
  AgentDataSufficiency,
  PipelineStage,
  Prisma,
  PursuitFeedbackStatus,
  PursuitSource,
  PursuitStatus,
} from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { ValidationError } from '../../../utils/errors'
import type { DimensionKey } from '../../capabilityMatch'
import {
  CONFIDENCE_HIGH_SAMPLE,
  CONFIDENCE_MEDIUM_SAMPLE,
  LEARNABLE_DIMENSIONS,
  MAX_FEEDBACK_RECORDS,
  MAX_WEIGHT_ADJUSTMENT_PCT,
  MIN_FEEDBACK_CLASS_SIZE,
  MIN_FEEDBACK_SAMPLE_SIZE,
  PURSUIT_ALGORITHM_VERSION,
  baseWeights,
  isValidWeightMap,
  weightsEqual,
  type PursuitLabel,
  type WeightMap,
} from './policy'

// -------------------------------------------------------------
// Pursued vs ignored — the exact deterministic mapping
// -------------------------------------------------------------

/**
 * Capture stages that prove the firm chose to work the opportunity.
 *
 * LOST is included on purpose: losing is an OUTCOME, not a preference. A firm
 * that pursued and lost still told us it wanted that kind of work.
 */
export const PURSUED_STAGES: PipelineStage[] = [
  PipelineStage.QUALIFICATION,
  PipelineStage.CAPTURE,
  PipelineStage.PROPOSAL,
  PipelineStage.SUBMITTED,
  PipelineStage.AWARDED,
  PipelineStage.LOST,
]

/** The one capture stage that records a conscious decision not to pursue. */
export const IGNORED_STAGES: PipelineStage[] = [PipelineStage.NO_BID]

/**
 * Stages that prove nothing either way and are excluded from the sample.
 *
 * IDENTIFIED means "seen, not yet decided". ARCHIVED is housekeeping. Neither
 * is evidence of disinterest, and treating them as such would train the model
 * on the firm's filing habits rather than its intent.
 */
export const NEUTRAL_STAGES: PipelineStage[] = [PipelineStage.IDENTIFIED, PipelineStage.ARCHIVED]

/**
 * Label one pursuit row, or null when it carries no preference evidence.
 *
 * The two axes are read in the right order. `pipelineStage` is the human-managed
 * capture lifecycle and is authoritative when it has moved off IDENTIFIED.
 * `status` PASSED only counts when `source` is USER — an AUTO_EXPIRED sweep is
 * the platform ageing a record out after the deadline, which is emphatically not
 * a statement of the firm's preference.
 */
export function labelPursuit(pursuit: {
  pipelineStage: PipelineStage
  status: PursuitStatus
  source: PursuitSource
}): PursuitLabel | null {
  if (PURSUED_STAGES.includes(pursuit.pipelineStage)) return 'PURSUED'
  if (IGNORED_STAGES.includes(pursuit.pipelineStage)) return 'IGNORED'

  // Stage is still IDENTIFIED or ARCHIVED — fall back to the declaration axis.
  if (pursuit.status === PursuitStatus.SUBMITTED) return 'PURSUED'
  if (pursuit.status === PursuitStatus.PASSED) {
    return pursuit.source === PursuitSource.USER ? 'IGNORED' : null
  }
  return null
}

// -------------------------------------------------------------
// Evidence gathering
// -------------------------------------------------------------

/** Per-dimension score of one labelled opportunity, as production recorded it. */
export interface LabelledSample {
  opportunityId: string
  label: PursuitLabel
  /** Origin of the label, carried into the evidence so it is auditable. */
  basis: string
  scores: Partial<Record<DimensionKey, number>>
}

/**
 * Read the tenant's own labelled history.
 *
 * Two sources, both explicit human behaviour:
 *   BidPursuit                — the firm's capture lifecycle and declarations
 *   ClientOpportunityDecline  — a client explicitly declining an opportunity
 *
 * The decline table is keyed by clientCompanyId, so it is joined through the
 * client's owning firm. A firm never sees another firm's declines.
 */
export async function collectPursuitSamples(
  consultingFirmId: string,
  limit = MAX_FEEDBACK_RECORDS,
): Promise<LabelledSample[]> {
  const [pursuits, declines] = await Promise.all([
    prisma.bidPursuit.findMany({
      where: { consultingFirmId },
      select: {
        opportunityId: true,
        pipelineStage: true,
        status: true,
        source: true,
        opportunity: { select: { match: { select: MATCH_SCORE_SELECT } } },
      },
      orderBy: { lastActivityAt: 'desc' },
      take: limit,
    }),
    prisma.clientOpportunityDecline.findMany({
      where: { clientCompany: { consultingFirmId } },
      select: {
        opportunityId: true,
        opportunity: { select: { consultingFirmId: true, match: { select: MATCH_SCORE_SELECT } } },
      },
      orderBy: { declinedAt: 'desc' },
      take: limit,
    }),
  ])

  // One label per opportunity. An explicit pursuit outranks a client decline:
  // if the firm worked it, the firm wanted it.
  const byOpportunity = new Map<string, LabelledSample>()

  for (const decline of declines) {
    // Defensive: never let a decline reach across tenants through its client.
    if (decline.opportunity?.consultingFirmId !== consultingFirmId) continue
    const scores = toScores(decline.opportunity?.match)
    if (!scores) continue
    byOpportunity.set(decline.opportunityId, {
      opportunityId: decline.opportunityId,
      label: 'IGNORED',
      basis: 'ClientOpportunityDecline',
      scores,
    })
  }

  for (const pursuit of pursuits) {
    const label = labelPursuit(pursuit)
    if (!label) continue
    const scores = toScores(pursuit.opportunity?.match)
    // No match snapshot means no dimension evidence — the record cannot teach
    // us anything, so it is excluded rather than counted as a zero.
    if (!scores) continue
    byOpportunity.set(pursuit.opportunityId, {
      opportunityId: pursuit.opportunityId,
      label,
      basis: `BidPursuit:${pursuit.pipelineStage}/${pursuit.status}/${pursuit.source}`,
      scores,
    })
  }

  // Stable ordering so the input fingerprint never depends on query order.
  return [...byOpportunity.values()].sort((a, b) => a.opportunityId.localeCompare(b.opportunityId))
}

const MATCH_SCORE_SELECT = {
  capabilityScore: true,
  naicsScore: true,
  pscScore: true,
  certificationScore: true,
  pastPerformanceScore: true,
  geographyScore: true,
  vehicleScore: true,
  keywordScore: true,
} as const

type MatchScoreRow = { [K in keyof typeof MATCH_SCORE_SELECT]: number | null } | null | undefined

const SCORE_FIELD: Record<DimensionKey, keyof typeof MATCH_SCORE_SELECT> = {
  capability: 'capabilityScore',
  naics: 'naicsScore',
  psc: 'pscScore',
  certification: 'certificationScore',
  pastPerformance: 'pastPerformanceScore',
  geography: 'geographyScore',
  vehicle: 'vehicleScore',
  keyword: 'keywordScore',
}

/** Null-preserving projection. An absent dimension stays absent, never zero. */
function toScores(match: MatchScoreRow): Partial<Record<DimensionKey, number>> | null {
  if (!match) return null
  const out: Partial<Record<DimensionKey, number>> = {}
  for (const key of LEARNABLE_DIMENSIONS) {
    const value = match[SCORE_FIELD[key]]
    if (typeof value === 'number') out[key] = value
  }
  return Object.keys(out).length > 0 ? out : null
}

// -------------------------------------------------------------
// The derivation
// -------------------------------------------------------------

export interface DimensionEvidence {
  dimension: DimensionKey
  pursuedCount: number
  ignoredCount: number
  pursuedMean: number | null
  ignoredMean: number | null
  /** (pursuedMean - ignoredMean) / 100, clamped to [-1, 1]. Null when unassessable. */
  delta: number | null
  baseWeight: number
  /** Weight after the bounded adjustment but BEFORE renormalisation. */
  adjustedWeight: number
  /** Final weight after renormalising the set back to 1. */
  proposedWeight: number
  explanation: string
}

export interface PursuitFeedbackComputation {
  algorithmVersion: string
  inputHash: string
  sampleSize: number
  pursuedSampleSize: number
  ignoredSampleSize: number
  minimumSampleSize: number
  sufficient: boolean
  insufficientReason: string | null
  confidenceState: AgentConfidenceState
  dataSufficiency: AgentDataSufficiency
  baselineWeights: WeightMap
  proposedWeights: WeightMap
  dimensions: DimensionEvidence[]
  summary: string
  samples: LabelledSample[]
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return Number((values.reduce((s, v) => s + v, 0) / values.length).toFixed(4))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Deterministic fingerprint of the labelled evidence plus the baseline it was
 * derived against. Two runs over unchanged history hash identically, which is
 * what makes the signal row idempotent.
 */
export function computeInputHash(samples: LabelledSample[], baseline: WeightMap): string {
  const payload = samples
    .map((s) => `${s.opportunityId}:${s.label}:${LEARNABLE_DIMENSIONS.map((d) => s.scores[d] ?? '-').join(',')}`)
    .join('|')
  const weights = LEARNABLE_DIMENSIONS.map((d) => `${d}=${baseline[d]}`).join(',')
  return createHash('sha256').update(`${PURSUIT_ALGORITHM_VERSION}|${weights}|${payload}`).digest('hex')
}

/**
 * Pure derivation. No I/O, so it is fully unit-testable and gives identical
 * output for identical input.
 *
 * For each dimension the firm's pursued mean is compared with its ignored mean.
 * A dimension the firm consistently pursues HIGH scores on, and consistently
 * declines LOW scores on, is one it evidently cares about, so its weight rises —
 * by at most MAX_WEIGHT_ADJUSTMENT_PCT of its own base weight. The adjusted set
 * is then renormalised so the weights still sum to 1 and the score stays on the
 * same 0–100 scale as before.
 */
export function computePursuitFeedback(
  samples: LabelledSample[],
  baseline: WeightMap = baseWeights(),
): PursuitFeedbackComputation {
  const pursued = samples.filter((s) => s.label === 'PURSUED')
  const ignored = samples.filter((s) => s.label === 'IGNORED')
  const sampleSize = samples.length
  const inputHash = computeInputHash(samples, baseline)

  let insufficientReason: string | null = null
  if (sampleSize < MIN_FEEDBACK_SAMPLE_SIZE) {
    insufficientReason =
      `Only ${sampleSize} labelled pursue/ignore decision(s) are recorded. ` +
      `${MIN_FEEDBACK_SAMPLE_SIZE} are required before any weighting change is proposed.`
  } else if (pursued.length < MIN_FEEDBACK_CLASS_SIZE || ignored.length < MIN_FEEDBACK_CLASS_SIZE) {
    insufficientReason =
      `The sample is one-sided (${pursued.length} pursued, ${ignored.length} declined). ` +
      `At least ${MIN_FEEDBACK_CLASS_SIZE} of each are required before a preference can be inferred.`
  }
  const sufficient = insufficientReason === null

  const dimensions: DimensionEvidence[] = []
  for (const dimension of LEARNABLE_DIMENSIONS) {
    const pursuedScores = pursued.map((s) => s.scores[dimension]).filter((v): v is number => typeof v === 'number')
    const ignoredScores = ignored.map((s) => s.scores[dimension]).filter((v): v is number => typeof v === 'number')
    const pursuedMean = mean(pursuedScores)
    const ignoredMean = mean(ignoredScores)
    const baseWeight = baseline[dimension]

    // A dimension without both sides present keeps its base weight untouched.
    // Absent evidence is absent, never a signal of indifference.
    const assessable =
      sufficient &&
      pursuedMean !== null &&
      ignoredMean !== null &&
      pursuedScores.length >= MIN_FEEDBACK_CLASS_SIZE &&
      ignoredScores.length >= MIN_FEEDBACK_CLASS_SIZE

    const delta = assessable ? Number(clamp((pursuedMean! - ignoredMean!) / 100, -1, 1).toFixed(4)) : null
    const adjustedWeight = delta === null
      ? baseWeight
      : Number((baseWeight * (1 + delta * MAX_WEIGHT_ADJUSTMENT_PCT)).toFixed(6))

    dimensions.push({
      dimension,
      pursuedCount: pursuedScores.length,
      ignoredCount: ignoredScores.length,
      pursuedMean,
      ignoredMean,
      delta,
      baseWeight,
      adjustedWeight,
      proposedWeight: adjustedWeight,
      explanation: buildDimensionExplanation(dimension, pursuedMean, ignoredMean, delta, pursuedScores.length, ignoredScores.length, sufficient),
    })
  }

  // Renormalise so the weighted score stays on the same scale. Done once, over
  // the whole set, so no dimension gains from another's rounding.
  const total = dimensions.reduce((s, d) => s + d.adjustedWeight, 0)
  const proposedWeights = {} as WeightMap
  for (const d of dimensions) {
    d.proposedWeight = total > 0 ? Number((d.adjustedWeight / total).toFixed(6)) : d.baseWeight
    proposedWeights[d.dimension] = d.proposedWeight
  }

  const movedDimensions = dimensions.filter((d) => d.delta !== null && d.delta !== 0)
  const confidenceState: AgentConfidenceState = !sufficient
    ? 'INSUFFICIENT_DATA'
    : sampleSize >= CONFIDENCE_HIGH_SAMPLE
      ? 'HIGH'
      : sampleSize >= CONFIDENCE_MEDIUM_SAMPLE
        ? 'MEDIUM'
        : 'LOW'

  return {
    algorithmVersion: PURSUIT_ALGORITHM_VERSION,
    inputHash,
    sampleSize,
    pursuedSampleSize: pursued.length,
    ignoredSampleSize: ignored.length,
    minimumSampleSize: MIN_FEEDBACK_SAMPLE_SIZE,
    sufficient,
    insufficientReason,
    confidenceState,
    dataSufficiency: !sufficient ? 'INSUFFICIENT' : movedDimensions.length === LEARNABLE_DIMENSIONS.length ? 'SUFFICIENT' : 'PARTIAL',
    baselineWeights: { ...baseline },
    proposedWeights: sufficient ? proposedWeights : { ...baseline },
    dimensions,
    summary: sufficient
      ? `${sampleSize} labelled decision(s) — ${pursued.length} pursued, ${ignored.length} declined. ` +
        `${movedDimensions.length} of ${LEARNABLE_DIMENSIONS.length} matching dimension(s) show a preference. ` +
        'This is a proposal only; production matching is unchanged until an administrator applies it.'
      : (insufficientReason ?? 'Insufficient data.'),
    samples,
  }
}

function buildDimensionExplanation(
  dimension: DimensionKey,
  pursuedMean: number | null,
  ignoredMean: number | null,
  delta: number | null,
  pursuedCount: number,
  ignoredCount: number,
  sufficient: boolean,
): string {
  if (!sufficient) return 'Not assessed — the overall sample is below the minimum.'
  if (delta === null) {
    return `Not assessed — ${pursuedCount} pursued and ${ignoredCount} declined record(s) carry a ${dimension} score, below the ${MIN_FEEDBACK_CLASS_SIZE} needed on each side.`
  }
  if (delta === 0) return `No preference: pursued and declined opportunities score identically on ${dimension}.`
  const direction = delta > 0 ? 'higher' : 'lower'
  return (
    `Pursued opportunities average ${pursuedMean} on ${dimension} against ${ignoredMean} for declined ones — ` +
    `${Math.abs(Math.round(delta * 100))} points ${direction}. Weight moves by at most ` +
    `${Math.round(MAX_WEIGHT_ADJUSTMENT_PCT * 100)}% of its base value.`
  )
}

// -------------------------------------------------------------
// Persistence
// -------------------------------------------------------------

/**
 * The weighting currently in force for a firm.
 *
 * At most one signal is ever APPLIED (the apply endpoint refuses a second), so
 * this resolves without ambiguity. A malformed stored map falls back to the base
 * model rather than corrupting matching.
 */
export async function resolveEffectiveWeights(
  consultingFirmId: string,
): Promise<{ weights: WeightMap; appliedSignalId: string | null; profile: 'BASE' | 'PURSUIT_ADJUSTED' }> {
  const applied = await prisma.pursuitFeedbackSignal.findFirst({
    where: { consultingFirmId, status: PursuitFeedbackStatus.APPLIED },
    orderBy: { appliedAt: 'desc' },
    select: { id: true, proposedWeights: true },
  })
  if (!applied) return { weights: baseWeights(), appliedSignalId: null, profile: 'BASE' }

  if (!isValidWeightMap(applied.proposedWeights)) {
    logger.warn('Applied pursuit feedback signal has a malformed weight map; falling back to base weights', {
      signalId: applied.id,
    })
    return { weights: baseWeights(), appliedSignalId: null, profile: 'BASE' }
  }
  return { weights: applied.proposedWeights, appliedSignalId: applied.id, profile: 'PURSUIT_ADJUSTED' }
}

export interface AnalyseResult {
  signalId: string | null
  status: PursuitFeedbackStatus
  computation: PursuitFeedbackComputation
  created: boolean
}

/**
 * Analyse a firm's pursuit history and record the result.
 *
 * Idempotent by construction: the row is unique on (firm, inputHash), so
 * re-running over unchanged history returns the existing signal rather than
 * creating a second one — and never resets a signal a human already acted on.
 *
 * This function NEVER changes production matching. It only records a proposal.
 */
export async function analysePursuitFeedback(args: {
  consultingFirmId: string
  runId?: string | null
  now?: Date
}): Promise<AnalyseResult> {
  const { consultingFirmId } = args
  const samples = await collectPursuitSamples(consultingFirmId)

  // Derived against the BASE model, always. A proposal is an alternative to the
  // stable base, never a compounding adjustment on top of a previous one.
  const computation = computePursuitFeedback(samples, baseWeights())

  const existing = await prisma.pursuitFeedbackSignal.findUnique({
    where: { consultingFirmId_inputHash: { consultingFirmId, inputHash: computation.inputHash } },
    select: { id: true, status: true },
  })
  if (existing) {
    return { signalId: existing.id, status: existing.status, computation, created: false }
  }

  const status: PursuitFeedbackStatus = computation.sufficient
    ? PursuitFeedbackStatus.PROPOSED
    : PursuitFeedbackStatus.INSUFFICIENT_DATA

  const evidence = {
    dimensions: computation.dimensions,
    labelling: {
      pursuedStages: PURSUED_STAGES,
      ignoredStages: IGNORED_STAGES,
      neutralStages: NEUTRAL_STAGES,
      note:
        'A LOST pursuit counts as pursued — losing is an outcome, not a preference. ' +
        'An AUTO_EXPIRED pass is a system sweep and is excluded entirely.',
    },
    samples: computation.samples.map((s) => ({ opportunityId: s.opportunityId, label: s.label, basis: s.basis })),
    insufficientReason: computation.insufficientReason,
  }

  try {
    const created = await prisma.pursuitFeedbackSignal.create({
      data: {
        consultingFirmId,
        algorithmVersion: computation.algorithmVersion,
        inputHash: computation.inputHash,
        status,
        sampleSize: computation.sampleSize,
        pursuedSampleSize: computation.pursuedSampleSize,
        ignoredSampleSize: computation.ignoredSampleSize,
        minimumSampleSize: computation.minimumSampleSize,
        confidenceState: computation.confidenceState,
        dataSufficiency: computation.dataSufficiency,
        baselineWeights: computation.baselineWeights as unknown as Prisma.InputJsonObject,
        proposedWeights: computation.proposedWeights as unknown as Prisma.InputJsonObject,
        evidence: JSON.parse(JSON.stringify(evidence)) as Prisma.InputJsonObject,
        summary: computation.summary,
        generatedByRunId: args.runId ?? null,
        generatedAt: args.now ?? new Date(),
      },
      select: { id: true, status: true },
    })

    // A newer proposal replaces an older UNAPPLIED one. An APPLIED signal is the
    // firm's live configuration and is deliberately left alone — replacing it
    // silently would be exactly the auto-apply this agent must never do.
    if (status === PursuitFeedbackStatus.PROPOSED) {
      await prisma.pursuitFeedbackSignal.updateMany({
        where: {
          consultingFirmId,
          id: { not: created.id },
          status: PursuitFeedbackStatus.PROPOSED,
        },
        data: {
          status: PursuitFeedbackStatus.SUPERSEDED,
          supersededBySignalId: created.id,
          supersededAt: args.now ?? new Date(),
        },
      })
    }

    return { signalId: created.id, status: created.status, computation, created: true }
  } catch (err) {
    // A concurrent run inserted the same fingerprint first. That is the
    // idempotency working, not a failure.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const row = await prisma.pursuitFeedbackSignal.findUnique({
        where: { consultingFirmId_inputHash: { consultingFirmId, inputHash: computation.inputHash } },
        select: { id: true, status: true },
      })
      return { signalId: row?.id ?? null, status: row?.status ?? status, computation, created: false }
    }
    throw err
  }
}

// -------------------------------------------------------------
// Human apply / revert — the only paths that change matching
// -------------------------------------------------------------

/**
 * Apply a proposal. ADMIN-only; the route enforces the role, this enforces every
 * domain precondition.
 *
 * Refuses when another signal is already applied. Learned weights are an overlay
 * on a STABLE BASE MODEL, not a chain of compounding adjustments, so the firm
 * reverts the current one before applying another. That also makes revert exact:
 * the preserved baseline is always the base model.
 */
export async function applyPursuitFeedback(args: {
  consultingFirmId: string
  signalId: string
  userId: string
  now?: Date
}): Promise<{ id: string; appliedWeights: WeightMap; baselineWeights: WeightMap }> {
  const now = args.now ?? new Date()

  const signal = await prisma.pursuitFeedbackSignal.findFirst({
    where: { id: args.signalId, consultingFirmId: args.consultingFirmId },
    select: {
      id: true, status: true, sampleSize: true, minimumSampleSize: true,
      baselineWeights: true, proposedWeights: true,
    },
  })
  if (!signal) throw new ValidationError('Pursuit feedback signal not found for this firm.')

  if (signal.status !== PursuitFeedbackStatus.PROPOSED) {
    throw new ValidationError(
      `Only a PROPOSED signal can be applied. This signal is ${signal.status}.`,
    )
  }
  if (signal.sampleSize < signal.minimumSampleSize) {
    throw new ValidationError(
      `This signal is below the minimum sample size (${signal.sampleSize} of ${signal.minimumSampleSize}) and cannot be applied.`,
    )
  }
  if (!isValidWeightMap(signal.proposedWeights) || !isValidWeightMap(signal.baselineWeights)) {
    throw new ValidationError('This signal has a malformed weighting and cannot be applied.')
  }

  const current = await resolveEffectiveWeights(args.consultingFirmId)
  if (current.appliedSignalId) {
    throw new ValidationError(
      'Another learned adjustment is already applied. Revert it before applying a different one.',
    )
  }
  // The baseline recorded on the proposal must still be what is in force,
  // otherwise the proposal describes a configuration that no longer exists.
  if (!weightsEqual(current.weights, signal.baselineWeights)) {
    throw new ValidationError(
      'The matching configuration has changed since this proposal was generated. Regenerate it before applying.',
    )
  }

  // Compare-and-set on status: a replayed request finds the row no longer
  // PROPOSED and updates nothing, so a double-apply is impossible.
  const claimed = await prisma.pursuitFeedbackSignal.updateMany({
    where: { id: signal.id, consultingFirmId: args.consultingFirmId, status: PursuitFeedbackStatus.PROPOSED },
    data: {
      status: PursuitFeedbackStatus.APPLIED,
      appliedByUserId: args.userId,
      appliedAt: now,
    },
  })
  if (claimed.count !== 1) {
    throw new ValidationError('This signal was already actioned by another request.')
  }

  return {
    id: signal.id,
    appliedWeights: signal.proposedWeights,
    baselineWeights: signal.baselineWeights,
  }
}

/**
 * Revert an applied adjustment.
 *
 * Restores the EXACT preserved baseline stored on the row. Nothing is
 * recalculated and no attempt is made to infer what the previous weights
 * probably were.
 */
export async function revertPursuitFeedback(args: {
  consultingFirmId: string
  signalId: string
  userId: string
  now?: Date
}): Promise<{ id: string; restoredWeights: WeightMap }> {
  const now = args.now ?? new Date()

  const signal = await prisma.pursuitFeedbackSignal.findFirst({
    where: { id: args.signalId, consultingFirmId: args.consultingFirmId },
    select: { id: true, status: true, baselineWeights: true },
  })
  if (!signal) throw new ValidationError('Pursuit feedback signal not found for this firm.')
  if (signal.status !== PursuitFeedbackStatus.APPLIED) {
    throw new ValidationError(`Only an APPLIED signal can be reverted. This signal is ${signal.status}.`)
  }
  if (!isValidWeightMap(signal.baselineWeights)) {
    throw new ValidationError('The preserved baseline on this signal is malformed; it cannot be reverted safely.')
  }

  const claimed = await prisma.pursuitFeedbackSignal.updateMany({
    where: { id: signal.id, consultingFirmId: args.consultingFirmId, status: PursuitFeedbackStatus.APPLIED },
    data: {
      status: PursuitFeedbackStatus.REVERTED,
      revertedByUserId: args.userId,
      revertedAt: now,
    },
  })
  if (claimed.count !== 1) {
    throw new ValidationError('This signal was already actioned by another request.')
  }

  return { id: signal.id, restoredWeights: signal.baselineWeights }
}
