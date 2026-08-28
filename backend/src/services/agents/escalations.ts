// =============================================================
// §7.0 — Escalation engine.
//
// An escalation is a decision the agent refused to make alone. The dedupe rule
// is what keeps this usable: a scheduled agent that re-runs every six hours must
// NOT produce four identical OPEN items a day. Repeat occurrences refresh the
// existing OPEN row instead.
//
// Dedupe is enforced by a UNIQUE column, not by a read-then-write race.
// =============================================================
import { Prisma } from '@prisma/client'
import type { AgentEscalationSeverity, AgentEscalationStatus, AgentKey } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { ValidationError } from '../../utils/errors'
import type { ProposedEscalation } from './types'

export const SEVERITY_RANK: Record<AgentEscalationSeverity, number> = {
  INFO: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
}

/** Terminal escalation states — an agent may never move an item out of these. */
const HUMAN_RESOLVED_STATUSES: AgentEscalationStatus[] = ['RESOLVED', 'DISMISSED']

export function buildEscalationDedupeKey(
  consultingFirmId: string,
  agentKey: AgentKey,
  dedupeHint: string,
): string {
  return `${consultingFirmId}:${agentKey}:${dedupeHint}`
}

export interface PersistEscalationsArgs {
  consultingFirmId: string
  runId: string | null
  agentKey: AgentKey
  escalations: ProposedEscalation[]
}

export interface PersistEscalationsResult {
  created: number
  refreshed: number
  suppressedResolved: number
  records: Array<{ id: string; severity: AgentEscalationSeverity; title: string; wasCreated: boolean }>
}

/**
 * Creates or refreshes escalations.
 *
 * A key that is already RESOLVED/DISMISSED is deliberately NOT reopened here —
 * an agent must not silently undo a human's decision. It is counted as
 * suppressed and surfaced in the run's counters so the behaviour is visible.
 */
export async function persistEscalations(args: PersistEscalationsArgs): Promise<PersistEscalationsResult> {
  const result: PersistEscalationsResult = { created: 0, refreshed: 0, suppressedResolved: 0, records: [] }

  for (const esc of args.escalations) {
    const dedupeKey = buildEscalationDedupeKey(args.consultingFirmId, args.agentKey, esc.dedupeHint)
    try {
      const existing = await prisma.agentEscalation.findUnique({
        where: { dedupeKey },
        select: { id: true, status: true, severity: true },
      })

      if (existing && HUMAN_RESOLVED_STATUSES.includes(existing.status)) {
        result.suppressedResolved++
        continue
      }

      if (existing) {
        const updated = await prisma.agentEscalation.update({
          where: { dedupeKey },
          data: {
            runId: args.runId,
            // Only ever escalate severity upward on a repeat sighting.
            severity: SEVERITY_RANK[esc.severity] > SEVERITY_RANK[existing.severity] ? esc.severity : existing.severity,
            reason: esc.reason,
            recommendedAction: esc.recommendedAction ?? null,
            dueAt: esc.dueAt ?? null,
          },
          select: { id: true, severity: true, title: true },
        })
        result.refreshed++
        result.records.push({ ...updated, wasCreated: false })
        continue
      }

      const created = await prisma.agentEscalation.create({
        data: {
          consultingFirmId: args.consultingFirmId,
          runId: args.runId,
          agentKey: args.agentKey,
          severity: esc.severity,
          status: 'OPEN',
          title: esc.title,
          reason: esc.reason,
          recommendedAction: esc.recommendedAction ?? null,
          entityType: esc.entityType ?? null,
          entityId: esc.entityId ?? null,
          assignedToUserId: esc.assignedToUserId ?? null,
          dueAt: esc.dueAt ?? null,
          dedupeKey,
        },
        select: { id: true, severity: true, title: true },
      })
      result.created++
      result.records.push({ ...created, wasCreated: true })
    } catch (err) {
      // Unique violation = a concurrent run inserted the same key first. That is
      // the dedupe working, not an error.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        result.refreshed++
        continue
      }
      logger.error('Failed to persist agent escalation', {
        agentKey: args.agentKey,
        error: (err as Error).message,
      })
    }
  }

  return result
}

export type EscalationTransition = 'ACKNOWLEDGE' | 'RESOLVE' | 'DISMISS'

const TRANSITION_TARGET: Record<EscalationTransition, AgentEscalationStatus> = {
  ACKNOWLEDGE: 'ACKNOWLEDGED',
  RESOLVE: 'RESOLVED',
  DISMISS: 'DISMISSED',
}

const ALLOWED_FROM: Record<EscalationTransition, AgentEscalationStatus[]> = {
  ACKNOWLEDGE: ['OPEN'],
  RESOLVE: ['OPEN', 'ACKNOWLEDGED'],
  DISMISS: ['OPEN', 'ACKNOWLEDGED'],
}

/**
 * Human transition. Tenant-scoped and state-checked, so a resolved escalation
 * cannot be resolved twice or reopened by a replayed request.
 */
export async function transitionEscalation(args: {
  consultingFirmId: string
  escalationId: string
  transition: EscalationTransition
  userId: string
  resolution?: string
}): Promise<{ id: string; status: AgentEscalationStatus }> {
  const existing = await prisma.agentEscalation.findFirst({
    where: { id: args.escalationId, consultingFirmId: args.consultingFirmId },
    select: { id: true, status: true },
  })
  if (!existing) throw new ValidationError('Escalation not found for this firm.')

  if (!ALLOWED_FROM[args.transition].includes(existing.status)) {
    throw new ValidationError(
      `Cannot ${args.transition.toLowerCase()} an escalation that is already ${existing.status}.`,
    )
  }

  const now = new Date()
  const target = TRANSITION_TARGET[args.transition]

  const data: Prisma.AgentEscalationUpdateInput = { status: target }
  if (args.transition === 'ACKNOWLEDGE') {
    data.acknowledgedAt = now
    data.acknowledgedByUserId = args.userId
  } else {
    data.resolvedAt = now
    data.resolvedByUserId = args.userId
    data.resolution = args.resolution ?? null
    // Resolving straight from OPEN still records the implicit acknowledgement.
    if (existing.status === 'OPEN') {
      data.acknowledgedAt = now
      data.acknowledgedByUserId = args.userId
    }
  }

  const updated = await prisma.agentEscalation.update({
    where: { id: args.escalationId },
    data,
    select: { id: true, status: true },
  })
  return updated
}

export async function countOpenEscalations(consultingFirmId: string): Promise<Record<string, number>> {
  const rows = await prisma.agentEscalation.groupBy({
    by: ['agentKey'],
    where: { consultingFirmId, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
    _count: { _all: true },
  })
  return Object.fromEntries(rows.map((r) => [r.agentKey, r._count._all]))
}
