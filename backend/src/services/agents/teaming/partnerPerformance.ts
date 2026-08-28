// =============================================================
// §7.5 — Objective partner performance.
//
// WHAT THIS MEASURES, AND WHAT IT REFUSES TO
// Only deliverables a HUMAN explicitly attributed to a partner
// (`ContractDeliverable.partnerId`) are counted. A prime's own deliverable is
// never credited to — or held against — a subcontractor by inference, so a
// contract's overall record can never masquerade as a partner's record.
//
// Every rate carries its numerator and its denominator. Below the minimum
// sample the answer is INSUFFICIENT_DATA, not a small number dressed up as a
// judgement. One late deliverable is never a verdict.
//
// This module computes OBJECTIVE counts. It does not author subjective
// judgements: `humanNotes` and `isHumanVerified` belong to a person, and
// nothing here writes them.
// =============================================================
import { Prisma, type PartnerPerformanceRecord } from '@prisma/client'
import { prisma } from '../../../config/database'

export const PERFORMANCE_METHOD_VERSION = 'teaming-performance-v1'

/**
 * Fewer attributed deliverables than this and no rate is stated at all.
 * Five is the point at which a single outcome stops dominating the ratio.
 */
export const MINIMUM_SAMPLE_SIZE = 5

/** At or above this, the sample is strong enough to compare across periods. */
export const SUFFICIENT_SAMPLE_SIZE = 10

/**
 * A period must lose at least this many percentage points against a comparable
 * prior period before the decline policy will say anything at all.
 */
export const DECLINE_THRESHOLD_PCT = 20

/** The deterministic label the decline policy may set. Never a human judgement. */
export const DECLINE_LABEL = 'PERFORMANCE_DECLINE_DETECTED'

export type DataSufficiency = 'INSUFFICIENT_DATA' | 'PARTIAL' | 'SUFFICIENT'

/** A rate is always a fraction. A bare percentage is not an acceptable answer. */
export interface Rate {
  numerator: number
  denominator: number
  /** Null whenever the denominator is zero — never silently 0%. */
  percent: number | null
}

export interface PartnerPerformanceMetrics {
  onTimeRate: Rate
  acceptanceRate: Rate
  rejectionRate: Rate
  issueRate: Rate
}

export interface PartnerPerformanceComputation {
  partnerId: string
  partnerName: string
  periodStart: Date
  periodEnd: Date
  engagementCount: number
  deliverablesDue: number
  deliverablesOnTime: number
  deliverablesLate: number
  deliverablesAccepted: number
  deliverablesRejected: number
  issuesRaised: number
  issueSeverityCounts: Record<string, number>
  sampleSize: number
  dataSufficiency: DataSufficiency
  metrics: PartnerPerformanceMetrics
  evidenceRecordIds: string[]
  limitations: string[]
}

export interface PerformanceDecline {
  declined: boolean
  reason: string | null
  metric: 'onTimeRate' | 'acceptanceRate' | null
  previousPercent: number | null
  currentPercent: number | null
  deltaPct: number | null
  previousSampleSize: number
  currentSampleSize: number
}

const rate = (numerator: number, denominator: number): Rate => ({
  numerator,
  denominator,
  percent: denominator > 0 ? Math.round((numerator / denominator) * 100) : null,
})

function sufficiencyFor(sampleSize: number): DataSufficiency {
  if (sampleSize < MINIMUM_SAMPLE_SIZE) return 'INSUFFICIENT_DATA'
  if (sampleSize < SUFFICIENT_SAMPLE_SIZE) return 'PARTIAL'
  return 'SUFFICIENT'
}

/**
 * A deliverable counts as on time when it was submitted on or before its due
 * date. A deliverable with no due date, or none submitted, cannot answer the
 * question and is excluded from the on-time denominator rather than counted
 * against the partner.
 */
function isOnTime(d: { dueDate: Date | null; submissionDate: Date | null }): boolean | null {
  if (!d.dueDate || !d.submissionDate) return null
  return d.submissionDate.getTime() <= d.dueDate.getTime()
}

/**
 * Objective performance for one partner over one period.
 *
 * TENANT SCOPE: every read below filters on `consultingFirmId`. Two firms may
 * both know the same company; neither may see the other's record of it.
 */
export async function computePartnerPerformance(args: {
  consultingFirmId: string
  partnerId: string
  periodStart: Date
  periodEnd: Date
}): Promise<PartnerPerformanceComputation | null> {
  const partner = await prisma.partner.findFirst({
    where: { id: args.partnerId, consultingFirmId: args.consultingFirmId },
    select: { id: true, name: true },
  })
  if (!partner) return null

  const deliverables = await prisma.contractDeliverable.findMany({
    where: {
      consultingFirmId: args.consultingFirmId,
      partnerId: args.partnerId,
      isArchived: false,
      OR: [
        { dueDate: { gte: args.periodStart, lte: args.periodEnd } },
        { submissionDate: { gte: args.periodStart, lte: args.periodEnd } },
      ],
    },
    select: {
      id: true, contractId: true, dueDate: true, submissionDate: true,
      status: true, acceptanceStatus: true, rejectionReason: true,
    },
    orderBy: { id: 'asc' },
    take: 2000,
  })

  const limitations: string[] = []

  if (deliverables.length === 0) {
    limitations.push(
      `No deliverable in this period is attributed to ${partner.name}. Performance is computed only from work explicitly linked to a partner, so an unattributed contract deliverable is never counted.`,
    )
    return {
      partnerId: partner.id,
      partnerName: partner.name,
      periodStart: args.periodStart,
      periodEnd: args.periodEnd,
      engagementCount: 0,
      deliverablesDue: 0,
      deliverablesOnTime: 0,
      deliverablesLate: 0,
      deliverablesAccepted: 0,
      deliverablesRejected: 0,
      issuesRaised: 0,
      issueSeverityCounts: {},
      sampleSize: 0,
      dataSufficiency: 'INSUFFICIENT_DATA',
      metrics: {
        onTimeRate: rate(0, 0),
        acceptanceRate: rate(0, 0),
        rejectionRate: rate(0, 0),
        issueRate: rate(0, 0),
      },
      evidenceRecordIds: [],
      limitations,
    }
  }

  let onTime = 0
  let late = 0
  let timingUnknown = 0
  let accepted = 0
  let rejected = 0
  let acceptanceDecided = 0

  for (const d of deliverables) {
    const timing = isOnTime(d)
    if (timing === null) timingUnknown += 1
    else if (timing) onTime += 1
    else late += 1

    if (d.acceptanceStatus === 'ACCEPTED' || d.status === 'ACCEPTED') {
      accepted += 1
      acceptanceDecided += 1
    } else if (d.acceptanceStatus === 'REJECTED' || d.status === 'REJECTED') {
      rejected += 1
      acceptanceDecided += 1
    }
  }

  // An issue is an objective, recorded rejection — not an opinion.
  const issuesRaised = rejected
  const issueSeverityCounts: Record<string, number> = rejected > 0 ? { REJECTION: rejected } : {}

  const timingDecided = onTime + late
  if (timingUnknown > 0) {
    limitations.push(
      `${timingUnknown} attributed deliverable(s) have no due date or no submission date, so they cannot answer the on-time question and are excluded from that denominator rather than counted as late.`,
    )
  }
  if (acceptanceDecided < deliverables.length) {
    limitations.push(
      `${deliverables.length - acceptanceDecided} attributed deliverable(s) have no recorded acceptance decision, so they are excluded from the acceptance denominator.`,
    )
  }

  const sampleSize = deliverables.length
  const dataSufficiency = sufficiencyFor(sampleSize)
  if (dataSufficiency === 'INSUFFICIENT_DATA') {
    limitations.push(
      `Only ${sampleSize} attributed deliverable(s) fall in this period (minimum ${MINIMUM_SAMPLE_SIZE}). Counts are shown, but no rate is stated as a performance judgement.`,
    )
  }

  const contractIds = new Set(deliverables.map((d) => d.contractId))

  return {
    partnerId: partner.id,
    partnerName: partner.name,
    periodStart: args.periodStart,
    periodEnd: args.periodEnd,
    engagementCount: contractIds.size,
    deliverablesDue: sampleSize,
    deliverablesOnTime: onTime,
    deliverablesLate: late,
    deliverablesAccepted: accepted,
    deliverablesRejected: rejected,
    issuesRaised,
    issueSeverityCounts,
    sampleSize,
    dataSufficiency,
    metrics: {
      onTimeRate: rate(onTime, timingDecided),
      acceptanceRate: rate(accepted, acceptanceDecided),
      rejectionRate: rate(rejected, acceptanceDecided),
      issueRate: rate(issuesRaised, sampleSize),
    },
    evidenceRecordIds: deliverables.map((d) => d.id),
    limitations,
  }
}

/**
 * The decline policy. Deliberately hard to trigger.
 *
 * It requires a sufficient CURRENT sample, a sufficient PRIOR sample, and a
 * drop of at least DECLINE_THRESHOLD_PCT percentage points. A single failed
 * deliverable can never satisfy all three.
 */
export function assessPerformanceDecline(
  current: PartnerPerformanceComputation,
  previous: Pick<PartnerPerformanceRecord, 'sampleSize' | 'computedMetrics'> | null,
): PerformanceDecline {
  const empty: PerformanceDecline = {
    declined: false,
    reason: null,
    metric: null,
    previousPercent: null,
    currentPercent: null,
    deltaPct: null,
    previousSampleSize: previous?.sampleSize ?? 0,
    currentSampleSize: current.sampleSize,
  }

  if (current.dataSufficiency === 'INSUFFICIENT_DATA') {
    return { ...empty, reason: 'The current period does not have enough attributed deliverables to judge a trend.' }
  }
  if (!previous) {
    return { ...empty, reason: 'No comparable prior period exists, so no trend can be stated.' }
  }
  if (previous.sampleSize < MINIMUM_SAMPLE_SIZE) {
    return { ...empty, reason: 'The prior period does not have enough attributed deliverables to compare against.' }
  }

  const prior = previous.computedMetrics as unknown as Partial<PartnerPerformanceMetrics> | null

  for (const metric of ['onTimeRate', 'acceptanceRate'] as const) {
    const previousPercent = prior?.[metric]?.percent ?? null
    const currentPercent = current.metrics[metric].percent
    if (previousPercent === null || currentPercent === null) continue

    const deltaPct = previousPercent - currentPercent
    if (deltaPct >= DECLINE_THRESHOLD_PCT) {
      const label = metric === 'onTimeRate' ? 'On-time delivery' : 'Deliverable acceptance'
      return {
        declined: true,
        metric,
        previousPercent,
        currentPercent,
        deltaPct,
        previousSampleSize: previous.sampleSize,
        currentSampleSize: current.sampleSize,
        reason:
          `${label} fell from ${previousPercent}% to ${currentPercent}% (${deltaPct} points) between comparable periods, ` +
          `across ${previous.sampleSize} and ${current.sampleSize} attributed deliverable(s). This is an objective measurement, not a judgement of the partner.`,
      }
    }
  }

  return { ...empty, reason: 'No metric fell far enough between comparable periods to report a decline.' }
}

/**
 * Persist one period's record.
 *
 * Human-owned columns (`isHumanVerified`, `humanNotes`) are absent from both
 * the create and the update payload, so a person's note survives every refresh.
 */
export async function persistPartnerPerformance(args: {
  consultingFirmId: string
  computation: PartnerPerformanceComputation
  decline: PerformanceDecline
  contractId?: string | null
  opportunityId?: string | null
}): Promise<{ record: PartnerPerformanceRecord; changed: boolean }> {
  const { computation, decline } = args

  const payload = {
    contractId: args.contractId ?? null,
    opportunityId: args.opportunityId ?? null,
    engagementCount: computation.engagementCount,
    deliverablesDue: computation.deliverablesDue,
    deliverablesOnTime: computation.deliverablesOnTime,
    deliverablesLate: computation.deliverablesLate,
    deliverablesAccepted: computation.deliverablesAccepted,
    deliverablesRejected: computation.deliverablesRejected,
    issuesRaised: computation.issuesRaised,
    issueSeverityCounts: computation.issueSeverityCounts as Prisma.InputJsonObject,
    sampleSize: computation.sampleSize,
    dataSufficiency: computation.dataSufficiency,
    computedMetrics: JSON.parse(JSON.stringify(computation.metrics)) as Prisma.InputJsonObject,
    evidenceRecordIds: computation.evidenceRecordIds,
    evidence: {
      limitations: computation.limitations,
      attributionRule:
        'Computed only from ContractDeliverable rows a human attributed to this partner. Unattributed contract work is never counted.',
    } as Prisma.InputJsonObject,
    derivedLabel: decline.declined ? DECLINE_LABEL : null,
    declineEvidence: JSON.parse(JSON.stringify(decline)) as Prisma.InputJsonObject,
    methodVersion: PERFORMANCE_METHOD_VERSION,
    generatedAt: new Date(),
  }

  const existing = await prisma.partnerPerformanceRecord.findUnique({
    where: {
      partnerId_periodStart_periodEnd: {
        partnerId: computation.partnerId,
        periodStart: computation.periodStart,
        periodEnd: computation.periodEnd,
      },
    },
  })

  const changed =
    !existing ||
    existing.sampleSize !== payload.sampleSize ||
    existing.deliverablesOnTime !== payload.deliverablesOnTime ||
    existing.deliverablesAccepted !== payload.deliverablesAccepted ||
    existing.deliverablesRejected !== payload.deliverablesRejected ||
    existing.derivedLabel !== payload.derivedLabel

  const record = await prisma.partnerPerformanceRecord.upsert({
    where: {
      partnerId_periodStart_periodEnd: {
        partnerId: computation.partnerId,
        periodStart: computation.periodStart,
        periodEnd: computation.periodEnd,
      },
    },
    create: {
      consultingFirmId: args.consultingFirmId,
      partnerId: computation.partnerId,
      periodStart: computation.periodStart,
      periodEnd: computation.periodEnd,
      ...payload,
    },
    update: payload,
  })

  return { record, changed }
}

/** The most recent period that ENDED before this one began. Tenant-scoped. */
export async function findPriorPeriod(
  consultingFirmId: string,
  partnerId: string,
  periodStart: Date,
): Promise<PartnerPerformanceRecord | null> {
  return prisma.partnerPerformanceRecord.findFirst({
    where: { consultingFirmId, partnerId, periodEnd: { lte: periodStart } },
    orderBy: { periodEnd: 'desc' },
  })
}

/**
 * A short, honest summary for the teaming plan.
 *
 * Below the minimum sample it says INSUFFICIENT_DATA rather than quoting a
 * percentage a reader would inevitably treat as a grade.
 */
export function summarisePerformance(record: PartnerPerformanceRecord | null): {
  available: boolean
  sampleSize: number
  dataSufficiency: DataSufficiency
  onTime: string
  acceptance: string
  detail: string
} {
  if (!record) {
    return {
      available: false,
      sampleSize: 0,
      dataSufficiency: 'INSUFFICIENT_DATA',
      onTime: 'INSUFFICIENT_DATA',
      acceptance: 'INSUFFICIENT_DATA',
      detail: 'No performance record exists for this partner. This is not the same as poor performance.',
    }
  }

  const metrics = record.computedMetrics as unknown as Partial<PartnerPerformanceMetrics> | null
  const onTime = metrics?.onTimeRate
  const acceptance = metrics?.acceptanceRate
  const insufficient = record.dataSufficiency === 'INSUFFICIENT_DATA'

  const fraction = (r: Rate | undefined): string => {
    if (!r || r.denominator === 0) return 'INSUFFICIENT_DATA'
    if (insufficient) return `${r.numerator} of ${r.denominator} (below the minimum sample — no rate stated)`
    return `${r.numerator} of ${r.denominator} (${r.percent}%)`
  }

  return {
    available: true,
    sampleSize: record.sampleSize,
    dataSufficiency: record.dataSufficiency as DataSufficiency,
    onTime: fraction(onTime),
    acceptance: fraction(acceptance),
    detail: insufficient
      ? `Based on ${record.sampleSize} attributed deliverable(s), which is below the minimum sample of ${MINIMUM_SAMPLE_SIZE}. Counts are shown without a performance judgement.`
      : `Based on ${record.sampleSize} attributed deliverable(s) in the measured period.`,
  }
}
