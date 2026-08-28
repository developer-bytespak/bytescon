// =============================================================
// §7.4 — Qualification Agent API.
//
// Deliberately small. Runs, schedules, artifacts and escalations are already
// served by the generic `/api/agents` surface and are NOT recreated here.
//
//   GET  /:pursuitId               the current recommendation + brief + run
//   GET  /:pursuitId/history       every version, newest first
//   POST /recommendation/:id/accept   ADMIN — accept, then record the decision
//   POST /recommendation/:id/reject   ADMIN — reject, then record their own
//
// THE DECISION BOUNDARY
// Accept and reject BOTH route the actual decision through
// `recordQualificationDecision` — the one canonical human path, shared with
// `POST /api/qualification/:pursuitId/decision`. The actor is always
// `req.user.userId`; there is no code path that records a decision with a
// system actor. Rejecting never rewrites the recommendation to pretend the
// agent agreed: the agent's result is preserved and the human's own decision is
// stored beside it.
//
// Mounted at /api/agents/qualification. Tenant-scoped throughout.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import { recordQualificationDecision, FINAL_DECISIONS } from '../services/qualificationDecision'
import { BORDERLINE_POLICY_DOC } from '../services/agents/qualification/borderlinePolicy'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'QUALIFICATION' as const

const RECOMMENDATION_SELECT = {
  id: true, pursuitId: true, opportunityId: true, agentRunId: true,
  version: true, inputHash: true, algorithmVersion: true,
  recommendation: true, strength: true,
  rawProbability: true, finalProbability: true, probabilityMode: true, calibrationnote: true,
  confidenceLower: true, confidenceUpper: true, confidenceState: true, dataSufficiency: true,
  scorecardScore: true, isBorderline: true, borderlineReasons: true,
  capabilityGapSeverity: true, capacityState: true,
  incumbentEvidence: true, competitorEvidence: true, pricingEvidence: true, complianceEvidence: true,
  narrative: true, evidence: true, dataLimitations: true, proposedPriority: true,
  status: true, supersedesId: true, supersededAt: true,
  acceptedByUserId: true, acceptedAt: true, rejectedByUserId: true, rejectedAt: true, humanDecision: true,
  createdAt: true, updatedAt: true,
} as const

/** Tenant-verified pursuit lookup. Never trusts an id alone. */
async function loadPursuit(consultingFirmId: string, pursuitId: string) {
  const pursuit = await prisma.bidPursuit.findFirst({
    where: { id: pursuitId, consultingFirmId },
    select: {
      id: true, opportunityId: true, pipelineStage: true, priority: true, ownerUserId: true,
      opportunity: { select: { id: true, title: true, agency: true, responseDeadline: true } },
    },
  })
  if (!pursuit) throw new NotFoundError('Pursuit')
  return pursuit
}

/** Everything the pursuit page needs, in one tenant-scoped read. */
router.get('/:pursuitId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)

    const [current, brief, schedule, lastRun, escalations, gateReview, scorecard] = await Promise.all([
      prisma.qualificationRecommendation.findFirst({
        where: { consultingFirmId, pursuitId: pursuit.id, status: { in: ['ACTIVE', 'ACCEPTED', 'REJECTED'] } },
        orderBy: { version: 'desc' },
        select: RECOMMENDATION_SELECT,
      }),
      prisma.agentArtifact.findFirst({
        where: {
          consultingFirmId, agentKey: AGENT_KEY, artifactType: 'QUALIFICATION_BRIEF',
          sourceEntityType: 'BidPursuit', sourceEntityId: pursuit.id, supersededByArtifactId: null,
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, runId: true, summary: true, structuredData: true, confidenceState: true, createdAt: true },
      }),
      prisma.agentSchedule.findUnique({
        where: { consultingFirmId_agentKey: { consultingFirmId, agentKey: AGENT_KEY } },
        select: {
          isEnabled: true, cronExpression: true, nextRunAt: true, lastRunAt: true,
          lastSuccessfulRunAt: true, lastFailureAt: true, lastFailureMessage: true, autonomyLevel: true,
        },
      }),
      prisma.agentRun.findFirst({
        where: { consultingFirmId, agentKey: AGENT_KEY },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, triggerType: true, progressPercent: true, progressStage: true,
          createdAt: true, finishedAt: true, outputSummary: true, confidenceState: true,
          dataSufficiency: true, warnings: true, limitations: true, errorMessage: true,
          tokenInput: true, tokenOutput: true, estimatedCostUsd: true,
        },
      }),
      prisma.agentEscalation.findMany({
        where: { consultingFirmId, agentKey: AGENT_KEY, entityId: pursuit.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true, severity: true, status: true, title: true, reason: true,
          recommendedAction: true, createdAt: true,
        },
        take: 25,
      }),
      prisma.gateReview.findFirst({
        where: {
          consultingFirmId, bidPursuitId: pursuit.id,
          status: { in: ['NOT_STARTED', 'IN_PROGRESS', 'CHANGES_REQUIRED'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true, name: true, status: true, reviewerUserId: true, dueDate: true, comments: true },
      }),
      prisma.scorecard.findFirst({
        where: { consultingFirmId, bidPursuitId: pursuit.id },
        select: { id: true, status: true, finalDecision: true, decidedByUserId: true, decidedAt: true, isOverride: true, overrideReason: true },
      }),
    ])

    res.json({
      success: true,
      data: {
        agentKey: AGENT_KEY,
        pursuit,
        schedule: schedule ?? null,
        lastRun,
        // null means the agent has not qualified this pursuit yet — reported
        // plainly rather than as an empty-but-confident state.
        recommendation: current,
        brief: brief
          ? { artifactId: brief.id, runId: brief.runId, generatedAt: brief.createdAt, summary: brief.summary, ...(brief.structuredData as object) }
          : null,
        gateReview,
        // The HUMAN decision, shown separately so the two are never conflated.
        humanDecision: scorecard,
        escalations,
        policy: BORDERLINE_POLICY_DOC,
      },
    })
  } catch (err) { next(err) }
})

/** Every version, so a superseded recommendation stays visible as evidence. */
router.get('/:pursuitId/history', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)
    const versions = await prisma.qualificationRecommendation.findMany({
      where: { consultingFirmId, pursuitId: pursuit.id },
      orderBy: { version: 'desc' },
      select: RECOMMENDATION_SELECT,
      take: 50,
    })
    res.json({ success: true, data: { versions } })
  } catch (err) { next(err) }
})

const AcceptSchema = z.object({
  /**
   * Which decision the acceptance records. Optional for a clear BID/NO_BID
   * recommendation, required when the recommendation is borderline or
   * insufficient — the agent has no opinion to accept in that case.
   */
  decision: z.enum(FINAL_DECISIONS).optional(),
  overrideReason: z.string().trim().max(2000).optional(),
  reviewerComments: z.string().trim().max(2000).optional(),
})

const RejectSchema = z.object({
  decision: z.enum(FINAL_DECISIONS),
  overrideReason: z.string().trim().max(2000).optional(),
  reviewerComments: z.string().trim().max(2000).optional(),
})

/** Map an agent recommendation onto the decision it endorses. */
function endorsedDecision(recommendation: string): 'BID' | 'NO_BID' | null {
  if (recommendation === 'RECOMMEND_BID') return 'BID'
  if (recommendation === 'RECOMMEND_NO_BID') return 'NO_BID'
  return null
}

async function loadRecommendation(consultingFirmId: string, id: string) {
  const row = await prisma.qualificationRecommendation.findFirst({
    where: { id, consultingFirmId },
    select: { ...RECOMMENDATION_SELECT, consultingFirmId: true },
  })
  // Scoped find + 404: another firm's recommendation is not merely forbidden,
  // its existence is not disclosed.
  if (!row) throw new NotFoundError('Qualification recommendation')
  return row
}

/**
 * ACCEPT — the human agrees with the agent, and their decision is recorded
 * through the canonical human workflow.
 */
router.post('/recommendation/:id/accept', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A qualification decision must be recorded by a person.')

    const parsed = AcceptSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload')

    const recommendation = await loadRecommendation(consultingFirmId, req.params.id)
    if (recommendation.status !== 'ACTIVE') {
      throw new ValidationError(`Only an ACTIVE recommendation can be accepted. This one is ${recommendation.status}.`)
    }

    const endorsed = endorsedDecision(recommendation.recommendation)
    const decision = parsed.data.decision ?? endorsed
    if (!decision) {
      throw new ValidationError(
        `This recommendation is ${recommendation.recommendation}, so there is no decision to accept. Choose the decision explicitly.`,
      )
    }

    // The canonical human path. Its own rules apply verbatim: stage guard,
    // required criteria, override reason, history row, pipeline transition.
    const outcome = await recordQualificationDecision({
      consultingFirmId,
      pursuitId: recommendation.pursuitId,
      decision,
      actorUserId: userId,
      overrideReason: parsed.data.overrideReason ?? null,
      reviewerComments: parsed.data.reviewerComments ?? null,
    })

    const updated = await prisma.qualificationRecommendation.update({
      where: { id: recommendation.id },
      data: { status: 'ACCEPTED', acceptedByUserId: userId, acceptedAt: new Date(), humanDecision: decision },
      select: RECOMMENDATION_SELECT,
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'APPROVAL', entityType: 'QualificationRecommendation', entityId: recommendation.id,
      rationale: `Agent recommended ${recommendation.recommendation}; accepted by an administrator and recorded as ${decision}.`,
      before: { agentRecommendation: recommendation.recommendation },
      after: { humanDecision: decision, isOverride: outcome.isOverride },
    })

    res.json({ success: true, data: { recommendation: updated, decision: outcome } })
  } catch (err) { next(err) }
})

/**
 * REJECT — the human disagrees. The agent's recommendation is PRESERVED exactly
 * as it was, and the human's own decision is recorded beside it, so the record
 * reads "agent recommended X, human decided Y".
 */
router.post('/recommendation/:id/reject', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A qualification decision must be recorded by a person.')

    const parsed = RejectSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'A decision is required when rejecting a recommendation')

    const recommendation = await loadRecommendation(consultingFirmId, req.params.id)
    if (recommendation.status !== 'ACTIVE') {
      throw new ValidationError(`Only an ACTIVE recommendation can be rejected. This one is ${recommendation.status}.`)
    }

    const outcome = await recordQualificationDecision({
      consultingFirmId,
      pursuitId: recommendation.pursuitId,
      decision: parsed.data.decision,
      actorUserId: userId,
      overrideReason: parsed.data.overrideReason ?? null,
      reviewerComments: parsed.data.reviewerComments ?? null,
    })

    // Only the human's response is recorded. Nothing about what the agent
    // recommended is altered.
    const updated = await prisma.qualificationRecommendation.update({
      where: { id: recommendation.id },
      data: { status: 'REJECTED', rejectedByUserId: userId, rejectedAt: new Date(), humanDecision: parsed.data.decision },
      select: RECOMMENDATION_SELECT,
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'DECISION_OVERRIDE', entityType: 'QualificationRecommendation', entityId: recommendation.id,
      rationale: `Agent recommended ${recommendation.recommendation}; a human decided ${parsed.data.decision} instead.`,
      before: { agentRecommendation: recommendation.recommendation },
      after: { humanDecision: parsed.data.decision, isOverride: outcome.isOverride },
    })

    res.json({ success: true, data: { recommendation: updated, decision: outcome } })
  } catch (err) { next(err) }
})

export default router
