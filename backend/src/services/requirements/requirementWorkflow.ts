// =============================================================
// §6.3F — Requirement ownership, status workflow and notifications.
//
// Reuses the EXISTING ComplianceMatrix / MatrixRequirement records and the
// existing proposal responsibility matrix — there is no second matrix.
//
// The workflow is a real state machine: invalid transitions are rejected, not
// silently applied. Legacy enum values (COMPLETED, PENDING_REVIEW, BLOCKED) are
// accepted as aliases so existing production rows keep working, while nothing
// new is written with them.
// =============================================================
import { MatrixRequirementStatus, NotificationType } from '@prisma/client'
import { prisma } from '../../config/database'
import { notifyUser } from '../notificationService'
import { ValidationError } from '../../utils/errors'

/** The §6.3F workflow states. */
export const WORKFLOW_STATES = [
  'NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW', 'CHANGES_REQUIRED',
  'COMPLETE', 'VERIFIED', 'NOT_APPLICABLE',
] as const
export type WorkflowState = (typeof WORKFLOW_STATES)[number]

/** Legacy values kept for existing rows, mapped onto the workflow. */
export const LEGACY_ALIASES: Record<string, WorkflowState> = {
  COMPLETED: 'COMPLETE',
  PENDING_REVIEW: 'READY_FOR_REVIEW',
  BLOCKED: 'CHANGES_REQUIRED',
}

export function normalizeState(status: MatrixRequirementStatus | string): WorkflowState {
  const s = String(status)
  if ((WORKFLOW_STATES as readonly string[]).includes(s)) return s as WorkflowState
  return LEGACY_ALIASES[s] ?? 'NOT_STARTED'
}

/**
 * Allowed transitions. NOT_APPLICABLE is reachable from any non-verified state
 * (a requirement can be ruled out at any point), and VERIFIED is terminal
 * except for an explicit re-open to CHANGES_REQUIRED.
 */
export const ALLOWED_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  NOT_STARTED: ['IN_PROGRESS', 'NOT_APPLICABLE'],
  IN_PROGRESS: ['READY_FOR_REVIEW', 'NOT_STARTED', 'NOT_APPLICABLE'],
  READY_FOR_REVIEW: ['CHANGES_REQUIRED', 'COMPLETE', 'IN_PROGRESS', 'NOT_APPLICABLE'],
  CHANGES_REQUIRED: ['IN_PROGRESS', 'READY_FOR_REVIEW', 'NOT_APPLICABLE'],
  COMPLETE: ['VERIFIED', 'CHANGES_REQUIRED', 'IN_PROGRESS'],
  VERIFIED: ['CHANGES_REQUIRED'],
  NOT_APPLICABLE: ['NOT_STARTED'],
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (from === to) return true
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}

/** Completion percentage implied by a state, when none is set explicitly. */
export const STATE_COMPLETION: Record<WorkflowState, number> = {
  NOT_STARTED: 0,
  IN_PROGRESS: 40,
  READY_FOR_REVIEW: 80,
  CHANGES_REQUIRED: 60,
  COMPLETE: 100,
  VERIFIED: 100,
  NOT_APPLICABLE: 100,
}

export interface TransitionArgs {
  consultingFirmId: string
  requirementId: string
  toStatus: WorkflowState
  actorUserId: string | null
  note?: string
  completionPercent?: number
  now?: Date
}

/**
 * Apply a status transition with history. Throws ValidationError on an invalid
 * transition so the route returns a proper 400 rather than corrupting state.
 */
export async function transitionRequirement(args: TransitionArgs) {
  const now = args.now ?? new Date()
  const requirement = await prisma.matrixRequirement.findFirst({
    where: { id: args.requirementId, matrix: { consultingFirmId: args.consultingFirmId } },
    select: { id: true, status: true, ownerUserId: true, reviewerUserId: true, requirementText: true, matrix: { select: { opportunityId: true } } },
  })
  if (!requirement) throw new ValidationError('Requirement not found')

  const from = normalizeState(requirement.status)
  if (!canTransition(from, args.toStatus)) {
    throw new ValidationError(
      `Cannot move a requirement from ${from} to ${args.toStatus}. Allowed next states: ${ALLOWED_TRANSITIONS[from].join(', ') || 'none'}.`,
    )
  }

  const updated = await prisma.matrixRequirement.update({
    where: { id: requirement.id },
    data: {
      status: args.toStatus as MatrixRequirementStatus,
      completionPercent: args.completionPercent ?? STATE_COMPLETION[args.toStatus],
      // VERIFIED is the human sign-off; it is the only path that sets the
      // verification flags.
      ...(args.toStatus === 'VERIFIED'
        ? { verificationStatus: 'VERIFIED', isManuallyVerified: true }
        : {}),
      ...(args.toStatus === 'CHANGES_REQUIRED' ? { isBlocked: true, blockerReason: args.note ?? 'Changes requested during review.' } : {}),
      ...(args.toStatus === 'IN_PROGRESS' ? { isBlocked: false, blockerReason: null } : {}),
      lastActivityAt: now,
    },
  })

  await prisma.matrixRequirementEvent.create({
    data: {
      consultingFirmId: args.consultingFirmId,
      requirementId: requirement.id,
      action: 'STATUS_CHANGE',
      fromValue: from,
      toValue: args.toStatus,
      actorUserId: args.actorUserId,
      note: args.note ?? null,
    },
  })

  // Notify the reviewer on hand-off, and the owner on rework. Deduped by the
  // (requirement, state) key so a repeated transition cannot spam.
  const opportunityId = requirement.matrix.opportunityId
  const label = requirement.requirementText.slice(0, 80)
  if (args.toStatus === 'READY_FOR_REVIEW' && requirement.reviewerUserId) {
    await notifyUser({
      consultingFirmId: args.consultingFirmId,
      userId: requirement.reviewerUserId,
      type: NotificationType.REQUIREMENT_ASSIGNMENT,
      title: 'Requirement ready for your review',
      body: label,
      linkPath: `/opportunities/${opportunityId}`,
      entityType: 'MatrixRequirement',
      entityId: requirement.id,
      dedupeKey: `requirement-review:${requirement.id}:READY_FOR_REVIEW`,
    })
  }
  if (args.toStatus === 'CHANGES_REQUIRED' && requirement.ownerUserId) {
    await notifyUser({
      consultingFirmId: args.consultingFirmId,
      userId: requirement.ownerUserId,
      type: NotificationType.REQUIREMENT_ASSIGNMENT,
      title: 'Changes requested on your requirement',
      body: `${label}${args.note ? ` — ${args.note}` : ''}`,
      linkPath: `/opportunities/${opportunityId}`,
      entityType: 'MatrixRequirement',
      entityId: requirement.id,
      dedupeKey: `requirement-changes:${requirement.id}:${now.toISOString().slice(0, 10)}`,
    })
  }

  return updated
}

export interface AssignArgs {
  consultingFirmId: string
  requirementId: string
  ownerUserId?: string | null
  reviewerUserId?: string | null
  dueDate?: Date | null
  actorUserId: string | null
  now?: Date
}

/** Assign owner/reviewer/due date, with history and a deduped notification. */
export async function assignRequirement(args: AssignArgs) {
  const now = args.now ?? new Date()
  const requirement = await prisma.matrixRequirement.findFirst({
    where: { id: args.requirementId, matrix: { consultingFirmId: args.consultingFirmId } },
    select: { id: true, ownerUserId: true, reviewerUserId: true, dueDate: true, requirementText: true, matrix: { select: { opportunityId: true } } },
  })
  if (!requirement) throw new ValidationError('Requirement not found')

  const updated = await prisma.matrixRequirement.update({
    where: { id: requirement.id },
    data: {
      ...(args.ownerUserId !== undefined ? { ownerUserId: args.ownerUserId } : {}),
      ...(args.reviewerUserId !== undefined ? { reviewerUserId: args.reviewerUserId } : {}),
      ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
      lastActivityAt: now,
    },
  })

  await prisma.matrixRequirementEvent.create({
    data: {
      consultingFirmId: args.consultingFirmId,
      requirementId: requirement.id,
      action: 'ASSIGN',
      fromValue: requirement.ownerUserId ?? null,
      toValue: args.ownerUserId ?? requirement.ownerUserId ?? null,
      actorUserId: args.actorUserId,
      note: args.dueDate !== undefined ? `Due ${args.dueDate ? args.dueDate.toISOString().slice(0, 10) : 'cleared'}` : null,
    },
  })

  if (args.ownerUserId && args.ownerUserId !== requirement.ownerUserId) {
    await notifyUser({
      consultingFirmId: args.consultingFirmId,
      userId: args.ownerUserId,
      type: NotificationType.REQUIREMENT_ASSIGNMENT,
      title: 'A compliance requirement was assigned to you',
      body: requirement.requirementText.slice(0, 120),
      linkPath: `/opportunities/${requirement.matrix.opportunityId}`,
      entityType: 'MatrixRequirement',
      entityId: requirement.id,
      // Owner in the key so a re-assignment to a different person still fires,
      // but re-assigning the same person never notifies twice.
      dedupeKey: `requirement-assign:${requirement.id}:${args.ownerUserId}`,
    })
  }

  return updated
}

/**
 * Notify owners of overdue requirements. Deduped per requirement per day, so a
 * worker running hourly cannot produce more than one notice a day.
 */
export async function notifyOverdueRequirements(
  options: { now?: Date; limit?: number } = {},
): Promise<{ scanned: number; notified: number }> {
  const now = options.now ?? new Date()
  const overdue = await prisma.matrixRequirement.findMany({
    where: {
      dueDate: { lt: now },
      ownerUserId: { not: null },
      consultingFirmId: { not: null },
      status: { notIn: [MatrixRequirementStatus.COMPLETE, MatrixRequirementStatus.VERIFIED, MatrixRequirementStatus.NOT_APPLICABLE, MatrixRequirementStatus.COMPLETED] },
    },
    select: {
      id: true, ownerUserId: true, consultingFirmId: true, requirementText: true, dueDate: true,
      matrix: { select: { opportunityId: true } },
    },
    take: options.limit ?? 500,
  })

  let notified = 0
  const day = now.toISOString().slice(0, 10)
  for (const r of overdue) {
    if (!r.ownerUserId || !r.consultingFirmId) continue
    await notifyUser({
      consultingFirmId: r.consultingFirmId,
      userId: r.ownerUserId,
      type: NotificationType.REQUIREMENT_ASSIGNMENT,
      title: 'Compliance requirement overdue',
      body: `${r.requirementText.slice(0, 120)} — was due ${r.dueDate?.toISOString().slice(0, 10)}`,
      linkPath: `/opportunities/${r.matrix.opportunityId}`,
      entityType: 'MatrixRequirement',
      entityId: r.id,
      dedupeKey: `requirement-overdue:${r.id}:${day}`,
    })
    notified++
  }
  return { scanned: overdue.length, notified }
}

export interface RequirementSummary {
  total: number
  byStatus: Record<WorkflowState, number>
  overdue: number
  unassigned: number
  blocked: number
  averageCompletion: number
}

export async function summarizeRequirements(
  consultingFirmId: string,
  opportunityId: string,
  now: Date = new Date(),
): Promise<RequirementSummary> {
  const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { id: true } })
  if (!matrix) {
    return {
      total: 0,
      byStatus: WORKFLOW_STATES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<WorkflowState, number>),
      overdue: 0, unassigned: 0, blocked: 0, averageCompletion: 0,
    }
  }

  const requirements = await prisma.matrixRequirement.findMany({
    where: { matrixId: matrix.id },
    select: { status: true, dueDate: true, ownerUserId: true, isBlocked: true, completionPercent: true },
  })

  const byStatus = WORKFLOW_STATES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<WorkflowState, number>)
  let overdue = 0
  let unassigned = 0
  let blocked = 0
  let completionSum = 0

  for (const r of requirements) {
    const state = normalizeState(r.status)
    byStatus[state]++
    const isDone = state === 'COMPLETE' || state === 'VERIFIED' || state === 'NOT_APPLICABLE'
    if (r.dueDate && r.dueDate < now && !isDone) overdue++
    if (!r.ownerUserId) unassigned++
    if (r.isBlocked) blocked++
    completionSum += r.completionPercent || STATE_COMPLETION[state]
  }

  return {
    total: requirements.length,
    byStatus,
    overdue,
    unassigned,
    blocked,
    averageCompletion: requirements.length === 0 ? 0 : Math.round(completionSum / requirements.length),
  }
}
