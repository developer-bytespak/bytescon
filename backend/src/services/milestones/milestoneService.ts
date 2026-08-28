// =============================================================
// §6.4A — The connected milestone timeline.
//
// ONE timeline per opportunity, assembled from the records that already own
// each date rather than duplicating them:
//   Opportunity.responseDeadline · ProposalSubmission deadlines · GateReview ·
//   Contract option dates · Certification / insurance expiry ·
//   extraction-derived solicitation milestones · generated schedule phases.
//
// Synchronised (not copied) dates are written as OpportunityMilestone rows with
// origin = SYSTEM and are refreshed in place, so the timeline always agrees with
// its source record and never drifts.
// =============================================================
import { MilestoneOrigin, MilestoneStatus, MilestoneType, Prisma } from '@prisma/client'
import { prisma } from '../../config/database'

export interface TimelineItem {
  id: string
  milestoneType: MilestoneType
  title: string
  description: string | null
  startAt: Date | null
  endAt: Date | null
  isAllDay: boolean
  timeZone: string
  origin: MilestoneOrigin
  sourceEvidence: string | null
  sourceSection: string | null
  sourcePage: number | null
  isMandatory: boolean
  isInternal: boolean
  status: MilestoneStatus
  priority: string
  ownerUserId: string | null
  backupOwnerUserId: string | null
  participantUserIds: string[]
  dependsOnMilestoneId: string | null
  isLocked: boolean
  lockReason: string | null
  reminderLeadDays: number[]
  remindersEnabled: boolean
  calendarSyncState: string
  amendmentImpact: string | null
  completedAt: Date | null
  /** Derived, not stored — always computed against "now". */
  derived: {
    isOverdue: boolean
    isAtRisk: boolean
    daysRemaining: number | null
    bucket: 'UPCOMING' | 'OVERDUE' | 'AT_RISK' | 'COMPLETED' | 'AMENDMENT_CHANGED' | 'UNSCHEDULED'
  }
}

export interface Timeline {
  items: TimelineItem[]
  buckets: {
    upcoming: TimelineItem[]
    overdue: TimelineItem[]
    atRisk: TimelineItem[]
    completed: TimelineItem[]
    amendmentChanged: TimelineItem[]
    unscheduled: TimelineItem[]
  }
  counts: Record<string, number>
  earliest: Date | null
  latest: Date | null
}

const AT_RISK_DAYS = 3

function deriveBucket(m: {
  endAt: Date | null
  status: MilestoneStatus
  amendmentImpact: string | null
}, now: Date): TimelineItem['derived'] {
  if (m.status === MilestoneStatus.COMPLETE) {
    return { isOverdue: false, isAtRisk: false, daysRemaining: null, bucket: 'COMPLETED' }
  }
  if (m.amendmentImpact && m.amendmentImpact !== 'UNCHANGED') {
    return { isOverdue: false, isAtRisk: true, daysRemaining: null, bucket: 'AMENDMENT_CHANGED' }
  }
  if (!m.endAt) {
    // A milestone with no date is reported as unscheduled, not as on-track.
    return { isOverdue: false, isAtRisk: false, daysRemaining: null, bucket: 'UNSCHEDULED' }
  }
  const days = Math.ceil((m.endAt.getTime() - now.getTime()) / 86400000)
  if (days < 0 || m.status === MilestoneStatus.MISSED) {
    return { isOverdue: true, isAtRisk: false, daysRemaining: days, bucket: 'OVERDUE' }
  }
  if (days <= AT_RISK_DAYS || m.status === MilestoneStatus.AT_RISK) {
    return { isOverdue: false, isAtRisk: true, daysRemaining: days, bucket: 'AT_RISK' }
  }
  return { isOverdue: false, isAtRisk: false, daysRemaining: days, bucket: 'UPCOMING' }
}

export async function getTimeline(
  consultingFirmId: string,
  opportunityId: string,
  now: Date = new Date(),
): Promise<Timeline> {
  const milestones = await prisma.opportunityMilestone.findMany({
    where: { consultingFirmId, opportunityId },
    orderBy: [{ endAt: 'asc' }, { createdAt: 'asc' }],
  })

  const items: TimelineItem[] = milestones.map((m) => ({
    id: m.id,
    milestoneType: m.milestoneType,
    title: m.title,
    description: m.description,
    startAt: m.startAt,
    endAt: m.endAt,
    isAllDay: m.isAllDay,
    timeZone: m.timeZone,
    origin: m.origin,
    sourceEvidence: m.sourceEvidence,
    sourceSection: m.sourceSection,
    sourcePage: m.sourcePage,
    isMandatory: m.isMandatory,
    isInternal: m.isInternal,
    status: m.status,
    priority: m.priority,
    ownerUserId: m.ownerUserId,
    backupOwnerUserId: m.backupOwnerUserId,
    participantUserIds: m.participantUserIds,
    dependsOnMilestoneId: m.dependsOnMilestoneId,
    isLocked: m.isLocked,
    lockReason: m.lockReason,
    reminderLeadDays: m.reminderLeadDays,
    remindersEnabled: m.remindersEnabled,
    calendarSyncState: m.calendarSyncState,
    amendmentImpact: m.amendmentImpact,
    completedAt: m.completedAt,
    derived: deriveBucket(m, now),
  }))

  const dated = items.filter((i) => i.endAt !== null).map((i) => i.endAt as Date)

  return {
    items,
    buckets: {
      upcoming: items.filter((i) => i.derived.bucket === 'UPCOMING'),
      overdue: items.filter((i) => i.derived.bucket === 'OVERDUE'),
      atRisk: items.filter((i) => i.derived.bucket === 'AT_RISK'),
      completed: items.filter((i) => i.derived.bucket === 'COMPLETED'),
      amendmentChanged: items.filter((i) => i.derived.bucket === 'AMENDMENT_CHANGED'),
      unscheduled: items.filter((i) => i.derived.bucket === 'UNSCHEDULED'),
    },
    counts: items.reduce((acc, i) => ({ ...acc, [i.derived.bucket]: (acc[i.derived.bucket] ?? 0) + 1 }), {} as Record<string, number>),
    earliest: dated.length > 0 ? new Date(Math.min(...dated.map((d) => d.getTime()))) : null,
    latest: dated.length > 0 ? new Date(Math.max(...dated.map((d) => d.getTime()))) : null,
  }
}

/**
 * Synchronise SYSTEM milestones from the records that own each date. Existing
 * rows are refreshed in place — a locked or completed milestone is never moved.
 */
export async function syncSystemMilestones(
  consultingFirmId: string,
  opportunityId: string,
  now: Date = new Date(),
): Promise<{ created: number; updated: number; preserved: number }> {
  const [opportunity, submission, gateReviews, contract] = await Promise.all([
    prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      select: { responseDeadline: true, title: true, presolicitationKind: true },
    }),
    prisma.proposalSubmission.findFirst({
      where: { consultingFirmId, opportunityId },
      select: { id: true, finalDeadline: true, internalDeadline: true, title: true },
    }),
    prisma.gateReview.findMany({
      where: { consultingFirmId, opportunityId },
      select: { id: true, name: true, dueDate: true, status: true },
    }),
    prisma.contract.findFirst({
      where: { consultingFirmId, opportunityId },
      select: { startDate: true, optionPeriods: { select: { label: true, exerciseDeadline: true } } },
    }),
  ])
  if (!opportunity) return { created: 0, updated: 0, preserved: 0 }

  interface Desired {
    milestoneType: MilestoneType
    title: string
    date: Date | null
    isMandatory: boolean
    isInternal: boolean
  }

  const desired: Desired[] = []

  // The notice's own response deadline is the anchor of the whole timeline.
  const responseType = opportunity.presolicitationKind === 'SOURCES_SOUGHT'
    ? MilestoneType.SOURCES_SOUGHT_DEADLINE
    : opportunity.presolicitationKind === 'RFI'
      ? MilestoneType.RFI_DEADLINE
      : MilestoneType.PROPOSAL_DEADLINE
  desired.push({
    milestoneType: responseType,
    title: opportunity.presolicitationKind ? 'Notice response deadline' : 'Proposal deadline',
    date: opportunity.responseDeadline,
    isMandatory: true,
    isInternal: false,
  })

  if (submission?.finalDeadline) {
    desired.push({ milestoneType: MilestoneType.SUBMISSION, title: 'Submission — final deadline', date: submission.finalDeadline, isMandatory: true, isInternal: false })
  }
  if (submission?.internalDeadline) {
    desired.push({ milestoneType: MilestoneType.READY_TO_SUBMIT, title: 'Submission — internal deadline', date: submission.internalDeadline, isMandatory: true, isInternal: true })
  }
  for (const review of gateReviews) {
    if (!review.dueDate) continue
    desired.push({ milestoneType: MilestoneType.GATE_REVIEW, title: `Gate review — ${review.name}`, date: review.dueDate, isMandatory: true, isInternal: true })
  }
  for (const option of contract?.optionPeriods ?? []) {
    if (!option.exerciseDeadline) continue
    desired.push({ milestoneType: MilestoneType.CUSTOM, title: `Option exercise decision — ${option.label}`, date: option.exerciseDeadline, isMandatory: true, isInternal: true })
  }

  const existing = await prisma.opportunityMilestone.findMany({
    where: { consultingFirmId, opportunityId, origin: MilestoneOrigin.SYSTEM },
    select: { id: true, milestoneType: true, title: true, isLocked: true, status: true, endAt: true },
  })

  let created = 0
  let updated = 0
  let preserved = 0

  for (const d of desired) {
    if (!d.date) continue
    const match = existing.find((e) => e.milestoneType === d.milestoneType && e.title === d.title)
    if (match) {
      if (match.isLocked || match.status === MilestoneStatus.COMPLETE) { preserved++; continue }
      if (match.endAt && match.endAt.getTime() === d.date.getTime()) continue
      await prisma.opportunityMilestone.update({
        where: { id: match.id },
        data: { startAt: d.date, endAt: d.date },
      })
      updated++
      continue
    }
    await prisma.opportunityMilestone.create({
      data: {
        consultingFirmId,
        opportunityId,
        milestoneType: d.milestoneType,
        title: d.title,
        startAt: d.date,
        endAt: d.date,
        isAllDay: false,
        origin: MilestoneOrigin.SYSTEM,
        isMandatory: d.isMandatory,
        isInternal: d.isInternal,
        status: d.date < now ? MilestoneStatus.MISSED : MilestoneStatus.PLANNED,
      },
    })
    created++
  }

  return { created, updated, preserved }
}

export interface MilestoneMutation {
  title?: string
  description?: string | null
  startAt?: Date | null
  endAt?: Date | null
  isAllDay?: boolean
  timeZone?: string
  status?: MilestoneStatus
  priority?: string
  ownerUserId?: string | null
  backupOwnerUserId?: string | null
  participantUserIds?: string[]
  dependsOnMilestoneId?: string | null
  isLocked?: boolean
  lockReason?: string | null
  reminderLeadDays?: number[]
  remindersEnabled?: boolean
  escalateAfterDueHours?: number
}

/** Update a milestone and record the change in its history. */
export async function updateMilestone(
  consultingFirmId: string,
  milestoneId: string,
  changes: MilestoneMutation,
  actorUserId: string | null,
  now: Date = new Date(),
) {
  const existing = await prisma.opportunityMilestone.findFirst({
    where: { id: milestoneId, consultingFirmId },
  })
  if (!existing) throw new Error('Milestone not found')

  const updated = await prisma.opportunityMilestone.update({
    where: { id: existing.id },
    data: {
      ...changes,
      ...(changes.status === MilestoneStatus.COMPLETE ? { completedAt: now } : {}),
      ...(changes.status && changes.status !== MilestoneStatus.COMPLETE ? { completedAt: null } : {}),
    },
  })

  const events: Prisma.MilestoneEventCreateManyInput[] = []
  if (changes.status && changes.status !== existing.status) {
    events.push({ consultingFirmId, milestoneId: existing.id, action: 'STATUS_CHANGE', fromValue: existing.status, toValue: changes.status, actorUserId })
  }
  if (changes.ownerUserId !== undefined && changes.ownerUserId !== existing.ownerUserId) {
    events.push({ consultingFirmId, milestoneId: existing.id, action: 'ASSIGN', fromValue: existing.ownerUserId, toValue: changes.ownerUserId, actorUserId })
  }
  if (changes.endAt !== undefined && changes.endAt?.getTime() !== existing.endAt?.getTime()) {
    events.push({
      consultingFirmId, milestoneId: existing.id, action: 'RESCHEDULE',
      fromValue: existing.endAt?.toISOString() ?? null, toValue: changes.endAt?.toISOString() ?? null, actorUserId,
    })
  }
  if (changes.isLocked !== undefined && changes.isLocked !== existing.isLocked) {
    events.push({ consultingFirmId, milestoneId: existing.id, action: changes.isLocked ? 'LOCK' : 'UNLOCK', fromValue: String(existing.isLocked), toValue: String(changes.isLocked), actorUserId, note: changes.lockReason ?? null })
  }
  if (events.length > 0) await prisma.milestoneEvent.createMany({ data: events })

  return updated
}

/**
 * Firm-wide calendar feed. Powers the calendar/list views and the ICS export.
 */
export async function getFirmCalendar(
  consultingFirmId: string,
  options: { from?: Date; to?: Date; ownerUserId?: string; limit?: number } = {},
) {
  return prisma.opportunityMilestone.findMany({
    where: {
      consultingFirmId,
      ...(options.ownerUserId ? { OR: [{ ownerUserId: options.ownerUserId }, { backupOwnerUserId: options.ownerUserId }, { participantUserIds: { has: options.ownerUserId } }] } : {}),
      ...(options.from || options.to
        ? { endAt: { ...(options.from ? { gte: options.from } : {}), ...(options.to ? { lte: options.to } : {}) } }
        : { endAt: { not: null } }),
    },
    select: {
      id: true, opportunityId: true, milestoneType: true, title: true, description: true,
      startAt: true, endAt: true, isAllDay: true, timeZone: true, status: true, priority: true,
      ownerUserId: true, isInternal: true, isMandatory: true,
      opportunity: { select: { title: true, agency: true } },
    },
    orderBy: { endAt: 'asc' },
    take: options.limit ?? 500,
  })
}

function icsEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

function icsDate(date: Date, allDay: boolean): string {
  if (allDay) return date.toISOString().slice(0, 10).replace(/-/g, '')
  return `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
}

/**
 * Standards-compliant ICS export. This is the calendar integration that needs
 * no third-party account — any calendar client can subscribe to the file.
 */
export function buildIcs(
  milestones: Array<{ id: string; title: string; description: string | null; startAt: Date | null; endAt: Date | null; isAllDay: boolean; opportunity?: { title: string; agency: string } | null }>,
  calendarName = 'Bytescon Milestones',
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Bytescon//Section 6 Milestones//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calendarName)}`,
  ]

  for (const m of milestones) {
    const start = m.startAt ?? m.endAt
    if (!start) continue
    const end = m.endAt ?? start
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${m.id}@bytescon`)
    lines.push(`DTSTAMP:${icsDate(new Date(), false)}`)
    if (m.isAllDay) {
      lines.push(`DTSTART;VALUE=DATE:${icsDate(start, true)}`)
      lines.push(`DTEND;VALUE=DATE:${icsDate(new Date(end.getTime() + 86400000), true)}`)
    } else {
      lines.push(`DTSTART:${icsDate(start, false)}`)
      lines.push(`DTEND:${icsDate(end, false)}`)
    }
    lines.push(`SUMMARY:${icsEscape(m.title)}`)
    const description = [m.description, m.opportunity ? `${m.opportunity.title} — ${m.opportunity.agency}` : null].filter(Boolean).join('\n')
    if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`)
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  // RFC 5545 requires CRLF line endings.
  return lines.join('\r\n')
}
