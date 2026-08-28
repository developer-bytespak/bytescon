// =============================================================
// Manual Contract Upload Route
// Accepts PDF/Word RFP/SOW, extracts metadata via AI,
// creates an Opportunity + OpportunityDocument, returns opportunityId
// =============================================================
import { Router, Response, NextFunction } from 'express'
import path from 'path'
import fs from 'fs'
import { prisma } from '../config/database'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { upload } from '../middleware/upload'
import { ValidationError } from '../utils/errors'
import { logger } from '../utils/logger'
import { generateWithRouter } from '../services/llm/llmRouter'
import { DocumentAnalysisService } from '../services/documentAnalysis'
import { queueAnalysisForUpload } from '../workers/documentAnalysisWorker'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('contract_analysis'))

const docAnalysisService = new DocumentAnalysisService()

const EXTRACTION_SYSTEM_PROMPT = `You are a federal contracting metadata extractor. Extract structured information from this government contract document (RFP, SOW, solicitation, or amendment).

Return ONLY valid JSON with this exact structure — no markdown, no preamble:
{
  "title": "contract title or solicitation name",
  "agency": "issuing agency name",
  "subagency": "sub-agency or office if present, otherwise null",
  "naicsCode": "6-digit NAICS code if mentioned, otherwise null",
  "setAsideType": "one of: SDVOSB, WOSB, 8A, HUBZone, SB, NONE — based on any set-aside language",
  "estimatedValue": numeric dollar amount if mentioned (no commas/symbols), otherwise null,
  "responseDeadline": "ISO 8601 date string if a due date is mentioned, otherwise null",
  "solicitationNumber": "solicitation/contract number if present, otherwise null",
  "description": "2-4 sentence summary of the scope of work",
  "placeOfPerformance": "city, state or region if mentioned, otherwise null",
  "noticeType": "one of: Solicitation, Sources Sought, Presolicitation, Award Notice, Other"
}

If a field cannot be determined from the document, use null. Extract only what is actually in the document.`

// POST /api/contracts/upload
router.post('/upload', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let storedFilePath: string | null = null

  try {
    const consultingFirmId = getTenantId(req)
    if (!req.file) throw new ValidationError('File is required')

    storedFilePath = req.file.path
    const ext = path.extname(req.file.originalname).toLowerCase()

    // Extract text content from the document
    let content: string
    try {
      if (ext === '.pdf') {
        content = await (docAnalysisService as any).extractPdfText(storedFilePath)
      } else {
        content = fs.readFileSync(storedFilePath, 'utf-8')
      }
    } catch {
      content = ''
    }

    if (!content || content.trim().length < 50) {
      throw new ValidationError('Could not extract text from document. Please ensure the file is readable and not password-protected.')
    }

    // Run AI metadata extraction (truncate to 20k chars to stay within token limits)
    const truncated = content.slice(0, 20000)
    let extracted: any = {}

    try {
      const firmRecord = await prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        select: { anthropicApiKey: true, openaiApiKey: true, llmProvider: true, localaiBaseUrl: true, localaiModel: true },
      })

      if (firmRecord?.anthropicApiKey || firmRecord?.openaiApiKey) {
        const response = await generateWithRouter(
          {
            systemPrompt: EXTRACTION_SYSTEM_PROMPT,
            userPrompt: truncated,
            maxTokens: 1000,
            temperature: 0.1,
          },
          consultingFirmId,
          { task: 'DOCUMENT_ANALYSIS', useCache: false }
        )

        try {
          const cleaned = response.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
          const start = cleaned.indexOf('{')
          const end = cleaned.lastIndexOf('}')
          if (start !== -1 && end !== -1) {
            extracted = JSON.parse(cleaned.slice(start, end + 1))
          }
        } catch (parseErr) {
          logger.warn('Failed to parse extraction JSON, proceeding with filename-based defaults', { error: (parseErr as Error).message })
        }
      }
    } catch (llmErr: any) {
      // Non-fatal — proceed with defaults if LLM unavailable
      logger.warn('LLM extraction skipped', { error: llmErr.message })
    }

    // Build opportunity record from extracted data + sensible defaults
    const title = extracted.title || req.file.originalname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ')
    const agency = extracted.agency || 'Unknown Agency'
    const naicsCode = extracted.naicsCode || ''
    const setAsideType = extracted.setAsideType || 'NONE'
    const estimatedValue = extracted.estimatedValue && !isNaN(Number(extracted.estimatedValue))
      ? Number(extracted.estimatedValue)
      : null

    let responseDeadline: Date
    try {
      responseDeadline = extracted.responseDeadline
        ? new Date(extracted.responseDeadline)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // default: 30 days
      if (isNaN(responseDeadline.getTime())) throw new Error('invalid date')
    } catch {
      responseDeadline = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    }

    // Create the opportunity and document in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const opportunity = await tx.opportunity.create({
        data: {
          consultingFirmId,
          title,
          agency,
          subagency: extracted.subagency || null,
          naicsCode,
          setAsideType,
          estimatedValue: estimatedValue ?? undefined,
          responseDeadline,
          description: extracted.description || null,
          placeOfPerformance: extracted.placeOfPerformance || null,
          noticeType: extracted.noticeType || 'Solicitation',
          samNoticeId: null, // manual upload — no SAM notice ID
          sourceUrl: `MANUAL:${req.file!.originalname}`,
          status: 'ACTIVE',
        },
      })

      const document = await tx.opportunityDocument.create({
        data: {
          opportunityId: opportunity.id,
          fileName: req.file!.originalname,
          storageKey: req.file!.filename,
          fileType: req.file!.mimetype,
          fileSize: req.file!.size,
          analysisStatus: 'PENDING',
          // Persist the AI metadata-extraction output for audit / re-analysis.
          rawAnalysis: extracted && Object.keys(extracted).length ? extracted : undefined,
        },
      })

      return { opportunity, document }
    })

    // Queue the deeper scope analysis (complexity, alignment, incumbent signals)
    // that the UI promises on upload. Previously this never ran for manual
    // contracts, so documentIntelScore stayed null and dragged scoring to a
    // flat 0.5 doc-alignment default. Best-effort — never fails the upload.
    await queueAnalysisForUpload(result.document.id, consultingFirmId)

    logger.info('Manual contract uploaded', {
      opportunityId: result.opportunity.id,
      documentId: result.document.id,
      title,
      agency,
      consultingFirmId,
    })

    res.status(201).json({
      success: true,
      data: {
        opportunityId: result.opportunity.id,
        documentId: result.document.id,
        extracted: {
          title,
          agency,
          naicsCode: naicsCode || null,
          setAsideType,
          estimatedValue,
          responseDeadline: responseDeadline.toISOString(),
          description: extracted.description || null,
          solicitationNumber: extracted.solicitationNumber || null,
          noticeType: extracted.noticeType || 'Solicitation',
        },
      },
    })
  } catch (err) {
    // If we failed after the file was saved but before creating the DB record, clean up the file
    if (storedFilePath && !req.file?.path) {
      try { fs.unlinkSync(storedFilePath) } catch {}
    }
    next(err)
  }
})

// GET /api/contracts/manual — list manually uploaded contracts for this firm
router.get('/manual', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opps = await prisma.opportunity.findMany({
      where: {
        consultingFirmId,
        sourceUrl: { startsWith: 'MANUAL:' },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        title: true,
        agency: true,
        naicsCode: true,
        estimatedValue: true,
        responseDeadline: true,
        status: true,
        isScored: true,
        probabilityScore: true,
        noticeType: true,
        createdAt: true,
        sourceUrl: true,
        documents: { select: { id: true, fileName: true, analysisStatus: true }, take: 1 },
      },
    })
    res.json({ success: true, data: opps })
  } catch (err) { next(err) }
})

export default router
