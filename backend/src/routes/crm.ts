// =============================================================
// §8.1 — GovCon CRM routes.
//
// Offices, government contacts, partner contacts, activities and follow-ups,
// plus the derived relationship strength for a contact or a partner.
//
// What this deliberately does NOT do:
//  - it does not introduce an Agency model (agency identity is the string
//    already used across Opportunity/Contract; /agencies groups over it)
//  - it does not introduce a second pipeline (BidPursuit stays authoritative)
//  - it does not compute opportunity value (portfolioValue.ts owns that)
//  - it does not create a partner company record (Partner is extended)
//
// Every query is filtered by consultingFirmId from the JWT, and every foreign
// reference is re-validated against the tenant before it is stored, so an id
// belonging to another firm cannot be attached to a CRM record.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { CrmActivityType, CrmFollowUpStatus, GovContactRole, CrmContactStatus, CrmPriority, Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { computeRelationshipStrength, RelationshipStrengthResult } from '../services/crm/relationshipStrength'
import { agencyKey, agencyMatchesPath, parseAgencyPath } from '../services/crm/agencyMatching'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

// §8.5 — CRM mutations had no role gate at all, so a CONSULTANT (documented
// everywhere as read-only across the internal platform) could create and edit
// contacts, activities and follow-ups. Gating them on CRM_WRITE closes that
// gap: ADMIN and the capture roles hold it, CONSULTANT and VIEWER do not.

const audit = (
  req: AuthenticatedRequest,
  consultingFirmId: string,
  action: AuditAction,
  entityType: string,
  entityId: string,
  rationale?: string,
  before?: unknown,
  after?: unknown,
) =>
  logAudit({
    consultingFirmId,
    actorUserId: req.user?.userId,
    actorRole: req.user?.role,
    action,
    entityType,
    entityId,
    rationale,
    before,
    after,
  })

const OPEN_PURSUIT_STATES = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED'] as const

/**
 * Re-validate every optional foreign reference against the caller's tenant.
 * Returning 404 rather than 403 keeps the existence of another firm's record
 * unobservable — the same posture the rest of the platform takes.
 */
async function assertTenantRefs(
  consultingFirmId: string,
  refs: {
    governmentContactId?: string | null
    agencyOfficeId?: string | null
    opportunityId?: string | null
    bidPursuitId?: string | null
    partnerId?: string | null
    partnerContactId?: string | null
    activityId?: string | null
  },
): Promise<void> {
  const checks: Array<[string, Promise<unknown>]> = []
  if (refs.governmentContactId)
    checks.push(['Contact', prisma.governmentContact.findFirst({ where: { id: refs.governmentContactId, consultingFirmId }, select: { id: true } })])
  if (refs.agencyOfficeId)
    checks.push(['Office', prisma.agencyOffice.findFirst({ where: { id: refs.agencyOfficeId, consultingFirmId }, select: { id: true } })])
  if (refs.opportunityId)
    checks.push(['Opportunity', prisma.opportunity.findFirst({ where: { id: refs.opportunityId, consultingFirmId }, select: { id: true } })])
  if (refs.bidPursuitId)
    checks.push(['Pursuit', prisma.bidPursuit.findFirst({ where: { id: refs.bidPursuitId, consultingFirmId }, select: { id: true } })])
  if (refs.partnerId)
    checks.push(['Partner', prisma.partner.findFirst({ where: { id: refs.partnerId, consultingFirmId }, select: { id: true } })])
  if (refs.partnerContactId)
    checks.push(['Partner contact', prisma.partnerContact.findFirst({ where: { id: refs.partnerContactId, consultingFirmId }, select: { id: true } })])
  if (refs.activityId)
    checks.push(['Activity', prisma.crmActivity.findFirst({ where: { id: refs.activityId, consultingFirmId }, select: { id: true } })])

  const results = await Promise.all(checks.map(([, p]) => p))
  results.forEach((row, i) => {
    if (!row) throw new NotFoundError(`${checks[i][0]} not found`)
  })
}

// -------------------------------------------------------------
// Offices
// -------------------------------------------------------------

const OfficeSchema = z.object({
  agencyName: z.string().trim().min(1).max(300),
  officeName: z.string().trim().min(1).max(300),
  officeSymbol: z.string().trim().max(60).nullable().optional(),
  location: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
})

router.get('/offices', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.AgencyOfficeWhereInput = { consultingFirmId, isArchived: false }
    if (typeof req.query.agencyName === 'string' && req.query.agencyName) where.agencyName = req.query.agencyName
    const offices = await prisma.agencyOffice.findMany({
      where,
      orderBy: [{ agencyName: 'asc' }, { officeName: 'asc' }],
      include: { _count: { select: { contacts: true, activities: true } } },
      take: 500,
    })
    res.json({ success: true, data: offices })
  } catch (err) { next(err) }
})

router.post('/offices', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = OfficeSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid office payload')

    const existing = await prisma.agencyOffice.findFirst({
      where: { consultingFirmId, agencyName: parsed.data.agencyName, officeName: parsed.data.officeName },
      select: { id: true },
    })
    if (existing) throw new ValidationError('That office already exists for this agency.')

    const created = await prisma.agencyOffice.create({
      data: { ...parsed.data, consultingFirmId, createdByUserId: req.user?.userId ?? null },
    })
    await audit(req, consultingFirmId, 'CREATE', 'AgencyOffice', created.id, `Office ${created.officeName} created`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.put('/offices/:id', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = OfficeSchema.partial().safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid office payload')
    const existing = await prisma.agencyOffice.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Office not found')
    const updated = await prisma.agencyOffice.update({ where: { id: existing.id }, data: parsed.data })
    await audit(req, consultingFirmId, 'UPDATE', 'AgencyOffice', existing.id, 'Office updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Agencies — a grouping over agencyName, not a stored entity.
// -------------------------------------------------------------

router.get('/agencies', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [offices, contacts, activities] = await Promise.all([
      prisma.agencyOffice.groupBy({ by: ['agencyName'], where: { consultingFirmId, isArchived: false }, _count: { _all: true } }),
      prisma.governmentContact.groupBy({ by: ['agencyName'], where: { consultingFirmId, isArchived: false }, _count: { _all: true } }),
      prisma.crmActivity.groupBy({
        by: ['agencyName'],
        where: { consultingFirmId, agencyName: { not: null } },
        _count: { _all: true },
        _max: { occurredAt: true },
      }),
    ])

    // Grouped by normalised key, so "DOE" and "Department of Energy" typed on
    // different days are one agency card rather than two half-empty ones. The
    // longest spelling wins as the label, since it is the most informative.
    const buckets = new Map<string, { label: string; officeCount: number; contactCount: number; activityCount: number; lastActivityAt: Date | null }>()

    const bucketFor = (rawName: string) => {
      const key = agencyKey(rawName)
      const existing = buckets.get(key)
      if (existing) {
        if (rawName.length > existing.label.length) existing.label = rawName
        return existing
      }
      const created = { label: rawName, officeCount: 0, contactCount: 0, activityCount: 0, lastActivityAt: null as Date | null }
      buckets.set(key, created)
      return created
    }

    for (const o of offices) bucketFor(o.agencyName).officeCount += o._count._all
    for (const c of contacts) bucketFor(c.agencyName).contactCount += c._count._all
    for (const a of activities) {
      if (!a.agencyName) continue
      const bucket = bucketFor(a.agencyName)
      bucket.activityCount += a._count._all
      const last = a._max.occurredAt
      if (last && (!bucket.lastActivityAt || last > bucket.lastActivityAt)) bucket.lastActivityAt = last
    }

    const data = [...buckets.values()]
      .sort((x, y) => x.label.localeCompare(y.label))
      .map((b) => ({
        agencyName: b.label,
        officeCount: b.officeCount,
        contactCount: b.contactCount,
        activityCount: b.activityCount,
        lastActivityAt: b.lastActivityAt,
      }))

    res.json({
      success: true,
      data: {
        items: data,
        // Stated so the UI never implies the CRM owns agency master data.
        note: 'Agencies are grouped from the agency names already stored on opportunities, contracts and CRM records. There is no separate agency registry.',
      },
    })
  } catch (err) { next(err) }
})

router.get('/agencies/:agencyName', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const agencyName = decodeURIComponent(req.params.agencyName)
    const [offices, contacts, activities, marketProfile] = await Promise.all([
      prisma.agencyOffice.findMany({ where: { consultingFirmId, agencyName, isArchived: false }, orderBy: { officeName: 'asc' } }),
      prisma.governmentContact.findMany({ where: { consultingFirmId, agencyName, isArchived: false }, orderBy: { fullName: 'asc' } }),
      prisma.crmActivity.findMany({ where: { consultingFirmId, agencyName }, orderBy: { occurredAt: 'desc' }, take: 50 }),
      // Global market-stats table, joined for context — never written by the CRM.
      prisma.agencyAwardProfile.findUnique({ where: { agencyName } }),
    ])
    res.json({ success: true, data: { agencyName, offices, contacts, activities, marketProfile } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Government contacts
// -------------------------------------------------------------

const ContactSchema = z.object({
  agencyName: z.string().trim().min(1).max(300),
  agencyOfficeId: z.string().uuid().nullable().optional(),
  fullName: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).nullable().optional(),
  contactRole: z.nativeEnum(GovContactRole).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(60).nullable().optional(),
  status: z.nativeEnum(CrmContactStatus).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
})

router.get('/contacts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.GovernmentContactWhereInput = { consultingFirmId, isArchived: false }
    if (typeof req.query.agencyName === 'string' && req.query.agencyName) where.agencyName = req.query.agencyName
    if (typeof req.query.agencyOfficeId === 'string' && req.query.agencyOfficeId) where.agencyOfficeId = req.query.agencyOfficeId
    if (typeof req.query.contactRole === 'string' && req.query.contactRole in GovContactRole)
      where.contactRole = req.query.contactRole as GovContactRole
    if (typeof req.query.search === 'string' && req.query.search)
      where.fullName = { contains: req.query.search, mode: 'insensitive' }

    const contacts = await prisma.governmentContact.findMany({
      where,
      orderBy: { fullName: 'asc' },
      include: { agencyOffice: { select: { id: true, officeName: true } }, _count: { select: { activities: true, followUps: true } } },
      take: 500,
    })
    res.json({ success: true, data: contacts })
  } catch (err) { next(err) }
})

router.post('/contacts', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ContactSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid contact payload')
    await assertTenantRefs(consultingFirmId, { agencyOfficeId: parsed.data.agencyOfficeId })

    const created = await prisma.governmentContact.create({
      data: { ...parsed.data, consultingFirmId, createdByUserId: req.user?.userId ?? null },
    })
    await audit(req, consultingFirmId, 'CREATE', 'GovernmentContact', created.id, `Contact ${created.fullName} created`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.get('/contacts/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const contact = await prisma.governmentContact.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: { agencyOffice: true },
    })
    if (!contact) throw new NotFoundError('Contact not found')

    const [activities, followUps] = await Promise.all([
      prisma.crmActivity.findMany({
        where: { consultingFirmId, governmentContactId: contact.id },
        orderBy: { occurredAt: 'desc' },
        take: 200,
        include: { opportunity: { select: { id: true, title: true } } },
      }),
      prisma.crmFollowUp.findMany({
        where: { consultingFirmId, governmentContactId: contact.id },
        orderBy: { dueAt: 'asc' },
      }),
    ])

    const relationship = await relationshipForContact(consultingFirmId, contact.id, activities, followUps)
    res.json({ success: true, data: { ...contact, activities, followUps, relationship } })
  } catch (err) { next(err) }
})

router.put('/contacts/:id', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ContactSchema.partial().safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid contact payload')
    const existing = await prisma.governmentContact.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Contact not found')
    await assertTenantRefs(consultingFirmId, { agencyOfficeId: parsed.data.agencyOfficeId })

    const updated = await prisma.governmentContact.update({ where: { id: existing.id }, data: parsed.data })
    await audit(req, consultingFirmId, 'UPDATE', 'GovernmentContact', existing.id, 'Contact updated',
      { status: existing.status }, { status: updated.status })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.post('/contacts/:id/archive', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.governmentContact.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Contact not found')
    // Archive, never delete — activity history stays readable.
    const updated = await prisma.governmentContact.update({ where: { id: existing.id }, data: { isArchived: true } })
    await audit(req, consultingFirmId, 'UPDATE', 'GovernmentContact', existing.id, 'Contact archived')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Partner contacts — hang off the EXISTING Partner model
// -------------------------------------------------------------

const PartnerContactSchema = z.object({
  partnerId: z.string().min(1),
  fullName: z.string().trim().min(1).max(200),
  title: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(60).nullable().optional(),
  isPrimary: z.boolean().optional(),
  status: z.nativeEnum(CrmContactStatus).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  sourceSubcontractContactId: z.string().nullable().optional(),
})

router.get('/partner-contacts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.PartnerContactWhereInput = { consultingFirmId }
    if (typeof req.query.partnerId === 'string' && req.query.partnerId) where.partnerId = req.query.partnerId
    const contacts = await prisma.partnerContact.findMany({
      where,
      orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }],
      include: { partner: { select: { id: true, name: true } } },
      take: 500,
    })
    res.json({ success: true, data: contacts })
  } catch (err) { next(err) }
})

router.post('/partner-contacts', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = PartnerContactSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid partner contact payload')
    await assertTenantRefs(consultingFirmId, { partnerId: parsed.data.partnerId })

    const created = await prisma.partnerContact.create({
      data: { ...parsed.data, consultingFirmId, createdByUserId: req.user?.userId ?? null },
    })
    await audit(req, consultingFirmId, 'CREATE', 'PartnerContact', created.id, `Partner contact ${created.fullName} created`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.put('/partner-contacts/:id', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = PartnerContactSchema.partial().omit({ partnerId: true }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid partner contact payload')
    const existing = await prisma.partnerContact.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Partner contact not found')
    const updated = await prisma.partnerContact.update({ where: { id: existing.id }, data: parsed.data })
    await audit(req, consultingFirmId, 'UPDATE', 'PartnerContact', existing.id, 'Partner contact updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/**
 * Partner CRM view — company facts already stored on Partner, its people, its
 * interaction history, the teaming record that already exists, and derived
 * relationship strength. Nothing here duplicates the teaming models.
 */
router.get('/partners/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const partner = await prisma.partner.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        contacts: { orderBy: [{ isPrimary: 'desc' }, { fullName: 'asc' }] },
        performanceRecords: { orderBy: { createdAt: 'desc' }, take: 50 },
        arrangements: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { opportunity: { select: { id: true, title: true, agency: true, responseDeadline: true } } },
        },
      },
    })
    if (!partner) throw new NotFoundError('Partner not found')

    const [activities, followUps] = await Promise.all([
      prisma.crmActivity.findMany({
        where: { consultingFirmId, partnerId: partner.id },
        orderBy: { occurredAt: 'desc' },
        take: 200,
        include: { opportunity: { select: { id: true, title: true } }, partnerContact: { select: { id: true, fullName: true } } },
      }),
      prisma.crmFollowUp.findMany({ where: { consultingFirmId, partnerId: partner.id }, orderBy: { dueAt: 'asc' } }),
    ])

    const openArrangements = partner.arrangements.filter((a) => a.teamingStatus !== 'DECLINED').length
    const relationship = computeRelationshipStrength({
      activities: activities.map((a) => ({ activityType: a.activityType, occurredAt: a.occurredAt })),
      activeOpportunityCount: openArrangements,
      openFollowUpCount: followUps.filter((f) => f.status === 'OPEN' || f.status === 'IN_PROGRESS').length,
    })

    res.json({ success: true, data: { ...partner, activities, followUps, relationship } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Activities — one system; calls and meetings are types
// -------------------------------------------------------------

const ActivitySchema = z.object({
  activityType: z.nativeEnum(CrmActivityType),
  occurredAt: z.string().datetime(),
  subject: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(4000).nullable().optional(),
  notes: z.string().trim().max(8000).nullable().optional(),
  durationMinutes: z.number().int().min(0).max(10_000).nullable().optional(),
  location: z.string().trim().max(300).nullable().optional(),
  participants: z.array(z.string().trim().max(200)).max(50).optional(),
  followUpNeeded: z.boolean().optional(),
  sourceReference: z.string().trim().max(500).nullable().optional(),
  ownerUserId: z.string().nullable().optional(),
  governmentContactId: z.string().uuid().nullable().optional(),
  agencyOfficeId: z.string().uuid().nullable().optional(),
  agencyName: z.string().trim().max(300).nullable().optional(),
  opportunityId: z.string().nullable().optional(),
  bidPursuitId: z.string().nullable().optional(),
  partnerId: z.string().nullable().optional(),
  partnerContactId: z.string().uuid().nullable().optional(),
})

router.get('/activities', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.CrmActivityWhereInput = { consultingFirmId }
    for (const key of ['governmentContactId', 'opportunityId', 'partnerId', 'bidPursuitId', 'partnerContactId'] as const) {
      const v = req.query[key]
      if (typeof v === 'string' && v) (where as Record<string, unknown>)[key] = v
    }
    if (typeof req.query.activityType === 'string' && req.query.activityType in CrmActivityType)
      where.activityType = req.query.activityType as CrmActivityType
    if (typeof req.query.agencyName === 'string' && req.query.agencyName) where.agencyName = req.query.agencyName

    const activities = await prisma.crmActivity.findMany({
      where,
      orderBy: { occurredAt: 'desc' },
      take: Math.min(Number(req.query.limit ?? 100) || 100, 300),
      include: {
        governmentContact: { select: { id: true, fullName: true, contactRole: true } },
        partner: { select: { id: true, name: true } },
        partnerContact: { select: { id: true, fullName: true } },
        opportunity: { select: { id: true, title: true, agency: true } },
      },
    })
    res.json({ success: true, data: activities })
  } catch (err) { next(err) }
})

router.post('/activities', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ActivitySchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid activity payload')
    const d = parsed.data
    await assertTenantRefs(consultingFirmId, d)

    // An activity that is attached to nothing is a floating note nobody will
    // find again, so at least one link is required.
    if (!d.governmentContactId && !d.opportunityId && !d.partnerId && !d.partnerContactId && !d.agencyOfficeId && !d.bidPursuitId) {
      throw new ValidationError('An activity must be linked to at least a contact, partner, office, opportunity or pursuit.')
    }

    const created = await prisma.crmActivity.create({
      data: {
        ...d,
        occurredAt: new Date(d.occurredAt),
        participants: d.participants ?? [],
        consultingFirmId,
        createdByUserId: req.user?.userId ?? null,
        ownerUserId: d.ownerUserId ?? req.user?.userId ?? null,
      },
    })

    // Keep the existing pipeline record's activity clock accurate rather than
    // introducing a parallel notion of "last touched".
    if (created.bidPursuitId) {
      await prisma.bidPursuit.updateMany({
        where: { id: created.bidPursuitId, consultingFirmId },
        data: { lastActivityAt: created.occurredAt },
      })
    }

    await audit(req, consultingFirmId, 'CREATE', 'CrmActivity', created.id, `${created.activityType} logged: ${created.subject}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Follow-ups
// -------------------------------------------------------------

const FollowUpSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(4000).nullable().optional(),
  dueAt: z.string().datetime(),
  priority: z.nativeEnum(CrmPriority).optional(),
  ownerUserId: z.string().nullable().optional(),
  governmentContactId: z.string().uuid().nullable().optional(),
  partnerContactId: z.string().uuid().nullable().optional(),
  partnerId: z.string().nullable().optional(),
  opportunityId: z.string().nullable().optional(),
  bidPursuitId: z.string().nullable().optional(),
  activityId: z.string().uuid().nullable().optional(),
})

/** Only these transitions are legal; anything else is refused with the options. */
const FOLLOW_UP_TRANSITIONS: Record<CrmFollowUpStatus, CrmFollowUpStatus[]> = {
  OPEN: ['IN_PROGRESS', 'DONE', 'CANCELLED'],
  IN_PROGRESS: ['DONE', 'CANCELLED', 'OPEN'],
  DONE: [],
  CANCELLED: ['OPEN'],
}

router.get('/follow-ups', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.CrmFollowUpWhereInput = { consultingFirmId }
    if (typeof req.query.status === 'string' && req.query.status in CrmFollowUpStatus)
      where.status = req.query.status as CrmFollowUpStatus
    else if (req.query.openOnly === 'true') where.status = { in: ['OPEN', 'IN_PROGRESS'] }
    for (const key of ['governmentContactId', 'partnerId', 'opportunityId', 'ownerUserId'] as const) {
      const v = req.query[key]
      if (typeof v === 'string' && v) (where as Record<string, unknown>)[key] = v
    }

    const followUps = await prisma.crmFollowUp.findMany({
      where,
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
      take: 300,
      include: {
        governmentContact: { select: { id: true, fullName: true, agencyName: true } },
        partner: { select: { id: true, name: true } },
        partnerContact: { select: { id: true, fullName: true } },
        opportunity: { select: { id: true, title: true } },
      },
    })
    res.json({ success: true, data: followUps })
  } catch (err) { next(err) }
})

router.post('/follow-ups', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = FollowUpSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid follow-up payload')
    const d = parsed.data
    await assertTenantRefs(consultingFirmId, d)

    const created = await prisma.crmFollowUp.create({
      data: {
        ...d,
        dueAt: new Date(d.dueAt),
        consultingFirmId,
        createdByUserId: req.user?.userId ?? null,
        ownerUserId: d.ownerUserId ?? req.user?.userId ?? null,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'CrmFollowUp', created.id, `Follow-up created: ${created.title}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.post('/follow-ups/:id/transition', requirePermission('CRM_WRITE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({ status: z.nativeEnum(CrmFollowUpStatus) }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid status is required')

    const existing = await prisma.crmFollowUp.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Follow-up not found')

    const allowed = FOLLOW_UP_TRANSITIONS[existing.status]
    if (!allowed.includes(parsed.data.status)) {
      // 422 with the legal options, mirroring the requirement state machine.
      res.status(422).json({
        success: false,
        error: `Cannot move a ${existing.status} follow-up to ${parsed.data.status}.`,
        code: 'INVALID_TRANSITION',
        allowedNextStates: allowed,
      })
      return
    }

    const done = parsed.data.status === 'DONE'
    const updated = await prisma.crmFollowUp.update({
      where: { id: existing.id },
      data: {
        status: parsed.data.status,
        completedAt: done ? new Date() : null,
        completedByUserId: done ? req.user?.userId ?? null : null,
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'CrmFollowUp', existing.id, `Follow-up ${parsed.data.status}`,
      { status: existing.status }, { status: updated.status })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// CRM context for an opportunity — read-only composition over
// records that already exist. No pipeline or value logic here.
// -------------------------------------------------------------

router.get('/opportunity-context/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, title: true, agency: true },
    })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    // SAM stores the agency as a dotted, inverted path
    // ("ENERGY, DEPARTMENT OF.…"), while a user types "Department of Energy".
    // Comparing those for equality found nothing, so a contact at exactly the
    // right agency never appeared here. Candidates are fetched for the tenant
    // and reconciled in memory against every tier of the path — a read-time
    // fix, so nothing SAM ingested is ever rewritten.
    const agencyPath = parseAgencyPath(opportunity.agency)
    const [allOffices, allContacts, activities, followUps, partnerLinks] = await Promise.all([
      prisma.agencyOffice.findMany({ where: { consultingFirmId, isArchived: false }, take: 500 }),
      prisma.governmentContact.findMany({
        where: { consultingFirmId, isArchived: false },
        orderBy: { fullName: 'asc' },
        take: 500,
      }),
      prisma.crmActivity.findMany({
        where: { consultingFirmId, opportunityId: opportunity.id },
        orderBy: { occurredAt: 'desc' },
        take: 25,
        include: { governmentContact: { select: { id: true, fullName: true } }, partner: { select: { id: true, name: true } } },
      }),
      prisma.crmFollowUp.findMany({
        where: { consultingFirmId, opportunityId: opportunity.id, status: { in: ['OPEN', 'IN_PROGRESS'] } },
        orderBy: { dueAt: 'asc' },
        take: 25,
      }),
      prisma.crmActivity.groupBy({
        by: ['partnerId'],
        where: { consultingFirmId, opportunityId: opportunity.id, partnerId: { not: null } },
        _count: { _all: true },
      }),
    ])

    const offices = allOffices.filter((o) => agencyMatchesPath(o.agencyName, opportunity.agency)).slice(0, 25)
    const contacts = allContacts.filter((c) => agencyMatchesPath(c.agencyName, opportunity.agency)).slice(0, 50)

    res.json({
      success: true,
      data: {
        opportunityId: opportunity.id,
        agencyName: opportunity.agency,
        /** Parsed for display: SAM's raw path is unreadable to a person. */
        agencyPath,
        offices,
        contacts,
        activities,
        nextFollowUp: followUps[0] ?? null,
        openFollowUps: followUps,
        partnersEngaged: partnerLinks.length,
        // Weighted value is deliberately absent — the portfolio service owns it.
        valueNote: 'Weighted opportunity value is provided by the portfolio service, not by the CRM.',
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Relationship strength
// -------------------------------------------------------------

async function relationshipForContact(
  consultingFirmId: string,
  contactId: string,
  preloadedActivities?: Array<{ activityType: CrmActivityType; occurredAt: Date; opportunityId?: string | null }>,
  preloadedFollowUps?: Array<{ status: CrmFollowUpStatus }>,
): Promise<RelationshipStrengthResult> {
  const activities =
    preloadedActivities ??
    (await prisma.crmActivity.findMany({
      where: { consultingFirmId, governmentContactId: contactId },
      select: { activityType: true, occurredAt: true, opportunityId: true },
    }))
  const followUps =
    preloadedFollowUps ??
    (await prisma.crmFollowUp.findMany({ where: { consultingFirmId, governmentContactId: contactId }, select: { status: true } }))

  const linkedOpportunityIds = [...new Set(activities.map((a) => a.opportunityId).filter((v): v is string => Boolean(v)))]
  const activeOpportunityCount = linkedOpportunityIds.length
    ? await prisma.bidPursuit.count({
        where: {
          consultingFirmId,
          opportunityId: { in: linkedOpportunityIds },
          closedAt: null,
          pipelineStage: { in: OPEN_PURSUIT_STATES as unknown as Prisma.EnumPipelineStageFilter['in'] },
        },
      })
    : 0

  return computeRelationshipStrength({
    activities: activities.map((a) => ({ activityType: a.activityType, occurredAt: a.occurredAt })),
    activeOpportunityCount,
    openFollowUpCount: followUps.filter((f) => f.status === 'OPEN' || f.status === 'IN_PROGRESS').length,
  })
}

router.get('/relationship/contact/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const contact = await prisma.governmentContact.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!contact) throw new NotFoundError('Contact not found')
    res.json({ success: true, data: await relationshipForContact(consultingFirmId, contact.id) })
  } catch (err) { next(err) }
})

export default router
