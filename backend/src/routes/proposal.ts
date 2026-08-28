// =============================================================
// Proposal Workspace + Responsibility Matrix (§5.1 Stage 5 / §5.2). Built on the
// existing ProposalSection records (the same rows power the workspace and the
// responsibility matrix — no disconnected assignment rows). One ACTIVE proposal
// per opportunity; content is versioned and approved content is never silently
// overwritten; assignment/review transitions are retained and audited; in-app
// notifications are deduped. AI section drafting reuses the exact drafting prompt
// (proposalSectionDraft) with a deterministic no-key fallback + generation states
// + duplicate-generation guard. Mounted at /api/proposal. ADMIN writes.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { notifyUser } from '../services/notificationService'
import { upload } from '../middleware/upload'
import { prisma } from '../config/database'
import { generateSectionDraft, buildOutlineFromRequirements } from '../services/proposalSectionDraft'
import { emitProposalSectionApproved, isHumanSectionApproval } from '../services/agents/proposal/proposalEvents'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const SECTION_STATUSES = ['OUTLINE', 'DRAFTING', 'IN_REVIEW', 'CHANGES_REQUESTED', 'APPROVED'] as const
const APPROVED = 'APPROVED'

const audit = (req: AuthenticatedRequest, firmId: string, action: AuditAction, entityType: string, entityId: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId: firmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId, rationale, before, after })

async function loadProposal(firmId: string, id: string) {
  const p = await prisma.proposal.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!p) throw new NotFoundError('Proposal')
  return p
}
async function loadSection(firmId: string, id: string) {
  const s = await prisma.proposalSection.findFirst({ where: { id, consultingFirmId: firmId } })
  if (!s) throw new NotFoundError('Proposal section')
  return s
}
async function assertFirmUser(firmId: string, userId: string) {
  const u = await prisma.user.findFirst({ where: { id: userId, consultingFirmId: firmId }, select: { id: true } })
  if (!u) throw new ValidationError('userId does not belong to your firm')
}
function decorateSection<T extends { status: string; dueDate: Date | null }>(s: T, now: Date) {
  return { ...s, isOverdue: !!s.dueDate && s.dueDate.getTime() < now.getTime() && s.status !== APPROVED }
}
async function recordReview(firmId: string, sectionId: string, action: string, fromStatus: string | null, toStatus: string | null, actorUserId?: string, comment?: string | null) {
  await prisma.proposalSectionReview.create({ data: { consultingFirmId: firmId, proposalSectionId: sectionId, action, fromStatus, toStatus, actorUserId: actorUserId ?? null, comment: comment ?? null } })
}

// =============================================================
// PROPOSAL
// =============================================================
router.post('/opportunity/:opportunityId', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 300) : null
    if (!title) throw new ValidationError('A proposal title is required')
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId: firmId }, select: { id: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const activeDupe = await prisma.proposal.findFirst({ where: { consultingFirmId: firmId, opportunityId: opp.id, status: 'ACTIVE' }, select: { id: true } })
    if (activeDupe) throw new ConflictError('An active proposal already exists for this opportunity.')
    const proposal = await prisma.proposal.create({ data: { consultingFirmId: firmId, opportunityId: opp.id, title, createdByUserId: req.user?.userId ?? null } })
    await audit(req, firmId, 'CREATE', 'Proposal', proposal.id, `Proposal created: ${title}`)
    res.status(201).json({ success: true, data: { proposal } })
  } catch (err) { next(err) }
})

router.get('/opportunity/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const now = new Date()
    const includeArchivedSections = String(req.query.includeArchivedSections) === 'true'
    const proposal = await prisma.proposal.findFirst({
      where: { consultingFirmId: firmId, opportunityId: req.params.opportunityId, status: 'ACTIVE' },
      include: { sections: { where: includeArchivedSections ? {} : { isArchived: false }, orderBy: { sortOrder: 'asc' } } },
    })
    if (!proposal) return res.json({ success: true, data: { exists: false } })
    const sections = proposal.sections.map((s) => decorateSection(s, now))
    // Archived sections don't count toward X/Y approved progress.
    const active = sections.filter((s) => !s.isArchived)
    const approved = active.filter((s) => s.status === APPROVED).length
    res.json({ success: true, data: { exists: true, proposal: { ...proposal, sections }, progress: { total: active.length, approved, percent: active.length ? Math.round((approved / active.length) * 100) : 0 } } })
  } catch (err) { next(err) }
})

router.post('/:proposalId/archive', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const proposal = await loadProposal(firmId, req.params.proposalId)
    const updated = await prisma.proposal.update({ where: { id: proposal.id }, data: { status: 'ARCHIVED' } })
    await audit(req, firmId, 'ARCHIVED', 'Proposal', proposal.id, 'Proposal archived', { status: proposal.status }, { status: 'ARCHIVED' })
    res.json({ success: true, data: { proposal: updated } })
  } catch (err) { next(err) }
})

// PATCH /api/proposal/:proposalId — rename the proposal (ADMIN). Delete is never
// permitted; archive/restore is the lifecycle.
router.patch('/:proposalId', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const proposal = await loadProposal(firmId, req.params.proposalId)
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 300) : ''
    if (!title) throw new ValidationError('A proposal title is required')
    const updated = await prisma.proposal.update({ where: { id: proposal.id }, data: { title } })
    await audit(req, firmId, 'UPDATE', 'Proposal', proposal.id, 'Proposal renamed', { title: proposal.title }, { title })
    res.json({ success: true, data: { proposal: updated } })
  } catch (err) { next(err) }
})

// POST /api/proposal/:proposalId/restore — reactivate an archived proposal (ADMIN).
// Blocked if another active proposal already exists for the opportunity.
router.post('/:proposalId/restore', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const proposal = await loadProposal(firmId, req.params.proposalId)
    const activeDupe = await prisma.proposal.findFirst({ where: { consultingFirmId: firmId, opportunityId: proposal.opportunityId, status: 'ACTIVE', id: { not: proposal.id } }, select: { id: true } })
    if (activeDupe) throw new ConflictError('An active proposal already exists for this opportunity — archive it before restoring this one.')
    const updated = await prisma.proposal.update({ where: { id: proposal.id }, data: { status: 'ACTIVE' } })
    await audit(req, firmId, 'RESTORED', 'Proposal', proposal.id, 'Proposal restored', { status: proposal.status }, { status: 'ACTIVE' })
    res.json({ success: true, data: { proposal: updated } })
  } catch (err) { next(err) }
})

// GET /api/proposal/opportunity/:opportunityId/archived — archived proposals for the restore UI.
router.get('/opportunity/:opportunityId/archived', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const proposals = await prisma.proposal.findMany({
      where: { consultingFirmId: firmId, opportunityId: req.params.opportunityId, status: 'ARCHIVED' },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, status: true, updatedAt: true },
    })
    res.json({ success: true, data: { proposals } })
  } catch (err) { next(err) }
})

// Generate an outline (sections) from the opportunity's VERIFIED compliance
// requirements (deterministic — no fabricated section names).
router.post('/:proposalId/outline', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const proposal = await loadProposal(firmId, req.params.proposalId)
    const matrix = await prisma.complianceMatrix.findFirst({ where: { opportunityId: proposal.opportunityId, consultingFirmId: firmId }, select: { id: true } })
    const requirements = matrix ? await prisma.matrixRequirement.findMany({ where: { matrixId: matrix.id, verificationStatus: 'VERIFIED' }, select: { requirementText: true, proposalSection: true, sectionType: true, isMandatory: true } }) : []
    const outline = buildOutlineFromRequirements(requirements)
    if (outline.length === 0) throw new ValidationError('No verified compliance requirements to build an outline from. Verify requirements first.')
    const existing = await prisma.proposalSection.count({ where: { proposalId: proposal.id } })
    const created = await prisma.$transaction(outline.map((s, i) => prisma.proposalSection.create({
      data: { consultingFirmId: firmId, opportunityId: proposal.opportunityId, proposalId: proposal.id, title: s.title, sortOrder: existing + i, outline: s.requirementPreview.map((r) => `- ${r}`).join('\n') },
    })))
    await audit(req, firmId, 'CREATE', 'Proposal', proposal.id, `Outline generated: ${created.length} sections from verified requirements`)
    res.status(201).json({ success: true, data: { sections: created } })
  } catch (err) { next(err) }
})

// =============================================================
// SECTIONS — CRUD, reorder, assignment
// =============================================================
const dateOpt = z.string().datetime().transform((s) => new Date(s)).nullable().optional()
const SectionCreateSchema = z.object({
  title: z.string().trim().min(1).max(300),
  sectionNumber: z.string().trim().max(40).optional(),
  outline: z.string().max(20000).optional(),
  pageLimit: z.number().int().min(1).max(10000).optional(),
  ownerUserId: z.string().max(64).nullable().optional(),
  reviewerUserId: z.string().max(64).nullable().optional(),
  dueDate: dateOpt,
  reviewDate: dateOpt,
  notes: z.string().max(10000).nullable().optional(),
  dependencies: z.array(z.string().max(120)).max(50).optional(),
})

router.post('/:proposalId/sections', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const parsed = SectionCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid section payload')
    const proposal = await loadProposal(firmId, req.params.proposalId)
    const max = await prisma.proposalSection.aggregate({ where: { proposalId: proposal.id }, _max: { sortOrder: true } })
    const d = parsed.data
    const section = await prisma.proposalSection.create({ data: {
      consultingFirmId: firmId, opportunityId: proposal.opportunityId, proposalId: proposal.id,
      title: d.title, sectionNumber: d.sectionNumber ?? null, outline: d.outline ?? null, pageLimit: d.pageLimit ?? null,
      ownerUserId: d.ownerUserId ?? null, reviewerUserId: d.reviewerUserId ?? null, dueDate: d.dueDate ?? null, reviewDate: d.reviewDate ?? null,
      notes: d.notes ?? null, dependencies: d.dependencies ?? [], sortOrder: (max._max.sortOrder ?? -1) + 1,
    } })
    await audit(req, firmId, 'CREATE', 'ProposalSection', section.id, `Section created: ${section.title}`)
    res.status(201).json({ success: true, data: { section } })
  } catch (err) { next(err) }
})

const SectionUpdateSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  sectionNumber: z.string().trim().max(40).nullable().optional(),
  outline: z.string().max(20000).nullable().optional(),
  notes: z.string().max(10000).nullable().optional(),
  dependencies: z.array(z.string().max(120)).max(50).optional(),
  dueDate: z.string().datetime().transform((s) => new Date(s)).nullable().optional(),
  reviewDate: z.string().datetime().transform((s) => new Date(s)).nullable().optional(),
  pageLimit: z.number().int().min(1).max(10000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })

router.patch('/sections/:sectionId', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const parsed = SectionUpdateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid update payload')
    const section = await loadSection(firmId, req.params.sectionId)
    const data: Prisma.ProposalSectionUpdateInput = {}
    for (const k of ['title', 'sectionNumber', 'outline', 'notes', 'dueDate', 'reviewDate', 'pageLimit', 'sortOrder'] as const) if (k in parsed.data) (data as Record<string, unknown>)[k] = parsed.data[k] ?? null
    if (parsed.data.dependencies) data.dependencies = parsed.data.dependencies
    const updated = await prisma.proposalSection.update({ where: { id: section.id }, data })
    await audit(req, firmId, 'UPDATE', 'ProposalSection', section.id, 'Section updated')
    res.json({ success: true, data: { section: decorateSection(updated, new Date()) } })
  } catch (err) { next(err) }
})

// Batch reorder within a proposal.
router.post('/:proposalId/sections/reorder', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const orderedIds: unknown = req.body?.orderedIds
    if (!Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== 'string')) throw new ValidationError('orderedIds must be an array of section ids')
    const proposal = await loadProposal(firmId, req.params.proposalId)
    await prisma.$transaction((orderedIds as string[]).map((id, i) => prisma.proposalSection.updateMany({ where: { id, proposalId: proposal.id, consultingFirmId: firmId }, data: { sortOrder: i } })))
    await audit(req, firmId, 'UPDATE', 'Proposal', proposal.id, 'Sections reordered')
    res.json({ success: true, data: { reordered: orderedIds.length } })
  } catch (err) { next(err) }
})

// Sections are never hard-deleted — DELETE soft-archives (ADMIN). Archived
// sections drop out of the approved count but remain recoverable.
router.delete('/sections/:sectionId', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const section = await loadSection(firmId, req.params.sectionId)
    const updated = await prisma.proposalSection.update({ where: { id: section.id }, data: { isArchived: true } })
    await audit(req, firmId, 'ARCHIVED', 'ProposalSection', section.id, `Section archived: ${section.title}`)
    res.json({ success: true, data: { section: decorateSection(updated, new Date()) } })
  } catch (err) { next(err) }
})

router.post('/sections/:sectionId/restore', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const section = await loadSection(firmId, req.params.sectionId)
    const updated = await prisma.proposalSection.update({ where: { id: section.id }, data: { isArchived: false } })
    await audit(req, firmId, 'RESTORED', 'ProposalSection', section.id, `Section restored: ${section.title}`)
    res.json({ success: true, data: { section: decorateSection(updated, new Date()) } })
  } catch (err) { next(err) }
})

// Reopen an approved section for edits (ADMIN or the approver). Distinct from
// request-changes: no reviewer round-trip, just unlocks editing.
router.post('/sections/:sectionId/reopen', requirePermission('PROPOSAL_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const section = await loadSection(firmId, req.params.sectionId)
    if (section.status !== APPROVED) throw new ConflictError('Only approved sections can be reopened for edits.')
    const updated = await prisma.proposalSection.update({ where: { id: section.id }, data: { status: 'DRAFTING', approvedAt: null, approvedByUserId: null } })
    await audit(req, firmId, 'SECTION_REOPENED', 'ProposalSection', section.id, `Section reopened for edits: ${section.title}`, { status: APPROVED }, { status: 'DRAFTING' })
    res.json({ success: true, data: { section: decorateSection(updated, new Date()) } })
  } catch (err) { next(err) }
})

router.post('/sections/:sectionId/assign', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const ownerUserId: string | null = typeof req.body?.ownerUserId === 'string' ? req.body.ownerUserId : req.body?.ownerUserId === null ? null : undefined as never
    if (ownerUserId === undefined) throw new ValidationError('ownerUserId is required (or null to unassign)')
    const section = await loadSection(firmId, req.params.sectionId)
    if (ownerUserId) await assertFirmUser(firmId, ownerUserId)
    const updated = await prisma.proposalSection.update({ where: { id: section.id }, data: { ownerUserId } })
    await recordReview(firmId, section.id, 'ASSIGNED', section.status, section.status, req.user?.userId, ownerUserId ? `Writer assigned` : 'Writer unassigned')
    if (ownerUserId && ownerUserId !== req.user?.userId) await notifyUser({ consultingFirmId: firmId, userId: ownerUserId, type: 'PROPOSAL_ASSIGNMENT', title: `You are the writer for “${section.title}”`, linkPath: `/opportunities/${section.opportunityId}/proposal`, entityType: 'ProposalSection', entityId: section.id, dedupeKey: `proposal-assign:${section.id}:${ownerUserId}` })
    await audit(req, firmId, 'UPDATE', 'ProposalSection', section.id, 'Writer assigned', { ownerUserId: section.ownerUserId }, { ownerUserId })
    res.json({ success: true, data: { section: updated } })
  } catch (err) { next(err) }
})

router.post('/sections/:sectionId/reviewer', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const reviewerUserId: string | null = typeof req.body?.reviewerUserId === 'string' ? req.body.reviewerUserId : req.body?.reviewerUserId === null ? null : undefined as never
    if (reviewerUserId === undefined) throw new ValidationError('reviewerUserId is required (or null)')
    const section = await loadSection(firmId, req.params.sectionId)
    if (reviewerUserId) await assertFirmUser(firmId, reviewerUserId)
    const updated = await prisma.proposalSection.update({ where: { id: section.id }, data: { reviewerUserId } })
    await recordReview(firmId, section.id, 'REVIEWER_SET', section.status, section.status, req.user?.userId)
    await audit(req, firmId, 'UPDATE', 'ProposalSection', section.id, 'Reviewer set', { reviewerUserId: section.reviewerUserId }, { reviewerUserId })
    res.json({ success: true, data: { section: updated } })
  } catch (err) { next(err) }
})

// =============================================================
// SECTION CONTENT (versioned, never overwrite approved)
// =============================================================
router.put('/sections/:sectionId/content', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const content: unknown = req.body?.content
    if (typeof content !== 'string') throw new ValidationError('content (string) is required')
    const section = await loadSection(firmId, req.params.sectionId)
    if (section.status === APPROVED) throw new ConflictError('This section is approved — reopen it (request changes) before editing.')
    const nextVersion = ((await prisma.proposalSectionVersion.aggregate({ where: { proposalSectionId: section.id }, _max: { version: true } }))._max.version ?? 0) + 1
    await prisma.$transaction([
      prisma.proposalSectionVersion.create({ data: { consultingFirmId: firmId, proposalSectionId: section.id, version: nextVersion, content, source: 'HUMAN', createdByUserId: req.user?.userId ?? null } }),
      prisma.proposalSection.update({ where: { id: section.id }, data: { draft: content, wordCount: content.trim() ? content.trim().split(/\s+/).length : 0, isAiGenerated: false, status: section.status === 'OUTLINE' ? 'DRAFTING' : section.status } }),
    ])
    await audit(req, firmId, 'UPDATE', 'ProposalSection', section.id, `Content saved (v${nextVersion})`)
    res.json({ success: true, data: { version: nextVersion } })
  } catch (err) { next(err) }
})

router.get('/sections/:sectionId/versions', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadSection(firmId, req.params.sectionId)
    const versions = await prisma.proposalSectionVersion.findMany({ where: { consultingFirmId: firmId, proposalSectionId: req.params.sectionId }, orderBy: { version: 'desc' } })
    res.json({ success: true, data: { versions } })
  } catch (err) { next(err) }
})

// POST /api/proposal/sections/:sectionId/versions/:version/restore — copy an
// older version's content into a NEW version (immutable history; never overwrites).
router.post('/sections/:sectionId/versions/:version/restore', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const section = await loadSection(firmId, req.params.sectionId)
    if (section.status === APPROVED) throw new ConflictError('This section is approved — reopen it before restoring a version.')
    const src = await prisma.proposalSectionVersion.findFirst({ where: { consultingFirmId: firmId, proposalSectionId: section.id, version: parseInt(req.params.version, 10) } })
    if (!src) throw new NotFoundError('Version')
    const nextVersion = ((await prisma.proposalSectionVersion.aggregate({ where: { proposalSectionId: section.id }, _max: { version: true } }))._max.version ?? 0) + 1
    await prisma.$transaction([
      prisma.proposalSectionVersion.create({ data: { consultingFirmId: firmId, proposalSectionId: section.id, version: nextVersion, content: src.content, source: 'HUMAN', createdByUserId: req.user?.userId ?? null } }),
      prisma.proposalSection.update({ where: { id: section.id }, data: { draft: src.content, wordCount: src.content.trim() ? src.content.trim().split(/\s+/).length : 0, status: section.status === 'OUTLINE' ? 'DRAFTING' : section.status } }),
    ])
    await audit(req, firmId, 'UPDATE', 'ProposalSection', section.id, `Restored v${src.version} into new v${nextVersion}`)
    res.json({ success: true, data: { version: nextVersion, restoredFrom: src.version } })
  } catch (err) { next(err) }
})

router.get('/sections/:sectionId/reviews', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    await loadSection(firmId, req.params.sectionId)
    const reviews = await prisma.proposalSectionReview.findMany({ where: { consultingFirmId: firmId, proposalSectionId: req.params.sectionId }, orderBy: { createdAt: 'desc' } })
    res.json({ success: true, data: { reviews } })
  } catch (err) { next(err) }
})

// =============================================================
// REVIEW WORKFLOW (submit / approve / request-changes / resubmit)
// =============================================================
async function transitionSection(req: AuthenticatedRequest, res: Response, sectionId: string, opts: { action: string; from: string[]; to: string; audit: AuditAction; commentRequired?: boolean; notify?: 'reviewer' | 'writer' }) {
  const firmId = getTenantId(req)
  const section = await loadSection(firmId, sectionId)
  if (!opts.from.includes(section.status)) throw new ConflictError(`Cannot ${opts.action} a section in status ${section.status}`)
  const comment = typeof req.body?.comment === 'string' ? req.body.comment.trim() : ''
  if (opts.commentRequired && comment.length < 10) throw new ValidationError('A comment of at least 10 characters is required')
  const now = new Date()
  const data: Prisma.ProposalSectionUpdateInput = { status: opts.to }
  if (opts.to === 'IN_REVIEW') data.submittedForReviewAt = now
  if (opts.to === APPROVED) { data.approvedAt = now; data.approvedByUserId = req.user?.userId ?? null; data.reviewDate = now }

  // §7.7 — the status write and PROPOSAL_SECTION_APPROVED share one
  // transaction, so a rolled-back approval emits nothing. The event fires only
  // on a genuine human transition INTO approved: a draft, a new version, a
  // comment or a READY_FOR_REVIEW move emits nothing at all.
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.proposalSection.update({ where: { id: section.id }, data })
    if (isHumanSectionApproval(section.status, opts.to)) {
      await emitProposalSectionApproved(
        {
          consultingFirmId: firmId,
          proposalSectionId: section.id,
          opportunityId: section.opportunityId,
          proposalId: section.proposalId ?? null,
          approvedByUserId: req.user?.userId ?? null,
        },
        tx,
      )
    }
    return row
  })
  await recordReview(firmId, section.id, opts.action, section.status, opts.to, req.user?.userId, comment || null)
  if (opts.notify === 'reviewer' && updated.reviewerUserId && updated.reviewerUserId !== req.user?.userId) {
    await notifyUser({ consultingFirmId: firmId, userId: updated.reviewerUserId, type: 'PROPOSAL_REVIEW', title: `Section ready for your review: “${section.title}”`, linkPath: `/opportunities/${section.opportunityId}/proposal`, entityType: 'ProposalSection', entityId: section.id, dedupeKey: `proposal-review:${section.id}:${updated.reviewerUserId}:${now.toISOString().slice(0, 10)}:${now.getHours()}${now.getMinutes()}${now.getSeconds()}` })
  }
  if (opts.notify === 'writer' && updated.ownerUserId && updated.ownerUserId !== req.user?.userId) {
    await notifyUser({ consultingFirmId: firmId, userId: updated.ownerUserId, type: 'PROPOSAL_REVIEW', title: `Review update on “${section.title}”: ${opts.to}`, linkPath: `/opportunities/${section.opportunityId}/proposal`, entityType: 'ProposalSection', entityId: section.id, dedupeKey: `proposal-review-writer:${section.id}:${opts.to}:${now.toISOString().slice(0, 10)}:${now.getHours()}${now.getMinutes()}${now.getSeconds()}` })
  }
  await audit(req, firmId, opts.audit, 'ProposalSection', section.id, `Section ${opts.action} → ${opts.to}${comment ? `: ${comment}` : ''}`, { status: section.status }, { status: opts.to })
  res.json({ success: true, data: { section: decorateSection(updated, now) } })
}

router.post('/sections/:sectionId/submit', requirePermission('PROPOSAL_WRITE'), (req, res, next) => transitionSection(req, res, req.params.sectionId, { action: 'submitted', from: ['OUTLINE', 'DRAFTING', 'CHANGES_REQUESTED'], to: 'IN_REVIEW', audit: 'UPDATE', notify: 'reviewer' }).catch(next))
router.post('/sections/:sectionId/resubmit', requirePermission('PROPOSAL_WRITE'), (req, res, next) => transitionSection(req, res, req.params.sectionId, { action: 'resubmitted', from: ['CHANGES_REQUESTED'], to: 'IN_REVIEW', audit: 'UPDATE', notify: 'reviewer' }).catch(next))
router.post('/sections/:sectionId/approve', requirePermission('PROPOSAL_APPROVE'), (req, res, next) => transitionSection(req, res, req.params.sectionId, { action: 'approved', from: ['IN_REVIEW'], to: APPROVED, audit: 'APPROVAL', notify: 'writer' }).catch(next))
router.post('/sections/:sectionId/request-changes', requirePermission('PROPOSAL_APPROVE'), (req, res, next) => transitionSection(req, res, req.params.sectionId, { action: 'changes requested', from: ['IN_REVIEW', APPROVED], to: 'CHANGES_REQUESTED', audit: 'REJECTION', commentRequired: true, notify: 'writer' }).catch(next))

// =============================================================
// AI SECTION DRAFT (generation states + duplicate-generation guard)
// =============================================================
router.post('/sections/:sectionId/draft', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const section = await loadSection(firmId, req.params.sectionId)
    if (section.status === APPROVED) throw new ConflictError('This section is approved — reopen it before generating a new draft.')
    if (section.generationStatus === 'PROCESSING' || section.generationStatus === 'QUEUED') throw new ConflictError('A draft is already being generated for this section.')

    await prisma.proposalSection.update({ where: { id: section.id }, data: { generationStatus: 'PROCESSING', generationError: null } })
    try {
      // Approved-only company context; missing data becomes placeholders, never fabricated.
      const firm = await prisma.consultingFirm.findUnique({ where: { id: firmId }, select: { name: true } })
      const capabilities = typeof req.body?.companyCapabilities === 'string' ? req.body.companyCapabilities : null
      const pastPerformance = typeof req.body?.approvedPastPerformance === 'string' ? req.body.approvedPastPerformance : null
      const { content, source } = await generateSectionDraft({
        sectionTitle: section.title,
        requirementText: section.outline ?? (typeof req.body?.requirementText === 'string' ? req.body.requirementText : null),
        evaluationCriteria: typeof req.body?.evaluationCriteria === 'string' ? req.body.evaluationCriteria : null,
        companyCapabilities: capabilities,
        approvedPastPerformance: pastPerformance,
        userNotes: section.notes ?? null,
      }, firmId)
      void firm
      const nextVersion = ((await prisma.proposalSectionVersion.aggregate({ where: { proposalSectionId: section.id }, _max: { version: true } }))._max.version ?? 0) + 1
      await prisma.$transaction([
        prisma.proposalSectionVersion.create({ data: { consultingFirmId: firmId, proposalSectionId: section.id, version: nextVersion, content, source: 'AI', isAiGenerated: true, createdByUserId: req.user?.userId ?? null } }),
        prisma.proposalSection.update({ where: { id: section.id }, data: { draft: content, isAiGenerated: true, generationStatus: 'COMPLETED', status: section.status === 'OUTLINE' ? 'DRAFTING' : section.status, wordCount: content.trim().split(/\s+/).length } }),
      ])
      await audit(req, firmId, 'LLM_INFERENCE', 'ProposalSection', section.id, `AI section draft generated (${source}), v${nextVersion}`)
      res.status(201).json({ success: true, data: { version: nextVersion, generationStatus: 'COMPLETED', source } })
    } catch (genErr) {
      await prisma.proposalSection.update({ where: { id: section.id }, data: { generationStatus: 'FAILED', generationError: (genErr as Error).message.slice(0, 500) } })
      throw genErr
    }
  } catch (err) { next(err) }
})

// Reset a stuck/failed generation so the writer can retry (or cancel a PROCESSING one).
router.post('/sections/:sectionId/draft/cancel', requirePermission('PROPOSAL_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const section = await loadSection(firmId, req.params.sectionId)
    const updated = await prisma.proposalSection.update({ where: { id: section.id }, data: { generationStatus: 'CANCELLED' } })
    await audit(req, firmId, 'UPDATE', 'ProposalSection', section.id, 'Draft generation cancelled')
    res.json({ success: true, data: { generationStatus: updated.generationStatus } })
  } catch (err) { next(err) }
})

// =============================================================
// ATTACHMENT (reuses shared /uploads storage)
// =============================================================
router.post('/sections/:sectionId/attachment', requirePermission('PROPOSAL_WRITE'), upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const section = await loadSection(firmId, req.params.sectionId)
    if (!req.file) throw new ValidationError('No file uploaded')
    const updated = await prisma.proposalSection.update({ where: { id: section.id }, data: { attachmentKey: path.basename(req.file.path), attachmentName: req.file.originalname } })
    await audit(req, firmId, 'UPDATE', 'ProposalSection', section.id, `Attachment added: ${req.file.originalname}`)
    res.status(201).json({ success: true, data: { section: { id: updated.id, attachmentName: updated.attachmentName } } })
  } catch (err) { next(err) }
})
router.get('/sections/:sectionId/attachment', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const section = await loadSection(firmId, req.params.sectionId)
    if (!section.attachmentKey) throw new NotFoundError('Attachment')
    const filePath = path.join(process.cwd(), 'uploads', section.attachmentKey)
    if (!fs.existsSync(filePath)) throw new NotFoundError('File not found on disk')
    res.download(filePath, section.attachmentName ?? section.attachmentKey)
  } catch (err) { next(err) }
})

// =============================================================
// RESPONSIBILITY MATRIX (same ProposalSection rows, filtered + overdue)
// =============================================================
router.get('/:proposalId/responsibility', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firmId = getTenantId(req)
    const proposal = await loadProposal(firmId, req.params.proposalId)
    const q = req.query
    const now = new Date()
    const where: Prisma.ProposalSectionWhereInput = { proposalId: proposal.id, consultingFirmId: firmId }
    if (q.writerUserId) where.ownerUserId = String(q.writerUserId)
    if (q.reviewerUserId) where.reviewerUserId = String(q.reviewerUserId)
    if (q.status && (SECTION_STATUSES as readonly string[]).includes(String(q.status))) where.status = String(q.status)
    if (q.dueBefore) { const d = new Date(String(q.dueBefore)); if (!Number.isNaN(d.getTime())) where.dueDate = { lte: d } }
    let sections = (await prisma.proposalSection.findMany({ where, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })).map((s) => decorateSection(s, now))
    if (q.overdue === 'true') sections = sections.filter((s) => s.isOverdue)
    res.json({ success: true, data: { sections, total: sections.length, overdue: sections.filter((s) => s.isOverdue).length } })
  } catch (err) { next(err) }
})

export default router
