// =============================================================
// §7.7 — Proposal Agent triggers.
//
// Two events are NEW: PROPOSAL_SECTION_APPROVED and, optionally,
// CAPABILITY_NARRATIVE_APPROVED. The other two the agent subscribes to already
// exist and are NOT duplicated: BID_DECISION_RECORDED (§7.5, from the canonical
// human decision) and EXTRACTION_COMPLETED / AMENDMENT_RECORDED (§7.3).
//
// BOTH NEW EVENTS FIRE ONLY ON A HUMAN APPROVAL. Neither can be produced by the
// agent: an agent draft, a new version, a reviewer comment and a
// READY_FOR_REVIEW transition all emit nothing. That is what stops the agent
// from triggering itself into a loop of self-congratulation.
//
// Payloads carry ids and status only.
// =============================================================
import type { Prisma } from '@prisma/client'
import { emitAgentEvent } from '../outbox'

export const PROPOSAL_SECTION_APPROVED = 'PROPOSAL_SECTION_APPROVED'
export const CAPABILITY_NARRATIVE_APPROVED = 'CAPABILITY_NARRATIVE_APPROVED'

export const PROPOSAL_SECTION_ENTITY_TYPE = 'ProposalSection'
export const CAPABILITY_NARRATIVE_ENTITY_TYPE = 'CapabilityNarrative'

/** The one status transition that counts as a human approval. */
export const APPROVED_STATUS = 'APPROVED'

/**
 * Is this transition a genuine human section approval?
 *
 * Pure, so the rule is testable without a database. It requires an actual
 * change INTO the approved state — re-saving an already-approved section is
 * not a new approval, and no other target status qualifies.
 */
export function isHumanSectionApproval(fromStatus: string, toStatus: string): boolean {
  return toStatus === APPROVED_STATUS && fromStatus !== APPROVED_STATUS
}

/**
 * A human approved a proposal section.
 *
 * Emitted from `transitionSection` in `routes/proposal.ts` — the single
 * chokepoint for every review transition — inside the same transaction as the
 * status write.
 */
export function emitProposalSectionApproved(
  args: {
    consultingFirmId: string
    proposalSectionId: string
    opportunityId: string
    proposalId: string | null
    approvedByUserId: string | null
  },
  tx: Prisma.TransactionClient,
): Promise<{ eventId: string | null; created: boolean }> {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: PROPOSAL_SECTION_APPROVED,
      entityType: PROPOSAL_SECTION_ENTITY_TYPE,
      entityId: args.proposalSectionId,
      payload: {
        proposalSectionId: args.proposalSectionId,
        opportunityId: args.opportunityId,
        proposalId: args.proposalId,
        approvedByUserId: args.approvedByUserId,
      },
      // One event per approval. A section reopened and re-approved is a new
      // fact and gets its own event via the timestamp in the key.
      dedupeKey: `proposal-section-approved:${args.consultingFirmId}:${args.proposalSectionId}:${Date.now()}`,
    },
    tx,
  )
}

/**
 * A human approved a capability-narrative version.
 *
 * Lets the agent re-evaluate active proposals that could now quote the newly
 * approved wording. It never regenerates an approved proposal section — the
 * most it produces is a new DRAFT suggestion.
 */
export function emitCapabilityNarrativeApproved(
  args: {
    consultingFirmId: string
    capabilityNarrativeId: string
    versionId: string
    versionNumber: number
    approvedByUserId: string | null
  },
  tx: Prisma.TransactionClient,
): Promise<{ eventId: string | null; created: boolean }> {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: CAPABILITY_NARRATIVE_APPROVED,
      entityType: CAPABILITY_NARRATIVE_ENTITY_TYPE,
      entityId: args.capabilityNarrativeId,
      payload: {
        capabilityNarrativeId: args.capabilityNarrativeId,
        versionId: args.versionId,
        versionNumber: args.versionNumber,
        approvedByUserId: args.approvedByUserId,
      },
      // Keyed on the version: approving version 3 fires once, and editing a
      // draft afterwards fires nothing.
      dedupeKey: `capability-approved:${args.consultingFirmId}:${args.versionId}`,
    },
    tx,
  )
}
