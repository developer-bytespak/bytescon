// =============================================================
// §8.1 — CRM follow-up reminders.
//
// This is NOT a second reminder framework. It is a scan function called by the
// EXISTING hourly milestone-reminders job in workers/section6Worker.ts, and it
// delivers through the EXISTING notificationService.
//
// Dedupe is the notification service's own dedupeKey, keyed per follow-up, per
// user, per calendar day — so an hourly job cannot produce hourly spam, and a
// failed send cannot cause a duplicate on the retry.
// =============================================================
import { CrmFollowUpStatus, NotificationType } from '@prisma/client'
import { prisma } from '../../config/database'
import { notifyUser } from '../notificationService'
import { logger } from '../../utils/logger'

/** A follow-up is surfaced this many days before it falls due. */
export const DUE_SOON_DAYS = 2

export interface FollowUpScanResult {
  scanned: number
  notified: number
  suppressed: number
}

function dayStamp(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Notify owners of follow-ups that are due soon or already overdue.
 *
 * Suppressed, deliberately: follow-ups with no owner (nobody to tell), and
 * anything already DONE or CANCELLED.
 */
export async function notifyDueFollowUps(now: Date = new Date()): Promise<FollowUpScanResult> {
  const horizon = new Date(now.getTime() + DUE_SOON_DAYS * 86_400_000)

  const due = await prisma.crmFollowUp.findMany({
    where: {
      status: { in: [CrmFollowUpStatus.OPEN, CrmFollowUpStatus.IN_PROGRESS] },
      dueAt: { lte: horizon },
    },
    select: {
      id: true,
      consultingFirmId: true,
      title: true,
      dueAt: true,
      ownerUserId: true,
      governmentContact: { select: { fullName: true } },
      partner: { select: { name: true } },
    },
    take: 1000,
  })

  let notified = 0
  let suppressed = 0

  for (const f of due) {
    if (!f.ownerUserId) {
      suppressed++
      continue
    }
    const overdue = f.dueAt.getTime() < now.getTime()
    const who = f.governmentContact?.fullName ?? f.partner?.name ?? null
    try {
      await notifyUser({
        consultingFirmId: f.consultingFirmId,
        userId: f.ownerUserId,
        type: NotificationType.CRM_FOLLOW_UP,
        title: overdue ? `Overdue follow-up: ${f.title}` : `Follow-up due: ${f.title}`,
        body: who
          ? `${who} — due ${f.dueAt.toISOString().slice(0, 10)}.`
          : `Due ${f.dueAt.toISOString().slice(0, 10)}.`,
        linkPath: '/crm?tab=follow-ups',
        // One notification per follow-up, per user, per day.
        dedupeKey: `crm-followup:${f.id}:${f.ownerUserId}:${dayStamp(now)}`,
      })
      notified++
    } catch (err) {
      // One firm's failure never aborts the batch.
      logger.warn('CRM follow-up reminder failed', { followUpId: f.id, error: (err as Error).message })
      suppressed++
    }
  }

  return { scanned: due.length, notified, suppressed }
}
