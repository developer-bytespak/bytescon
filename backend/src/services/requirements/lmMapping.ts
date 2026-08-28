// =============================================================
// §6.3B — Section L ↔ Section M mapping.
//
// Deterministic derivation first: an L instruction and an M evaluation factor
// are proposed as related when their significant terms overlap strongly enough
// to be more than coincidence.
//
// Everything the spec forbids is enforced here:
//  - A mapping is NEVER auto-confirmed. It lands UNVERIFIED and a human
//    confirms or rejects it.
//  - Where the relationship is unclear, reviewRequired is set with a reason
//    rather than a mapping being fabricated.
//  - Re-running derivation NEVER deletes or overwrites a human-verified mapping.
//  - One-to-one, one-to-many and many-to-one are all representable; unmapped on
//    either side is a first-class result, not a failure.
// =============================================================
import { MappingVerification, Prisma } from '@prisma/client'
import { prisma } from '../../config/database'

export const MAPPING_METHOD = 'DETERMINISTIC'
/** Minimum term overlap for a proposed mapping. Below this, nothing is proposed. */
export const MIN_MAPPING_SIMILARITY = 0.28
/** Above this the relationship is clear enough not to need a review flag. */
export const CLEAR_MAPPING_SIMILARITY = 0.5

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'of', 'to', 'a', 'an', 'in', 'on', 'with', 'or', 'by', 'at', 'be',
  'shall', 'must', 'will', 'offeror', 'offerors', 'proposal', 'proposals', 'government',
  'contractor', 'section', 'volume', 'provide', 'provided', 'include', 'included', 'their',
  'this', 'that', 'which', 'evaluated', 'evaluation', 'submit', 'submitted',
])

export function significantTerms(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 3 && !STOP_WORDS.has(t)),
  )
}

/** Overlap coefficient — robust when the two texts differ a lot in length. */
export function termOverlap(a: string, b: string): number {
  const ta = significantTerms(a)
  const tb = significantTerms(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  ta.forEach((t) => { if (tb.has(t)) shared++ })
  return Number((shared / Math.min(ta.size, tb.size)).toFixed(4))
}

export interface DerivedMapping {
  instructionRequirementId: string
  instructionSourceSection: string
  instructionEvidence: string
  evaluationRequirementId: string
  evaluationSourceSection: string
  evaluationEvidence: string
  confidence: number
  relationshipExplanation: string
  reviewRequired: boolean
  reviewReason: string | null
}

export interface LmSide {
  id: string
  section: string
  requirementText: string
  evidenceText: string | null
}

/**
 * Pure derivation. Every L instruction is compared against every M factor; a
 * pair is proposed only above MIN_MAPPING_SIMILARITY.
 */
export function deriveMappingCandidates(instructions: LmSide[], evaluations: LmSide[]): DerivedMapping[] {
  const out: DerivedMapping[] = []
  for (const instruction of instructions) {
    for (const evaluation of evaluations) {
      const confidence = termOverlap(instruction.requirementText, evaluation.requirementText)
      if (confidence < MIN_MAPPING_SIMILARITY) continue

      const clear = confidence >= CLEAR_MAPPING_SIMILARITY
      out.push({
        instructionRequirementId: instruction.id,
        instructionSourceSection: instruction.section,
        instructionEvidence: (instruction.evidenceText ?? instruction.requirementText).slice(0, 1000),
        evaluationRequirementId: evaluation.id,
        evaluationSourceSection: evaluation.section,
        evaluationEvidence: (evaluation.evidenceText ?? evaluation.requirementText).slice(0, 1000),
        confidence,
        relationshipExplanation:
          `Instruction ${instruction.section} and evaluation factor ${evaluation.section} share ${(confidence * 100).toFixed(0)}% of their significant terms, ` +
          'which suggests the instruction produces the content this factor is evaluated on.',
        // Below the clear threshold the relationship is a suggestion, and says so.
        reviewRequired: !clear,
        reviewReason: clear
          ? null
          : `Term overlap is ${(confidence * 100).toFixed(0)}%, which is suggestive but not conclusive. Confirm or reject this mapping.`,
      })
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence)
}

/**
 * Derive and persist mappings for one opportunity.
 * Human-verified mappings are never touched.
 */
export async function deriveLmMappings(
  consultingFirmId: string,
  opportunityId: string,
  complianceMatrixId: string,
  extractionJobId: string | null,
  now: Date = new Date(),
): Promise<number> {
  const requirements = await prisma.matrixRequirement.findMany({
    where: { matrixId: complianceMatrixId, lmRole: { not: null } },
    select: { id: true, section: true, requirementText: true, evidenceText: true, lmRole: true },
  })

  const instructions = requirements.filter((r) => r.lmRole === 'INSTRUCTION')
  const evaluations = requirements.filter((r) => r.lmRole === 'EVALUATION')
  if (instructions.length === 0 || evaluations.length === 0) return 0

  const candidates = deriveMappingCandidates(instructions, evaluations)
  let created = 0

  for (const candidate of candidates) {
    const existing = await prisma.sectionLmMapping.findFirst({
      where: {
        consultingFirmId,
        opportunityId,
        instructionRequirementId: candidate.instructionRequirementId,
        evaluationRequirementId: candidate.evaluationRequirementId,
      },
      select: { id: true, verification: true },
    })

    // A confirmed or rejected mapping is a human decision and is final until a
    // human changes it.
    if (existing && existing.verification !== MappingVerification.UNVERIFIED) continue

    if (existing) {
      await prisma.sectionLmMapping.update({
        where: { id: existing.id },
        data: {
          confidence: candidate.confidence,
          relationshipExplanation: candidate.relationshipExplanation,
          reviewRequired: candidate.reviewRequired,
          reviewReason: candidate.reviewReason,
          extractionJobId,
        },
      })
      continue
    }

    await prisma.sectionLmMapping.create({
      data: {
        consultingFirmId,
        opportunityId,
        complianceMatrixId,
        instructionSourceSection: candidate.instructionSourceSection,
        instructionEvidence: candidate.instructionEvidence,
        instructionRequirementId: candidate.instructionRequirementId,
        evaluationSourceSection: candidate.evaluationSourceSection,
        evaluationEvidence: candidate.evaluationEvidence,
        evaluationRequirementId: candidate.evaluationRequirementId,
        relationshipExplanation: candidate.relationshipExplanation,
        confidence: candidate.confidence,
        origin: MAPPING_METHOD,
        // Never auto-confirmed.
        verification: MappingVerification.UNVERIFIED,
        reviewRequired: candidate.reviewRequired,
        reviewReason: candidate.reviewReason,
        extractionJobId,
      },
    })
    created++
  }

  return created
}

export interface LmCoverage {
  instructions: Array<{ id: string; section: string; text: string; mappedCount: number; proposalSectionId: string | null }>
  evaluations: Array<{ id: string; section: string; text: string; mappedCount: number }>
  unmappedInstructions: Array<{ id: string; section: string; text: string }>
  unmappedEvaluations: Array<{ id: string; section: string; text: string }>
  mappings: Array<{
    id: string
    instructionSourceSection: string
    evaluationSourceSection: string | null
    confidence: number
    verification: MappingVerification
    reviewRequired: boolean
    reviewReason: string | null
    relationshipExplanation: string | null
    proposalSectionId: string | null
    origin: string
  }>
  gaps: string[]
  proposalCoverage: { mappedToProposalSection: number; total: number }
}

/** Build the connected L/M view the §6.3B UI renders. */
export async function getLmCoverage(consultingFirmId: string, opportunityId: string): Promise<LmCoverage> {
  const matrix = await prisma.complianceMatrix.findUnique({
    where: { opportunityId },
    select: { id: true },
  })

  const requirements = matrix
    ? await prisma.matrixRequirement.findMany({
        where: { matrixId: matrix.id, lmRole: { not: null } },
        select: { id: true, section: true, requirementText: true, lmRole: true, proposalSectionId: true },
      })
    : []

  const mappings = await prisma.sectionLmMapping.findMany({
    where: { consultingFirmId, opportunityId },
    orderBy: [{ verification: 'asc' }, { confidence: 'desc' }],
  })

  const mappedInstructionIds = new Set(mappings.filter((m) => m.verification !== MappingVerification.REJECTED).map((m) => m.instructionRequirementId).filter(Boolean) as string[])
  const mappedEvaluationIds = new Set(mappings.filter((m) => m.verification !== MappingVerification.REJECTED).map((m) => m.evaluationRequirementId).filter(Boolean) as string[])

  const countFor = (id: string, key: 'instructionRequirementId' | 'evaluationRequirementId') =>
    mappings.filter((m) => m[key] === id && m.verification !== MappingVerification.REJECTED).length

  const instructions = requirements.filter((r) => r.lmRole === 'INSTRUCTION').map((r) => ({
    id: r.id, section: r.section, text: r.requirementText,
    mappedCount: countFor(r.id, 'instructionRequirementId'),
    proposalSectionId: r.proposalSectionId,
  }))
  const evaluations = requirements.filter((r) => r.lmRole === 'EVALUATION').map((r) => ({
    id: r.id, section: r.section, text: r.requirementText,
    mappedCount: countFor(r.id, 'evaluationRequirementId'),
  }))

  const unmappedInstructions = instructions.filter((i) => !mappedInstructionIds.has(i.id)).map(({ id, section, text }) => ({ id, section, text }))
  const unmappedEvaluations = evaluations.filter((e) => !mappedEvaluationIds.has(e.id)).map(({ id, section, text }) => ({ id, section, text }))

  const gaps: string[] = []
  if (unmappedInstructions.length > 0) gaps.push(`${unmappedInstructions.length} Section L instruction(s) have no evaluation factor mapped to them.`)
  if (unmappedEvaluations.length > 0) gaps.push(`${unmappedEvaluations.length} Section M evaluation factor(s) have no instruction mapped to them — check that your proposal actually addresses them.`)
  const unverified = mappings.filter((m) => m.verification === MappingVerification.UNVERIFIED).length
  if (unverified > 0) gaps.push(`${unverified} proposed mapping(s) are awaiting human confirmation.`)
  if (instructions.length === 0 && evaluations.length === 0) {
    gaps.push('No Section L or Section M requirements have been extracted yet, so no mapping can be shown.')
  }

  const mappedToProposalSection = mappings.filter((m) => m.proposalSectionId !== null).length

  return {
    instructions,
    evaluations,
    unmappedInstructions,
    unmappedEvaluations,
    mappings: mappings.map((m) => ({
      id: m.id,
      instructionSourceSection: m.instructionSourceSection,
      evaluationSourceSection: m.evaluationSourceSection,
      confidence: m.confidence,
      verification: m.verification,
      reviewRequired: m.reviewRequired,
      reviewReason: m.reviewReason,
      relationshipExplanation: m.relationshipExplanation,
      proposalSectionId: m.proposalSectionId,
      origin: m.origin,
    })),
    gaps,
    proposalCoverage: { mappedToProposalSection, total: mappings.length },
  }
}

export type LmMappingJson = Prisma.InputJsonValue
