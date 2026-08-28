// =============================================================
// §7.2 — Opportunity Agent API.
//
// Deliberately small. Runs, schedules, artifacts and escalations are already
// served by the generic `/api/agents` surface and are NOT recreated here. These
// endpoints exist for the two things that surface cannot give the discovery UI:
//
//   GET  /latest                 one backend-authoritative view joining the
//                                latest run, brief, source health and learning
//   GET  /feedback               the tenant's pursuit-learning history
//   POST /feedback/:id/apply     the HUMAN approval point (ADMIN only)
//   POST /feedback/:id/revert    the HUMAN undo point (ADMIN only)
//
// Applying is the ONLY path by which a learned weighting reaches production
// matching. No agent run, at any autonomy level, can reach these handlers.
//
// Mounted at /api/agents/opportunity. Tenant-scoped throughout; a signal is
// always loaded by (id, consultingFirmId) so another firm's learning can never
// be read, applied or reverted.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { PursuitFeedbackStatus } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import { logger } from '../utils/logger'
import { OPPORTUNITY_POLICY_DOC } from '../services/agents/opportunity/policy'
import {
  applyPursuitFeedback,
  resolveEffectiveWeights,
  revertPursuitFeedback,
} from '../services/agents/opportunity/pursuitFeedback'
import { refreshFirmMatches } from '../services/discovery/matchRefresh'
import { assessSourceHealth } from '../services/agents/opportunity/sourceHealth'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'OPPORTUNITY' as const

const SIGNAL_SELECT = {
  id: true,
  status: true,
  algorithmVersion: true,
  sampleSize: true,
  pursuedSampleSize: true,
  ignoredSampleSize: true,
  minimumSampleSize: true,
  confidenceState: true,
  dataSufficiency: true,
  baselineWeights: true,
  proposedWeights: true,
  evidence: true,
  summary: true,
  generatedByRunId: true,
  generatedAt: true,
  appliedByUserId: true,
  appliedAt: true,
  revertedByUserId: true,
  revertedAt: true,
  supersededBySignalId: true,
  supersededAt: true,
} as const

/**
 * Everything the /discovery agent panel needs, in one tenant-scoped read.
 *
 * The frontend renders this; it never recomputes a weighting, a match score or
 * a health state of its own.
 */
router.get('/latest', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const [schedule, lastRun, lastSuccessfulRun, brief, escalations, proposed, applied, effective, health] =
      await Promise.all([
        prisma.agentSchedule.findUnique({
          where: { consultingFirmId_agentKey: { consultingFirmId, agentKey: AGENT_KEY } },
          select: {
            isEnabled: true, scheduleType: true, cronExpression: true, intervalMinutes: true,
            timezone: true, nextRunAt: true, lastRunAt: true, lastSuccessfulRunAt: true,
            lastFailureAt: true, lastFailureMessage: true, consecutiveFailures: true, autonomyLevel: true,
          },
        }),
        prisma.agentRun.findFirst({
          where: { consultingFirmId, agentKey: AGENT_KEY },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, status: true, triggerType: true, triggerEntityType: true, triggerEntityId: true,
            progressPercent: true, progressStage: true, createdAt: true, startedAt: true, finishedAt: true,
            outputSummary: true, confidenceState: true, dataSufficiency: true, warnings: true, limitations: true,
            errorCode: true, errorMessage: true, tokenInput: true, tokenOutput: true, estimatedCostUsd: true,
          },
        }),
        prisma.agentRun.findFirst({
          where: { consultingFirmId, agentKey: AGENT_KEY, status: 'COMPLETED' },
          orderBy: { finishedAt: 'desc' },
          select: { id: true, finishedAt: true, outputSummary: true },
        }),
        prisma.agentArtifact.findFirst({
          where: {
            consultingFirmId,
            agentKey: AGENT_KEY,
            artifactType: 'OPPORTUNITY_BRIEF',
            supersededByArtifactId: null,
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true, runId: true, title: true, summary: true, structuredData: true,
            confidenceState: true, isHumanVerified: true, createdAt: true,
          },
        }),
        prisma.agentEscalation.findMany({
          where: { consultingFirmId, agentKey: AGENT_KEY, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
          orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
          select: {
            id: true, severity: true, status: true, title: true, reason: true, recommendedAction: true,
            entityType: true, entityId: true, createdAt: true,
          },
          take: 50,
        }),
        prisma.pursuitFeedbackSignal.findFirst({
          where: { consultingFirmId, status: PursuitFeedbackStatus.PROPOSED },
          orderBy: { generatedAt: 'desc' },
          select: SIGNAL_SELECT,
        }),
        prisma.pursuitFeedbackSignal.findFirst({
          where: { consultingFirmId, status: PursuitFeedbackStatus.APPLIED },
          orderBy: { appliedAt: 'desc' },
          select: SIGNAL_SELECT,
        }),
        resolveEffectiveWeights(consultingFirmId),
        assessSourceHealth(consultingFirmId),
      ])

    // Shown only when there is nothing proposed or applied, so the UI can say
    // INSUFFICIENT DATA honestly rather than showing an empty panel.
    const latestInsufficient = proposed || applied
      ? null
      : await prisma.pursuitFeedbackSignal.findFirst({
          where: { consultingFirmId, status: PursuitFeedbackStatus.INSUFFICIENT_DATA },
          orderBy: { generatedAt: 'desc' },
          select: SIGNAL_SELECT,
        })

    res.json({
      success: true,
      data: {
        agentKey: AGENT_KEY,
        schedule: schedule ?? null,
        lastRun,
        lastSuccessfulRun,
        // null means the agent has not produced a brief yet — the UI reports
        // that plainly rather than inventing an empty-but-healthy state.
        brief: brief
          ? {
              artifactId: brief.id,
              runId: brief.runId,
              generatedAt: brief.createdAt,
              confidenceState: brief.confidenceState,
              isHumanVerified: brief.isHumanVerified,
              summary: brief.summary,
              ...(brief.structuredData as object),
            }
          : null,
        sourceHealth: health.sources,
        sourceTotals: {
          total: health.sources.length,
          healthy: health.successful.length,
          failing: health.failing.length,
          stale: health.stale.length,
          notConfigured: health.notConfigured.length,
        },
        escalations,
        learning: {
          effectiveWeightProfile: effective.profile,
          effectiveWeights: effective.weights,
          appliedSignal: applied,
          proposedSignal: proposed,
          insufficientSignal: latestInsufficient,
        },
        policy: OPPORTUNITY_POLICY_DOC,
      },
    })
  } catch (err) { next(err) }
})

/** The tenant's learning history, newest first. Never another firm's. */
router.get('/feedback', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const signals = await prisma.pursuitFeedbackSignal.findMany({
      where: { consultingFirmId },
      orderBy: { generatedAt: 'desc' },
      select: SIGNAL_SELECT,
      take: 50,
    })
    res.json({ success: true, data: { signals, policy: OPPORTUNITY_POLICY_DOC } })
  } catch (err) { next(err) }
})

router.get('/feedback/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const signal = await prisma.pursuitFeedbackSignal.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: SIGNAL_SELECT,
    })
    // Scoped find + 404 rather than 403: another firm's signal is not merely
    // forbidden, its existence is not disclosed.
    if (!signal) throw new NotFoundError('Pursuit feedback signal')
    res.json({ success: true, data: signal })
  } catch (err) { next(err) }
})

/**
 * THE HUMAN APPROVAL POINT.
 *
 * ADMIN only. No agent run reaches this handler at any autonomy level — an
 * agent can propose a weighting and nothing more.
 */
router.post('/feedback/:id/apply', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('An authenticated user is required to apply a learned adjustment.')

    const result = await applyPursuitFeedback({ consultingFirmId, signalId: req.params.id, userId })

    await logAudit({
      consultingFirmId,
      actorUserId: userId,
      actorRole: req.user?.role,
      action: 'UPDATE',
      entityType: 'PursuitFeedbackSignal',
      entityId: result.id,
      rationale: 'Pursuit-preference weighting applied by an administrator',
      before: { weights: result.baselineWeights },
      after: { weights: result.appliedWeights },
    })

    // Controlled refresh so the new ranking is visible immediately. Failure here
    // must not undo the applied decision — the scheduled refresh will catch up.
    let refreshed = 0
    try {
      const refresh = await refreshFirmMatches(consultingFirmId)
      refreshed = refresh.refreshed
    } catch (err) {
      logger.error('Match refresh after applying pursuit feedback failed', {
        signalId: result.id, error: (err as Error).message,
      })
    }

    const signal = await prisma.pursuitFeedbackSignal.findFirst({
      where: { id: result.id, consultingFirmId },
      select: SIGNAL_SELECT,
    })
    res.json({ success: true, data: { signal, matchesRefreshed: refreshed } })
  } catch (err) { next(err) }
})

/**
 * THE HUMAN UNDO POINT.
 *
 * Restores the exact baseline preserved on the row. Nothing is recalculated.
 */
router.post('/feedback/:id/revert', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('An authenticated user is required to revert a learned adjustment.')

    const result = await revertPursuitFeedback({ consultingFirmId, signalId: req.params.id, userId })

    await logAudit({
      consultingFirmId,
      actorUserId: userId,
      actorRole: req.user?.role,
      action: 'UPDATE',
      entityType: 'PursuitFeedbackSignal',
      entityId: result.id,
      rationale: 'Pursuit-preference weighting reverted by an administrator',
      after: { weights: result.restoredWeights },
    })

    let refreshed = 0
    try {
      const refresh = await refreshFirmMatches(consultingFirmId)
      refreshed = refresh.refreshed
    } catch (err) {
      logger.error('Match refresh after reverting pursuit feedback failed', {
        signalId: result.id, error: (err as Error).message,
      })
    }

    const signal = await prisma.pursuitFeedbackSignal.findFirst({
      where: { id: result.id, consultingFirmId },
      select: SIGNAL_SELECT,
    })
    res.json({ success: true, data: { signal, restoredWeights: result.restoredWeights, matchesRefreshed: refreshed } })
  } catch (err) { next(err) }
})

export default router
