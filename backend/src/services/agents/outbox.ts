// =============================================================
// §7.0 — Transactional outbox.
//
// WHY AN OUTBOX RATHER THAN REDIS PUB/SUB
// "Safe recovery after process restart" is an explicit requirement. Pub/sub
// drops messages nobody is listening for; a durable table does not. Equally
// important, a producer inserts the event INSIDE the same transaction as its
// business write, so an event can never exist for a rolled-back change and a
// committed change can never lose its event.
//
// Claiming uses a compare-and-set UPDATE guarded on status, so two workers
// polling simultaneously cannot both take the same row — the database decides,
// not an in-memory lock.
//
// This slice ships the infrastructure. Domain writes across Sections 5/6 are
// deliberately NOT retrofitted here; each agent slice adds its own emissions.
// =============================================================
import * as crypto from 'crypto'
import { Prisma } from '@prisma/client'
import type { AgentEvent } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { logAudit } from '../auditService'
import { agentsSubscribedTo } from './registry'
import { buildRunIdempotencyKey, createRun } from './runService'
import { agentEventsProcessed } from './metrics'

export const DEFAULT_EVENT_MAX_ATTEMPTS = 3

export interface EmitAgentEventArgs {
  consultingFirmId: string
  eventType: string
  entityType?: string | null
  entityId?: string | null
  payload?: Record<string, unknown>
  /** Stable per business fact. Defaults to a hash of type+entity. */
  dedupeKey?: string
  availableAt?: Date
}

export function buildEventDedupeKey(args: Pick<EmitAgentEventArgs, 'consultingFirmId' | 'eventType' | 'entityType' | 'entityId'>): string {
  const raw = `${args.consultingFirmId}:${args.eventType}:${args.entityType ?? '-'}:${args.entityId ?? '-'}`
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * Emits an event.
 *
 * PASS THE CALLER'S TRANSACTION CLIENT. Calling this with `prisma` outside a
 * transaction still works, but the at-least-once guarantee only holds when the
 * insert shares the business write's transaction:
 *
 *   await prisma.$transaction(async (tx) => {
 *     await tx.contract.update(...)
 *     await emitAgentEvent({ ... }, tx)
 *   })
 */
export async function emitAgentEvent(
  args: EmitAgentEventArgs,
  tx: Prisma.TransactionClient = prisma,
): Promise<{ eventId: string | null; created: boolean }> {
  const dedupeKey = args.dedupeKey ?? buildEventDedupeKey(args)

  // `createMany({ skipDuplicates: true })` compiles to INSERT ... ON CONFLICT DO
  // NOTHING, which is the only safe way to do this INSIDE a caller's
  // transaction: a plain `create` that violates the unique index raises a
  // PostgreSQL error, and an aborted transaction rejects every subsequent
  // statement with 25P02 — so the duplicate-recovery read would fail and, worse,
  // a benign duplicate event would roll back the caller's business write.
  const inserted = await tx.agentEvent.createMany({
    data: [
      {
        consultingFirmId: args.consultingFirmId,
        eventType: args.eventType,
        entityType: args.entityType ?? null,
        entityId: args.entityId ?? null,
        payload: (args.payload ?? {}) as Prisma.InputJsonObject,
        dedupeKey,
        availableAt: args.availableAt ?? new Date(),
        maxAttempts: DEFAULT_EVENT_MAX_ATTEMPTS,
      },
    ],
    skipDuplicates: true,
  })

  const row = await tx.agentEvent.findUnique({ where: { dedupeKey }, select: { id: true } })
  return { eventId: row?.id ?? null, created: inserted.count === 1 }
}

/**
 * Optional tenant scope.
 *
 * Production always drains EVERY tenant — one poll serves the whole platform,
 * which is the design. The scope exists so a test can drain only the firm it
 * owns: several suites run in parallel against one database, and a global drain
 * makes any assertion about "how many events did this pass handle" a race. It
 * defaults to undefined, so production behaviour is unchanged.
 */
export interface OutboxScope {
  consultingFirmId?: string
}

/**
 * Compare-and-set claim. Returns only rows this caller genuinely won.
 *
 * Two concurrent workers issuing the same UPDATE cannot both match: the second
 * sees status PROCESSING and its WHERE clause excludes the row.
 */
export async function claimEvents(
  workerId: string,
  limit = 20,
  now: Date = new Date(),
  scope: OutboxScope = {},
): Promise<AgentEvent[]> {
  const candidates = await prisma.agentEvent.findMany({
    where: {
      status: 'PENDING',
      availableAt: { lte: now },
      ...(scope.consultingFirmId ? { consultingFirmId: scope.consultingFirmId } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { id: true },
  })
  if (!candidates.length) return []

  const claimed: string[] = []
  for (const c of candidates) {
    const res = await prisma.agentEvent.updateMany({
      where: { id: c.id, status: 'PENDING' },
      data: { status: 'PROCESSING', claimedAt: now, claimedBy: workerId, attempt: { increment: 1 } },
    })
    if (res.count === 1) claimed.push(c.id)
  }
  if (!claimed.length) return []
  return prisma.agentEvent.findMany({ where: { id: { in: claimed } } })
}

export interface OutboxResult {
  claimed: number
  processed: number
  runsCreated: number
  duplicateRunsSkipped: number
  noSubscriber: number
  retried: number
  deadLettered: number
}

/**
 * Drains the outbox: claim → resolve subscribers → create runs → mark processed.
 *
 * An event is marked PROCESSED only after every interested agent has a run row,
 * so a crash mid-fan-out leaves it PROCESSING and the reaper releases it for
 * another attempt rather than losing the trigger.
 */
export async function processOutbox(
  workerId: string,
  limit = 20,
  now: Date = new Date(),
  scope: OutboxScope = {},
): Promise<OutboxResult> {
  const result: OutboxResult = {
    claimed: 0,
    processed: 0,
    runsCreated: 0,
    duplicateRunsSkipped: 0,
    noSubscriber: 0,
    retried: 0,
    deadLettered: 0,
  }

  const events = await claimEvents(workerId, limit, now, scope)
  result.claimed = events.length

  for (const event of events) {
    try {
      const subscribers = agentsSubscribedTo(event.eventType)

      if (!subscribers.length) {
        // Nothing implemented listens yet. That is a normal state in this slice
        // and must not be treated as a failure.
        await prisma.agentEvent.update({
          where: { id: event.id },
          data: { status: 'PROCESSED', processedAt: now, lastError: null },
        })
        result.noSubscriber++
        result.processed++
        agentEventsProcessed.inc({ status: 'PROCESSED' })
        continue
      }

      for (const def of subscribers) {
        const { created } = await createRun({
          consultingFirmId: event.consultingFirmId,
          agentKey: def.key,
          triggerType: 'EVENT',
          eventId: event.id,
          triggerEntityType: event.entityType,
          triggerEntityId: event.entityId,
          autonomyLevel: def.defaultAutonomyLevel,
          maxAttempts: def.defaultMaxAttempts,
          timeoutMs: def.maxRuntimeMs,
          // One run per (agent, event) forever — replaying the event is a no-op.
          idempotencyKey: buildRunIdempotencyKey({
            agentKey: def.key,
            consultingFirmId: event.consultingFirmId,
            trigger: 'EVENT',
            discriminator: event.id,
          }),
        })
        if (created) result.runsCreated++
        else result.duplicateRunsSkipped++
      }

      await prisma.agentEvent.update({
        where: { id: event.id },
        data: { status: 'PROCESSED', processedAt: now, lastError: null },
      })
      result.processed++
      agentEventsProcessed.inc({ status: 'PROCESSED' })

      void logAudit({
        consultingFirmId: event.consultingFirmId,
        actorUserId: null,
        action: 'AGENT_EVENT_PROCESSED',
        entityType: 'AgentEvent',
        entityId: event.id,
        rationale: `${event.eventType} fanned out to ${subscribers.length} agent(s)`,
      })
    } catch (err) {
      const message = (err as Error).message
      const exhausted = event.attempt >= event.maxAttempts

      await prisma.agentEvent.update({
        where: { id: event.id },
        data: {
          status: exhausted ? 'DEAD_LETTER' : 'PENDING',
          lastError: message.slice(0, 1000),
          // Linear backoff before the next attempt.
          availableAt: exhausted ? undefined : new Date(now.getTime() + 60_000 * event.attempt),
          claimedBy: null,
          claimedAt: null,
        },
      })

      if (exhausted) {
        result.deadLettered++
        agentEventsProcessed.inc({ status: 'DEAD_LETTER' })
        logger.error('Agent outbox event dead-lettered', { eventId: event.id, eventType: event.eventType, error: message })
      } else {
        result.retried++
        logger.warn('Agent outbox event failed, will retry', { eventId: event.id, attempt: event.attempt, error: message })
      }
    }
  }

  if (result.claimed > 0) logger.info('Agent outbox pass complete', result)
  return result
}

/**
 * Releases events stuck in PROCESSING because their worker died. Without this a
 * crash mid-fan-out would strand the trigger permanently.
 */
export async function releaseStuckEvents(staleAfterMs = 5 * 60_000, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - staleAfterMs)
  const released = await prisma.agentEvent.updateMany({
    where: { status: 'PROCESSING', claimedAt: { lt: cutoff } },
    data: { status: 'PENDING', claimedBy: null, claimedAt: null },
  })
  if (released.count > 0) logger.warn('Released stuck agent outbox events', { count: released.count })
  return released.count
}
