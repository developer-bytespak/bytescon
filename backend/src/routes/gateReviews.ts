// =============================================================
// Gate Reviews (§5.2) — internal go/no-go checkpoints linked to a BidPursuit
// (and optionally its Scorecard). Reads are firm-wide; management actions
// (create/assign/submit/waive) are ADMIN; review outcomes (approve/reject/
// request-changes) are restricted to the ASSIGNED reviewer. Every significant
// transition is audited and notifies the reviewer in-app (deduped). Mounted at
// /api/gate-reviews. A gate review is NOT an external government approval.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma, GateReviewStatus } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError, ForbiddenError, ConflictError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { notifyUser } from '../services/notificationService'
import { prisma } from '../config/database'
import { isValidGateTransition, allowedGateTargets, isGateOverdue } from '../services/gateReviewWorkflow'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const REVIEWER_SELECT = { id: true, firstName: true, lastName: true, email: true } as const

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityId: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType: 'GateReview', entityId, rationale, before, after })

function decorate<T extends { status: GateReviewStatus; dueDate: Date | null }>(gr: T, now: Date) {
  return { ...gr, isOverdue: isGateOverdue(gr.status, gr.dueDate, now) }
}

async function loadReview(consultingFirmId: string, id: string) {
  const gr = await prisma.gateReview.findFirst({ where: { id, consultingFirmId } })
  if (!gr) throw new NotFoundError('Gate review not found')
  return gr
}

async function assertPursuit(consultingFirmId: string, bidPursuitId: string) {
  const p = await prisma.bidPursuit.findFirst({ where: { id: bidPursuitId, consultingFirmId }, select: { id: true, opportunityId: true, opportunity: { select: { title: true } } } })
  if (!p) throw new ValidationError('bidPursuitId does not belong to your firm')
  return p
}

async function assertFirmUser(consultingFirmId: string, userId: string) {
  const u = await prisma.user.findFirst({ where: { id: userId, consultingFirmId }, select: { id: true } })
  if (!u) throw new ValidationError('reviewerUserId does not belong to your firm')
}

// =============================================================
// LIST (read, firm-wide)
// =============================================================
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const q = req.query
    const now = new Date()
    const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || '25'), 10) || 25))
    const where: Prisma.GateReviewWhereInput = { consultingFirmId }
    if (q.status) {
      if (!['NOT_STARTED', 'IN_PROGRESS', 'APPROVED', 'REJECTED', 'CHANGES_REQUIRED', 'WAIVED'].includes(String(q.status))) {
        throw new ValidationError('Invalid status filter')
      }
      where.status = String(q.status) as GateReviewStatus
    }
    if (q.reviewerUserId) where.reviewerUserId = q.reviewerUserId === 'me' ? req.user?.userId : String(q.reviewerUserId)
    if (q.bidPursuitId) where.bidPursuitId = String(q.bidPursuitId)
    if (q.overdue === 'true') { where.dueDate = { lt: now }; where.status = { notIn: ['APPROVED', 'REJECTED', 'WAIVED'] } }
    if (q.includeArchived !== 'true') where.isArchived = false

    const [items, total] = await Promise.all([
      prisma.gateReview.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (page - 1) * limit, take: limit }),
      prisma.gateReview.count({ where }),
    ])
    res.json({ success: true, data: { items: items.map((g) => decorate(g, now)), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } })
  } catch (err) { next(err) }
})

router.get('/pursuit/:pursuitId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const now = new Date()
    const includeArchived = String(req.query.includeArchived) === 'true'
    const items = await prisma.gateReview.findMany({ where: { consultingFirmId, bidPursuitId: req.params.pursuitId, ...(includeArchived ? {} : { isArchived: false }) }, orderBy: { createdAt: 'desc' } })
    res.json({ success: true, data: items.map((g) => decorate(g, now)) })
  } catch (err) { next(err) }
})

// =============================================================
// CREATE (ADMIN)
// =============================================================
const CreateSchema = z.object({
  bidPursuitId: z.string().min(1),
  name: z.string().trim().min(1).max(160),
  stage: z.string().trim().max(64).optional(),
  scorecardId: z.string().min(1).nullable().optional(),
  reviewerUserId: z.string().min(1).nullable().optional(),
  dueDate: z.string().datetime().transform((s) => new Date(s)).nullable().optional(),
  comments: z.string().trim().max(4000).nullable().optional(),
})

router.post('/', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = CreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid gate-review payload')
    const p = await assertPursuit(consultingFirmId, parsed.data.bidPursuitId)
    if (parsed.data.reviewerUserId) await assertFirmUser(consultingFirmId, parsed.data.reviewerUserId)

    const now = new Date()
    const gr = await prisma.gateReview.create({
      data: {
        consultingFirmId, bidPursuitId: p.id, opportunityId: p.opportunityId, scorecardId: parsed.data.scorecardId ?? null,
        name: parsed.data.name, stage: parsed.data.stage ?? 'GATE', reviewerUserId: parsed.data.reviewerUserId ?? null,
        dueDate: parsed.data.dueDate ?? null, comments: parsed.data.comments ?? null, status: 'NOT_STARTED',
      },
    })
    if (gr.reviewerUserId && gr.reviewerUserId !== req.user?.userId) {
      await notifyUser({ consultingFirmId, userId: gr.reviewerUserId, type: 'GATE_REVIEW_ASSIGNED', title: `Gate review assigned: ${gr.name}`, body: p.opportunity?.title, linkPath: `/pipeline/${p.id}`, entityType: 'GateReview', entityId: gr.id, dedupeKey: `gate-assigned:${gr.id}:${gr.reviewerUserId}` })
    }
    await audit(req, consultingFirmId, 'CREATE', gr.id, `Gate review created: ${gr.name}`, undefined, { bidPursuitId: p.id, reviewerUserId: gr.reviewerUserId })
    res.status(201).json({ success: true, data: decorate(gr, now) })
  } catch (err) { next(err) }
})

// =============================================================
// ASSIGN reviewer / due date (ADMIN)
// =============================================================
const AssignSchema = z.object({
  reviewerUserId: z.string().min(1).nullable().optional(),
  dueDate: z.string().datetime().transform((s) => new Date(s)).nullable().optional(),
}).refine((v) => 'reviewerUserId' in v || 'dueDate' in v, { message: 'Provide reviewerUserId or dueDate' })

router.patch('/:id/assign', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = AssignSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid assign payload')
    const gr = await loadReview(consultingFirmId, req.params.id)
    // Draft-state edits only — once submitted, a gate review is immutable.
    if (gr.status !== 'NOT_STARTED') throw new ConflictError('Only draft (Not started) gate reviews can be edited')
    if (parsed.data.reviewerUserId) await assertFirmUser(consultingFirmId, parsed.data.reviewerUserId)

    const now = new Date()
    const data: Prisma.GateReviewUpdateInput = {}
    if ('reviewerUserId' in parsed.data) data.reviewerUserId = parsed.data.reviewerUserId ?? null
    if ('dueDate' in parsed.data) data.dueDate = parsed.data.dueDate ?? null
    const updated = await prisma.gateReview.update({ where: { id: gr.id }, data })

    if (updated.reviewerUserId && updated.reviewerUserId !== gr.reviewerUserId && updated.reviewerUserId !== req.user?.userId) {
      const p = await prisma.bidPursuit.findUnique({ where: { id: gr.bidPursuitId }, select: { opportunity: { select: { title: true } } } })
      await notifyUser({ consultingFirmId, userId: updated.reviewerUserId, type: 'GATE_REVIEW_ASSIGNED', title: `Gate review assigned: ${updated.name}`, body: p?.opportunity?.title, linkPath: `/pipeline/${gr.bidPursuitId}`, entityType: 'GateReview', entityId: gr.id, dedupeKey: `gate-assigned:${gr.id}:${updated.reviewerUserId}` })
    }
    await audit(req, consultingFirmId, 'UPDATE', gr.id, 'Gate review reassigned', { reviewerUserId: gr.reviewerUserId }, { reviewerUserId: updated.reviewerUserId })
    res.json({ success: true, data: decorate(updated, now) })
  } catch (err) { next(err) }
})

// =============================================================
// TRANSITIONS
// =============================================================
async function transition(
  req: AuthenticatedRequest,
  id: string,
  to: GateReviewStatus,
  opts: { requireReviewer?: boolean; adminOnly?: boolean; action: AuditAction; reasonRequired?: boolean; setSubmitted?: boolean; setCompleted?: boolean },
  res: Response,
) {
  const consultingFirmId = getTenantId(req)
  const gr = await loadReview(consultingFirmId, id)

  // Assigned-reviewer gate for review outcomes.
  if (opts.requireReviewer && gr.reviewerUserId !== req.user?.userId) {
    throw new ForbiddenError('Only the assigned reviewer can perform this review action')
  }
  if (!isValidGateTransition(gr.status, to)) {
    return res.status(422).json({ success: false, code: 'INVALID_TRANSITION', error: `Cannot move a gate review from ${gr.status} to ${to}`, data: { from: gr.status, allowedTargets: allowedGateTargets(gr.status) } })
  }

  const body = (req.body ?? {}) as { comments?: string; outcome?: string; reason?: string }
  const reason = (body.reason ?? body.comments ?? '').trim()
  if (opts.reasonRequired && reason.length < 10) {
    throw new ValidationError('A reason of at least 10 characters is required for this action')
  }

  const now = new Date()
  const data: Prisma.GateReviewUpdateInput = { status: to }
  if (typeof body.comments === 'string') data.comments = body.comments
  if (typeof body.outcome === 'string') data.outcome = body.outcome
  if (opts.reasonRequired && to === 'WAIVED') data.outcome = reason
  if (opts.setSubmitted) data.submittedAt = now
  if (opts.setCompleted) data.completedAt = now

  const updated = await prisma.gateReview.update({ where: { id: gr.id }, data })

  // Notify the reviewer on submit (deduped per submitted timestamp so a resubmit
  // after CHANGES_REQUIRED notifies again, but a retried submit does not).
  if (opts.setSubmitted && updated.reviewerUserId && updated.reviewerUserId !== req.user?.userId) {
    const p = await prisma.bidPursuit.findUnique({ where: { id: gr.bidPursuitId }, select: { opportunity: { select: { title: true } } } })
    await notifyUser({ consultingFirmId, userId: updated.reviewerUserId, type: 'GATE_REVIEW_SUBMITTED', title: `Gate review awaiting your decision: ${updated.name}`, body: p?.opportunity?.title, linkPath: `/pipeline/${gr.bidPursuitId}`, entityType: 'GateReview', entityId: gr.id, dedupeKey: `gate-submitted:${gr.id}:${now.getTime()}` })
  }
  await audit(req, consultingFirmId, opts.action, gr.id, `Gate review ${gr.status} → ${to}${reason ? `: ${reason}` : ''}`, { status: gr.status }, { status: to })
  res.json({ success: true, data: decorate(updated, now) })
}

// Submit for review (ADMIN): NOT_STARTED / CHANGES_REQUIRED → IN_PROGRESS.
router.post('/:id/submit', requireRole('ADMIN'), async (req, res, next) => {
  try { await transition(req, req.params.id, 'IN_PROGRESS', { adminOnly: true, action: 'UPDATE', setSubmitted: true }, res) } catch (err) { next(err) }
})

// Approve / Reject / Request changes: ASSIGNED REVIEWER only.
router.post('/:id/approve', async (req, res, next) => {
  try { await transition(req, req.params.id, 'APPROVED', { requireReviewer: true, action: 'APPROVAL', setCompleted: true, reasonRequired: true }, res) } catch (err) { next(err) }
})
router.post('/:id/reject', async (req, res, next) => {
  try { await transition(req, req.params.id, 'REJECTED', { requireReviewer: true, action: 'REJECTION', setCompleted: true, reasonRequired: true }, res) } catch (err) { next(err) }
})
router.post('/:id/request-changes', async (req, res, next) => {
  try { await transition(req, req.params.id, 'CHANGES_REQUIRED', { requireReviewer: true, action: 'UPDATE', reasonRequired: true }, res) } catch (err) { next(err) }
})

// Waive (ADMIN) — requires a reason.
router.post('/:id/waive', requireRole('ADMIN'), async (req, res, next) => {
  try { await transition(req, req.params.id, 'WAIVED', { adminOnly: true, action: 'UPDATE', reasonRequired: true, setCompleted: true }, res) } catch (err) { next(err) }
})

// =============================================================
// ARCHIVE / RESTORE (ADMIN) — archive is draft-state only.
// =============================================================
router.post('/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const gr = await loadReview(consultingFirmId, req.params.id)
    if (gr.status !== 'NOT_STARTED') throw new ConflictError('Only draft (Not started) gate reviews can be archived')
    const now = new Date()
    const updated = await prisma.gateReview.update({ where: { id: gr.id }, data: { isArchived: true } })
    await audit(req, consultingFirmId, 'ARCHIVED', gr.id, `Gate review archived: ${gr.name}`)
    res.json({ success: true, data: decorate(updated, now) })
  } catch (err) { next(err) }
})

router.post('/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const gr = await loadReview(consultingFirmId, req.params.id)
    const now = new Date()
    const updated = await prisma.gateReview.update({ where: { id: gr.id }, data: { isArchived: false } })
    await audit(req, consultingFirmId, 'RESTORED', gr.id, `Gate review restored: ${gr.name}`)
    res.json({ success: true, data: decorate(updated, now) })
  } catch (err) { next(err) }
})

export default router
