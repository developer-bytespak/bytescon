// =============================================================
// Submission Management (§5.1 Stage 7). Mounted at /api/submission. A pre-submission
// readiness/packaging workspace tied to a Proposal/Opportunity — DISTINCT from the
// post-submission compliance/penalty ledger `SubmissionRecord`. Checklist items are
// SOURCED FROM verified MatrixRequirements, ProposalSections, and DocumentRequirements
// (never duplicated). Readiness is backend-authoritative. No automatic government
// submission is performed or claimed — status is user-recorded workflow state.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import { Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { requireActiveBase } from '../middleware/addonGate'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { notifyUser } from '../services/notificationService'
import { upload } from '../middleware/upload'
import { prisma } from '../config/database'
import { computeReadiness, validateDocumentItem, CHECKLIST_ITEM_TYPES } from '../services/submissionReadiness'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const ACTIVE_SUB_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'READY_TO_SUBMIT']
const REMINDER_SUPPRESSED = ['CONFIRMED', 'WITHDRAWN', 'ARCHIVED', 'REJECTED']

const audit = (req: AuthenticatedRequest, firmId: string, action: AuditAction, entityType: string, entityId: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId: firmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId, rationale, before, after })

async function loadSubmission(firmId: string, id: string) {
  const s = await prisma.proposalSubmission.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!s) throw new NotFoundError('Submission')
  return s
}
async function loadItem(firmId: string, id: string) {
  const i = await prisma.submissionChecklistItem.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!i) throw new NotFoundError('Checklist item')
  return i
}
async function recordHistory(firmId: string, submissionId: string, action: string, fromStatus: string | null, toStatus: string | null, actorUserId?: string, comment?: string | null) {
  await prisma.submissionStatusHistory.create({ data: { consultingFirmId: firmId, submissionId, action, fromStatus, toStatus, actorUserId: actorUserId ?? null, comment: comment ?? null } })
}

// Recompute + persist readinessPercent + auto-advance NOT_STARTED→IN_PROGRESS.
async function recomputeReadiness(submissionId: string) {
  const items = await prisma.submissionChecklistItem.findMany({ where: { submissionId, isArchived: false }, select: { status: true, isMandatory: true, isBlocker: true, dueDate: true } })
  const r = computeReadiness(items)
  const sub = await prisma.proposalSubmission.findUnique({ where: { id: submissionId }, select: { status: true } })
  const data: Prisma.ProposalSubmissionUpdateInput = { readinessPercent: r.overallPercent }
  if (sub?.status === 'NOT_STARTED' && items.length > 0) data.status = 'IN_PROGRESS'
  await prisma.proposalSubmission.update({ where: { id: submissionId }, data })
  return r
}

// =============================================================
// SUBMISSION
// =============================================================
router.post('/opportunity/:opportunityId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 300) : null
    if (!title) throw new ValidationError('A submission title is required')
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId: firmId }, select: { id: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const dupe = await prisma.proposalSubmission.findFirst({ where: { consultingFirmId: firmId, opportunityId: opp.id, isArchived: false, status: { in: [...ACTIVE_SUB_STATUSES, 'SUBMITTED'] } }, select: { id: true } })
    if (dupe) throw new ConflictError('An active submission already exists for this opportunity.')
    const submission = await prisma.proposalSubmission.create({
      data: {
        consultingFirmId: firmId, opportunityId: opp.id, title,
        proposalId: typeof req.body?.proposalId === 'string' ? req.body.proposalId : null,
        finalDeadline: req.body?.finalDeadline ? new Date(req.body.finalDeadline) : null,
        internalDeadline: req.body?.internalDeadline ? new Date(req.body.internalDeadline) : null,
        submissionMethod: typeof req.body?.submissionMethod === 'string' ? req.body.submissionMethod : null,
        destinationDescription: typeof req.body?.destinationDescription === 'string' ? req.body.destinationDescription : null,
        ownerUserId: req.user?.userId ?? null, createdByUserId: req.user?.userId ?? null,
      },
    })
    await recordHistory(firmId, submission.id, 'created', null, 'NOT_STARTED', req.user?.userId)
    await audit(req, firmId, 'CREATE', 'ProposalSubmission', submission.id, `Submission created: ${title}`)
    res.status(201).json({ success: true, data: { submission } })
  } catch (err) { next(err) }
})

router.get('/opportunity/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId: firmId }, select: { id: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const submission = await prisma.proposalSubmission.findFirst({ where: { consultingFirmId: firmId, opportunityId: opp.id, isArchived: false }, include: { items: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' } } } })
    if (!submission) return res.json({ success: true, data: { exists: false } })
    const readiness = computeReadiness(submission.items)
    res.json({ success: true, data: { exists: true, submission, readiness } })
  } catch (err) { next(err) }
})

router.get('/:submissionId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const submission = await prisma.proposalSubmission.findFirst({ where: { id: req.params.submissionId, consultingFirmId: firmId }, include: { items: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' } } } })
    if (!submission) throw new NotFoundError('Submission')
    res.json({ success: true, data: { submission, readiness: computeReadiness(submission.items) } })
  } catch (err) { next(err) }
})

router.patch('/:submissionId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    // Submitted workspaces are immutable.
    if (s.status === 'SUBMITTED' || s.status === 'CONFIRMED') throw new ConflictError('A submitted workspace is immutable and cannot be edited.')
    const data: Prisma.ProposalSubmissionUpdateInput = {}
    if (typeof req.body?.title === 'string' && req.body.title.trim()) data.title = req.body.title.trim().slice(0, 300)
    for (const k of ['submissionMethod', 'destinationDescription', 'notes'] as const) if (k in (req.body ?? {})) (data as Record<string, unknown>)[k] = req.body[k] ?? null
    if ('finalDeadline' in (req.body ?? {})) data.finalDeadline = req.body.finalDeadline ? new Date(req.body.finalDeadline) : null
    if ('internalDeadline' in (req.body ?? {})) data.internalDeadline = req.body.internalDeadline ? new Date(req.body.internalDeadline) : null
    if ('ownerUserId' in (req.body ?? {})) {
      if (req.body.ownerUserId) { const u = await prisma.user.findFirst({ where: { id: req.body.ownerUserId, consultingFirmId: firmId }, select: { id: true } }); if (!u) throw new ValidationError('ownerUserId does not belong to your firm') }
      data.ownerUserId = req.body.ownerUserId ?? null
    }
    const updated = await prisma.proposalSubmission.update({ where: { id: s.id }, data })
    await audit(req, firmId, 'UPDATE', 'ProposalSubmission', s.id, 'Submission updated')
    res.json({ success: true, data: { submission: updated } })
  } catch (err) { next(err) }
})

router.post('/:submissionId/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    // Archive only allowed for early-stage workspaces; submitted ones are immutable.
    if (!['NOT_STARTED', 'IN_PROGRESS'].includes(s.status)) throw new ConflictError(`Only NOT_STARTED or IN_PROGRESS submissions can be archived (this one is ${s.status}).`)
    await prisma.proposalSubmission.update({ where: { id: s.id }, data: { isArchived: true, status: 'ARCHIVED' } })
    await recordHistory(firmId, s.id, 'archived', s.status, 'ARCHIVED', req.user?.userId)
    await audit(req, firmId, 'ARCHIVED', 'ProposalSubmission', s.id, 'Submission archived')
    res.json({ success: true, data: { archived: true } })
  } catch (err) { next(err) }
})

// =============================================================
// CHECKLIST — generate from verified requirements (additive, deduped)
// =============================================================
router.post('/:submissionId/generate-checklist', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    const existing = await prisma.submissionChecklistItem.findMany({ where: { submissionId: s.id }, select: { sourceMatrixRequirementId: true, sourceProposalSectionId: true, sourceDocumentRequirementId: true } })
    const haveMatrix = new Set(existing.map((e) => e.sourceMatrixRequirementId).filter(Boolean))
    const haveSection = new Set(existing.map((e) => e.sourceProposalSectionId).filter(Boolean))
    const haveDoc = new Set(existing.map((e) => e.sourceDocumentRequirementId).filter(Boolean))

    const matrix = await prisma.complianceMatrix.findFirst({ where: { opportunityId: s.opportunityId, consultingFirmId: firmId }, select: { id: true } })
    const verified = matrix ? await prisma.matrixRequirement.findMany({ where: { matrixId: matrix.id, verificationStatus: 'VERIFIED' }, orderBy: { sortOrder: 'asc' } }) : []
    const sections = await prisma.proposalSection.findMany({ where: { consultingFirmId: firmId, opportunityId: s.opportunityId, ...(s.proposalId ? { proposalId: s.proposalId } : {}) }, orderBy: { sortOrder: 'asc' } })
    const docReqs = await prisma.documentRequirement.findMany({ where: { consultingFirmId: firmId, opportunityId: s.opportunityId } })

    const mapType = (sectionType: string): string => {
      const t = sectionType.toUpperCase()
      if (t === 'DOCUMENT') return 'DOCUMENT'
      if (t === 'CERTIFICATION') return 'CERTIFICATION'
      if (t === 'FORMAT' || t === 'FORM') return 'FORM'
      return 'OTHER'
    }

    let order = (await prisma.submissionChecklistItem.aggregate({ where: { submissionId: s.id }, _max: { sortOrder: true } }))._max.sortOrder ?? -1
    const toCreate: Prisma.SubmissionChecklistItemCreateManyInput[] = []
    for (const r of verified) {
      if (haveMatrix.has(r.id)) continue
      toCreate.push({ consultingFirmId: firmId, submissionId: s.id, title: r.requirementText.slice(0, 300), itemType: mapType(r.sectionType), isMandatory: r.isMandatory, sourceMatrixRequirementId: r.id, sourceSection: r.section, sourcePage: r.sourcePageNumber ?? null, sortOrder: ++order })
    }
    for (const sec of sections) {
      if (haveSection.has(sec.id)) continue
      toCreate.push({ consultingFirmId: firmId, submissionId: s.id, title: `Proposal section: ${sec.title}`, itemType: 'PROPOSAL_SECTION', isMandatory: true, sourceProposalSectionId: sec.id, status: sec.status === 'APPROVED' ? 'COMPLETE' : 'PENDING', sortOrder: ++order })
    }
    for (const d of docReqs) {
      if (haveDoc.has(d.id)) continue
      toCreate.push({ consultingFirmId: firmId, submissionId: s.id, title: `Document: ${d.title}`, itemType: 'DOCUMENT', isMandatory: true, sourceDocumentRequirementId: d.id, dueDate: d.dueDate, sortOrder: ++order })
    }
    if (toCreate.length > 0) await prisma.submissionChecklistItem.createMany({ data: toCreate })
    const readiness = await recomputeReadiness(s.id)
    await audit(req, firmId, 'UPDATE', 'ProposalSubmission', s.id, `Checklist generated: +${toCreate.length} items (verified reqs preserved)`)
    res.status(201).json({ success: true, data: { added: toCreate.length, readiness } })
  } catch (err) { next(err) }
})

router.post('/:submissionId/items', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 300) : null
    if (!title) throw new ValidationError('An item title is required')
    const itemType = typeof req.body?.itemType === 'string' && (CHECKLIST_ITEM_TYPES as readonly string[]).includes(req.body.itemType) ? req.body.itemType : 'OTHER'
    const order = ((await prisma.submissionChecklistItem.aggregate({ where: { submissionId: s.id }, _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1
    const item = await prisma.submissionChecklistItem.create({ data: { consultingFirmId: firmId, submissionId: s.id, title, description: typeof req.body?.description === 'string' ? req.body.description : null, itemType, isMandatory: req.body?.isMandatory === true, dueDate: req.body?.dueDate ? new Date(req.body.dueDate) : null, isManuallyVerified: true, sortOrder: order } })
    const readiness = await recomputeReadiness(s.id)
    await audit(req, firmId, 'CREATE', 'SubmissionChecklistItem', item.id, `Item added: ${title}`)
    res.status(201).json({ success: true, data: { item, readiness } })
  } catch (err) { next(err) }
})

router.patch('/items/:itemId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const item = await loadItem(firmId, req.params.itemId)
    const data: Record<string, unknown> = {}
    for (const k of ['title', 'description', 'status', 'isMandatory', 'notes', 'blockerReason'] as const) if (k in (req.body ?? {})) data[k] = (req.body as Record<string, unknown>)[k]
    if ('dueDate' in (req.body ?? {})) data.dueDate = req.body.dueDate ? new Date(req.body.dueDate) : null
    if ('ownerUserId' in (req.body ?? {})) {
      if (req.body.ownerUserId) { const u = await prisma.user.findFirst({ where: { id: req.body.ownerUserId, consultingFirmId: firmId }, select: { id: true } }); if (!u) throw new ValidationError('ownerUserId does not belong to your firm') }
      data.ownerUserId = req.body.ownerUserId ?? null
    }
    if (data.status && !['PENDING', 'IN_PROGRESS', 'COMPLETE', 'VALIDATED', 'BLOCKED', 'NA'].includes(String(data.status))) throw new ValidationError('Invalid item status')
    if (req.body?.markManuallyVerified === true) data.isManuallyVerified = true
    const updated = await prisma.submissionChecklistItem.update({ where: { id: item.id }, data })
    const readiness = await recomputeReadiness(item.submissionId)
    await audit(req, firmId, 'UPDATE', 'SubmissionChecklistItem', item.id, 'Item updated')
    res.json({ success: true, data: { item: updated, readiness } })
  } catch (err) { next(err) }
})

// DELETE /items/:itemId — manual items (no generated source) are hard-deleted;
// generated items are soft-archived instead so a regenerate can't silently drop
// a tracked requirement.
router.delete('/items/:itemId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const item = await loadItem(firmId, req.params.itemId)
    const isGenerated = !!(item.sourceMatrixRequirementId || item.sourceProposalSectionId || item.sourceDocumentRequirementId)
    if (isGenerated) {
      await prisma.submissionChecklistItem.update({ where: { id: item.id }, data: { isArchived: true } })
      await audit(req, firmId, 'ARCHIVED', 'SubmissionChecklistItem', item.id, 'Generated checklist item archived')
    } else {
      await prisma.submissionChecklistItem.delete({ where: { id: item.id } })
      await audit(req, firmId, 'DELETE', 'SubmissionChecklistItem', item.id, 'Manual checklist item deleted')
    }
    const readiness = await recomputeReadiness(item.submissionId)
    res.json({ success: true, data: { removed: true, archived: isGenerated, readiness } })
  } catch (err) { next(err) }
})

// POST /items/:itemId/restore — un-archive a generated item.
router.post('/items/:itemId/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const item = await loadItem(firmId, req.params.itemId)
    const updated = await prisma.submissionChecklistItem.update({ where: { id: item.id }, data: { isArchived: false } })
    const readiness = await recomputeReadiness(item.submissionId)
    await audit(req, firmId, 'RESTORED', 'SubmissionChecklistItem', item.id, 'Checklist item restored')
    res.json({ success: true, data: { item: updated, readiness } })
  } catch (err) { next(err) }
})

router.post('/items/:itemId/block', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    if (!reason) throw new ValidationError('A blocker reason is required')
    const item = await loadItem(firmId, req.params.itemId)
    const updated = await prisma.submissionChecklistItem.update({ where: { id: item.id }, data: { isBlocker: true, blockerReason: reason, status: 'BLOCKED' } })
    const readiness = await recomputeReadiness(item.submissionId)
    await audit(req, firmId, 'UPDATE', 'SubmissionChecklistItem', item.id, `Blocker raised: ${reason}`)
    res.json({ success: true, data: { item: updated, readiness } })
  } catch (err) { next(err) }
})

router.post('/items/:itemId/resolve-blocker', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const item = await loadItem(firmId, req.params.itemId)
    const updated = await prisma.submissionChecklistItem.update({ where: { id: item.id }, data: { isBlocker: false, blockerReason: null, status: item.status === 'BLOCKED' ? 'IN_PROGRESS' : item.status } })
    const readiness = await recomputeReadiness(item.submissionId)
    await audit(req, firmId, 'UPDATE', 'SubmissionChecklistItem', item.id, 'Blocker resolved')
    res.json({ success: true, data: { item: updated, readiness } })
  } catch (err) { next(err) }
})

router.post('/items/:itemId/validate', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const item = await loadItem(firmId, req.params.itemId)
    let fileExists = false, fileSize: number | null = null
    if (item.attachmentKey) {
      const p = path.join(process.cwd(), 'uploads', item.attachmentKey)
      fileExists = fs.existsSync(p)
      if (fileExists) { try { fileSize = fs.statSync(p).size } catch { fileSize = null } }
    }
    const result = validateDocumentItem({
      itemType: item.itemType, attachmentKey: item.attachmentKey, attachmentName: item.attachmentName, fileExists, fileSize,
      expectedExtensions: Array.isArray(req.body?.expectedExtensions) ? req.body.expectedExtensions : null,
      expectedNameIncludes: typeof req.body?.expectedNameIncludes === 'string' ? req.body.expectedNameIncludes : null,
      maxSizeBytes: typeof req.body?.maxSizeBytes === 'number' ? req.body.maxSizeBytes : null,
    })
    const updated = await prisma.submissionChecklistItem.update({ where: { id: item.id }, data: { validationState: result.state, validationEvidence: result.evidence, validatedByUserId: req.user?.userId ?? null, validatedAt: new Date(), status: result.state === 'PASSED' ? 'VALIDATED' : item.status } })
    const readiness = await recomputeReadiness(item.submissionId)
    await audit(req, firmId, 'UPDATE', 'SubmissionChecklistItem', item.id, `Validated: ${result.state} — ${result.evidence}`)
    res.json({ success: true, data: { item: updated, readiness } })
  } catch (err) { next(err) }
})

router.post('/items/:itemId/attachment', requireRole('ADMIN'), upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const item = await loadItem(firmId, req.params.itemId)
    if (!req.file) throw new ValidationError('No file uploaded')
    const updated = await prisma.submissionChecklistItem.update({ where: { id: item.id }, data: { attachmentKey: path.basename(req.file.path), attachmentName: req.file.originalname } })
    await audit(req, firmId, 'UPDATE', 'SubmissionChecklistItem', item.id, `Attachment added: ${req.file.originalname}`)
    res.status(201).json({ success: true, data: { item: { id: updated.id, attachmentName: updated.attachmentName } } })
  } catch (err) { next(err) }
})

router.get('/items/:itemId/attachment', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const item = await loadItem(firmId, req.params.itemId)
    if (!item.attachmentKey) throw new NotFoundError('Attachment')
    const filePath = path.join(process.cwd(), 'uploads', item.attachmentKey)
    if (!fs.existsSync(filePath)) throw new NotFoundError('File not found on disk')
    res.download(filePath, item.attachmentName ?? item.attachmentKey)
  } catch (err) { next(err) }
})

// =============================================================
// READINESS + WORKFLOW TRANSITIONS
// =============================================================
router.get('/:submissionId/readiness', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    const items = await prisma.submissionChecklistItem.findMany({ where: { submissionId: s.id, isArchived: false }, select: { status: true, isMandatory: true, isBlocker: true, dueDate: true } })
    res.json({ success: true, data: { readiness: computeReadiness(items), status: s.status } })
  } catch (err) { next(err) }
})

router.post('/:submissionId/mark-ready', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    const items = await prisma.submissionChecklistItem.findMany({ where: { submissionId: s.id, isArchived: false }, select: { status: true, isMandatory: true, isBlocker: true, dueDate: true } })
    const r = computeReadiness(items)
    const overrideReason = typeof req.body?.overrideReason === 'string' ? req.body.overrideReason.trim() : ''
    if (!r.canBeReady) {
      if (!overrideReason) throw new ConflictError(`Not ready: ${r.blockingReasons.join('; ')}. Provide an overrideReason (min 20 chars) to force READY_TO_SUBMIT.`)
      if (overrideReason.length < 20) throw new ValidationError('Override reason must be at least 20 characters')
    }
    const updated = await prisma.proposalSubmission.update({ where: { id: s.id }, data: { status: 'READY_TO_SUBMIT', readinessPercent: r.overallPercent, overrideReason: r.canBeReady ? null : overrideReason, overriddenByUserId: r.canBeReady ? null : req.user?.userId ?? null } })
    await recordHistory(firmId, s.id, r.canBeReady ? 'marked ready' : 'marked ready (override)', s.status, 'READY_TO_SUBMIT', req.user?.userId, r.canBeReady ? null : overrideReason)
    await audit(req, firmId, 'UPDATE', 'ProposalSubmission', s.id, r.canBeReady ? 'Marked READY_TO_SUBMIT' : `Marked READY_TO_SUBMIT (override): ${overrideReason}`)
    res.json({ success: true, data: { submission: updated, readiness: r } })
  } catch (err) { next(err) }
})

router.post('/:submissionId/submit', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    if (s.status === 'SUBMITTED' || s.status === 'CONFIRMED') throw new ConflictError('This submission has already been submitted.')
    const items = await prisma.submissionChecklistItem.findMany({ where: { submissionId: s.id, isArchived: false }, select: { status: true, isMandatory: true, isBlocker: true, dueDate: true } })
    const r = computeReadiness(items)
    const overrideReason = typeof req.body?.overrideReason === 'string' ? req.body.overrideReason.trim() : ''
    if (!r.canBeReady) {
      if (!overrideReason) throw new ConflictError(`Submission is not ready: ${r.blockingReasons.join('; ')}. Provide an overrideReason (min 20 chars) to record submission anyway.`)
      if (overrideReason.length < 20) throw new ValidationError('Override reason must be at least 20 characters')
    }
    const updated = await prisma.proposalSubmission.update({
      where: { id: s.id },
      data: {
        status: 'SUBMITTED', submittedAt: new Date(), submittedByUserId: req.user?.userId ?? null,
        submissionMethod: typeof req.body?.submissionMethod === 'string' ? req.body.submissionMethod : s.submissionMethod,
        destinationDescription: typeof req.body?.destinationDescription === 'string' ? req.body.destinationDescription : s.destinationDescription,
        confirmationReference: typeof req.body?.confirmationReference === 'string' ? req.body.confirmationReference : s.confirmationReference,
        overrideReason: r.canBeReady ? s.overrideReason : overrideReason, overriddenByUserId: r.canBeReady ? s.overriddenByUserId : req.user?.userId ?? null,
      },
    })
    await recordHistory(firmId, s.id, 'submitted', s.status, 'SUBMITTED', req.user?.userId, overrideReason || null)
    await audit(req, firmId, 'APPROVAL', 'ProposalSubmission', s.id, `Submission recorded as SUBMITTED (user-recorded; no government portal action)`)
    res.json({ success: true, data: { submission: updated } })
  } catch (err) { next(err) }
})

router.post('/:submissionId/confirm', requireRole('ADMIN'), upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    if (s.status !== 'SUBMITTED') throw new ConflictError('Only a SUBMITTED submission can be confirmed.')
    const data: Prisma.ProposalSubmissionUpdateInput = { status: 'CONFIRMED', confirmationReceivedAt: new Date() }
    if (typeof req.body?.confirmationReference === 'string') data.confirmationReference = req.body.confirmationReference
    if (req.file) { data.confirmationAttachmentKey = path.basename(req.file.path); data.confirmationAttachmentName = req.file.originalname }
    const updated = await prisma.proposalSubmission.update({ where: { id: s.id }, data })
    await recordHistory(firmId, s.id, 'confirmed', s.status, 'CONFIRMED', req.user?.userId)
    await audit(req, firmId, 'UPDATE', 'ProposalSubmission', s.id, 'Confirmation recorded')
    res.json({ success: true, data: { submission: updated } })
  } catch (err) { next(err) }
})

router.get('/:submissionId/confirmation-attachment', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    if (!s.confirmationAttachmentKey) throw new NotFoundError('Confirmation attachment')
    const filePath = path.join(process.cwd(), 'uploads', s.confirmationAttachmentKey)
    if (!fs.existsSync(filePath)) throw new NotFoundError('File not found on disk')
    res.download(filePath, s.confirmationAttachmentName ?? s.confirmationAttachmentKey)
  } catch (err) { next(err) }
})

async function simpleTransition(req: AuthenticatedRequest, res: Response, id: string, to: string, action: string, reasonRequired: boolean) {
  const firmId = getTenantId(req)
  const s = await loadSubmission(firmId, id)
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
  if (reasonRequired && !reason) throw new ValidationError('A reason is required')
  const updated = await prisma.proposalSubmission.update({ where: { id: s.id }, data: { status: to, notes: reason ? `${action}: ${reason}` : s.notes } })
  await recordHistory(firmId, s.id, action, s.status, to, req.user?.userId, reason || null)
  await audit(req, firmId, 'UPDATE', 'ProposalSubmission', s.id, `${action}${reason ? `: ${reason}` : ''}`)
  res.json({ success: true, data: { submission: updated } })
}
router.post('/:submissionId/reject', requireRole('ADMIN'), (req, res, next) => simpleTransition(req, res, req.params.submissionId, 'REJECTED', 'rejected', true).catch(next))
router.post('/:submissionId/withdraw', requireRole('ADMIN'), (req, res, next) => simpleTransition(req, res, req.params.submissionId, 'WITHDRAWN', 'withdrawn', true).catch(next))
router.post('/:submissionId/miss', requireRole('ADMIN'), (req, res, next) => simpleTransition(req, res, req.params.submissionId, 'MISSED', 'missed', false).catch(next))

router.get('/:submissionId/history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadSubmission(firmId, req.params.submissionId)
    const history = await prisma.submissionStatusHistory.findMany({ where: { consultingFirmId: firmId, submissionId: req.params.submissionId }, orderBy: { createdAt: 'desc' } })
    res.json({ success: true, data: { history } })
  } catch (err) { next(err) }
})

// =============================================================
// REMINDERS (in-app, deduped, tenant + owner scoped)
// =============================================================
router.get('/:submissionId/reminders', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    res.json({ success: true, data: { reminders: buildReminders(s, await prisma.submissionChecklistItem.findMany({ where: { submissionId: s.id } })) } })
  } catch (err) { next(err) }
})

router.post('/:submissionId/reminders/dispatch', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const s = await loadSubmission(firmId, req.params.submissionId)
    if (REMINDER_SUPPRESSED.includes(s.status)) return res.json({ success: true, data: { dispatched: 0, suppressed: true } })
    const items = await prisma.submissionChecklistItem.findMany({ where: { submissionId: s.id } })
    const reminders = buildReminders(s, items)
    const targetUserId = s.ownerUserId
    let dispatched = 0
    if (targetUserId) {
      for (const rem of reminders) {
        await notifyUser({ consultingFirmId: firmId, userId: targetUserId, type: 'SUBMISSION_REMINDER', title: rem.title, linkPath: `/opportunities/${s.opportunityId}/submission`, entityType: 'ProposalSubmission', entityId: s.id, dedupeKey: `submission-reminder:${s.id}:${rem.kind}:${rem.dateKey}` })
        dispatched++
      }
    }
    res.json({ success: true, data: { dispatched, reminderCount: reminders.length } })
  } catch (err) { next(err) }
})

interface Reminder { kind: string; title: string; dateKey: string }
function buildReminders(s: { finalDeadline: Date | null; internalDeadline: Date | null; status: string }, items: { status: string; isMandatory: boolean; dueDate: Date | null; isBlocker: boolean; title: string }[]): Reminder[] {
  const now = Date.now()
  const SOON = 3 * 86_400_000
  const out: Reminder[] = []
  const dk = (d: Date) => d.toISOString().slice(0, 10)
  if (s.internalDeadline && s.internalDeadline.getTime() - now < SOON && s.internalDeadline.getTime() > now) out.push({ kind: 'internal-approaching', title: 'Internal submission deadline is approaching', dateKey: dk(s.internalDeadline) })
  if (s.finalDeadline) {
    if (s.finalDeadline.getTime() < now && !['SUBMITTED', 'CONFIRMED'].includes(s.status)) out.push({ kind: 'final-missed', title: 'Final submission deadline has passed', dateKey: dk(s.finalDeadline) })
    else if (s.finalDeadline.getTime() - now < SOON) out.push({ kind: 'final-approaching', title: 'Final submission deadline is approaching', dateKey: dk(s.finalDeadline) })
  }
  const overdueMandatory = items.filter((i) => i.isMandatory && i.dueDate && i.dueDate.getTime() < now && !['COMPLETE', 'VALIDATED', 'NA'].includes(i.status))
  if (overdueMandatory.length > 0) out.push({ kind: 'items-overdue', title: `${overdueMandatory.length} mandatory checklist item(s) overdue`, dateKey: new Date(now).toISOString().slice(0, 10) })
  if (s.status === 'READY_FOR_REVIEW') out.push({ kind: 'ready-for-review', title: 'Submission is ready for review', dateKey: new Date(now).toISOString().slice(0, 10) })
  if (s.status === 'SUBMITTED') out.push({ kind: 'awaiting-confirmation', title: 'Submission is awaiting confirmation', dateKey: new Date(now).toISOString().slice(0, 10) })
  return out
}

export default router
