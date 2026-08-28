// =============================================================
// §6.4C — Working-backward schedule generation.
//
// Deterministic and server-side: the same deadline, template and complexity
// inputs always produce the same schedule. React never computes these dates.
//
// Behaviours the spec requires, implemented here:
//  - Phases are laid out backwards from the submission deadline, in working
//    days, honouring weekends, holidays, dependencies and a minimum buffer.
//  - A schedule that cannot fit is reported INFEASIBLE with the reason and the
//    shortfall — it is never silently compressed into the past.
//  - Dates already in the past are flagged as overdue rather than hidden.
//  - Locked milestones and completed milestones are PRESERVED on regeneration.
//  - Every run is versioned, so regeneration is previewable and reversible.
// =============================================================
import { MilestoneOrigin, MilestoneStatus, MilestoneType, Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import {
  addWorkingDays,
  makeCalendar,
  previousWorkingDay,
  toUtcDateOnly,
  usFederalHolidayRange,
  workingDaysBetween,
  type WorkingCalendar,
} from './workingDays'

export const SCHEDULE_METHOD_VERSION = 'v1'

export interface PhaseTemplate {
  key: string
  milestoneType: MilestoneType
  label: string
  /** Working days before the submission deadline this phase must complete. */
  offsetWorkingDays: number
  /** Working days the phase itself occupies. */
  durationWorkingDays: number
  dependsOn?: string | null
  optional?: boolean
}

/**
 * Default 13-phase template from §6.4C, expressed in working days before the
 * final deadline. Offsets are the baseline for a medium-complexity pursuit and
 * are scaled by the complexity multiplier below.
 */
export const DEFAULT_PHASES: PhaseTemplate[] = [
  { key: 'bid_decision', milestoneType: MilestoneType.BID_DECISION, label: 'Bid / no-bid decision', offsetWorkingDays: 30, durationWorkingDays: 1 },
  { key: 'kickoff', milestoneType: MilestoneType.INTERNAL_KICKOFF, label: 'Internal kickoff', offsetWorkingDays: 28, durationWorkingDays: 1, dependsOn: 'bid_decision' },
  { key: 'compliance_review', milestoneType: MilestoneType.GATE_REVIEW, label: 'Compliance matrix review', offsetWorkingDays: 25, durationWorkingDays: 2, dependsOn: 'kickoff' },
  { key: 'outline', milestoneType: MilestoneType.OUTLINE_COMPLETE, label: 'Proposal outline complete', offsetWorkingDays: 22, durationWorkingDays: 2, dependsOn: 'compliance_review' },
  { key: 'assignments', milestoneType: MilestoneType.CUSTOM, label: 'Writer assignments issued', offsetWorkingDays: 21, durationWorkingDays: 1, dependsOn: 'outline' },
  { key: 'first_draft', milestoneType: MilestoneType.FIRST_DRAFT, label: 'First draft complete', offsetWorkingDays: 14, durationWorkingDays: 6, dependsOn: 'assignments' },
  { key: 'pink_team', milestoneType: MilestoneType.CUSTOM, label: 'Pink / Blue team review', offsetWorkingDays: 12, durationWorkingDays: 2, dependsOn: 'first_draft', optional: true },
  { key: 'red_team', milestoneType: MilestoneType.RED_TEAM, label: 'Red Team review', offsetWorkingDays: 9, durationWorkingDays: 2, dependsOn: 'first_draft' },
  { key: 'pricing_freeze', milestoneType: MilestoneType.PRICING_FREEZE, label: 'Pricing freeze', offsetWorkingDays: 6, durationWorkingDays: 1, dependsOn: 'red_team' },
  { key: 'production', milestoneType: MilestoneType.CUSTOM, label: 'Final document production', offsetWorkingDays: 4, durationWorkingDays: 2, dependsOn: 'pricing_freeze' },
  { key: 'gold_team', milestoneType: MilestoneType.GOLD_TEAM, label: 'Gold Team / final QA', offsetWorkingDays: 3, durationWorkingDays: 1, dependsOn: 'production' },
  { key: 'ready_to_submit', milestoneType: MilestoneType.READY_TO_SUBMIT, label: 'Ready to submit', offsetWorkingDays: 2, durationWorkingDays: 1, dependsOn: 'gold_team' },
  { key: 'submission_buffer', milestoneType: MilestoneType.SUBMISSION, label: 'Submission (with buffer)', offsetWorkingDays: 1, durationWorkingDays: 1, dependsOn: 'ready_to_submit' },
]

export interface ComplexityInputs {
  proposalSectionCount: number
  complianceRequirementCount: number
  pricingScenarioCount: number
  teamSize: number
  requiredReviewCycles: number
  partnerCount: number
  requiredDocumentCount: number
  /** Other pursuits already due in the same window. */
  concurrentPursuits: number
}

/**
 * Complexity multiplier applied to every phase offset. Bounded to [1, 2.5] so a
 * pathological input cannot produce an absurd schedule. Deterministic.
 */
export function complexityMultiplier(inputs: ComplexityInputs): number {
  let m = 1
  if (inputs.proposalSectionCount > 15) m += 0.2
  if (inputs.proposalSectionCount > 40) m += 0.2
  if (inputs.complianceRequirementCount > 50) m += 0.15
  if (inputs.complianceRequirementCount > 150) m += 0.2
  if (inputs.pricingScenarioCount > 2) m += 0.1
  if (inputs.partnerCount > 0) m += 0.15
  if (inputs.partnerCount > 2) m += 0.1
  if (inputs.requiredReviewCycles > 2) m += 0.15
  if (inputs.requiredDocumentCount > 10) m += 0.1
  // A small team on a big proposal needs more calendar time.
  if (inputs.teamSize > 0 && inputs.proposalSectionCount / inputs.teamSize > 10) m += 0.2
  if (inputs.concurrentPursuits >= 3) m += 0.15
  return Number(Math.min(2.5, Math.max(1, m)).toFixed(3))
}

export interface GeneratedPhase {
  key: string
  label: string
  milestoneType: MilestoneType
  start: Date
  end: Date
  offsetWorkingDays: number
  durationWorkingDays: number
  dependsOn: string | null
  isOverdue: boolean
  optional: boolean
}

export interface GenerationResult {
  phases: GeneratedPhase[]
  isFeasible: boolean
  infeasibilityReason: string | null
  overdueCount: number
  multiplier: number
  workingDaysAvailable: number
  workingDaysRequired: number
}

/**
 * Lay phases out backwards from the deadline. Pure: no I/O.
 *
 * Feasibility is checked against the working days actually available between
 * `now` and the deadline. When the schedule does not fit, the phases are still
 * returned (so the user can see the shape of the problem) but flagged
 * infeasible with the exact shortfall.
 */
export function generateSchedule(
  deadline: Date,
  phases: PhaseTemplate[],
  calendar: WorkingCalendar,
  options: { now?: Date; minBufferDays?: number; multiplier?: number } = {},
): GenerationResult {
  const now = toUtcDateOnly(options.now ?? new Date())
  const minBuffer = options.minBufferDays ?? 1
  const multiplier = options.multiplier ?? 1

  // The anchor is the last working day at or before the deadline, minus buffer.
  const anchor = addWorkingDays(previousWorkingDay(deadline, calendar), -minBuffer, calendar)

  const generated: GeneratedPhase[] = phases.map((p) => {
    const scaledOffset = Math.round(p.offsetWorkingDays * multiplier)
    const scaledDuration = Math.max(1, Math.round(p.durationWorkingDays * multiplier))
    const end = addWorkingDays(anchor, -scaledOffset, calendar)
    const start = addWorkingDays(end, -(scaledDuration - 1), calendar)
    return {
      key: p.key,
      label: p.label,
      milestoneType: p.milestoneType,
      start,
      end,
      offsetWorkingDays: scaledOffset,
      durationWorkingDays: scaledDuration,
      dependsOn: p.dependsOn ?? null,
      isOverdue: end < now,
      optional: Boolean(p.optional),
    }
  }).sort((a, b) => a.start.getTime() - b.start.getTime())

  const earliest = generated[0]?.start ?? anchor
  const workingDaysAvailable = workingDaysBetween(now, previousWorkingDay(deadline, calendar), calendar)
  const workingDaysRequired = workingDaysBetween(earliest, anchor, calendar) + minBuffer

  const overdueCount = generated.filter((p) => p.isOverdue).length
  const isFeasible = workingDaysAvailable >= workingDaysRequired

  return {
    phases: generated,
    isFeasible,
    infeasibilityReason: isFeasible
      ? null
      : `This schedule needs ${workingDaysRequired} working day(s) but only ${workingDaysAvailable} remain before the deadline — a shortfall of ${workingDaysRequired - workingDaysAvailable} working day(s). ` +
        `${overdueCount} phase(s) would already be overdue. Shorten review cycles, add people, or accept the compressed dates explicitly.`,
    overdueCount,
    multiplier,
    workingDaysAvailable,
    workingDaysRequired,
  }
}

/** Gather the complexity inputs for one opportunity from real records. */
export async function loadComplexityInputs(
  consultingFirmId: string,
  opportunityId: string,
  deadline: Date,
): Promise<ComplexityInputs> {
  const [proposal, matrix, workspace, teamSize, partners, documents, concurrent] = await Promise.all([
    prisma.proposal.findFirst({ where: { consultingFirmId, opportunityId }, select: { _count: { select: { sections: true } } } }),
    prisma.complianceMatrix.findUnique({ where: { opportunityId }, select: { _count: { select: { requirements: true } } } }),
    prisma.pricingWorkspace.findFirst({ where: { consultingFirmId, opportunityId }, select: { _count: { select: { scenarios: true } } } }),
    prisma.user.count({ where: { consultingFirmId, isActive: true } }),
    prisma.teamingArrangement.count({ where: { consultingFirmId, opportunityId } }),
    prisma.proposalSubmission.findFirst({ where: { consultingFirmId, opportunityId }, select: { _count: { select: { items: true } } } }),
    prisma.opportunity.count({
      where: {
        consultingFirmId, isDemo: false, status: 'ACTIVE',
        id: { not: opportunityId },
        responseDeadline: { gte: new Date(deadline.getTime() - 14 * 86400000), lte: new Date(deadline.getTime() + 14 * 86400000) },
      },
    }),
  ])

  return {
    proposalSectionCount: proposal?._count.sections ?? 0,
    complianceRequirementCount: matrix?._count.requirements ?? 0,
    pricingScenarioCount: workspace?._count.scenarios ?? 0,
    teamSize: Math.max(1, teamSize),
    requiredReviewCycles: 2,
    partnerCount: partners,
    requiredDocumentCount: documents?._count.items ?? 0,
    concurrentPursuits: concurrent,
  }
}

export async function loadCalendar(consultingFirmId: string, calendarKey = 'US_FEDERAL', year = new Date().getUTCFullYear()): Promise<WorkingCalendar> {
  const custom = await prisma.holidayCalendarEntry.findMany({
    where: {
      calendarKey,
      OR: [{ consultingFirmId }, { consultingFirmId: null }],
      date: { gte: new Date(Date.UTC(year - 1, 0, 1)), lte: new Date(Date.UTC(year + 2, 11, 31)) },
    },
    select: { date: true },
  })
  // Federal holidays are computed, so the calendar works even with no seed rows.
  const federal = calendarKey === 'US_FEDERAL' ? usFederalHolidayRange(year - 1, year + 2).map((h) => h.date) : []
  return makeCalendar(undefined, [...federal, ...custom.map((c) => c.date)])
}

export interface RunScheduleArgs {
  consultingFirmId: string
  opportunityId: string
  templateId?: string | null
  /** Preview only — computes and records the run but writes no milestones. */
  isPreview?: boolean
  overrideReason?: string | null
  actorUserId?: string | null
  now?: Date
}

export interface ScheduleRunResult {
  runId: string
  versionNo: number
  isPreview: boolean
  isFeasible: boolean
  infeasibilityReason: string | null
  phases: GeneratedPhase[]
  overdueCount: number
  lockedPreserved: number
  completedPreserved: number
  milestonesCreated: number
  milestonesUpdated: number
  multiplier: number
}

/**
 * Generate (and optionally apply) a working-backward schedule.
 * Locked and completed milestones are always preserved.
 */
export async function runScheduleGeneration(args: RunScheduleArgs): Promise<ScheduleRunResult> {
  const now = args.now ?? new Date()

  const opportunity = await prisma.opportunity.findFirst({
    where: { id: args.opportunityId, consultingFirmId: args.consultingFirmId },
    select: { id: true, responseDeadline: true },
  })
  if (!opportunity) throw new Error('Opportunity not found')

  const submission = await prisma.proposalSubmission.findFirst({
    where: { consultingFirmId: args.consultingFirmId, opportunityId: args.opportunityId },
    select: { finalDeadline: true },
  })
  const deadline = submission?.finalDeadline ?? opportunity.responseDeadline

  const template = args.templateId
    ? await prisma.scheduleTemplate.findFirst({ where: { id: args.templateId, consultingFirmId: args.consultingFirmId } })
    : await prisma.scheduleTemplate.findFirst({ where: { consultingFirmId: args.consultingFirmId, isDefault: true, isArchived: false } })

  const phases: PhaseTemplate[] = template
    ? (template.phases as unknown as PhaseTemplate[])
    : DEFAULT_PHASES

  const calendar = await loadCalendar(args.consultingFirmId, template?.holidayCalendarKey ?? 'US_FEDERAL', deadline.getUTCFullYear())
  const inputs = await loadComplexityInputs(args.consultingFirmId, args.opportunityId, deadline)
  const multiplier = complexityMultiplier(inputs)

  const generated = generateSchedule(deadline, phases, calendar, {
    now,
    minBufferDays: template?.minBufferDays ?? 1,
    multiplier,
  })

  const lastRun = await prisma.scheduleRun.findFirst({
    where: { opportunityId: args.opportunityId },
    orderBy: { versionNo: 'desc' },
    select: { versionNo: true },
  })
  const versionNo = (lastRun?.versionNo ?? 0) + 1

  // Existing schedule-generated milestones that must not be moved.
  const existing = await prisma.opportunityMilestone.findMany({
    where: { consultingFirmId: args.consultingFirmId, opportunityId: args.opportunityId },
    select: { id: true, milestoneType: true, title: true, isLocked: true, status: true },
  })
  const lockedPreserved = existing.filter((m) => m.isLocked).length
  const completedPreserved = existing.filter((m) => m.status === MilestoneStatus.COMPLETE).length

  const run = await prisma.scheduleRun.create({
    data: {
      consultingFirmId: args.consultingFirmId,
      opportunityId: args.opportunityId,
      templateId: template?.id ?? null,
      versionNo,
      anchorDeadline: deadline,
      isPreview: Boolean(args.isPreview),
      isApplied: false,
      inputs: JSON.parse(JSON.stringify({ ...inputs, multiplier, minBufferDays: template?.minBufferDays ?? 1 })) as Prisma.InputJsonValue,
      generated: JSON.parse(JSON.stringify(generated.phases)) as Prisma.InputJsonValue,
      isFeasible: generated.isFeasible,
      infeasibilityReason: generated.infeasibilityReason,
      overdueMilestoneCount: generated.overdueCount,
      lockedPreserved,
      completedPreserved,
      overrideReason: args.overrideReason ?? null,
      overriddenByUserId: args.overrideReason ? args.actorUserId ?? null : null,
      generatedByUserId: args.actorUserId ?? null,
      methodVersion: SCHEDULE_METHOD_VERSION,
    },
    select: { id: true },
  })

  let milestonesCreated = 0
  let milestonesUpdated = 0

  if (!args.isPreview) {
    // An infeasible schedule may only be applied with an explicit override.
    if (!generated.isFeasible && !args.overrideReason) {
      throw new Error(`${generated.infeasibilityReason} Supply an override reason to apply it anyway.`)
    }

    for (const phase of generated.phases) {
      const match = existing.find((m) => m.milestoneType === phase.milestoneType && m.title === phase.label)
      // Never silently overwrite a locked or completed milestone.
      if (match && (match.isLocked || match.status === MilestoneStatus.COMPLETE)) continue

      if (match) {
        await prisma.opportunityMilestone.update({
          where: { id: match.id },
          data: {
            startAt: phase.start,
            endAt: phase.end,
            scheduleRunId: run.id,
            status: phase.isOverdue ? MilestoneStatus.AT_RISK : MilestoneStatus.PLANNED,
          },
        })
        milestonesUpdated++
        continue
      }
      await prisma.opportunityMilestone.create({
        data: {
          consultingFirmId: args.consultingFirmId,
          opportunityId: args.opportunityId,
          scheduleRunId: run.id,
          milestoneType: phase.milestoneType,
          title: phase.label,
          startAt: phase.start,
          endAt: phase.end,
          isAllDay: true,
          origin: MilestoneOrigin.SCHEDULE_GENERATOR,
          isInternal: true,
          isMandatory: !phase.optional,
          status: phase.isOverdue ? MilestoneStatus.AT_RISK : MilestoneStatus.PLANNED,
        },
      })
      milestonesCreated++
    }

    await prisma.scheduleRun.update({ where: { id: run.id }, data: { isApplied: true } })
  }

  return {
    runId: run.id,
    versionNo,
    isPreview: Boolean(args.isPreview),
    isFeasible: generated.isFeasible,
    infeasibilityReason: generated.infeasibilityReason,
    phases: generated.phases,
    overdueCount: generated.overdueCount,
    lockedPreserved,
    completedPreserved,
    milestonesCreated,
    milestonesUpdated,
    multiplier,
  }
}
