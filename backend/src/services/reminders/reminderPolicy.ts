// =============================================================
// §7.1 — Shared deterministic reminder policy.
//
// Extracted from `milestones/reminderEngine` (§6.4D) so any dated, owned,
// status-aware, tenant-scoped entity can reuse the SAME escalation ladder
// instead of growing a second severity vocabulary. The §7 plan calls for this
// generalisation to happen once, here, so the later Compliance and Finance
// agents inherit it.
//
// BEHAVIOUR-PRESERVING: `decideLevel` is moved verbatim — same thresholds, same
// reason strings, same `ReminderLevel` enum. `milestones/reminderEngine`
// re-exports it and keeps producing byte-identical dedupe keys, so every §6.4
// milestone reminder behaves exactly as before.
//
// Nothing here touches the database. The ladder is pure and clock-injected.
// =============================================================
import { ReminderLevel } from '@prisma/client'

/** Hours past due before escalation goes beyond the owner. */
export const DEFAULT_ESCALATION_HOURS = 24

export interface LevelDecision {
  level: ReminderLevel
  reason: string
}

/**
 * Decide the reminder level for a dated item. Pure and deterministic.
 * `leadDays` is the item's own reminder policy, evaluated ascending.
 *
 * Moved verbatim from §6.4D. Do not change the thresholds without re-running
 * the milestone reminder suite — they are shared by two agents now.
 */
export function decideLevel(
  dueAt: Date,
  now: Date,
  leadDays: number[],
  escalateAfterHours: number = DEFAULT_ESCALATION_HOURS,
): LevelDecision | null {
  const msUntil = dueAt.getTime() - now.getTime()
  const hoursUntil = msUntil / 3600_000
  const daysUntil = msUntil / 86400_000

  if (hoursUntil < 0) {
    const hoursOverdue = Math.abs(hoursUntil)
    if (hoursOverdue >= escalateAfterHours) {
      return { level: ReminderLevel.ESCALATED, reason: `Overdue by ${Math.floor(hoursOverdue)} hours, past the ${escalateAfterHours}-hour escalation threshold.` }
    }
    return { level: ReminderLevel.OVERDUE, reason: `Overdue by ${Math.floor(hoursOverdue)} hours.` }
  }

  if (hoursUntil <= 24) return { level: ReminderLevel.URGENT, reason: `Due in ${Math.max(0, Math.floor(hoursUntil))} hours.` }
  if (daysUntil <= 3) return { level: ReminderLevel.DUE_SOON, reason: `Due in ${Math.floor(daysUntil)} day(s).` }

  // Beyond three days, fire only on the configured lead days.
  const sorted = [...leadDays].sort((a, b) => a - b)
  const hit = sorted.find((d) => daysUntil <= d)
  if (hit === undefined) return null
  if (hit <= 7) return { level: ReminderLevel.UPCOMING, reason: `Due in ${Math.floor(daysUntil)} day(s) (${hit}-day reminder).` }
  return { level: ReminderLevel.INFORMATIONAL, reason: `Due in ${Math.floor(daysUntil)} day(s) (${hit}-day reminder).` }
}

/** Levels at which recipients widen beyond the owner. */
export function isEscalationLevel(level: ReminderLevel): boolean {
  return level === ReminderLevel.ESCALATED
}

/**
 * One reminder per (prefix, entity, user, level, channel, day) — the anti-spam
 * guarantee. The prefix keeps each domain's keys in their own namespace so a
 * deliverable and a milestone can never collide.
 */
export function buildReminderDedupeKey(args: {
  prefix: string
  entityId: string
  userId: string
  level: ReminderLevel
  channel: string
  now: Date
}): string {
  return `${args.prefix}:${args.entityId}:${args.userId}:${args.level}:${args.channel}:${args.now.toISOString().slice(0, 10)}`
}

/**
 * The generic shape any domain adapts its rows into. Deliberately an ADAPTER
 * contract rather than a schema requirement — no existing model changes shape
 * to satisfy it (§7.1 brief: prefer adapters over schema duplication).
 */
export interface ReminderTarget {
  entityType: string
  entityId: string
  consultingFirmId: string
  title: string
  dueAt: Date
  ownerUserId: string | null
  reviewerUserId: string | null
  /** Domain status, already normalised by the adapter. */
  status: string
  /** True when the item no longer needs action — suppresses all reminders. */
  isComplete: boolean
  lastReminderAt: Date | null
  lastEscalationAt: Date | null
  /** Deep link for the notification. */
  linkPath: string
  reminderLeadDays: number[]
  escalateAfterHours: number
}

export type ReminderRecipientRole = 'OWNER' | 'REVIEWER' | 'ADMIN'

export interface ReminderRecipient {
  userId: string
  role: ReminderRecipientRole
  isEscalation: boolean
}

/**
 * Deterministic recipient ladder: owner → reviewer → firm ADMINs.
 *
 * Below escalation only the owner is contacted (falling back to the reviewer
 * when there is no owner). At ESCALATED the reviewer and firm admins are added,
 * which is the contract-deliverable equivalent of the milestone
 * owner → backup → team-lead ladder.
 */
export function resolveReminderRecipients(
  target: Pick<ReminderTarget, 'ownerUserId' | 'reviewerUserId'>,
  level: ReminderLevel,
  adminUserIds: string[],
): ReminderRecipient[] {
  const recipients: ReminderRecipient[] = []
  const add = (userId: string | null, role: ReminderRecipientRole, isEscalation: boolean) => {
    if (!userId) return
    if (recipients.some((r) => r.userId === userId)) return
    recipients.push({ userId, role, isEscalation })
  }

  add(target.ownerUserId, 'OWNER', false)

  if (isEscalationLevel(level)) {
    add(target.reviewerUserId, 'REVIEWER', true)
    for (const id of adminUserIds) add(id, 'ADMIN', true)
  } else if (!target.ownerUserId) {
    // Nobody owns it — the reviewer carries it rather than it going unnoticed.
    add(target.reviewerUserId, 'REVIEWER', false)
  }

  return recipients
}
