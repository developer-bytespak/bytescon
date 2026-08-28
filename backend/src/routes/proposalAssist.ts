import { Router, Response, NextFunction } from 'express'
import fs from 'fs'
import path from 'path'
import * as XLSX from 'xlsx'
import { prisma } from '../config/database'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError } from '../utils/errors'
import { generateProposalOutline } from '../services/proposalAssist'
import { generateProposalDraft, ProposalAnswer, OfferorProfile } from '../services/proposalDraftService'
import {
  getRelevantPastPerformanceRecords,
  PastPerformanceForProposal,
} from '../services/pastPerformanceService'
import { buildProposalPdf, ProposalBranding } from '../services/proposalPdfBuilder'
import { resolveWinnersContext } from '../services/winnersIntel/resolver'
import { logAudit } from '../services/auditService'
import {
  PROPOSAL_ATTESTATION_VERSION,
  PROPOSAL_ATTESTATION_STATEMENT,
  hashProposalDraft,
} from '../services/proposalAttestation'
import { Prisma } from '@prisma/client'
import { checkAiCallLimit, checkProposalTokens, deductProposalTokens } from '../middleware/tierGate'
import { generateWithRouter } from '../services/llm/llmRouter'
import { logger } from '../utils/logger'
import { upload } from '../middleware/upload'
import { DocumentAnalysisService } from '../services/documentAnalysis'

const docAnalysisService = new DocumentAnalysisService()

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('proposal_studio'))

// ---------------------------------------------------------------
// POST /api/proposal-assist/:opportunityId/outline  (costs 1 token)
// ---------------------------------------------------------------
router.post('/:opportunityId/outline', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    logger.info('Proposal outline requested', { opportunityId: req.params.opportunityId, consultingFirmId })

    const aiCheck = await checkAiCallLimit(consultingFirmId)
    if (!aiCheck.allowed) {
      return res.status(403).json({ error: 'AI_LIMIT', message: `AI call limit reached (${aiCheck.current}/${aiCheck.max} this month).` })
    }

    const tokenCheck = await checkProposalTokens(consultingFirmId, 1)
    if (!tokenCheck.allowed) {
      return res.status(402).json({
        error: 'NO_TOKENS',
        message: 'You have no proposal tokens remaining. Purchase more in Billing → Proposal Token Packs.',
        balance: tokenCheck.balance,
      })
    }

    const { opportunityId } = req.params

    const [opp, matrix] = await Promise.all([
      prisma.opportunity.findFirst({
        where: { id: opportunityId, consultingFirmId },
        select: { id: true, title: true, agency: true, naicsCode: true, setAsideType: true, estimatedValue: true, historicalWinner: true },
      }),
      prisma.complianceMatrix.findUnique({
        where: { opportunityId },
        include: { requirements: { orderBy: { sortOrder: 'asc' }, take: 30 } },
      }),
    ])

    if (!opp) throw new NotFoundError('Opportunity')

    const requirements = (matrix?.requirements ?? []).map(r => ({
      section: r.section,
      requirementText: r.requirementText,
      isMandatory: r.isMandatory,
    }))

    const userGuidance: string | undefined = typeof req.body?.userGuidance === 'string' && req.body.userGuidance.trim()
      ? req.body.userGuidance.trim().slice(0, 3000)
      : undefined

    const outline = await generateProposalOutline(
      opp.title,
      opp.agency,
      requirements,
      {
        naicsCode: opp.naicsCode ?? undefined,
        setAsideType: opp.setAsideType,
        estimatedValue: opp.estimatedValue ? Number(opp.estimatedValue) : null,
        historicalWinner: opp.historicalWinner,
      },
      consultingFirmId,
      userGuidance
    )

    const tokensRemaining = await deductProposalTokens(consultingFirmId, 1, {
      userId: req.user?.userId ?? null,
      opportunityId: req.params.opportunityId,
      reason: 'Outline generation (1 token)',
    })
    res.json({ success: true, data: outline, tokensRemaining })
  } catch (err: any) {
    if (err?.message === 'NO_LLM_KEY') {
      return res.status(400).json({ success: false, error: 'No AI key configured — go to Settings to add your API key.', code: 'NO_AI_KEY' })
    }
    if (err?.message === 'RATE_LIMITED') {
      return res.status(429).json({ success: false, error: 'AI rate limit reached — please wait 60 seconds and try again.', code: 'RATE_LIMITED' })
    }
    // These fire before the token deduction below, so the user is not charged.
    if (err?.message === 'LLM_UNAVAILABLE') {
      return res.status(502).json({ success: false, error: 'The AI provider is temporarily unavailable. No tokens were charged — please try again in a moment.', code: 'LLM_UNAVAILABLE' })
    }
    if (err?.message === 'LLM_BAD_OUTPUT') {
      return res.status(502).json({ success: false, error: 'The AI returned an unexpected response. No tokens were charged — please try again.', code: 'LLM_BAD_OUTPUT' })
    }
    next(err)
  }
})

// ---------------------------------------------------------------
// POST /api/proposal-assist/:opportunityId/questions  (free — 0 tokens)
// Accepts: { outline: ProposalOutline }
// Returns: ProposalQuestion[]
// ---------------------------------------------------------------
router.post('/:opportunityId/questions', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params
    const { outline } = req.body

    const opp = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      select: { title: true, agency: true, naicsCode: true, setAsideType: true, estimatedValue: true, description: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')

    const winThemes = Array.isArray(outline?.winThemes) ? outline.winThemes.slice(0, 5).join(', ') : ''
    const sections = Array.isArray(outline?.sections)
      ? outline.sections.map((s: any) => s.title).join(', ')
      : ''

    const systemPrompt = `You are a senior federal proposal manager conducting a pre-proposal interview. Generate targeted questions that will help write a stronger, winning proposal for this specific opportunity. Focus on information the AI cannot know: exact pricing, key personnel, past contracts, teaming partners, certifications, and technical differentiators.

Return ONLY a valid JSON array — no markdown, no preamble:
[
  {
    "id": "q1",
    "category": "PRICING",
    "question": "What is your proposed total contract price and how is it structured?",
    "hint": "e.g., $2.4M total: $1.8M labor, $400K ODC, 10% fee",
    "required": true
  }
]

category must be one of: PRICING, TECHNICAL, PERSONNEL, PAST_PERFORMANCE, TEAMING, CERTIFICATIONS, OTHER
required: true for questions that significantly improve proposal quality, false for nice-to-have.
Generate 7-9 questions. Mix required (4-5) and optional (2-4).`

    const userPrompt = `Generate proposal interview questions for this opportunity.

Opportunity: ${opp.title}
Agency: ${opp.agency}
NAICS: ${opp.naicsCode ?? 'Not specified'}
Set-Aside: ${opp.setAsideType ?? 'Open competition'}
Estimated Value: ${opp.estimatedValue ? '$' + Number(opp.estimatedValue).toLocaleString() : 'Not published'}
Win Themes: ${winThemes || 'Not yet defined'}
Proposed Sections: ${sections || 'Standard proposal sections'}
${opp.description ? `\nOpportunity Description:\n${opp.description.slice(0, 1000)}` : ''}`

    let questions: any[] = []
    try {
      const response = await generateWithRouter(
        { systemPrompt, userPrompt, maxTokens: 1200, temperature: 0.3 },
        consultingFirmId,
        { task: 'BID_GUIDANCE', useCache: false }
      )

      const cleaned = response.text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
      const start = cleaned.indexOf('[')
      const end = cleaned.lastIndexOf(']')
      if (start !== -1 && end !== -1) {
        questions = JSON.parse(cleaned.slice(start, end + 1))
      }
    } catch (err) {
      logger.warn('Question generation failed, using defaults', { error: (err as Error).message })
    }

    // Fallback if LLM failed or returned empty
    if (!questions.length) {
      questions = [
        { id: 'q1', category: 'PRICING', question: 'What is your proposed total contract price and cost structure?', hint: 'e.g., $2.4M total: $1.8M labor, $400K ODC, 10% profit fee', required: true },
        { id: 'q2', category: 'PERSONNEL', question: 'Who is your proposed Program Manager and what are their key qualifications?', hint: 'e.g., Jane Smith, PMP, 15 years VA contracting experience', required: true },
        { id: 'q3', category: 'PAST_PERFORMANCE', question: 'What are your 2-3 most relevant prior contracts to reference?', hint: 'e.g., Contract #, Agency, dollar value, period, scope similarity', required: true },
        { id: 'q4', category: 'TECHNICAL', question: 'What is your primary technical differentiator for this work?', hint: 'e.g., proprietary platform, specialized methodology, cleared staff', required: true },
        { id: 'q5', category: 'TEAMING', question: 'Are you teaming with any subcontractors? If so, who and what role?', hint: 'e.g., Acme LLC (SDVOSB) for cybersecurity work — 20% of contract value', required: false },
        { id: 'q6', category: 'CERTIFICATIONS', question: 'What relevant certifications does your firm hold?', hint: 'e.g., ISO 9001, CMMI Level 3, SDVOSB, 8(a)', required: false },
        { id: 'q7', category: 'OTHER', question: 'Is there anything else the proposal should specifically highlight or address?', hint: 'e.g., incumbent risk response, unique past performance with this agency', required: false },
      ]
    }

    res.json({ success: true, data: questions })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// POST /api/proposal-assist/:opportunityId/draft  (costs 5 tokens)
// Accepts: { answers?: ProposalAnswer[], userGuidance?: string }
// Returns: PDF blob
// ---------------------------------------------------------------
router.post('/:opportunityId/draft', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    logger.info('Proposal draft PDF requested', { opportunityId: req.params.opportunityId, consultingFirmId })

    const aiCheck = await checkAiCallLimit(consultingFirmId)
    if (!aiCheck.allowed) {
      return res.status(403).json({ error: 'AI_LIMIT', message: `AI call limit reached (${aiCheck.current}/${aiCheck.max} this month).` })
    }

    const tokenCheck = await checkProposalTokens(consultingFirmId, 5)
    if (!tokenCheck.allowed) {
      return res.status(402).json({
        error: 'NO_TOKENS',
        message: `Generating a full draft costs 5 tokens but you only have ${tokenCheck.balance}. Purchase more in Billing → Proposal Token Packs.`,
        balance: tokenCheck.balance,
      })
    }

    const { opportunityId } = req.params

    const [opp, matrix] = await Promise.all([
      prisma.opportunity.findFirst({
        where: { id: opportunityId, consultingFirmId },
        select: { id: true, title: true, agency: true, naicsCode: true, setAsideType: true, estimatedValue: true, historicalWinner: true, description: true },
      }),
      prisma.complianceMatrix.findUnique({
        where: { opportunityId },
        include: { requirements: { orderBy: { sortOrder: 'asc' }, take: 30 } },
      }),
    ])

    if (!opp) throw new NotFoundError('Opportunity')

    const requirements = (matrix?.requirements ?? []).map(r => ({
      section: r.section,
      requirementText: r.requirementText,
      isMandatory: r.isMandatory,
    }))

    const userGuidance: string | undefined = typeof req.body?.userGuidance === 'string' && req.body.userGuidance.trim()
      ? req.body.userGuidance.trim().slice(0, 3000)
      : undefined

    const answers: ProposalAnswer[] = Array.isArray(req.body?.answers) ? req.body.answers : []
    const bidFormContext: string | undefined = typeof req.body?.bidFormContext === 'string' && req.body.bidFormContext.trim()
      ? req.body.bidFormContext.trim().slice(0, 4000)
      : undefined

    // Optional client selection. When provided, the resulting PDF reflects
    // THIS client's branding (cover colors, logo, "PREPARED BY" line, footer
    // address) instead of the platform default. Validated against firm scope
    // before use so a caller cannot point at another firm's client.
    const clientCompanyId: string | undefined = typeof req.body?.clientCompanyId === 'string' && req.body.clientCompanyId.trim()
      ? req.body.clientCompanyId.trim()
      : undefined

    let clientBranding: ProposalBranding | undefined
    let clientBrandingApplied = false
    let offeror: OfferorProfile | undefined
    if (clientCompanyId) {
      const client = await prisma.clientCompany.findFirst({
        where: { id: clientCompanyId, consultingFirmId },
        select: {
          id: true,
          name: true,
          uei: true,
          cage: true,
          naicsCodes: true,
          pscCodes: true,
          sdvosb: true,
          wosb: true,
          hubzone: true,
          smallBusiness: true,
          contractVehicles: true,
          city: true,
          state: true,
          website: true,
          brandingLogoUrl: true,
          brandingPrimaryColor: true,
          brandingSecondaryColor: true,
          brandingDisplayName: true,
          brandingTagline: true,
          brandingFooterAddress: true,
          brandingPreparedByLine: true,
        },
      })
      if (!client) {
        throw new NotFoundError('ClientCompany')
      }
      clientBranding = {
        primaryColor:   client.brandingPrimaryColor,
        secondaryColor: client.brandingSecondaryColor,
        displayName:    client.brandingDisplayName,
        tagline:        client.brandingTagline,
        preparedByLine: client.brandingPreparedByLine,
        footerAddress:  client.brandingFooterAddress,
        logoUrl:        client.brandingLogoUrl,
      }
      // True only if at least one field is non-null — don't claim branding
      // was applied when the row exists but every column is empty.
      clientBrandingApplied = Object.values(clientBranding).some((v) => v !== null && v !== undefined && v !== '')

      // P0: the proposal CONTENT is written for THIS client — never a name the
      // LLM invents. setAsides derived from the client's certification flags.
      const setAsides: string[] = []
      if (client.sdvosb) setAsides.push('SDVOSB (Service-Disabled Veteran-Owned Small Business)')
      if (client.wosb) setAsides.push('WOSB (Woman-Owned Small Business)')
      if (client.hubzone) setAsides.push('HUBZone')
      if (client.smallBusiness) setAsides.push('Small Business')
      offeror = {
        legalName: client.name,
        uei: client.uei,
        cage: client.cage,
        naicsCodes: client.naicsCodes,
        pscCodes: client.pscCodes,
        setAsides,
        contractVehicles: client.contractVehicles,
        location: [client.city, client.state].filter(Boolean).join(', ') || null,
        website: client.website,
        source: 'CLIENT_COMPANY',
      }
    }

    // No client selected → the offeror is the consulting firm itself (the
    // tenant, e.g. "Bytes Platform"). Fail loudly if we cannot resolve a real
    // legal name rather than let the draft fabricate one.
    if (!offeror) {
      const firm = await prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        select: { name: true, isVeteranOwned: true, brandingDisplayName: true },
      })
      const legalName = (firm?.name ?? firm?.brandingDisplayName ?? '').trim()
      if (!legalName) {
        return res.status(409).json({
          success: false,
          error: 'No offeror identity found. Set your company name in Settings, or select a client company, before generating a proposal. No tokens were charged.',
          code: 'MISSING_OFFEROR',
        })
      }
      offeror = {
        legalName,
        setAsides: firm?.isVeteranOwned ? ['Veteran-Owned Small Business'] : [],
        source: 'CONSULTING_FIRM',
      }
    }

    // Resolve Winners Intel context for this opportunity. Returns null when
    // the feature flag is off, the firm hasn't opted in, or no slices exist
    // on disk — in which case the proposal generates exactly as before. When
    // it returns a context, the slices land in the system prompt and the
    // injection is written to AuditEvent for replay.
    const winnersContext = await resolveWinnersContext(
      { agency: opp.agency, naicsCode: opp.naicsCode },
      consultingFirmId,
    )

    if (winnersContext) {
      void logAudit({
        consultingFirmId,
        actorUserId: req.user?.userId ?? null,
        action: 'LLM_INFERENCE',
        entityType: 'PROPOSAL_DRAFT',
        entityId: opp.id,
        rationale: `Winners Intel injection: ${winnersContext.sliceKeys.length} slices, ~${winnersContext.totalEstimatedTokens} tokens, content sha256=${winnersContext.contentSha256.slice(0, 16)}`,
        after: {
          sliceKeys: winnersContext.sliceKeys,
          contentSha256: winnersContext.contentSha256,
          manifestGeneratedAt: winnersContext.manifestGeneratedAt,
        },
      })
    }

    // Pull the offeror's real, structured past-performance records so the Past
    // Performance volume cites actual prior contracts instead of placeholders.
    // Scope: a client offeror → that client's records; the firm itself → its
    // firm-level records (clientCompanyId IS NULL). Best-effort.
    let pastPerformanceRecords: PastPerformanceForProposal[] = []
    try {
      pastPerformanceRecords = await getRelevantPastPerformanceRecords(
        consultingFirmId,
        offeror.source === 'CLIENT_COMPANY' ? (clientCompanyId as string) : null,
        { naicsCode: opp.naicsCode, agency: opp.agency },
      )
    } catch (ppErr) {
      logger.warn('Relevant past-performance fetch failed; drafting without it', {
        opportunityId,
        error: (ppErr as Error).message,
      })
    }

    const draft = await generateProposalDraft(
      opp.title,
      opp.agency,
      requirements,
      {
        naicsCode: opp.naicsCode ?? undefined,
        setAsideType: opp.setAsideType,
        estimatedValue: opp.estimatedValue ? Number(opp.estimatedValue) : null,
        historicalWinner: opp.historicalWinner,
        description: opp.description,
      },
      consultingFirmId,
      offeror,
      answers,
      userGuidance,
      bidFormContext,
      opp.id,
      winnersContext?.context ?? null,
      pastPerformanceRecords,
    )

    logger.info('Proposal draft generated, building PDF', {
      opportunityId,
      sectionCount: draft.sections.length,
      clientBrandingApplied,
      winnersIntelApplied: Boolean(winnersContext),
      winnersIntelSliceCount: winnersContext?.sliceKeys.length ?? 0,
    })

    const pdfBuffer = await buildProposalPdf(draft, clientBranding)

    if (!pdfBuffer || pdfBuffer.length < 1024) {
      logger.error('Generated PDF buffer is empty or too small — refusing to charge', {
        opportunityId,
        size: pdfBuffer?.length ?? 0,
      })
      return res.status(500).json({
        success: false,
        error: 'Generated draft was empty. No tokens were charged. Please try again.',
        code: 'EMPTY_DRAFT',
      })
    }

    // Persist draft + PDF FIRST so the artifact is recoverable even if the
    // client connection drops before res.send completes. Tokens are only
    // deducted after persistence succeeds — if persist fails, no charge.
    const pdfKey = `proposal_${opportunityId}.pdf`
    const uploadsDir = path.join(process.cwd(), 'uploads')
    const pdfPath = path.join(uploadsDir, pdfKey)
    try {
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })
      fs.writeFileSync(pdfPath, pdfBuffer)
      await prisma.opportunity.update({
        where: { id: opportunityId },
        data: {
          savedProposalDraft: draft as any,
          savedProposalPdfKey: pdfKey,
          savedProposalDraftAt: new Date(),
          // Persist the branding so the human-reviewed final PDF re-renders
          // identically to this draft (FIX-6). JsonNull when no client branding.
          savedProposalBranding: clientBranding ? (clientBranding as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      })
    } catch (persistErr) {
      logger.error('Failed to persist proposal draft — refusing to charge', { opportunityId, error: (persistErr as Error).message })
      return res.status(500).json({
        success: false,
        error: 'Could not save the generated draft. No tokens were charged. Please try again.',
        code: 'PERSIST_FAILED',
      })
    }

    await deductProposalTokens(consultingFirmId, 5, {
      userId: req.user?.userId ?? null,
      opportunityId,
      reason: clientBrandingApplied
        ? `Full draft generation (5 tokens) with client branding`
        : `Full draft generation (5 tokens)`,
    })

    const safeName = opp.title.replace(/[^a-z0-9]/gi, '_').slice(0, 60)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Proposal_Draft_${safeName}.pdf"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    // Surface truncation to the client in headers — the response body is a
    // PDF blob so we cannot include JSON. The frontend reads X-Draft-Partial
    // and shows a yellow review-required banner instead of the green ready
    // toast. CORS-exposed via Access-Control-Expose-Headers below.
    if (draft.partial) {
      res.setHeader('X-Draft-Partial', 'true')
    }
    res.setHeader('Access-Control-Expose-Headers', 'X-Draft-Partial')
    res.send(pdfBuffer)
  } catch (err: any) {
    if (err?.message === 'NO_LLM_KEY') {
      return res.status(400).json({ success: false, error: 'No AI key configured — go to Settings to add your API key.', code: 'NO_AI_KEY' })
    }
    if (err?.message === 'RATE_LIMITED') {
      return res.status(429).json({ success: false, error: 'AI rate limit reached — please wait 60 seconds and try again.', code: 'RATE_LIMITED' })
    }
    if (err?.message === 'EMPTY_LLM_OUTPUT') {
      return res.status(502).json({
        success: false,
        error: 'The AI provider returned no usable content. No tokens were charged. Please verify your AI provider in Settings and try again.',
        code: 'EMPTY_LLM_OUTPUT',
      })
    }
    next(err)
  }
})

// ---------------------------------------------------------------
// POST /api/proposal-assist/:opportunityId/extract-form
// Accepts: file upload (PDF, Word, Excel, CSV, TXT)
// Returns: { text: string } — extracted text content for AI context
// ---------------------------------------------------------------
router.post('/:opportunityId/extract-form', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  let storedFilePath: string | null = null
  try {
    const consultingFirmId = getTenantId(req)
    const { opportunityId } = req.params

    const opp = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      select: { id: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')
    if (!req.file) return res.status(400).json({ error: 'File is required' })

    storedFilePath = req.file.path
    const ext = path.extname(req.file.originalname).toLowerCase()
    let text = ''

    if (ext === '.pdf') {
      text = await (docAnalysisService as any).extractPdfText(storedFilePath)
    } else if (ext === '.docx' || ext === '.doc') {
      const mammoth = await import('mammoth')
      const result = await mammoth.extractRawText({ path: storedFilePath })
      text = result.value
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(storedFilePath)
      const lines: string[] = []
      workbook.SheetNames.forEach(sheetName => {
        lines.push(`=== Sheet: ${sheetName} ===`)
        const sheet = workbook.Sheets[sheetName]
        const rows = XLSX.utils.sheet_to_csv(sheet)
        lines.push(rows)
      })
      text = lines.join('\n')
    } else if (ext === '.csv') {
      text = fs.readFileSync(storedFilePath, 'utf-8')
    } else {
      text = fs.readFileSync(storedFilePath, 'utf-8')
    }

    // Clean up the temp file
    try { fs.unlinkSync(storedFilePath) } catch {}
    storedFilePath = null

    const truncated = text.trim().slice(0, 8000)
    if (!truncated) return res.status(422).json({ error: 'Could not extract readable text from this file.' })

    logger.info('Bid form extracted', { opportunityId, fileName: req.file.originalname, chars: truncated.length })
    res.json({ success: true, text: truncated, fileName: req.file.originalname })
  } catch (err) {
    if (storedFilePath) { try { fs.unlinkSync(storedFilePath) } catch {} }
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/proposal-assist/:opportunityId/saved
// Returns saved outline, answers, step, and draft metadata so the
// user doesn't lose work or get re-billed on reopen.
// ---------------------------------------------------------------
router.get('/:opportunityId/saved', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: {
        savedProposalOutline: true,
        savedProposalAnswers: true,
        savedProposalStep: true,
        savedProposalDraft: true,
        savedProposalPdfKey: true,
        savedProposalDraftAt: true,
      },
    })
    if (!opp) throw new NotFoundError('Opportunity')

    // Verify the cached PDF still exists on disk before reporting it
    let hasDraftPdf = false
    if (opp.savedProposalPdfKey) {
      const pdfPath = path.join(process.cwd(), 'uploads', opp.savedProposalPdfKey)
      hasDraftPdf = fs.existsSync(pdfPath)
    }

    // Surface the partial flag back to the UI so reopening an opportunity
    // whose draft was generated under truncation re-shows the review-required
    // banner. Defensive cast: savedProposalDraft is Prisma JSON, may be null,
    // and may pre-date the partial-flag column entirely.
    const draftJson = opp.savedProposalDraft as { partial?: unknown } | null
    const draftPartial = Boolean(draftJson && draftJson.partial === true)

    res.json({
      success: true,
      data: {
        outline: opp.savedProposalOutline,
        answers: opp.savedProposalAnswers,
        step: opp.savedProposalStep,
        draft: opp.savedProposalDraft,
        draftGeneratedAt: opp.savedProposalDraftAt,
        hasDraftPdf,
        draftPartial,
      },
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// GET /api/proposal-assist/:opportunityId/saved-draft/pdf
// Streams the most recently generated PDF without charging tokens.
// ---------------------------------------------------------------
router.get('/:opportunityId/saved-draft/pdf', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, title: true, savedProposalPdfKey: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')
    if (!opp.savedProposalPdfKey) {
      return res.status(404).json({ success: false, error: 'No saved draft', code: 'NO_SAVED_DRAFT' })
    }

    const pdfPath = path.join(process.cwd(), 'uploads', opp.savedProposalPdfKey)
    if (!fs.existsSync(pdfPath)) {
      return res.status(404).json({ success: false, error: 'Saved draft file is missing', code: 'NO_SAVED_DRAFT_FILE' })
    }

    const safeName = opp.title.replace(/[^a-z0-9]/gi, '_').slice(0, 60)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Proposal_Draft_${safeName}.pdf"`)
    fs.createReadStream(pdfPath).pipe(res)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// PUT /api/proposal-assist/:opportunityId/saved
// Persists outline, answers, and step so navigating away doesn't lose work
// ---------------------------------------------------------------
router.put('/:opportunityId/saved', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { outline, answers, step } = req.body

    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')

    await prisma.opportunity.update({
      where: { id: opp.id },
      data: {
        savedProposalOutline: outline ?? undefined,
        savedProposalAnswers: answers ?? undefined,
        savedProposalStep: step ?? undefined,
      },
    })

    res.json({ success: true })
  } catch (err) {
    next(err)
  }
})

// ===============================================================
// FIX-6 — human-in-the-loop attestation on AI-drafted proposals
// ===============================================================

// GET /api/proposal-assist/:opportunityId/attestation
// Current attestation status + the statement the operator must affirm.
router.get('/:opportunityId/attestation', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, savedProposalDraft: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')

    const hasDraft = !!opp.savedProposalDraft
    const att = await prisma.proposalAttestation.findUnique({ where: { opportunityId: opp.id } })
    const currentHash = hasDraft ? hashProposalDraft(opp.savedProposalDraft) : null
    const isStale = !!att && !!currentHash && att.draftContentHash !== currentHash

    // FIX-6 follow-up: per-section LLM confidence summary so the reviewer
    // knows which sections to rework first. Sections without a flag (older
    // drafts, truncation-recovered sections) count as unrated. Confidence is
    // excluded from the content hash, so this never affects staleness.
    const draftSections = Array.isArray((opp.savedProposalDraft as { sections?: unknown[] } | null)?.sections)
      ? ((opp.savedProposalDraft as { sections: Array<{ title?: unknown; confidence?: unknown }> }).sections)
      : []
    const confidence = { high: 0, medium: 0, low: 0, unrated: 0 }
    const flaggedSections: { title: string; confidence: 'MEDIUM' | 'LOW' }[] = []
    for (const s of draftSections) {
      if (s?.confidence === 'HIGH') confidence.high++
      else if (s?.confidence === 'MEDIUM' || s?.confidence === 'LOW') {
        confidence[s.confidence === 'MEDIUM' ? 'medium' : 'low']++
        flaggedSections.push({ title: typeof s.title === 'string' ? s.title : 'Untitled section', confidence: s.confidence })
      } else confidence.unrated++
    }
    // LOW first — that's the review order.
    flaggedSections.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === 'LOW' ? -1 : 1))

    res.json({
      success: true,
      data: {
        hasDraft,
        statement: PROPOSAL_ATTESTATION_STATEMENT,
        statementVersion: PROPOSAL_ATTESTATION_VERSION,
        attested: !!att && !isStale,
        isStale,
        attestation: att
          ? { attestedByName: att.attestedByName, attestedAt: att.attestedAt, statementVersion: att.statementVersion }
          : null,
        // The hash of the draft this response describes — the client echoes it
        // back on POST /attest so the attestation provably covers the draft
        // the reviewer actually saw (409 on mismatch).
        draftContentHash: currentHash,
        confidence,
        flaggedSections,
      },
    })
  } catch (err) {
    next(err)
  }
})

// POST /api/proposal-assist/:opportunityId/attest
// Record that a responsible human reviewed THIS draft. Requires confirmed:true
// (mirrors the deidentificationConfirmed gate on shared templates). Pins the
// attestation to the draft's content hash so a later edit reads as stale.
router.post('/:opportunityId/attest', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    if (req.body?.confirmed !== true) {
      return res.status(422).json({
        success: false,
        error: 'You must confirm (confirmed:true) that you have reviewed the draft in full before attesting.',
        code: 'ATTESTATION_NOT_CONFIRMED',
      })
    }

    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, savedProposalDraft: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')
    if (!opp.savedProposalDraft) {
      return res.status(409).json({ success: false, error: 'Generate a proposal draft before attesting.', code: 'NO_DRAFT' })
    }

    const hash = hashProposalDraft(opp.savedProposalDraft)

    // Review-what-you-attest: the client must send the hash of the draft it
    // DISPLAYED (from GET /attestation). Without this, an attest click pins
    // whatever is in the DB at that instant — if a colleague (or a second tab)
    // regenerated the draft between review and click, the reviewer would
    // unknowingly take professional responsibility for content nobody read.
    const reviewedHash = typeof req.body?.draftContentHash === 'string' ? req.body.draftContentHash : null
    if (!reviewedHash) {
      return res.status(422).json({
        success: false,
        error: 'draftContentHash of the reviewed draft is required — reload the proposal panel and re-attest.',
        code: 'ATTESTATION_HASH_REQUIRED',
      })
    }
    if (reviewedHash !== hash) {
      return res.status(409).json({
        success: false,
        error: 'The draft changed since you reviewed it. Re-read the current draft and attest again.',
        code: 'DRAFT_CHANGED_SINCE_REVIEW',
      })
    }

    const user = req.user?.userId
      ? await prisma.user.findUnique({ where: { id: req.user.userId }, select: { firstName: true, lastName: true, email: true } })
      : null
    const attestedByName =
      (user && [user.firstName, user.lastName].filter(Boolean).join(' ').trim()) || user?.email || req.user?.email || 'Unknown'

    const att = await prisma.proposalAttestation.upsert({
      where: { opportunityId: opp.id },
      create: {
        consultingFirmId,
        opportunityId: opp.id,
        attestedByUserId: req.user?.userId ?? null,
        attestedByName,
        statementVersion: PROPOSAL_ATTESTATION_VERSION,
        statementText: PROPOSAL_ATTESTATION_STATEMENT,
        draftContentHash: hash,
      },
      update: {
        attestedByUserId: req.user?.userId ?? null,
        attestedByName,
        statementVersion: PROPOSAL_ATTESTATION_VERSION,
        statementText: PROPOSAL_ATTESTATION_STATEMENT,
        draftContentHash: hash,
        attestedAt: new Date(),
      },
    })

    void logAudit({
      consultingFirmId,
      actorUserId: req.user?.userId ?? null,
      action: 'APPROVAL',
      entityType: 'PROPOSAL_DRAFT',
      entityId: opp.id,
      rationale: `Human-in-the-loop proposal attestation ${PROPOSAL_ATTESTATION_VERSION} by ${attestedByName}`,
      after: { draftContentHash: hash },
    })

    res.json({
      success: true,
      data: { attestedByName: att.attestedByName, attestedAt: att.attestedAt, statementVersion: att.statementVersion },
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/proposal-assist/:opportunityId/final-pdf
// The gated "final" export. Re-renders the saved draft with a HUMAN-REVIEWED
// cover stamp — but only when a current (non-stale) attestation is on record.
router.get('/:opportunityId/final-pdf', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: { id: true, title: true, savedProposalDraft: true, savedProposalBranding: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')
    if (!opp.savedProposalDraft) {
      return res.status(404).json({ success: false, error: 'No saved draft to finalize.', code: 'NO_SAVED_DRAFT' })
    }

    const att = await prisma.proposalAttestation.findUnique({ where: { opportunityId: opp.id } })
    if (!att) {
      return res.status(403).json({
        success: false,
        error: 'A human-in-the-loop attestation is required before exporting a final proposal. Review the draft, then attest.',
        code: 'ATTESTATION_REQUIRED',
      })
    }
    const currentHash = hashProposalDraft(opp.savedProposalDraft)
    if (att.draftContentHash !== currentHash) {
      return res.status(403).json({
        success: false,
        error: 'The draft changed since it was attested. Re-review and re-attest before exporting the final proposal.',
        code: 'ATTESTATION_STALE',
      })
    }

    const branding = (opp.savedProposalBranding ?? undefined) as ProposalBranding | undefined
    const pdfBuffer = await buildProposalPdf(opp.savedProposalDraft as any, branding, {
      status: 'REVIEWED',
      attestedByName: att.attestedByName,
      attestedAt: att.attestedAt.toISOString().slice(0, 10),
      statementVersion: att.statementVersion,
    })

    void logAudit({
      consultingFirmId,
      actorUserId: req.user?.userId ?? null,
      action: 'EXPORT',
      entityType: 'PROPOSAL_FINAL',
      entityId: opp.id,
      rationale: `Final (human-reviewed) proposal exported; attested by ${att.attestedByName} (${att.statementVersion})`,
    })

    const safeName = opp.title.replace(/[^a-z0-9]/gi, '_').slice(0, 60)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Proposal_FINAL_${safeName}.pdf"`)
    res.setHeader('Content-Length', pdfBuffer.length)
    res.send(pdfBuffer)
  } catch (err) {
    next(err)
  }
})

export default router
