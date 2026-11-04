// =============================================================
// Which opportunity does an agent run's trigger entity belong to?
//
// Events name their entity by its real type: 'AmendmentRevision' and
// 'SolicitationExtractionJob' (compliance/complianceEvents.ts). Every lookup is
// firm-scoped, so an event can never reach another firm's record. Returns null
// when the entity doesn't exist for this firm, or isn't tied to an opportunity.
// =============================================================
import { prisma } from '../../config/database'
import { AMENDMENT_ENTITY_TYPE, EXTRACTION_JOB_ENTITY_TYPE } from './compliance/complianceEvents'

/** A run about an amendment, however the trigger names it. */
export function isAmendmentTrigger(type: string | null | undefined): boolean {
  return type === AMENDMENT_ENTITY_TYPE || type === 'Amendment'
}

export function isExtractionTrigger(type: string | null | undefined): boolean {
  return type === EXTRACTION_JOB_ENTITY_TYPE || type === 'ExtractionJob'
}

export async function opportunityIdForTrigger(
  consultingFirmId: string,
  type: string | null | undefined,
  id: string | null | undefined,
): Promise<string | null> {
  if (!id) return null
  if (type === 'Opportunity') return id
  if (type === AMENDMENT_ENTITY_TYPE) {
    const revision = await prisma.amendmentRevision.findFirst({
      where: { id, consultingFirmId }, select: { opportunityId: true },
    })
    return revision?.opportunityId ?? null
  }
  if (type === 'Amendment') {
    // A manual run may target the Amendment row, which has no firm column of its own.
    const amendment = await prisma.amendment.findFirst({
      where: { id, opportunity: { consultingFirmId } }, select: { opportunityId: true },
    })
    return amendment?.opportunityId ?? null
  }
  if (isExtractionTrigger(type)) {
    const job = await prisma.solicitationExtractionJob.findFirst({
      where: { id, consultingFirmId }, select: { opportunityId: true },
    })
    return job?.opportunityId ?? null
  }
  return null
}
