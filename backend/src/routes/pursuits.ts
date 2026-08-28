// =============================================================
// Bid Pursuit Routes — the declare-your-bid feedback loop.
//
// A REVIEWING pursuit is created automatically the first time a firm
// opens a live solicitation (opportunities.ts GET /:id). The dashboard
// widget lists pending pursuits and the firm declares:
//   submitted → creates + links a SubmissionRecord (its WON/LOST outcome
//               flow then labels the probability engine's backtest data)
//   passed    → recorded as a deliberate no-bid
//   snooze    → "still thinking", resurfaces after the snooze window
// Undeclared pursuits are auto-PASSED by the expiry worker 7 days after
// the response deadline. Award notices matching a SUBMITTED pursuit's
// solicitation number surface as outcome prompts (GET /award-prompts).
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma, PipelineStage, PursuitPriority } from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError, ForbiddenError } from '../utils/errors'
import { recordComplianceEvent } from '../services/complianceStateMachine'
import { logAudit } from '../services/auditService'
import {
  PIPELINE_STAGES,
  PURSUIT_PRIORITIES,
  isValidStageTransition,
  allowedStageTargets,
  isPursuitOverdue,
} from '../services/pipelineStages'
import { emitPursuitStageChanged } from '../services/agents/opportunity/opportunityEvents'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const SNOOZE_DEFAULT_DAYS = 3

// Active capture stages a declare (submit/pass) may advance from without
// rewinding an already-decided pursuit.
const PRE_SUBMISSION_STAGES: PipelineStage[] = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL']

// Opportunity fields surfaced on every pipeline row — enough to render the
// board/table without a second fetch, and to gate government links honestly
// (demo rows carry isDemo; sourceUrl/samNoticeId are null when absent).
const PIPELINE_OPP_SELECT = {
  id: true,
  title: true,
  agency: true,
  responseDeadline: true,
  solicitationNumber: true,
  estimatedValue: true,
  setAsideType: true,
  status: true,
  isDemo: true,
  sourceUrl: true,
  samNoticeId: true,
  probabilityScore: true,
} as const

const PIPELINE_OWNER_SELECT = { id: true, firstName: true, lastName: true, email: true } as const

const PIPELINE_INCLUDE = {
  opportunity: { select: PIPELINE_OPP_SELECT },
  owner: { select: PIPELINE_OWNER_SELECT },
  submissionRecord: { select: { id: true, outcome: true, submittedAt: true } },
} as const

// Attach derived overdue flag + the latest bid/no-bid decision (read-only) so
// the pipeline and the qualification decision share one source of truth.
type PipelineRow = Prisma.BidPursuitGetPayload<{ include: typeof PIPELINE_INCLUDE }>
function decorate(
  p: PipelineRow,
  now: Date,
  decisionByOpp: Map<string, { decision: string; recommendation: string | null; winProbability: number | null }>,
) {
  return {
    ...p,
    isOverdue: isPursuitOverdue(p.pipelineStage, p.nextActionDueAt, now),
    bidDecision: decisionByOpp.get(p.opportunityId) ?? null,
  }
}

const auditPursuit = (
  req: AuthenticatedRequest,
  consultingFirmId: string,
  action: 'UPDATE',
  pursuitId: string,
  opportunityId: string,
  before: unknown,
  after: unknown,
  rationale?: string,
) =>
  logAudit({
    consultingFirmId,
    actorUserId: req.user?.userId,
    actorRole: req.user?.role,
    action,
    entityType: 'BidPursuit',
    entityId: pursuitId,
    rationale,
    before,
    after: { ...(after as object), opportunityId },
  })

// -------------------------------------------------------------
// GET /api/pursuits — pending + recent pursuits for the widget
// Query: status (default REVIEWING), includeSnoozed=1
// -------------------------------------------------------------
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const status = typeof req.query.status === 'string' ? req.query.status : 'REVIEWING'
    if (!['REVIEWING', 'SUBMITTED', 'PASSED'].includes(status)) {
      throw new ValidationError('status must be REVIEWING, SUBMITTED, or PASSED')
    }
    const includeSnoozed = req.query.includeSnoozed === '1'
    const now = new Date()

    const pursuits = await prisma.bidPursuit.findMany({
      where: {
        consultingFirmId,
        status: status as 'REVIEWING' | 'SUBMITTED' | 'PASSED',
        ...(status === 'REVIEWING' && !includeSnoozed
          ? { OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: now } }] }
          : {}),
      },
      include: {
        opportunity: {
          select: {
            id: true, title: true, agency: true, responseDeadline: true,
            probabilityScore: true, setAsideType: true, status: true,
            solicitationNumber: true,
          },
        },
        submissionRecord: { select: { id: true, outcome: true, submittedAt: true } },
      },
      orderBy: { opportunity: { responseDeadline: 'asc' } },
      take: 50,
    })
    res.json({ success: true, data: pursuits })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/pursuits/award-prompts — SUBMITTED pursuits whose solicitation
// now has an ingested Award Notice but no recorded outcome. The widget
// prompts "You bid on this — won or lost?" Detection is read-time via the
// shared solicitationNumber, so no ingest-side hook is needed.
// -------------------------------------------------------------
router.get('/award-prompts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const submitted = await prisma.bidPursuit.findMany({
      where: {
        consultingFirmId,
        status: 'SUBMITTED',
        OR: [
          { submissionRecordId: null },
          { submissionRecord: { outcome: null } },
        ],
      },
      include: {
        opportunity: {
          select: { id: true, title: true, agency: true, solicitationNumber: true },
        },
        submissionRecord: { select: { id: true, outcome: true } },
      },
      take: 100,
    })

    const withSolNumbers = submitted.filter((p) => p.opportunity.solicitationNumber)
    if (withSolNumbers.length === 0) return res.json({ success: true, data: [] })

    const awardNotices = await prisma.opportunity.findMany({
      where: {
        consultingFirmId,
        solicitationNumber: { in: withSolNumbers.map((p) => p.opportunity.solicitationNumber as string) },
        noticeType: { contains: 'award', mode: 'insensitive' },
      },
      select: {
        id: true, title: true, solicitationNumber: true, postedDate: true,
        estimatedValue: true, historicalWinner: true, sourceUrl: true,
      },
    })
    const awardsBySol = new Map(awardNotices.map((a) => [a.solicitationNumber as string, a]))

    const prompts = withSolNumbers
      .filter((p) => awardsBySol.has(p.opportunity.solicitationNumber as string))
      .map((p) => ({
        pursuit: p,
        awardNotice: awardsBySol.get(p.opportunity.solicitationNumber as string),
      }))

    res.json({ success: true, data: prompts })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/pursuits/pipeline — the Section 5.2 pipeline board/table.
// Server-side filter + sort + pagination over the firm's BidPursuit rows,
// each decorated with its opportunity, owner, overdue flag, and latest
// bid/no-bid decision. Read is firm-wide (any authenticated role).
// Query: stage, priority, ownerUserId ('unassigned'), bidDecision (GO|NO_GO|
//   PENDING), overdue=true, q (title/agency/solicitation), includeArchived=true,
//   sortBy, order, page, limit.
// -------------------------------------------------------------
const SORT_FIELDS: Record<string, (order: Prisma.SortOrder) => Prisma.BidPursuitOrderByWithRelationInput> = {
  lastActivityAt: (order) => ({ lastActivityAt: order }),
  nextActionDueAt: (order) => ({ nextActionDueAt: order }),
  priority: (order) => ({ priority: order }),
  updatedAt: (order) => ({ updatedAt: order }),
  deadline: (order) => ({ opportunity: { responseDeadline: order } }),
  probability: (order) => ({ opportunity: { probabilityScore: order } }),
}

router.get('/pipeline', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const q = req.query
    const now = new Date()
    const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || '25'), 10) || 25))

    const where: Prisma.BidPursuitWhereInput = { consultingFirmId }

    if (q.stage) {
      if (!(PIPELINE_STAGES as string[]).includes(String(q.stage))) {
        throw new ValidationError(`stage must be one of: ${PIPELINE_STAGES.join(', ')}`)
      }
      where.pipelineStage = String(q.stage) as PipelineStage
    } else if (q.includeArchived !== 'true') {
      where.pipelineStage = { not: 'ARCHIVED' }
    }

    // Closed pursuits are hidden unless "Include closed" is requested.
    if (q.includeClosed !== 'true') {
      where.closedAt = null
    }

    if (q.priority) {
      if (!(PURSUIT_PRIORITIES as string[]).includes(String(q.priority))) {
        throw new ValidationError(`priority must be one of: ${PURSUIT_PRIORITIES.join(', ')}`)
      }
      where.priority = String(q.priority) as PursuitPriority
    }

    if (q.ownerUserId) {
      where.ownerUserId = q.ownerUserId === 'unassigned' ? null : String(q.ownerUserId)
    }

    if (q.overdue === 'true') {
      where.nextActionDueAt = { lt: now }
      where.pipelineStage = where.pipelineStage ?? { notIn: ['AWARDED', 'LOST', 'NO_BID', 'ARCHIVED'] }
    }

    if (typeof q.q === 'string' && q.q.trim()) {
      const term = q.q.trim()
      where.opportunity = {
        OR: [
          { title: { contains: term, mode: 'insensitive' } },
          { agency: { contains: term, mode: 'insensitive' } },
          { solicitationNumber: { contains: term, mode: 'insensitive' } },
        ],
      }
    }

    if (q.bidDecision) {
      const dec = String(q.bidDecision)
      if (!['GO', 'NO_GO', 'PENDING'].includes(dec)) {
        throw new ValidationError('bidDecision must be GO, NO_GO, or PENDING')
      }
      where.opportunity = {
        ...(where.opportunity as Prisma.OpportunityWhereInput | undefined),
        bidDecisions: { some: { decision: dec as 'GO' | 'NO_GO' | 'PENDING' } },
      }
    }

    const sortKey = typeof q.sortBy === 'string' && SORT_FIELDS[q.sortBy] ? q.sortBy : 'lastActivityAt'
    const order: Prisma.SortOrder = q.order === 'asc' ? 'asc' : 'desc'
    // Secondary id sort guarantees a stable, deterministic total order.
    const orderBy: Prisma.BidPursuitOrderByWithRelationInput[] = [SORT_FIELDS[sortKey](order), { id: 'asc' }]

    const [items, total, grouped] = await Promise.all([
      prisma.bidPursuit.findMany({
        where,
        include: PIPELINE_INCLUDE,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.bidPursuit.count({ where }),
      prisma.bidPursuit.groupBy({
        by: ['pipelineStage'],
        where: { consultingFirmId },
        _count: { _all: true },
      }),
    ])

    // One decision lookup per page of opportunities (latest per opportunity).
    const oppIds = items.map((p) => p.opportunityId)
    const decisions = oppIds.length
      ? await prisma.bidDecision.findMany({
          where: { consultingFirmId, opportunityId: { in: oppIds } },
          select: { opportunityId: true, decision: true, recommendation: true, winProbability: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
        })
      : []
    const decisionByOpp = new Map<string, { decision: string; recommendation: string | null; winProbability: number | null }>()
    for (const d of decisions) {
      if (!decisionByOpp.has(d.opportunityId)) {
        decisionByOpp.set(d.opportunityId, { decision: d.decision, recommendation: d.recommendation, winProbability: d.winProbability })
      }
    }

    const stageCounts: Record<string, number> = {}
    for (const s of PIPELINE_STAGES) stageCounts[s] = 0
    for (const g of grouped) stageCounts[g.pipelineStage] = g._count._all

    res.json({
      success: true,
      data: {
        items: items.map((p) => decorate(p, now, decisionByOpp)),
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        stageCounts,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PATCH /api/pursuits/:id/stage — advance the capture lifecycle.
// Any firm staff (ADMIN or CONSULTANT). Transition is validated against the
// pipeline state machine; impossible moves are rejected (not silently applied).
// Audited with before/after. Does NOT touch BidPursuit.status.
// -------------------------------------------------------------
const StageSchema = z.object({
  stage: z.enum(PIPELINE_STAGES as [string, ...string[]]),
  reason: z.string().trim().max(2000).optional(),
})

router.patch('/:id/stage', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = StageSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid stage payload')
    const target = parsed.data.stage as PipelineStage

    const pursuit = await prisma.bidPursuit.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!pursuit) throw new NotFoundError('Pursuit not found')

    if (!isValidStageTransition(pursuit.pipelineStage, target)) {
      return res.status(422).json({
        success: false,
        code: 'INVALID_TRANSITION',
        error: `Cannot move a pursuit from ${pursuit.pipelineStage} to ${target}`,
        data: { from: pursuit.pipelineStage, allowedTargets: allowedStageTargets(pursuit.pipelineStage) },
      })
    }

    const now = new Date()
    // §7.2 — the stage write and PURSUIT_STAGE_CHANGED share one transaction,
    // so a rolled-back transition emits zero events. This is the canonical
    // stage-transition workflow; the event is never inferred from UI state.
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.bidPursuit.update({
        where: { id: pursuit.id },
        data: { pipelineStage: target, lastActivityAt: now },
        include: PIPELINE_INCLUDE,
      })
      await emitPursuitStageChanged(tx, {
        consultingFirmId,
        pursuitId: pursuit.id,
        opportunityId: pursuit.opportunityId,
        fromStage: pursuit.pipelineStage,
        toStage: target,
      })
      return row
    })
    await auditPursuit(
      req, consultingFirmId, 'UPDATE', pursuit.id, pursuit.opportunityId,
      { pipelineStage: pursuit.pipelineStage }, { pipelineStage: target },
      parsed.data.reason ?? `Stage ${pursuit.pipelineStage} → ${target}`,
    )
    res.json({ success: true, data: decorate(updated, now, new Map()) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PATCH /api/pursuits/:id/assign — assign / clear the responsible owner.
// Management action → ADMIN only. Owner must belong to the same firm.
// -------------------------------------------------------------
const AssignSchema = z.object({ ownerUserId: z.string().min(1).nullable() })

router.patch('/:id/assign', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = AssignSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('ownerUserId must be a user id or null')
    const { ownerUserId } = parsed.data

    const pursuit = await prisma.bidPursuit.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!pursuit) throw new NotFoundError('Pursuit not found')

    if (ownerUserId) {
      const owner = await prisma.user.findFirst({ where: { id: ownerUserId, consultingFirmId }, select: { id: true } })
      if (!owner) throw new ValidationError('ownerUserId does not belong to your firm')
    }

    const now = new Date()
    const updated = await prisma.bidPursuit.update({
      where: { id: pursuit.id },
      data: { ownerUserId, lastActivityAt: now },
      include: PIPELINE_INCLUDE,
    })
    await auditPursuit(
      req, consultingFirmId, 'UPDATE', pursuit.id, pursuit.opportunityId,
      { ownerUserId: pursuit.ownerUserId }, { ownerUserId },
      ownerUserId ? 'Owner assigned' : 'Owner cleared',
    )
    res.json({ success: true, data: decorate(updated, now, new Map()) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PATCH /api/pursuits/:id/next-action — next action, due date, notes, priority.
// Any firm staff (ADMIN or CONSULTANT). At least one field required.
// -------------------------------------------------------------
const NextActionSchema = z
  .object({
    nextAction: z.string().trim().max(2000).nullable().optional(),
    nextActionDueAt: z.string().datetime().transform((s) => new Date(s)).nullable().optional(),
    notes: z.string().trim().max(10000).nullable().optional(),
    priority: z.enum(PURSUIT_PRIORITIES as [string, ...string[]]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })

router.patch('/:id/next-action', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = NextActionSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload')

    const pursuit = await prisma.bidPursuit.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!pursuit) throw new NotFoundError('Pursuit not found')

    // CONSULTANT may edit ONLY the notes field, and ONLY on pursuits they own.
    if (req.user?.role === 'CONSULTANT') {
      const touchesNonNotes =
        'nextAction' in parsed.data || 'nextActionDueAt' in parsed.data || parsed.data.priority !== undefined
      if (touchesNonNotes) throw new ForbiddenError('Consultants may only edit notes on a pursuit')
      if (pursuit.ownerUserId !== req.user.userId) throw new ForbiddenError('You can only edit notes on pursuits assigned to you')
    }

    const now = new Date()
    const data: Prisma.BidPursuitUpdateInput = { lastActivityAt: now }
    if ('nextAction' in parsed.data) data.nextAction = parsed.data.nextAction ?? null
    if ('nextActionDueAt' in parsed.data) data.nextActionDueAt = parsed.data.nextActionDueAt ?? null
    if ('notes' in parsed.data) data.notes = parsed.data.notes ?? null
    if (parsed.data.priority) data.priority = parsed.data.priority as PursuitPriority

    const updated = await prisma.bidPursuit.update({ where: { id: pursuit.id }, data, include: PIPELINE_INCLUDE })
    await auditPursuit(
      req, consultingFirmId, 'UPDATE', pursuit.id, pursuit.opportunityId,
      { nextAction: pursuit.nextAction, nextActionDueAt: pursuit.nextActionDueAt, notes: pursuit.notes, priority: pursuit.priority },
      { nextAction: updated.nextAction, nextActionDueAt: updated.nextActionDueAt, notes: updated.notes, priority: updated.priority },
      'Next action updated',
    )
    res.json({ success: true, data: decorate(updated, now, new Map()) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PATCH /api/pursuits/:id/close — explicitly close a pursuit with a reason.
// Reasons: WON | LOST | NO_BID | DEFERRED | DUPLICATE (+ optional free-text).
// WON/LOST/NO_BID also advance the pipeline stage; all set closedAt so the
// pursuit drops out of the default board until "Include closed" is set.
// -------------------------------------------------------------
const CLOSE_REASONS = ['WON', 'LOST', 'NO_BID', 'DEFERRED', 'DUPLICATE'] as const
const CloseSchema = z.object({
  reason: z.enum(CLOSE_REASONS),
  note: z.string().trim().max(2000).optional(),
})
const CLOSE_REASON_STAGE: Partial<Record<string, PipelineStage>> = {
  WON: 'AWARDED',
  LOST: 'LOST',
  NO_BID: 'NO_BID',
}

router.patch('/:id/close', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = CloseSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid close payload')
    const pursuit = await prisma.bidPursuit.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!pursuit) throw new NotFoundError('Pursuit not found')
    if (pursuit.closedAt) throw new ValidationError('Pursuit is already closed')

    const now = new Date()
    const stage = CLOSE_REASON_STAGE[parsed.data.reason]
    const updated = await prisma.bidPursuit.update({
      where: { id: pursuit.id },
      data: {
        closedAt: now,
        closeReason: parsed.data.reason,
        closeNote: parsed.data.note ?? null,
        lastActivityAt: now,
        ...(stage ? { pipelineStage: stage } : {}),
      },
      include: PIPELINE_INCLUDE,
    })
    await auditPursuit(
      req, consultingFirmId, 'UPDATE', pursuit.id, pursuit.opportunityId,
      { closedAt: null, pipelineStage: pursuit.pipelineStage },
      { closedAt: now, closeReason: parsed.data.reason, pipelineStage: updated.pipelineStage },
      `Closed: ${parsed.data.reason}${parsed.data.note ? ` — ${parsed.data.note}` : ''}`,
    )
    res.json({ success: true, data: decorate(updated, now, new Map()) })
  } catch (err) { next(err) }
})

// PATCH /api/pursuits/:id/reopen — clear the close so it returns to the board.
router.patch('/:id/reopen', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const pursuit = await prisma.bidPursuit.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!pursuit) throw new NotFoundError('Pursuit not found')
    if (!pursuit.closedAt) throw new ValidationError('Pursuit is not closed')

    const now = new Date()
    const updated = await prisma.bidPursuit.update({
      where: { id: pursuit.id },
      data: { closedAt: null, closeReason: null, closeNote: null, lastActivityAt: now },
      include: PIPELINE_INCLUDE,
    })
    await auditPursuit(
      req, consultingFirmId, 'UPDATE', pursuit.id, pursuit.opportunityId,
      { closedAt: pursuit.closedAt, closeReason: pursuit.closeReason }, { closedAt: null },
      'Reopened pursuit',
    )
    res.json({ success: true, data: decorate(updated, now, new Map()) })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PATCH /api/pursuits/:id — declare a decision on a pursuit
// Body: { action: 'submitted' | 'passed' | 'snooze',
//         clientCompanyId?, submittedAt?, snoozeDays? }
// -------------------------------------------------------------
router.patch('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { action, clientCompanyId, submittedAt, snoozeDays } = req.body ?? {}
    if (!['submitted', 'passed', 'snooze'].includes(action)) {
      throw new ValidationError("action must be 'submitted', 'passed', or 'snooze'")
    }

    const pursuit = await prisma.bidPursuit.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: { opportunity: { select: { id: true, probabilityScore: true, responseDeadline: true } } },
    })
    if (!pursuit) throw new NotFoundError('Pursuit not found')

    const now = new Date()

    if (action === 'snooze') {
      const days = Number.isFinite(Number(snoozeDays)) && Number(snoozeDays) > 0
        ? Math.min(30, Number(snoozeDays))
        : SNOOZE_DEFAULT_DAYS
      const updated = await prisma.bidPursuit.update({
        where: { id: pursuit.id },
        data: { snoozedUntil: new Date(now.getTime() + days * 24 * 60 * 60 * 1000) },
      })
      return res.json({ success: true, data: updated })
    }

    if (action === 'passed') {
      const movesStage = PRE_SUBMISSION_STAGES.includes(pursuit.pipelineStage)
      const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.bidPursuit.update({
          where: { id: pursuit.id },
          data: {
            status: 'PASSED',
            source: 'USER',
            decidedAt: now,
            lastActivityAt: now,
            // Keep the capture lifecycle consistent: a deliberate pass is a
            // no-bid, but never rewind an already-closed pursuit.
            ...(movesStage ? { pipelineStage: 'NO_BID' as const } : {}),
            probabilityAtDecision: pursuit.probabilityAtDecision ?? pursuit.opportunity.probabilityScore,
          },
        })
        // A user-declared pass is the clearest negative preference signal the
        // learning loop has, so it is announced even when the capture stage was
        // already closed and did not move.
        await emitPursuitStageChanged(tx, {
          consultingFirmId,
          pursuitId: pursuit.id,
          opportunityId: pursuit.opportunityId,
          fromStage: pursuit.pipelineStage,
          toStage: movesStage ? 'NO_BID' : pursuit.pipelineStage,
          declaredStatus: 'PASSED',
        })
        return row
      })
      return res.json({ success: true, data: updated })
    }

    // action === 'submitted' — attach (or create) the SubmissionRecord so the
    // existing WON/LOST outcome flow owns the rest of the lifecycle.
    let resolvedClientId: string | null = typeof clientCompanyId === 'string' ? clientCompanyId : null
    if (resolvedClientId) {
      const owned = await prisma.clientCompany.findFirst({
        where: { id: resolvedClientId, consultingFirmId },
        select: { id: true },
      })
      if (!owned) throw new ValidationError('clientCompanyId does not belong to your firm')
    } else {
      const activeClients = await prisma.clientCompany.findMany({
        where: { consultingFirmId, isActive: true },
        select: { id: true },
        take: 2,
      })
      if (activeClients.length === 1) {
        resolvedClientId = activeClients[0].id
      } else {
        return res.status(422).json({
          success: false,
          code: 'CLIENT_REQUIRED',
          error: 'Pass clientCompanyId — your firm has more than one (or no) active client company.',
        })
      }
    }

    const declaredAt = submittedAt ? new Date(submittedAt) : now
    const wasOnTime = declaredAt <= pursuit.opportunity.responseDeadline

    const submission = pursuit.submissionRecordId
      ? await prisma.submissionRecord.findUnique({ where: { id: pursuit.submissionRecordId } })
      : await prisma.$transaction(async (tx) => {
          const record = await tx.submissionRecord.create({
            data: {
              consultingFirmId,
              clientCompanyId: resolvedClientId,
              opportunityId: pursuit.opportunityId,
              submittedById: req.user?.userId ?? null,
              submittedAt: declaredAt,
              wasOnTime,
              status: 'APPROVED',
              notes: 'Declared via bid pursuit tracker',
            },
          })
          // Section 4 #4: audit the submission creation atomically.
          await recordComplianceEvent(tx, {
            entityType: 'SUBMISSION',
            entityId: record.id,
            toStatus: record.status ?? 'APPROVED',
            consultingFirmId,
            triggeredBy: req.user?.userId,
            reason: 'Submission declared via bid pursuit tracker',
            dedupeOn: 'entity-creation',
          })
          return record
        })

    const movesStage = PRE_SUBMISSION_STAGES.includes(pursuit.pipelineStage)
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.bidPursuit.update({
        where: { id: pursuit.id },
        data: {
          status: 'SUBMITTED',
          source: 'USER',
          decidedAt: now,
          lastActivityAt: now,
          // Advance the capture lifecycle to SUBMITTED, but never rewind a
          // pursuit already marked AWARDED/LOST/NO_BID/ARCHIVED.
          ...(movesStage ? { pipelineStage: 'SUBMITTED' as const } : {}),
          submissionRecordId: submission?.id ?? null,
          probabilityAtDecision: pursuit.probabilityAtDecision ?? pursuit.opportunity.probabilityScore,
        },
        include: { submissionRecord: true },
      })
      await emitPursuitStageChanged(tx, {
        consultingFirmId,
        pursuitId: pursuit.id,
        opportunityId: pursuit.opportunityId,
        fromStage: pursuit.pipelineStage,
        toStage: movesStage ? 'SUBMITTED' : pursuit.pipelineStage,
        declaredStatus: 'SUBMITTED',
      })
      return row
    })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

export default router
