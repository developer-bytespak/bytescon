// =============================================================
// Saved Monitoring Profiles (§5.1 Stage 1) — reusable saved opportunity-search
// profiles. A profile stores a validated subset of the SAME filters the
// opportunity search accepts; "applying" one replays those filters against the
// existing search (server-side filtering stays the single source of truth). The
// /count endpoint runs the shared buildOpportunityWhere so the displayed result
// count matches what the live search would return.
//
// §6.1G extends this with user ownership, PRIVATE/FIRM visibility, per-profile
// alert cadence/priority/channels and an alert ledger. The permission model is
// enforced here on the BACKEND: any firm member may create and fully manage
// their OWN profiles, PRIVATE profiles are invisible to others, and ADMIN
// retains firm-wide control. Mounted at /api/monitoring-profiles.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { Prisma, MonitoringAlertFrequency } from '@prisma/client'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError, ConflictError, ForbiddenError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
import { buildOpportunityWhere, MonitoringFiltersSchema } from '../services/opportunityFilters'
import { emitMonitoringProfileSaved } from '../services/agents/opportunity/opportunityEvents'
import { getEntitlementsForRequest, hasAddonEntitlement } from '../services/entitlementService'
import {
  canAccessProfile,
  canMutateProfile,
  evaluateProfile,
  nextEvaluationAt,
} from '../services/discovery/profileAlerts'

/** The profile fields that decide what it matches, for the event fingerprint. */
function profileMaterial(row: {
  filters: Prisma.JsonValue
  alertFrequency: MonitoringAlertFrequency
  priority: string
  isActive: boolean
  isArchived: boolean
  visibility: string
}) {
  return {
    filters: row.filters,
    alertFrequency: row.alertFrequency,
    priority: row.priority,
    isActive: row.isActive,
    isArchived: row.isArchived,
    visibility: row.visibility,
  }
}

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const ALERT_FREQUENCIES = ['INSTANT', 'DAILY', 'WEEKLY', 'DISABLED'] as const

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, id: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType: 'SavedMonitoringProfile', entityId: id, rationale, before, after })

async function loadProfile(consultingFirmId: string, id: string) {
  const p = await prisma.savedMonitoringProfile.findFirst({ where: { id, consultingFirmId } })
  if (!p) throw new NotFoundError('Monitoring profile not found')
  return p
}

// Reject a name already used by another non-archived profile in the firm.
async function assertNameFree(consultingFirmId: string, name: string, exceptId?: string) {
  const clash = await prisma.savedMonitoringProfile.findFirst({
    where: { consultingFirmId, isArchived: false, name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  })
  if (clash) throw new ConflictError('A profile with this name already exists')
}

// §6.1G — per-profile ownership, visibility, priority and alert channels.
const OwnershipFields = {
  visibility: z.enum(['PRIVATE', 'FIRM']).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  alertInApp: z.boolean().optional(),
  alertEmail: z.boolean().optional(),
  timeZone: z.string().trim().max(60).optional(),
}

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).nullable().optional(),
  filters: MonitoringFiltersSchema.optional(),
  alertFrequency: z.enum(ALERT_FREQUENCIES).optional(),
  ...OwnershipFields,
})
const UpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  filters: MonitoringFiltersSchema.optional(),
  alertFrequency: z.enum(ALERT_FREQUENCIES).optional(),
  isActive: z.boolean().optional(),
  ...OwnershipFields,
}).refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })

/**
 * §6.1G permission model, enforced on the BACKEND (never by hiding UI):
 *   read   — FIRM profiles are firm-wide; PRIVATE ones only the owner or ADMIN
 *   write  — the owner, or ADMIN
 * A CONSULTANT therefore fully manages their own profiles, which is the §6.1G
 * requirement, while other people's profiles remain protected.
 */
function assertCanRead(profile: { ownerUserId: string | null; createdByUserId: string | null; visibility: string }, req: AuthenticatedRequest) {
  if (canAccessProfile(profile, { userId: req.user?.userId ?? '', role: req.user?.role ?? '' })) return
  throw new NotFoundError('Monitoring profile not found')
}
function assertCanWrite(profile: { ownerUserId: string | null; createdByUserId: string | null; visibility: string }, req: AuthenticatedRequest) {
  if (canMutateProfile(profile, { userId: req.user?.userId ?? '', role: req.user?.role ?? '' })) return
  throw new ForbiddenError('You can only modify monitoring profiles you own.')
}

// GET / — list profiles (firm-wide read). ?includeArchived=true adds archived.
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.SavedMonitoringProfileWhereInput = { consultingFirmId }
    if (req.query.includeArchived !== 'true') where.isArchived = false
    if (req.query.activeOnly === 'true') where.isActive = true
    if (req.query.mineOnly === 'true' && req.user?.userId) {
      where.OR = [{ ownerUserId: req.user.userId }, { createdByUserId: req.user.userId }]
    }
    const items = await prisma.savedMonitoringProfile.findMany({ where, orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }] })
    // PRIVATE profiles belonging to someone else are filtered server-side.
    const visible = items.filter((p) => canAccessProfile(p, { userId: req.user?.userId ?? '', role: req.user?.role ?? '' }))
    res.json({ success: true, data: visible })
  } catch (err) { next(err) }
})

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const profile = await loadProfile(consultingFirmId, req.params.id)
    assertCanRead(profile, req)
    res.json({ success: true, data: profile })
  } catch (err) { next(err) }
})

// GET /:id/count — apply the profile server-side and return the result count
// (+ cache it). Uses the shared filter builder so it matches the live search.
router.get('/:id/count', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const profile = await loadProfile(consultingFirmId, req.params.id)
    assertCanRead(profile, req)
    const filters = (profile.filters ?? {}) as Record<string, unknown>
    let allowSetAside = true
    if (filters.setAsideType) {
      const ents = await getEntitlementsForRequest(req, consultingFirmId)
      allowSetAside = hasAddonEntitlement(ents, 'setaside_intel')
    }
    const where = buildOpportunityWhere(filters, { consultingFirmId, allowSetAside })
    const count = await prisma.opportunity.count({ where })
    // Cache is display-only; safe to update on a read.
    await prisma.savedMonitoringProfile.update({ where: { id: profile.id }, data: { lastResultCount: count, lastAppliedAt: new Date() } })
    res.json({ success: true, data: { count, setAsideIgnored: Boolean(filters.setAsideType) && !allowSetAside } })
  } catch (err) { next(err) }
})

// POST / — create. §6.1G: any firm member may create a profile; they own it.
router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = CreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid profile payload')
    await assertNameFree(consultingFirmId, parsed.data.name)
    // §7.2 — profile write and MONITORING_PROFILE_SAVED share one transaction.
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.savedMonitoringProfile.create({
        data: {
          consultingFirmId,
          createdByUserId: req.user?.userId ?? null,
          ownerUserId: req.user?.userId ?? null,
          name: parsed.data.name, description: parsed.data.description ?? null,
          filters: (parsed.data.filters ?? {}) as Prisma.InputJsonValue,
          alertFrequency: (parsed.data.alertFrequency ?? 'DISABLED') as MonitoringAlertFrequency,
          visibility: parsed.data.visibility ?? 'FIRM',
          priority: parsed.data.priority ?? 'MEDIUM',
          alertInApp: parsed.data.alertInApp ?? true,
          alertEmail: parsed.data.alertEmail ?? false,
          timeZone: parsed.data.timeZone ?? 'UTC',
          nextEvaluationAt: nextEvaluationAt((parsed.data.alertFrequency ?? 'DISABLED') as MonitoringAlertFrequency, new Date()),
        },
      })
      await emitMonitoringProfileSaved(tx, { consultingFirmId, profileId: row.id, changeType: 'CREATED', material: profileMaterial(row) })
      return row
    })
    await audit(req, consultingFirmId, 'CREATE', created.id, `Monitoring profile created: ${created.name}`, undefined, { alertFrequency: created.alertFrequency })
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

// PUT /:id — update (owner or ADMIN).
router.put('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = UpdateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid profile payload')
    const profile = await loadProfile(consultingFirmId, req.params.id)
    assertCanWrite(profile, req)
    if (parsed.data.name && parsed.data.name.toLowerCase() !== profile.name.toLowerCase()) {
      await assertNameFree(consultingFirmId, parsed.data.name, profile.id)
    }
    const data: Prisma.SavedMonitoringProfileUpdateInput = {}
    if (parsed.data.name !== undefined) data.name = parsed.data.name
    if ('description' in parsed.data) data.description = parsed.data.description ?? null
    if (parsed.data.filters !== undefined) data.filters = parsed.data.filters as Prisma.InputJsonValue
    if (parsed.data.alertFrequency !== undefined) data.alertFrequency = parsed.data.alertFrequency as MonitoringAlertFrequency
    if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive
    if (parsed.data.visibility !== undefined) data.visibility = parsed.data.visibility
    if (parsed.data.priority !== undefined) data.priority = parsed.data.priority
    if (parsed.data.alertInApp !== undefined) data.alertInApp = parsed.data.alertInApp
    if (parsed.data.alertEmail !== undefined) data.alertEmail = parsed.data.alertEmail
    if (parsed.data.timeZone !== undefined) data.timeZone = parsed.data.timeZone
    // Changing the cadence re-schedules the next evaluation immediately.
    if (parsed.data.alertFrequency !== undefined) {
      data.nextEvaluationAt = nextEvaluationAt(parsed.data.alertFrequency as MonitoringAlertFrequency, new Date())
    }
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.savedMonitoringProfile.update({ where: { id: profile.id }, data })
      // Fingerprinted over filters/cadence/priority/active — a rename alone does
      // not warrant a fresh evaluation and collapses onto the existing event.
      await emitMonitoringProfileSaved(tx, { consultingFirmId, profileId: row.id, changeType: 'UPDATED', material: profileMaterial(row) })
      return row
    })
    await audit(req, consultingFirmId, 'UPDATE', profile.id, 'Monitoring profile updated', { name: profile.name, alertFrequency: profile.alertFrequency, isActive: profile.isActive }, { name: updated.name, alertFrequency: updated.alertFrequency, isActive: updated.isActive })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// POST /:id/duplicate — copy a profile (the copy is owned by the caller).
router.post('/:id/duplicate', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const source = await loadProfile(consultingFirmId, req.params.id)
    assertCanRead(source, req)
    // Find a free "(copy)" name.
    let name = `${source.name} (copy)`
    for (let i = 2; await prisma.savedMonitoringProfile.findFirst({ where: { consultingFirmId, isArchived: false, name: { equals: name, mode: 'insensitive' } }, select: { id: true } }); i++) {
      name = `${source.name} (copy ${i})`
    }
    const copy = await prisma.savedMonitoringProfile.create({
      data: {
        consultingFirmId, createdByUserId: req.user?.userId ?? null,
        name, description: source.description, filters: source.filters as Prisma.InputJsonValue,
        alertFrequency: source.alertFrequency, isActive: true, isArchived: false,
        ownerUserId: req.user?.userId ?? null,
        visibility: source.visibility, priority: source.priority,
        alertInApp: source.alertInApp, alertEmail: source.alertEmail, timeZone: source.timeZone,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', copy.id, `Duplicated from ${source.id}`)
    res.status(201).json({ success: true, data: copy })
  } catch (err) { next(err) }
})

// PATCH /:id/active — activate / deactivate (owner or ADMIN).
router.patch('/:id/active', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const isActive = (req.body ?? {}).isActive
    if (typeof isActive !== 'boolean') throw new ValidationError('isActive must be a boolean')
    const profile = await loadProfile(consultingFirmId, req.params.id)
    assertCanWrite(profile, req)
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.savedMonitoringProfile.update({ where: { id: profile.id }, data: { isActive } })
      // Reactivation needs a fresh evaluation; deactivation changes the same
      // fingerprint field, so both are announced through the one event.
      await emitMonitoringProfileSaved(tx, { consultingFirmId, profileId: row.id, changeType: 'REACTIVATED', material: profileMaterial(row) })
      return row
    })
    await audit(req, consultingFirmId, 'UPDATE', profile.id, isActive ? 'Activated' : 'Deactivated', { isActive: profile.isActive }, { isActive })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// POST /:id/archive — soft-archive (owner or ADMIN). Also deactivates.
router.post('/:id/archive', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const profile = await loadProfile(consultingFirmId, req.params.id)
    assertCanWrite(profile, req)
    const updated = await prisma.savedMonitoringProfile.update({ where: { id: profile.id }, data: { isArchived: true, isActive: false } })
    await audit(req, consultingFirmId, 'UPDATE', profile.id, 'Archived', { isArchived: profile.isArchived }, { isArchived: true })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// POST /:id/restore — un-archive (owner or ADMIN).
router.post('/:id/restore', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const profile = await loadProfile(consultingFirmId, req.params.id)
    assertCanWrite(profile, req)
    await assertNameFree(consultingFirmId, profile.name, profile.id)
    const updated = await prisma.savedMonitoringProfile.update({ where: { id: profile.id }, data: { isArchived: false } })
    await audit(req, consultingFirmId, 'UPDATE', profile.id, 'Restored', { isArchived: profile.isArchived }, { isArchived: false })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// POST /:id/evaluate — run this profile's alerting now (owner or ADMIN).
router.post('/:id/evaluate', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const profile = await loadProfile(consultingFirmId, req.params.id)
    assertCanWrite(profile, req)
    const result = await evaluateProfile(profile.id)
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

// GET /:id/alerts — the dedupe ledger, so users can see what was alerted and why.
router.get('/:id/alerts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const profile = await loadProfile(consultingFirmId, req.params.id)
    assertCanRead(profile, req)
    const alerts = await prisma.monitoringProfileAlert.findMany({
      where: { consultingFirmId, profileId: profile.id },
      orderBy: { lastSentAt: 'desc' },
      take: 200,
    })
    res.json({ success: true, data: alerts })
  } catch (err) { next(err) }
})

export default router
