// =============================================================
// Contract deliverable status logic (Section 5 Module 8E)
//
// OVERDUE is DERIVED from due date + workflow status + a controlled clock — it
// is never persisted, so it can never go stale. Pure + clock-injected for
// deterministic tests.
// =============================================================

export type DeliverableStatus =
  | 'NOT_STARTED'
  | 'IN_PROGRESS'
  | 'READY_FOR_REVIEW'
  | 'SUBMITTED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'WAIVED'
  | 'CANCELLED'

export type DerivedDeliverableStatus = DeliverableStatus | 'OVERDUE'

export const DELIVERABLE_STATUSES: DeliverableStatus[] = [
  'NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'WAIVED', 'CANCELLED',
]

// Statuses that still require owner action (thus can be OVERDUE / UPCOMING).
// SUBMITTED is awaiting acceptance (owner is done) and terminal states never overdue.
const OPEN_STATUSES = new Set<DeliverableStatus>(['NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'REJECTED'])

const DAY_MS = 24 * 60 * 60 * 1000

/** Allowed workflow transitions. ACCEPTED/WAIVED/CANCELLED are terminal. */
const TRANSITIONS: Record<DeliverableStatus, DeliverableStatus[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'READY_FOR_REVIEW', 'SUBMITTED', 'WAIVED', 'CANCELLED'],
  IN_PROGRESS: ['READY_FOR_REVIEW', 'SUBMITTED', 'WAIVED', 'CANCELLED'],
  READY_FOR_REVIEW: ['IN_PROGRESS', 'SUBMITTED', 'WAIVED', 'CANCELLED'],
  SUBMITTED: ['ACCEPTED', 'REJECTED'],
  REJECTED: ['IN_PROGRESS', 'SUBMITTED', 'CANCELLED'],
  ACCEPTED: [],
  WAIVED: [],
  CANCELLED: [],
}

export function isValidDeliverableTransition(from: DeliverableStatus, to: DeliverableStatus): boolean {
  if (from === to) return true // idempotent no-op
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function isOverdue(dueDate: Date | null | undefined, status: DeliverableStatus, now: Date): boolean {
  if (!dueDate) return false
  if (!OPEN_STATUSES.has(status)) return false
  return dueDate.getTime() < now.getTime()
}

export function deriveStatus(dueDate: Date | null | undefined, status: DeliverableStatus, now: Date): DerivedDeliverableStatus {
  return isOverdue(dueDate, status, now) ? 'OVERDUE' : status
}

/** True when due within [now, now+windowDays] and still needing action. */
export function isUpcoming(
  dueDate: Date | null | undefined,
  status: DeliverableStatus,
  now: Date,
  windowDays: number,
): boolean {
  if (!dueDate) return false
  if (!OPEN_STATUSES.has(status)) return false
  const diff = dueDate.getTime() - now.getTime()
  return diff >= 0 && diff <= Math.max(0, windowDays) * DAY_MS
}
