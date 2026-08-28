// =============================================================
// §6.1G — Saved-profile evaluation and alerting.
//
// Extends the EXISTING SavedMonitoringProfile (§5.1 Stage 1). There is no
// second profile system: the same stored filters still replay through the same
// buildOpportunityWhere, so what a profile alerts on is exactly what its search
// returns.
//
// Alert discipline:
//  - One MonitoringProfileAlert row per (profile, record), ever — the dedupe
//    key is unique, so a repeat evaluation cannot spam.
//  - A record already alerted is re-alerted ONLY when its content fingerprint
//    changes materially (deadline, amendment, value, set-aside, status,
//    eligibility) or its priority rises. Cosmetic churn never re-alerts.
//  - In-app notification is always available. Email is attempted only when mail
//    is actually configured, and never blocks the in-app write.
//  - DAILY/WEEKLY profiles group their hits into one digest notification rather
//    than one notification per record.
// =============================================================
import { createHash } from 'crypto'
import { MonitoringAlertFrequency, NotificationType, Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { notifyUser } from '../notificationService'
import { buildOpportunityWhere } from '../opportunityFilters'

export const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const
export type AlertPriority = (typeof PRIORITIES)[number]

export function priorityRank(p: string): number {
  const i = (PRIORITIES as readonly string[]).indexOf(p)
  return i === -1 ? 1 : i
}

/** Fields whose change justifies alerting on a record a second time. */
export interface FingerprintInput {
  responseDeadline: Date | null
  status: string
  setAsideType: string
  estimatedValue: unknown
  amendmentCount: number
  sourceUpdatedAt: Date | null
  eligibility: string | null
}

/**
 * Stable fingerprint of the fields that make a record MATERIALLY different.
 * Title wording, description enrichment and score drift are deliberately
 * excluded so they cannot trigger a second alert.
 */
export function contentFingerprint(input: FingerprintInput): string {
  const payload = [
    input.responseDeadline ? input.responseDeadline.toISOString() : 'no-deadline',
    input.status,
    input.setAsideType,
    input.estimatedValue === null || input.estimatedValue === undefined ? 'no-value' : String(input.estimatedValue),
    `amendments:${input.amendmentCount}`,
    input.sourceUpdatedAt ? input.sourceUpdatedAt.toISOString() : 'no-source-update',
    input.eligibility ?? 'no-eligibility',
  ].join('|')
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}

export function buildDedupeKey(profileId: string, recordType: 'opportunity' | 'forecast', recordId: string): string {
  return `monitoring:${profileId}:${recordType}:${recordId}`
}

/** Next evaluation instant for a frequency. DISABLED profiles never schedule. */
export function nextEvaluationAt(frequency: MonitoringAlertFrequency, from: Date): Date | null {
  switch (frequency) {
    case MonitoringAlertFrequency.INSTANT: return new Date(from.getTime() + 15 * 60_000)
    case MonitoringAlertFrequency.DAILY: return new Date(from.getTime() + 24 * 3600_000)
    case MonitoringAlertFrequency.WEEKLY: return new Date(from.getTime() + 7 * 24 * 3600_000)
    case MonitoringAlertFrequency.DISABLED: return null
    default: return null
  }
}

export interface ProfileHit {
  opportunityId: string
  title: string
  agency: string
  responseDeadline: Date
  fingerprint: string
  priority: AlertPriority
  eligibility: string | null
  matchScore: number | null
  isNew: boolean
  changeReason: string | null
}

/**
 * Derive an alert priority from the record itself: eligibility, match strength
 * and deadline pressure. The profile's own priority is the floor.
 */
export function derivePriority(
  profilePriority: string,
  eligibility: string | null,
  matchScore: number | null,
  daysToDeadline: number,
): AlertPriority {
  let rank = priorityRank(profilePriority)
  if (eligibility === 'ELIGIBLE') rank += 1
  if (eligibility === 'NOT_ELIGIBLE') rank -= 1
  if (matchScore !== null && matchScore >= 75) rank += 1
  if (daysToDeadline <= 7) rank += 1
  if (daysToDeadline <= 3) rank += 1
  return PRIORITIES[Math.max(0, Math.min(PRIORITIES.length - 1, rank))]
}

export interface EvaluateOptions {
  now?: Date
  /** Cap on records considered per evaluation. */
  limit?: number
}

export interface EvaluateResult {
  profileId: string
  matched: number
  newAlerts: number
  reAlerts: number
  suppressed: number
  notificationsSent: number
  skippedReason?: string
}

/**
 * Evaluate one profile: run its filters, decide which hits warrant an alert,
 * write the in-app notification(s), and update the profile's evaluation stamps.
 */
export async function evaluateProfile(
  profileId: string,
  options: EvaluateOptions = {},
): Promise<EvaluateResult> {
  const now = options.now ?? new Date()
  const limit = options.limit ?? 100

  const profile = await prisma.savedMonitoringProfile.findUnique({ where: { id: profileId } })
  if (!profile) throw new Error('Monitoring profile not found')

  const base: EvaluateResult = { profileId, matched: 0, newAlerts: 0, reAlerts: 0, suppressed: 0, notificationsSent: 0 }

  if (!profile.isActive || profile.isArchived || profile.alertFrequency === MonitoringAlertFrequency.DISABLED) {
    await prisma.savedMonitoringProfile.update({
      where: { id: profile.id },
      data: { lastEvaluatedAt: now, nextEvaluationAt: nextEvaluationAt(profile.alertFrequency, now) },
    })
    return { ...base, skippedReason: 'Profile is inactive, archived, or has alerts disabled.' }
  }

  // A profile with no owner has nobody to notify — recorded, not guessed at.
  const recipientUserId = profile.ownerUserId ?? profile.createdByUserId
  if (!recipientUserId) {
    await prisma.savedMonitoringProfile.update({
      where: { id: profile.id },
      data: { lastEvaluatedAt: now, nextEvaluationAt: nextEvaluationAt(profile.alertFrequency, now) },
    })
    return { ...base, skippedReason: 'Profile has no owner, so there is no recipient for its alerts.' }
  }

  // Replay the SAME filters the live search uses. Set-aside filtering is left
  // enabled here because the profile was validated when it was saved.
  const filters = (profile.filters ?? {}) as Record<string, unknown>
  const where = buildOpportunityWhere(filters, {
    consultingFirmId: profile.consultingFirmId,
    allowSetAside: true,
    now,
  })

  const opportunities = await prisma.opportunity.findMany({
    where,
    select: {
      id: true, title: true, agency: true, responseDeadline: true, status: true,
      setAsideType: true, estimatedValue: true, sourceUpdatedAt: true,
      match: { select: { overallScore: true, eligibility: true } },
      _count: { select: { amendments: true } },
    },
    orderBy: { responseDeadline: 'asc' },
    take: limit,
  })

  const hits: ProfileHit[] = []
  let suppressed = 0

  for (const opp of opportunities) {
    const fingerprint = contentFingerprint({
      responseDeadline: opp.responseDeadline,
      status: opp.status,
      setAsideType: opp.setAsideType,
      estimatedValue: opp.estimatedValue,
      amendmentCount: opp._count.amendments,
      sourceUpdatedAt: opp.sourceUpdatedAt,
      eligibility: opp.match?.eligibility ?? null,
    })

    const daysToDeadline = Math.max(0, Math.floor((opp.responseDeadline.getTime() - now.getTime()) / 86400000))
    const priority = derivePriority(profile.priority, opp.match?.eligibility ?? null, opp.match?.overallScore ?? null, daysToDeadline)

    const dedupeKey = buildDedupeKey(profile.id, 'opportunity', opp.id)
    const existing = await prisma.monitoringProfileAlert.findUnique({ where: { dedupeKey } })

    if (!existing) {
      hits.push({
        opportunityId: opp.id, title: opp.title, agency: opp.agency,
        responseDeadline: opp.responseDeadline, fingerprint, priority,
        eligibility: opp.match?.eligibility ?? null, matchScore: opp.match?.overallScore ?? null,
        isNew: true, changeReason: null,
      })
      continue
    }

    // Already alerted. Re-alert only on a material change or a priority rise.
    const fingerprintChanged = existing.contentFingerprint !== fingerprint
    const priorityRose = priorityRank(priority) > priorityRank(existing.priority)
    if (!fingerprintChanged && !priorityRose) { suppressed++; continue }

    hits.push({
      opportunityId: opp.id, title: opp.title, agency: opp.agency,
      responseDeadline: opp.responseDeadline, fingerprint, priority,
      eligibility: opp.match?.eligibility ?? null, matchScore: opp.match?.overallScore ?? null,
      isNew: false,
      changeReason: fingerprintChanged
        ? 'The notice changed materially (deadline, amendment, value, set-aside, status or eligibility).'
        : `Priority rose from ${existing.priority} to ${priority}.`,
    })
  }

  // Persist the alert ledger before notifying, so a notification failure can
  // never cause the same record to be alerted twice.
  for (const hit of hits) {
    const dedupeKey = buildDedupeKey(profile.id, 'opportunity', hit.opportunityId)
    await prisma.monitoringProfileAlert.upsert({
      where: { dedupeKey },
      create: {
        consultingFirmId: profile.consultingFirmId,
        profileId: profile.id,
        userId: recipientUserId,
        opportunityId: hit.opportunityId,
        dedupeKey,
        contentFingerprint: hit.fingerprint,
        priority: hit.priority,
        channel: profile.alertEmail ? 'EMAIL' : 'IN_APP',
        reason: hit.changeReason,
        firstSentAt: now,
        lastSentAt: now,
      },
      update: {
        contentFingerprint: hit.fingerprint,
        priority: hit.priority,
        reason: hit.changeReason,
        alertCount: { increment: 1 },
        lastSentAt: now,
      },
    })
  }

  let notificationsSent = 0
  if (hits.length > 0) {
    if (profile.alertFrequency === MonitoringAlertFrequency.INSTANT) {
      // One notification per record, each with a working deep link.
      for (const hit of hits) {
        await notifyUser({
          consultingFirmId: profile.consultingFirmId,
          userId: recipientUserId,
          type: NotificationType.OPPORTUNITY_ALERT,
          title: `${hit.priority} · ${hit.title}`,
          body: `${hit.agency} · responds ${hit.responseDeadline.toISOString().slice(0, 10)}${hit.changeReason ? ` · ${hit.changeReason}` : ''} (profile: ${profile.name})`,
          linkPath: `/opportunities/${hit.opportunityId}`,
          entityType: 'Opportunity',
          entityId: hit.opportunityId,
          // Fingerprint in the key so an unchanged record can never notify twice.
          dedupeKey: `profile-alert:${profile.id}:${hit.opportunityId}:${hit.fingerprint}`,
        })
        notificationsSent++
      }
    } else {
      // DAILY / WEEKLY — a single grouped digest.
      const top = hits.slice(0, 5).map((h) => `• ${h.title} (${h.agency}, due ${h.responseDeadline.toISOString().slice(0, 10)})`).join('\n')
      const digestBucket = profile.alertFrequency === MonitoringAlertFrequency.DAILY
        ? now.toISOString().slice(0, 10)
        : `${now.getUTCFullYear()}-W${Math.ceil((now.getUTCDate() + 6) / 7)}-${now.getUTCMonth()}`
      await notifyUser({
        consultingFirmId: profile.consultingFirmId,
        userId: recipientUserId,
        type: NotificationType.OPPORTUNITY_ALERT,
        title: `${hits.length} update(s) for "${profile.name}"`,
        body: `${top}${hits.length > 5 ? `\n…and ${hits.length - 5} more.` : ''}`,
        linkPath: `/opportunities?profileId=${profile.id}`,
        entityType: 'SavedMonitoringProfile',
        entityId: profile.id,
        dedupeKey: `profile-digest:${profile.id}:${digestBucket}`,
      })
      notificationsSent++
    }
  }

  await prisma.savedMonitoringProfile.update({
    where: { id: profile.id },
    data: {
      lastEvaluatedAt: now,
      nextEvaluationAt: nextEvaluationAt(profile.alertFrequency, now),
      lastResultCount: opportunities.length,
      lastAlertCount: hits.length,
      ...(hits.length > 0 ? { lastAlertSentAt: now } : {}),
    },
  })

  return {
    profileId: profile.id,
    matched: opportunities.length,
    newAlerts: hits.filter((h) => h.isNew).length,
    reAlerts: hits.filter((h) => !h.isNew).length,
    suppressed,
    notificationsSent,
  }
}

/**
 * Evaluate every profile that is due. Safe to run on a schedule: due-ness is
 * driven by nextEvaluationAt, and per-profile failure never aborts the batch.
 */
export async function evaluateDueProfiles(
  options: { now?: Date; batchSize?: number } = {},
): Promise<{ evaluated: number; totalNewAlerts: number; totalReAlerts: number; failures: number }> {
  const now = options.now ?? new Date()
  const batchSize = options.batchSize ?? 50

  const due = await prisma.savedMonitoringProfile.findMany({
    where: {
      isActive: true,
      isArchived: false,
      alertFrequency: { not: MonitoringAlertFrequency.DISABLED },
      OR: [{ nextEvaluationAt: null }, { nextEvaluationAt: { lte: now } }],
    },
    select: { id: true },
    orderBy: { nextEvaluationAt: 'asc' },
    take: batchSize,
  })

  let totalNewAlerts = 0
  let totalReAlerts = 0
  let failures = 0

  for (const { id } of due) {
    try {
      const result = await evaluateProfile(id, { now })
      totalNewAlerts += result.newAlerts
      totalReAlerts += result.reAlerts
    } catch (err) {
      failures++
      logger.error('Monitoring profile evaluation failed', { profileId: id, error: (err as Error).message })
    }
  }

  return { evaluated: due.length, totalNewAlerts, totalReAlerts, failures }
}

/** Visibility check used by the routes — enforced on the backend, not in the UI. */
export function canAccessProfile(
  profile: { ownerUserId: string | null; createdByUserId: string | null; visibility: string },
  user: { userId: string; role: string },
): boolean {
  if (profile.visibility !== 'PRIVATE') return true
  if (user.role === 'ADMIN') return true
  return profile.ownerUserId === user.userId || profile.createdByUserId === user.userId
}

/**
 * Write permission. A CONSULTANT owns their own profiles — the §6.1G
 * requirement — while firm-visible profiles they do not own stay ADMIN-managed.
 */
export function canMutateProfile(
  profile: { ownerUserId: string | null; createdByUserId: string | null; visibility: string },
  user: { userId: string; role: string },
): boolean {
  if (user.role === 'ADMIN') return true
  return profile.ownerUserId === user.userId || (profile.ownerUserId === null && profile.createdByUserId === user.userId)
}

export type ProfileFiltersJson = Prisma.InputJsonValue
