// =============================================================
// Gate review state machine (§5.2). Pure + deterministic so it is unit-testable
// and shared between the route layer and tests. A gate review is a firm's
// internal go/no-go checkpoint — NOT an external government approval.
// =============================================================
import { GateReviewStatus } from '@prisma/client'

export const GATE_REVIEW_STATUSES: GateReviewStatus[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUIRED',
  'WAIVED',
]

// Terminal outcomes — no further transition (overdue never applies here).
export const GATE_REVIEW_TERMINAL: GateReviewStatus[] = ['APPROVED', 'REJECTED', 'WAIVED']

const ALLOWED: Record<GateReviewStatus, GateReviewStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'WAIVED'],
  IN_PROGRESS: ['APPROVED', 'REJECTED', 'CHANGES_REQUIRED', 'WAIVED'],
  CHANGES_REQUIRED: ['IN_PROGRESS', 'WAIVED'],
  APPROVED: [],
  REJECTED: [],
  WAIVED: [],
}

export function isValidGateTransition(from: GateReviewStatus, to: GateReviewStatus): boolean {
  if (from === to) return false
  return (ALLOWED[from] ?? []).includes(to)
}

export function allowedGateTargets(from: GateReviewStatus): GateReviewStatus[] {
  return ALLOWED[from] ?? []
}

// Overdue = a due date in the past and the review is not in a terminal state.
export function isGateOverdue(status: GateReviewStatus, dueDate: Date | null | undefined, now: Date): boolean {
  if (!dueDate) return false
  if (GATE_REVIEW_TERMINAL.includes(status)) return false
  return dueDate.getTime() < now.getTime()
}
