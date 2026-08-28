// =============================================================
// §7.1 — Deliverable watch.
//
// Reuses the Section 5 derived-OVERDUE semantics (`deliverableStatus.isOverdue`
// / `isUpcoming`) — OVERDUE stays DERIVED and no competing persisted status is
// introduced. Reuses the Section 6 escalation ladder through the shared
// reminder policy, so contract deliverables and opportunity milestones speak
// one severity vocabulary.
//
// The agent may remind and escalate. It may NEVER accept, reject, submit or
// waive a deliverable — those stay human decisions and are enforced by the
// autonomy policy plus dedicated tests.
//
// `lastReminderAt` / `lastEscalationAt` already exist on ContractDeliverable and
// were never written by automation before this slice. They are operational
// bookkeeping, not human judgement, so the agent maintains them.
// =============================================================
import { NotificationType, ReminderLevel } from '@prisma/client'
import type { ContractDeliverable } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { notifyUser } from '../../notificationService'
import { isOverdue, isUpcoming, type DeliverableStatus } from '../../deliverableStatus'
import {
  buildReminderDedupeKey,
  decideLevel,
  isEscalationLevel,
  resolveReminderRecipients,
} from '../../reminders/reminderPolicy'
import {
  DELIVERABLE_DUE_SOON_DAYS,
  DELIVERABLE_ESCALATE_AFTER_HOURS,
  DELIVERABLE_LEAD_DAYS,
  type ContractHealthState,
} from './policy'
import type { EvidenceRef } from '../types'

/** Namespace for contract-deliverable reminder keys — never collides with milestones. */
export const DELIVERABLE_REMINDER_PREFIX = 'contract-deliverable-reminder'

export interface DeliverableItem {
  id: string
  name: string
  cdrlNumber: string | null
  dueDate: string | null
  status: string
  derivedStatus: string
  ownerUserId: string | null
  reviewerUserId: string | null
  isOverdue: boolean
  isDueSoon: boolean
  reminderLevel: ReminderLevel | null
  reminderReason: string | null
  lastReminderAt: string | null
  lastEscalationAt: string | null
}

export interface DeliverableAssessment {
  total: number
  dueSoon: number
  overdue: number
  awaitingReview: number
  unowned: number
  openItems: DeliverableItem[]
  remindersSent: number
  escalationsSent: number
  suppressed: number
  health: ContractHealthState
  evidence: EvidenceRef[]
  warnings: string[]
}

/** Statuses awaiting a reviewer/customer decision rather than owner action. */
const AWAITING_REVIEW = new Set(['SUBMITTED', 'READY_FOR_REVIEW'])

/**
 * Assesses a contract's deliverables and sends any due reminders.
 *
 * `sendReminders` is false under OBSERVE autonomy: the assessment is still
 * computed and reported, but nothing is written or notified.
 */
export async function assessDeliverables(args: {
  consultingFirmId: string
  contractId: string
  contractTitle: string
  now: Date
  sendReminders: boolean
  adminUserIds: string[]
}): Promise<DeliverableAssessment> {
  const { consultingFirmId, contractId, now } = args

  const deliverables = await prisma.contractDeliverable.findMany({
    where: { consultingFirmId, contractId, isArchived: false },
    orderBy: { dueDate: 'asc' },
  })

  const assessment: DeliverableAssessment = {
    total: deliverables.length,
    dueSoon: 0,
    overdue: 0,
    awaitingReview: 0,
    unowned: 0,
    openItems: [],
    remindersSent: 0,
    escalationsSent: 0,
    suppressed: 0,
    health: 'HEALTHY',
    evidence: [],
    warnings: [],
  }

  for (const d of deliverables) {
    const status = d.status as DeliverableStatus
    const overdue = isOverdue(d.dueDate, status, now)
    const dueSoon = isUpcoming(d.dueDate, status, now, DELIVERABLE_DUE_SOON_DAYS)
    const awaiting = AWAITING_REVIEW.has(status)

    if (overdue) assessment.overdue++
    if (dueSoon) assessment.dueSoon++
    if (awaiting) assessment.awaitingReview++

    // Only items that still need action participate in the reminder ladder.
    const needsAction = overdue || dueSoon
    let decision = null as ReturnType<typeof decideLevel>
    if (d.dueDate && needsAction) {
      decision = decideLevel(d.dueDate, now, DELIVERABLE_LEAD_DAYS, DELIVERABLE_ESCALATE_AFTER_HOURS)
    }

    if (needsAction && !d.ownerUserId && !d.reviewerUserId) {
      assessment.unowned++
      assessment.warnings.push(`Deliverable "${d.name}" needs action but has no owner or reviewer assigned.`)
    }

    if (overdue || dueSoon || awaiting) {
      assessment.openItems.push({
        id: d.id,
        name: d.name,
        cdrlNumber: d.cdrlNumber,
        dueDate: d.dueDate?.toISOString() ?? null,
        status: d.status,
        derivedStatus: overdue ? 'OVERDUE' : d.status,
        ownerUserId: d.ownerUserId,
        reviewerUserId: d.reviewerUserId,
        isOverdue: overdue,
        isDueSoon: dueSoon,
        reminderLevel: decision?.level ?? null,
        reminderReason: decision?.reason ?? null,
        lastReminderAt: d.lastReminderAt?.toISOString() ?? null,
        lastEscalationAt: d.lastEscalationAt?.toISOString() ?? null,
      })
    }

    if (!decision || !args.sendReminders) {
      if (decision && !args.sendReminders) assessment.suppressed++
      continue
    }

    const sent = await sendDeliverableReminders({
      deliverable: d,
      contractTitle: args.contractTitle,
      contractId,
      level: decision.level,
      reason: decision.reason,
      now,
      adminUserIds: args.adminUserIds,
    })
    assessment.remindersSent += sent.remindersSent
    assessment.escalationsSent += sent.escalations
    assessment.suppressed += sent.suppressed
  }

  assessment.health = assessment.overdue > 0 ? 'CRITICAL' : assessment.dueSoon > 0 ? 'ATTENTION' : 'HEALTHY'

  assessment.evidence.push({
    sourceType: 'ContractDeliverable',
    sourceId: contractId,
    sourceLocator: `contract:${contractId}/deliverables`,
    retrievedAt: now.toISOString(),
    note: `${assessment.total} deliverable(s): ${assessment.overdue} overdue, ${assessment.dueSoon} due soon, ${assessment.awaitingReview} awaiting review. OVERDUE is derived from due date + workflow status, never persisted.`,
  })

  return assessment
}

/**
 * Sends the reminder for one deliverable to the resolved recipient ladder.
 *
 * Dedupe is per (deliverable, user, level, channel, DAY), so repeated agent
 * runs on the same day never produce a second notification. `notifyUser`'s
 * unique `dedupeKey` is the enforcement point — not an in-memory check.
 */
async function sendDeliverableReminders(args: {
  deliverable: ContractDeliverable
  contractTitle: string
  contractId: string
  level: ReminderLevel
  reason: string
  now: Date
  adminUserIds: string[]
}): Promise<{ remindersSent: number; escalations: number; suppressed: number }> {
  const { deliverable: d, level, now } = args
  const result = { remindersSent: 0, escalations: 0, suppressed: 0 }

  const recipients = resolveReminderRecipients(
    { ownerUserId: d.ownerUserId, reviewerUserId: d.reviewerUserId },
    level,
    args.adminUserIds,
  )
  if (!recipients.length) {
    result.suppressed++
    return result
  }

  const escalating = isEscalationLevel(level)

  for (const recipient of recipients) {
    const dedupeKey = buildReminderDedupeKey({
      prefix: DELIVERABLE_REMINDER_PREFIX,
      entityId: d.id,
      userId: recipient.userId,
      level,
      channel: 'IN_APP',
      now,
    })

    try {
      await notifyUser({
        consultingFirmId: d.consultingFirmId,
        userId: recipient.userId,
        type: escalating ? NotificationType.MILESTONE_ESCALATION : NotificationType.MILESTONE_REMINDER,
        title: `${level.replace('_', ' ')} · ${d.name}`,
        body: `${args.reason}${recipient.isEscalation ? ` Escalated to you as ${recipient.role.toLowerCase()} because the deliverable is past due.` : ''} Contract: ${args.contractTitle}.`,
        linkPath: `/contracts/${args.contractId}`,
        entityType: 'ContractDeliverable',
        entityId: d.id,
        dedupeKey,
      })
      result.remindersSent++
      if (recipient.isEscalation) result.escalations++
    } catch (err) {
      result.suppressed++
      logger.warn('Contract deliverable reminder failed', { deliverableId: d.id, error: (err as Error).message })
    }
  }

  // Operational bookkeeping only — never a business-state change. Written once
  // per day at most, because the reminder itself is day-deduped.
  const sameDay = (a: Date | null) => a != null && a.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
  const patch: { lastReminderAt?: Date; lastEscalationAt?: Date } = {}
  if (!sameDay(d.lastReminderAt)) patch.lastReminderAt = now
  if (escalating && !sameDay(d.lastEscalationAt)) patch.lastEscalationAt = now

  if (Object.keys(patch).length > 0) {
    await prisma.contractDeliverable
      .update({ where: { id: d.id }, data: patch })
      .catch((err) => logger.warn('Failed to record deliverable reminder timestamps', { deliverableId: d.id, error: (err as Error).message }))
  }

  return result
}

/** Stable per (deliverable) so one overdue item raises one escalation, not one a day. */
export function deliverableEscalationDedupeHint(deliverableId: string): string {
  return `contract-deliverable-overdue:${deliverableId}`
}
