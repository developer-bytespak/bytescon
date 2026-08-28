import * as path from 'path'
import { Router, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { authenticateJWT } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { checkAiCallLimit, checkProposalTokens, deductProposalTokens } from '../middleware/tierGate'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors'
import { logger } from '../utils/logger'
import { generateComplianceMatrix, extractTextFromDocument, generateBidGuidance, EnrichmentContext } from '../services/complianceMatrixService'
import { analyzeOpportunityCompliance } from '../services/complianceGapAnalysis'
import { extractComplianceRequirements, dedupeAgainstExisting, REQUIREMENT_TYPES } from '../services/complianceExtraction'
import { logAudit } from '../services/auditService'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('contract_analysis'))

/** Strip null bytes that PostgreSQL UTF-8 rejects */
function stripNulls(s: string): string {
  return s.replace(/\x00/g, '')
}

/** Recursively strip null bytes from any JSON-serializable value */
function deepStripNulls(val: unknown): unknown {
  if (typeof val === 'string') return stripNulls(val)
  if (Array.isArray(val)) return val.map(deepStripNulls)
  if (val !== null && typeof val === 'object') {
    return Object.fromEntries(
      Object.entries(val as Record<string, unknown>).map(([k, v]) => [k, deepStripNulls(v)])
    )
  }
  return val
}

// ---------------------------------------------------------------
// POST /api/compliance-matrix/:opportunityId/generate
// Generate (or regenerate) a compliance matrix for an opportunity.
// Uses the opportunity description + any uploaded solicitation docs.
// ---------------------------------------------------------------
router.post('/:opportunityId/generate', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const aiCheck = await checkAiCallLimit(consultingFirmId)
    if (!aiCheck.allowed) {
      return res.status(403).json({
        error: 'AI_LIMIT',
        message: `AI call limit reached (${aiCheck.current}/${aiCheck.max} this month). Upgrade your plan for more AI calls.`,
      })
    }

    const tokenCheck = await checkProposalTokens(consultingFirmId, 1)
    if (!tokenCheck.allowed) {
      return res.status(402).json({
        success: false,
        error: 'NO_TOKENS',
        message: 'You have no proposal tokens remaining. Purchase more in Billing → Proposal Token Packs.',
        balance: tokenCheck.balance,
      })
    }

    const { opportunityId } = req.params

    const opp = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      include: {
        documents: {
          // Include all uploaded docs — not just AI-analyzed ones — so the matrix
          // can be generated even if document analysis was never run.
          orderBy: { uploadedAt: 'desc' },
          take: 5,
        },
      },
    })
    if (!opp) throw new NotFoundError('Opportunity')

    // Build source text: uploaded docs first, then fall back to description
    let sourceText = ''
    for (const doc of opp.documents) {
      try {
        if (!doc.storageKey || /[/\\]/.test(doc.storageKey) || doc.storageKey.includes('..')) continue
        const filePath = path.join(process.cwd(), 'uploads', doc.storageKey)
        const txt = await extractTextFromDocument(filePath)
        if (txt.length > 200) {
          sourceText += `\n\n=== ${doc.fileName} ===\n${txt}`
        }
      } catch {
        // File unreadable — skip and continue with other docs
        logger.warn('Could not read document for matrix generation', { docId: doc.id, storageKey: doc.storageKey })
      }
    }
    if (sourceText.length < 200 && opp.description) {
      sourceText = opp.description
    }
    // If still empty, build minimal context from structured fields so the AI
    // can still generate generic compliance requirements for the opportunity.
    if (!sourceText.trim()) {
      sourceText = [
        `Title: ${opp.title}`,
        opp.agency ? `Agency: ${opp.agency}` : '',
        opp.naicsCode ? `NAICS Code: ${opp.naicsCode}` : '',
        (opp as any).noticeType ? `Notice Type: ${(opp as any).noticeType}` : '',
        opp.setAsideType ? `Set-Aside: ${opp.setAsideType}` : '',
        opp.estimatedValue != null ? `Estimated Value: $${Number(opp.estimatedValue).toLocaleString()}` : '',
      ].filter(Boolean).join('\n')
    }
    if (!sourceText.trim()) {
      throw new ValidationError(
        'No solicitation text available. Upload the RFP/SOW document or ensure the opportunity has a description.'
      )
    }

    logger.info('Generating compliance matrix', {
      opportunityId,
      sourceLength: sourceText.length,
      docCount: opp.documents.length,
      usingDescription: opp.documents.length === 0 || sourceText === opp.description,
    })
    const requirements = await generateComplianceMatrix(sourceText, opp.title, opportunityId, consultingFirmId)
    const safeSourceText = stripNulls(sourceText).substring(0, 5000)

    // Upsert matrix record
    const matrix = await prisma.complianceMatrix.upsert({
      where: { opportunityId },
      update: {
        sourceText: safeSourceText,
        generatedAt: new Date(),
      },
      create: {
        opportunityId,
        consultingFirmId,
        sourceText: safeSourceText,
      },
    })

    // Delete old requirements and recreate
    await prisma.matrixRequirement.deleteMany({ where: { matrixId: matrix.id } })
    await prisma.matrixRequirement.createMany({
      data: requirements.map((r) => ({
        matrixId: matrix.id,
        section: stripNulls(r.section),
        sectionType: stripNulls(r.sectionType),
        requirementText: stripNulls(r.requirementText),
        isMandatory: r.isMandatory,
        farReference: r.farReference ? stripNulls(r.farReference) : null,
        sortOrder: r.sortOrder,
      })),
    })

    const full = await prisma.complianceMatrix.findUnique({
      where: { id: matrix.id },
      include: { requirements: { orderBy: { sortOrder: 'asc' } } },
    })

    const tokensRemaining = await deductProposalTokens(consultingFirmId, 1, {
      userId: req.user?.userId ?? null,
      opportunityId,
      reason: 'Compliance matrix generation (1 token)',
    })

    logger.info('Compliance matrix generated', {
      opportunityId,
      consultingFirmId,
      requirementCount: requirements.length,
    })

    res.json({ success: true, data: full, tokensRemaining })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// POST /api/compliance-matrix/:opportunityId/bid-guidance
// Generate plain-language win strategy from solicitation text.
// ---------------------------------------------------------------
router.post('/:opportunityId/bid-guidance', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const aiCheck = await checkAiCallLimit(consultingFirmId)
    if (!aiCheck.allowed) {
      return res.status(403).json({
        error: 'AI_LIMIT',
        message: `AI call limit reached (${aiCheck.current}/${aiCheck.max} this month). Upgrade your plan for more AI calls.`,
      })
    }

    const tokenCheck = await checkProposalTokens(consultingFirmId, 1)
    if (!tokenCheck.allowed) {
      return res.status(402).json({
        success: false,
        error: 'NO_TOKENS',
        message: 'You have no proposal tokens remaining. Purchase more in Billing → Proposal Token Packs.',
        balance: tokenCheck.balance,
      })
    }

    const { opportunityId } = req.params

    const opp = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      include: {
        documents: {
          orderBy: { uploadedAt: 'desc' },
          take: 5,
        },
      },
    })
    if (!opp) throw new NotFoundError('Opportunity')

    // Build source text: uploaded docs first, then description
    let sourceText = ''
    for (const doc of opp.documents) {
      try {
        if (!doc.storageKey || /[/\\]/.test(doc.storageKey) || doc.storageKey.includes('..')) continue
        const filePath = path.join(process.cwd(), 'uploads', doc.storageKey)
        const txt = await extractTextFromDocument(filePath)
        if (txt.length > 200) sourceText += `\n\n=== ${doc.fileName} ===\n${txt}`
      } catch {
        logger.warn('Could not read document for bid guidance', { docId: doc.id, storageKey: doc.storageKey })
      }
    }
    if (sourceText.length < 200 && opp.description) sourceText = opp.description
    if (!sourceText.trim()) {
      sourceText = [
        `Title: ${opp.title}`,
        opp.agency ? `Agency: ${opp.agency}` : '',
        opp.naicsCode ? `NAICS Code: ${opp.naicsCode}` : '',
        (opp as any).noticeType ? `Notice Type: ${(opp as any).noticeType}` : '',
        opp.setAsideType ? `Set-Aside: ${opp.setAsideType}` : '',
        opp.estimatedValue != null ? `Estimated Value: $${Number(opp.estimatedValue).toLocaleString()}` : '',
      ].filter(Boolean).join('\n')
    }
    if (!sourceText.trim()) {
      throw new ValidationError('No solicitation text available. Upload the RFP/SOW or ensure the opportunity has a description.')
    }

    const enrichment: EnrichmentContext = {
      agency: opp.agency,
      naicsCode: opp.naicsCode,
      setAsideType: opp.setAsideType ?? null,
      recompeteFlag: opp.recompeteFlag,
      historicalWinner: opp.historicalWinner ?? null,
      historicalAvgAward: opp.historicalAvgAward ? Number(opp.historicalAvgAward) : null,
      historicalAwardCount: opp.historicalAwardCount ?? null,
      competitionCount: opp.competitionCount ?? null,
      incumbentProbability: opp.incumbentProbability ?? null,
      agencySmallBizRate: opp.agencySmallBizRate ?? null,
      agencySdvosbRate: opp.agencySdvosbRate ?? null,
    }

    let guidance
    try {
      guidance = await generateBidGuidance(sourceText, opp.title, opportunityId, enrichment, consultingFirmId)
    } catch (llmErr) {
      if ((llmErr as Error).message === 'NO_LLM_KEY') {
        return res.status(422).json({
          success: false,
          error: 'NO_AI_KEY',
          message: 'Add your AI provider API key in Settings → AI Intelligence Provider.',
        })
      }
      throw llmErr
    }
    if (!guidance) {
      return res.status(500).json({ success: false, error: 'Bid guidance generation failed. Check server logs.' })
    }

    const safeGuidance = deepStripNulls(guidance) as any
    const safeSourceText = stripNulls(sourceText).substring(0, 5000)

    // Upsert into compliance_matrices so guidance is co-located
    const matrix = await prisma.complianceMatrix.upsert({
      where: { opportunityId },
      update: {
        bidGuidanceJson: safeGuidance,
        bidGuidanceAt: new Date(),
      },
      create: {
        opportunityId,
        consultingFirmId,
        sourceText: safeSourceText,
        bidGuidanceJson: safeGuidance,
        bidGuidanceAt: new Date(),
      },
    })

    const tokensRemaining = await deductProposalTokens(consultingFirmId, 1, {
      userId: req.user?.userId ?? null,
      opportunityId,
      reason: 'Bid guidance generation (1 token)',
    })

    logger.info('Bid guidance generated', { opportunityId, consultingFirmId })
    res.json({ success: true, data: { ...guidance, generatedAt: matrix.bidGuidanceAt }, tokensRemaining })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/compliance-matrix/:opportunityId
// ---------------------------------------------------------------
router.get('/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params

    // Verify tenant owns the opportunity
    const opp = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      select: { id: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')

    const matrix = await prisma.complianceMatrix.findUnique({
      where: { opportunityId },
      include: { requirements: { orderBy: { sortOrder: 'asc' } } },
    })

    res.json({ success: true, data: matrix ?? null })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// PATCH /api/compliance-matrix/requirements/:requirementId
// Update proposal section, status, or notes on a single row.
// ---------------------------------------------------------------
router.patch('/requirements/:requirementId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { requirementId } = req.params
    const { proposalSection, status, notes } = req.body

    const VALID_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'WAIVED', 'NON_COMPLIANT']
    if (status && !VALID_STATUSES.includes(status)) {
      throw new ValidationError(`status must be one of: ${VALID_STATUSES.join(', ')}`)
    }

    // Verify tenant owns the matrix this requirement belongs to
    const req2 = await prisma.matrixRequirement.findFirst({
      where: { id: requirementId },
      include: { matrix: { select: { consultingFirmId: true } } },
    })
    if (!req2 || req2.matrix.consultingFirmId !== consultingFirmId) {
      throw new NotFoundError('MatrixRequirement')
    }

    const updated = await prisma.matrixRequirement.update({
      where: { id: requirementId },
      data: {
        ...(proposalSection !== undefined && { proposalSection }),
        ...(status !== undefined && { status }),
        ...(notes !== undefined && { notes }),
      },
    })

    res.json({ success: true, data: updated })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// GET /api/compliance-matrix/:opportunityId/gap-analysis
// Returns FAR/DFARS clause matching, set-aside requirements,
// and plain-language explanations for the opportunity
// =============================================================
router.get('/:opportunityId/gap-analysis', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params
    // ?ai=true opts into LLM-powered clause extraction (extends keyword analysis)
    const useAi = req.query.ai === 'true' || req.query.ai === '1'
    const result = await analyzeOpportunityCompliance(opportunityId, consultingFirmId, { useAi })
    res.json({ success: true, data: result })
  } catch (err: any) {
    if (err.message === 'Opportunity not found') {
      return next(new NotFoundError(err.message))
    }
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/compliance-matrix/:opportunityId/requirements
// Fetch requirements with optional source document filter
// ---------------------------------------------------------------
router.get('/:opportunityId/requirements', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params
    const { sourceDocumentId } = req.query

    // Verify opportunity belongs to firm
    const opp = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId }
    })
    if (!opp) throw new NotFoundError('Opportunity')

    const matrix = await prisma.complianceMatrix.findUnique({
      where: { opportunityId },
      include: {
        requirements: {
          where: sourceDocumentId ? { sourceDocumentId: String(sourceDocumentId) } : undefined,
          include: {
            sourceDocument: {
              select: { id: true, fileName: true, extractionStatus: true, extractionConfidence: true }
            }
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    })

    if (!matrix) {
      return res.status(404).json({ error: 'Compliance matrix not found' })
    }

    res.json(matrix.requirements)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// PATCH /api/compliance-matrix/:opportunityId/requirements/:requirementId
// Override requirement with reason tracking (for manual corrections)
// ---------------------------------------------------------------
router.patch('/:opportunityId/requirements/:requirementId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId, requirementId } = req.params
    const { requirementText, isMandatory, overrideReason } = req.body
    const userId = (req as any).user?.id || 'unknown'

    // Verify opportunity belongs to firm
    const opp = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId }
    })
    if (!opp) throw new NotFoundError('Opportunity')

    // Verify requirement exists and belongs to this opportunity
    const req2 = await prisma.matrixRequirement.findUnique({
      where: { id: requirementId },
      include: { matrix: true }
    })
    if (!req2 || req2.matrix.opportunityId !== opportunityId) {
      throw new NotFoundError('MatrixRequirement')
    }

    if (!overrideReason) {
      throw new ValidationError('overrideReason is required for manual overrides')
    }

    const updated = await prisma.matrixRequirement.update({
      where: { id: requirementId },
      data: {
        ...(requirementText !== undefined && { requirementText }),
        ...(isMandatory !== undefined && { isMandatory }),
        isManuallyVerified: true,
        manualOverrideReason: overrideReason,
      },
    })

    logger.info('Requirement manually overridden', {
      requirementId,
      opportunityId,
      overrideReason,
      userId,
    })

    res.json({ success: true, requirement: updated })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// POST /api/compliance-matrix/:opportunityId/refresh
// Re-extract requirements from all documents
// ---------------------------------------------------------------
router.post('/:opportunityId/refresh', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params

    // Verify opportunity belongs to firm
    const opp = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId }
    })
    if (!opp) throw new NotFoundError('Opportunity')

    // Get all documents for this opportunity
    const documents = await prisma.opportunityDocument.findMany({
      where: { opportunityId },
    })

    if (documents.length === 0) {
      return res.status(422).json({
        error: 'NO_DOCUMENTS',
        message: 'No documents uploaded for this opportunity'
      })
    }

    // Queue each document for re-extraction
    const { queueRequirementExtraction } = await import('../workers/requirementExtractionWorker')
    for (const doc of documents) {
      try {
        await queueRequirementExtraction(doc.id)
      } catch (queueErr) {
        logger.error('Failed to queue document for re-extraction', {
          documentId: doc.id,
          error: String(queueErr)
        })
      }
    }

    logger.info('Documents queued for re-extraction', {
      opportunityId,
      documentCount: documents.length,
      userId: (req as any).user?.id
    })

    res.json({
      success: true,
      message: `Queued ${documents.length} document(s) for requirement re-extraction. Refresh the page in a moment to see updated requirements.`,
      queuedCount: documents.length,
    })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// §5.2 Compliance Matrix — verification, ownership, linking, filters,
// compliance %, and non-destructive re-extraction (preserves verified rows).
// =============================================================

async function loadOwnedOpportunity(consultingFirmId: string, opportunityId: string) {
  const opp = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId }, select: { id: true, title: true } })
  if (!opp) throw new NotFoundError('Opportunity')
  return opp
}

async function ensureMatrix(opportunityId: string, consultingFirmId: string) {
  return prisma.complianceMatrix.upsert({ where: { opportunityId }, update: {}, create: { opportunityId, consultingFirmId } })
}

async function loadOwnedRequirement(consultingFirmId: string, requirementId: string) {
  const r = await prisma.matrixRequirement.findUnique({ where: { id: requirementId }, include: { matrix: { select: { consultingFirmId: true, opportunityId: true } } } })
  if (!r || r.matrix.consultingFirmId !== consultingFirmId) throw new NotFoundError('MatrixRequirement')
  return r
}

// Gather solicitation source text (uploaded docs first, then description). Shared
// with the AI extraction path.
async function buildSourceText(opportunityId: string): Promise<string> {
  const opp = await prisma.opportunity.findUnique({ where: { id: opportunityId }, include: { documents: { orderBy: { uploadedAt: 'desc' }, take: 5 } } })
  if (!opp) return ''
  let sourceText = ''
  for (const doc of opp.documents) {
    try {
      if (!doc.storageKey || /[/\\]/.test(doc.storageKey) || doc.storageKey.includes('..')) continue
      const txt = await extractTextFromDocument(path.join(process.cwd(), 'uploads', doc.storageKey))
      if (txt.length > 200) sourceText += `\n\n=== ${doc.fileName} ===\n${txt}`
    } catch {
      logger.warn('Could not read document for re-extraction', { docId: doc.id })
    }
  }
  if (sourceText.length < 200 && opp.description) sourceText = opp.description
  return sourceText.trim()
}

// ---------------------------------------------------------------
// POST /api/compliance-matrix/:opportunityId/requirements
// Manually add a compliance requirement (human-authored → VERIFIED).
// ---------------------------------------------------------------
router.post('/:opportunityId/requirements', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params
    await loadOwnedOpportunity(consultingFirmId, opportunityId)

    const body = req.body ?? {}
    const requirementText = typeof body.requirementText === 'string' ? body.requirementText.trim() : ''
    if (!requirementText) throw new ValidationError('requirementText is required')
    const typeRaw = typeof body.sectionType === 'string' ? body.sectionType.toUpperCase() : 'OTHER'
    const sectionType = (REQUIREMENT_TYPES as readonly string[]).includes(typeRaw) ? typeRaw : 'OTHER'

    const matrix = await ensureMatrix(opportunityId, consultingFirmId)
    // Duplicate requirement text on the same matrix (proposal) is blocked.
    const dupe = await prisma.matrixRequirement.findFirst({ where: { matrixId: matrix.id, requirementText: { equals: requirementText, mode: 'insensitive' } }, select: { id: true } })
    if (dupe) throw new ConflictError('A requirement with this text already exists on this matrix.')
    const sourcePageNumber = Number.isInteger(body.sourcePageNumber) ? body.sourcePageNumber : null
    const maxSort = await prisma.matrixRequirement.aggregate({ where: { matrixId: matrix.id }, _max: { sortOrder: true } })
    const created = await prisma.matrixRequirement.create({
      data: {
        matrixId: matrix.id,
        section: typeof body.section === 'string' && body.section.trim() ? stripNulls(body.section.trim()) : 'Manual entry',
        sectionType,
        requirementText: stripNulls(requirementText),
        isMandatory: body.isMandatory === true,
        proposalSection: typeof body.proposalSection === 'string' ? stripNulls(body.proposalSection) : null,
        evidenceText: typeof body.evidenceText === 'string' ? stripNulls(body.evidenceText) : null,
        sourcePageNumber,
        farReference: typeof body.farReference === 'string' ? stripNulls(body.farReference) : null,
        extractionMethod: 'MANUAL',
        extractionConfidence: 1,
        isManuallyVerified: true,
        verificationStatus: 'VERIFIED',
        sortOrder: (maxSort._max.sortOrder ?? -1) + 1,
      },
    })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'CREATE', entityType: 'MatrixRequirement', entityId: created.id, rationale: 'Requirement added manually' })
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------
// POST /api/compliance-matrix/requirements/:requirementId/verify
// POST /api/compliance-matrix/requirements/:requirementId/reject
// ---------------------------------------------------------------
router.post('/requirements/:requirementId/verify', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await loadOwnedRequirement(consultingFirmId, req.params.requirementId)
    const updated = await prisma.matrixRequirement.update({ where: { id: existing.id }, data: { verificationStatus: 'VERIFIED', isManuallyVerified: true, reviewRequired: false } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'APPROVAL', entityType: 'MatrixRequirement', entityId: existing.id, rationale: 'Requirement verified', before: { verificationStatus: existing.verificationStatus }, after: { verificationStatus: 'VERIFIED' } })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.post('/requirements/:requirementId/reject', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
    if (!reason) throw new ValidationError('reason is required to reject a requirement')
    const existing = await loadOwnedRequirement(consultingFirmId, req.params.requirementId)
    const updated = await prisma.matrixRequirement.update({ where: { id: existing.id }, data: { verificationStatus: 'REJECTED', reviewRequired: false, reviewReason: stripNulls(reason) } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'REJECTION', entityType: 'MatrixRequirement', entityId: existing.id, rationale: `Requirement rejected: ${reason}`, before: { verificationStatus: existing.verificationStatus }, after: { verificationStatus: 'REJECTED' } })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------
// POST /api/compliance-matrix/requirements/:requirementId/assign
// Assign an owner (must belong to the firm). null to unassign.
// ---------------------------------------------------------------
router.post('/requirements/:requirementId/assign', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const ownerUserId: string | null = typeof req.body?.ownerUserId === 'string' ? req.body.ownerUserId : req.body?.ownerUserId === null ? null : undefined as never
    if (ownerUserId === undefined) throw new ValidationError('ownerUserId is required (or null to unassign)')
    const existing = await loadOwnedRequirement(consultingFirmId, req.params.requirementId)
    if (ownerUserId) {
      const u = await prisma.user.findFirst({ where: { id: ownerUserId, consultingFirmId }, select: { id: true } })
      if (!u) throw new ValidationError('ownerUserId does not belong to your firm')
    }
    const updated = await prisma.matrixRequirement.update({ where: { id: existing.id }, data: { ownerUserId } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'MatrixRequirement', entityId: existing.id, rationale: ownerUserId ? 'Requirement owner assigned' : 'Requirement owner cleared', before: { ownerUserId: existing.ownerUserId }, after: { ownerUserId } })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------
// POST /api/compliance-matrix/requirements/:requirementId/link-section
// Link the requirement to a proposal section (same tenant + opportunity).
// ---------------------------------------------------------------
router.post('/requirements/:requirementId/link-section', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const proposalSectionId: string | null = typeof req.body?.proposalSectionId === 'string' ? req.body.proposalSectionId : req.body?.proposalSectionId === null ? null : undefined as never
    if (proposalSectionId === undefined) throw new ValidationError('proposalSectionId is required (or null to unlink)')
    const existing = await loadOwnedRequirement(consultingFirmId, req.params.requirementId)
    if (proposalSectionId) {
      const section = await prisma.proposalSection.findFirst({ where: { id: proposalSectionId, consultingFirmId, opportunityId: existing.matrix.opportunityId }, select: { id: true, title: true } })
      if (!section) throw new ValidationError('proposalSectionId is not a section of this opportunity')
      const updated = await prisma.matrixRequirement.update({ where: { id: existing.id }, data: { proposalSectionId, proposalSection: section.title, coverageStatus: 'COVERED' } })
      await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'MatrixRequirement', entityId: existing.id, rationale: 'Requirement linked to proposal section' })
      return res.json({ success: true, data: updated })
    }
    const updated = await prisma.matrixRequirement.update({ where: { id: existing.id }, data: { proposalSectionId: null, coverageStatus: 'UNCOVERED' } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'MatrixRequirement', entityId: existing.id, rationale: 'Requirement unlinked from proposal section' })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------
// GET /api/compliance-matrix/:opportunityId/summary
// Compliance % + counts, with optional filters (mandatory/unverified/incomplete).
// ---------------------------------------------------------------
router.get('/:opportunityId/summary', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params
    await loadOwnedOpportunity(consultingFirmId, opportunityId)
    const matrix = await prisma.complianceMatrix.findUnique({ where: { opportunityId }, include: { requirements: { orderBy: { sortOrder: 'asc' } } } })
    const all = matrix?.requirements ?? []
    const isComplete = (s: string) => s === 'COMPLETED'
    const counts = {
      total: all.length,
      mandatory: all.filter((r) => r.isMandatory).length,
      verified: all.filter((r) => r.verificationStatus === 'VERIFIED').length,
      unverified: all.filter((r) => r.verificationStatus === 'UNVERIFIED').length,
      rejected: all.filter((r) => r.verificationStatus === 'REJECTED').length,
      complete: all.filter((r) => isComplete(r.status)).length,
      incomplete: all.filter((r) => !isComplete(r.status) && r.verificationStatus !== 'REJECTED').length,
      linked: all.filter((r) => r.proposalSectionId).length,
    }
    const active = all.filter((r) => r.verificationStatus !== 'REJECTED')
    const compliancePercent = active.length ? Math.round((active.filter((r) => isComplete(r.status)).length / active.length) * 100) : 0

    let requirements = all
    if (req.query.mandatory === 'true') requirements = requirements.filter((r) => r.isMandatory)
    if (req.query.unverified === 'true') requirements = requirements.filter((r) => r.verificationStatus === 'UNVERIFIED')
    if (req.query.incomplete === 'true') requirements = requirements.filter((r) => !isComplete(r.status) && r.verificationStatus !== 'REJECTED')

    res.json({ success: true, data: { counts, compliancePercent, requirements } })
  } catch (err) { next(err) }
})

// ---------------------------------------------------------------
// POST /api/compliance-matrix/:opportunityId/re-extract
// Re-run AI extraction (exact prompt) and append ONLY new requirements —
// existing (especially verified) requirements are never duplicated or deleted.
// ---------------------------------------------------------------
router.post('/:opportunityId/re-extract', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params
    const opp = await loadOwnedOpportunity(consultingFirmId, opportunityId)

    const aiCheck = await checkAiCallLimit(consultingFirmId)
    if (!aiCheck.allowed) return res.status(403).json({ success: false, error: 'AI_LIMIT', message: `AI call limit reached (${aiCheck.current}/${aiCheck.max} this month).` })

    const sourceText = await buildSourceText(opportunityId)
    if (!sourceText) throw new ValidationError('No solicitation text available. Upload the RFP/SOW or add a description.')

    const matrix = await ensureMatrix(opportunityId, consultingFirmId)
    const existing = await prisma.matrixRequirement.findMany({ where: { matrixId: matrix.id }, select: { requirementText: true } })

    let extraction
    try {
      extraction = await extractComplianceRequirements(sourceText, { documentName: undefined, opportunityTitle: opp.title }, consultingFirmId)
    } catch (llmErr) {
      if ((llmErr as Error).message === 'NO_LLM_KEY') {
        return res.status(422).json({ success: false, error: 'NO_AI_KEY', message: 'Add your AI provider API key in Settings → AI Intelligence Provider, or add requirements manually.' })
      }
      throw llmErr
    }

    const fresh = dedupeAgainstExisting(extraction.requirements, existing)
    const maxSort = await prisma.matrixRequirement.aggregate({ where: { matrixId: matrix.id }, _max: { sortOrder: true } })
    let base = (maxSort._max.sortOrder ?? -1) + 1
    if (fresh.length > 0) {
      await prisma.matrixRequirement.createMany({
        data: fresh.map((r) => ({
          matrixId: matrix.id,
          section: stripNulls(r.sourceSection ?? 'General'),
          sectionType: r.requirementType,
          requirementText: stripNulls(r.requirementText),
          isMandatory: r.mandatory,
          proposalSection: r.suggestedProposalSection ? stripNulls(r.suggestedProposalSection) : null,
          sourcePageNumber: r.sourcePageNumber,
          evidenceText: r.evidenceText ? stripNulls(r.evidenceText) : null,
          extractionMethod: 'AI',
          extractionConfidence: r.extractionConfidence,
          verificationStatus: 'UNVERIFIED',
          reviewRequired: r.reviewRequired,
          reviewReason: r.reviewReason ? stripNulls(r.reviewReason) : null,
          sortOrder: base++,
        })),
      })
    }
    await prisma.complianceMatrix.update({ where: { id: matrix.id }, data: { updatedAt: new Date() } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'LLM_INFERENCE', entityType: 'ComplianceMatrix', entityId: matrix.id, rationale: `Re-extraction added ${fresh.length} new requirement(s); ${existing.length} preserved` })

    const full = await prisma.complianceMatrix.findUnique({ where: { id: matrix.id }, include: { requirements: { orderBy: { sortOrder: 'asc' } } } })
    res.json({ success: true, data: full, added: fresh.length, preserved: existing.length, parseErrors: extraction.errors })
  } catch (err) { next(err) }
})

export default router
