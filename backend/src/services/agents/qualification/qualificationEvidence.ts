// =============================================================
// §7.4 — Qualification evidence loaders.
//
// Every function here READS canonical Section 5/6 records and shapes them for
// the recommendation. None of them computes a score of its own, and none of
// them writes anything.
//
// The honesty rules the loaders enforce:
//  * An incumbent is never invented. No award evidence → INSUFFICIENT_DATA.
//  * A competitor's observed award share is never called a win rate. The
//    `RateBasis` enum already distinguishes them and is carried through
//    verbatim, numerator and denominator included.
//  * Award value is never presented as a comparable unit price. Normalised
//    price benchmarking is §7.6's job; here it is PRICING_COMPARISON_NOT_AVAILABLE.
//  * Missing capacity data is UNKNOWN, never "has capacity".
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { assessCapabilityGaps, type GapAssessment } from '../../scoring/capabilityGap'
import { BASIS_LABELS } from '../../scoring/evidenceStats'
import type { CapabilityGapSeverity, CapacityState } from './borderlinePolicy'

// -------------------------------------------------------------
// Incumbent
// -------------------------------------------------------------

export interface IncumbentEvidence {
  available: boolean
  name: string | null
  uei: string | null
  retentionNumerator: number | null
  retentionDenominator: number | null
  retentionRatePct: number | null
  basis: string
  basisLabel: string
  sampleSize: number
  confidence: string
  evidenceSource: string | null
  explanation: string | null
  limitation: string | null
}

const NO_INCUMBENT: IncumbentEvidence = {
  available: false, name: null, uei: null,
  retentionNumerator: null, retentionDenominator: null, retentionRatePct: null,
  basis: 'INSUFFICIENT_DATA', basisLabel: BASIS_LABELS.INSUFFICIENT_DATA,
  sampleSize: 0, confidence: 'NOT_AVAILABLE', evidenceSource: null, explanation: null,
  limitation: 'No incumbent could be identified from the award evidence for this opportunity.',
}

/**
 * Identify the incumbent from recorded award history, then attach the Section 6
 * retention statistic if one exists for them.
 *
 * Returns NO_INCUMBENT rather than guessing. An opportunity with no award
 * history has no incumbent as far as this agent is concerned.
 */
export async function loadIncumbentEvidence(
  consultingFirmId: string,
  opportunityId: string,
): Promise<IncumbentEvidence> {
  const award = await prisma.awardHistory.findFirst({
    where: { opportunityId, opportunity: { consultingFirmId } },
    orderBy: { awardDate: 'desc' },
    select: { recipientName: true, recipientUei: true },
  })
  if (!award?.recipientName) return NO_INCUMBENT

  const stat = await prisma.incumbentRetentionStat.findFirst({
    where: { consultingFirmId, incumbentName: award.recipientName },
    orderBy: { lastRefreshedAt: 'desc' },
  })

  if (!stat) {
    return {
      ...NO_INCUMBENT,
      name: award.recipientName,
      uei: award.recipientUei,
      limitation: `An incumbent (${award.recipientName}) is recorded, but no retention statistic has been computed for them.`,
    }
  }

  // A rate is only stated when the canonical engine judged the denominator big
  // enough — `retentionRate` is null otherwise, and that null is respected.
  const rateAvailable = stat.retentionRate !== null && stat.similarAwardCount > 0
  return {
    available: rateAvailable,
    name: stat.incumbentName,
    uei: stat.incumbentUei,
    retentionNumerator: stat.retainedCount,
    retentionDenominator: stat.similarAwardCount,
    retentionRatePct: rateAvailable ? Math.round((stat.retentionRate as number) * 100) : null,
    basis: stat.basis,
    basisLabel: BASIS_LABELS[stat.basis] ?? stat.basis,
    sampleSize: stat.sampleSize,
    confidence: stat.confidence,
    evidenceSource: stat.evidenceSource,
    explanation: stat.explanation,
    limitation: rateAvailable
      ? null
      : `Retention evidence for ${stat.incumbentName} is based on ${stat.similarAwardCount} comparable award(s), too few to state a rate.`,
  }
}

// -------------------------------------------------------------
// Competitors
// -------------------------------------------------------------

export interface CompetitorEvidence {
  name: string
  uei: string | null
  awardsObserved: number
  totalObserved: number
  confirmedBids: number
  /** Populated only when the basis genuinely supports a percentage. */
  observedAwardSharePct: number | null
  /** TRUE only when the denominator is confirmed bid participation. */
  isConfirmedWinRate: boolean
  basis: string
  /** The exact wording the canonical engine chose. Rendered verbatim. */
  basisLabel: string
  sampleSize: number
  isIncumbent: boolean
}

/**
 * Load competitor statistics for the opportunity's agency/NAICS.
 *
 * `basisLabel` comes straight from the stored row, and `isConfirmedWinRate` is
 * derived from the enum rather than from the presence of a number — so an
 * observed award share can never be relabelled as a win rate downstream.
 */
export async function loadCompetitorEvidence(
  consultingFirmId: string,
  opportunity: { agency: string; naicsCode: string },
  limit = 5,
): Promise<{ competitors: CompetitorEvidence[]; limitation: string | null }> {
  const stats = await prisma.competitorAwardStat.findMany({
    where: {
      consultingFirmId,
      OR: [{ agency: opportunity.agency }, { naicsCode: opportunity.naicsCode }],
    },
    orderBy: [{ observedAwards: 'desc' }],
    take: limit,
  })

  if (stats.length === 0) {
    return { competitors: [], limitation: 'No competitor award evidence exists for this agency or NAICS code.' }
  }

  const competitors = stats.map((s) => {
    const isConfirmed = s.basis === 'CONFIRMED_WIN_RATE' && s.confirmedWinRate !== null
    const rate = isConfirmed ? s.confirmedWinRate : s.observedAwardShare
    return {
      name: s.competitorName,
      uei: s.uei,
      awardsObserved: s.observedAwards,
      totalObserved: isConfirmed ? s.confirmedBids : s.comparableAwardPool,
      confirmedBids: s.confirmedBids,
      observedAwardSharePct: rate !== null ? Math.round(rate * 100) : null,
      isConfirmedWinRate: isConfirmed,
      basis: s.basis,
      basisLabel: s.basisLabel,
      sampleSize: s.sampleSize,
      isIncumbent: s.isIncumbent,
    }
  })

  const anyConfirmed = competitors.some((c) => c.isConfirmedWinRate)
  return {
    competitors,
    limitation: anyConfirmed
      ? null
      : 'Confirmed competitor bid participation is unavailable, so these figures are observed award shares, not win rates.',
  }
}

// -------------------------------------------------------------
// Capability gaps
// -------------------------------------------------------------

export interface CapabilityEvidence {
  severity: CapabilityGapSeverity
  assessment: GapAssessment | null
  criticalGaps: string[]
  allGaps: string[]
  /** Requirements the Compliance Agent extracted, when available. */
  mandatoryRequirementGaps: number
  limitations: string[]
}

/**
 * Assess capability gaps through the canonical §6.2F engine, then sharpen the
 * severity using Compliance-extracted mandatory requirements when they exist.
 *
 * Severity rules — deliberately conservative:
 *   CRITICAL  missing eligibility or a missing certification (a bid cannot be
 *             compliant without them), or an unmet mandatory requirement
 *   MAJOR     missing capabilities
 *   MINOR     capacity/geography/vehicle gaps only
 */
export async function loadCapabilityEvidence(
  consultingFirmId: string,
  opportunityId: string,
  mandatoryRequirementGaps: number,
): Promise<CapabilityEvidence> {
  let assessment: GapAssessment | null = null
  const limitations: string[] = []
  try {
    assessment = await assessCapabilityGaps(consultingFirmId, opportunityId)
  } catch (err) {
    limitations.push(`Capability gap analysis could not run: ${(err as Error).message}`)
  }

  if (!assessment) {
    return {
      severity: 'NONE', assessment: null, criticalGaps: [], allGaps: [],
      mandatoryRequirementGaps,
      limitations: [...limitations, 'No capability gap assessment is available, so gap severity is unknown.'],
    }
  }

  const criticalGaps = [
    ...assessment.missingEligibility.map((g) => `eligibility: ${g}`),
    ...assessment.missingCertifications.map((g) => `certification: ${g}`),
  ]
  const allGaps = [
    ...criticalGaps,
    ...assessment.missingCapabilities.map((g) => `capability: ${g}`),
    ...assessment.capacityGaps.map((g) => `capacity: ${g}`),
    ...assessment.geographyGaps.map((g) => `geography: ${g}`),
    ...assessment.vehicleGaps.map((g) => `vehicle: ${g}`),
  ]

  let severity: CapabilityGapSeverity = 'NONE'
  if (criticalGaps.length > 0 || mandatoryRequirementGaps > 0) severity = 'CRITICAL'
  else if (assessment.missingCapabilities.length > 0) severity = 'MAJOR'
  else if (allGaps.length > 0) severity = 'MINOR'

  if (mandatoryRequirementGaps > 0) {
    criticalGaps.push(`${mandatoryRequirementGaps} mandatory solicitation requirement(s) are not yet complete`)
  }

  return {
    severity,
    assessment,
    criticalGaps,
    allGaps,
    mandatoryRequirementGaps,
    limitations: [...limitations, ...assessment.limitations],
  }
}

// -------------------------------------------------------------
// Capacity
// -------------------------------------------------------------

export interface CapacityEvidence {
  state: CapacityState
  activePursuits: number
  declaredConcurrentCapacity: number | null
  detail: string
  conflicts: string[]
  evidence: Record<string, unknown>
}

/**
 * Judge delivery capacity from recorded capability capacity limits and the
 * firm's live pursuit load.
 *
 * MISSING DATA IS NEVER "AVAILABLE". With no declared concurrent capacity the
 * answer is INSUFFICIENT_DATA, and the narrative says so explicitly — telling a
 * firm it has capacity because it recorded nothing would be the worst possible
 * inference here.
 */
export async function loadCapacityEvidence(
  consultingFirmId: string,
  excludePursuitId: string | null,
): Promise<CapacityEvidence> {
  const [capabilities, activePursuits] = await Promise.all([
    prisma.firmCapability.findMany({
      where: { consultingFirmId, isArchived: false, concurrentCapacity: { not: null } },
      select: { name: true, concurrentCapacity: true, capacityNote: true },
    }),
    prisma.bidPursuit.count({
      where: {
        consultingFirmId,
        pipelineStage: { in: ['QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED'] },
        ...(excludePursuitId ? { id: { not: excludePursuitId } } : {}),
      },
    }),
  ])

  if (capabilities.length === 0) {
    return {
      state: 'INSUFFICIENT_DATA',
      activePursuits,
      declaredConcurrentCapacity: null,
      detail:
        `${activePursuits} other pursuit(s) are active, but no capability records a concurrent capacity limit, ` +
        'so whether this pursuit can be delivered cannot be judged. This is not the same as having capacity.',
      conflicts: [],
      evidence: { activePursuits, capabilitiesWithCapacity: 0 },
    }
  }

  // The tightest declared limit governs — a firm is constrained by its scarcest
  // capability, not its most plentiful one.
  const limit = Math.min(...capabilities.map((c) => c.concurrentCapacity as number))
  const conflicts: string[] = []
  let state: CapacityState

  if (activePursuits >= limit) {
    state = 'OVER_CAPACITY'
    conflicts.push(
      `${activePursuits} active pursuit(s) already meet or exceed the tightest declared concurrent capacity of ${limit}.`,
    )
  } else if (activePursuits >= limit - 1) {
    state = 'NEAR_CAPACITY'
    conflicts.push(`${activePursuits} of ${limit} concurrent capacity is committed; this pursuit would fill it.`)
  } else {
    state = 'AVAILABLE'
  }

  const notes = capabilities.map((c) => c.capacityNote).filter((n): n is string => Boolean(n))

  return {
    state,
    activePursuits,
    declaredConcurrentCapacity: limit,
    detail:
      state === 'AVAILABLE'
        ? `${activePursuits} of ${limit} declared concurrent capacity is committed.`
        : conflicts[0],
    conflicts,
    evidence: { activePursuits, declaredConcurrentCapacity: limit, capacityNotes: notes },
  }
}

// -------------------------------------------------------------
// Past performance
// -------------------------------------------------------------

export interface PastPerformanceEvidence {
  relevantCount: number
  records: Array<{ id: string; title: string; agency: string | null; naicsCode: string | null; relevance: string }>
  limitations: string[]
}

/**
 * Find past-performance records relevant to this opportunity.
 *
 * Relevance is deterministic — exact NAICS, then agency. This agent only asks
 * WHETHER relevant experience exists; rewriting or adapting a narrative is the
 * Proposal Agent's job and is not done here.
 */
export async function loadPastPerformanceEvidence(
  consultingFirmId: string,
  opportunity: { agency: string; naicsCode: string },
): Promise<PastPerformanceEvidence> {
  const records = await prisma.pastPerformanceRecord.findMany({
    where: {
      consultingFirmId,
      isArchived: false,
      OR: [{ naicsCode: opportunity.naicsCode }, { customerAgency: opportunity.agency }],
    },
    select: { id: true, contractTitle: true, customerName: true, customerAgency: true, naicsCode: true },
    take: 10,
  })

  const limitations: string[] = []
  if (records.length === 0) {
    limitations.push('No past-performance record matches this opportunity\'s NAICS code or agency.')
  }

  return {
    relevantCount: records.length,
    records: records.map((r) => ({
      id: r.id,
      title: r.contractTitle ?? r.customerName,
      agency: r.customerAgency,
      naicsCode: r.naicsCode,
      relevance:
        r.naicsCode === opportunity.naicsCode && r.customerAgency === opportunity.agency
          ? 'NAICS and agency match'
          : r.naicsCode === opportunity.naicsCode
            ? 'NAICS match'
            : 'Agency match',
    })),
    limitations,
  }
}

// -------------------------------------------------------------
// Pricing
// -------------------------------------------------------------

export type PricingAvailability =
  | 'AVAILABLE'
  | 'PRICING_DATA_NOT_AVAILABLE'
  | 'PRICING_COMPARISON_NOT_AVAILABLE'

export interface PricingEvidence {
  availability: PricingAvailability
  validity: string | null
  basePrice: string | null
  baseProbability: number | null
  benchmarkSource: string | null
  sampleSize: number | null
  detail: string
}

/**
 * Read an existing §6.2E pricing sensitivity analysis if one exists.
 *
 * Never creates or mutates one — qualifying an opportunity must not manufacture
 * a pricing scenario. When none exists, qualification continues and simply
 * reports PRICING_DATA_NOT_AVAILABLE.
 *
 * NOTE ON INCUMBENT PRICING: award VALUE is not a comparable unit price, and no
 * normalised price benchmark dataset exists in this build. This function
 * therefore never derives a price comparison from award history — that is
 * §7.6's work, and asserting it here would be an unsupported claim.
 */
export async function loadPricingEvidence(
  consultingFirmId: string,
  opportunityId: string,
): Promise<PricingEvidence> {
  const analysis = await prisma.pricingSensitivityAnalysis.findFirst({
    where: { consultingFirmId, opportunityId },
    orderBy: { calculatedAt: 'desc' },
  })

  if (!analysis) {
    return {
      availability: 'PRICING_DATA_NOT_AVAILABLE',
      validity: null, basePrice: null, baseProbability: null, benchmarkSource: null, sampleSize: null,
      detail:
        'No pricing scenario exists for this opportunity, so pricing evidence did not contribute to this recommendation. ' +
        'A comparable-price benchmark against incumbent award history is not available in this build.',
    }
  }

  return {
    availability: 'AVAILABLE',
    validity: analysis.validity,
    basePrice: analysis.basePrice?.toFixed(2) ?? null,
    baseProbability: analysis.baseProbability !== null ? Math.round(analysis.baseProbability * 100) : null,
    benchmarkSource: analysis.benchmarkSource,
    sampleSize: analysis.sampleSize,
    detail:
      `A pricing sensitivity analysis exists (${analysis.validity}, ${analysis.sampleSize} sample(s)). ` +
      'It positions price against the recorded benchmark; it is not a comparable unit-price benchmark against the incumbent.',
  }
}

// -------------------------------------------------------------
// Compliance context
// -------------------------------------------------------------

export interface ComplianceEvidence {
  available: boolean
  overallStatus: string | null
  blockers: number
  humanReviewItems: number
  mandatoryRequirementGaps: number
  generatedAt: Date | null
  detail: string
}

/**
 * Read the latest §7.3 COMPLIANCE_STATUS for this opportunity.
 *
 * Compliance evidence IMPROVES qualification but is never required for it — an
 * absent status lowers data sufficiency rather than failing the run, and no
 * Compliance logic is reimplemented here.
 */
export async function loadComplianceEvidence(
  consultingFirmId: string,
  opportunityId: string,
): Promise<ComplianceEvidence> {
  const artifact = await prisma.agentArtifact.findFirst({
    where: {
      consultingFirmId,
      agentKey: 'COMPLIANCE',
      artifactType: 'COMPLIANCE_STATUS',
      supersededByArtifactId: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { structuredData: true, createdAt: true },
  })

  if (!artifact) {
    return {
      available: false, overallStatus: null, blockers: 0, humanReviewItems: 0,
      mandatoryRequirementGaps: 0, generatedAt: null,
      detail: 'No Compliance Agent status is available, so compliance evidence did not contribute.',
    }
  }

  const data = artifact.structuredData as {
    overallStatus?: string
    opportunities?: Array<{
      opportunityId: string
      overallStatus?: string
      matrix?: { mandatoryRequirements?: number; incompleteRequirements?: number }
      clauses?: { unresolvedFlowDowns?: number }
      submission?: { blockers?: string[] }
      statusReasons?: string[]
    }>
  }

  const row = data.opportunities?.find((o) => o.opportunityId === opportunityId) ?? null
  if (!row) {
    return {
      available: false, overallStatus: data.overallStatus ?? null, blockers: 0, humanReviewItems: 0,
      mandatoryRequirementGaps: 0, generatedAt: artifact.createdAt,
      detail: 'A Compliance Agent status exists but does not cover this opportunity, so compliance evidence did not contribute.',
    }
  }

  const blockers =
    (row.overallStatus === 'BLOCKED' ? 1 : 0) + (row.submission?.blockers?.length ?? 0)
  const humanReviewItems = row.clauses?.unresolvedFlowDowns ?? 0
  // Only an INCOMPLETE mandatory requirement is a gap; a complete one is not.
  const mandatoryRequirementGaps = Math.min(
    row.matrix?.mandatoryRequirements ?? 0,
    row.matrix?.incompleteRequirements ?? 0,
  )

  return {
    available: true,
    overallStatus: row.overallStatus ?? null,
    blockers,
    humanReviewItems,
    mandatoryRequirementGaps,
    generatedAt: artifact.createdAt,
    detail: `Compliance status for this opportunity is ${row.overallStatus ?? 'unknown'}.`,
  }
}

/** JSON-safe projection used when persisting evidence onto the recommendation. */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}
