// =============================================================
// §6.4D — Escalating owner reminders.
//
// Six levels: INFORMATIONAL → UPCOMING → DUE_SOON → URGENT → OVERDUE →
// ESCALATED. Each level fires at most once per milestone per user per
// occurrence day, enforced by a unique dedupe key, so a worker running hourly
// cannot spam.
//
// Suppression rules (all enforced before any notification is written):
//   completed · cancelled · waived · archived opportunity · acknowledged ·
//   snoozed · milestone has no owner
//
// Escalation goes owner → backup owner → team lead (firm ADMINs), and only
// after the configured grace period past the due date.
// =============================================================
import { MilestoneStatus, NotificationType, ReminderLevel } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { notifyUser } from '../notificationService'
import { buildReminderDedupeKey, decideLevel as decideReminderLevel } from '../reminders/reminderPolicy'

/** Namespace for milestone reminder dedupe keys. Unchanged from §6.4. */
export const MILESTONE_REMINDER_PREFIX = 'milestone-reminder'

// §7.1 — the ladder itself now lives in the shared reminder policy so contract
// deliverables (and later Compliance/Finance items) use the SAME levels and
// thresholds. Re-exported here so every existing §6.4 import keeps working
// unchanged.
export { DEFAULT_ESCALATION_HOURS, decideLevel } from '../reminders/reminderPolicy'
export type { LevelDecision } from '../reminders/reminderPolicy'

/** One row per milestone/user/level/day — the anti-spam guarantee. */
export function buildReminderKey(milestoneId: string, userId: string, level: ReminderLevel, channel: string, now: Date): string {
  // Delegates to the shared builder; the produced string is byte-identical to
  // the §6.4 original, so historical dedupe keys still match.
  return buildReminderDedupeKey({ prefix: MILESTONE_REMINDER_PREFIX, entityId: milestoneId, userId, level, channel, now })
}

/** Statuses that suppress reminders entirely. */
export const SUPPRESSING_STATUSES: MilestoneStatus[] = [
  MilestoneStatus.COMPLETE,
  MilestoneStatus.CANCELLED,
  MilestoneStatus.WAIVED,
]

export interface ReminderRunResult {
  scanned: number
  remindersSent: number
  escalations: number
  suppressed: number
  failures: number
}

/**
 * Scan due milestones and send the appropriate reminder to each responsible
 * party. Safe to run on a schedule and safe to restart mid-run.
 */
export async function runReminderScan(
  options: { now?: Date; horizonDays?: number; limit?: number } = {},
): Promise<ReminderRunResult> {
  const now = options.now ?? new Date()
  const horizonDays = options.horizonDays ?? 30
  const horizon = new Date(now.getTime() + horizonDays * 86400000)

  const milestones = await prisma.opportunityMilestone.findMany({
    where: {
      remindersEnabled: true,
      status: { notIn: SUPPRESSING_STATUSES },
      endAt: { not: null, lte: horizon },
      // A milestone with nobody responsible has nobody to remind.
      OR: [{ ownerUserId: { not: null } }, { backupOwnerUserId: { not: null } }],
      opportunity: { status: 'ACTIVE' },
    },
    select: {
      id: true, consultingFirmId: true, opportunityId: true, title: true, milestoneType: true,
      endAt: true, ownerUserId: true, backupOwnerUserId: true, reminderLeadDays: true,
      escalateAfterDueHours: true, priority: true, status: true,
    },
    orderBy: { endAt: 'asc' },
    take: options.limit ?? 500,
  })

  let remindersSent = 0
  let escalations = 0
  let suppressed = 0
  let failures = 0

  for (const milestone of milestones) {
    if (!milestone.endAt) { suppressed++; continue }

    const decision = decideReminderLevel(milestone.endAt, now, milestone.reminderLeadDays, milestone.escalateAfterDueHours)
    if (!decision) { suppressed++; continue }

    // Acknowledged or snoozed at this level suppresses the reminder.
    const priorLog = await prisma.milestoneReminderLog.findFirst({
      where: { milestoneId: milestone.id, level: decision.level },
      orderBy: { sentAt: 'desc' },
      select: { acknowledgedAt: true, snoozedUntil: true },
    })
    if (priorLog?.acknowledgedAt) { suppressed++; continue }
    if (priorLog?.snoozedUntil && priorLog.snoozedUntil > now) { suppressed++; continue }

    // Recipients: owner always; backup and leads only on escalation.
    const recipients: Array<{ userId: string; isEscalation: boolean }> = []
    if (milestone.ownerUserId) recipients.push({ userId: milestone.ownerUserId, isEscalation: false })

    if (decision.level === ReminderLevel.ESCALATED) {
      if (milestone.backupOwnerUserId) recipients.push({ userId: milestone.backupOwnerUserId, isEscalation: true })
      const leads = await prisma.user.findMany({
        where: { consultingFirmId: milestone.consultingFirmId, role: 'ADMIN', isActive: true },
        select: { id: true },
        take: 5,
      })
      for (const lead of leads) {
        if (!recipients.some((r) => r.userId === lead.id)) recipients.push({ userId: lead.id, isEscalation: true })
      }
    } else if (!milestone.ownerUserId && milestone.backupOwnerUserId) {
      // No owner — the backup carries it.
      recipients.push({ userId: milestone.backupOwnerUserId, isEscalation: false })
    }

    if (recipients.length === 0) { suppressed++; continue }

    for (const recipient of recipients) {
      const dedupeKey = buildReminderKey(milestone.id, recipient.userId, decision.level, 'IN_APP', now)
      try {
        // The ledger write is the dedupe gate: a unique-key clash means this
        // exact reminder already went out today, so nothing is sent.
        await prisma.milestoneReminderLog.create({
          data: {
            consultingFirmId: milestone.consultingFirmId,
            milestoneId: milestone.id,
            userId: recipient.userId,
            level: decision.level,
            channel: 'IN_APP',
            dedupeKey,
            isEscalation: recipient.isEscalation,
            escalatedToUserId: recipient.isEscalation ? recipient.userId : null,
            sentAt: now,
          },
        })
      } catch {
        suppressed++
        continue
      }

      try {
        await notifyUser({
          consultingFirmId: milestone.consultingFirmId,
          userId: recipient.userId,
          type: decision.level === ReminderLevel.ESCALATED ? NotificationType.MILESTONE_ESCALATION : NotificationType.MILESTONE_REMINDER,
          title: `${decision.level.replace('_', ' ')} · ${milestone.title}`,
          body: `${decision.reason}${recipient.isEscalation ? ' Escalated because the responsible owner has not completed it.' : ''}`,
          linkPath: `/opportunities/${milestone.opportunityId}`,
          entityType: 'OpportunityMilestone',
          entityId: milestone.id,
          dedupeKey,
        })
        remindersSent++
        if (recipient.isEscalation) escalations++
      } catch (err) {
        failures++
        logger.warn('Milestone reminder notification failed', { milestoneId: milestone.id, userId: recipient.userId, error: (err as Error).message })
      }
    }

    // Mark a passed, incomplete milestone as MISSED so the timeline is honest.
    if (milestone.endAt < now && milestone.status !== MilestoneStatus.MISSED) {
      await prisma.opportunityMilestone.update({ where: { id: milestone.id }, data: { status: MilestoneStatus.MISSED } })
    } else if (decision.level === ReminderLevel.URGENT && milestone.status === MilestoneStatus.PLANNED) {
      await prisma.opportunityMilestone.update({ where: { id: milestone.id }, data: { status: MilestoneStatus.AT_RISK } })
    }
  }

  return { scanned: milestones.length, remindersSent, escalations, suppressed, failures }
}

export async function acknowledgeReminder(consultingFirmId: string, reminderId: string, userId: string, now: Date = new Date()) {
  const log = await prisma.milestoneReminderLog.findFirst({ where: { id: reminderId, consultingFirmId }, select: { id: true } })
  if (!log) throw new Error('Reminder not found')
  return prisma.milestoneReminderLog.update({
    where: { id: log.id },
    data: { acknowledgedAt: now, acknowledgedByUserId: userId },
  })
}

export async function snoozeReminder(consultingFirmId: string, reminderId: string, until: Date) {
  const log = await prisma.milestoneReminderLog.findFirst({ where: { id: reminderId, consultingFirmId }, select: { id: true } })
  if (!log) throw new Error('Reminder not found')
  return prisma.milestoneReminderLog.update({ where: { id: log.id }, data: { snoozedUntil: until } })
}
