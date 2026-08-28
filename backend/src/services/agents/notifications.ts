// =============================================================
// §7.0 — Agent notification routing.
//
// Deliberately NOT a second notification feed. Everything funnels into the
// existing UserNotification store via notifyUser(), which already solves
// idempotency with a unique dedupeKey and never throws.
//
// AgentNotificationPreference decides WHO hears about WHAT. Absent a row, a
// conservative default applies: failures and escalations notify, routine
// successes do not — nine agents notifying every success would be unusable.
// =============================================================
import type { AgentEscalationSeverity, AgentKey, AgentNotificationPreference } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { notifyUser } from '../notificationService'
import { SEVERITY_RANK } from './escalations'

/** Applied when a user has no explicit row for this agent. */
export const DEFAULT_AGENT_NOTIFICATION_PREFERENCE = {
  inAppEnabled: true,
  emailEnabled: false,
  minimumSeverity: 'MEDIUM' as AgentEscalationSeverity,
  notifyOnSuccess: false,
  notifyOnFailure: true,
  notifyOnEscalation: true,
  digestMode: false,
}

export type AgentNotificationKind = 'SUCCESS' | 'FAILURE' | 'ESCALATION'

type Preference = Pick<
  AgentNotificationPreference,
  'inAppEnabled' | 'emailEnabled' | 'minimumSeverity' | 'notifyOnSuccess' | 'notifyOnFailure' | 'notifyOnEscalation' | 'digestMode'
>

export async function resolvePreference(userId: string, agentKey: AgentKey): Promise<Preference> {
  const row = await prisma.agentNotificationPreference.findUnique({
    where: { userId_agentKey: { userId, agentKey } },
  })
  return row ?? DEFAULT_AGENT_NOTIFICATION_PREFERENCE
}

/** True when this user wants this kind of notification at this severity. */
export function shouldNotify(pref: Preference, kind: AgentNotificationKind, severity?: AgentEscalationSeverity): boolean {
  if (!pref.inAppEnabled) return false
  if (kind === 'SUCCESS') return pref.notifyOnSuccess
  if (kind === 'FAILURE') return pref.notifyOnFailure
  if (!pref.notifyOnEscalation) return false
  if (!severity) return true
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[pref.minimumSeverity]
}

/**
 * Recipients for an agent notification: ADMINs of the tenant, plus any
 * explicitly assigned user. Consultants are not notified by default because
 * they cannot act on agent configuration.
 */
async function resolveRecipients(consultingFirmId: string, assignedToUserId?: string | null): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { consultingFirmId, role: 'ADMIN', isActive: true },
    select: { id: true },
  })
  const ids = new Set(admins.map((a) => a.id))
  if (assignedToUserId) ids.add(assignedToUserId)
  return [...ids]
}

export interface AgentNotifyArgs {
  consultingFirmId: string
  agentKey: AgentKey
  runId: string
  kind: AgentNotificationKind
  title: string
  body?: string
  severity?: AgentEscalationSeverity
  escalationId?: string
  assignedToUserId?: string | null
}

/**
 * Fans out one agent notification. Every write carries a stable dedupeKey so a
 * BullMQ retry of the same run cannot produce a second copy.
 */
export async function notifyAgentOutcome(args: AgentNotifyArgs): Promise<{ notified: number; suppressed: number }> {
  let notified = 0
  let suppressed = 0

  try {
    const recipients = await resolveRecipients(args.consultingFirmId, args.assignedToUserId)

    for (const userId of recipients) {
      const pref = await resolvePreference(userId, args.agentKey)
      if (!shouldNotify(pref, args.kind, args.severity)) {
        suppressed++
        continue
      }

      const type =
        args.kind === 'ESCALATION'
          ? 'AGENT_ESCALATION'
          : args.kind === 'FAILURE'
            ? 'AGENT_RUN_FAILED'
            : 'AGENT_RUN_COMPLETED'

      // Escalation notifications key on the escalation so a refreshed escalation
      // does not re-notify; run notifications key on the run.
      const dedupeKey = args.escalationId
        ? `agent:${args.agentKey}:escalation:${args.escalationId}:${userId}`
        : `agent:${args.agentKey}:run:${args.runId}:${args.kind}:${userId}`

      const linkPath = args.escalationId
        ? `/agents/escalations?focus=${args.escalationId}`
        : `/agents/runs/${args.runId}`

      await notifyUser({
        consultingFirmId: args.consultingFirmId,
        userId,
        type,
        title: args.title,
        body: args.body,
        linkPath,
        entityType: args.escalationId ? 'AgentEscalation' : 'AgentRun',
        entityId: args.escalationId ?? args.runId,
        dedupeKey,
      })
      notified++
    }
  } catch (err) {
    // A notification failure must never change a run's outcome.
    logger.error('Agent notification fan-out failed', { runId: args.runId, error: (err as Error).message })
  }

  return { notified, suppressed }
}
