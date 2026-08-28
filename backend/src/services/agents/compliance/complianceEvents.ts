// =============================================================
// §7.3 — Compliance domain events.
//
// Two NEW emitters (`SOLICITATION_DOCUMENT_ADDED`, `EXTRACTION_COMPLETED`) plus
// one reused from §6.4B's persistence path (`AMENDMENT_RECORDED`).
// `PURSUIT_STAGE_CHANGED` is NOT re-emitted here — §7.2 already owns that
// emitter and the Compliance Agent simply subscribes to it.
//
// Same transactional discipline as §7.1 and §7.2: each emitter takes a
// `Prisma.TransactionClient` so the event shares the business write's
// transaction, and the outbox inserts with ON CONFLICT DO NOTHING so a benign
// duplicate can never abort the caller's transaction.
//
// LOOP SAFETY
// `EXTRACTION_COMPLETED` is emitted by the extraction path and consumed by the
// Compliance Agent. The agent's handling of it is PHASE-AWARE: a run triggered
// by `EXTRACTION_COMPLETED` never runs the extraction phase, so it cannot cause
// another extraction and therefore cannot emit another `EXTRACTION_COMPLETED`.
// That guarantee lives in `phasesForRun` and is asserted by test.
// =============================================================
import type { Prisma } from '@prisma/client'
import { emitAgentEvent } from '../outbox'

export const SOLICITATION_DOCUMENT_ADDED = 'SOLICITATION_DOCUMENT_ADDED'
export const EXTRACTION_COMPLETED = 'EXTRACTION_COMPLETED'
export const AMENDMENT_RECORDED = 'AMENDMENT_RECORDED'

export const COMPLIANCE_EVENT_TYPES = [
  SOLICITATION_DOCUMENT_ADDED,
  EXTRACTION_COMPLETED,
  AMENDMENT_RECORDED,
] as const

/** Entity types the runtime uses to target a Compliance Agent run. */
export const DOCUMENT_ENTITY_TYPE = 'OpportunityDocument'
export const EXTRACTION_JOB_ENTITY_TYPE = 'SolicitationExtractionJob'
export const AMENDMENT_ENTITY_TYPE = 'AmendmentRevision'

/**
 * A solicitation document was successfully persisted.
 *
 * Carries identifiers only — never the document bytes or its extracted text.
 * The agent re-reads whatever it needs from the canonical records.
 *
 * Deduped on the document id, which is unique per successful upload, so a
 * retried request cannot produce a second event.
 */
export function emitSolicitationDocumentAdded(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    documentId: string
    opportunityId: string
    pursuitId?: string | null
    fileName: string
    fileType: string | null
    isAmendment: boolean
    sourceHash?: string | null
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: SOLICITATION_DOCUMENT_ADDED,
      entityType: DOCUMENT_ENTITY_TYPE,
      entityId: args.documentId,
      payload: {
        documentId: args.documentId,
        opportunityId: args.opportunityId,
        pursuitId: args.pursuitId ?? null,
        fileName: args.fileName,
        fileType: args.fileType,
        isAmendment: args.isAmendment,
        sourceHash: args.sourceHash ?? null,
      },
      dedupeKey: `${SOLICITATION_DOCUMENT_ADDED}:${args.consultingFirmId}:${args.documentId}`,
    },
    tx,
  )
}

/**
 * A canonical §6.3A extraction finished with usable structured output.
 *
 * Emitted for SUCCEEDED and PARTIAL — a partial parse still produced
 * requirements worth mapping. A FAILED job emits nothing; the failure is
 * surfaced through the job record and its own escalation instead.
 *
 * Deduped on the extraction job id AND its terminal status, so a job that is
 * retried and later succeeds still announces itself, while a replay of the same
 * completion does not.
 */
export function emitExtractionCompleted(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    extractionJobId: string
    opportunityId: string
    documentId: string | null
    status: string
    requirementsCreated: number
    clausesCreated: number
    mappingsCreated: number
    unresolvedCount: number
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: EXTRACTION_COMPLETED,
      // Targeted at the JOB, not the opportunity, so the handler can tell an
      // extraction-completed run apart from a document-added run and skip the
      // extraction phase entirely.
      entityType: EXTRACTION_JOB_ENTITY_TYPE,
      entityId: args.extractionJobId,
      payload: {
        extractionJobId: args.extractionJobId,
        opportunityId: args.opportunityId,
        documentId: args.documentId,
        status: args.status,
        requirementsCreated: args.requirementsCreated,
        clausesCreated: args.clausesCreated,
        mappingsCreated: args.mappingsCreated,
        unresolvedCount: args.unresolvedCount,
      },
      dedupeKey: `${EXTRACTION_COMPLETED}:${args.consultingFirmId}:${args.extractionJobId}:${args.status}`,
    },
    tx,
  )
}

/**
 * An amendment revision was recorded by the canonical §6.4B path.
 *
 * Deduped on the revision id — `AmendmentRevision` is already unique on content
 * hash, so re-recording identical content creates no revision and therefore no
 * event.
 */
export function emitAmendmentRecorded(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    revisionId: string
    opportunityId: string
    revisionNo: number
    amendmentNumber: string | null
    changedRequirements: number
    changedDeadlines: number
    changedClauses: number
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: AMENDMENT_RECORDED,
      entityType: AMENDMENT_ENTITY_TYPE,
      entityId: args.revisionId,
      payload: {
        revisionId: args.revisionId,
        opportunityId: args.opportunityId,
        revisionNo: args.revisionNo,
        amendmentNumber: args.amendmentNumber,
        changedRequirements: args.changedRequirements,
        changedDeadlines: args.changedDeadlines,
        changedClauses: args.changedClauses,
      },
      dedupeKey: `${AMENDMENT_RECORDED}:${args.consultingFirmId}:${args.revisionId}`,
    },
    tx,
  )
}
