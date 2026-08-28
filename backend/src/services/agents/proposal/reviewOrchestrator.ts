// =============================================================
// §7.7 — Colour-team review orchestration.
//
// WHAT IT MAY DO
//   open the next planned cycle when the previous one has genuinely closed ·
//   report reviewer assignments · compute overdue reviews on working days ·
//   propose reminders · propose escalations
//
// WHAT IT MAY NEVER DO
//   mark a cycle APPROVED · record a reviewer's approval · approve a section ·
//   fabricate a review completion · invent a reviewer
//
// The canonical vocabulary is reused exactly as the platform already defines
// it: ReviewCycle.cycleType is PINK | RED | GOLD | WHITE and status is
// OPEN | IN_PROGRESS | RESOLVED | APPROVED | REJECTED. No second colour-team
// state system is introduced.
// =============================================================
import { prisma } from '../../../config/database'
import { workingDaysBetween } from '../../milestones/workingDays'
import type { WorkingCalendar } from '../../milestones/workingDays'

export const REVIEW_METHOD_VERSION = 'proposal-review-v1'

/** The canonical colour-team order. Reused, not reinvented. */
export const CYCLE_ORDER = ['PINK', 'RED', 'GOLD', 'WHITE'] as const
export type CycleType = (typeof CYCLE_ORDER)[number]

/** A cycle a human has finished with. Only these permit opening the next. */
export const CLOSED_STATUSES = ['APPROVED', 'REJECTED', 'RESOLVED'] as const

/** A cycle still in a human's hands. */
export const OPEN_STATUSES = ['OPEN', 'IN_PROGRESS'] as const

/** A section in review longer than this, in working days, is overdue. */
export const REVIEW_OVERDUE_WORKING_DAYS = 3

/** A cycle open longer than this, in working days, has stalled. */
export const CYCLE_STALL_WORKING_DAYS = 10

/** The reminder ladder, in working days since the review was requested. */
export const REMINDER_LADDER = [
  { afterWorkingDays: 2, audience: 'REVIEWER' as const },
  { afterWorkingDays: 5, audience: 'OWNER' as const },
  { afterWorkingDays: 8, audience: 'ADMIN' as const },
]

export interface CycleSummary {
  cycleId: string
  cycleType: string
  status: string
  startedAt: Date
  closedAt: Date | null
  approverUserId: string | null
  workingDaysOpen: number | null
  isClosed: boolean
  hasStalled: boolean
  openComments: number
  blockerComments: number
  nextAction: string
}

export interface SectionReviewState {
  sectionId: string
  title: string
  status: string
  ownerUserId: string | null
  reviewerUserId: string | null
  submittedForReviewAt: Date | null
  workingDaysInReview: number | null
  isOverdue: boolean
  /** No reviewer recorded — a person must assign one; the agent never guesses. */
  reviewerAssignmentRequired: boolean
  dueDate: Date | null
}

export interface ReminderProposal {
  sectionId: string
  audience: 'REVIEWER' | 'OWNER' | 'ADMIN'
  userId: string | null
  reason: string
  /** Stable across six-hourly sweeps, so an unchanged state never re-notifies. */
  dedupeKey: string
}

/**
 * Summarise every review cycle for an opportunity.
 *
 * `nextAction` states what a PERSON should do next; nothing here performs it.
 */
export async function summariseCycles(
  consultingFirmId: string,
  opportunityId: string,
  now: Date,
  calendar: WorkingCalendar,
): Promise<CycleSummary[]> {
  const cycles = await prisma.reviewCycle.findMany({
    where: { consultingFirmId, opportunityId },
    orderBy: { startedAt: 'asc' },
    include: { comments: { select: { status: true, severity: true } } },
  })

  return cycles.map((cycle) => {
    const isClosed = (CLOSED_STATUSES as readonly string[]).includes(cycle.status)
    const workingDaysOpen = isClosed ? null : workingDaysBetween(cycle.startedAt, now, calendar)
    const openComments = cycle.comments.filter((c) => c.status === 'OPEN').length
    const blockerComments = cycle.comments.filter((c) => c.status === 'OPEN' && c.severity === 'BLOCKER').length
    const hasStalled = !isClosed && workingDaysOpen !== null && workingDaysOpen > CYCLE_STALL_WORKING_DAYS

    let nextAction: string
    if (isClosed) {
      nextAction = `Closed as ${cycle.status}. No further action.`
    } else if (blockerComments > 0) {
      nextAction = `${blockerComments} blocker comment(s) remain open. A person must resolve them before this cycle can close.`
    } else if (openComments > 0) {
      nextAction = `${openComments} comment(s) remain open.`
    } else {
      nextAction = 'No open comments. A person decides whether this cycle is complete — the agent never closes it.'
    }

    return {
      cycleId: cycle.id,
      cycleType: cycle.cycleType,
      status: cycle.status,
      startedAt: cycle.startedAt,
      closedAt: cycle.closedAt,
      approverUserId: cycle.approverUserId,
      workingDaysOpen,
      isClosed,
      hasStalled,
      openComments,
      blockerComments,
      nextAction,
    }
  })
}

/**
 * The next colour-team cycle the agent may open, if any.
 *
 * Returns null unless EVERY existing cycle has genuinely closed by a human
 * outcome and there is a later colour in the sequence. A cycle a person is
 * still working on always blocks the next one.
 */
export function nextCycleToOpen(cycles: CycleSummary[]): CycleType | null {
  if (cycles.some((c) => !c.isClosed)) return null

  const seen = new Set(cycles.map((c) => c.cycleType.toUpperCase()))
  for (const type of CYCLE_ORDER) {
    if (!seen.has(type)) return type
  }
  return null
}

/**
 * Open the next cycle, idempotently.
 *
 * The uniqueness check runs INSIDE the transaction, so two concurrent sweeps
 * cannot both create the same colour. The new cycle is OPEN — never APPROVED.
 */
export async function openNextCycle(args: {
  consultingFirmId: string
  opportunityId: string
  cycleType: CycleType
}): Promise<{ created: boolean; cycleId: string | null }> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.reviewCycle.findFirst({
      where: {
        consultingFirmId: args.consultingFirmId,
        opportunityId: args.opportunityId,
        cycleType: args.cycleType,
      },
      select: { id: true },
    })
    if (existing) return { created: false, cycleId: existing.id }

    const cycle = await tx.reviewCycle.create({
      data: {
        consultingFirmId: args.consultingFirmId,
        opportunityId: args.opportunityId,
        cycleType: args.cycleType,
        // OPEN, always. Approval is a human act with a human approver.
        status: 'OPEN',
      },
    })
    return { created: true, cycleId: cycle.id }
  })
}

/**
 * Review state per section, on working days.
 *
 * A section with no reviewer is reported as needing assignment. The agent never
 * picks a reviewer from the tenant's user list.
 */
export function assessSectionReviews(
  sections: Array<{
    id: string
    title: string
    status: string
    ownerUserId: string | null
    reviewerUserId: string | null
    submittedForReviewAt: Date | null
    dueDate: Date | null
  }>,
  now: Date,
  calendar: WorkingCalendar,
): SectionReviewState[] {
  return sections.map((section) => {
    const inReview = section.status === 'IN_REVIEW'
    const workingDaysInReview =
      inReview && section.submittedForReviewAt ? workingDaysBetween(section.submittedForReviewAt, now, calendar) : null

    return {
      sectionId: section.id,
      title: section.title,
      status: section.status,
      ownerUserId: section.ownerUserId,
      reviewerUserId: section.reviewerUserId,
      submittedForReviewAt: section.submittedForReviewAt,
      workingDaysInReview,
      isOverdue: workingDaysInReview !== null && workingDaysInReview > REVIEW_OVERDUE_WORKING_DAYS,
      // Only meaningful once a section is actually awaiting review.
      reviewerAssignmentRequired: inReview && section.reviewerUserId === null,
      dueDate: section.dueDate,
    }
  })
}

/**
 * Reminders the run should send.
 *
 * One rung of the ladder at a time, keyed on the section, the audience and the
 * rung — so a six-hourly sweep over an unchanged review sends nothing new.
 */
export function proposeReminders(
  states: SectionReviewState[],
  adminUserIds: string[],
): ReminderProposal[] {
  const proposals: ReminderProposal[] = []

  for (const state of states) {
    if (state.workingDaysInReview === null) continue

    // The highest rung the elapsed time has reached.
    const rung = [...REMINDER_LADDER]
      .reverse()
      .find((r) => state.workingDaysInReview! >= r.afterWorkingDays)
    if (!rung) continue

    const base = `proposal-review-reminder:${state.sectionId}:${rung.audience}:${rung.afterWorkingDays}`

    if (rung.audience === 'REVIEWER') {
      if (!state.reviewerUserId) continue
      proposals.push({
        sectionId: state.sectionId,
        audience: 'REVIEWER',
        userId: state.reviewerUserId,
        reason: `"${state.title}" has been awaiting your review for ${state.workingDaysInReview} working day(s).`,
        dedupeKey: base,
      })
      continue
    }

    if (rung.audience === 'OWNER') {
      if (!state.ownerUserId) continue
      proposals.push({
        sectionId: state.sectionId,
        audience: 'OWNER',
        userId: state.ownerUserId,
        reason: `"${state.title}" has been in review for ${state.workingDaysInReview} working day(s) without a decision.`,
        dedupeKey: base,
      })
      continue
    }

    for (const adminId of adminUserIds) {
      proposals.push({
        sectionId: state.sectionId,
        audience: 'ADMIN',
        userId: adminId,
        reason: `"${state.title}" has been in review for ${state.workingDaysInReview} working day(s) and has passed the reviewer and owner reminders.`,
        dedupeKey: `${base}:${adminId}`,
      })
    }
  }

  return proposals
}

/**
 * Does the review picture warrant escalation?
 *
 * Escalating never completes a review — it asks a person to act. Clearing the
 * escalation requires the human decision the escalation is asking for.
 */
export function assessReviewEscalations(args: {
  cycles: CycleSummary[]
  sections: SectionReviewState[]
  workingDaysToDeadline: number | null
  deadlineRiskWindow: number
}): Array<{ severity: 'LOW' | 'MEDIUM' | 'HIGH'; title: string; reason: string; dedupeHint: string; sectionId: string | null }> {
  const escalations: Array<{ severity: 'LOW' | 'MEDIUM' | 'HIGH'; title: string; reason: string; dedupeHint: string; sectionId: string | null }> = []

  for (const cycle of args.cycles.filter((c) => c.hasStalled)) {
    escalations.push({
      severity: 'MEDIUM',
      title: `${cycle.cycleType} review cycle has stalled`,
      reason:
        `The ${cycle.cycleType} cycle has been open for ${cycle.workingDaysOpen} working day(s) with ${cycle.openComments} comment(s) still open. ` +
        'The agent does not close a review cycle; a person must.',
      dedupeHint: `proposal-cycle-stalled:${cycle.cycleId}`,
      sectionId: null,
    })
  }

  const nearDeadline = args.workingDaysToDeadline !== null && args.workingDaysToDeadline <= args.deadlineRiskWindow

  for (const section of args.sections.filter((s) => s.reviewerAssignmentRequired)) {
    escalations.push({
      severity: nearDeadline ? 'HIGH' : 'MEDIUM',
      title: `REVIEWER_ASSIGNMENT_REQUIRED — ${section.title}`,
      reason:
        `"${section.title}" is awaiting review but has no assigned reviewer` +
        `${nearDeadline ? ` with ${args.workingDaysToDeadline} working day(s) until the submission deadline` : ''}. ` +
        'The agent does not choose a reviewer.',
      dedupeHint: `proposal-reviewer-required:${section.sectionId}`,
      sectionId: section.sectionId,
    })
  }

  // Only escalate an overdue review once it has exhausted the ladder.
  const exhausted = args.sections.filter(
    (s) => s.workingDaysInReview !== null && s.workingDaysInReview >= REMINDER_LADDER[REMINDER_LADDER.length - 1].afterWorkingDays,
  )
  for (const section of exhausted) {
    escalations.push({
      severity: 'MEDIUM',
      title: `Review overdue after the full reminder ladder — ${section.title}`,
      reason:
        `"${section.title}" has been in review for ${section.workingDaysInReview} working day(s) and every reminder rung has been sent. ` +
        'The review is still not complete and the agent will not complete it.',
      dedupeHint: `proposal-review-overdue:${section.sectionId}`,
      sectionId: section.sectionId,
    })
  }

  return escalations
}
