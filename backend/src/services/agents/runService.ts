// =============================================================
// §7.0 — AgentRun lifecycle persistence.
//
// Idempotency is enforced by the database, not by an in-memory lock: every run
// carries a UNIQUE idempotencyKey, so two schedulers, two workers or a replayed
// HTTP request converge on one row. This is the same technique §6 already uses
// for SourceSyncRun and SolicitationExtractionJob.
// =============================================================
import * as crypto from 'crypto'
import { Prisma } from '@prisma/client'
import type { AgentKey, AgentRun, AgentRunStatus, AgentTriggerType, AgentAutonomyLevel } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { logAudit } from '../auditService'
import { assertRunTransition, isTerminalRunStatus } from './runStateMachine'
import { requireAgentDefinition } from './registry'

/**
 * Deterministic idempotency keys.
 *
 *  SCHEDULE  bucketed to the minute of the due time, so a scheduler that runs
 *            twice for the same due window produces one run.
 *  EVENT     keyed to the event row — one run per event per agent, forever.
 *  MANUAL    keyed to an explicit caller-supplied token (or a fresh uuid), so a
 *            double-submitted button does not start two runs.
 */
export function buildRunIdempotencyKey(args: {
  agentKey: AgentKey
  consultingFirmId: string
  trigger: AgentTriggerType
  discriminator: string
}): string {
  const raw = `${args.agentKey}:${args.consultingFirmId}:${args.trigger}:${args.discriminator}`
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function scheduleDiscriminator(dueAt: Date): string {
  // Minute precision: two scheduler passes inside the same minute collapse.
  return dueAt.toISOString().slice(0, 16)
}

export interface CreateRunArgs {
  consultingFirmId: string
  agentKey: AgentKey
  triggerType: AgentTriggerType
  idempotencyKey: string
  scheduleId?: string | null
  eventId?: string | null
  triggerEntityType?: string | null
  triggerEntityId?: string | null
  initiatedByUserId?: string | null
  autonomyLevel?: AgentAutonomyLevel
  maxAttempts?: number
  timeoutMs?: number
}

export interface CreateRunResult {
  run: AgentRun
  /** False when an equivalent run already existed for this idempotency key. */
  created: boolean
}

/**
 * Creates a run, or returns the existing one for the same idempotency key.
 * Never throws on a duplicate — a duplicate IS the expected outcome of the
 * concurrency protections working.
 */
export async function createRun(args: CreateRunArgs): Promise<CreateRunResult> {
  const def = requireAgentDefinition(args.agentKey)

  try {
    const run = await prisma.agentRun.create({
      data: {
        consultingFirmId: args.consultingFirmId,
        agentKey: args.agentKey,
        scheduleId: args.scheduleId ?? null,
        eventId: args.eventId ?? null,
        triggerType: args.triggerType,
        triggerEntityType: args.triggerEntityType ?? null,
        triggerEntityId: args.triggerEntityId ?? null,
        initiatedByUserId: args.initiatedByUserId ?? null,
        idempotencyKey: args.idempotencyKey,
        status: 'QUEUED',
        autonomyLevel: args.autonomyLevel ?? def.defaultAutonomyLevel,
        maxAttempts: args.maxAttempts ?? def.defaultMaxAttempts,
        timeoutMs: args.timeoutMs ?? def.maxRuntimeMs,
      },
    })

    void logAudit({
      consultingFirmId: args.consultingFirmId,
      actorUserId: args.initiatedByUserId ?? null,
      action: 'AGENT_RUN_CREATED',
      entityType: 'AgentRun',
      entityId: run.id,
      rationale: `${args.agentKey} run queued via ${args.triggerType}`,
    })

    return { run, created: true }
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await prisma.agentRun.findUnique({ where: { idempotencyKey: args.idempotencyKey } })
      if (existing) return { run: existing, created: false }
    }
    throw err
  }
}

/**
 * Atomically claims a QUEUED run for execution. The status guard in the WHERE
 * clause is what makes this safe when two workers race — exactly one update
 * matches a row.
 */
export async function claimRunForExecution(runId: string): Promise<AgentRun | null> {
  const now = new Date()
  const claimed = await prisma.agentRun.updateMany({
    where: { id: runId, status: 'QUEUED' },
    data: { status: 'RUNNING', startedAt: now, heartbeatAt: now, progressStage: 'starting' },
  })
  if (claimed.count === 0) return null
  return prisma.agentRun.findUnique({ where: { id: runId } })
}

export async function heartbeatRun(runId: string, progressPercent: number, stage?: string): Promise<void> {
  await prisma.agentRun
    .updateMany({
      where: { id: runId, status: 'RUNNING' },
      data: {
        heartbeatAt: new Date(),
        progressPercent: Math.max(0, Math.min(100, Math.round(progressPercent))),
        ...(stage ? { progressStage: stage } : {}),
      },
    })
    .catch((err) => logger.warn('Agent heartbeat failed', { runId, error: (err as Error).message }))
}

export interface FinalizeRunArgs {
  runId: string
  status: AgentRunStatus
  outputSummary?: string | null
  confidenceState?: AgentRun['confidenceState']
  dataSufficiency?: AgentRun['dataSufficiency']
  warnings?: string[]
  limitations?: string[]
  errorCode?: string | null
  errorMessage?: string | null
  inputSnapshot?: Prisma.InputJsonValue
  inputHash?: string | null
  tokenInput?: number
  tokenOutput?: number
  estimatedCostUsd?: number
}

/**
 * Moves a run into a terminal status, validating the transition first. Returns
 * null when the run was already terminal — that is how a late-arriving timeout
 * loses safely to an already-recorded completion.
 */
export async function finalizeRun(args: FinalizeRunArgs): Promise<AgentRun | null> {
  const current = await prisma.agentRun.findUnique({
    where: { id: args.runId },
    select: { id: true, status: true, startedAt: true, agentKey: true, consultingFirmId: true },
  })
  if (!current) return null

  if (isTerminalRunStatus(current.status)) {
    logger.info('Ignoring finalize for an already-terminal agent run', {
      runId: args.runId,
      current: current.status,
      attempted: args.status,
    })
    return null
  }

  assertRunTransition(current.status, args.status)

  const now = new Date()
  const durationMs = current.startedAt ? now.getTime() - current.startedAt.getTime() : null

  // The status guard makes the write itself a compare-and-set.
  const updated = await prisma.agentRun.updateMany({
    where: { id: args.runId, status: current.status },
    data: {
      status: args.status,
      finishedAt: now,
      durationMs,
      progressPercent: args.status === 'COMPLETED' ? 100 : undefined,
      outputSummary: args.outputSummary ?? undefined,
      confidenceState: args.confidenceState ?? undefined,
      dataSufficiency: args.dataSufficiency ?? undefined,
      warnings: args.warnings ?? undefined,
      limitations: args.limitations ?? undefined,
      errorCode: args.errorCode ?? undefined,
      errorMessage: args.errorMessage ?? undefined,
      inputSnapshot: args.inputSnapshot ?? undefined,
      inputHash: args.inputHash ?? undefined,
      tokenInput: args.tokenInput ?? undefined,
      tokenOutput: args.tokenOutput ?? undefined,
      estimatedCostUsd: args.estimatedCostUsd ?? undefined,
      ...(args.status === 'CANCELLED' ? { cancelledAt: now } : {}),
    },
  })
  if (updated.count === 0) return null

  return prisma.agentRun.findUnique({ where: { id: args.runId } })
}

/** Re-queues a live run for another BullMQ attempt. Refuses once budget is spent. */
export async function requeueForRetry(runId: string): Promise<boolean> {
  const run = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: { status: true, attempt: true, maxAttempts: true },
  })
  if (!run || isTerminalRunStatus(run.status)) return false
  if (run.attempt >= run.maxAttempts) return false

  const updated = await prisma.agentRun.updateMany({
    where: { id: runId, status: 'RUNNING' },
    data: { status: 'QUEUED', attempt: { increment: 1 }, progressStage: 'retry-queued', heartbeatAt: new Date() },
  })
  return updated.count > 0
}

/**
 * Requests cancellation. A QUEUED run is cancelled outright; a RUNNING run is
 * cancelled and its in-flight handler observes the abort on its next check.
 */
export async function cancelRun(
  consultingFirmId: string,
  runId: string,
  userId: string | null,
): Promise<{ cancelled: boolean; reason?: string }> {
  const run = await prisma.agentRun.findFirst({
    where: { id: runId, consultingFirmId },
    select: { id: true, status: true, agentKey: true },
  })
  if (!run) return { cancelled: false, reason: 'NOT_FOUND' }
  if (isTerminalRunStatus(run.status)) return { cancelled: false, reason: `Run is already ${run.status}.` }

  const now = new Date()
  const updated = await prisma.agentRun.updateMany({
    where: { id: runId, status: { in: ['QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW'] } },
    data: { status: 'CANCELLED', cancelledAt: now, finishedAt: now, errorCode: 'CANCELLED', errorMessage: 'Cancelled by user.' },
  })
  if (updated.count === 0) return { cancelled: false, reason: 'Run reached a terminal state first.' }

  void logAudit({
    consultingFirmId,
    actorUserId: userId,
    action: 'AGENT_RUN_CANCELLED',
    entityType: 'AgentRun',
    entityId: runId,
    rationale: `${run.agentKey} run cancelled`,
  })
  return { cancelled: true }
}
