// =============================================================
// Bid Qualification (§5.1 Stage 3 + §5.2 Bid/No-Bid Scorecard)
// -------------------------------------------------------------
// Human-judgment configurable weighted scorecard anchored to the existing
// BidPursuit (no second pursuit/pipeline). The weighted total + system
// recommendation are computed on the backend (services/scorecardScoring.ts) —
// the single source of truth. Reads are firm-wide; all writes are ADMIN
// (CONSULTANT is globally read-only). Decisions sync the pipeline stage
// transactionally, retain append-only history, and are audited. Mounted at
// /api/qualification. Mirrors routes/contractManagement.ts conventions.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma, QualificationStatus, ScorecardRecommendation } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ConflictError, ValidationError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { notifyUser } from '../services/notificationService'
import { prisma } from '../config/database'
import { computeScorecard, validateWeights, isValidScore, DEFAULT_CRITERIA, RECOMMENDATION_VERSION } from '../services/scorecardScoring'
// §7.4 — the canonical human decision now lives in one shared service so the
// Qualification Agent's accept/reject endpoints record a decision identically.
import {
  recordQualificationDecision, NON_QUALIFIABLE_STAGES, isOverrideDecision,
  FINAL_DECISIONS, type FinalDecision,
} from '../services/qualificationDecision'
import { isValidStageTransition } from '../services/pipelineStages'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityType: string, entityId: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId, rationale, before, after })

// The decision vocabulary, stage guard and override rule now live in the
// shared service so the \u00a77.4 accept endpoint reuses them exactly.

async function loadPursuit(consultingFirmId: string, pursuitId: string) {
  const pursuit = await prisma.bidPursuit.findFirst({
    where: { id: pursuitId, consultingFirmId },
    include: { opportunity: { select: { id: true, title: true, agency: true, solicitationNumber: true, responseDeadline: true, isDemo: true } } },
  })
  if (!pursuit) throw new NotFoundError('Pursuit not found')
  return pursuit
}

// Seed a firm's criterion config with the defaults the first time it is read.
async function ensureCriterionConfig(consultingFirmId: string) {
  const existing = await prisma.scorecardCriterionConfig.findMany({ where: { consultingFirmId }, orderBy: { displayOrder: 'asc' } })
  if (existing.length > 0) return existing
  await prisma.scorecardCriterionConfig.createMany({
    data: DEFAULT_CRITERIA.map((c) => ({ consultingFirmId, key: c.key, name: c.name, description: c.description, weight: c.weight, required: c.required, displayOrder: c.displayOrder })),
    skipDuplicates: true,
  })
  return prisma.scorecardCriterionConfig.findMany({ where: { consultingFirmId }, orderBy: { displayOrder: 'asc' } })
}

// Recompute + persist the scorecard's stored total & recommendation from its
// criterion snapshot. Returns the recomputed scoring result.
async function recomputeAndStore(tx: Prisma.TransactionClient, scorecardId: string) {
  const criteria = await tx.scorecardCriterion.findMany({ where: { scorecardId } })
  const result = computeScorecard(criteria.map((c) => ({ key: c.key, weight: c.weight, score: c.score, required: c.required })))
  await tx.scorecard.update({ where: { id: scorecardId }, data: { totalScore: result.totalScore, recommendation: result.recommendation, recommendationVersion: RECOMMENDATION_VERSION } })
  return result
}

function decorateScorecard(sc: { totalScore: number; recommendation: ScorecardRecommendation | null; status: QualificationStatus; criteria: { key: string; score: number | null; required: boolean; weight: number }[] }) {
  const result = computeScorecard(sc.criteria.map((c) => ({ key: c.key, weight: c.weight, score: c.score, required: c.required })))
  return { computed: result }
}

// =============================================================
// CRITERION CONFIG (per-firm template)
// =============================================================
router.get('/criteria/config', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const config = await ensureCriterionConfig(consultingFirmId)
    const totalWeight = config.filter((c) => c.isActive).reduce((s, c) => s + c.weight, 0)
    res.json({ success: true, data: { criteria: config, totalWeight, weightRule: 'Active weights must total exactly 100.' } })
  } catch (err) { next(err) }
})

const CriterionInput = z.object({
  key: z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/, 'key must be lowercase letters, numbers and underscores'),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  weight: z.number().int().min(0).max(100),
  required: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional(),
})
const ConfigSchema = z.object({ criteria: z.array(CriterionInput).min(1).max(40) })

// Replace the full criterion set (ADMIN). Validates the active weights total
// exactly 100 and rejects duplicate keys/names. Historical scorecards keep
// their own snapshots, so reconfiguring never rewrites past results.
router.put('/criteria/config', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ConfigSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid criteria payload')
    const criteria = parsed.data.criteria

    const keys = new Set<string>()
    const names = new Set<string>()
    for (const c of criteria) {
      const nameLc = c.name.toLowerCase()
      if (keys.has(c.key)) throw new ValidationError(`Duplicate criterion key: ${c.key}`)
      if (names.has(nameLc)) throw new ValidationError(`Duplicate criterion name: ${c.name}`)
      keys.add(c.key)
      names.add(nameLc)
    }

    const weightError = validateWeights(criteria.map((c) => ({ weight: c.weight, isActive: c.isActive })))
    if (weightError) throw new ValidationError(weightError)

    const saved = await prisma.$transaction(async (tx) => {
      await tx.scorecardCriterionConfig.deleteMany({ where: { consultingFirmId } })
      await tx.scorecardCriterionConfig.createMany({
        data: criteria.map((c, i) => ({
          consultingFirmId, key: c.key, name: c.name, description: c.description ?? null,
          weight: c.weight, required: c.required ?? true, displayOrder: c.displayOrder ?? i + 1, isActive: c.isActive ?? true,
        })),
      })
      return tx.scorecardCriterionConfig.findMany({ where: { consultingFirmId }, orderBy: { displayOrder: 'asc' } })
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ScorecardCriterionConfig', consultingFirmId, 'Scorecard criteria reconfigured', undefined, { count: saved.length })
    res.json({ success: true, data: { criteria: saved } })
  } catch (err) { next(err) }
})

// =============================================================
// SCORECARD (per pursuit)
// =============================================================
async function fullScorecard(consultingFirmId: string, pursuitId: string) {
  const sc = await prisma.scorecard.findFirst({
    where: { consultingFirmId, bidPursuitId: pursuitId },
    include: {
      criteria: { orderBy: { displayOrder: 'asc' } },
      history: { orderBy: { createdAt: 'desc' }, take: 20 },
    },
  })
  return sc
}

// GET scorecard for a pursuit — returns exists:false when not yet started.
router.get('/:pursuitId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)
    const sc = await fullScorecard(consultingFirmId, pursuit.id)
    if (!sc) return res.json({ success: true, data: { exists: false, pursuit: { id: pursuit.id, pipelineStage: pursuit.pipelineStage, closedAt: pursuit.closedAt, opportunity: pursuit.opportunity } } })
    res.json({ success: true, data: { exists: true, scorecard: sc, ...decorateScorecard(sc), pursuit: { id: pursuit.id, pipelineStage: pursuit.pipelineStage, closedAt: pursuit.closedAt, opportunity: pursuit.opportunity } } })
  } catch (err) { next(err) }
})

// Start qualification: create the scorecard (idempotent), snapshot the active
// criteria, and advance the pipeline IDENTIFIED → QUALIFICATION.
router.post('/:pursuitId/start', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)

    const existing = await prisma.scorecard.findUnique({ where: { bidPursuitId: pursuit.id } })
    if (existing) {
      const sc = await fullScorecard(consultingFirmId, pursuit.id)
      return res.json({ success: true, data: { scorecard: sc, ...decorateScorecard(sc!) } })
    }

    const config = (await ensureCriterionConfig(consultingFirmId)).filter((c) => c.isActive)
    if (config.length === 0) throw new ValidationError('Configure at least one active scorecard criterion first')

    const created = await prisma.$transaction(async (tx) => {
      const sc = await tx.scorecard.create({
        data: {
          consultingFirmId, bidPursuitId: pursuit.id, opportunityId: pursuit.opportunityId,
          status: 'NOT_REVIEWED', recommendationVersion: RECOMMENDATION_VERSION,
          criteria: {
            create: config.map((c) => ({ key: c.key, name: c.name, description: c.description, weight: c.weight, required: c.required, displayOrder: c.displayOrder })),
          },
        },
        include: { criteria: { orderBy: { displayOrder: 'asc' } } },
      })
      await tx.scorecardDecision.create({
        data: { consultingFirmId, scorecardId: sc.id, bidPursuitId: pursuit.id, opportunityId: pursuit.opportunityId, status: 'NOT_REVIEWED', recommendation: 'REVIEW_REQUIRED', totalScore: 0, changedByUserId: req.user?.userId, changeReason: 'Qualification started' },
      })
      // Advance pipeline IDENTIFIED → QUALIFICATION when legal.
      if (isValidStageTransition(pursuit.pipelineStage, 'QUALIFICATION')) {
        await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { pipelineStage: 'QUALIFICATION', lastActivityAt: new Date() } })
      }
      return sc
    })
    await audit(req, consultingFirmId, 'CREATE', 'Scorecard', created.id, 'Qualification started', undefined, { bidPursuitId: pursuit.id, opportunityId: pursuit.opportunityId })
    const sc = await fullScorecard(consultingFirmId, pursuit.id)
    res.status(201).json({ success: true, data: { scorecard: sc, ...decorateScorecard(sc!) } })
  } catch (err) { next(err) }
})

const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100).nullable().optional(),
  evidence: z.string().trim().max(4000).nullable().optional(),
}).refine((v) => 'score' in v || 'evidence' in v, { message: 'Provide a score or evidence' })

// Score a single criterion (ADMIN). Recomputes + stores the weighted total.
router.patch('/:pursuitId/criteria/:key', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ScoreSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid score payload')
    if ('score' in parsed.data && parsed.data.score !== null && parsed.data.score !== undefined && !isValidScore(parsed.data.score)) {
      throw new ValidationError('score must be an integer between 0 and 100')
    }

    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)
    const sc = await prisma.scorecard.findFirst({ where: { consultingFirmId, bidPursuitId: pursuit.id } })
    if (!sc) throw new NotFoundError('Scorecard not started')
    const criterion = await prisma.scorecardCriterion.findFirst({ where: { scorecardId: sc.id, key: req.params.key } })
    if (!criterion) throw new NotFoundError('Criterion not found')

    const data: Prisma.ScorecardCriterionUpdateInput = {}
    if ('score' in parsed.data) data.score = parsed.data.score ?? null
    if ('evidence' in parsed.data) data.evidence = parsed.data.evidence ?? null

    const result = await prisma.$transaction(async (tx) => {
      await tx.scorecardCriterion.update({ where: { id: criterion.id }, data })
      const r = await recomputeAndStore(tx, sc.id)
      await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { lastActivityAt: new Date() } })
      return r
    })
    await audit(req, consultingFirmId, 'UPDATE', 'ScorecardCriterion', criterion.id, `Scored ${criterion.key}`, { score: criterion.score }, { score: data.score ?? criterion.score })
    const full = await fullScorecard(consultingFirmId, pursuit.id)
    res.json({ success: true, data: { scorecard: full, computed: result } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PATCH /api/qualification/:pursuitId/criteria — bulk "Save scorecard".
// Persists every provided criterion score in ONE transaction. Server always
// recomputes the total (client total is never trusted). Each changed criterion
// writes a "scored X → Y" audit row. Blocked once the pursuit is closed.
// -------------------------------------------------------------
const BulkScoreSchema = z.object({
  scores: z.array(z.object({
    key: z.string().min(1),
    score: z.number().int().nullable().optional(),
    evidence: z.string().max(4000).nullable().optional(),
  })).min(1),
})

router.patch('/:pursuitId/criteria', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = BulkScoreSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid scores payload')
    for (const s of parsed.data.scores) {
      if (s.score !== null && s.score !== undefined && !isValidScore(s.score)) {
        throw new ValidationError(`Score for "${s.key}" must be an integer between 0 and 100`)
      }
    }

    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)
    if (pursuit.closedAt) throw new ConflictError('This pursuit is closed — reopen it to edit the scorecard')
    const sc = await prisma.scorecard.findFirst({ where: { consultingFirmId, bidPursuitId: pursuit.id }, include: { criteria: true } })
    if (!sc) throw new NotFoundError('Scorecard not started')

    const byKey = new Map(sc.criteria.map((c) => [c.key, c]))
    const changes: { criterion: typeof sc.criteria[number]; from: number | null; to: number | null }[] = []
    for (const s of parsed.data.scores) {
      const c = byKey.get(s.key)
      if (!c) throw new ValidationError(`Unknown criterion: ${s.key}`)
      const to = s.score ?? null
      if (to !== c.score || ('evidence' in s && (s.evidence ?? null) !== c.evidence)) {
        changes.push({ criterion: c, from: c.score, to })
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      for (const s of parsed.data.scores) {
        const c = byKey.get(s.key)!
        const data: Prisma.ScorecardCriterionUpdateInput = {}
        if ('score' in s) data.score = s.score ?? null
        if ('evidence' in s) data.evidence = s.evidence ?? null
        if (Object.keys(data).length) await tx.scorecardCriterion.update({ where: { id: c.id }, data })
      }
      const r = await recomputeAndStore(tx, sc.id)
      await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { lastActivityAt: new Date() } })
      return r
    })

    for (const ch of changes) {
      await audit(req, consultingFirmId, 'UPDATE', 'ScorecardCriterion', ch.criterion.id, `scored ${ch.from ?? '—'} → ${ch.to ?? '—'} on criterion ${ch.criterion.name}`, { score: ch.from }, { score: ch.to })
    }
    const full = await fullScorecard(consultingFirmId, pursuit.id)
    res.json({ success: true, data: { scorecard: full, computed: result } })
  } catch (err) { next(err) }
})

// POST /api/qualification/:pursuitId/reset — clear every score (ADMIN). Server
// recomputes the total to 0 and writes a SCORECARD_RESET audit row.
router.post('/:pursuitId/reset', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)
    if (pursuit.closedAt) throw new ConflictError('This pursuit is closed — reopen it to edit the scorecard')
    const sc = await prisma.scorecard.findFirst({ where: { consultingFirmId, bidPursuitId: pursuit.id } })
    if (!sc) throw new NotFoundError('Scorecard not started')

    const result = await prisma.$transaction(async (tx) => {
      await tx.scorecardCriterion.updateMany({ where: { scorecardId: sc.id }, data: { score: null, evidence: null } })
      const r = await recomputeAndStore(tx, sc.id)
      await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { lastActivityAt: new Date() } })
      return r
    })
    await audit(req, consultingFirmId, 'SCORECARD_RESET', 'Scorecard', sc.id, 'Scorecard reset — all scores cleared')
    const full = await fullScorecard(consultingFirmId, pursuit.id)
    res.json({ success: true, data: { scorecard: full, computed: result } })
  } catch (err) { next(err) }
})

const SubmitSchema = z.object({ reviewerUserId: z.string().min(1).nullable().optional(), comments: z.string().trim().max(4000).optional() })

// Submit for review (ADMIN) → IN_REVIEW. Requires all required criteria scored.
// Optionally assigns a reviewer and notifies them in-app.
router.post('/:pursuitId/submit-review', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = SubmitSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('Invalid submit payload')
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)
    const sc = await prisma.scorecard.findFirst({ where: { consultingFirmId, bidPursuitId: pursuit.id }, include: { criteria: true } })
    if (!sc) throw new NotFoundError('Scorecard not started')

    const result = computeScorecard(sc.criteria.map((c) => ({ key: c.key, weight: c.weight, score: c.score, required: c.required })))
    if (!result.complete) throw new ValidationError(`Cannot submit — required criteria not scored: ${result.missingRequiredKeys.join(', ')}`)

    let reviewerUserId = sc.reviewerUserId
    if (parsed.data.reviewerUserId !== undefined) {
      reviewerUserId = parsed.data.reviewerUserId
      if (reviewerUserId) {
        const owner = await prisma.user.findFirst({ where: { id: reviewerUserId, consultingFirmId }, select: { id: true } })
        if (!owner) throw new ValidationError('reviewerUserId does not belong to your firm')
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.scorecard.update({ where: { id: sc.id }, data: { status: 'IN_REVIEW', submittedForReviewAt: new Date(), reviewerUserId, reviewerComments: parsed.data.comments ?? sc.reviewerComments } })
      await tx.scorecardDecision.create({ data: { consultingFirmId, scorecardId: sc.id, bidPursuitId: pursuit.id, opportunityId: pursuit.opportunityId, status: 'IN_REVIEW', recommendation: result.recommendation, totalScore: result.totalScore, changedByUserId: req.user?.userId, changeReason: 'Submitted for review' } })
      await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { lastActivityAt: new Date() } })
      if (reviewerUserId && reviewerUserId !== req.user?.userId) {
        await notifyUser({ consultingFirmId, userId: reviewerUserId, type: 'QUALIFICATION_DECISION', title: 'Qualification submitted for your review', body: pursuit.opportunity.title, linkPath: `/pipeline/${pursuit.id}`, entityType: 'Scorecard', entityId: sc.id, dedupeKey: `qual-review:${sc.id}:${reviewerUserId}` }, tx)
      }
    })
    await audit(req, consultingFirmId, 'UPDATE', 'Scorecard', sc.id, 'Submitted for review')
    const full = await fullScorecard(consultingFirmId, pursuit.id)
    res.json({ success: true, data: { scorecard: full, ...decorateScorecard(full!) } })
  } catch (err) { next(err) }
})

const DecisionSchema = z.object({
  decision: z.enum(FINAL_DECISIONS),
  overrideReason: z.string().trim().max(4000).optional(),
  reviewerComments: z.string().trim().max(4000).optional(),
})

// Final decision (ADMIN). Requires required criteria complete. Overriding the
// system recommendation requires a non-empty reason. Transactionally records
// history + syncs the pipeline stage.
router.post('/:pursuitId/decision', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = DecisionSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid decision payload')
    if (!req.user?.userId) throw new ValidationError('A qualification decision must be recorded by a person.')

    // §7.4 extracted this into ONE canonical implementation so the Qualification
    // Agent's accept/reject endpoints record a decision the identical way.
    // Behaviour here is unchanged.
    const outcome = await recordQualificationDecision({
      consultingFirmId,
      pursuitId: req.params.pursuitId,
      decision: parsed.data.decision,
      actorUserId: req.user.userId,
      overrideReason: parsed.data.overrideReason ?? null,
      reviewerComments: parsed.data.reviewerComments ?? null,
    })

    await audit(
      req, consultingFirmId,
      outcome.isOverride ? 'DECISION_OVERRIDE' : 'APPROVAL',
      'Scorecard', outcome.scorecardId,
      outcome.isOverride
        ? `Override \u2192 ${outcome.decision}: ${(parsed.data.overrideReason ?? '').trim()}`
        : `Decision \u2192 ${outcome.decision}`,
      { recommendation: outcome.recommendation },
      { decision: outcome.decision, isOverride: outcome.isOverride },
    )
    const full = await fullScorecard(consultingFirmId, req.params.pursuitId)
    res.json({ success: true, data: { scorecard: full, ...decorateScorecard(full!) } })
  } catch (err) { next(err) }
})

const ReassessSchema = z.object({ reason: z.string().trim().max(2000).optional() })

// Reopen a decided scorecard for reassessment (ADMIN) — retains all history.
router.post('/:pursuitId/reassess', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ReassessSchema.safeParse(req.body ?? {})
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)
    const sc = await prisma.scorecard.findFirst({ where: { consultingFirmId, bidPursuitId: pursuit.id } })
    if (!sc) throw new NotFoundError('Scorecard not started')
    if (sc.status === 'NOT_REVIEWED' || sc.status === 'IN_REVIEW') {
      throw new ConflictError('This scorecard has not been decided yet — nothing to reassess')
    }

    await prisma.$transaction(async (tx) => {
      await tx.scorecard.update({ where: { id: sc.id }, data: { status: 'IN_REVIEW', finalDecision: null, isOverride: false, overrideReason: null, overriddenByUserId: null, decidedByUserId: null, decidedAt: null } })
      await tx.scorecardDecision.create({ data: { consultingFirmId, scorecardId: sc.id, bidPursuitId: pursuit.id, opportunityId: pursuit.opportunityId, status: 'IN_REVIEW', recommendation: sc.recommendation, totalScore: sc.totalScore, changedByUserId: req.user?.userId, changeReason: parsed.success && parsed.data.reason ? `Reassess: ${parsed.data.reason}` : 'Reopened for reassessment' } })
      await tx.bidPursuit.update({ where: { id: pursuit.id }, data: { lastActivityAt: new Date() } })
    })
    await audit(req, consultingFirmId, 'UPDATE', 'Scorecard', sc.id, 'Reopened for reassessment')
    const full = await fullScorecard(consultingFirmId, pursuit.id)
    res.json({ success: true, data: { scorecard: full, ...decorateScorecard(full!) } })
  } catch (err) { next(err) }
})

// Paginated decision history for a scorecard (read — firm-wide).
router.get('/:pursuitId/history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)
    const sc = await prisma.scorecard.findFirst({ where: { consultingFirmId, bidPursuitId: pursuit.id }, select: { id: true } })
    if (!sc) return res.json({ success: true, data: { items: [], total: 0, page: 1, limit: 25 } })
    const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '25'), 10) || 25))
    const [items, total] = await Promise.all([
      prisma.scorecardDecision.findMany({ where: { consultingFirmId, scorecardId: sc.id }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.scorecardDecision.count({ where: { consultingFirmId, scorecardId: sc.id } }),
    ])
    res.json({ success: true, data: { items, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) } })
  } catch (err) { next(err) }
})

export default router
