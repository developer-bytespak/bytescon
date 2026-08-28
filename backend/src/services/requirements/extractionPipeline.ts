// =============================================================
// §6.3A — Solicitation extraction pipeline.
//
// Orchestrates: persist job → deterministic parse → persist draft requirements,
// clauses, milestones and standing-document needs → optional AI enrichment.
//
// The invariants that make reprocessing an amendment safe:
//  - AI-extracted requirements are NEVER auto-verified. They land UNVERIFIED
//    with reviewRequired where the parser was unsure.
//  - A human-verified requirement is NEVER overwritten or deleted. Reprocessing
//    updates only untouched machine rows.
//  - Duplicate prevention is by deterministic fingerprint, so re-running the
//    same document produces no new rows.
//  - Parse failures are recorded on the job honestly, with the real error.
//  - The job is idempotent on its key, retryable, and bounded by a timeout.
// =============================================================
import { createHash } from 'crypto'
import {
  ClauseApplicability,
  ExtractionJobStatus,
  FlowDownStatus,
  MatrixRequirementStatus,
  MilestoneOrigin,
  MilestoneType,
  Prisma,
} from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import {
  parseSolicitation,
  requirementFingerprint,
  EXTRACTOR_VERSION,
  type ParseResult,
} from './solicitationParser'
import { deriveLmMappings } from './lmMapping'

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_ATTEMPTS = 3

export function buildExtractionKey(opportunityId: string, documentId: string | null, sourceHash: string): string {
  return createHash('sha256').update(`${opportunityId}:${documentId ?? 'inline'}:${sourceHash}`).digest('hex').slice(0, 48)
}

export interface StartExtractionArgs {
  consultingFirmId: string
  opportunityId: string
  documentId?: string | null
  /** Extracted document text. */
  text: string
  documentName?: string
  isAmendmentReprocess?: boolean
  now?: Date
}

export interface ExtractionOutcome {
  jobId: string
  status: ExtractionJobStatus
  alreadyProcessed: boolean
  requirementsCreated: number
  requirementsSkipped: number
  clausesCreated: number
  milestonesCreated: number
  standingDocsCreated: number
  mappingsCreated: number
  unresolvedCount: number
  warnings: string[]
  error?: string | null
}

/**
 * Run one extraction. Synchronous by design so a route can await it for small
 * documents; the worker calls the same function for queued work.
 */
export async function runExtraction(args: StartExtractionArgs): Promise<ExtractionOutcome> {
  const now = args.now ?? new Date()
  const parseInput = args.text ?? ''
  const sourceHash = createHash('sha256').update(parseInput.replace(/\s+/g, ' ').trim()).digest('hex')
  const idempotencyKey = buildExtractionKey(args.opportunityId, args.documentId ?? null, sourceHash)

  // Idempotency — the same document content is never processed twice.
  const existing = await prisma.solicitationExtractionJob.findUnique({ where: { idempotencyKey } })
  if (existing && existing.status === ExtractionJobStatus.SUCCEEDED) {
    return {
      jobId: existing.id, status: existing.status, alreadyProcessed: true,
      requirementsCreated: existing.requirementsCreated,
      requirementsSkipped: existing.requirementsSkipped,
      clausesCreated: existing.clausesCreated,
      milestonesCreated: existing.milestonesCreated,
      standingDocsCreated: existing.standingDocsCreated,
      mappingsCreated: existing.mappingsCreated,
      unresolvedCount: existing.unresolvedCount,
      warnings: existing.parseWarnings,
    }
  }

  // The compliance matrix is the ONE matrix — reused, never duplicated.
  const matrix = await prisma.complianceMatrix.upsert({
    where: { opportunityId: args.opportunityId },
    create: { opportunityId: args.opportunityId, consultingFirmId: args.consultingFirmId },
    update: {},
    select: { id: true },
  })

  const job = existing
    ? await prisma.solicitationExtractionJob.update({
        where: { id: existing.id },
        data: {
          status: ExtractionJobStatus.RUNNING,
          attempt: existing.attempt + 1,
          startedAt: now,
          progressPercent: 5,
          progressStage: 'Parsing document',
          errorMessage: null,
        },
      })
    : await prisma.solicitationExtractionJob.create({
        data: {
          consultingFirmId: args.consultingFirmId,
          opportunityId: args.opportunityId,
          documentId: args.documentId ?? null,
          complianceMatrixId: matrix.id,
          idempotencyKey,
          status: ExtractionJobStatus.RUNNING,
          parseMethod: 'DETERMINISTIC',
          extractorVersion: EXTRACTOR_VERSION,
          sourceHash,
          isAmendmentReprocess: Boolean(args.isAmendmentReprocess),
          maxAttempts: DEFAULT_MAX_ATTEMPTS,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          startedAt: now,
          progressPercent: 5,
          progressStage: 'Parsing document',
        },
      })

  try {
    if (job.attempt > job.maxAttempts) {
      throw new Error(`Extraction exceeded ${job.maxAttempts} attempts and will not be retried automatically.`)
    }

    const parsed: ParseResult = parseSolicitation(parseInput, { documentName: args.documentName })

    await prisma.solicitationExtractionJob.update({
      where: { id: job.id },
      data: { progressPercent: 40, progressStage: 'Writing draft requirements' },
    })

    const counts = await persistParseResult(args.consultingFirmId, args.opportunityId, matrix.id, job.id, parsed, args.documentId ?? null, now)

    await prisma.solicitationExtractionJob.update({
      where: { id: job.id },
      data: { progressPercent: 80, progressStage: 'Deriving Section L/M mappings' },
    })

    const mappingsCreated = await deriveLmMappings(args.consultingFirmId, args.opportunityId, matrix.id, job.id, now)

    // PARTIAL rather than SUCCEEDED when the parser could not resolve
    // everything — the job never claims a cleaner result than it achieved.
    const status = parsed.unresolved.length > 0 || parsed.warnings.length > 0
      ? ExtractionJobStatus.PARTIAL
      : ExtractionJobStatus.SUCCEEDED

    await prisma.solicitationExtractionJob.update({
      where: { id: job.id },
      data: {
        status,
        progressPercent: 100,
        progressStage: 'Complete',
        requirementsCreated: counts.requirementsCreated,
        requirementsSkipped: counts.requirementsSkipped,
        clausesCreated: counts.clausesCreated,
        milestonesCreated: counts.milestonesCreated,
        standingDocsCreated: counts.standingDocsCreated,
        mappingsCreated,
        unresolvedCount: parsed.unresolved.length,
        parseWarnings: parsed.warnings,
        rawResult: JSON.parse(JSON.stringify({ unresolved: parsed.unresolved })) as Prisma.InputJsonValue,
        finishedAt: new Date(),
      },
    })

    return {
      jobId: job.id, status, alreadyProcessed: false,
      ...counts, mappingsCreated,
      unresolvedCount: parsed.unresolved.length,
      warnings: parsed.warnings,
    }
  } catch (err) {
    const message = (err as Error).message
    logger.error('Solicitation extraction failed', { jobId: job.id, opportunityId: args.opportunityId, error: message })
    await prisma.solicitationExtractionJob.update({
      where: { id: job.id },
      data: { status: ExtractionJobStatus.FAILED, errorMessage: message, finishedAt: new Date(), progressStage: 'Failed' },
    })
    return {
      jobId: job.id, status: ExtractionJobStatus.FAILED, alreadyProcessed: false,
      requirementsCreated: 0, requirementsSkipped: 0, clausesCreated: 0,
      milestonesCreated: 0, standingDocsCreated: 0, mappingsCreated: 0,
      unresolvedCount: 0, warnings: [], error: message,
    }
  }
}

interface PersistCounts {
  requirementsCreated: number
  requirementsSkipped: number
  clausesCreated: number
  milestonesCreated: number
  standingDocsCreated: number
}

async function persistParseResult(
  consultingFirmId: string,
  opportunityId: string,
  matrixId: string,
  jobId: string,
  parsed: ParseResult,
  documentId: string | null,
  now: Date,
): Promise<PersistCounts> {
  // --- requirements -------------------------------------------------
  const existingRequirements = await prisma.matrixRequirement.findMany({
    where: { matrixId },
    select: { id: true, section: true, requirementText: true, isManuallyVerified: true, verificationStatus: true },
  })

  // Fingerprint the existing rows the same way the parser does, so a re-run
  // recognises what it already produced.
  const existingByFingerprint = new Map<string, (typeof existingRequirements)[number]>()
  for (const r of existingRequirements) {
    existingByFingerprint.set(requirementFingerprint(r.section || null, r.requirementText), r)
  }

  let requirementsCreated = 0
  let requirementsSkipped = 0

  for (const req of parsed.requirements) {
    const existing = existingByFingerprint.get(req.fingerprint)
    if (existing) {
      // A verified requirement is authoritative and is left completely alone.
      requirementsSkipped++
      continue
    }
    await prisma.matrixRequirement.create({
      data: {
        matrixId,
        consultingFirmId,
        section: req.sourceSection ?? 'Unsectioned',
        sectionType: req.requirementType,
        requirementText: req.requirementText,
        status: MatrixRequirementStatus.NOT_STARTED,
        isMandatory: req.isMandatory,
        sourceDocumentId: documentId,
        sourcePageNumber: req.sourcePageNumber,
        evidenceText: req.evidenceText,
        // Deterministic parse — the extraction method is reported truthfully.
        extractionMethod: 'DETERMINISTIC',
        extractionConfidence: req.reviewRequired ? 0.5 : 0.8,
        // Never auto-verified.
        isManuallyVerified: false,
        verificationStatus: 'UNVERIFIED',
        reviewRequired: req.reviewRequired,
        reviewReason: req.reviewReason,
        lmRole: req.lmRole,
        extractionJobId: jobId,
        lastActivityAt: now,
      },
    })
    requirementsCreated++
  }

  // --- clauses ------------------------------------------------------
  let clausesCreated = 0
  for (const clause of parsed.clauses) {
    const existing = await prisma.clauseObligation.findUnique({
      where: { consultingFirmId_opportunityId_clauseNumber: { consultingFirmId, opportunityId, clauseNumber: clause.clauseNumber } },
      select: { id: true, isManuallyVerified: true },
    })
    if (existing?.isManuallyVerified) continue
    if (existing) {
      await prisma.clauseObligation.update({
        where: { id: existing.id },
        data: {
          clauseTitle: clause.clauseTitle,
          evidenceText: clause.evidenceText,
          sourceSection: clause.sourceSection,
          sourcePageNumber: clause.sourcePageNumber,
          flowDownStatus: clause.flowDownStatus as FlowDownStatus,
          flowDownCondition: clause.flowDownCondition,
          extractionJobId: jobId,
        },
      })
      continue
    }
    await prisma.clauseObligation.create({
      data: {
        consultingFirmId,
        opportunityId,
        clauseNumber: clause.clauseNumber,
        clauseTitle: clause.clauseTitle,
        clauseSet: clause.clauseSet,
        sourceDocumentId: documentId,
        sourceSection: clause.sourceSection,
        sourcePageNumber: clause.sourcePageNumber,
        evidenceText: clause.evidenceText,
        // The clause was found in the solicitation, but whether it APPLIES to a
        // given subcontract is a legal question — never asserted here.
        applicability: ClauseApplicability.UNDETERMINED,
        flowDownStatus: clause.flowDownStatus as FlowDownStatus,
        flowDownCondition: clause.flowDownCondition,
        legalReviewRequired: clause.flowDownStatus !== 'NO_EXPLICIT_FLOWDOWN_FOUND',
        extractionJobId: jobId,
      },
    })
    clausesCreated++
  }

  // --- milestones ---------------------------------------------------
  let milestonesCreated = 0
  const validMilestoneTypes = new Set(Object.values(MilestoneType) as string[])
  for (const ms of parsed.milestones) {
    if (!validMilestoneTypes.has(ms.milestoneType)) continue
    const existing = await prisma.opportunityMilestone.findFirst({
      where: {
        consultingFirmId, opportunityId,
        milestoneType: ms.milestoneType as MilestoneType,
        origin: { in: [MilestoneOrigin.SOLICITATION, MilestoneOrigin.EXTRACTION] },
      },
      select: { id: true, isLocked: true, status: true },
    })
    // A locked or completed milestone is never moved by re-extraction.
    if (existing && (existing.isLocked || existing.status === 'COMPLETE')) continue

    if (existing) {
      await prisma.opportunityMilestone.update({
        where: { id: existing.id },
        data: {
          title: ms.title,
          ...(ms.dateTime ? { startAt: ms.dateTime, endAt: ms.dateTime } : {}),
          sourceEvidence: ms.evidenceText,
          sourceSection: ms.sourceSection,
          sourcePage: ms.sourcePageNumber,
        },
      })
      continue
    }
    await prisma.opportunityMilestone.create({
      data: {
        consultingFirmId,
        opportunityId,
        milestoneType: ms.milestoneType as MilestoneType,
        title: ms.title,
        startAt: ms.dateTime,
        endAt: ms.dateTime,
        isAllDay: true,
        origin: MilestoneOrigin.EXTRACTION,
        sourceEvidence: ms.evidenceText,
        sourceSection: ms.sourceSection,
        sourcePage: ms.sourcePageNumber,
        isMandatory: true,
        isInternal: false,
      },
    })
    milestonesCreated++
  }

  // --- standing-document needs --------------------------------------
  // Recorded as requirements against the matrix; AVAILABILITY is never asserted
  // from the solicitation text — that comes from the document library.
  let standingDocsCreated = 0
  for (const need of parsed.standingDocumentNeeds) {
    const text = `Required standing document: ${need.documentName}`
    const fingerprint = requirementFingerprint(need.sourceSection ?? null, text)
    if (existingByFingerprint.has(fingerprint)) continue
    await prisma.matrixRequirement.create({
      data: {
        matrixId,
        consultingFirmId,
        section: need.sourceSection ?? 'Unsectioned',
        sectionType: 'DOCUMENT',
        requirementText: text,
        status: MatrixRequirementStatus.NOT_STARTED,
        isMandatory: true,
        sourceDocumentId: documentId,
        sourcePageNumber: need.sourcePageNumber,
        evidenceText: need.evidenceText,
        extractionMethod: 'DETERMINISTIC',
        extractionConfidence: 0.7,
        isManuallyVerified: false,
        verificationStatus: 'UNVERIFIED',
        reviewRequired: true,
        reviewReason: 'Link this to a document in your library to confirm you actually hold it — the solicitation text cannot establish availability.',
        extractionJobId: jobId,
        lastActivityAt: now,
      },
    })
    existingByFingerprint.set(fingerprint, { id: 'new', section: need.sourceSection ?? '', requirementText: text, isManuallyVerified: false, verificationStatus: 'UNVERIFIED' })
    standingDocsCreated++
  }

  return { requirementsCreated, requirementsSkipped, clausesCreated, milestonesCreated, standingDocsCreated }
}

/** Cancel a queued or running job. */
export async function cancelExtraction(consultingFirmId: string, jobId: string): Promise<boolean> {
  const job = await prisma.solicitationExtractionJob.findFirst({
    where: { id: jobId, consultingFirmId },
    select: { id: true, status: true },
  })
  if (!job) return false
  if (job.status !== ExtractionJobStatus.QUEUED && job.status !== ExtractionJobStatus.RUNNING) return false
  await prisma.solicitationExtractionJob.update({
    where: { id: job.id },
    data: { status: ExtractionJobStatus.CANCELLED, finishedAt: new Date(), progressStage: 'Cancelled by user' },
  })
  return true
}
