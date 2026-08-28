// =============================================================
// §7.0 — AgentRun state machine.
//
// Terminal states are immutable. A completed run is decision evidence: it is
// never rewritten, and a retry is represented by an incremented attempt on a
// still-live run or by a brand-new run — never by resurrecting a finished one.
// =============================================================
import type { AgentRunStatus } from '@prisma/client'
import { ValidationError } from '../../utils/errors'

export const TERMINAL_RUN_STATUSES: AgentRunStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
  'SKIPPED',
]

export const ALLOWED_RUN_TRANSITIONS: Record<AgentRunStatus, AgentRunStatus[]> = {
  // FAILED is reachable directly from QUEUED because pre-execution validation
  // (e.g. a run whose schedule belongs to another tenant) must be able to
  // refuse the run outright without first pretending it started.
  QUEUED: ['RUNNING', 'CANCELLED', 'SKIPPED', 'FAILED'],
  RUNNING: ['COMPLETED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'WAITING_FOR_REVIEW', 'SKIPPED', 'QUEUED'],
  WAITING_FOR_REVIEW: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
  SKIPPED: [],
}

export function isTerminalRunStatus(status: AgentRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status)
}

export function canTransitionRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return ALLOWED_RUN_TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * Throws unless the transition is legal. Used by every write path so an illegal
 * transition fails loudly rather than silently corrupting run history.
 *
 * RUNNING → QUEUED is the single "backwards" edge, and it exists only so a
 * BullMQ retry can re-queue a live run; it is rejected once the retry budget is
 * exhausted (the caller checks attempt >= maxAttempts first).
 */
export function assertRunTransition(from: AgentRunStatus, to: AgentRunStatus): void {
  if (from === to) return
  if (!canTransitionRun(from, to)) {
    throw new ValidationError(
      isTerminalRunStatus(from)
        ? `Agent run is already in terminal state ${from} and cannot move to ${to}.`
        : `Illegal agent run transition ${from} -> ${to}.`,
    )
  }
}
