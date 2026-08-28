// =============================================================
// Pipeline stage state machine (Section 5.2 Opportunity Pipeline Tracker).
//
// Pure, dependency-free logic so it is trivially unit-testable and shared
// between the route layer and tests. `pipelineStage` is the human-managed
// capture lifecycle — a SEPARATE axis from BidPursuit.status (the calibration
// / award-routing declaration). Transitions here never touch that axis.
// =============================================================
import { PipelineStage, PursuitPriority } from '@prisma/client'

export const PIPELINE_STAGES: PipelineStage[] = [
  'IDENTIFIED',
  'QUALIFICATION',
  'CAPTURE',
  'PROPOSAL',
  'SUBMITTED',
  'AWARDED',
  'LOST',
  'NO_BID',
  'ARCHIVED',
]

export const PURSUIT_PRIORITIES: PursuitPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']

// A stage is terminal for overdue purposes: no next-action chasing once a
// pursuit is decided/closed, so those never count as overdue.
export const CLOSED_STAGES: PipelineStage[] = ['AWARDED', 'LOST', 'NO_BID', 'ARCHIVED']

// Forward capture flow plus the allowed off-ramps. AWARDED/LOST only archive
// (they must not silently rewind to an earlier active stage). NO_BID may be
// reassessed back into QUALIFICATION without losing history. ARCHIVED can be
// reopened to IDENTIFIED.
const ALLOWED_TRANSITIONS: Record<PipelineStage, PipelineStage[]> = {
  IDENTIFIED: ['QUALIFICATION', 'NO_BID', 'ARCHIVED'],
  QUALIFICATION: ['CAPTURE', 'NO_BID', 'ARCHIVED'],
  CAPTURE: ['PROPOSAL', 'NO_BID', 'ARCHIVED'],
  PROPOSAL: ['SUBMITTED', 'NO_BID', 'ARCHIVED'],
  SUBMITTED: ['AWARDED', 'LOST', 'ARCHIVED'],
  AWARDED: ['ARCHIVED'],
  LOST: ['ARCHIVED'],
  NO_BID: ['QUALIFICATION', 'ARCHIVED'],
  ARCHIVED: ['IDENTIFIED'],
}

export function isPipelineStage(value: unknown): value is PipelineStage {
  return typeof value === 'string' && (PIPELINE_STAGES as string[]).includes(value)
}

export function isPursuitPriority(value: unknown): value is PursuitPriority {
  return typeof value === 'string' && (PURSUIT_PRIORITIES as string[]).includes(value)
}

export function allowedStageTargets(from: PipelineStage): PipelineStage[] {
  return ALLOWED_TRANSITIONS[from] ?? []
}

// Same-stage moves are rejected (a no-op is not a transition). Unknown pairs
// are rejected. This blocks impossible transitions rather than silently
// applying them.
export function isValidStageTransition(from: PipelineStage, to: PipelineStage): boolean {
  if (from === to) return false
  return allowedStageTargets(from).includes(to)
}

// Overdue = there is a next-action due date in the past AND the pursuit is
// still in an open stage. Deterministic given `now` (tests inject a clock).
export function isPursuitOverdue(
  stage: PipelineStage,
  nextActionDueAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!nextActionDueAt) return false
  if (CLOSED_STAGES.includes(stage)) return false
  return nextActionDueAt.getTime() < now.getTime()
}
