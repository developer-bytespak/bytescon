// =============================================================
// §7.7 — Proposal outline construction.
//
// FULLY DETERMINISTIC. No LLM is involved in deciding what the proposal's
// structure should be — that comes from the solicitation and from the human
// sections that already exist.
//
// THE RULE THAT MATTERS MOST
// A mandatory requirement is never silently dropped. Every mandatory
// MatrixRequirement either maps to a section or appears in `unmapped` with a
// reason. There is no third outcome.
//
// SOURCE PRIORITY, strongest first:
//   1. an existing HUMAN-created ProposalSection
//   2. a human-verified SectionLmMapping
//   3. a high-confidence AI/deterministic SectionLmMapping
//   4. the requirement's own recorded proposalSection label
//   5. a safe deterministic fallback bucket
//
// A low-confidence automatic mapping never displaces human structure, and a
// human-created section is never proposed for deletion.
// =============================================================
import { createHash } from 'crypto'
import { prisma } from '../../../config/database'

export const OUTLINE_METHOD_VERSION = 'proposal-outline-v1'

/** Below this, an automatic L/M mapping is advisory only. */
export const HIGH_CONFIDENCE_MAPPING = 0.7

export type MappingSource =
  | 'EXISTING_HUMAN_SECTION'
  | 'VERIFIED_LM_MAPPING'
  | 'HIGH_CONFIDENCE_LM_MAPPING'
  | 'REQUIREMENT_LABEL'
  | 'DETERMINISTIC_FALLBACK'
  | 'UNMAPPED'

export type CoverageState = 'COVERED' | 'PARTIAL' | 'SKELETON_ONLY' | 'UNMAPPED' | 'HUMAN_REVIEW_REQUIRED'

export interface OutlineRequirement {
  requirementId: string
  section: string
  requirementText: string
  isMandatory: boolean
  isManuallyVerified: boolean
  verificationStatus: string
  lmRole: string | null
  ownerUserId: string | null
}

export interface OutlineItem {
  key: string
  title: string
  sectionNumber: string | null
  /** Null until a ProposalSection exists for this outline slot. */
  proposalSectionId: string | null
  isHumanCreated: boolean
  mappingSource: MappingSource
  requirementIds: string[]
  mandatoryRequirementIds: string[]
  sortOrder: number
}

export interface OutlineResult {
  methodVersion: string
  items: OutlineItem[]
  /** Mandatory requirements with nowhere to live. Never silently dropped. */
  unmapped: Array<{ requirementId: string; section: string; reason: string }>
  totalRequirements: number
  mandatoryRequirements: number
  mappedMandatoryRequirements: number
  ambiguities: string[]
  limitations: string[]
  outlineHash: string
}

/**
 * A safe bucket for a mandatory requirement that has no better home.
 *
 * Derived from the requirement's own solicitation section label, so it stays
 * traceable rather than inventing a proposal structure.
 */
function fallbackBucket(req: OutlineRequirement): { key: string; title: string } {
  const label = (req.section ?? '').trim()
  if (label) return { key: `SECTION:${label.toUpperCase()}`, title: `Response to ${label}` }
  return { key: 'SECTION:UNCLASSIFIED', title: 'Unclassified solicitation requirements' }
}

/**
 * Build the outline for one opportunity.
 *
 * TENANT SCOPE: every read filters on `consultingFirmId`.
 */
export async function buildOutline(args: {
  consultingFirmId: string
  opportunityId: string
  proposalId: string | null
}): Promise<OutlineResult> {
  const limitations: string[] = []
  const ambiguities: string[] = []

  // ---- requirements (the canonical §5.2/§6.3 matrix) ------------------
  const matrices = await prisma.complianceMatrix.findMany({
    where: { opportunityId: args.opportunityId },
    select: { id: true },
  })
  const requirementRows = matrices.length
    ? await prisma.matrixRequirement.findMany({
        where: { matrixId: { in: matrices.map((m) => m.id) } },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        take: 1000,
      })
    : []

  const requirements: OutlineRequirement[] = requirementRows.map((r) => ({
    requirementId: r.id,
    section: r.section,
    requirementText: r.requirementText,
    isMandatory: r.isMandatory,
    isManuallyVerified: r.isManuallyVerified,
    verificationStatus: r.verificationStatus,
    lmRole: r.lmRole,
    ownerUserId: r.ownerUserId,
  }))

  if (requirements.length === 0) {
    limitations.push('No compliance-matrix requirement exists for this opportunity, so no requirement-driven outline could be built. Run solicitation extraction first.')
  }

  // ---- existing sections (human structure is authoritative) ------------
  const sections = await prisma.proposalSection.findMany({
    where: { consultingFirmId: args.consultingFirmId, opportunityId: args.opportunityId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    select: {
      id: true, title: true, sectionNumber: true, sortOrder: true,
      isAiGenerated: true, status: true,
    },
  })

  // ---- L/M mappings ------------------------------------------------------
  const mappings = await prisma.sectionLmMapping.findMany({
    where: { consultingFirmId: args.consultingFirmId, opportunityId: args.opportunityId },
    select: {
      instructionRequirementId: true, evaluationRequirementId: true,
      proposalSectionId: true, confidence: true, verification: true,
      instructionSourceSection: true,
    },
  })

  const sectionById = new Map(sections.map((s) => [s.id, s]))
  const items = new Map<string, OutlineItem>()

  const ensureItem = (
    key: string,
    title: string,
    sectionNumber: string | null,
    proposalSectionId: string | null,
    isHumanCreated: boolean,
    mappingSource: MappingSource,
    sortOrder: number,
  ): OutlineItem => {
    const existing = items.get(key)
    if (existing) return existing
    const item: OutlineItem = {
      key, title, sectionNumber, proposalSectionId, isHumanCreated,
      mappingSource, requirementIds: [], mandatoryRequirementIds: [], sortOrder,
    }
    items.set(key, item)
    return item
  }

  // Every existing section becomes an outline slot first, so human structure
  // is never proposed for removal.
  for (const section of sections) {
    ensureItem(
      `SECTION_ID:${section.id}`,
      section.title,
      section.sectionNumber,
      section.id,
      // An agent-generated skeleton is not human structure.
      !section.isAiGenerated,
      'EXISTING_HUMAN_SECTION',
      section.sortOrder,
    )
  }

  // ---- place each requirement ---------------------------------------------
  const unmapped: OutlineResult['unmapped'] = []
  let mappedMandatory = 0

  for (const req of requirements) {
    const relevant = mappings.filter(
      (m) => m.instructionRequirementId === req.requirementId || m.evaluationRequirementId === req.requirementId,
    )

    // 2. a human-verified mapping to a real section
    // The canonical enum value for a human-confirmed mapping is CONFIRMED.
    const verified = relevant.find((m) => m.verification === 'CONFIRMED' && m.proposalSectionId && sectionById.has(m.proposalSectionId))
    // 3. a high-confidence automatic mapping to a real section
    const confident = relevant.find(
      (m) => m.proposalSectionId && sectionById.has(m.proposalSectionId) && m.confidence >= HIGH_CONFIDENCE_MAPPING,
    )
    const lowConfidence = relevant.filter(
      (m) => m.proposalSectionId && sectionById.has(m.proposalSectionId) && m.confidence < HIGH_CONFIDENCE_MAPPING,
    )

    let target: OutlineItem | null = null
    if (verified) {
      const section = sectionById.get(verified.proposalSectionId!)!
      target = ensureItem(`SECTION_ID:${section.id}`, section.title, section.sectionNumber, section.id, !section.isAiGenerated, 'VERIFIED_LM_MAPPING', section.sortOrder)
      if (target.mappingSource === 'EXISTING_HUMAN_SECTION') target.mappingSource = 'VERIFIED_LM_MAPPING'
    } else if (confident) {
      const section = sectionById.get(confident.proposalSectionId!)!
      target = ensureItem(`SECTION_ID:${section.id}`, section.title, section.sectionNumber, section.id, !section.isAiGenerated, 'HIGH_CONFIDENCE_LM_MAPPING', section.sortOrder)
    } else {
      // 4. the requirement's own recorded proposal-section label
      const label = (req.section ?? '').trim()
      const byLabel = sections.find(
        (s) => (s.sectionNumber ?? '').trim() === label || s.title.trim().toLowerCase() === label.toLowerCase(),
      )
      if (byLabel && label) {
        target = ensureItem(`SECTION_ID:${byLabel.id}`, byLabel.title, byLabel.sectionNumber, byLabel.id, !byLabel.isAiGenerated, 'REQUIREMENT_LABEL', byLabel.sortOrder)
        // Record HOW the requirement was placed, not merely that the slot
        // pre-existed. A slot only ever gains stronger placement evidence.
        if (target.mappingSource === 'EXISTING_HUMAN_SECTION') target.mappingSource = 'REQUIREMENT_LABEL'
      } else if (req.isMandatory) {
        // 5. a safe deterministic bucket, so nothing mandatory is dropped
        const bucket = fallbackBucket(req)
        target = ensureItem(bucket.key, bucket.title, label || null, null, false, 'DETERMINISTIC_FALLBACK', 1000 + items.size)
      }
    }

    if (lowConfidence.length > 0 && (!verified && !confident)) {
      // Recorded, never acted on: a low-confidence guess must not move human
      // structure, but a reader should know the guess exists.
      ambiguities.push(
        `Requirement ${req.requirementId} has ${lowConfidence.length} low-confidence L/M mapping(s) that were not used to place it. A person should confirm where it belongs.`,
      )
    }

    if (!target) {
      if (req.isMandatory) {
        unmapped.push({
          requirementId: req.requirementId,
          section: req.section,
          reason: 'No proposal section, verified mapping, confident mapping or section label could place this mandatory requirement.',
        })
      }
      continue
    }

    target.requirementIds.push(req.requirementId)
    if (req.isMandatory) {
      target.mandatoryRequirementIds.push(req.requirementId)
      if (target.proposalSectionId !== null) {
        mappedMandatory += 1
      } else {
        // A deterministic bucket holds the requirement so it is never lost,
        // but a bucket with no ProposalSection behind it is NOT a mapping.
        // Counting it as one would report coverage the proposal does not have.
        unmapped.push({
          requirementId: req.requirementId,
          section: req.section,
          reason: 'Placed in a deterministic bucket because no proposal section, verified mapping, confident mapping or section label could hold it. A section still needs to exist.',
        })
      }
    }
  }

  const mandatoryRequirements = requirements.filter((r) => r.isMandatory).length

  // The invariant, restated as an assertion a reader can check.
  if (mappedMandatory + unmapped.length !== mandatoryRequirements) {
    limitations.push(
      `Outline accounting mismatch: ${mappedMandatory} mapped plus ${unmapped.length} unmapped does not equal ${mandatoryRequirements} mandatory requirement(s). Treat the outline as incomplete.`,
    )
  }
  if (unmapped.length > 0) {
    limitations.push(`${unmapped.length} mandatory requirement(s) could not be placed and are listed explicitly rather than dropped.`)
  }

  const ordered = [...items.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key))

  return {
    methodVersion: OUTLINE_METHOD_VERSION,
    items: ordered,
    unmapped,
    totalRequirements: requirements.length,
    mandatoryRequirements,
    mappedMandatoryRequirements: mappedMandatory,
    ambiguities,
    limitations,
    outlineHash: buildOutlineHash(ordered, unmapped),
  }
}

/** Digest of the outline's structure. Excludes titles' incidental whitespace. */
export function buildOutlineHash(
  items: OutlineItem[],
  unmapped: OutlineResult['unmapped'],
): string {
  const material = {
    items: items
      .map((i) => `${i.key}:${i.proposalSectionId ?? 'none'}:${i.mappingSource}:${[...i.requirementIds].sort().join('|')}`)
      .sort(),
    unmapped: unmapped.map((u) => u.requirementId).sort(),
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

/**
 * Coverage for one outline slot.
 *
 * A skeleton is never coverage: a section that exists but has no substantive
 * draft reports SKELETON_ONLY, because "a heading exists" is not "the
 * requirement is answered".
 */
export function coverageFor(item: OutlineItem, section: { draft: string | null; status: string } | null): CoverageState {
  if (!item.proposalSectionId || !section) return item.mandatoryRequirementIds.length > 0 ? 'UNMAPPED' : 'HUMAN_REVIEW_REQUIRED'
  const draft = (section.draft ?? '').trim()
  if (draft.length === 0) return 'SKELETON_ONLY'
  // A draft that is only a bracketed placeholder is still not coverage.
  if (/^\[[^\]]*\]$/.test(draft)) return 'SKELETON_ONLY'
  if (section.status === 'APPROVED') return 'COVERED'
  return 'PARTIAL'
}

/**
 * Sections the agent may safely create as empty skeletons.
 *
 * Only for a deterministic fallback bucket holding a mandatory requirement
 * with nowhere else to go. Never for a slot a human already owns.
 */
export function skeletonCandidates(outline: OutlineResult): OutlineItem[] {
  return outline.items.filter(
    (i) => i.proposalSectionId === null && i.mappingSource === 'DETERMINISTIC_FALLBACK' && i.mandatoryRequirementIds.length > 0,
  )
}

/**
 * Recompute coverage after skeletons have been created for fallback buckets.
 *
 * `buildOutline` runs before the agent writes anything, so its counters
 * describe the world as it was on entry. Once a bucket is backed by a real
 * ProposalSection the requirement it holds IS mapped, and reporting it as
 * unmapped would understate coverage in the artifact the humans read.
 *
 * Mutates the outline in place and returns it. Idempotent: calling it when no
 * skeleton was created leaves every field untouched.
 */
export function reconcileOutlineCoverage(outline: OutlineResult): OutlineResult {
  const stillUnmapped = outline.unmapped.filter((u) => {
    const holder = outline.items.find((i) => i.mandatoryRequirementIds.includes(u.requirementId))
    return !holder || holder.proposalSectionId === null
  })
  if (stillUnmapped.length === outline.unmapped.length) return outline

  outline.mappedMandatoryRequirements = outline.mandatoryRequirements - stillUnmapped.length
  outline.unmapped = stillUnmapped
  outline.outlineHash = buildOutlineHash(outline.items, stillUnmapped)
  outline.limitations = outline.limitations.filter(
    (l) => !l.includes('could not be placed and are listed explicitly'),
  )
  if (stillUnmapped.length > 0) {
    outline.limitations.push(
      `${stillUnmapped.length} mandatory requirement(s) could not be placed and are listed explicitly rather than dropped.`,
    )
  }
  return outline
}
