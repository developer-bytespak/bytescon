// =============================================================
// §7.0 — Agent operations API.
//
// Mounted at /api/agents. Tenant-scoped throughout.
//
// AUTHORIZATION NOTE (documented rather than worked around):
// `enforceTenantScope` makes CONSULTANT read-only platform-wide — any non-GET
// returns 403. That is a deliberate, separately-tested platform contract
// established in §5/§6, so in this slice a CONSULTANT can VIEW agent state but
// cannot configure schedules, trigger runs, resolve escalations, or save their
// own notification preferences. Weakening the middleware to make the agent UI
// nicer is explicitly out of scope; the UI surfaces the restriction instead.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma } from '@prisma/client'
import type { AgentKey, AgentRunStatus, AgentTriggerType } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logAudit } from '../services/auditService'
import { prisma } from '../config/database'
import { publicAgentDefinitions, isKnownAgentKey, requireAgentDefinition } from '../services/agents/registry'
import { upsertSchedule, isValidCronExpression } from '../services/agents/scheduler'
import { buildRunIdempotencyKey, createRun, cancelRun } from '../services/agents/runService'
import { transitionEscalation, countOpenEscalations } from '../services/agents/escalations'
import { verifyArtifact } from '../services/agents/artifacts'
import { DEFAULT_AGENT_NOTIFICATION_PREFERENCE } from '../services/agents/notifications'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const PAGE_SIZE_MAX = 100

function parsePaging(q: Record<string, unknown>): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Number(q.page) || 1)
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Number(q.pageSize) || 25))
  return { page, pageSize, skip: (page - 1) * pageSize }
}

function requireAgentKey(value: unknown): AgentKey {
  if (!isKnownAgentKey(value)) throw new ValidationError(`Unknown agent key: ${String(value)}`)
  const def = requireAgentDefinition(value)
  if (def.internal) throw new ValidationError('That agent key is not addressable through the product API.')
  return value
}

// -------------------------------------------------------------
// Definitions — the code-level registry, minus internal agents
// -------------------------------------------------------------

router.get('/definitions', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const data = publicAgentDefinitions().map((d) => ({
      key: d.key,
      name: d.name,
      description: d.description,
      implemented: d.implemented,
      plannedSlice: d.plannedSlice,
      defaultEnabled: d.defaultEnabled,
      supportedTriggers: d.supportedTriggers,
      defaultCronExpression: d.defaultCronExpression,
      defaultAutonomyLevel: d.defaultAutonomyLevel,
      requiresLlm: d.requiresLlm,
      noLlmBehaviour: d.noLlmBehaviour,
      maxRuntimeMs: d.maxRuntimeMs,
      defaultMaxAttempts: d.defaultMaxAttempts,
      defaultTokenBudget: d.defaultTokenBudget,
      supportedArtifactTypes: d.supportedArtifactTypes,
      subscribedEventTypes: d.subscribedEventTypes,
      allowlistedActionKeys: d.allowlistedActionKeys,
    }))
    res.json({ success: true, data })
  } catch (err) { next(err) }
})

/**
 * Overview: one row per public agent, joining registry metadata to this
 * tenant's schedule state and open-escalation count. Drives the agent
 * operations landing page in a single request.
 */
router.get('/overview', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const defs = publicAgentDefinitions()

    const [schedules, openCounts, lastRuns] = await Promise.all([
      prisma.agentSchedule.findMany({ where: { consultingFirmId } }),
      countOpenEscalations(consultingFirmId),
      prisma.agentRun.findMany({
        where: { consultingFirmId },
        orderBy: { createdAt: 'desc' },
        distinct: ['agentKey'],
        select: { agentKey: true, id: true, status: true, createdAt: true, finishedAt: true },
      }),
    ])

    const scheduleByKey = new Map(schedules.map((s) => [s.agentKey, s]))
    const lastRunByKey = new Map(lastRuns.map((r) => [r.agentKey, r]))

    const data = defs.map((d) => {
      const s = scheduleByKey.get(d.key)
      const lastRun = lastRunByKey.get(d.key)
      return {
        key: d.key,
        name: d.name,
        description: d.description,
        implemented: d.implemented,
        plannedSlice: d.plannedSlice,
        requiresLlm: d.requiresLlm,
        // A schedule row only means "configured". Never report an unimplemented
        // agent as enabled/healthy.
        isEnabled: d.implemented ? (s?.isEnabled ?? false) : false,
        isConfigured: Boolean(s),
        autonomyLevel: s?.autonomyLevel ?? d.defaultAutonomyLevel,
        scheduleType: s?.scheduleType ?? null,
        cronExpression: s?.cronExpression ?? d.defaultCronExpression,
        timezone: s?.timezone ?? 'UTC',
        nextRunAt: d.implemented ? (s?.nextRunAt ?? null) : null,
        lastRunAt: s?.lastRunAt ?? null,
        lastSuccessfulRunAt: s?.lastSuccessfulRunAt ?? null,
        lastFailureAt: s?.lastFailureAt ?? null,
        lastFailureMessage: s?.lastFailureMessage ?? null,
        consecutiveFailures: s?.consecutiveFailures ?? 0,
        openEscalations: openCounts[d.key] ?? 0,
        lastRun: lastRun
          ? { id: lastRun.id, status: lastRun.status, createdAt: lastRun.createdAt, finishedAt: lastRun.finishedAt }
          : null,
      }
    })

    res.json({ success: true, data })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Schedules
// -------------------------------------------------------------

router.get('/schedules', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const rows = await prisma.agentSchedule.findMany({
      where: { consultingFirmId, agentKey: { not: 'INTERNAL_DIAGNOSTIC' } },
      orderBy: { agentKey: 'asc' },
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

router.get('/schedules/:agentKey', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const agentKey = requireAgentKey(req.params.agentKey)
    const row = await prisma.agentSchedule.findUnique({
      where: { consultingFirmId_agentKey: { consultingFirmId, agentKey } },
    })
    if (!row) throw new NotFoundError('No schedule configured for this agent yet.')
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

const ScheduleUpsertSchema = z.object({
  isEnabled: z.boolean().optional(),
  scheduleType: z.enum(['CRON', 'INTERVAL', 'MANUAL_ONLY']).optional(),
  cronExpression: z.string().min(1).max(120).nullable().optional(),
  intervalMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  timezone: z.string().min(1).max(64).optional(),
  autonomyLevel: z.enum(['OBSERVE', 'PROPOSE', 'ACT_WITH_GUARDRAILS']).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
  tokenBudget: z.number().int().min(0).max(10_000_000).nullable().optional(),
})

router.put('/schedules/:agentKey', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const agentKey = requireAgentKey(req.params.agentKey)
    const parsed = ScheduleUpsertSchema.safeParse(req.body)
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid schedule payload.')

    const patch = parsed.data
    const def = requireAgentDefinition(agentKey)

    // Refuse to enable an agent that has no handler — that is exactly the
    // "fake healthy agent" this slice is required to prevent.
    if (patch.isEnabled && !def.implemented) {
      throw new ValidationError(
        `${def.name} is not implemented yet (planned in slice ${def.plannedSlice}) and cannot be enabled.`,
      )
    }

    if (patch.cronExpression && !isValidCronExpression(patch.cronExpression, patch.timezone ?? 'UTC')) {
      throw new ValidationError(`"${patch.cronExpression}" is not a valid cron expression.`)
    }
    if (patch.scheduleType === 'INTERVAL' && !patch.intervalMinutes) {
      throw new ValidationError('An interval schedule needs intervalMinutes.')
    }

    const saved = await upsertSchedule({
      consultingFirmId,
      agentKey,
      actorUserId: req.user!.userId,
      patch: patch as Parameters<typeof upsertSchedule>[0]['patch'],
    })
    res.json({ success: true, data: saved })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Runs
// -------------------------------------------------------------

router.get('/runs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { page, pageSize, skip } = parsePaging(req.query as Record<string, unknown>)

    const where: Prisma.AgentRunWhereInput = { consultingFirmId }
    if (req.query.agentKey) where.agentKey = requireAgentKey(req.query.agentKey)
    if (req.query.status) where.status = req.query.status as AgentRunStatus
    if (req.query.triggerType) where.triggerType = req.query.triggerType as AgentTriggerType
    if (req.query.entityId) where.triggerEntityId = String(req.query.entityId)
    if (req.query.entityType) where.triggerEntityType = String(req.query.entityType)
    if (req.query.from || req.query.to) {
      where.createdAt = {
        ...(req.query.from ? { gte: new Date(String(req.query.from)) } : {}),
        ...(req.query.to ? { lte: new Date(String(req.query.to)) } : {}),
      }
    }

    const [items, total] = await Promise.all([
      prisma.agentRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true, agentKey: true, status: true, triggerType: true, triggerEntityType: true,
          triggerEntityId: true, attempt: true, maxAttempts: true, progressPercent: true,
          progressStage: true, outputSummary: true, confidenceState: true, dataSufficiency: true,
          startedAt: true, finishedAt: true, durationMs: true, createdAt: true,
          errorCode: true, tokenInput: true, tokenOutput: true, estimatedCostUsd: true,
        },
      }),
      prisma.agentRun.count({ where }),
    ])

    res.json({
      success: true,
      data: { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) },
    })
  } catch (err) { next(err) }
})

router.get('/runs/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const run = await prisma.agentRun.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        artifacts: { orderBy: { createdAt: 'desc' } },
        escalations: { orderBy: { createdAt: 'desc' } },
        schedule: { select: { id: true, cronExpression: true, timezone: true, scheduleType: true } },
        event: { select: { id: true, eventType: true, entityType: true, entityId: true } },
      },
    })
    if (!run) throw new NotFoundError('Agent run not found.')

    const def = requireAgentDefinition(run.agentKey)
    // Audit trail for this run, so the detail page can show what it actually did.
    const auditEvents = await prisma.auditEvent.findMany({
      where: { consultingFirmId, entityType: { in: ['AgentRun', 'AgentEscalation'] }, entityId: run.id },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { id: true, action: true, rationale: true, actorUserId: true, createdAt: true },
    })

    res.json({ success: true, data: { ...run, agentName: def.name, auditEvents } })
  } catch (err) { next(err) }
})

const ManualRunSchema = z.object({
  agentKey: z.string(),
  idempotencyToken: z.string().min(4).max(200).optional(),
  triggerEntityType: z.string().max(80).nullable().optional(),
  triggerEntityId: z.string().max(200).nullable().optional(),
})

router.post('/runs', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ManualRunSchema.safeParse(req.body)
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid run payload.')

    const agentKey = requireAgentKey(parsed.data.agentKey)
    const def = requireAgentDefinition(agentKey)
    if (!def.implemented || !def.handler) {
      throw new ValidationError(
        `${def.name} is not implemented yet (planned in slice ${def.plannedSlice}) and cannot be run.`,
      )
    }

    const schedule = await prisma.agentSchedule.findUnique({
      where: { consultingFirmId_agentKey: { consultingFirmId, agentKey } },
    })

    // A caller-supplied token makes a double-submitted button idempotent.
    const discriminator = parsed.data.idempotencyToken ?? `${Date.now()}-${req.user!.userId}`
    const { run, created } = await createRun({
      consultingFirmId,
      agentKey,
      triggerType: 'MANUAL',
      scheduleId: schedule?.id ?? null,
      initiatedByUserId: req.user!.userId,
      triggerEntityType: parsed.data.triggerEntityType ?? null,
      triggerEntityId: parsed.data.triggerEntityId ?? null,
      autonomyLevel: schedule?.autonomyLevel ?? def.defaultAutonomyLevel,
      maxAttempts: schedule?.maxAttempts ?? def.defaultMaxAttempts,
      timeoutMs: schedule?.timeoutMs ?? def.maxRuntimeMs,
      idempotencyKey: buildRunIdempotencyKey({ agentKey, consultingFirmId, trigger: 'MANUAL', discriminator }),
    })

    if (created) {
      // Lazy import: keeps BullMQ (and its Redis connection) out of the module
      // graph of anything that merely mounts this router, e.g. the test app.
      const { enqueueAgentRun } = await import('../workers/agentWorker')
      await enqueueAgentRun(run.id)
    }

    res.status(created ? 201 : 200).json({
      success: true,
      data: { run, created, note: created ? undefined : 'An identical run already exists for this idempotency token.' },
    })
  } catch (err) { next(err) }
})

router.post('/runs/:id/cancel', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const result = await cancelRun(consultingFirmId, req.params.id, req.user!.userId)
    if (!result.cancelled && result.reason === 'NOT_FOUND') throw new NotFoundError('Agent run not found.')
    if (!result.cancelled) throw new ValidationError(result.reason ?? 'Run cannot be cancelled.')
    res.json({ success: true, data: { cancelled: true } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Artifacts
// -------------------------------------------------------------

router.get('/artifacts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { page, pageSize, skip } = parsePaging(req.query as Record<string, unknown>)
    const where: Prisma.AgentArtifactWhereInput = { consultingFirmId }
    if (req.query.agentKey) where.agentKey = requireAgentKey(req.query.agentKey)
    if (req.query.runId) where.runId = String(req.query.runId)
    if (req.query.currentOnly === 'true') where.supersededByArtifactId = null

    const [items, total] = await Promise.all([
      prisma.agentArtifact.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      prisma.agentArtifact.count({ where }),
    ])
    res.json({ success: true, data: { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) } })
  } catch (err) { next(err) }
})

router.get('/artifacts/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await prisma.agentArtifact.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!row) throw new NotFoundError('Artifact not found.')
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

router.post('/artifacts/:id/verify', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const ok = await verifyArtifact(consultingFirmId, req.params.id, req.user!.userId)
    if (!ok) throw new ValidationError('Artifact not found, or it is already human-verified.')
    await logAudit({
      consultingFirmId,
      actorUserId: req.user!.userId,
      action: 'APPROVAL',
      entityType: 'AgentArtifact',
      entityId: req.params.id,
      rationale: 'Artifact marked human-verified; the runtime will no longer supersede it.',
    })
    res.json({ success: true, data: { verified: true } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Escalations
// -------------------------------------------------------------

router.get('/escalations', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { page, pageSize, skip } = parsePaging(req.query as Record<string, unknown>)
    const where: Prisma.AgentEscalationWhereInput = { consultingFirmId }
    if (req.query.agentKey) where.agentKey = requireAgentKey(req.query.agentKey)
    if (req.query.status) where.status = req.query.status as Prisma.EnumAgentEscalationStatusFilter['equals']
    if (req.query.severity) where.severity = req.query.severity as Prisma.EnumAgentEscalationSeverityFilter['equals']

    const [items, total] = await Promise.all([
      prisma.agentEscalation.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], skip, take: pageSize }),
      prisma.agentEscalation.count({ where }),
    ])
    res.json({ success: true, data: { items, total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) } })
  } catch (err) { next(err) }
})

router.get('/escalations/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await prisma.agentEscalation.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: { run: { select: { id: true, agentKey: true, status: true, createdAt: true } } },
    })
    if (!row) throw new NotFoundError('Escalation not found.')
    res.json({ success: true, data: row })
  } catch (err) { next(err) }
})

const ResolveSchema = z.object({ resolution: z.string().min(1).max(2000).optional() })

for (const [path, transition, action] of [
  ['acknowledge', 'ACKNOWLEDGE', 'AGENT_ESCALATION_ACKNOWLEDGED'],
  ['resolve', 'RESOLVE', 'AGENT_ESCALATION_RESOLVED'],
  ['dismiss', 'DISMISS', 'AGENT_ESCALATION_RESOLVED'],
] as const) {
  router.post(`/escalations/:id/${path}`, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const parsed = ResolveSchema.safeParse(req.body ?? {})
      if (!parsed.success) throw new ValidationError('Invalid resolution payload.')

      const updated = await transitionEscalation({
        consultingFirmId,
        escalationId: req.params.id,
        transition,
        userId: req.user!.userId,
        resolution: parsed.data.resolution,
      })

      // Every human resolution is audited — that is the whole point of an
      // escalation being a human-judgement record.
      await logAudit({
        consultingFirmId,
        actorUserId: req.user!.userId,
        actorRole: req.user!.role,
        action,
        entityType: 'AgentEscalation',
        entityId: req.params.id,
        rationale: parsed.data.resolution ?? `Escalation ${transition.toLowerCase()}d`,
      })

      res.json({ success: true, data: updated })
    } catch (err) { next(err) }
  })
}

// -------------------------------------------------------------
// Notification preferences (per user, per agent)
// -------------------------------------------------------------

router.get('/notification-preferences', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user!.userId
    const rows = await prisma.agentNotificationPreference.findMany({ where: { consultingFirmId, userId } })
    const byKey = new Map(rows.map((r) => [r.agentKey, r]))

    // Every public agent gets a row in the response, defaulted where unset, so
    // the UI never has to guess what the effective behaviour is.
    const data = publicAgentDefinitions().map((d) => {
      const row = byKey.get(d.key)
      return {
        agentKey: d.key,
        agentName: d.name,
        isExplicit: Boolean(row),
        ...(row
          ? {
              inAppEnabled: row.inAppEnabled,
              emailEnabled: row.emailEnabled,
              minimumSeverity: row.minimumSeverity,
              notifyOnSuccess: row.notifyOnSuccess,
              notifyOnFailure: row.notifyOnFailure,
              notifyOnEscalation: row.notifyOnEscalation,
              digestMode: row.digestMode,
              timezone: row.timezone,
            }
          : { ...DEFAULT_AGENT_NOTIFICATION_PREFERENCE, timezone: 'UTC' }),
      }
    })
    res.json({ success: true, data })
  } catch (err) { next(err) }
})

const PreferenceSchema = z.object({
  inAppEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  minimumSeverity: z.enum(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  notifyOnSuccess: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
  notifyOnEscalation: z.boolean().optional(),
  digestMode: z.boolean().optional(),
  timezone: z.string().min(1).max(64).optional(),
})

router.put('/notification-preferences/:agentKey', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const agentKey = requireAgentKey(req.params.agentKey)
    const parsed = PreferenceSchema.safeParse(req.body)
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid preference payload.')

    const saved = await prisma.agentNotificationPreference.upsert({
      where: { userId_agentKey: { userId: req.user!.userId, agentKey } },
      create: { consultingFirmId, userId: req.user!.userId, agentKey, ...parsed.data },
      update: parsed.data,
    })
    res.json({ success: true, data: saved })
  } catch (err) { next(err) }
})

export default router
