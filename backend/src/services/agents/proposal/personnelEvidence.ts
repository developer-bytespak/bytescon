// =============================================================
// §8.4 — Personnel evidence for the Proposal Agent.
//
// The agent may write about a person only from what a human already recorded
// and approved. This module is where that rule is enforced, before any text is
// generated, because a prohibition in a prompt is a request and a filter in
// code is a guarantee.
//
// WHAT IS SUPPLIED
//   - the person, as selected for THIS proposal by a human
//   - the content of an APPROVED resume version, and only an approved one
//   - labour qualifications a human marked VERIFIED, and only those
//   - years of experience only where a human typed a number
//
// WHAT IS NEVER SUPPLIED, AND SO CANNOT BE WRITTEN ABOUT
//   - a DRAFT, SUPERSEDED or ARCHIVED resume's content
//   - an UNVERIFIED or REJECTED qualification
//   - a years-of-experience figure derived from employment dates
//   - a certification, degree, clearance or employer inferred from a job title
//   - an archived person, or one belonging to another tenant
//
// Absence is reported as absence: a selected person with no approved resume
// still appears, with `hasApprovedResume: false` and a plain statement of what
// is missing, so the draft can say the evidence is unavailable instead of
// filling the gap.
// =============================================================
import { ResumeStatus, QualificationVerification } from '@prisma/client'
import { prisma } from '../../../config/database'

export interface KeyPersonnelEvidence {
  /** The citation id the model must use. It is the selection row, not the person. */
  id: string
  personnelId: string
  fullName: string
  proposalRole: string | null
  laborCategory: string | null
  hasApprovedResume: boolean
  approvedResumeId: string | null
  approvedResumeVersion: number | null
  /** The approved resume's structured content, verbatim. Null when none is approved. */
  approvedResumeContent: Record<string, unknown> | null
  /** Human-entered only. Never computed from dates. */
  yearsExperienceStated: number | null
  verifiedLaborQualifications: Array<{
    laborCategory: string
    yearsExperienceStated: number | null
    evidence: string | null
  }>
  /** Plain statements of what a person may NOT be described as having. */
  missingEvidence: string[]
}

export const PERSONNEL_EVIDENCE_RULE =
  'Each entry is the complete evidence available for that person. A credential, degree, certification, clearance, employer, project or years-of-experience figure that does not appear in an entry is not available and must not be written, implied or inferred — a job title is not a certification, and a date range is not verified experience. Where evidence is missing, state that it is unavailable rather than describing the person as qualified.'

/**
 * Assemble the evidence for a proposal's selected key personnel.
 *
 * Selection is a human act: this reads `ProposalKeyPersonnel` and never picks
 * a person itself. An empty result means nobody was selected, which is a
 * different thing from nobody being qualified, and the caller says so.
 */
export async function buildKeyPersonnelEvidence(
  consultingFirmId: string, proposalId: string,
): Promise<KeyPersonnelEvidence[]> {
  const selections = await prisma.proposalKeyPersonnel.findMany({
    where: { consultingFirmId, proposalId },
    select: {
      id: true, personnelId: true, proposalRole: true, laborCategory: true, resumeId: true,
      personnel: {
        select: {
          id: true, firstName: true, lastName: true, yearsExperience: true, isArchived: true,
          consultingFirmId: true,
          qualifications: {
            where: { verification: QualificationVerification.VERIFIED },
            select: { laborCategory: true, yearsExperience: true, evidence: true },
          },
          resumes: {
            where: { status: ResumeStatus.APPROVED },
            select: { id: true, versionNumber: true, content: true },
            orderBy: { versionNumber: 'desc' }, take: 1,
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const evidence: KeyPersonnelEvidence[] = []
  for (const sel of selections) {
    const p = sel.personnel
    // Belt and braces: the tenant is already in the WHERE clause, and an
    // archived person is not proposable regardless of an old selection row.
    if (!p || p.consultingFirmId !== consultingFirmId || p.isArchived) continue

    // The selection may name a resume, but only an APPROVED version is usable.
    // A selection pointing at a draft is treated as no evidence, not as
    // permission to read the draft.
    const approved = p.resumes[0] ?? null
    const usable = approved && (sel.resumeId === null || sel.resumeId === approved.id) ? approved : null

    const missing: string[] = []
    if (!usable) {
      missing.push('No approved resume version exists for this person, so no experience, education, certification, clearance or project history is available for them.')
    }
    if (p.qualifications.length === 0) {
      missing.push('No labour category has been verified for this person.')
    }
    if (p.yearsExperience === null || p.yearsExperience === undefined) {
      missing.push('No years-of-experience figure has been recorded for this person.')
    }

    evidence.push({
      id: sel.id,
      personnelId: p.id,
      fullName: `${p.firstName} ${p.lastName}`,
      proposalRole: sel.proposalRole,
      laborCategory: sel.laborCategory,
      hasApprovedResume: Boolean(usable),
      approvedResumeId: usable?.id ?? null,
      approvedResumeVersion: usable?.versionNumber ?? null,
      approvedResumeContent: usable ? (usable.content as Record<string, unknown>) : null,
      yearsExperienceStated: p.yearsExperience ?? null,
      verifiedLaborQualifications: p.qualifications.map((q) => ({
        laborCategory: q.laborCategory,
        yearsExperienceStated: q.yearsExperience ?? null,
        evidence: q.evidence,
      })),
      missingEvidence: missing,
    })
  }
  return evidence
}
