// =============================================================
// §6.2B — Contractor-specific historical calibration.
//
// Fits a per-tenant calibration on that tenant's OWN verified outcomes and
// activates it only when it demonstrably beats the uncalibrated baseline on
// held-out data. Fitting a curve is explicitly NOT grounds for activation.
//
// Guarantees:
//  - Outcomes come only from verified records (submission outcome, contract
//    award, or an explicitly human-confirmed pursuit result). Nothing synthetic.
//  - Deterministic: the holdout split is a stable hash of the sample id, not
//    a random draw, so refitting the same data gives the same model.
//  - No double application. This layer produces a tenant-level adjustment that
//    the resolver applies ONCE, after (and instead of) the global curve.
//  - Rollback: activating a new version deactivates the prior one and records
//    rolledBackFromId, so the previous accepted calibration can be restored.
//  - Staleness: a calibration older than stalenessDays is marked STALE and
//    stops being applied — it falls back to RAW rather than silently ageing.
//  - The master feature flag is respected; with it off nothing is ever applied.
// =============================================================
import { createHash } from 'crypto'
import { CalibrationState, OutcomeVerification, Prisma, SubmissionOutcome } from '@prisma/client'
import { prisma } from '../../config/database'
import { emitCalibrationUpdated } from '../agents/intelligence/intelligenceEvents'
import { logger } from '../../utils/logger'
import { fitPlatt, applyPlatt, type PlattParams } from '../plattCalibration'

export const TENANT_CALIBRATION_METHOD = 'platt'
export const TENANT_CALIBRATION_METHOD_VERSION = 'tenant-platt-v1'
export const DEFAULT_MIN_SAMPLE = 30
export const DEFAULT_STALENESS_DAYS = 180
/** Fraction of samples reserved for validation when there is enough data. */
export const HOLDOUT_FRACTION = 0.3
/** Holdout validation only runs above this sample size. */
export const MIN_SAMPLES_FOR_HOLDOUT = 50
/** Minimum Brier improvement required to activate. Ties do not activate. */
export const MIN_BRIER_IMPROVEMENT = 0.001

/** Master flag. With calibration disabled globally, nothing is ever applied. */
export function tenantCalibrationEnabled(): boolean {
  const raw = process.env.ENABLE_PROBABILITY_CALIBRATION
  return raw === '1' || (typeof raw === 'string' && raw.toLowerCase() === 'true')
}

export interface OutcomeSample {
  id: string
  opportunityId: string | null
  bidPursuitId: string | null
  submissionRecordId: string | null
  predicted: number
  observed: 0 | 1
  outcomeSource: string
  verification: OutcomeVerification
  observedAt: Date
}

/**
 * Deterministic holdout assignment. A stable hash of the sample identity means
 * the same sample always lands in the same split, so refits are reproducible.
 */
export function isHoldout(sampleKey: string, fraction: number = HOLDOUT_FRACTION): boolean {
  const digest = createHash('sha256').update(sampleKey).digest()
  // First 4 bytes → [0,1).
  const value = digest.readUInt32BE(0) / 0xffffffff
  return value < fraction
}

export function brierScore(samples: Array<{ predicted: number; observed: number }>): number | null {
  if (samples.length === 0) return null
  const sum = samples.reduce((acc, s) => acc + (s.predicted - s.observed) ** 2, 0)
  return Number((sum / samples.length).toFixed(6))
}

/** Log loss with clipping so a confident miss cannot produce Infinity. */
export function logLoss(samples: Array<{ predicted: number; observed: number }>, eps = 1e-6): number | null {
  if (samples.length === 0) return null
  const sum = samples.reduce((acc, s) => {
    const p = Math.min(1 - eps, Math.max(eps, s.predicted))
    return acc + -(s.observed * Math.log(p) + (1 - s.observed) * Math.log(1 - p))
  }, 0)
  return Number((sum / samples.length).toFixed(6))
}

export interface ReliabilityBin {
  lower: number
  upper: number
  count: number
  wins: number
  meanPredicted: number | null
  observedRate: number | null
}

export function reliabilityBins(
  samples: Array<{ predicted: number; observed: number }>,
  binCount = 10,
): ReliabilityBin[] {
  const bins: ReliabilityBin[] = Array.from({ length: binCount }, (_, i) => ({
    lower: i / binCount, upper: (i + 1) / binCount, count: 0, wins: 0, meanPredicted: null, observedRate: null,
  }))
  const sums = new Array(binCount).fill(0)
  for (const s of samples) {
    const p = Math.min(0.999999, Math.max(0, s.predicted))
    const idx = Math.min(binCount - 1, Math.floor(p * binCount))
    bins[idx].count++
    sums[idx] += p
    if (s.observed >= 0.5) bins[idx].wins++
  }
  return bins.map((b, i) => ({
    ...b,
    meanPredicted: b.count > 0 ? Number((sums[i] / b.count).toFixed(4)) : null,
    observedRate: b.count > 0 ? Number((b.wins / b.count).toFixed(4)) : null,
  }))
}

/**
 * Collect verified outcome samples for a tenant from real records.
 *
 * Sources, all human- or system-verified — never synthetic:
 *   SUBMISSION_OUTCOME  SubmissionRecord.outcome (WON/LOST), human-recorded
 *   CONTRACT_AWARD      a Contract exists against the opportunity (won)
 * Each opportunity contributes at most one sample per source, enforced by the
 * (firm, opportunity, source) unique key on CalibrationSample.
 */
export async function collectOutcomeSamples(
  consultingFirmId: string,
  options: { windowStart?: Date; now?: Date } = {},
): Promise<OutcomeSample[]> {
  const now = options.now ?? new Date()
  const windowStart = options.windowStart ?? new Date(now.getTime() - 3 * 365 * 86400000)
  const samples: OutcomeSample[] = []
  const seen = new Set<string>()

  const submissions = await prisma.submissionRecord.findMany({
    where: {
      consultingFirmId,
      outcome: { in: [SubmissionOutcome.WON, SubmissionOutcome.LOST] },
      outcomeRecordedAt: { gte: windowStart },
    },
    select: {
      id: true, opportunityId: true, outcome: true, outcomeRecordedAt: true, submittedAt: true,
      opportunity: { select: { probabilityScore: true, isDemo: true } },
    },
    take: 5000,
  })

  for (const s of submissions) {
    if (s.opportunity.isDemo) continue
    const key = `${s.opportunityId}:SUBMISSION_OUTCOME`
    if (seen.has(key)) continue
    seen.add(key)
    samples.push({
      id: key,
      opportunityId: s.opportunityId,
      bidPursuitId: null,
      submissionRecordId: s.id,
      // probabilityScore is the persisted RAW model probability (0..1 or 0..100
      // depending on age of the row) — normalized defensively.
      predicted: normalizeProbability(s.opportunity.probabilityScore),
      observed: s.outcome === SubmissionOutcome.WON ? 1 : 0,
      outcomeSource: 'SUBMISSION_OUTCOME',
      verification: OutcomeVerification.HUMAN_CONFIRMED,
      observedAt: s.outcomeRecordedAt ?? s.submittedAt ?? now,
    })
  }

  // A tracked contract against an opportunity is a verified win.
  const contracts = await prisma.contract.findMany({
    where: {
      consultingFirmId,
      opportunityId: { not: null },
      createdAt: { gte: windowStart },
      status: { notIn: ['DRAFT', 'CANCELLED'] },
    },
    select: {
      id: true, opportunityId: true, startDate: true, createdAt: true,
      opportunity: { select: { probabilityScore: true, isDemo: true } },
    },
    take: 5000,
  })

  for (const c of contracts) {
    if (!c.opportunityId || c.opportunity?.isDemo) continue
    const key = `${c.opportunityId}:CONTRACT_AWARD`
    if (seen.has(`${c.opportunityId}:SUBMISSION_OUTCOME`) || seen.has(key)) continue
    seen.add(key)
    samples.push({
      id: key,
      opportunityId: c.opportunityId,
      bidPursuitId: null,
      submissionRecordId: null,
      predicted: normalizeProbability(c.opportunity?.probabilityScore ?? 0),
      observed: 1,
      outcomeSource: 'CONTRACT_AWARD',
      verification: OutcomeVerification.SYSTEM_DERIVED,
      observedAt: c.startDate ?? c.createdAt,
    })
  }

  return samples.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())
}

/** Older rows stored probability as 0-100; newer as 0-1. Normalize to 0-1. */
export function normalizeProbability(value: number): number {
  if (!Number.isFinite(value)) return 0
  const p = value > 1 ? value / 100 : value
  return Math.min(1, Math.max(0, p))
}

export interface FitOutcome {
  activated: boolean
  calibrationId: string | null
  version: number | null
  state: CalibrationState
  reason: string
  sampleSize: number
  holdoutSize: number
  brierScore: number | null
  baselineBrierScore: number | null
  improvement: number | null
}

/**
 * Fit and evaluate a tenant calibration. Activation requires ALL of:
 *   1. sample size >= minSampleSize
 *   2. both classes present (a single-class dataset cannot calibrate)
 *   3. a finite, valid Platt fit
 *   4. Brier improvement over the uncalibrated baseline ON THE HOLDOUT
 *      (or, below the holdout threshold, on the training set — reported as such)
 *      of at least MIN_BRIER_IMPROVEMENT
 * Otherwise the model is persisted as EVALUATED or REJECTED with the reason,
 * and the previously accepted calibration keeps running.
 */
export async function fitTenantCalibration(
  consultingFirmId: string,
  options: { minSampleSize?: number; now?: Date; actorUserId?: string } = {},
): Promise<FitOutcome> {
  const now = options.now ?? new Date()
  const minSampleSize = options.minSampleSize ?? DEFAULT_MIN_SAMPLE
  const samples = await collectOutcomeSamples(consultingFirmId, { now })

  const reject = async (state: CalibrationState, reason: string): Promise<FitOutcome> => ({
    activated: false, calibrationId: null, version: null, state, reason,
    sampleSize: samples.length, holdoutSize: 0,
    brierScore: null, baselineBrierScore: null, improvement: null,
  })

  if (samples.length < minSampleSize) {
    return reject(
      CalibrationState.DRAFT,
      `Only ${samples.length} verified outcome(s); ${minSampleSize} are required. Scores stay RAW until enough real outcomes are recorded.`,
    )
  }

  const wins = samples.filter((s) => s.observed === 1).length
  if (wins === 0 || wins === samples.length) {
    return reject(
      CalibrationState.REJECTED,
      `All ${samples.length} recorded outcomes are ${wins === 0 ? 'losses' : 'wins'}. A single-class dataset cannot produce a meaningful calibration.`,
    )
  }

  const useHoldout = samples.length >= MIN_SAMPLES_FOR_HOLDOUT
  const train = useHoldout ? samples.filter((s) => !isHoldout(s.id)) : samples
  const holdout = useHoldout ? samples.filter((s) => isHoldout(s.id)) : []

  if (useHoldout && (train.length < 10 || holdout.length < 5)) {
    return reject(CalibrationState.REJECTED, 'The deterministic holdout split left too few samples on one side to validate against.')
  }
  const trainWins = train.filter((s) => s.observed === 1).length
  if (trainWins === 0 || trainWins === train.length) {
    return reject(CalibrationState.REJECTED, 'The training split contains only one outcome class, so no calibration can be fitted.')
  }

  // Reuses the existing, tested Platt fitter. It returns null for degenerate or
  // too-small inputs rather than throwing.
  const params = fitPlatt(train.map((s) => ({ predicted: s.predicted, observed: s.observed })))
  if (!params) {
    return reject(
      CalibrationState.REJECTED,
      'The fitter rejected this dataset (too few points after the split, or a single outcome class). No calibration was produced.',
    )
  }
  if (!Number.isFinite(params.A) || !Number.isFinite(params.B)) {
    return reject(CalibrationState.REJECTED, 'The fitted parameters are not finite, so the calibration is unusable.')
  }

  // Evaluate on held-out data where it exists, otherwise on the training set —
  // and say which was used.
  const evalSet = useHoldout ? holdout : train
  const baselinePairs = evalSet.map((s) => ({ predicted: s.predicted, observed: s.observed }))
  const calibratedPairs = evalSet.map((s) => ({ predicted: applyPlatt(s.predicted, params), observed: s.observed }))

  const baselineBrier = brierScore(baselinePairs)
  const calibratedBrier = brierScore(calibratedPairs)
  const baselineLl = logLoss(baselinePairs)
  const calibratedLl = logLoss(calibratedPairs)
  const improvement = baselineBrier !== null && calibratedBrier !== null
    ? Number((baselineBrier - calibratedBrier).toFixed(6))
    : null

  const lastVersion = await prisma.tenantCalibration.findFirst({
    where: { consultingFirmId },
    orderBy: { version: 'desc' },
    select: { version: true },
  })
  const version = (lastVersion?.version ?? 0) + 1

  const meetsBar = improvement !== null && improvement >= MIN_BRIER_IMPROVEMENT
  const evalLabel = useHoldout ? `held-out set of ${holdout.length}` : `training set of ${train.length} (too few samples for a holdout)`

  const created = await prisma.tenantCalibration.create({
    data: {
      consultingFirmId,
      version,
      method: TENANT_CALIBRATION_METHOD,
      methodVersion: TENANT_CALIBRATION_METHOD_VERSION,
      params: { A: params.A, B: params.B, fittedAt: now.toISOString(), sampleSize: train.length } as Prisma.InputJsonValue,
      sampleSize: samples.length,
      minSampleSize,
      trainingStart: samples[0].observedAt,
      trainingEnd: samples[samples.length - 1].observedAt,
      holdoutSize: holdout.length,
      brierScore: calibratedBrier,
      baselineBrierScore: baselineBrier,
      logLoss: calibratedLl,
      baselineLogLoss: baselineLl,
      reliabilityBins: JSON.parse(JSON.stringify(reliabilityBins(baselinePairs))) as Prisma.InputJsonValue,
      improvement,
      state: meetsBar ? CalibrationState.EVALUATED : CalibrationState.REJECTED,
      rejectionReason: meetsBar
        ? null
        : `Calibrated Brier ${calibratedBrier} did not beat the uncalibrated baseline ${baselineBrier} by at least ${MIN_BRIER_IMPROVEMENT} on the ${evalLabel}. Not activated — scores remain uncalibrated.`,
      stalenessDays: DEFAULT_STALENESS_DAYS,
    },
  })

  // Persist the samples used, so the evidence behind a calibration is auditable.
  for (const s of samples) {
    await prisma.calibrationSample.upsert({
      where: {
        consultingFirmId_opportunityId_outcomeSource: {
          consultingFirmId, opportunityId: s.opportunityId ?? '', outcomeSource: s.outcomeSource,
        },
      },
      create: {
        consultingFirmId,
        calibrationId: created.id,
        opportunityId: s.opportunityId,
        bidPursuitId: s.bidPursuitId,
        submissionRecordId: s.submissionRecordId,
        predictedProbability: s.predicted,
        observedOutcome: s.observed,
        outcomeSource: s.outcomeSource,
        verification: s.verification,
        isHoldout: useHoldout && isHoldout(s.id),
        observedAt: s.observedAt,
      },
      update: {
        calibrationId: created.id,
        predictedProbability: s.predicted,
        observedOutcome: s.observed,
        isHoldout: useHoldout && isHoldout(s.id),
      },
    })
  }

  if (!meetsBar) {
    return {
      activated: false, calibrationId: created.id, version, state: CalibrationState.REJECTED,
      reason: created.rejectionReason as string,
      sampleSize: samples.length, holdoutSize: holdout.length,
      brierScore: calibratedBrier, baselineBrierScore: baselineBrier, improvement,
    }
  }

  const activated = await activateCalibration(consultingFirmId, created.id, {
    now,
    actorUserId: options.actorUserId,
    reason: `Brier improved from ${baselineBrier} to ${calibratedBrier} (Δ ${improvement}) on the ${evalLabel}.`,
  })

  return {
    activated: true, calibrationId: created.id, version, state: activated.state,
    reason: activated.activationReason ?? '',
    sampleSize: samples.length, holdoutSize: holdout.length,
    brierScore: calibratedBrier, baselineBrierScore: baselineBrier, improvement,
  }
}

/**
 * Activate a calibration, deactivating whatever was active. The prior active
 * version is recorded on the new one so a rollback can restore it exactly.
 */
export async function activateCalibration(
  consultingFirmId: string,
  calibrationId: string,
  options: { now?: Date; actorUserId?: string; reason?: string } = {},
) {
  const now = options.now ?? new Date()
  const previous = await prisma.tenantCalibration.findFirst({
    where: { consultingFirmId, state: CalibrationState.ACTIVE },
    select: { id: true },
  })

  return prisma.$transaction(async (tx) => {
    if (previous) {
      await tx.tenantCalibration.update({
        where: { id: previous.id },
        data: { state: CalibrationState.ROLLED_BACK, deactivatedAt: now },
      })
    }
    const activated = await tx.tenantCalibration.update({
      where: { id: calibrationId },
      data: {
        state: CalibrationState.ACTIVE,
        activatedAt: now,
        activatedByUserId: options.actorUserId ?? null,
        activationReason: options.reason ?? null,
        rolledBackFromId: previous?.id ?? null,
        deactivatedAt: null,
      },
    })
    // §7.9 — the activation and CALIBRATION_UPDATED share this transaction, so
    // a rolled-back activation emits nothing. The nightly recalibration worker
    // produces DRAFT rows and never reaches here, so it emits nothing either.
    await emitCalibrationUpdated(tx, {
      consultingFirmId,
      calibrationId: activated.id,
      version: activated.version,
      previousCalibrationId: previous?.id ?? null,
      reason: 'ACTIVATED',
    })
    return activated
  })
}

/** Roll back to the version the current active calibration replaced. */
export async function rollbackCalibration(
  consultingFirmId: string,
  options: { now?: Date; actorUserId?: string } = {},
): Promise<{ restoredId: string | null; reason: string }> {
  const now = options.now ?? new Date()
  const active = await prisma.tenantCalibration.findFirst({
    where: { consultingFirmId, state: CalibrationState.ACTIVE },
  })
  if (!active) return { restoredId: null, reason: 'No calibration is currently active.' }
  if (!active.rolledBackFromId) {
    await prisma.tenantCalibration.update({
      where: { id: active.id },
      data: { state: CalibrationState.ROLLED_BACK, deactivatedAt: now },
    })
    return { restoredId: null, reason: 'Deactivated the active calibration. There was no prior accepted version to restore, so scoring returns to uncalibrated.' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.tenantCalibration.update({
      where: { id: active.id },
      data: { state: CalibrationState.ROLLED_BACK, deactivatedAt: now },
    })
    const restored = await tx.tenantCalibration.update({
      where: { id: active.rolledBackFromId! },
      data: {
        state: CalibrationState.ACTIVE,
        activatedAt: now,
        activatedByUserId: options.actorUserId ?? null,
        activationReason: `Restored by rollback from version ${active.version}.`,
        deactivatedAt: null,
      },
    })
    // A rollback genuinely changes which calibration is active, so it is a
    // real update the Intelligence Agent should re-read.
    await emitCalibrationUpdated(tx, {
      consultingFirmId,
      calibrationId: restored.id,
      version: restored.version,
      previousCalibrationId: active.id,
      reason: 'ROLLED_BACK',
    })
  })
  return { restoredId: active.rolledBackFromId, reason: `Rolled back from version ${active.version} to the previously accepted calibration.` }
}

export interface ActiveTenantCalibration {
  id: string
  version: number
  params: PlattParams
  sampleSize: number
  activatedAt: Date | null
  brierScore: number | null
  baselineBrierScore: number | null
  reliabilityBins: unknown
  isStale: boolean
}

/**
 * Load the tenant's active calibration, if any. A stale calibration is returned
 * flagged so callers fall back to RAW rather than applying an aged model.
 */
export async function getActiveTenantCalibration(
  consultingFirmId: string,
  now: Date = new Date(),
): Promise<ActiveTenantCalibration | null> {
  if (!tenantCalibrationEnabled()) return null
  const active = await prisma.tenantCalibration.findFirst({
    where: { consultingFirmId, state: CalibrationState.ACTIVE },
    orderBy: { version: 'desc' },
  })
  if (!active) return null

  const stored = active.params as { A?: number; B?: number } | null
  if (!stored || !Number.isFinite(stored.A) || !Number.isFinite(stored.B)) {
    logger.warn('Active tenant calibration has invalid params; ignoring', { consultingFirmId, calibrationId: active.id })
    return null
  }

  const ageDays = active.activatedAt ? (now.getTime() - active.activatedAt.getTime()) / 86400000 : Infinity
  return {
    id: active.id,
    version: active.version,
    params: {
      A: stored.A as number,
      B: stored.B as number,
      fittedAt: (active.activatedAt ?? active.createdAt).toISOString(),
      sampleSize: active.sampleSize,
      preBrier: active.baselineBrierScore ?? 0,
      postBrier: active.brierScore ?? 0,
    },
    sampleSize: active.sampleSize,
    activatedAt: active.activatedAt,
    brierScore: active.brierScore,
    baselineBrierScore: active.baselineBrierScore,
    reliabilityBins: active.reliabilityBins,
    isStale: ageDays > active.stalenessDays,
  }
}

/** Mark aged calibrations STALE so they stop being applied. */
export async function markStaleCalibrations(now: Date = new Date()): Promise<number> {
  const active = await prisma.tenantCalibration.findMany({
    where: { state: CalibrationState.ACTIVE },
    select: { id: true, activatedAt: true, stalenessDays: true },
  })
  const stale = active.filter((c) => {
    if (!c.activatedAt) return false
    return (now.getTime() - c.activatedAt.getTime()) / 86400000 > c.stalenessDays
  })
  if (stale.length === 0) return 0
  await prisma.tenantCalibration.updateMany({
    where: { id: { in: stale.map((c) => c.id) } },
    data: { state: CalibrationState.STALE },
  })
  return stale.length
}
