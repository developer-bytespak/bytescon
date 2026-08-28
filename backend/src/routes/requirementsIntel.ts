// =============================================================
// §6.3 — Document & requirement tracking API.
//
// Extraction jobs · Section L/M mapping · FAR/DFARS clause obligations ·
// requirement ownership workflow · standing document library ·
// pre-submission validation · expiry vs period of performance.
//
// Mounted at /api/requirements-intel. Tenant-scoped throughout.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { MappingVerification, Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
import { runExtraction, cancelExtraction } from '../services/requirements/extractionPipeline'
import { emitExtractionCompleted } from '../services/agents/compliance/complianceEvents'
import { getLmCoverage, deriveLmMappings } from '../services/requirements/lmMapping'
import {
  transitionRequirement,
  assignRequirement,
  summarizeRequirements,
  WORKFLOW_STATES,
  ALLOWED_TRANSITIONS,
  normalizeState,
} from '../services/requirements/requirementWorkflow'
import {
  syncExistingDocuments,
  getLibraryHealth,
  addDocumentVersion,
  getDocumentUsage,
  linkDocument,
} from '../services/standingDocuments'
import {
  runSubmissionValidation,
  recordManualCheck,
  loadLifecycle,
  CHECK_CATALOGUE,
} from '../services/preSubmissionValidation'
import { checkExpiryAgainstLifecycle, EXPIRY_STATE_LABELS } from '../services/documentExpiry'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityType: string, id: string, rationale?: string) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId: id, rationale })

// -------------------------------------------------------------
// §6.3A — Extraction jobs
// -------------------------------------------------------------

const ExtractSchema = z.object({
  documentId: z.string().trim().min(1).nullable().optional(),
  text: z.string().min(1).max(2_000_000).optional(),
  isAmendmentReprocess: z.boolean().optional(),
})

router.post('/extraction/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ExtractSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid extraction payload')

    const opportunity = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, description: true, descriptionHtml: true },
    })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    let text = parsed.data.text
    let documentName: string | undefined

    // Prefer an uploaded document's extracted text; fall back to the notice
    // description. Both are honest sources — nothing is invented.
    if (!text && parsed.data.documentId) {
      const doc = await prisma.opportunityDocument.findFirst({
        where: { id: parsed.data.documentId, opportunityId: opportunity.id },
        select: { fileName: true, rawAnalysis: true },
      })
      if (!doc) throw new NotFoundError('Document not found')
      documentName = doc.fileName
      const raw = doc.rawAnalysis as { text?: string; extractedText?: string } | null
      text = raw?.text ?? raw?.extractedText ?? undefined
    }
    if (!text) {
      text = (opportunity.descriptionHtml ?? opportunity.description ?? '').replace(/<[^>]+>/g, ' ')
      documentName = documentName ?? 'Solicitation description'
    }
    if (!text.trim()) {
      throw new ValidationError('No document text is available to extract from. Upload the solicitation document first.')
    }

    const outcome = await runExtraction({
      consultingFirmId,
      opportunityId: opportunity.id,
      documentId: parsed.data.documentId ?? null,
      text,
      documentName,
      isAmendmentReprocess: parsed.data.isAmendmentReprocess,
    })
    await audit(req, consultingFirmId, 'CREATE', 'SolicitationExtractionJob', outcome.jobId, `Extraction ${outcome.status}`)
    // §7.3 — announce a completion that produced usable structured output so the
    // Compliance Agent can pick up the downstream work. A FAILED job emits
    // nothing; its failure is surfaced through the job record instead. Deduped
    // on (job, status), so an already-processed job does not re-announce.
    if (
      !outcome.alreadyProcessed &&
      (outcome.status === 'SUCCEEDED' || outcome.status === 'PARTIAL')
    ) {
      await prisma.$transaction(async (tx) => {
        await emitExtractionCompleted(tx, {
          consultingFirmId,
          extractionJobId: outcome.jobId,
          opportunityId: opportunity.id,
          documentId: parsed.data.documentId ?? null,
          status: outcome.status,
          requirementsCreated: outcome.requirementsCreated,
          clausesCreated: outcome.clausesCreated,
          mappingsCreated: outcome.mappingsCreated,
          unresolvedCount: outcome.unresolvedCount,
        })
      })
    }
    res.json({ success: true, data: outcome })
  } catch (err) { next(err) }
})

router.get('/extraction/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const jobs = await prisma.solicitationExtractionJob.findMany({
      where: { consultingFirmId, opportunityId: req.params.opportunityId },
      orderBy: { createdAt: 'desc' },
      take: 25,
    })
    res.json({ success: true, data: jobs })
  } catch (err) { next(err) }
})

router.post('/extraction/job/:jobId/cancel', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const cancelled = await cancelExtraction(consultingFirmId, req.params.jobId)
    if (!cancelled) throw new ValidationError('This job is not in a cancellable state.')
    await audit(req, consultingFirmId, 'UPDATE', 'SolicitationExtractionJob', req.params.jobId, 'Extraction cancelled')
    res.json({ success: true, data: { cancelled: true } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.3B — Section L/M mapping
// -------------------------------------------------------------

router.get('/lm/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const coverage = await getLmCoverage(consultingFirmId, req.params.opportunityId)
    res.json({ success: true, data: coverage })
  } catch (err) { next(err) }
})

router.post('/lm/:opportunityId/derive', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId: req.params.opportunityId }, select: { id: true, consultingFirmId: true } })
    if (!matrix || matrix.consultingFirmId !== consultingFirmId) throw new NotFoundError('Compliance matrix not found for this opportunity')
    const created = await deriveLmMappings(consultingFirmId, req.params.opportunityId, matrix.id, null)
    res.json({ success: true, data: { created } })
  } catch (err) { next(err) }
})

const MappingDecisionSchema = z.object({
  decision: z.enum(['CONFIRM', 'REJECT']),
  reason: z.string().trim().max(1000).optional(),
  proposalSectionId: z.string().trim().min(1).nullable().optional(),
})

router.patch('/lm/mapping/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = MappingDecisionSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid mapping decision')

    const mapping = await prisma.sectionLmMapping.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true, verification: true } })
    if (!mapping) throw new NotFoundError('Mapping not found')

    const updated = await prisma.sectionLmMapping.update({
      where: { id: mapping.id },
      data: {
        verification: parsed.data.decision === 'CONFIRM' ? MappingVerification.CONFIRMED : MappingVerification.REJECTED,
        verifiedByUserId: req.user?.userId ?? null,
        verifiedAt: new Date(),
        decisionReason: parsed.data.reason ?? null,
        // A human decision resolves the review flag.
        reviewRequired: false,
        ...(parsed.data.proposalSectionId !== undefined ? { proposalSectionId: parsed.data.proposalSectionId } : {}),
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'SectionLmMapping', mapping.id, `Mapping ${parsed.data.decision}`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

const ManualMappingSchema = z.object({
  opportunityId: z.string().trim().min(1),
  instructionRequirementId: z.string().trim().min(1),
  evaluationRequirementId: z.string().trim().min(1),
  reason: z.string().trim().max(1000).optional(),
})

router.post('/lm/mapping', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ManualMappingSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid mapping payload')

    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId: parsed.data.opportunityId }, select: { id: true, consultingFirmId: true } })
    if (!matrix || matrix.consultingFirmId !== consultingFirmId) throw new NotFoundError('Compliance matrix not found')

    const [instruction, evaluation] = await Promise.all([
      prisma.matrixRequirement.findFirst({ where: { id: parsed.data.instructionRequirementId, matrixId: matrix.id }, select: { id: true, section: true, requirementText: true } }),
      prisma.matrixRequirement.findFirst({ where: { id: parsed.data.evaluationRequirementId, matrixId: matrix.id }, select: { id: true, section: true, requirementText: true } }),
    ])
    if (!instruction || !evaluation) throw new ValidationError('Both requirements must exist on this opportunity’s compliance matrix.')

    const created = await prisma.sectionLmMapping.create({
      data: {
        consultingFirmId,
        opportunityId: parsed.data.opportunityId,
        complianceMatrixId: matrix.id,
        instructionSourceSection: instruction.section,
        instructionEvidence: instruction.requirementText.slice(0, 1000),
        instructionRequirementId: instruction.id,
        evaluationSourceSection: evaluation.section,
        evaluationEvidence: evaluation.requirementText.slice(0, 1000),
        evaluationRequirementId: evaluation.id,
        relationshipExplanation: parsed.data.reason ?? 'Manually created by a user.',
        confidence: 1,
        origin: 'MANUAL',
        // A person created it, so it is confirmed on creation.
        verification: MappingVerification.CONFIRMED,
        verifiedByUserId: req.user?.userId ?? null,
        verifiedAt: new Date(),
        reviewRequired: false,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'SectionLmMapping', created.id, 'Manual L/M mapping created')
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.3C — Clause obligations
// -------------------------------------------------------------

router.get('/clauses/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const clauses = await prisma.clauseObligation.findMany({
      where: { consultingFirmId, opportunityId: req.params.opportunityId },
      orderBy: [{ flowDownStatus: 'asc' }, { clauseNumber: 'asc' }],
      include: { history: { orderBy: { createdAt: 'desc' }, take: 10 } },
    })
    res.json({
      success: true,
      data: {
        clauses,
        // The exact wording §6.3C requires. This is not legal advice.
        disclaimer: 'Potential flow-down identified — legal review required. This system identifies clause language; it does not determine whether a clause applies to a given subcontract, and it is not legal counsel.',
      },
    })
  } catch (err) { next(err) }
})

const ClauseUpdateSchema = z.object({
  applicability: z.enum(['APPLICABLE', 'NOT_APPLICABLE', 'CONDITIONAL', 'UNDETERMINED']).optional(),
  flowDownStatus: z.enum(['EXPLICIT_FLOWDOWN', 'CONDITIONAL_FLOWDOWN', 'NO_EXPLICIT_FLOWDOWN_FOUND', 'REVIEW_REQUIRED']).optional(),
  flowDownCondition: z.string().trim().max(2000).nullable().optional(),
  affectedPartnerIds: z.array(z.string().trim().min(1)).max(50).optional(),
  ownerUserId: z.string().trim().min(1).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
  complianceStatus: z.enum(['NOT_STARTED', 'IN_PROGRESS', 'SATISFIED', 'NOT_APPLICABLE', 'BLOCKED']).optional(),
  isManuallyVerified: z.boolean().optional(),
  legalReviewed: z.boolean().optional(),
  note: z.string().trim().max(2000).optional(),
})

router.patch('/clauses/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ClauseUpdateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid clause payload')

    const clause = await prisma.clauseObligation.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!clause) throw new NotFoundError('Clause not found')

    // Partner ids must belong to this firm — no cross-tenant reference.
    if (parsed.data.affectedPartnerIds?.length) {
      const count = await prisma.partner.count({ where: { consultingFirmId, id: { in: parsed.data.affectedPartnerIds } } })
      if (count !== parsed.data.affectedPartnerIds.length) throw new ValidationError('One or more partners do not belong to this firm.')
    }

    const updated = await prisma.clauseObligation.update({
      where: { id: clause.id },
      data: {
        ...(parsed.data.applicability ? { applicability: parsed.data.applicability } : {}),
        ...(parsed.data.flowDownStatus ? { flowDownStatus: parsed.data.flowDownStatus } : {}),
        ...(parsed.data.flowDownCondition !== undefined ? { flowDownCondition: parsed.data.flowDownCondition } : {}),
        ...(parsed.data.affectedPartnerIds ? { affectedPartnerIds: parsed.data.affectedPartnerIds } : {}),
        ...(parsed.data.ownerUserId !== undefined ? { ownerUserId: parsed.data.ownerUserId } : {}),
        ...(parsed.data.dueDate !== undefined ? { dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null } : {}),
        ...(parsed.data.complianceStatus ? { complianceStatus: parsed.data.complianceStatus } : {}),
        ...(parsed.data.isManuallyVerified !== undefined
          ? { isManuallyVerified: parsed.data.isManuallyVerified, verifiedByUserId: req.user?.userId ?? null, verifiedAt: new Date() }
          : {}),
        ...(parsed.data.legalReviewed ? { legalReviewedByUserId: req.user?.userId ?? null, legalReviewedAt: new Date() } : {}),
      },
    })

    await prisma.clauseObligationEvent.create({
      data: {
        obligationId: clause.id,
        action: 'UPDATE',
        fromValue: clause.flowDownStatus,
        toValue: updated.flowDownStatus,
        actorUserId: req.user?.userId ?? null,
        note: parsed.data.note ?? null,
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ClauseObligation', clause.id, `Clause ${clause.clauseNumber} updated`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.3F — Requirement ownership + workflow
// -------------------------------------------------------------

router.get('/requirements/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId: req.params.opportunityId }, select: { id: true, consultingFirmId: true } })
    if (!matrix || matrix.consultingFirmId !== consultingFirmId) {
      return res.json({ success: true, data: { requirements: [], summary: null, workflowStates: WORKFLOW_STATES, allowedTransitions: ALLOWED_TRANSITIONS } })
    }

    const requirements = await prisma.matrixRequirement.findMany({
      where: { matrixId: matrix.id },
      orderBy: [{ sortOrder: 'asc' }, { section: 'asc' }],
      include: { events: { orderBy: { createdAt: 'desc' }, take: 5 } },
    })
    const summary = await summarizeRequirements(consultingFirmId, req.params.opportunityId)

    res.json({
      success: true,
      data: {
        requirements: requirements.map((r) => ({ ...r, workflowState: normalizeState(r.status) })),
        summary,
        workflowStates: WORKFLOW_STATES,
        allowedTransitions: ALLOWED_TRANSITIONS,
      },
    })
  } catch (err) { next(err) }
})

const TransitionSchema = z.object({
  toStatus: z.enum(WORKFLOW_STATES),
  note: z.string().trim().max(2000).optional(),
  completionPercent: z.number().int().min(0).max(100).optional(),
})

router.post('/requirements/:id/transition', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = TransitionSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid transition payload')
    const updated = await transitionRequirement({
      consultingFirmId,
      requirementId: req.params.id,
      toStatus: parsed.data.toStatus,
      actorUserId: req.user?.userId ?? null,
      note: parsed.data.note,
      completionPercent: parsed.data.completionPercent,
    })
    await audit(req, consultingFirmId, 'UPDATE', 'MatrixRequirement', req.params.id, `Requirement → ${parsed.data.toStatus}`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

const AssignSchema = z.object({
  ownerUserId: z.string().trim().min(1).nullable().optional(),
  reviewerUserId: z.string().trim().min(1).nullable().optional(),
  dueDate: z.string().datetime().nullable().optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field' })

router.post('/requirements/:id/assign', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = AssignSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid assignment payload')

    // Assignees must be users of THIS firm.
    for (const userId of [parsed.data.ownerUserId, parsed.data.reviewerUserId]) {
      if (!userId) continue
      const member = await prisma.user.findFirst({ where: { id: userId, consultingFirmId }, select: { id: true } })
      if (!member) throw new ValidationError('Assignee must be a member of your firm.')
    }

    const updated = await assignRequirement({
      consultingFirmId,
      requirementId: req.params.id,
      ownerUserId: parsed.data.ownerUserId,
      reviewerUserId: parsed.data.reviewerUserId,
      dueDate: parsed.data.dueDate === undefined ? undefined : parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
      actorUserId: req.user?.userId ?? null,
    })
    await audit(req, consultingFirmId, 'UPDATE', 'MatrixRequirement', req.params.id, 'Requirement assignment updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.3D — Standing document library
// -------------------------------------------------------------

router.get('/documents', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opportunityId = typeof req.query.opportunityId === 'string' ? req.query.opportunityId : null

    // Evaluate expiry against a real opportunity lifecycle when one is given.
    const lifecycle = opportunityId
      ? await loadLifecycle(consultingFirmId, opportunityId, null)
      : {}

    const health = await getLibraryHealth(consultingFirmId, lifecycle)
    const filtered = typeof req.query.category === 'string' && req.query.category
      ? health.filter((d) => d.category === req.query.category)
      : health
    const searched = typeof req.query.search === 'string' && req.query.search
      ? filtered.filter((d) => d.name.toLowerCase().includes((req.query.search as string).toLowerCase()))
      : filtered

    res.json({ success: true, data: { documents: searched, expiryLabels: EXPIRY_STATE_LABELS, evaluatedAgainstOpportunityId: opportunityId } })
  } catch (err) { next(err) }
})

const DocumentSchema = z.object({
  category: z.enum(['CAPABILITY_STATEMENT', 'CERTIFICATION', 'REGISTRATION', 'INSURANCE', 'BOND', 'FINANCIAL', 'INDIRECT_RATE', 'RESUME', 'PAST_PERFORMANCE', 'REPRESENTATION', 'SIGNED_FORM', 'PROPOSAL_TEMPLATE', 'OTHER']),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).nullable().optional(),
  tags: z.array(z.string().trim().max(40)).max(30).optional(),
  sensitivity: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']).optional(),
  effectiveDate: z.string().datetime().nullable().optional(),
  expiryDate: z.string().datetime().nullable().optional(),
  ownerUserId: z.string().trim().min(1).nullable().optional(),
  fileKey: z.string().trim().max(500).nullable().optional(),
  fileName: z.string().trim().max(300).nullable().optional(),
})

router.post('/documents', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = DocumentSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid document payload')

    const created = await prisma.standingDocument.create({
      data: {
        consultingFirmId,
        category: parsed.data.category,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        tags: parsed.data.tags ?? [],
        sensitivity: parsed.data.sensitivity ?? 'INTERNAL',
        effectiveDate: parsed.data.effectiveDate ? new Date(parsed.data.effectiveDate) : null,
        expiryDate: parsed.data.expiryDate ? new Date(parsed.data.expiryDate) : null,
        ownerUserId: parsed.data.ownerUserId ?? req.user?.userId ?? null,
        sourceSystem: 'LIBRARY',
        currentVersionNo: 1,
      },
    })
    await prisma.standingDocumentVersion.create({
      data: { documentId: created.id, versionNo: 1, isCurrent: true, fileKey: parsed.data.fileKey ?? null, fileName: parsed.data.fileName ?? null, uploadedByUserId: req.user?.userId ?? null },
    })
    await audit(req, consultingFirmId, 'CREATE', 'StandingDocument', created.id, `Document added: ${created.name}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.post('/documents/sync', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const result = await syncExistingDocuments(consultingFirmId)
    res.json({ success: true, data: { ...result, note: 'Existing registration, certification and insurance records are referenced, not copied. The underlying files are unchanged.' } })
  } catch (err) { next(err) }
})

router.post('/documents/:id/version', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const created = await addDocumentVersion(consultingFirmId, req.params.id, {
      fileKey: typeof req.body?.fileKey === 'string' ? req.body.fileKey : null,
      fileName: typeof req.body?.fileName === 'string' ? req.body.fileName : null,
      fileType: typeof req.body?.fileType === 'string' ? req.body.fileType : null,
      fileSize: Number.isInteger(req.body?.fileSize) ? req.body.fileSize : null,
      pageCount: Number.isInteger(req.body?.pageCount) ? req.body.pageCount : null,
      changeNote: typeof req.body?.changeNote === 'string' ? req.body.changeNote : null,
      uploadedByUserId: req.user?.userId ?? null,
    })
    await audit(req, consultingFirmId, 'UPDATE', 'StandingDocument', req.params.id, `New version ${created.versionNo}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.post('/documents/:id/approve', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const doc = await prisma.standingDocument.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!doc) throw new NotFoundError('Document not found')
    const approved = req.body?.approved !== false
    const updated = await prisma.standingDocument.update({
      where: { id: doc.id },
      data: {
        approvedForReuse: approved,
        approvedByUserId: approved ? req.user?.userId ?? null : null,
        approvedAt: approved ? new Date() : null,
        verification: approved ? 'VERIFIED' : 'UNVERIFIED',
        verifiedByUserId: approved ? req.user?.userId ?? null : null,
        verifiedAt: approved ? new Date() : null,
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'StandingDocument', doc.id, approved ? 'Approved for reuse' : 'Approval withdrawn')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/**
 * Every version of one standing document, newest first.
 *
 * Superseded versions are kept, not replaced: a proposal submitted last year
 * attached the file as it stood then, and that has to stay provable.
 */
router.get('/documents/:id/versions', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const doc = await prisma.standingDocument.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, name: true, currentVersionNo: true },
    })
    if (!doc) throw new NotFoundError('Document not found')
    const versions = await prisma.standingDocumentVersion.findMany({
      where: { documentId: doc.id },
      orderBy: { versionNo: 'desc' },
      select: {
        id: true, versionNo: true, fileName: true, fileType: true, fileSize: true,
        pageCount: true, changeNote: true, isCurrent: true, createdAt: true, uploadedByUserId: true,
      },
    })
    res.json({ success: true, data: { document: doc, versions } })
  } catch (err) { next(err) }
})

router.get('/documents/:id/usage', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    res.json({ success: true, data: await getDocumentUsage(consultingFirmId, req.params.id) })
  } catch (err) { next(err) }
})

const LinkSchema = z.object({
  targetType: z.enum(['MATRIX_REQUIREMENT', 'SUBMISSION_ITEM', 'PROPOSAL_SECTION', 'CLAUSE_OBLIGATION', 'OPPORTUNITY']),
  targetId: z.string().trim().min(1),
  opportunityId: z.string().trim().min(1).nullable().optional(),
  note: z.string().trim().max(1000).nullable().optional(),
})

router.post('/documents/:id/link', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = LinkSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid link payload')
    const link = await linkDocument(consultingFirmId, {
      documentId: req.params.id,
      targetType: parsed.data.targetType,
      targetId: parsed.data.targetId,
      opportunityId: parsed.data.opportunityId ?? null,
      note: parsed.data.note ?? null,
      linkedByUserId: req.user?.userId ?? null,
    })
    res.status(201).json({ success: true, data: link })
  } catch (err) { next(err) }
})

router.post('/documents/:id/archive', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const doc = await prisma.standingDocument.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!doc) throw new NotFoundError('Document not found')
    const updated = await prisma.standingDocument.update({ where: { id: doc.id }, data: { isArchived: true } })
    await audit(req, consultingFirmId, 'UPDATE', 'StandingDocument', doc.id, 'Document archived')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.3E — Pre-submission validation
// -------------------------------------------------------------

router.get('/validation/catalogue', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Published so users can see exactly which checks the system does and does
    // not perform.
    res.json({ success: true, data: CHECK_CATALOGUE })
  } catch (err) { next(err) }
})

router.post('/validation/:submissionId/run', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const result = await runSubmissionValidation(consultingFirmId, req.params.submissionId, { actorUserId: req.user?.userId ?? null })
    await audit(req, consultingFirmId, 'UPDATE', 'ProposalSubmission', req.params.submissionId, `Validation run ${result.runId}: ${result.failed} failed, ${result.blockingFailures} blocking`)
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

router.get('/validation/:submissionId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const checks = await prisma.submissionValidationCheck.findMany({
      where: { consultingFirmId, submissionId: req.params.submissionId },
      orderBy: { performedAt: 'desc' },
      take: 500,
    })
    const latestRunId = checks[0]?.runId ?? null
    res.json({
      success: true,
      data: {
        latestRunId,
        latest: checks.filter((c) => c.runId === latestRunId),
        // Prior runs are retained — revalidation never erases evidence.
        history: checks,
        catalogue: CHECK_CATALOGUE,
      },
    })
  } catch (err) { next(err) }
})

const ManualCheckSchema = z.object({
  checkKey: z.string().trim().min(1).max(60),
  checklistItemId: z.string().trim().min(1).nullable().optional(),
  outcome: z.enum(['PASSED', 'FAILED']),
  note: z.string().trim().min(1).max(2000),
})

router.post('/validation/:submissionId/manual', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ManualCheckSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid manual check payload')
    if (!req.user?.userId) throw new ValidationError('A user context is required to record a manual check.')

    const submission = await prisma.proposalSubmission.findFirst({ where: { id: req.params.submissionId, consultingFirmId }, select: { id: true } })
    if (!submission) throw new NotFoundError('Submission not found')

    const created = await recordManualCheck(consultingFirmId, submission.id, {
      checkKey: parsed.data.checkKey,
      checklistItemId: parsed.data.checklistItemId ?? null,
      outcome: parsed.data.outcome,
      note: parsed.data.note,
      actorUserId: req.user.userId,
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ProposalSubmission', submission.id, `Manual check ${parsed.data.checkKey}: ${parsed.data.outcome}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.3G — Expiry against the period of performance
// -------------------------------------------------------------

router.get('/expiry/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId }, select: { id: true } })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    const submission = await prisma.proposalSubmission.findFirst({ where: { consultingFirmId, opportunityId: opportunity.id }, select: { finalDeadline: true } })
    const lifecycle = await loadLifecycle(consultingFirmId, opportunity.id, submission?.finalDeadline ?? null)
    // Option coverage is only required when the solicitation says so.
    const optionCoverageRequired = req.query.optionCoverageRequired === 'true'

    const [certifications, policies, documents] = await Promise.all([
      prisma.certification.findMany({ where: { consultingFirmId, isArchived: false }, select: { id: true, name: true, expiryDate: true } }),
      prisma.insurancePolicy.findMany({ where: { consultingFirmId, isArchived: false }, select: { id: true, policyType: true, expiryDate: true } }),
      prisma.standingDocument.findMany({ where: { consultingFirmId, isArchived: false }, select: { id: true, name: true, category: true, expiryDate: true, sourceSystem: true, sourceRecordId: true } }),
    ])

    const evaluate = (id: string, name: string, kind: string, expiryDate: Date | null, sourceLink: string | null) => {
      const result = checkExpiryAgainstLifecycle({ expiryDate, lifecycle, optionCoverageRequired })
      return { id, name, kind, expiryDate, sourceLink, ...result, label: EXPIRY_STATE_LABELS[result.state] }
    }

    res.json({
      success: true,
      data: {
        lifecycle,
        optionCoverageRequired,
        items: [
          ...certifications.map((c) => evaluate(c.id, c.name, 'CERTIFICATION', c.expiryDate, `/registration`)),
          ...policies.map((p) => evaluate(p.id, p.policyType, 'INSURANCE', p.expiryDate, `/registration`)),
          ...documents.map((d) => evaluate(d.id, d.name, d.category, d.expiryDate, d.sourceSystem === 'LIBRARY' ? null : `/registration`)),
        ],
        labels: EXPIRY_STATE_LABELS,
        note: optionCoverageRequired
          ? 'Option-period coverage has been marked as required for this solicitation, so documents expiring during the options are treated as blocking.'
          : 'Option-period coverage has not been marked as required for this solicitation, so expiry during an option period is reported for awareness rather than treated as a blocker.',
      },
    })
  } catch (err) { next(err) }
})

export default router
export type { Prisma }
