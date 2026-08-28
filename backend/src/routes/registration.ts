// =============================================================
// Registration, Certification & Insurance Routes (Section 5 Module 2)
// -------------------------------------------------------------
// Registration health dashboard + the native Certification & Insurance Log.
// Reads are firm-wide (any authenticated role); writes are ADMIN-only and
// tenant-scoped. Every write is audited. Expiry status is computed, never
// stored. Mirrors the conventions in routes/pastPerformance.ts.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError } from '../utils/errors'
import { logAudit } from '../services/auditService'
import { prisma } from '../config/database'
import { config } from '../config/config'
import { assertFresh } from '../utils/optimisticLock'
import { buildRegistrationHealth } from '../services/registrationHealth'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const dateField = z
  .string()
  .datetime({ message: 'Expected an ISO 8601 datetime' })
  .transform((s) => new Date(s))
  .nullable()
  .optional()

const leadDays = z.number().int().min(0).max(365).optional()

// -------------------------------------------------------------
// GET /api/registration/health — whole-firm expiry health + reminders
// -------------------------------------------------------------
router.get('/health', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [profile, certifications, policies] = await Promise.all([
      prisma.registrationProfile.findUnique({ where: { consultingFirmId } }),
      prisma.certification.findMany({ where: { consultingFirmId, isArchived: false } }),
      prisma.insurancePolicy.findMany({ where: { consultingFirmId, isArchived: false } }),
    ])
    const health = buildRegistrationHealth(profile, certifications, policies, new Date())
    res.json({ success: true, data: health })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// Registration profile (1 per firm) — GET + upsert (ADMIN)
// -------------------------------------------------------------
router.get('/profile', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const profile = await prisma.registrationProfile.findUnique({ where: { consultingFirmId } })
    res.json({ success: true, data: profile })
  } catch (err) {
    next(err)
  }
})

// UEI: exactly 12 letters/digits. Placeholder SAMPLE_* values are rejected in
// production so seed stand-ins never masquerade as a real registration.
const ueiField = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{12}$/, 'UEI must be exactly 12 letters or digits')
  .refine((s) => !(config.isProduction && /^SAMPLE/i.test(s)), 'Placeholder UEI values are not allowed')
  .nullable()
  .optional()

// CAGE code: exactly 5 letters/digits.
const cageField = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{5}$/, 'CAGE code must be exactly 5 letters or digits')
  .nullable()
  .optional()

const ProfileSchema = z.object({
  // ACTIVE | PENDING | EXPIRED | NOT_REGISTERED are the current values; INACTIVE
  // and UNKNOWN are retained so existing rows validate (no data backfill needed).
  samStatus: z.enum(['ACTIVE', 'PENDING', 'EXPIRED', 'NOT_REGISTERED', 'INACTIVE', 'UNKNOWN']).optional(),
  samExpiryDate: dateField,
  uei: ueiField,
  cageCode: cageField,
  naicsCodes: z.array(z.string().max(10)).max(200).optional(),
  setAsideCerts: z.array(z.string().max(40)).max(50).optional(),
  reminderLeadDays: leadDays,
  ownerUserId: z.string().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  // Optimistic-lock guard — client echoes the updatedAt it last read.
  updatedAt: z.string().datetime().optional(),
})

const saveProfileHandler = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { updatedAt: clientUpdatedAt, ...data } = ProfileSchema.parse(req.body)
    const before = await prisma.registrationProfile.findUnique({ where: { consultingFirmId } })
    if (before && clientUpdatedAt) assertFresh(before.updatedAt, clientUpdatedAt)
    const profile = await prisma.registrationProfile.upsert({
      where: { consultingFirmId },
      create: { consultingFirmId, ...data },
      update: data,
    })
    await logAudit({
      consultingFirmId,
      actorUserId: req.user?.userId,
      actorRole: req.user?.role,
      action: before ? 'UPDATE' : 'CREATE',
      entityType: 'RegistrationProfile',
      entityId: profile.id,
      before: before ?? undefined,
      after: profile,
    })
    res.json({ success: true, data: profile })
  } catch (err) {
    next(err)
  }
}

// PUT preserves the existing contract; PATCH matches the standard partial-update
// contract used across the platform. Both share the same handler.
router.put('/profile', requireRole('ADMIN'), saveProfileHandler)
router.patch('/profile', requireRole('ADMIN'), saveProfileHandler)

// -------------------------------------------------------------
// Certifications — CRUD (writes ADMIN)
// -------------------------------------------------------------
const CertSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.enum(['SET_ASIDE', 'QUALITY', 'SECURITY', 'REGISTRATION', 'OTHER']).optional(),
  issuingBody: z.string().max(200).nullable().optional(),
  certNumber: z.string().max(120).nullable().optional(),
  issueDate: dateField,
  expiryDate: dateField,
  reminderLeadDays: leadDays,
  ownerUserId: z.string().nullable().optional(),
  documentKey: z.string().max(500).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
})

router.get('/certifications', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const includeArchived = String(req.query.includeArchived) === 'true'
    const certifications = await prisma.certification.findMany({
      where: { consultingFirmId, ...(includeArchived ? {} : { isArchived: false }) },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'desc' }],
    })
    res.json({ success: true, data: certifications })
  } catch (err) {
    next(err)
  }
})

router.post('/certifications', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = CertSchema.parse(req.body)
    const cert = await prisma.certification.create({ data: { consultingFirmId, ...body } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'CREATE', entityType: 'Certification', entityId: cert.id })
    res.status(201).json({ success: true, data: cert })
  } catch (err) {
    next(err)
  }
})

router.put('/certifications/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = CertSchema.partial().parse(req.body)
    const existing = await prisma.certification.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Certification')
    assertFresh(existing.updatedAt, req.body?.updatedAt)
    const cert = await prisma.certification.update({ where: { id: existing.id }, data: body })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'Certification', entityId: cert.id, before: existing, after: cert })
    res.json({ success: true, data: cert })
  } catch (err) {
    next(err)
  }
})

// Soft-delete (archive) — compliance records are retained, never hard-deleted.
router.delete('/certifications/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.certification.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Certification')
    const cert = await prisma.certification.update({ where: { id: existing.id }, data: { isArchived: true } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'ARCHIVED', entityType: 'Certification', entityId: cert.id, rationale: req.body?.reason ?? 'archived' })
    res.json({ success: true, data: { id: cert.id, isArchived: true } })
  } catch (err) {
    next(err)
  }
})

router.patch('/certifications/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.certification.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Certification')
    const cert = await prisma.certification.update({ where: { id: existing.id }, data: { isArchived: false } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'RESTORED', entityType: 'Certification', entityId: cert.id })
    res.json({ success: true, data: cert })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// Insurance policies & bonds — CRUD (writes ADMIN)
// -------------------------------------------------------------
const POLICY_TYPES = ['GENERAL_LIABILITY', 'PROFESSIONAL', 'WORKERS_COMP', 'CYBER', 'SURETY_BOND', 'BID_BOND', 'PERFORMANCE_BOND', 'PAYMENT_BOND', 'OTHER'] as const

const PolicySchema = z.object({
  policyType: z.enum(POLICY_TYPES),
  carrier: z.string().max(200).nullable().optional(),
  policyNumber: z.string().max(120).nullable().optional(),
  coverageAmount: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  effectiveDate: dateField,
  expiryDate: dateField,
  reminderLeadDays: leadDays,
  ownerUserId: z.string().nullable().optional(),
  documentKey: z.string().max(500).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
})

router.get('/insurance', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const includeArchived = String(req.query.includeArchived) === 'true'
    const policies = await prisma.insurancePolicy.findMany({
      where: { consultingFirmId, ...(includeArchived ? {} : { isArchived: false }) },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'desc' }],
    })
    res.json({ success: true, data: policies })
  } catch (err) {
    next(err)
  }
})

router.post('/insurance', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = PolicySchema.parse(req.body)
    const policy = await prisma.insurancePolicy.create({ data: { consultingFirmId, ...body } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'CREATE', entityType: 'InsurancePolicy', entityId: policy.id })
    res.status(201).json({ success: true, data: policy })
  } catch (err) {
    next(err)
  }
})

router.put('/insurance/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = PolicySchema.partial().parse(req.body)
    const existing = await prisma.insurancePolicy.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('InsurancePolicy')
    assertFresh(existing.updatedAt, req.body?.updatedAt)
    const policy = await prisma.insurancePolicy.update({ where: { id: existing.id }, data: body })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'InsurancePolicy', entityId: policy.id, before: existing, after: policy })
    res.json({ success: true, data: policy })
  } catch (err) {
    next(err)
  }
})

router.delete('/insurance/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.insurancePolicy.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('InsurancePolicy')
    const policy = await prisma.insurancePolicy.update({ where: { id: existing.id }, data: { isArchived: true } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'ARCHIVED', entityType: 'InsurancePolicy', entityId: policy.id, rationale: req.body?.reason ?? 'archived' })
    res.json({ success: true, data: { id: policy.id, isArchived: true } })
  } catch (err) {
    next(err)
  }
})

router.patch('/insurance/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.insurancePolicy.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('InsurancePolicy')
    const policy = await prisma.insurancePolicy.update({ where: { id: existing.id }, data: { isArchived: false } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'RESTORED', entityType: 'InsurancePolicy', entityId: policy.id })
    res.json({ success: true, data: policy })
  } catch (err) {
    next(err)
  }
})

export default router
