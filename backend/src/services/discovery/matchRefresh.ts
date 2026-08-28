// =============================================================
// §6.1E/§6.1F — Persisting capability match + eligibility.
//
// Loads the firm's real records (capabilities, registration, certifications,
// past performance, partners), runs the two deterministic engines, and writes
// ONE OpportunityMatch snapshot per (firm, opportunity).
//
// The snapshot is a cache of a pure computation — it is always recomputed, never
// hand-edited, so it can be regenerated at any time without losing human input.
// =============================================================
import { EligibilityState, Prisma, PursuitStatus } from '@prisma/client'
import { prisma } from '../../config/database'
import { evaluateEligibility, EligibilityResult } from '../setAsideEligibility'
import {
  computeCapabilityMatch,
  dimensionScore,
  CapabilityMatchResult,
  MatchFirmInput,
  WeightingOptions,
} from '../capabilityMatch'
import { resolveEffectiveWeights } from '../agents/opportunity/pursuitFeedback'
import { HIGH_MATCH_SCORE } from '../agents/opportunity/policy'
import { crossedHighMatchThreshold, emitOpportunityMatchHigh } from '../agents/qualification/qualificationEvents'

export interface FirmMatchContext {
  firm: MatchFirmInput
  registration: {
    samStatus: string
    samExpiryDate: Date | null
    setAsideCerts: string[]
    naicsCodes: string[]
  } | null
  certifications: Array<{ id: string; name: string; category: string; expiryDate: Date | null; isArchived: boolean }>
  partnerCertifications: Array<{ partnerId: string; partnerName: string; certifications: string[] }>
  /**
   * §7.2 — the weighting in force for this firm. BASE unless an ADMIN has
   * applied a learned pursuit-preference adjustment. Resolved once per context
   * load, so a batch refresh cannot mix two weightings within one pass.
   */
  weighting: WeightingOptions
}

/**
 * Load everything the two engines need, once per firm, so a batch refresh does
 * not re-query per opportunity.
 */
export async function loadFirmMatchContext(consultingFirmId: string): Promise<FirmMatchContext> {
  const [capabilities, registration, certifications, pastPerformance, activePursuitCount, partners, effectiveWeights] = await Promise.all([
    prisma.firmCapability.findMany({
      where: { consultingFirmId, isArchived: false },
      select: {
        id: true, name: true, category: true, keywords: true, naicsCodes: true, pscCodes: true,
        geographies: true, contractVehicles: true, concurrentCapacity: true, capacityNote: true, verification: true,
      },
    }),
    prisma.registrationProfile.findUnique({
      where: { consultingFirmId },
      select: { samStatus: true, samExpiryDate: true, setAsideCerts: true, naicsCodes: true },
    }),
    prisma.certification.findMany({
      where: { consultingFirmId, isArchived: false },
      select: { id: true, name: true, category: true, expiryDate: true, isArchived: true },
    }),
    prisma.pastPerformanceRecord.findMany({
      where: { consultingFirmId, isArchived: false },
      select: { id: true, naicsCode: true, pscCode: true, customerAgency: true, isArchived: true, verificationStatus: true },
      take: 500,
    }),
    // Pursuits still in play — REVIEWING or SUBMITTED. PASSED is closed out.
    prisma.bidPursuit.count({
      where: { consultingFirmId, status: { in: [PursuitStatus.REVIEWING, PursuitStatus.SUBMITTED] } },
    }),
    prisma.partner.findMany({
      where: { consultingFirmId },
      // primarySetAsides is a declared status; certifications are the named
      // certification records. §6.1F normalizes and de-duplicates both.
      select: { id: true, name: true, certifications: true, primarySetAsides: true },
      take: 500,
    }),
    resolveEffectiveWeights(consultingFirmId),
  ])

  return {
    firm: {
      capabilities,
      registrationNaics: registration?.naicsCodes ?? [],
      pastPerformance: pastPerformance.map((p) => ({
        id: p.id,
        naicsCode: p.naicsCode,
        pscCode: p.pscCode,
        agency: p.customerAgency,
        isArchived: p.isArchived,
        verificationStatus: p.verificationStatus,
      })),
      activePursuitCount,
    },
    registration,
    certifications,
    partnerCertifications: partners.map((p) => ({
      partnerId: p.id,
      partnerName: p.name,
      certifications: [...new Set([...(p.certifications ?? []), ...(p.primarySetAsides ?? [])])],
    })),
    weighting: {
      weights: effectiveWeights.weights,
      weightProfile: effectiveWeights.profile,
      appliedSignalId: effectiveWeights.appliedSignalId,
    },
  }
}

export interface MatchComputation {
  match: CapabilityMatchResult
  eligibility: EligibilityResult
}

export function computeForOpportunity(
  opportunity: {
    id: string
    title: string
    description: string | null
    agency: string
    naicsCode: string
    psc: string | null
    setAsideType: string
    placeOfPerformance: string | null
    contractVehicle: string | null
    responseDeadline: Date
  },
  ctx: FirmMatchContext,
  now: Date = new Date(),
): MatchComputation {
  const eligibility = evaluateEligibility({
    setAsideType: opportunity.setAsideType,
    responseDeadline: opportunity.responseDeadline,
    naicsCode: opportunity.naicsCode,
    registration: ctx.registration,
    certifications: ctx.certifications,
    partnerCertifications: ctx.partnerCertifications,
    now,
  })
  const match = computeCapabilityMatch(opportunity, ctx.firm, eligibility, ctx.weighting)
  return { match, eligibility }
}

/** Upsert the snapshot for one opportunity. */
export async function refreshOpportunityMatch(
  consultingFirmId: string,
  opportunityId: string,
  ctx?: FirmMatchContext,
  now: Date = new Date(),
): Promise<MatchComputation | null> {
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: {
      id: true, title: true, description: true, agency: true, naicsCode: true, psc: true,
      setAsideType: true, placeOfPerformance: true, contractVehicle: true, responseDeadline: true,
    },
  })
  if (!opportunity) return null

  const context = ctx ?? (await loadFirmMatchContext(consultingFirmId))
  const computed = computeForOpportunity(opportunity, context, now)
  await persistMatch(consultingFirmId, opportunity.id, computed, now)
  return computed
}

export async function persistMatch(
  consultingFirmId: string,
  opportunityId: string,
  computed: MatchComputation,
  now: Date,
): Promise<void> {
  const { match, eligibility } = computed
  const data = {
    consultingFirmId,
    overallScore: match.overallScore,
    capabilityScore: dimensionScore(match, 'capability'),
    naicsScore: dimensionScore(match, 'naics'),
    pscScore: dimensionScore(match, 'psc'),
    certificationScore: dimensionScore(match, 'certification'),
    pastPerformanceScore: dimensionScore(match, 'pastPerformance'),
    geographyScore: dimensionScore(match, 'geography'),
    vehicleScore: dimensionScore(match, 'vehicle'),
    keywordScore: dimensionScore(match, 'keyword'),
    matchedCapabilityIds: match.matchedCapabilityIds,
    missingCapabilities: match.missingCapabilities,
    capacityWarning: match.capacityWarning,
    // §7.2 — the weighting is recorded alongside the dimensions so a score
    // produced under an applied pursuit-preference adjustment is always
    // distinguishable from a base match. The learned influence is never hidden.
    evidence: JSON.parse(JSON.stringify({
      dimensions: match.dimensions,
      weightProfile: match.weightProfile,
      appliedPursuitSignalId: match.appliedSignalId,
      baseOverallScore: match.baseOverallScore,
      ...(match.weightProfile === 'PURSUIT_ADJUSTED'
        ? {
            learnedAdjustmentNote:
              'This score uses a pursuit-preference weighting an administrator applied. ' +
              'baseOverallScore is the same evidence under the unadjusted Section 6 weighting. ' +
              'Eligibility is calculated independently and is unaffected.',
          }
        : {}),
    })) as Prisma.InputJsonValue,
    dataLimitations: match.dataLimitations,
    hasSufficientData: match.hasSufficientData,
    eligibility: eligibility.state,
    eligibilityReason: eligibility.reason,
    eligibilityEvidence: JSON.parse(JSON.stringify({
      evidence: eligibility.evidence,
      requiredCertKeys: eligibility.requiredCertKeys,
      partnerCoverage: eligibility.partnerCoverage,
      disclaimer: eligibility.disclaimer,
    })) as Prisma.InputJsonValue,
    expiringCertificationIds: eligibility.expiringCertificationIds,
    matchMethod: match.matchMethod,
    methodVersion: match.methodVersion,
    calculatedAt: now,
  }

  // §7.4 — the match write and OPPORTUNITY_MATCH_HIGH share ONE transaction, so
  // a rolled-back match emits no event. The event fires only on the CROSSING of
  // the threshold, so an unchanged high match never re-triggers qualification.
  await prisma.$transaction(async (tx) => {
    const previous = await tx.opportunityMatch.findUnique({
      where: { opportunityId },
      select: { overallScore: true },
    })

    await tx.opportunityMatch.upsert({
      where: { opportunityId },
      create: { opportunityId, ...data },
      update: data,
    })

    if (crossedHighMatchThreshold(previous?.overallScore ?? null, match.overallScore, HIGH_MATCH_SCORE)) {
      await emitOpportunityMatchHigh(tx, {
        consultingFirmId,
        opportunityId,
        overallScore: match.overallScore,
        previousScore: previous?.overallScore ?? null,
        threshold: HIGH_MATCH_SCORE,
        eligibility: eligibility.state,
      })
    }
  })
}

/**
 * Batch refresh for a firm. Bounded so one worker tick cannot run unbounded;
 * oldest snapshots are refreshed first.
 */
export async function refreshFirmMatches(
  consultingFirmId: string,
  options: { limit?: number; now?: Date } = {},
): Promise<{ refreshed: number; eligibleCount: number; insufficientData: number }> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? 200

  const opportunities = await prisma.opportunity.findMany({
    where: { consultingFirmId, isDemo: false, status: 'ACTIVE' },
    select: {
      id: true, title: true, description: true, agency: true, naicsCode: true, psc: true,
      setAsideType: true, placeOfPerformance: true, contractVehicle: true, responseDeadline: true,
      match: { select: { calculatedAt: true } },
    },
    orderBy: { responseDeadline: 'asc' },
    take: limit,
  })
  if (opportunities.length === 0) return { refreshed: 0, eligibleCount: 0, insufficientData: 0 }

  const ctx = await loadFirmMatchContext(consultingFirmId)
  let eligibleCount = 0
  let insufficientData = 0

  for (const opportunity of opportunities) {
    const computed = computeForOpportunity(opportunity, ctx, now)
    await persistMatch(consultingFirmId, opportunity.id, computed, now)
    if (computed.eligibility.state === EligibilityState.ELIGIBLE) eligibleCount++
    if (!computed.match.hasSufficientData) insufficientData++
  }

  return { refreshed: opportunities.length, eligibleCount, insufficientData }
}
