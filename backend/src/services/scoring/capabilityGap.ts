// =============================================================
// §6.2F — Capability gap analysis + partner-close recommendations.
//
// Reuses the EXISTING Partner records and the existing partnerMatch scoring.
// It produces RECOMMENDATIONS ONLY:
//   - it never creates a TeamingArrangement
//   - it never claims a partner guarantees eligibility
//   - it never reads another tenant's partner data (every query is firm-scoped)
// A human must select a partner before anything is linked.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { evaluateEligibility } from '../setAsideEligibility'
import { loadFirmMatchContext, computeForOpportunity } from '../discovery/matchRefresh'
import { emitCapabilityGapDetected, gapSnapshotWorsened } from '../agents/teaming/teamingEvents'

export const METHOD_VERSION = 'v1'

export interface PartnerRecommendation {
  partnerId: string
  partnerName: string
  /** 0..100 — share of the firm's open gaps this partner could close. */
  gapCloseScore: number
  closes: string[]
  remainingGaps: string[]
  worksharConsiderations: string[]
  why: string
  evidence: Record<string, unknown>
}

export interface GapAssessment {
  confirmedCoverage: string[]
  partialCoverage: string[]
  missingCapabilities: string[]
  missingCertifications: string[]
  missingEligibility: string[]
  capacityGaps: string[]
  geographyGaps: string[]
  vehicleGaps: string[]
  partnerRecommendations: PartnerRecommendation[]
  evidence: Record<string, unknown>
  limitations: string[]
}

interface PartnerRow {
  id: string
  name: string
  certifications: string[]
  primarySetAsides: string[]
  primaryNaicsCodes: string[]
  capabilities: string[]
  /** Partner.geography is a single free-text region string, not a list. */
  geography: string | null
}

/**
 * Score one partner against the open gaps. Deterministic and explainable.
 * Certification coverage is only credited when the partner record explicitly
 * carries that certification — never inferred from their NAICS or name.
 */
export function scorePartner(
  partner: PartnerRow,
  gaps: {
    missingCapabilities: string[]
    missingCertifications: string[]
    geographyGaps: string[]
    vehicleGaps: string[]
  },
): PartnerRecommendation {
  const closes: string[] = []
  const remaining: string[] = []

  const partnerCapText = [...partner.capabilities, ...partner.primaryNaicsCodes].map((c) => c.toLowerCase())
  for (const gap of gaps.missingCapabilities) {
    const needle = gap.toLowerCase()
    const covered = partnerCapText.some((c) => c.includes(needle) || needle.includes(c))
    if (covered) closes.push(`Capability: ${gap}`)
    else remaining.push(`Capability: ${gap}`)
  }

  const partnerCerts = new Set([...partner.certifications, ...partner.primarySetAsides].map((c) => c.toUpperCase()))
  for (const cert of gaps.missingCertifications) {
    if (partnerCerts.has(cert.toUpperCase())) closes.push(`Certification: ${cert}`)
    else remaining.push(`Certification: ${cert}`)
  }

  const reach = (partner.geography ?? '').toLowerCase().trim()
  for (const geo of gaps.geographyGaps) {
    const needle = geo.toLowerCase()
    const covered = Boolean(reach) && (reach.includes(needle) || needle.includes(reach) || /nationwide|conus/.test(reach))
    if (covered) closes.push(`Geography: ${geo}`)
    else remaining.push(`Geography: ${geo}`)
  }

  // Vehicle access is not tracked on Partner, so it is reported as unresolved
  // rather than guessed.
  for (const veh of gaps.vehicleGaps) remaining.push(`Contract vehicle: ${veh} (partner vehicle access is not tracked)`)

  const totalGaps = closes.length + remaining.length
  const gapCloseScore = totalGaps === 0 ? 0 : Math.round((closes.length / totalGaps) * 100)

  const worksharConsiderations: string[] = []
  if (closes.some((c) => c.startsWith('Certification:'))) {
    worksharConsiderations.push(
      'If the partner supplies the set-aside certification, limitations on subcontracting mean the certified party normally has to perform a required share of the work. Confirm the applicable percentage before committing.',
    )
  }
  if (closes.some((c) => c.startsWith('Capability:'))) {
    worksharConsiderations.push('Define which capability areas the partner owns before workshare percentages are agreed, so scope and price stay aligned.')
  }
  if (remaining.length > 0) {
    worksharConsiderations.push(`${remaining.length} gap(s) would remain even with this partner, so a second teaming partner or an internal build may still be required.`)
  }

  return {
    partnerId: partner.id,
    partnerName: partner.name,
    gapCloseScore,
    closes,
    remainingGaps: remaining,
    worksharConsiderations,
    why: closes.length === 0
      ? 'No recorded partner attribute matches an open gap on this opportunity.'
      : `Closes ${closes.length} of ${totalGaps} open gap(s): ${closes.slice(0, 3).join('; ')}${closes.length > 3 ? '; …' : ''}. This is a records-based suggestion — it does not establish that a teaming arrangement would qualify.`,
    evidence: {
      partnerCertifications: partner.certifications,
      partnerSetAsides: partner.primarySetAsides,
      partnerCapabilities: partner.capabilities,
      partnerNaics: partner.primaryNaicsCodes,
      partnerGeography: partner.geography ?? null,
    },
  }
}

/**
 * Assess gaps for one opportunity and persist the result.
 * Firm-scoped throughout — no cross-tenant partner data can be reached.
 */
export async function assessCapabilityGaps(
  consultingFirmId: string,
  opportunityId: string,
  now: Date = new Date(),
): Promise<GapAssessment | null> {
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: {
      id: true, title: true, description: true, agency: true, naicsCode: true, psc: true,
      setAsideType: true, placeOfPerformance: true, contractVehicle: true, responseDeadline: true,
    },
  })
  if (!opportunity) return null

  const ctx = await loadFirmMatchContext(consultingFirmId)
  const { match, eligibility } = computeForOpportunity(opportunity, ctx, now)

  const limitations: string[] = [...match.dataLimitations]

  // Coverage split from the capability dimension.
  const matchedIds = new Set(match.matchedCapabilityIds)
  const confirmedCoverage = ctx.firm.capabilities
    .filter((c) => matchedIds.has(c.id) && c.verification === 'VERIFIED')
    .map((c) => c.name)
  const partialCoverage = ctx.firm.capabilities
    .filter((c) => matchedIds.has(c.id) && c.verification !== 'VERIFIED')
    .map((c) => c.name)
  if (partialCoverage.length > 0) {
    limitations.push(`${partialCoverage.length} matching capability record(s) are unverified, so their coverage is recorded as partial.`)
  }

  // Missing capabilities: what the notice needs that nothing recorded covers.
  // Derived from the notice's own classification axes, never invented.
  const missingCapabilities: string[] = []
  if (ctx.firm.capabilities.length === 0) {
    missingCapabilities.push(`No capability records exist to match against NAICS ${opportunity.naicsCode}`)
  } else if (matchedIds.size === 0) {
    missingCapabilities.push(`No recorded capability aligns with NAICS ${opportunity.naicsCode}${opportunity.psc ? ` / PSC ${opportunity.psc}` : ''}`)
  }

  const missingCertifications = eligibility.state === 'ELIGIBLE' ? [] : eligibility.requiredCertKeys
  const missingEligibility: string[] = []
  if (eligibility.state === 'NOT_ELIGIBLE' || eligibility.state === 'POSSIBLY_ELIGIBLE') missingEligibility.push(eligibility.reason)
  if (eligibility.state === 'EXPIRING_BEFORE_DEADLINE') missingEligibility.push(eligibility.reason)
  if (eligibility.state === 'INSUFFICIENT_DATA') limitations.push(eligibility.reason)

  const capacityGaps = match.capacityWarning ? [match.capacityWarning] : []

  const geographyDim = match.dimensions.find((d) => d.key === 'geography')
  const geographyGaps = geographyDim?.score === 0 && opportunity.placeOfPerformance ? [opportunity.placeOfPerformance] : []
  const vehicleDim = match.dimensions.find((d) => d.key === 'vehicle')
  const vehicleGaps = vehicleDim?.score === 0 && opportunity.contractVehicle ? [opportunity.contractVehicle] : []

  // Partner recommendations — firm-scoped, recommendations only.
  const partners = await prisma.partner.findMany({
    where: { consultingFirmId },
    select: {
      id: true, name: true, certifications: true, primarySetAsides: true,
      primaryNaicsCodes: true, capabilities: true, geography: true,
    },
    take: 200,
  })

  const gapInput = { missingCapabilities, missingCertifications, geographyGaps, vehicleGaps }
  const hasGaps = missingCapabilities.length + missingCertifications.length + geographyGaps.length + vehicleGaps.length > 0

  const partnerRecommendations = hasGaps
    ? partners
        .map((p) => scorePartner(p as PartnerRow, gapInput))
        .filter((r) => r.gapCloseScore > 0)
        .sort((a, b) => b.gapCloseScore - a.gapCloseScore)
        .slice(0, 10)
    : []

  if (partners.length === 0 && hasGaps) {
    limitations.push('No partner records exist, so no gap-close recommendations could be produced.')
  }
  limitations.push('Partner recommendations are suggestions based on your own stored partner records. Selecting one does not create a teaming arrangement, and it does not establish that a partner would confer eligibility.')

  const assessment: GapAssessment = {
    confirmedCoverage,
    partialCoverage,
    missingCapabilities,
    missingCertifications,
    missingEligibility,
    capacityGaps,
    geographyGaps,
    vehicleGaps,
    partnerRecommendations,
    evidence: {
      matchScore: match.overallScore,
      dimensions: match.dimensions,
      eligibility: { state: eligibility.state, reason: eligibility.reason, evidence: eligibility.evidence },
      partnersConsidered: partners.length,
    },
    limitations,
  }

  // §7.5 — the upsert and its event share ONE transaction, and the event fires
  // only when the gap set became materially WORSE than the stored snapshot. An
  // unchanged or improved snapshot emits nothing, so a daily re-assessment never
  // re-pages anybody about the same gap.
  const previousSnapshot = await prisma.capabilityGapAssessment.findUnique({
    where: { opportunityId },
    select: { missingCapabilities: true, missingCertifications: true, missingEligibility: true },
  })
  const gapDelta = gapSnapshotWorsened(previousSnapshot, {
    missingCapabilities: assessment.missingCapabilities,
    missingCertifications: assessment.missingCertifications,
    missingEligibility: assessment.missingEligibility,
  })

  await prisma.$transaction(async (tx) => {
  await tx.capabilityGapAssessment.upsert({
    where: { opportunityId },
    create: {
      consultingFirmId,
      opportunityId,
      confirmedCoverage: assessment.confirmedCoverage,
      partialCoverage: assessment.partialCoverage,
      missingCapabilities: assessment.missingCapabilities,
      missingCertifications: assessment.missingCertifications,
      missingEligibility: assessment.missingEligibility,
      capacityGaps: assessment.capacityGaps,
      geographyGaps: assessment.geographyGaps,
      vehicleGaps: assessment.vehicleGaps,
      partnerRecommendations: JSON.parse(JSON.stringify(assessment.partnerRecommendations)) as Prisma.InputJsonValue,
      evidence: JSON.parse(JSON.stringify(assessment.evidence)) as Prisma.InputJsonValue,
      limitations: assessment.limitations,
      methodVersion: METHOD_VERSION,
      calculatedAt: now,
    },
    update: {
      confirmedCoverage: assessment.confirmedCoverage,
      partialCoverage: assessment.partialCoverage,
      missingCapabilities: assessment.missingCapabilities,
      missingCertifications: assessment.missingCertifications,
      missingEligibility: assessment.missingEligibility,
      capacityGaps: assessment.capacityGaps,
      geographyGaps: assessment.geographyGaps,
      vehicleGaps: assessment.vehicleGaps,
      partnerRecommendations: JSON.parse(JSON.stringify(assessment.partnerRecommendations)) as Prisma.InputJsonValue,
      evidence: JSON.parse(JSON.stringify(assessment.evidence)) as Prisma.InputJsonValue,
      limitations: assessment.limitations,
      calculatedAt: now,
    },
  })

    if (gapDelta.worsened) {
      await emitCapabilityGapDetected(
        {
          consultingFirmId,
          opportunityId,
          newGaps: gapDelta.newGaps,
          criticalGapCount: assessment.missingCertifications.length + assessment.missingEligibility.length,
        },
        tx,
      )
    }
  })

  return assessment
}
