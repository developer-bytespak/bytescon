import { Router, Response, NextFunction } from 'express'
import path from 'path'
import fs from 'fs'
import { prisma } from '../config/database'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { upload } from '../middleware/upload'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logger } from '../utils/logger'
import { anonymizeDocument } from '../services/anonymizer'
import { requirePlatformAdmin, isPlatformAdmin } from '../middleware/platformAdmin'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const ALLOWED_TYPES = ['.docx', '.txt', '.md']
const DOC_TYPE_LABELS: Record<string, string> = {
  CAPABILITY_STATEMENT: 'Capability Statement',
  PAST_PERFORMANCE: 'Past Performance',
  TECHNICAL_PROPOSAL: 'Technical Proposal',
  MANAGEMENT_APPROACH: 'Management Approach',
  PRICE_VOLUME: 'Price/Cost Volume',
  SMALL_BUSINESS_PLAN: 'Small Business Plan',
  TEAMING_AGREEMENT: 'Teaming Agreement',
  COVER_LETTER: 'Cover Letter',
  OTHER: 'Other',
}

// ---------------------------------------------------------------
// POST /api/client-documents/upload
// ---------------------------------------------------------------
router.post('/upload', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { clientCompanyId, documentType = 'OTHER', title, notes } = req.body
    const file = req.file

    if (!file) throw new ValidationError('No file uploaded')
    if (!clientCompanyId) throw new ValidationError('clientCompanyId required')
    if (!title || !title.trim()) throw new ValidationError('title required')

    const ext = path.extname(file.originalname).toLowerCase()
    if (!ALLOWED_TYPES.includes(ext)) {
      fs.unlinkSync(file.path)
      throw new ValidationError(`File type not supported. Upload ${ALLOWED_TYPES.join(', ')} only.`)
    }

    // Verify client belongs to this firm
    const client = await prisma.clientCompany.findFirst({
      where: { id: clientCompanyId, consultingFirmId },
    })
    if (!client) throw new NotFoundError('ClientCompany')

    const storageKey = path.basename(file.path)
    const fileUrl = `/uploads/${storageKey}`

    const doc = await prisma.clientDocument.create({
      data: {
        consultingFirmId,
        clientCompanyId,
        documentType: documentType as any,
        fileName: file.originalname,
        fileType: ext.replace('.', '').toUpperCase(),
        fileSize: file.size,
        storageKey,
        fileUrl,
        title: title.trim(),
        notes: notes?.trim() || null,
      },
    })

    res.status(201).json({ success: true, data: doc })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/client-documents?clientCompanyId=:id
// ---------------------------------------------------------------
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { clientCompanyId } = req.query

    if (!clientCompanyId) throw new ValidationError('clientCompanyId required')

    const client = await prisma.clientCompany.findFirst({
      where: { id: String(clientCompanyId), consultingFirmId },
    })
    if (!client) throw new NotFoundError('ClientCompany')

    const docs = await prisma.clientDocument.findMany({
      where: { clientCompanyId: String(clientCompanyId), consultingFirmId },
      orderBy: { createdAt: 'desc' },
      include: { sharedTemplate: { select: { id: true, status: true } } },
    })

    res.json({ success: true, data: docs })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/client-documents/:id/download  (authenticated)
// ---------------------------------------------------------------
router.get('/:id/download', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const doc = await prisma.clientDocument.findFirst({
      where: { id: req.params.id, consultingFirmId },
    })
    if (!doc) throw new NotFoundError('ClientDocument')

    const filePath = path.join(process.cwd(), 'uploads', doc.storageKey)
    if (!fs.existsSync(filePath)) throw new NotFoundError('File not found on disk')

    res.download(filePath, doc.fileName)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// DELETE /api/client-documents/:id
// ---------------------------------------------------------------
router.delete('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const doc = await prisma.clientDocument.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: { sharedTemplate: true },
    })
    if (!doc) throw new NotFoundError('ClientDocument')

    // Delete anonymized file if it exists
    if (doc.sharedTemplate?.anonymizedStorageKey) {
      const anonPath = path.join(process.cwd(), 'uploads', doc.sharedTemplate.anonymizedStorageKey)
      if (fs.existsSync(anonPath)) fs.unlinkSync(anonPath)
    }

    // Delete original file
    const filePath = path.join(process.cwd(), 'uploads', doc.storageKey)
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)

    await prisma.clientDocument.delete({ where: { id: doc.id } })

    res.json({ success: true, data: { message: 'Document deleted' } })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// POST /api/client-documents/:id/share-as-template
// ---------------------------------------------------------------
router.post('/:id/share-as-template', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { title, description } = req.body

    if (!title?.trim()) throw new ValidationError('title required for template')

    const doc = await prisma.clientDocument.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        clientCompany: { select: { name: true } },
        sharedTemplate: true,
      },
    })
    if (!doc) throw new NotFoundError('ClientDocument')
    if (doc.isSharedAsTemplate) throw new ValidationError('Already submitted as a template')

    const inputPath = path.join(process.cwd(), 'uploads', doc.storageKey)
    if (!fs.existsSync(inputPath)) throw new ValidationError('Original file no longer found')

    const anonKey = `anon-${Date.now()}-${Math.round(Math.random() * 1e9)}.txt`
    const anonPath = path.join(process.cwd(), 'uploads', anonKey)

    const { patternsReplaced, outputPath } = await anonymizeDocument(
      inputPath,
      anonPath,
      doc.clientCompany.name,
    )

    const finalKey = path.basename(outputPath)

    const template = await prisma.sharedTemplate.create({
      data: {
        sourceDocumentId: doc.id,
        submittedByFirmId: consultingFirmId,
        documentType: doc.documentType,
        title: title.trim(),
        description: description?.trim() || null,
        anonymizedStorageKey: finalKey,
      },
    })

    await prisma.clientDocument.update({
      where: { id: doc.id },
      data: { isSharedAsTemplate: true },
    })

    logger.info('Template submitted for review', { templateId: template.id, patternsReplaced })

    res.status(201).json({ success: true, data: template })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/client-documents/templates   (public to all auth users)
// ---------------------------------------------------------------
router.get('/templates', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { documentType, page = '1', limit = '20' } = req.query
    const pageNum = parseInt(String(page))
    const limitNum = Math.min(parseInt(String(limit)), 50)

    const where: any = { status: 'APPROVED' }
    if (documentType) where.documentType = String(documentType)

    const [templates, total] = await Promise.all([
      prisma.sharedTemplate.findMany({
        where,
        orderBy: { downloadCount: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        select: {
          id: true,
          documentType: true,
          title: true,
          description: true,
          downloadCount: true,
          createdAt: true,
        },
      }),
      prisma.sharedTemplate.count({ where }),
    ])

    res.json({ success: true, data: templates, meta: { page: pageNum, total, totalPages: Math.ceil(total / limitNum) } })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/client-documents/templates/download/:id
// ---------------------------------------------------------------
router.get('/templates/download/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const template = await prisma.sharedTemplate.findFirst({
      where: { id: req.params.id, status: 'APPROVED' },
    })
    if (!template) throw new NotFoundError('SharedTemplate')

    const filePath = path.join(process.cwd(), 'uploads', template.anonymizedStorageKey)
    if (!fs.existsSync(filePath)) throw new NotFoundError('Template file')

    await prisma.sharedTemplate.update({
      where: { id: template.id },
      data: { downloadCount: { increment: 1 } },
    })

    const safeTitle = template.title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/ /g, '_')
    res.download(filePath, `${safeTitle}_template.txt`)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/client-documents/templates/admin  (admin only)
// ---------------------------------------------------------------
router.get('/templates/admin', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Tenant-scope: an admin only sees templates submitted by their OWN firm.
    // Without this, any admin can enumerate every firm's templates — a
    // cross-tenant leak that becomes material once many users hold ADMIN.
    // (Cross-firm moderation would require a dedicated platform-admin role.)
    const templates = await prisma.sharedTemplate.findMany({
      where: { submittedByFirmId: getTenantId(req) },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, documentType: true, title: true, description: true,
        status: true, reviewNotes: true, downloadCount: true, createdAt: true,
        submittedByFirm: { select: { name: true } },
      },
    })
    res.json({ success: true, data: templates })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/client-documents/templates/admin/pending  (PLATFORM ADMIN)
// Cross-firm moderation queue: every template awaiting review.
// ---------------------------------------------------------------
router.get('/templates/admin/pending', requirePlatformAdmin, async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const templates = await prisma.sharedTemplate.findMany({
      where: { status: 'PENDING_REVIEW' },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, documentType: true, title: true, description: true,
        status: true, createdAt: true,
        submittedByFirm: { select: { id: true, name: true } },
      },
    })
    res.json({ success: true, data: templates })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/client-documents/templates/admin/can-moderate
// Lightweight check the frontend uses to decide whether to show the moderation
// view. Any authenticated user may call it; it just reports their own status.
// ---------------------------------------------------------------
router.get('/templates/admin/can-moderate', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { canModerate: isPlatformAdmin(req.user?.email) } })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/client-documents/templates/admin/:id/file  (PLATFORM ADMIN)
// Preview the anonymized file for review BEFORE approval — the public download
// only serves APPROVED templates, so a reviewer otherwise could not inspect it.
// ---------------------------------------------------------------
router.get('/templates/admin/:id/file', requirePlatformAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const template = await prisma.sharedTemplate.findUnique({ where: { id: req.params.id } })
    if (!template) throw new NotFoundError('SharedTemplate')
    const filePath = path.join(process.cwd(), 'uploads', template.anonymizedStorageKey)
    if (!fs.existsSync(filePath)) throw new NotFoundError('Template file')
    const safeTitle = template.title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/ /g, '_')
    res.download(filePath, `${safeTitle}_REVIEW.txt`)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// POST /api/client-documents/templates/:id/review  (PLATFORM ADMIN)
// Independent cross-tenant review — NOT the submitting firm's own admin.
// Self-approval previously let a firm publish its own (weakly anonymized)
// client document to every tenant with no oversight (C5). Approving requires an
// explicit attestation that the file has been verified de-identified.
// ---------------------------------------------------------------
router.post('/templates/:id/review', requirePlatformAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { status, reviewNotes, deidentificationConfirmed } = req.body
    if (!['APPROVED', 'REJECTED'].includes(status)) throw new ValidationError('status must be APPROVED or REJECTED')
    if (status === 'APPROVED' && deidentificationConfirmed !== true) {
      throw new ValidationError(
        'Approving requires deidentificationConfirmed:true — confirm the file is verified de-identified (no client names, PII, or CUI) before exposing it cross-tenant.',
      )
    }

    const template = await prisma.sharedTemplate.findUnique({ where: { id: req.params.id } })
    if (!template) throw new NotFoundError('SharedTemplate')

    const updated = await prisma.sharedTemplate.update({
      where: { id: template.id },
      data: { status, reviewNotes: reviewNotes || null },
    })

    logger.info('Shared template reviewed by platform admin', {
      templateId: template.id,
      submittedByFirmId: template.submittedByFirmId,
      status,
      reviewer: req.user?.email,
    })

    res.json({ success: true, data: updated })
  } catch (err) {
    next(err)
  }
})

export default router
