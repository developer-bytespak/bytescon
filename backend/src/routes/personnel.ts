// =============================================================
// §8.3 — Personnel & resume library.
//
// `User` is the authentication identity; `Personnel` is the business identity.
// They link optionally, in both directions, because not every employee needs a
// login, proposed key personnel are often consultants or subcontractor staff,
// and a personnel record must outlive a disabled account.
//
// The honesty rule shaping every write here: nothing about a person is inferred.
// Years of experience, labour-category qualification, certifications and
// clearances are only ever what a human entered, and an approved resume is
// never edited in place.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import {
  PersonnelEmploymentType, PersonnelSource, Prisma,
  QualificationVerification, ResumeStatus,
} from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { upload } from '../middleware/upload'
import { sendAuthorizedFile } from '../services/partnerPortal/partnerFiles'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const audit = (
  req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction,
  entityType: string, entityId: string, rationale?: string, before?: unknown, after?: unknown,
) => logAudit({
  consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
  action, entityType, entityId, rationale, before, after,
})

const PersonnelSchema = z.object({
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  jobTitle: z.string().trim().max(200).nullable().optional(),
  employmentType: z.nativeEnum(PersonnelEmploymentType).optional(),
  email: z.string().trim().email().max(200).nullable().optional(),
  phone: z.string().trim().max(60).nullable().optional(),
  location: z.string().trim().max(200).nullable().optional(),
  summary: z.string().trim().max(8000).nullable().optional(),
  yearsExperience: z.number().int().min(0).max(80).nullable().optional(),
  userId: z.string().min(1).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
})

async function assertUserInTenant(consultingFirmId: string, userId?: string | null) {
  if (!userId) return
  const u = await prisma.user.findFirst({ where: { id: userId, consultingFirmId }, select: { id: true } })
  if (!u) throw new NotFoundError('User not found')
}

router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.PersonnelWhereInput = { consultingFirmId }
    if (req.query.includeArchived !== 'true') where.isArchived = false
    if (typeof req.query.search === 'string' && req.query.search) {
      where.OR = [
        { lastName: { contains: req.query.search, mode: 'insensitive' } },
        { firstName: { contains: req.query.search, mode: 'insensitive' } },
      ]
    }
    const rows = await prisma.personnel.findMany({
      where,
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      include: {
        qualifications: { select: { id: true, laborCategory: true, verification: true } },
        resumes: {
          where: { status: ResumeStatus.APPROVED },
          select: { id: true, versionNumber: true, approvedAt: true },
          orderBy: { versionNumber: 'desc' }, take: 1,
        },
        user: { select: { id: true, email: true, isActive: true } },
        _count: { select: { proposalUses: true, allocations: true } },
      },
      take: 500,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

router.post('/', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = PersonnelSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid personnel payload')
    await assertUserInTenant(consultingFirmId, parsed.data.userId)
    const created = await prisma.personnel.create({
      data: { ...parsed.data, consultingFirmId, createdByUserId: req.user?.userId ?? null },
    })
    await audit(req, consultingFirmId, 'CREATE', 'Personnel', created.id, `Personnel ${created.firstName} ${created.lastName} created`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

/**
 * Seed a personnel record from an existing account. Explicit and per-user by
 * design — personnel are never created for every User automatically, because
 * having a login is not evidence that someone is proposable staff.
 */
router.post('/import-from-user/:userId', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const user = await prisma.user.findFirst({
      where: { id: req.params.userId, consultingFirmId },
      select: { id: true, firstName: true, lastName: true, email: true },
    })
    if (!user) throw new NotFoundError('User not found')
    const existing = await prisma.personnel.findFirst({ where: { consultingFirmId, userId: user.id }, select: { id: true } })
    if (existing) throw new ValidationError('This account already has a personnel record')

    const created = await prisma.personnel.create({
      data: {
        consultingFirmId, userId: user.id,
        firstName: user.firstName ?? 'Unknown', lastName: user.lastName ?? 'Unknown',
        email: user.email, source: PersonnelSource.IMPORTED_FROM_USER,
        createdByUserId: req.user?.userId ?? null,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'Personnel', created.id, 'Personnel imported from user account')
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const person = await prisma.personnel.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        qualifications: { orderBy: { laborCategory: 'asc' } },
        resumes: { orderBy: { versionNumber: 'desc' } },
        user: { select: { id: true, email: true, isActive: true } },
        allocations: {
          select: {
            id: true, allocationPercent: true, startDate: true, endDate: true, status: true,
            contract: { select: { id: true, contractNumber: true, title: true } },
          },
          orderBy: { startDate: 'desc' }, take: 50,
        },
        proposalUses: {
          select: {
            id: true, proposalRole: true, laborCategory: true, resumeId: true,
            proposal: { select: { id: true, title: true } },
          },
          take: 50,
        },
      },
    })
    if (!person) throw new NotFoundError('Personnel not found')
    res.json({ success: true, data: person })
  } catch (err) { next(err) }
})

router.put('/:id', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.personnel.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Personnel not found')
    const parsed = PersonnelSchema.partial().safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid personnel payload')
    await assertUserInTenant(consultingFirmId, parsed.data.userId)
    const updated = await prisma.personnel.update({ where: { id: existing.id }, data: parsed.data })
    await audit(req, consultingFirmId, 'UPDATE', 'Personnel', existing.id, 'Personnel updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.post('/:id/archive', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.personnel.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Personnel not found')
    // Archive, never delete — proposal and allocation history must stay readable.
    const updated = await prisma.personnel.update({ where: { id: existing.id }, data: { isArchived: true, isActive: false } })
    await audit(req, consultingFirmId, 'UPDATE', 'Personnel', existing.id, 'Personnel archived')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

const QualSchema = z.object({
  laborCategory: z.string().trim().min(1).max(160),
  effectiveDate: z.string().datetime().nullable().optional(),
  expirationDate: z.string().datetime().nullable().optional(),
  yearsExperience: z.number().int().min(0).max(80).nullable().optional(),
  evidence: z.string().trim().max(2000).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
})

router.post('/:id/qualifications', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const person = await prisma.personnel.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!person) throw new NotFoundError('Personnel not found')
    const parsed = QualSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid qualification payload')
    const d = parsed.data

    const dup = await prisma.personnelLaborQualification.findFirst({
      where: { personnelId: person.id, laborCategory: d.laborCategory }, select: { id: true },
    })
    if (dup) throw new ValidationError('That labour category is already recorded for this person')

    const created = await prisma.personnelLaborQualification.create({
      data: {
        consultingFirmId, personnelId: person.id, laborCategory: d.laborCategory,
        effectiveDate: d.effectiveDate ? new Date(d.effectiveDate) : null,
        expirationDate: d.expirationDate ? new Date(d.expirationDate) : null,
        yearsExperience: d.yearsExperience ?? null,
        evidence: d.evidence ?? null, notes: d.notes ?? null,
        // Always starts unverified. Recording a category is not verifying it.
        verification: QualificationVerification.UNVERIFIED,
        createdByUserId: req.user?.userId ?? null,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'PersonnelLaborQualification', created.id, `Qualification ${d.laborCategory} recorded`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.post('/qualifications/:qualId/verify', requirePermission('RESUME_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({
      verification: z.nativeEnum(QualificationVerification),
      evidence: z.string().trim().max(2000).optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid verification state is required')

    const existing = await prisma.personnelLaborQualification.findFirst({
      where: { id: req.params.qualId, consultingFirmId },
    })
    if (!existing) throw new NotFoundError('Qualification not found')

    const updated = await prisma.personnelLaborQualification.update({
      where: { id: existing.id },
      data: {
        verification: parsed.data.verification,
        evidence: parsed.data.evidence ?? existing.evidence,
        verifiedByUserId: req.user?.userId ?? null,
        verifiedAt: new Date(),
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'PersonnelLaborQualification', existing.id,
      `Qualification ${parsed.data.verification}`, { verification: existing.verification }, { verification: updated.verification })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// The file fields are deliberately absent. A stored file arrives through
// POST /resumes/:resumeId/file, where multer names it, so a caller can never
// point a resume at a file it did not upload by supplying a storage key.
const ResumeSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  content: z.record(z.unknown()).optional(),
})

router.post('/:id/resumes', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const person = await prisma.personnel.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!person) throw new NotFoundError('Personnel not found')
    const parsed = ResumeSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid resume payload')

    const created = await prisma.$transaction(async (tx) => {
      const last = await tx.personnelResume.findFirst({
        where: { personnelId: person.id }, orderBy: { versionNumber: 'desc' }, select: { versionNumber: true },
      })
      return tx.personnelResume.create({
        data: {
          consultingFirmId, personnelId: person.id,
          versionNumber: (last?.versionNumber ?? 0) + 1,
          status: ResumeStatus.DRAFT,
          title: parsed.data.title ?? null,
          content: (parsed.data.content ?? {}) as Prisma.InputJsonObject,
          createdByUserId: req.user?.userId ?? null,
        },
      })
    })
    await audit(req, consultingFirmId, 'CREATE', 'PersonnelResume', created.id, `Resume v${created.versionNumber} drafted`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

/** Only a DRAFT may be edited. An approved version is evidence and is immutable. */
router.put('/resumes/:resumeId', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.personnelResume.findFirst({ where: { id: req.params.resumeId, consultingFirmId } })
    if (!existing) throw new NotFoundError('Resume not found')
    if (existing.status !== ResumeStatus.DRAFT) {
      res.status(422).json({
        success: false, code: 'RESUME_IMMUTABLE',
        error: `A ${existing.status} resume cannot be edited. Create a new version instead — approved resumes are the evidence a proposal was built on.`,
      })
      return
    }
    const parsed = ResumeSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid resume payload')

    const updated = await prisma.personnelResume.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.content !== undefined ? { content: parsed.data.content as Prisma.InputJsonObject } : {}),
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'PersonnelResume', existing.id, 'Draft resume updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/**
 * Attach the real resume document to a version.
 *
 * The file lands on the exact VERSION, not on the person: a resume version is
 * the evidence a proposal was built on, and a file that could be swapped
 * underneath an approved version would make that evidence worthless. So an
 * approved, superseded or archived version refuses the write with the same
 * RESUME_IMMUTABLE contract as an edit — replacing the document means creating
 * a new draft version.
 *
 * MIME and size are validated by the upload middleware, which reads the
 * declared type rather than the extension.
 */
router.post('/resumes/:resumeId/file', requirePermission('PERSONNEL_MANAGE'), upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.personnelResume.findFirst({
      where: { id: req.params.resumeId, consultingFirmId },
      select: { id: true, status: true, versionNumber: true, personnelId: true },
    })
    if (!existing) throw new NotFoundError('Resume not found')
    if (existing.status !== ResumeStatus.DRAFT) {
      res.status(422).json({
        success: false, code: 'RESUME_IMMUTABLE',
        error: `A ${existing.status} resume cannot have its document replaced. Create a new draft version instead — approved resumes are the evidence a proposal was built on.`,
      })
      return
    }
    const file = (req as unknown as { file?: Express.Multer.File }).file
    if (!file) throw new ValidationError('A file is required')

    const updated = await prisma.personnelResume.update({
      where: { id: existing.id },
      data: {
        fileName: file.originalname,
        // From the validated upload, never from the file name.
        fileType: file.mimetype,
        fileSize: file.size,
        storageKey: file.filename ?? file.path,
      },
      select: { id: true, versionNumber: true, status: true, fileName: true, fileType: true, fileSize: true },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'PersonnelResume', existing.id,
      `Resume v${existing.versionNumber} document attached`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/** Read a resume document. Tenant-scoped; no other firm's file is reachable. */
router.get('/resumes/:resumeId/file', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const resume = await prisma.personnelResume.findFirst({
      where: { id: req.params.resumeId, consultingFirmId },
      select: { id: true, fileName: true, fileType: true, storageKey: true },
    })
    if (!resume) throw new NotFoundError('Resume not found')
    sendAuthorizedFile(res, resume)
  } catch (err) { next(err) }
})

/**
 * Approve a draft. Any previously approved version is superseded in the same
 * transaction, so a person has at most one approved resume and the superseded
 * one stays on the record.
 */
router.post('/resumes/:resumeId/approve', requirePermission('RESUME_APPROVE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const resume = await prisma.personnelResume.findFirst({ where: { id: req.params.resumeId, consultingFirmId } })
    if (!resume) throw new NotFoundError('Resume not found')
    if (resume.status !== ResumeStatus.DRAFT) {
      res.status(422).json({
        success: false, code: 'INVALID_TRANSITION',
        error: `Only a DRAFT resume can be approved; this one is ${resume.status}.`,
        allowedNextStates: resume.status === ResumeStatus.APPROVED ? ['SUPERSEDED', 'ARCHIVED'] : [],
      })
      return
    }

    const result = await prisma.$transaction(async (tx) => {
      const current = await tx.personnelResume.findFirst({
        where: { consultingFirmId, personnelId: resume.personnelId, status: ResumeStatus.APPROVED },
        select: { id: true },
      })
      if (current) {
        await tx.personnelResume.update({
          where: { id: current.id },
          data: { status: ResumeStatus.SUPERSEDED, supersededAt: new Date() },
        })
      }
      return tx.personnelResume.update({
        where: { id: resume.id },
        data: {
          status: ResumeStatus.APPROVED,
          approvedByUserId: req.user?.userId ?? null,
          approvedAt: new Date(),
          supersedesResumeId: current?.id ?? null,
        },
      })
    })

    await audit(req, consultingFirmId, 'APPROVAL', 'PersonnelResume', resume.id,
      `Resume v${resume.versionNumber} approved`, { status: resume.status }, { status: result.status })
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Proposal key personnel
// -------------------------------------------------------------

router.get('/proposals/:proposalId/key-personnel', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const proposal = await prisma.proposal.findFirst({ where: { id: req.params.proposalId, consultingFirmId }, select: { id: true } })
    if (!proposal) throw new NotFoundError('Proposal not found')
    const rows = await prisma.proposalKeyPersonnel.findMany({
      where: { consultingFirmId, proposalId: proposal.id },
      include: {
        personnel: { select: { id: true, firstName: true, lastName: true, jobTitle: true, isArchived: true } },
        resume: { select: { id: true, versionNumber: true, status: true, approvedAt: true } },
      },
    })
    res.json({
      success: true,
      data: {
        items: rows,
        provenanceNote:
          'Each selection keeps a snapshot for the record and a live link to the personnel record and the exact resume version used. The source resume is immutable, so the two can never silently diverge.',
      },
    })
  } catch (err) { next(err) }
})

const KeyPersonnelSchema = z.object({
  personnelId: z.string().uuid(),
  resumeId: z.string().uuid().nullable().optional(),
  proposalRole: z.string().trim().max(200).nullable().optional(),
  laborCategory: z.string().trim().max(160).nullable().optional(),
  snapshot: z.record(z.unknown()).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
})

router.post('/proposals/:proposalId/key-personnel', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const proposal = await prisma.proposal.findFirst({ where: { id: req.params.proposalId, consultingFirmId }, select: { id: true } })
    if (!proposal) throw new NotFoundError('Proposal not found')
    const parsed = KeyPersonnelSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid key-personnel payload')
    const d = parsed.data

    const person = await prisma.personnel.findFirst({ where: { id: d.personnelId, consultingFirmId }, select: { id: true } })
    if (!person) throw new NotFoundError('Personnel not found')

    if (d.resumeId) {
      const resume = await prisma.personnelResume.findFirst({
        where: { id: d.resumeId, consultingFirmId, personnelId: person.id },
        select: { id: true, status: true },
      })
      if (!resume) throw new NotFoundError('Resume not found')
      // Only approved evidence may back a proposal submission.
      if (resume.status !== ResumeStatus.APPROVED) {
        throw new ValidationError(`Only an APPROVED resume can be used on a proposal; this one is ${resume.status}.`)
      }
    }

    const dup = await prisma.proposalKeyPersonnel.findFirst({
      where: { proposalId: proposal.id, personnelId: person.id }, select: { id: true },
    })
    if (dup) throw new ValidationError('That person is already on this proposal')

    const created = await prisma.proposalKeyPersonnel.create({
      data: {
        consultingFirmId, proposalId: proposal.id, personnelId: person.id,
        resumeId: d.resumeId ?? null,
        proposalRole: d.proposalRole ?? null,
        laborCategory: d.laborCategory ?? null,
        snapshot: (d.snapshot ?? {}) as Prisma.InputJsonObject,
        notes: d.notes ?? null,
        createdByUserId: req.user?.userId ?? null,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'ProposalKeyPersonnel', created.id, 'Key personnel selected for proposal')
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.delete('/key-personnel/:id', requirePermission('PERSONNEL_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.proposalKeyPersonnel.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Selection not found')
    await prisma.proposalKeyPersonnel.delete({ where: { id: existing.id } })
    await audit(req, consultingFirmId, 'DELETE', 'ProposalKeyPersonnel', existing.id, 'Key personnel removed from proposal')
    res.json({ success: true, data: { removed: true } })
  } catch (err) { next(err) }
})

export default router
