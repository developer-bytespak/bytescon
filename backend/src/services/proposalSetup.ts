// =============================================================
// A new proposal sets itself up, so writing can start straight away:
//   1. brings in the solicitation documents SAM.gov lists (if it has none yet);
//   2. builds the compliance matrix from them (if it has no requirements yet);
//   3. adds the sections (if it has none yet): from the verified requirements,
//      else from the requirements just read (marked as not verified yet), else
//      the standard sections.
// Verifying requirements stays a person's job in the Compliance Matrix (the
// submission checklist uses only verified ones); it no longer holds up the
// sections. Each step is skipped when its work is already there, and a step
// that can't run (no tokens, AI limit, no text) leaves the next one to carry on.
// proposal.setupStatus is PREPARING while this runs and DONE after, with
// setupNote saying what it did.
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { logAudit } from './auditService'
import { importSamAttachments } from './samAttachmentImport'
import { samAttachments } from './samNoticeDetails'
import { buildComplianceMatrix } from './complianceMatrixBuild'
import { buildOutlineFromRequirements, STANDARD_OUTLINE, STANDARD_OUTLINE_NOTE } from './proposalSectionDraft'

/** On unless PROPOSAL_AUTO_SETUP=off (the test suite sets it, so route tests drive each step themselves). */
export const proposalSetupEnabled = (): boolean => process.env.PROPOSAL_AUTO_SETUP !== 'off'

export const UNVERIFIED_OUTLINE_NOTE = 'From requirements read from the solicitation, not verified yet. Check them in the Compliance Matrix before you submit.'

type Requirement = { requirementText: string; proposalSection: string | null; sectionType: string; isMandatory: boolean; verificationStatus: string }

async function requirementsOf(consultingFirmId: string, opportunityId: string): Promise<Requirement[]> {
  const matrix = await prisma.complianceMatrix.findFirst({ where: { opportunityId, consultingFirmId }, select: { id: true } })
  if (!matrix) return []
  return prisma.matrixRequirement.findMany({
    where: { matrixId: matrix.id, verificationStatus: { not: 'REJECTED' } },
    select: { requirementText: true, proposalSection: true, sectionType: true, isMandatory: true, verificationStatus: true },
    orderBy: { sortOrder: 'asc' },
  })
}

/** Adds the first sections; returns how many and where they came from. */
async function addSections(consultingFirmId: string, proposal: { id: string; opportunityId: string }): Promise<{ count: number; from: 'VERIFIED' | 'UNVERIFIED' | 'STANDARD' }> {
  const requirements = await requirementsOf(consultingFirmId, proposal.opportunityId)
  const verified = requirements.filter((r) => r.verificationStatus === 'VERIFIED')
  const pick = verified.length ? { list: verified, from: 'VERIFIED' as const } : requirements.length ? { list: requirements, from: 'UNVERIFIED' as const } : null

  const rows = pick
    ? buildOutlineFromRequirements(pick.list).map((s) => ({
        title: s.title,
        outline: [...(pick.from === 'UNVERIFIED' ? [UNVERIFIED_OUTLINE_NOTE] : []), ...s.requirementPreview.map((r) => `- ${r}`)].join('\n'),
      }))
    : STANDARD_OUTLINE.map((s) => ({ title: s.title, outline: `${STANDARD_OUTLINE_NOTE}\n- ${s.guidance}` }))

  await prisma.$transaction(rows.map((r, i) => prisma.proposalSection.create({
    data: { consultingFirmId, opportunityId: proposal.opportunityId, proposalId: proposal.id, title: r.title, sortOrder: i, outline: r.outline },
  })))
  return { count: rows.length, from: pick?.from ?? 'STANDARD' }
}

export async function setUpProposal(consultingFirmId: string, proposalId: string, userId: string | null): Promise<void> {
  const proposal = await prisma.proposal.findFirst({ where: { id: proposalId, consultingFirmId }, select: { id: true, opportunityId: true } })
  if (!proposal) return
  await prisma.proposal.update({ where: { id: proposal.id }, data: { setupStatus: 'PREPARING', setupNote: null } })
  const notes: string[] = []
  try {
    const opp = await prisma.opportunity.findFirst({
      where: { id: proposal.opportunityId, consultingFirmId },
      select: { id: true, resourceLinks: true, _count: { select: { documents: true } } },
    })
    if (!opp) return

    // 1. The solicitation's documents.
    if (opp._count.documents === 0 && samAttachments(opp.resourceLinks).length > 0) {
      const imported = await importSamAttachments(consultingFirmId, opp.id)
      const n = imported.results.filter((r) => r.outcome === 'imported').length
      if (n > 0) notes.push(`Added ${n} solicitation document${n === 1 ? '' : 's'} from SAM.gov.`)
    }

    // 2. Its compliance requirements.
    if ((await requirementsOf(consultingFirmId, opp.id)).length === 0) {
      const built = await buildComplianceMatrix(consultingFirmId, opp.id, userId)
      if (built.ok) notes.push(`Read ${built.requirementCount} requirement${built.requirementCount === 1 ? '' : 's'} into the Compliance Matrix (1 token).`)
      else notes.push(`Requirements were not read: ${built.message}`)
    }

    // 3. The sections.
    if ((await prisma.proposalSection.count({ where: { proposalId: proposal.id } })) === 0) {
      const added = await addSections(consultingFirmId, proposal)
      notes.push(
        added.from === 'VERIFIED' ? `Added ${added.count} sections from the verified requirements.`
          : added.from === 'UNVERIFIED' ? `Added ${added.count} sections from the requirements; verify them in the Compliance Matrix before you submit.`
            : `Added the ${added.count} standard sections; they aren't from the solicitation.`,
      )
    }

    await logAudit({
      consultingFirmId, actorUserId: userId ?? undefined, action: 'UPDATE', entityType: 'Proposal', entityId: proposal.id,
      rationale: `Proposal set up: ${notes.join(' ') || 'nothing to do'}`,
    })
  } catch (err) {
    logger.error('Proposal set-up did not finish', { proposalId, error: (err as Error).message })
    notes.push('Set-up did not finish; use the buttons on this page to carry on.')
  } finally {
    await prisma.proposal.update({ where: { id: proposal.id }, data: { setupStatus: 'DONE', setupNote: notes.join(' ') || null } }).catch(() => undefined)
  }
}
