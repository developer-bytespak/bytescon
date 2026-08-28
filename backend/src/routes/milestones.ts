// =============================================================
// §6.4 — Deadline & milestone management API.
//
// Timeline · calendar + ICS export · working-backward schedules ·
// amendment revisions and impacts · escalating reminders.
//
// Mounted at /api/milestones. Tenant-scoped throughout.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { MilestoneOrigin, MilestoneStatus, MilestoneType, Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
import {
  getTimeline,
  syncSystemMilestones,
  updateMilestone,
  getFirmCalendar,
  buildIcs,
} from '../services/milestones/milestoneService'
import {
  runScheduleGeneration,
  DEFAULT_PHASES,
  complexityMultiplier,
  loadComplexityInputs,
} from '../services/milestones/scheduleGenerator'
import { recordAmendmentRevision, acknowledgeRevision } from '../services/milestones/amendmentMonitor'
import { emitAmendmentRecorded } from '../services/agents/compliance/complianceEvents'
import { acknowledgeReminder, snoozeReminder, runReminderScan } from '../services/milestones/reminderEngine'
import { usFederalHolidays } from '../services/milestones/workingDays'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityType: string, id: string, rationale?: string) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId: id, rationale })

// -------------------------------------------------------------
// §6.4A — Timeline
// -------------------------------------------------------------

router.get('/timeline/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId }, select: { id: true } })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    // Keep SYSTEM milestones in step with the records that own their dates.
    if (req.query.skipSync !== 'true') {
      await syncSystemMilestones(consultingFirmId, opportunity.id)
    }
    const timeline = await getTimeline(consultingFirmId, opportunity.id)
    res.json({ success: true, data: { ...timeline, milestoneTypes: Object.values(MilestoneType) } })
  } catch (err) { next(err) }
})

const MilestoneCreateSchema = z.object({
  opportunityId: z.string().trim().min(1),
  milestoneType: z.nativeEnum(MilestoneType),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(4000).nullable().optional(),
  startAt: z.string().datetime().nullable().optional(),
  endAt: z.string().datetime().nullable().optional(),
  isAllDay: z.boolean().optional(),
  timeZone: z.string().trim().max(60).optional(),
  isMandatory: z.boolean().optional(),
  isInternal: z.boolean().optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  ownerUserId: z.string().trim().min(1).nullable().optional(),
  backupOwnerUserId: z.string().trim().min(1).nullable().optional(),
  participantUserIds: z.array(z.string().trim().min(1)).max(50).optional(),
  dependsOnMilestoneId: z.string().trim().min(1).nullable().optional(),
  reminderLeadDays: z.array(z.number().int().min(0).max(365)).max(10).optional(),
  remindersEnabled: z.boolean().optional(),
  escalateAfterDueHours: z.number().int().min(1).max(720).optional(),
})

router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = MilestoneCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid milestone payload')

    const opportunity = await prisma.opportunity.findFirst({ where: { id: parsed.data.opportunityId, consultingFirmId }, select: { id: true } })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    // Owners and participants must belong to this firm.
    const userIds = [parsed.data.ownerUserId, parsed.data.backupOwnerUserId, ...(parsed.data.participantUserIds ?? [])].filter((v): v is string => Boolean(v))
    if (userIds.length > 0) {
      const count = await prisma.user.count({ where: { consultingFirmId, id: { in: userIds } } })
      if (count !== new Set(userIds).size) throw new ValidationError('Owner and participants must be members of your firm.')
    }

    const created = await prisma.opportunityMilestone.create({
      data: {
        consultingFirmId,
        opportunityId: opportunity.id,
        milestoneType: parsed.data.milestoneType,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : null,
        endAt: parsed.data.endAt ? new Date(parsed.data.endAt) : null,
        isAllDay: parsed.data.isAllDay ?? false,
        timeZone: parsed.data.timeZone ?? 'UTC',
        origin: MilestoneOrigin.MANUAL,
        isMandatory: parsed.data.isMandatory ?? false,
        isInternal: parsed.data.isInternal ?? true,
        priority: parsed.data.priority ?? 'MEDIUM',
        ownerUserId: parsed.data.ownerUserId ?? null,
        backupOwnerUserId: parsed.data.backupOwnerUserId ?? null,
        participantUserIds: parsed.data.participantUserIds ?? [],
        dependsOnMilestoneId: parsed.data.dependsOnMilestoneId ?? null,
        reminderLeadDays: parsed.data.reminderLeadDays ?? [14, 7, 3, 1],
        remindersEnabled: parsed.data.remindersEnabled ?? true,
        escalateAfterDueHours: parsed.data.escalateAfterDueHours ?? 24,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'OpportunityMilestone', created.id, `Milestone created: ${created.title}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

const MilestoneUpdateSchema = MilestoneCreateSchema.partial().omit({ opportunityId: true, milestoneType: true }).extend({
  status: z.nativeEnum(MilestoneStatus).optional(),
  isLocked: z.boolean().optional(),
  lockReason: z.string().trim().max(1000).nullable().optional(),
})

router.patch('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = MilestoneUpdateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid milestone payload')

    const updated = await updateMilestone(consultingFirmId, req.params.id, {
      ...parsed.data,
      startAt: parsed.data.startAt === undefined ? undefined : parsed.data.startAt ? new Date(parsed.data.startAt) : null,
      endAt: parsed.data.endAt === undefined ? undefined : parsed.data.endAt ? new Date(parsed.data.endAt) : null,
    }, req.user?.userId ?? null)

    await audit(req, consultingFirmId, 'UPDATE', 'OpportunityMilestone', req.params.id, 'Milestone updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Calendar + ICS
// -------------------------------------------------------------

router.get('/calendar', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const from = typeof req.query.from === 'string' ? new Date(req.query.from) : undefined
    const to = typeof req.query.to === 'string' ? new Date(req.query.to) : undefined
    const items = await getFirmCalendar(consultingFirmId, {
      from: from && !Number.isNaN(from.getTime()) ? from : undefined,
      to: to && !Number.isNaN(to.getTime()) ? to : undefined,
      ownerUserId: req.query.mineOnly === 'true' ? req.user?.userId : undefined,
    })
    res.json({ success: true, data: items })
  } catch (err) { next(err) }
})

/** GET /calendar.ics — standards-compliant export; no third-party account. */
router.get('/calendar.ics', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const items = await getFirmCalendar(consultingFirmId, {
      ownerUserId: req.query.mineOnly === 'true' ? req.user?.userId : undefined,
      limit: 1000,
    })
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="bytescon-milestones.ics"')
    res.send(buildIcs(items))
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.4C — Working-backward schedules
// -------------------------------------------------------------

router.get('/schedule/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const runs = await prisma.scheduleRun.findMany({
      where: { consultingFirmId, opportunityId: req.params.opportunityId },
      orderBy: { versionNo: 'desc' },
      take: 25,
    })
    const templates = await prisma.scheduleTemplate.findMany({ where: { consultingFirmId, isArchived: false }, orderBy: { name: 'asc' } })
    res.json({ success: true, data: { runs, templates, defaultPhases: DEFAULT_PHASES } })
  } catch (err) { next(err) }
})

const ScheduleSchema = z.object({
  templateId: z.string().trim().min(1).nullable().optional(),
  preview: z.boolean().optional(),
  overrideReason: z.string().trim().max(2000).nullable().optional(),
})

router.post('/schedule/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ScheduleSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid schedule payload')

    const result = await runScheduleGeneration({
      consultingFirmId,
      opportunityId: req.params.opportunityId,
      templateId: parsed.data.templateId ?? null,
      isPreview: parsed.data.preview ?? false,
      overrideReason: parsed.data.overrideReason ?? null,
      actorUserId: req.user?.userId ?? null,
    })
    if (!parsed.data.preview) {
      await audit(req, consultingFirmId, 'CREATE', 'ScheduleRun', result.runId,
        `Schedule v${result.versionNo} applied (feasible: ${result.isFeasible})`)
    }
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

router.get('/schedule/:opportunityId/complexity', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId }, select: { responseDeadline: true } })
    if (!opportunity) throw new NotFoundError('Opportunity not found')
    const inputs = await loadComplexityInputs(consultingFirmId, req.params.opportunityId, opportunity.responseDeadline)
    res.json({ success: true, data: { inputs, multiplier: complexityMultiplier(inputs) } })
  } catch (err) { next(err) }
})

const TemplateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2000).nullable().optional(),
  isDefault: z.boolean().optional(),
  phases: z.array(z.object({
    key: z.string().trim().min(1).max(60),
    milestoneType: z.nativeEnum(MilestoneType),
    label: z.string().trim().min(1).max(200),
    offsetWorkingDays: z.number().int().min(0).max(365),
    durationWorkingDays: z.number().int().min(1).max(120),
    dependsOn: z.string().trim().max(60).nullable().optional(),
    optional: z.boolean().optional(),
  })).min(1).max(40),
  minBufferDays: z.number().int().min(0).max(30).optional(),
  holidayCalendarKey: z.string().trim().max(40).optional(),
})

router.post('/schedule-templates', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = TemplateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid template payload')

    if (parsed.data.isDefault) {
      await prisma.scheduleTemplate.updateMany({ where: { consultingFirmId, isDefault: true }, data: { isDefault: false } })
    }
    const created = await prisma.scheduleTemplate.create({
      data: {
        consultingFirmId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        isDefault: parsed.data.isDefault ?? false,
        phases: JSON.parse(JSON.stringify(parsed.data.phases)) as Prisma.InputJsonValue,
        minBufferDays: parsed.data.minBufferDays ?? 1,
        holidayCalendarKey: parsed.data.holidayCalendarKey ?? 'US_FEDERAL',
        createdByUserId: req.user?.userId ?? null,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'ScheduleTemplate', created.id, `Template created: ${created.name}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

/** GET /holidays — the working calendar behind the schedule maths. */
router.get('/holidays', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const year = Number(req.query.year ?? new Date().getUTCFullYear()) || new Date().getUTCFullYear()
    const custom = await prisma.holidayCalendarEntry.findMany({
      where: { OR: [{ consultingFirmId }, { consultingFirmId: null }], date: { gte: new Date(Date.UTC(year, 0, 1)), lte: new Date(Date.UTC(year, 11, 31)) } },
      orderBy: { date: 'asc' },
    })
    res.json({ success: true, data: { year, federal: usFederalHolidays(year), custom } })
  } catch (err) { next(err) }
})

router.post('/holidays', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const date = new Date(req.body?.date)
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (Number.isNaN(date.getTime()) || !name) throw new ValidationError('A valid date and name are required.')
    const created = await prisma.holidayCalendarEntry.create({
      data: { consultingFirmId, calendarKey: typeof req.body?.calendarKey === 'string' ? req.body.calendarKey : 'US_FEDERAL', date, name },
    })
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.4B — Amendments
// -------------------------------------------------------------

router.get('/amendments/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const revisions = await prisma.amendmentRevision.findMany({
      where: { consultingFirmId, opportunityId: req.params.opportunityId },
      orderBy: { revisionNo: 'desc' },
      include: { impacts: { orderBy: { createdAt: 'desc' } } },
    })
    res.json({
      success: true,
      data: {
        revisions,
        note: 'Every amendment version is preserved. Impacts are proposals for human confirmation — no verified requirement, proposal section, checklist item or pricing value is changed automatically.',
      },
    })
  } catch (err) { next(err) }
})

const AmendmentSchema = z.object({
  amendmentNumber: z.string().trim().max(60).nullable().optional(),
  documentName: z.string().trim().max(300).nullable().optional(),
  sourceUrl: z.string().trim().url().max(2000).nullable().optional(),
  externalId: z.string().trim().max(200).nullable().optional(),
  text: z.string().min(1).max(2_000_000),
})

router.post('/amendments/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = AmendmentSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid amendment payload')

    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId }, select: { id: true } })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    const result = await recordAmendmentRevision({
      consultingFirmId,
      opportunityId: opportunity.id,
      amendmentNumber: parsed.data.amendmentNumber ?? null,
      documentName: parsed.data.documentName ?? null,
      sourceUrl: parsed.data.sourceUrl ?? null,
      externalId: parsed.data.externalId ?? null,
      text: parsed.data.text,
    })
    if (result.revisionId) {
      await audit(req, consultingFirmId, 'CREATE', 'AmendmentRevision', result.revisionId, result.message)
      // §7.3 — only a genuinely NEW revision announces itself. Re-posting
      // identical amendment content creates no revision (AmendmentRevision is
      // unique on content hash) and therefore emits no event.
      if (result.isNew) {
        await prisma.$transaction(async (tx) => {
          await emitAmendmentRecorded(tx, {
            consultingFirmId,
            revisionId: result.revisionId as string,
            opportunityId: opportunity.id,
            revisionNo: result.revisionNo ?? 0,
            amendmentNumber: parsed.data.amendmentNumber ?? null,
            changedRequirements: result.diff?.changedRequirements.length ?? 0,
            changedDeadlines: result.diff?.changedDeadlines.length ?? 0,
            changedClauses: result.diff?.changedClauses.length ?? 0,
          })
        })
      }
    }
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

router.post('/amendments/revision/:id/acknowledge', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    if (!req.user?.userId) throw new ValidationError('A user context is required.')
    const result = await acknowledgeRevision(consultingFirmId, req.params.id, req.user.userId)
    await audit(req, consultingFirmId, 'UPDATE', 'AmendmentRevision', req.params.id, 'Amendment acknowledged')
    res.json({ success: true, data: { impactsAcknowledged: result.count } })
  } catch (err) { next(err) }
})

router.post('/amendments/impact/:id/dismiss', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    if (!reason) throw new ValidationError('A reason is required to dismiss an impact.')
    const impact = await prisma.amendmentImpact.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!impact) throw new NotFoundError('Impact not found')
    const updated = await prisma.amendmentImpact.update({
      where: { id: impact.id },
      data: { dismissedReason: reason, acknowledgedByUserId: req.user?.userId ?? null, acknowledgedAt: new Date() },
    })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.4D — Reminders
// -------------------------------------------------------------

router.get('/reminders', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const reminders = await prisma.milestoneReminderLog.findMany({
      where: {
        consultingFirmId,
        ...(req.query.mineOnly === 'true' && req.user?.userId ? { userId: req.user.userId } : {}),
        ...(req.query.unacknowledgedOnly === 'true' ? { acknowledgedAt: null } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: Math.min(Number(req.query.limit ?? 100) || 100, 300),
      include: { milestone: { select: { id: true, title: true, endAt: true, opportunityId: true, status: true } } },
    })
    res.json({ success: true, data: reminders })
  } catch (err) { next(err) }
})

router.post('/reminders/:id/acknowledge', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    if (!req.user?.userId) throw new ValidationError('A user context is required.')
    const updated = await acknowledgeReminder(consultingFirmId, req.params.id, req.user.userId)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.post('/reminders/:id/snooze', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const until = new Date(req.body?.until)
    if (Number.isNaN(until.getTime()) || until <= new Date()) throw new ValidationError('`until` must be a future date.')
    const updated = await snoozeReminder(consultingFirmId, req.params.id, until)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/** POST /reminders/scan — ADMIN-triggered run of the same scan the worker uses. */
router.post('/reminders/scan', requireRole('ADMIN'), async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await runReminderScan()
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

export default router
