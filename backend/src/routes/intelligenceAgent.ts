// =============================================================
// §7.9 — Intelligence Agent API.
//
// Deliberately small. Runs, schedules and escalations are already served by the
// generic `/api/agents` surface and are NOT recreated here.
//
//   GET  /portfolio                         latest PORTFOLIO_INTELLIGENCE
//   GET  /segments                          persisted win/loss segments
//   GET  /recommendations                   capture recommendations
//   POST /recommendations/:id/dismiss       a person declines one (ADMIN)
//   POST /recommendations/:id/acknowledge   a person notes they have seen it
//
// EVERY ENDPOINT IS READ-ONLY WITH RESPECT TO THE BUSINESS. The two writes
// change the status of the agent's OWN recommendation and nothing else — no
// pursuit priority, no scoring weight, no pipeline membership, no historical
// evidence. Dismissing is a statement about the advice, not about the data.
//
// Mounted at /api/agents/intelligence. Tenant-scoped throughout.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors'
import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import {
  MIN_WIN_LOSS_SAMPLE_SIZE,
  ANALYSIS_LOOKBACK_MONTHS,
  WIN_LOSS_ALGORITHM_VERSION,
  MIN_TREND_PERIODS,
  VALUE_BANDS,
  CONFIRMED_OUTCOMES,
  NON_CONTEST_OUTCOMES,
} from '../services/agents/intelligence/winLossAnalysis'
import { CAPTURE_ALGORITHM_VERSION, MAX_RECOMMENDATIONS } from '../services/agents/intelligence/captureFocus'
import { MIN_RECURRENCE, ROADMAP_ALGORITHM_VERSION } from '../services/agents/intelligence/capabilityRoadmap'
import { CONCENTRATION_HHI_THRESHOLD } from '../services/agents/intelligence/intelligenceAgentHandler'
import { MIN_BENCHMARK_COHORT_SIZE } from '../services/agents/pricing/awardBenchmark'
import { CONFIDENCE_METHOD } from '../services/scoring/confidenceInterval'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'INTELLIGENCE' as const

/** The policy the UI displays so a reader can check the numbers themselves. */
const INTELLIGENCE_POLICY = {
  algorithmVersion: WIN_LOSS_ALGORITHM_VERSION,
  captureAlgorithmVersion: CAPTURE_ALGORITHM_VERSION,
  roadmapAlgorithmVersion: ROADMAP_ALGORITHM_VERSION,
  minimumSampleSize: MIN_WIN_LOSS_SAMPLE_SIZE,
  minimumTrendPeriods: MIN_TREND_PERIODS,
  minimumGapRecurrence: MIN_RECURRENCE,
  minimumPublicCohortSize: MIN_BENCHMARK_COHORT_SIZE,
  concentrationThreshold: CONCENTRATION_HHI_THRESHOLD,
  analysisLookbackMonths: ANALYSIS_LOOKBACK_MONTHS,
  intervalMethod: CONFIDENCE_METHOD,
  maxRecommendations: MAX_RECOMMENDATIONS,
  valueBands: VALUE_BANDS.map((b) => ({ key: b.key, label: b.label })),
  confirmedOutcomes: CONFIRMED_OUTCOMES,
  nonContestOutcomes: NON_CONTEST_OUTCOMES,
  notes: [
    `A win rate is reported only once ${MIN_WIN_LOSS_SAMPLE_SIZE} confirmed outcomes exist. Below that the answer is "not enough data", never 0%.`,
    'Only WON and LOST count. A bid decision is not a result, a submitted proposal awaiting an award notice is pending, and a cancelled or withdrawn solicitation decided no contest.',
    'Pending pursuits are reported but never enter the win-rate denominator.',
    'Public award records show who was awarded, not who bid — an award share is never presented as a competitor win rate.',
    'Another customer’s private data never affects any figure here. Public federal award records are the only shared substrate.',
    'Everything the agent produces is advice. It changes no decision, weight, priority, pursuit, price or capability.',
  ],
}

// -------------------------------------------------------------
// GET /portfolio
// -------------------------------------------------------------

router.get('/portfolio', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const [artifact, schedule, lastRun, escalations] = await Promise.all([
      prisma.agentArtifact.findFirst({
        where: {
          consultingFirmId, agentKey: AGENT_KEY, artifactType: 'PORTFOLIO_INTELLIGENCE',
          supersededByArtifactId: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.agentSchedule.findFirst({
        where: { consultingFirmId, agentKey: AGENT_KEY },
        select: {
          isEnabled: true, cronExpression: true, nextRunAt: true, lastRunAt: true,
          lastSuccessfulRunAt: true, lastFailureAt: true, lastFailureMessage: true, autonomyLevel: true,
        },
      }),
      prisma.agentRun.findFirst({
        where: { consultingFirmId, agentKey: AGENT_KEY },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, triggerType: true, createdAt: true, finishedAt: true,
          outputSummary: true, warnings: true, limitations: true,
          tokenInput: true, tokenOutput: true, estimatedCostUsd: true,
        },
      }),
      prisma.agentEscalation.findMany({
        where: { consultingFirmId, agentKey: AGENT_KEY, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, severity: true, status: true, title: true, reason: true,
          recommendedAction: true, entityType: true, entityId: true, createdAt: true,
        },
      }),
    ])

    res.json({
      success: true,
      data: {
        agentKey: AGENT_KEY,
        schedule,
        lastRun,
        // null = the agent has not analysed this firm yet.
        intelligence: artifact
          ? { artifactId: artifact.id, generatedAt: artifact.createdAt, ...(artifact.structuredData as object) }
          : null,
        escalations,
        policy: INTELLIGENCE_POLICY,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /segments
// -------------------------------------------------------------

router.get('/segments', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const segmentType = typeof req.query.segmentType === 'string' ? req.query.segmentType : undefined
    const includeSuperseded = req.query.includeSuperseded === 'true'

    const segments = await prisma.winLossSegment.findMany({
      where: {
        consultingFirmId,
        ...(includeSuperseded ? {} : { supersededAt: null }),
        ...(segmentType ? { segmentType: segmentType as never } : {}),
      },
      orderBy: [{ computedAt: 'desc' }, { sampleSize: 'desc' }],
      take: 300,
    })

    res.json({ success: true, data: { segments, policy: INTELLIGENCE_POLICY } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /recommendations
// -------------------------------------------------------------

router.get('/recommendations', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const status = typeof req.query.status === 'string' ? req.query.status : 'ACTIVE'

    const recommendations = await prisma.captureRecommendation.findMany({
      where: { consultingFirmId, ...(status === 'ALL' ? {} : { status: status as never }) },
      orderBy: [{ status: 'asc' }, { rank: 'asc' }, { sampleSize: 'desc' }],
      take: 100,
    })

    res.json({ success: true, data: { recommendations, policy: INTELLIGENCE_POLICY } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Human control over the agent's own advice
// -------------------------------------------------------------

const DismissSchema = z.object({ reason: z.string().trim().min(1).max(2000) })

/**
 * A person declines a recommendation.
 *
 * This changes the status of the agent's advice and NOTHING else. No pursuit,
 * no priority, no scoring weight, no WinLossSegment and no historical evidence
 * is touched — the measurement stays exactly as measured.
 *
 * The dismissal is keyed to the recommendation's evidence fingerprint, so the
 * weekly run will not re-raise it. Materially different evidence produces a
 * different fingerprint and may legitimately surface a new version.
 */
router.post('/recommendations/:id/dismiss', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A recommendation must be dismissed by a person.')

    const parsed = DismissSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A reason is required to dismiss a recommendation.')

    const existing = await prisma.captureRecommendation.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('CaptureRecommendation')
    if (existing.status === 'DISMISSED') throw new ConflictError('This recommendation has already been dismissed.')

    const recommendation = await prisma.captureRecommendation.update({
      where: { id: existing.id },
      data: {
        status: 'DISMISSED',
        dismissedByUserId: userId,
        dismissedAt: new Date(),
        dismissReason: parsed.data.reason,
      },
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'UPDATE', entityType: 'CaptureRecommendation', entityId: recommendation.id,
      rationale: `Capture recommendation for ${recommendation.segmentLabel} dismissed: ${parsed.data.reason.slice(0, 200)}. No pursuit, weight or measurement was changed.`,
      before: { status: existing.status },
      after: { status: 'DISMISSED' },
    })

    res.json({ success: true, data: { recommendation } })
  } catch (err) { next(err) }
})

/**
 * A person records that they have read a recommendation. Status is unchanged.
 *
 * No explicit role gate: `enforceTenantScope` already makes every non-GET
 * admin-only, which is the platform-wide read-only policy for team members.
 */
router.post('/recommendations/:id/acknowledge', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A recommendation must be acknowledged by a person.')

    const existing = await prisma.captureRecommendation.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('CaptureRecommendation')

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'ACCESS', entityType: 'CaptureRecommendation', entityId: existing.id,
      rationale: `Capture recommendation for ${existing.segmentLabel} acknowledged. Advisory only — nothing was changed.`,
    })

    res.json({ success: true, data: { recommendation: existing, acknowledged: true } })
  } catch (err) { next(err) }
})

export default router
