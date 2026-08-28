// =============================================================
// §7.5 — Teaming Agent API.
//
// Deliberately small. Runs, schedules and escalations are already served by the
// generic `/api/agents` surface and are NOT recreated here.
//
//   GET    /plan/:pursuitId        latest TEAMING_PLAN + run + escalations
//   GET    /goals                  subcontracting goals with latest progress
//   POST   /goals                  ADMIN — record an obligation
//   PATCH  /goals/:id              ADMIN — correct or verify an obligation
//   GET    /performance            partner performance records
//
// THERE IS NO SEND ENDPOINT, AND NO EXECUTE ENDPOINT.
// Nothing here signs an agreement, executes an arrangement, clears a legal
// review, or transmits outreach. Those are human actions elsewhere in the
// product; §7.5 adds no route that performs them.
//
// Mounted at /api/agents/teaming. Tenant-scoped throughout.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import { NO_SUITABLE_PARTNER_MESSAGE } from '../services/agents/teaming/teamingAgentHandler'
import { LEGAL_REVIEW_BANNER } from '../services/agents/teaming/teamingPrompts'
import { MINIMUM_SAMPLE_SIZE } from '../services/agents/teaming/partnerPerformance'
import { AT_RISK_WORKING_DAYS } from '../services/agents/teaming/subcontractGoals'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'TEAMING' as const

/** The policy the UI displays so a reader can check the numbers themselves. */
const TEAMING_POLICY = {
  policyVersion: 'teaming-v1',
  minimumPerformanceSample: MINIMUM_SAMPLE_SIZE,
  atRiskWorkingDays: AT_RISK_WORKING_DAYS,
  legalReviewBanner: LEGAL_REVIEW_BANNER,
  noSuitablePartnerMessage: NO_SUITABLE_PARTNER_MESSAGE,
  notes: [
    'Every agreement and NDA is a draft. The agent never signs, executes, or clears legal review.',
    'Every outreach message is a draft. The agent never sends anything.',
    'A proposed partner is proposed mitigation. It does not close a capability gap.',
    'A proposed workshare is PROPOSED. It is not agreed and changes no arrangement, pricing or goal.',
    'Partner performance counts only deliverables a person attributed to that partner.',
  ],
}

/** Tenant-verified pursuit lookup. Never trusts an id alone. */
async function loadPursuit(consultingFirmId: string, pursuitId: string) {
  const pursuit = await prisma.bidPursuit.findFirst({
    where: { id: pursuitId, consultingFirmId },
    select: {
      id: true, opportunityId: true, pipelineStage: true, ownerUserId: true,
      opportunity: { select: { id: true, title: true, agency: true, responseDeadline: true } },
    },
  })
  if (!pursuit) throw new NotFoundError('Pursuit')
  return pursuit
}

// -------------------------------------------------------------
// GET /plan/:pursuitId
// -------------------------------------------------------------

router.get('/plan/:pursuitId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const pursuit = await loadPursuit(consultingFirmId, req.params.pursuitId)

    const [artifact, schedule, lastRun, escalations] = await Promise.all([
      prisma.agentArtifact.findFirst({
        where: {
          consultingFirmId, agentKey: AGENT_KEY, artifactType: 'TEAMING_PLAN',
          sourceEntityType: 'BidPursuit', sourceEntityId: pursuit.id,
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
        pursuit,
        schedule,
        lastRun,
        // null = the agent has not planned this pursuit yet.
        plan: artifact ? { artifactId: artifact.id, generatedAt: artifact.createdAt, ...(artifact.structuredData as object) } : null,
        escalations,
        policy: TEAMING_POLICY,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Subcontracting goals
// -------------------------------------------------------------

const GoalSchema = z.object({
  goalType: z.enum([
    'SMALL_BUSINESS', 'SMALL_DISADVANTAGED_BUSINESS', 'SDVOSB', 'VOSB',
    'WOSB', 'HUBZONE', 'ANC_TRIBAL', 'HBCU_MI', 'OTHER',
  ]),
  category: z.string().trim().max(120).optional(),
  targetType: z.enum(['PERCENT', 'AMOUNT']),
  targetPercent: z.number().min(0).max(100).optional(),
  targetAmount: z.number().min(0).optional(),
  source: z.enum(['SOLICITATION', 'SUBCONTRACTING_PLAN', 'CONTRACT', 'HUMAN_ENTRY']),
  sourceReference: z.string().trim().max(500).optional(),
  pursuitId: z.string().trim().optional(),
  contractId: z.string().trim().optional(),
  opportunityId: z.string().trim().optional(),
  measurementStartDate: z.string().datetime().optional(),
  measurementEndDate: z.string().datetime().optional(),
  dueDate: z.string().datetime().optional(),
  isHumanVerified: z.boolean().optional(),
  notes: z.string().trim().max(2000).optional(),
})

router.get('/goals', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const goals = await prisma.subcontractingGoal.findMany({
      where: {
        consultingFirmId,
        ...(req.query.pursuitId ? { pursuitId: String(req.query.pursuitId) } : {}),
        ...(req.query.includeArchived === 'true' ? {} : { status: { not: 'ARCHIVED' } }),
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 200,
      include: { progress: { orderBy: { calculatedAt: 'desc' }, take: 1 } },
    })
    res.json({ success: true, data: { goals, policy: TEAMING_POLICY } })
  } catch (err) { next(err) }
})

router.post('/goals', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A subcontracting goal must be recorded by a person.')

    const parsed = GoalSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload')
    const body = parsed.data

    // A target the platform cannot measure against is refused rather than
    // stored as an obligation nobody can satisfy.
    if (body.targetType === 'PERCENT' && (body.targetPercent === undefined || body.targetPercent <= 0)) {
      throw new ValidationError('A percentage goal requires a target percent greater than zero.')
    }
    if (body.targetType === 'AMOUNT' && (body.targetAmount === undefined || body.targetAmount <= 0)) {
      throw new ValidationError('An amount goal requires a target amount greater than zero.')
    }

    if (body.pursuitId) {
      const pursuit = await prisma.bidPursuit.findFirst({ where: { id: body.pursuitId, consultingFirmId }, select: { id: true } })
      if (!pursuit) throw new NotFoundError('Pursuit')
    }
    if (body.contractId) {
      const contract = await prisma.contract.findFirst({ where: { id: body.contractId, consultingFirmId }, select: { id: true } })
      if (!contract) throw new NotFoundError('Contract')
    }

    const goal = await prisma.subcontractingGoal.create({
      data: {
        consultingFirmId,
        goalType: body.goalType,
        category: body.category ?? null,
        targetType: body.targetType,
        targetPercent: body.targetPercent !== undefined ? new Prisma.Decimal(body.targetPercent) : null,
        targetAmount: body.targetAmount !== undefined ? new Prisma.Decimal(body.targetAmount) : null,
        source: body.source,
        sourceReference: body.sourceReference ?? null,
        pursuitId: body.pursuitId ?? null,
        contractId: body.contractId ?? null,
        opportunityId: body.opportunityId ?? null,
        measurementStartDate: body.measurementStartDate ? new Date(body.measurementStartDate) : null,
        measurementEndDate: body.measurementEndDate ? new Date(body.measurementEndDate) : null,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
        isHumanVerified: body.isHumanVerified ?? false,
        createdByUserId: userId,
        notes: body.notes ?? null,
      },
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'CREATE', entityType: 'SubcontractingGoal', entityId: goal.id,
      rationale: `Subcontracting obligation recorded from ${goal.source}.`,
      after: { goalType: goal.goalType, targetType: goal.targetType, isHumanVerified: goal.isHumanVerified },
    })

    res.status(201).json({ success: true, data: { goal } })
  } catch (err) { next(err) }
})

const GoalPatchSchema = GoalSchema.partial().extend({
  status: z.enum(['ACTIVE', 'ACHIEVED', 'MISSED', 'ARCHIVED']).optional(),
})

router.patch('/goals/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('A subcontracting goal must be changed by a person.')

    const existing = await prisma.subcontractingGoal.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Subcontracting goal')

    const parsed = GoalPatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload')
    const body = parsed.data

    const goal = await prisma.subcontractingGoal.update({
      where: { id: existing.id },
      data: {
        ...(body.goalType ? { goalType: body.goalType } : {}),
        ...(body.category !== undefined ? { category: body.category } : {}),
        ...(body.targetType ? { targetType: body.targetType } : {}),
        ...(body.targetPercent !== undefined ? { targetPercent: new Prisma.Decimal(body.targetPercent) } : {}),
        ...(body.targetAmount !== undefined ? { targetAmount: new Prisma.Decimal(body.targetAmount) } : {}),
        ...(body.source ? { source: body.source } : {}),
        ...(body.sourceReference !== undefined ? { sourceReference: body.sourceReference } : {}),
        ...(body.dueDate ? { dueDate: new Date(body.dueDate) } : {}),
        ...(body.isHumanVerified !== undefined ? { isHumanVerified: body.isHumanVerified } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
      },
    })

    await logAudit({
      consultingFirmId, actorUserId: userId, actorRole: req.user?.role,
      action: 'UPDATE', entityType: 'SubcontractingGoal', entityId: goal.id,
      rationale: 'Subcontracting obligation changed by an administrator.',
      before: { targetPercent: existing.targetPercent?.toString() ?? null, isHumanVerified: existing.isHumanVerified, status: existing.status },
      after: { targetPercent: goal.targetPercent?.toString() ?? null, isHumanVerified: goal.isHumanVerified, status: goal.status },
    })

    res.json({ success: true, data: { goal } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Partner performance
// -------------------------------------------------------------

router.get('/performance', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const records = await prisma.partnerPerformanceRecord.findMany({
      where: {
        consultingFirmId,
        ...(req.query.partnerId ? { partnerId: String(req.query.partnerId) } : {}),
      },
      orderBy: [{ periodEnd: 'desc' }, { partnerId: 'asc' }],
      take: 100,
      include: { partner: { select: { id: true, name: true } } },
    })
    res.json({ success: true, data: { records, policy: TEAMING_POLICY } })
  } catch (err) { next(err) }
})

export default router
