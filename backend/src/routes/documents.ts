import { Router, Response, NextFunction } from 'express'
import path from 'path'
import fs from 'fs'
import AdmZip from 'adm-zip'
import { prisma } from '../config/database'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { upload } from '../middleware/upload'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logger } from '../utils/logger'
import { queueAnalysisForUpload } from '../workers/documentAnalysisWorker'
import { emitSolicitationDocumentAdded } from '../services/agents/compliance/complianceEvents'

const ALLOWED_EXTRACTED = new Set(['.docx', '.doc', '.txt', '.md', '.pdf'])
const MAX_ZIP_ENTRIES = 20
const MAX_EXTRACTED_SIZE = 10 * 1024 * 1024 // 10 MB per file

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('contract_analysis'))

// POST /api/documents/upload
router.post('/upload', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.body
    if (!opportunityId) throw new ValidationError('opportunityId required')
    if (!req.file) throw new ValidationError('File required')

    const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId } })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    // Prevent duplicate uploads of the same file to the same opportunity
    const existing = await prisma.opportunityDocument.findFirst({
      where: { opportunityId, fileName: req.file.originalname },
    })
    if (existing) {
      fs.unlinkSync(req.file.path)
      return res.status(409).json({
        success: false,
        error: `"${req.file.originalname}" has already been uploaded for this opportunity. Delete it first or upload a different file.`,
      })
    }

    // §7.3 — the document write and SOLICITATION_DOCUMENT_ADDED share one
    // transaction, so a rolled-back upload emits zero events.
    const document = await prisma.$transaction(async (tx) => {
      const row = await tx.opportunityDocument.create({
        data: {
          opportunityId,
          fileName: req.file!.originalname,
          fileUrl: null,
          storageKey: req.file!.filename,
          fileType: req.file!.mimetype,
          fileSize: req.file!.size,
          isAmendment: req.body.isAmendment === 'true',
          analysisStatus: 'PENDING',
          extractionStatus: 'PENDING',  // Initialize extraction status
        },
      })
      await emitSolicitationDocumentAdded(tx, {
        consultingFirmId,
        documentId: row.id,
        opportunityId,
        fileName: row.fileName,
        fileType: row.fileType,
        isAmendment: row.isAmendment,
      })
      return row
    })

    // Queue requirement extraction as background job
    try {
      const { queueRequirementExtraction } = await import('../workers/requirementExtractionWorker');
      await queueRequirementExtraction(document.id);
      logger.info('Document uploaded and extraction queued', {
        documentId: document.id,
        opportunityId,
      });
    } catch (queueErr) {
      logger.error('Failed to queue requirement extraction', {
        documentId: document.id,
        error: String(queueErr),
      });
      // Don't fail the upload if queueing fails — extraction can be triggered manually
    }

    // Also queue the deeper scope/complexity/incumbent analysis (feeds
    // documentIntelScore + re-scoring). Previously only requirement extraction
    // ran here, so attached docs never updated the opportunity's win score.
    await queueAnalysisForUpload(document.id, consultingFirmId)

    res.json({
      success: true,
      data: {
        ...document,
        fileUrl: `/api/documents/download/${document.id}`,
        message: 'Document uploaded. Requirement extraction and scope analysis in progress.',
      },
    })
  } catch (err) { next(err) }
})

// POST /api/documents/upload-zip
// Accepts a .zip file, extracts allowed document types, creates a DB record for each
router.post('/upload-zip', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.body
    if (!opportunityId) throw new ValidationError('opportunityId required')
    if (!req.file) throw new ValidationError('File required')
    if (!req.file.originalname.toLowerCase().endsWith('.zip')) {
      fs.unlinkSync(req.file.path)
      throw new ValidationError('Only .zip files are accepted on this endpoint')
    }

    const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId } })
    if (!opportunity) { fs.unlinkSync(req.file.path); throw new NotFoundError('Opportunity not found') }

    const zip = new AdmZip(req.file.path)
    const entries = zip.getEntries().filter((e) => {
      if (e.isDirectory) return false
      const ext = path.extname(e.entryName).toLowerCase()
      if (!ALLOWED_EXTRACTED.has(ext)) return false
      if (e.header.size > MAX_EXTRACTED_SIZE) return false
      return true
    }).slice(0, MAX_ZIP_ENTRIES)

    if (entries.length === 0) {
      fs.unlinkSync(req.file.path)
      return res.status(422).json({ success: false, error: 'No supported files found in zip. Supported: .docx .doc .txt .md .pdf (max 10 MB each)' })
    }

    const uploadsDir = path.join(process.cwd(), 'uploads')
    const created: any[] = []

    for (const entry of entries) {
      const baseName = path.basename(entry.entryName)
      const ext = path.extname(baseName).toLowerCase()
      const storageKey = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
      const destPath = path.join(uploadsDir, storageKey)

      const existing = await prisma.opportunityDocument.findFirst({ where: { opportunityId, fileName: baseName } })
      if (existing) continue // skip duplicates silently

      zip.extractEntryTo(entry, uploadsDir, false, true, false, storageKey)

      const doc = await prisma.opportunityDocument.create({
        data: {
          opportunityId,
          fileName: baseName,
          fileUrl: null,
          storageKey,
          fileType: ext === '.pdf' ? 'application/pdf' : ext === '.docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/plain',
          fileSize: fs.existsSync(destPath) ? fs.statSync(destPath).size : entry.header.size,
          isAmendment: false,
          analysisStatus: 'PENDING',
        },
      })
      created.push({ ...doc, fileUrl: `/api/documents/download/${doc.id}` })
    }

    // Clean up the uploaded zip
    fs.unlinkSync(req.file.path)

    // Queue requirement extraction + scope analysis for every extracted file.
    // Previously zip-extracted docs were created PENDING and never analyzed.
    // The analysis worker is concurrency-capped, so a 20-file zip is throttled.
    try {
      const { queueRequirementExtraction } = await import('../workers/requirementExtractionWorker')
      for (const c of created) {
        await queueRequirementExtraction(c.id).catch((e) =>
          logger.warn('Zip doc requirement extraction enqueue failed', { documentId: c.id, error: String(e) }),
        )
        await queueAnalysisForUpload(c.id, consultingFirmId)
      }
    } catch (queueErr) {
      logger.error('Failed to queue analysis for zip docs', { opportunityId, error: String(queueErr) })
    }

    logger.info('Zip extracted', { opportunityId, count: created.length })
    res.json({ success: true, data: created, message: `Extracted ${created.length} file(s) from zip` })
  } catch (err) { next(err) }
})

// GET /api/documents/download/:documentId
router.get('/download/:documentId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const doc = await prisma.opportunityDocument.findFirst({
      where: { id: req.params.documentId },
      include: { opportunity: { select: { consultingFirmId: true } } },
    })
    if (!doc || doc.opportunity.consultingFirmId !== consultingFirmId) {
      throw new NotFoundError('Document not found')
    }

    const filePath = path.join(process.cwd(), 'uploads', doc.storageKey)
    if (!fs.existsSync(filePath)) {
      throw new NotFoundError('Document file not found')
    }

    res.setHeader('Content-Type', doc.fileType)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.download(filePath, doc.fileName)
  } catch (err) {
    next(err)
  }
})

// GET /api/documents/:opportunityId
router.get('/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId } })
    if (!opportunity) throw new NotFoundError('Opportunity not found')
    const documents = await prisma.opportunityDocument.findMany({
      where: { opportunityId: req.params.opportunityId },
      orderBy: { uploadedAt: 'desc' },
    })
    res.json({
      success: true,
      data: documents.map((doc) => ({
        ...doc,
        fileUrl: `/api/documents/download/${doc.id}`,
      })),
    })
  } catch (err) { next(err) }
})

// DELETE /api/documents/:documentId
router.delete('/:documentId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const doc = await prisma.opportunityDocument.findFirst({ where: { id: req.params.documentId }, include: { opportunity: { select: { consultingFirmId: true } } } })
    if (!doc || doc.opportunity.consultingFirmId !== consultingFirmId) throw new NotFoundError('Document not found')
    if (doc.storageKey) {
      const filePath = path.join(process.cwd(), 'uploads', doc.storageKey)
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    }
    await prisma.opportunityDocument.delete({ where: { id: req.params.documentId } })
    res.json({ success: true })
  } catch (err) { next(err) }
})

export default router
