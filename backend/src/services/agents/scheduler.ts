// =============================================================
// §7.0 — Per-tenant agent scheduler.
//
// Copies the OpportunitySourceConfig pattern proven in §6.1A: one poll finds
// every due row across every tenant. Crucially there are NO per-tenant BullMQ
// repeatables — those would multiply Redis keys by (tenants x agents) and
// become the scaling problem instead of solving it.
//
// Duplicate-safety comes from the run idempotency key being bucketed to the
// due minute, so two scheduler passes inside the same window converge on one run.
// =============================================================
// cron-parser@^4.9.0. Already present in the tree as a BullMQ transitive
// dependency; declared directly in package.json so a future BullMQ bump cannot
// silently remove per-tenant cron scheduling.
import { parseExpression } from 'cron-parser'
import type { AgentSchedule } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { logAudit } from '../auditService'
import { requireAgentDefinition } from './registry'
import { buildRunIdempotencyKey, createRun, scheduleDiscriminator } from './runService'

/** A source that keeps failing backs off instead of being hammered. */
export const MAX_CONSECUTIVE_FAILURES = 10

export interface SchedulerResult {
  due: number
  runsCreated: number
  duplicatesSkipped: number
  skippedUnimplemented: number
  failures: number
  runIds: string[]
}

/**
 * Next fire time for a schedule. Returns null for MANUAL_ONLY and for a cron
 * expression the parser rejects — a bad expression must not silently become a
 * "runs constantly" schedule.
 */
export function computeNextRunAt(schedule: Pick<AgentSchedule, 'scheduleType' | 'cronExpression' | 'intervalMinutes' | 'timezone'>, from: Date = new Date()): Date | null {
  if (schedule.scheduleType === 'MANUAL_ONLY') return null

  if (schedule.scheduleType === 'INTERVAL') {
    const minutes = schedule.intervalMinutes ?? 0
    if (minutes <= 0) return null
    return new Date(from.getTime() + minutes * 60_000)
  }

  if (!schedule.cronExpression) return null
  try {
    const it = parseExpression(schedule.cronExpression, {
      currentDate: from,
      tz: schedule.timezone || 'UTC',
    })
    return it.next().toDate()
  } catch (err) {
    logger.warn('Invalid agent cron expression — schedule will not auto-run', {
      cronExpression: schedule.cronExpression,
      error: (err as Error).message,
    })
    return null
  }
}

export function isValidCronExpression(expr: string, timezone = 'UTC'): boolean {
  try {
    parseExpression(expr, { tz: timezone })
    return true
  } catch {
    return false
  }
}

/**
 * One scheduler pass. Creates a run per due schedule and advances nextRunAt.
 *
 * Returns counters rather than throwing: one tenant's bad configuration must
 * never abort the batch (the §6 `runDiscoveryIntelJob` contract).
 */
export async function runAgentScheduler(
  now: Date = new Date(),
  batchSize = 100,
  /**
   * Optional tenant scope. Production always scans EVERY tenant — one poll
   * serves the whole platform. The scope exists so a test can scan only the firm
   * it owns: several suites run in parallel against one database, and a global
   * scan makes any assertion about this pass's counters a race. Defaults to
   * undefined, so production behaviour is unchanged.
   */
  scope: { consultingFirmId?: string } = {},
): Promise<SchedulerResult> {
  const result: SchedulerResult = {
    due: 0,
    runsCreated: 0,
    duplicatesSkipped: 0,
    skippedUnimplemented: 0,
    failures: 0,
    runIds: [],
  }

  const due = await prisma.agentSchedule.findMany({
    where: {
      isEnabled: true,
      scheduleType: { not: 'MANUAL_ONLY' },
      nextRunAt: { not: null, lte: now },
      consecutiveFailures: { lt: MAX_CONSECUTIVE_FAILURES },
      ...(scope.consultingFirmId ? { consultingFirmId: scope.consultingFirmId } : {}),
    },
    orderBy: { nextRunAt: 'asc' },
    take: batchSize,
  })

  result.due = due.length

  for (const schedule of due) {
    try {
      const def = requireAgentDefinition(schedule.agentKey)

      // Advance the cursor FIRST so a crash mid-pass cannot produce a tight
      // re-fire loop on the same due window.
      const nextRunAt = computeNextRunAt(schedule, now)
      await prisma.agentSchedule.update({
        where: { id: schedule.id },
        data: { lastRunAt: now, nextRunAt },
      })

      if (!def.implemented || !def.handler) {
        // Never create runs for an agent that cannot execute.
        result.skippedUnimplemented++
        continue
      }

      const dueAt = schedule.nextRunAt ?? now
      const { run, created } = await createRun({
        consultingFirmId: schedule.consultingFirmId,
        agentKey: schedule.agentKey,
        triggerType: 'SCHEDULE',
        scheduleId: schedule.id,
        autonomyLevel: schedule.autonomyLevel,
        maxAttempts: schedule.maxAttempts,
        timeoutMs: schedule.timeoutMs,
        idempotencyKey: buildRunIdempotencyKey({
          agentKey: schedule.agentKey,
          consultingFirmId: schedule.consultingFirmId,
          trigger: 'SCHEDULE',
          discriminator: scheduleDiscriminator(dueAt),
        }),
      })

      if (created) {
        result.runsCreated++
        result.runIds.push(run.id)
      } else {
        result.duplicatesSkipped++
      }
    } catch (err) {
      result.failures++
      logger.error('Agent scheduler failed for one schedule (continuing)', {
        scheduleId: schedule.id,
        agentKey: schedule.agentKey,
        error: (err as Error).message,
      })
      await prisma.agentSchedule
        .update({
          where: { id: schedule.id },
          data: {
            lastFailureAt: now,
            lastFailureMessage: (err as Error).message.slice(0, 500),
            consecutiveFailures: { increment: 1 },
          },
        })
        .catch(() => undefined)
    }
  }

  if (result.due > 0) logger.info('Agent scheduler pass complete', result)
  return result
}

/** Records the outcome of a run against its schedule, driving the backoff. */
export async function recordScheduleOutcome(scheduleId: string, succeeded: boolean, message?: string): Promise<void> {
  const now = new Date()
  await prisma.agentSchedule
    .update({
      where: { id: scheduleId },
      data: succeeded
        ? { lastSuccessfulRunAt: now, consecutiveFailures: 0, lastFailureMessage: null }
        : { lastFailureAt: now, lastFailureMessage: message?.slice(0, 500) ?? null, consecutiveFailures: { increment: 1 } },
    })
    .catch((err) => logger.warn('Failed to record agent schedule outcome', { scheduleId, error: (err as Error).message }))
}

/** Creates or updates a tenant's schedule row, re-deriving nextRunAt. */
export async function upsertSchedule(args: {
  consultingFirmId: string
  agentKey: AgentSchedule['agentKey']
  actorUserId: string
  patch: Partial<Pick<AgentSchedule, 'isEnabled' | 'scheduleType' | 'cronExpression' | 'intervalMinutes' | 'timezone' | 'autonomyLevel' | 'maxAttempts' | 'timeoutMs' | 'tokenBudget'>>
}): Promise<AgentSchedule> {
  const def = requireAgentDefinition(args.agentKey)
  const existing = await prisma.agentSchedule.findUnique({
    where: { consultingFirmId_agentKey: { consultingFirmId: args.consultingFirmId, agentKey: args.agentKey } },
  })

  const merged = {
    scheduleType: args.patch.scheduleType ?? existing?.scheduleType ?? 'CRON',
    cronExpression: args.patch.cronExpression ?? existing?.cronExpression ?? def.defaultCronExpression,
    intervalMinutes: args.patch.intervalMinutes ?? existing?.intervalMinutes ?? null,
    timezone: args.patch.timezone ?? existing?.timezone ?? 'UTC',
  }
  const isEnabled = args.patch.isEnabled ?? existing?.isEnabled ?? def.defaultEnabled
  // A disabled schedule has no next fire time, so the due query skips it entirely.
  const nextRunAt = isEnabled ? computeNextRunAt(merged as AgentSchedule) : null

  const data = {
    isEnabled,
    scheduleType: merged.scheduleType,
    cronExpression: merged.cronExpression,
    intervalMinutes: merged.intervalMinutes,
    timezone: merged.timezone,
    autonomyLevel: args.patch.autonomyLevel ?? existing?.autonomyLevel ?? def.defaultAutonomyLevel,
    maxAttempts: args.patch.maxAttempts ?? existing?.maxAttempts ?? def.defaultMaxAttempts,
    timeoutMs: args.patch.timeoutMs ?? existing?.timeoutMs ?? def.maxRuntimeMs,
    tokenBudget: args.patch.tokenBudget ?? existing?.tokenBudget ?? def.defaultTokenBudget,
    nextRunAt,
  }

  const saved = await prisma.agentSchedule.upsert({
    where: { consultingFirmId_agentKey: { consultingFirmId: args.consultingFirmId, agentKey: args.agentKey } },
    create: { consultingFirmId: args.consultingFirmId, agentKey: args.agentKey, ...data },
    update: data,
  })

  void logAudit({
    consultingFirmId: args.consultingFirmId,
    actorUserId: args.actorUserId,
    action: 'AGENT_SCHEDULE_CHANGED',
    entityType: 'AgentSchedule',
    entityId: saved.id,
    rationale: `${args.agentKey} schedule updated (enabled=${saved.isEnabled}, autonomy=${saved.autonomyLevel})`,
    after: {
      isEnabled: saved.isEnabled,
      scheduleType: saved.scheduleType,
      cronExpression: saved.cronExpression,
      autonomyLevel: saved.autonomyLevel,
    },
  })

  return saved
}
