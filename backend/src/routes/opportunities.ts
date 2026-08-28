// =============================================================
// Opportunities Routes
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { logAudit } from '../services/auditService'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors'
import { classifyDeadline } from '../engines/deadlinePriority'
import { samApiService } from '../services/samApi'
import { scoringQueue } from '../workers/scoringWorker'
import { runPortfolioEvaluation } from '../services/portfolioDecisionEngine'
import { upload } from '../middleware/upload'
import { logger } from '../utils/logger'
import { evaluateBidDecision } from '../services/decisionEngine'
import { getEntitlementsForRequest, hasAddonEntitlement } from '../services/entitlementService'
import { buildOpportunityWhere } from '../services/opportunityFilters'
import { resolveStoredProbability } from '../services/winProbability'
import { OpportunitySource } from '@prisma/client'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

// The setAsideType filter (list + export) is part of the Set-Aside
// Intelligence add-on; the rest of search stays base.
async function allowSetAsideFilter(req: AuthenticatedRequest): Promise<boolean> {
  const ents = await getEntitlementsForRequest(req, getTenantId(req))
  return hasAddonEntitlement(ents, 'setaside_intel')
}

function sendSetAsideAddonRequired(res: Response) {
  return res.status(403).json({
    success: false,
    code: 'ADDON_REQUIRED',
    addon: 'setaside_intel',
    error: 'Set-aside filtering is part of the Set-Aside Intelligence add-on ($29/mo). Add it from the Billing page.',
  })
}

const IngestSchema = z.object({
  naicsCode: z.string().optional(),
  agency: z.string().optional(),
  setAsideType: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(25),
})

const ScoreSchema = z.object({
  clientCompanyId: z.string().min(1),
})

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function buildPlainAmendmentSummary(input: { title?: string | null; description?: string | null }): string {
  const text = `${input.title || ''}. ${input.description || ''}`.trim()
  if (!text) return 'No amendment details were provided.'

  const normalized = text.replace(/\s+/g, ' ').trim()
  const points: string[] = []

  if (/deadline|due date|closing date|submission date/i.test(normalized)) {
    points.push('Timeline terms appear to have changed; verify the revised response deadline before submission')
  }
  if (/attach|appendix|specification|statement of work|sow/i.test(normalized)) {
    points.push('Scope or attachment references were updated; review all newly referenced files')
  }
  if (/eligib|set-?aside|sdvosb|wosb|hubzone|8\(a\)|small business/i.test(normalized)) {
    points.push('Eligibility or set-aside language is present; re-check certification alignment')
  }
  if (/wage|labor|clearance|security|background/i.test(normalized)) {
    points.push('Labor/security compliance language appears; validate staffing and compliance documentation')
  }

  const sentences = normalized
    .split(/[.!?]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => `Key update: ${s}`)

  points.push(...sentences)

  const unique = Array.from(new Set(points)).slice(0, 4)
  return unique.join(' | ')
}

// -------------------------------------------------------------
// GET /api/opportunities
// -------------------------------------------------------------
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const q = req.query

    const page = Math.max(1, parseInt(String(q.page || '1'), 10) || 1)
    const limit = Math.min(100, Math.max(1, parseInt(String(q.limit || '25'), 10) || 25))
    const sortBy = String(q.sortBy || 'probability')
    const sortOrder = String(q.sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'

    // Validate enum-constrained filters up front so malformed values fail fast
    // (422) instead of silently returning an empty list or reaching Prisma.
    const OPP_STATUSES = ['ACTIVE', 'ARCHIVED', 'EXPIRED', 'AWARDED', 'CANCELLED']
    const OPP_SOURCES: string[] = Object.values(OpportunitySource)
    const PIPELINE_STAGES = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED', 'AWARDED', 'LOST', 'NO_BID', 'ARCHIVED']
    const BID_DECISIONS = ['GO', 'NO_GO', 'PENDING']
    if (q.status && !OPP_STATUSES.includes(String(q.status))) throw new ValidationError(`status must be one of: ${OPP_STATUSES.join(', ')}`)
    if (q.source && !OPP_SOURCES.includes(String(q.source))) throw new ValidationError(`source must be one of: ${OPP_SOURCES.join(', ')}`)
    if (q.pipelineStage && !PIPELINE_STAGES.includes(String(q.pipelineStage))) throw new ValidationError(`pipelineStage must be one of: ${PIPELINE_STAGES.join(', ')}`)
    if (q.bidDecision && !BID_DECISIONS.includes(String(q.bidDecision))) throw new ValidationError(`bidDecision must be one of: ${BID_DECISIONS.join(', ')}`)

    // The setAsideType filter is add-on gated — preserve the 403 response when
    // the firm lacks the Set-Aside Intelligence add-on.
    let allowSetAside = true
    if (q.setAsideType) {
      allowSetAside = await allowSetAsideFilter(req)
      if (!allowSetAside) return sendSetAsideAddonRequired(res)
    }

    // Client fit filter: restrict to NAICS prefixes matching the client.
    let clientNaicsPrefixes: string[] | undefined
    if (q.clientId) {
      const client = await prisma.clientCompany.findFirst({
        where: { id: String(q.clientId), consultingFirmId },
        select: { naicsCodes: true },
      })
      if (client && client.naicsCodes.length > 0) {
        clientNaicsPrefixes = Array.from(new Set(client.naicsCodes.map((c: string) => c.slice(0, 4))))
      }
    }

    // Single source of truth for opportunity filtering (shared with saved
    // monitoring profiles). See services/opportunityFilters.ts.
    const where = buildOpportunityWhere(q as Record<string, unknown>, { consultingFirmId, allowSetAside, clientNaicsPrefixes })

    const sortFieldMap: Record<string, string> = {
      deadline: 'responseDeadline',
      probability: 'probabilityScore',
      expectedValue: 'expectedValue',
      estimatedValue: 'estimatedValue',
      createdAt: 'createdAt',
    }
    const orderByField = sortFieldMap[sortBy] || 'probabilityScore'

    const [opportunities, total] = await Promise.all([
      prisma.opportunity.findMany({
        where,
        // Secondary id sort guarantees a stable, deterministic total order even
        // when the primary sort key ties (e.g. many rows with probability 0).
        orderBy: [{ [orderByField]: sortOrder }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { _count: { select: { amendments: true } } },
      }),
      prisma.opportunity.count({ where }),
    ])

    const enriched = opportunities.map(({ _count, ...opp }) => ({
      ...opp,
      deadline: classifyDeadline(opp.responseDeadline),
      deadlineClassification: classifyDeadline(opp.responseDeadline),
      // Data-quality signals for honest UI badges/fallbacks.
      amendmentCount: _count.amendments,
      isAmended: _count.amendments > 0,
      hasValidSourceLink: !opp.isDemo && opp.source !== 'DEMO' && Boolean(opp.sourceUrl),
    }))

    res.json({
      success: true,
      data: enriched,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/opportunities/manual — create a hand-entered opportunity (ADMIN).
// Marked source=MANUAL so ingestion never overwrites it. samNoticeId stays null
// (no external id) — these are firm-authored records, not government feeds.
// Declared before GET /:id (different method, but keeps manual routes grouped).
// -------------------------------------------------------------
const ManualOpportunitySchema = z.object({
  title: z.string().trim().min(1).max(500),
  agency: z.string().trim().min(1).max(300),
  responseDeadline: z.string().datetime(),
  naicsCode: z.string().trim().max(10).optional(),
  setAsideType: z.string().trim().max(40).optional(),
  solicitationNumber: z.string().trim().max(120).optional(),
  estimatedValue: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  postedDate: z.string().datetime().nullable().optional(),
  placeOfPerformance: z.string().trim().max(300).optional(),
  description: z.string().trim().max(20000).optional(),
  sourceUrl: z.string().url().max(1000).optional(),
  noticeType: z.string().trim().max(80).optional(),
})

router.post('/manual', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ManualOpportunitySchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid opportunity payload')
    const d = parsed.data
    const created = await prisma.opportunity.create({
      data: {
        consultingFirmId,
        source: 'MANUAL',
        isDemo: false,
        status: 'ACTIVE',
        title: d.title,
        agency: d.agency,
        responseDeadline: new Date(d.responseDeadline),
        postedDate: d.postedDate ? new Date(d.postedDate) : null,
        naicsCode: d.naicsCode ?? '',
        setAsideType: d.setAsideType ?? 'NONE',
        solicitationNumber: d.solicitationNumber ?? null,
        estimatedValue: d.estimatedValue ?? null,
        placeOfPerformance: d.placeOfPerformance ?? null,
        description: d.description ?? null,
        sourceUrl: d.sourceUrl ?? null,
        noticeType: d.noticeType ?? null,
        marketCategory: 'SERVICES',
        probabilityScore: 0,
        expectedValue: 0,
        isScored: false,
      },
    })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'CREATE', entityType: 'Opportunity', entityId: created.id, rationale: 'Manual opportunity created', after: { source: 'MANUAL', title: created.title } })
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

// PATCH /api/opportunities/:id — edit a MANUAL opportunity (ADMIN). SAM_GOV and
// other real-source records are read-only.
router.patch('/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!opp) throw new NotFoundError('Opportunity')
    if (opp.source !== 'MANUAL') throw new ConflictError('Only manually-created opportunities can be edited.')
    const b = req.body ?? {}
    const data: Record<string, unknown> = {}
    if (typeof b.title === 'string' && b.title.trim()) data.title = b.title.trim().slice(0, 500)
    if (typeof b.agency === 'string') data.agency = b.agency.trim()
    if (b.responseDeadline) data.responseDeadline = new Date(b.responseDeadline)
    for (const k of ['description', 'naicsCode', 'setAsideType', 'solicitationNumber', 'sourceUrl', 'estimatedValue'] as const) if (k in b) data[k] = b[k] ?? null
    const updated = await prisma.opportunity.update({ where: { id: opp.id }, data })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'Opportunity', entityId: opp.id, rationale: 'Manual opportunity edited' })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// POST /:id/archive — hide the opportunity (ADMIN). Restorable.
router.post('/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const updated = await prisma.opportunity.update({ where: { id: opp.id }, data: { status: 'ARCHIVED', archiveDate: new Date() } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'ARCHIVED', entityType: 'Opportunity', entityId: opp.id, rationale: 'Opportunity archived' })
    res.json({ success: true, data: { id: updated.id, status: updated.status } })
  } catch (err) { next(err) }
})

router.post('/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!opp) throw new NotFoundError('Opportunity')
    const updated = await prisma.opportunity.update({ where: { id: opp.id }, data: { status: 'ACTIVE', archiveDate: null } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'RESTORED', entityType: 'Opportunity', entityId: opp.id, rationale: 'Opportunity restored' })
    res.json({ success: true, data: { id: updated.id, status: updated.status } })
  } catch (err) { next(err) }
})

// DELETE /:id — hard-delete a MANUAL opportunity (ADMIN) ONLY when it has no
// linked pursuit / proposal / bid decision / submission. Otherwise archive.
router.delete('/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: { _count: { select: { bidPursuits: true, proposals: true, bidDecisions: true, submissionRecords: true } } },
    })
    if (!opp) throw new NotFoundError('Opportunity')
    if (opp.source !== 'MANUAL') throw new ConflictError('Only manually-created opportunities can be deleted.')
    const links = opp._count.bidPursuits + opp._count.proposals + opp._count.bidDecisions + opp._count.submissionRecords
    if (links > 0) throw new ConflictError('This opportunity has linked pursuits/proposals/decisions/submissions — archive it instead of deleting.')
    await prisma.opportunity.delete({ where: { id: opp.id } })
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'DELETE', entityType: 'Opportunity', entityId: opp.id, rationale: 'Manual opportunity deleted' })
    res.json({ success: true, data: { deleted: true } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/opportunities/export
// Full filtered pipeline (no pagination, capped) for CSV export. Mirrors the
// list filters; returns a curated, flat-friendly field set including the
// enrichment signals the paginated list carries but the UI doesn't show.
// MUST be declared before GET /:id so 'export' isn't captured as an :id.
// -------------------------------------------------------------
router.get('/export', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const q = req.query
    const MAX_EXPORT = 5000

    const where: any = { consultingFirmId }
    if (String(q.includeDemo) !== 'true') where.isDemo = false // Section 4 #2
    if (q.showExpired !== 'true') where.responseDeadline = { gte: new Date() }
    if (q.naicsCode) where.naicsCode = { startsWith: String(q.naicsCode) }
    if (q.agency) where.agency = { contains: String(q.agency), mode: 'insensitive' }
    if (q.setAsideType) {
      if (!(await allowSetAsideFilter(req))) return sendSetAsideAddonRequired(res)
      where.setAsideType = String(q.setAsideType)
    }
    if (q.status) where.status = String(q.status)
    // Free-text search over title / notice id / agency — powers pickers like
    // the teaming recommender's bid search (which sends `search` and would
    // otherwise silently get the unfiltered top-N list).
    if (q.search && String(q.search).trim()) {
      const term = String(q.search).trim()
      where.AND = [
        ...(where.AND ?? []),
        {
          OR: [
            { title: { contains: term, mode: 'insensitive' } },
            { samNoticeId: { contains: term, mode: 'insensitive' } },
            { agency: { contains: term, mode: 'insensitive' } },
          ],
        },
      ]
    }
    if (q.placeOfPerformance) where.placeOfPerformance = { contains: String(q.placeOfPerformance), mode: 'insensitive' }
    if (q.recompeteOnly === 'true') where.recompeteFlag = true
    if (q.enrichedOnly === 'true') where.isEnriched = true
    if (q.contractVehicle) where.contractVehicle = String(q.contractVehicle)
    if (q.hasVehicle === 'true') where.contractVehicle = { not: null }

    const estimatedValueMin = toNumber(q.estimatedValueMin)
    const estimatedValueMax = toNumber(q.estimatedValueMax)
    if (estimatedValueMin !== undefined || estimatedValueMax !== undefined) {
      where.estimatedValue = {}
      if (estimatedValueMin !== undefined) where.estimatedValue.gte = estimatedValueMin
      if (estimatedValueMax !== undefined) where.estimatedValue.lte = estimatedValueMax
    }
    const probabilityMin = toNumber(q.probabilityMin)
    if (probabilityMin !== undefined) where.probabilityScore = { gte: probabilityMin }

    const daysUntilDeadline = toNumber(q.daysUntilDeadline)
    if (daysUntilDeadline !== undefined) {
      const now = new Date()
      where.responseDeadline = { gt: now, lte: new Date(now.getTime() + daysUntilDeadline * 86400000) }
    }

    if (q.clientId) {
      const client = await prisma.clientCompany.findFirst({
        where: { id: String(q.clientId), consultingFirmId },
        select: { naicsCodes: true },
      })
      if (client && client.naicsCodes.length > 0) {
        const prefixes = Array.from(new Set(client.naicsCodes.map((c: string) => c.slice(0, 4))))
        where.OR = prefixes.map((prefix: string) => ({ naicsCode: { startsWith: prefix } }))
      }
    }

    const sortFieldMap: Record<string, string> = {
      deadline: 'responseDeadline', probability: 'probabilityScore',
      expectedValue: 'expectedValue', estimatedValue: 'estimatedValue', createdAt: 'createdAt',
    }
    const orderByField = sortFieldMap[String(q.sortBy || 'probability')] || 'probabilityScore'
    const sortOrder = String(q.sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'

    const rows = await prisma.opportunity.findMany({
      where,
      orderBy: { [orderByField]: sortOrder },
      take: MAX_EXPORT,
      select: {
        title: true, agency: true, subagency: true, naicsCode: true, setAsideType: true,
        noticeType: true, status: true, samNoticeId: true,
        estimatedValue: true, expectedValue: true, probabilityScore: true,
        responseDeadline: true, postedDate: true, createdAt: true,
        placeOfPerformance: true, contractVehicle: true, vehicleType: true,
        isEnriched: true, recompeteFlag: true,
        competitionCount: true, offersReceived: true,
        incumbentProbability: true, incumbentSignalDetected: true,
        historicalWinner: true, historicalAwardCount: true, historicalAvgAward: true,
        agencySmallBizRate: true, agencySdvosbRate: true,
        sourceUrl: true,
      },
    })

    const total = await prisma.opportunity.count({ where })

    res.json({
      success: true,
      data: rows,
      meta: { count: rows.length, total, capped: total > MAX_EXPORT, max: MAX_EXPORT },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/opportunities/:id/win-probability
// The single source of truth for the displayed win probability + calibration
// labelling (§5.1 Stage 3). Resolves the persisted RAW probabilityScore through
// the calibration resolver (applied once, strict guards, honest RAW/CALIBRATED/
// FALLBACK metadata). Declared before GET /:id (more specific path).
// -------------------------------------------------------------
router.get('/:id/win-probability', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opp = await prisma.opportunity.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, probabilityScore: true, isScored: true },
    })
    if (!opp) throw new NotFoundError('Opportunity')
    if (!opp.isScored) {
      return res.json({ success: true, data: { scored: false, rawScore: null, finalScore: null, scoreType: null } })
    }
    const resolved = resolveStoredProbability(opp.probabilityScore)
    res.json({ success: true, data: { scored: true, ...resolved } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/opportunities/:id
// -------------------------------------------------------------
router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { id } = req.params

    const opportunity = await prisma.opportunity.findFirst({
      where: { id, consultingFirmId },
      include: {
        documents: true,
        amendments: true,
        awardHistory: true,
      },
    })

    if (!opportunity) throw new NotFoundError('Opportunity not found')

    // Bid-pursuit tracker: opening a live solicitation starts a REVIEWING
    // pursuit the dashboard widget will prompt on. Fire-and-forget so the
    // read path never slows or fails on it. Award notices and expired
    // opportunities carry no bid decision to make.
    const isAwardNotice = (opportunity.noticeType ?? '').toLowerCase().includes('award')
    if (!isAwardNotice && opportunity.status === 'ACTIVE' && opportunity.responseDeadline > new Date()) {
      void prisma.bidPursuit
        .upsert({
          where: { consultingFirmId_opportunityId: { consultingFirmId, opportunityId: id } },
          update: {},
          create: { consultingFirmId, opportunityId: id },
        })
        .catch(() => {})
    }

    // If scoreBreakdown not stored on opportunity, build it from the latest bid decision
    let scoreBreakdown: any = opportunity.scoreBreakdown || null
    if (!scoreBreakdown) {
      const WEIGHTS: Record<string, number> = {
        naicsOverlapScore: 0.22, setAsideAlignmentScore: 0.20, incumbentWeaknessScore: 0.18,
        documentAlignmentScore: 0.15, agencyAlignmentScore: 0.12, awardSizeFitScore: 0.08,
        competitionDensityScore: 0.03, historicalDistribution: 0.02,
      }
      const latestDecision = await prisma.bidDecision.findFirst({
        where: { opportunityId: id, consultingFirmId },
        orderBy: { updatedAt: 'desc' },
        select: { explanationJson: true, winProbability: true },
      })
      const features = (latestDecision?.explanationJson as any)?.featureBreakdown || null
      if (features && Object.keys(features).length > 0) {
        const rawZ = Object.entries(features).reduce((sum, [k, v]) => sum + (WEIGHTS[k] || 0) * Number(v), 0)
        const factorContributions = Object.entries(features).map(([factor, score]) => {
          const numeric = Number(score) || 0
          const weight = WEIGHTS[factor] || 0
          const contribution = weight * numeric
          return { factor, score: numeric, weight, contribution, pct: Math.round(numeric * 100) }
        })
        scoreBreakdown = {
          factorContributions,
          formula: { equation: 'P(win) = 1 / (1 + e^-(6Z - 3))', rawZ },
          rawScore: rawZ,
          probability: latestDecision?.winProbability ? Number(latestDecision.winProbability) : undefined,
          generatedAt: new Date().toISOString(),
        }
      }
    }

    res.json({
      success: true,
      data: {
        ...opportunity,
        scoreBreakdown,
        documents: opportunity.documents.map((doc) => ({
          ...doc,
          fileUrl: `/api/documents/download/${doc.id}`,
        })),
        deadline: classifyDeadline(opportunity.responseDeadline),
        deadlineClassification: classifyDeadline(opportunity.responseDeadline),
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/opportunities/ingest
// -------------------------------------------------------------
router.post('/ingest', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const params = IngestSchema.parse(req.body)

    logger.info('Ingestion triggered', { consultingFirmId, params })

    const stats = await samApiService.searchAndIngest(params, consultingFirmId)

    const unscoredOpps = await prisma.opportunity.findMany({
      where: { consultingFirmId, isScored: false, status: 'ACTIVE' },
      select: { id: true },
      take: 500,
    })

    if (unscoredOpps.length > 0) {
      await scoringQueue.addBulk(
        unscoredOpps.map((opp) => ({
          name: 'score-opportunity',
          data: { opportunityId: opp.id, consultingFirmId },
        }))
      )
    }

    await runPortfolioEvaluation(consultingFirmId)

    await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: { lastIngestedAt: new Date() },
    })

    res.json({
      success: true,
      data: {
        ...stats,
        scoringJobsQueued: unscoredOpps.length,
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/opportunities/:id/score
// -------------------------------------------------------------
router.post('/:id/score', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { clientCompanyId } = ScoreSchema.parse(req.body)
    const { id: opportunityId } = req.params

    const [opportunity, client] = await Promise.all([
      prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId }, select: { id: true } }),
      prisma.clientCompany.findFirst({ where: { id: clientCompanyId, consultingFirmId, isActive: true }, select: { id: true } }),
    ])

    if (!opportunity) throw new NotFoundError('Opportunity not found')
    if (!client) throw new ValidationError('clientCompanyId is required and must belong to your firm')

    const decision = await evaluateBidDecision(opportunityId, clientCompanyId)
    res.json({ success: true, data: decision })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/opportunities/:id/score-breakdown
// -------------------------------------------------------------
router.get('/:id/score-breakdown', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { id: opportunityId } = req.params

    const opportunity = await prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      select: {
        id: true,
        probabilityScore: true,
        expectedValue: true,
        estimatedValue: true,
        scoreBreakdown: true,
      },
    })

    if (!opportunity) throw new NotFoundError('Opportunity not found')

    let breakdown = opportunity.scoreBreakdown as any

    if (!breakdown) {
      const latestDecision = await prisma.bidDecision.findFirst({
        where: { opportunityId, consultingFirmId },
        orderBy: { updatedAt: 'desc' },
        select: { explanationJson: true },
      })

      const features = (latestDecision?.explanationJson as any)?.featureBreakdown || null
      if (features) {
        const factorContributions = Object.entries(features).map(([factor, score]) => {
          const numeric = Number(score) || 0
          return {
            factor,
            score: numeric,
            pct: Math.round(numeric * 100),
          }
        })

        breakdown = {
          factorContributions,
          generatedAt: new Date().toISOString(),
        }
      }
    }

    res.json({
      success: true,
      data: {
        probability: opportunity.probabilityScore,
        expectedValue: Number(opportunity.expectedValue || 0),
        estimatedValue: Number(opportunity.estimatedValue || 0),
        breakdown,
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/opportunities/:id/amendments/:amendmentId/interpret
// -------------------------------------------------------------
router.post('/:id/amendments/:amendmentId/interpret', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { id: opportunityId, amendmentId } = req.params

    const amendment = await prisma.amendment.findFirst({
      where: {
        id: amendmentId,
        opportunityId,
        opportunity: { consultingFirmId },
      },
      select: {
        id: true,
        title: true,
        description: true,
      },
    })
    if (!amendment) throw new NotFoundError('Amendment not found')

    const plainLanguageSummary = buildPlainAmendmentSummary(amendment)
    const updated = await prisma.amendment.update({
      where: { id: amendment.id },
      data: {
        plainLanguageSummary,
        interpretedAt: new Date(),
      },
    })

    res.json({ success: true, data: updated })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/opportunities/:id/documents
// -------------------------------------------------------------
router.post(
  '/:id/documents',
  upload.single('file'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const { id } = req.params

      const opportunity = await prisma.opportunity.findFirst({
        where: { id, consultingFirmId },
      })

      if (!opportunity) throw new NotFoundError('Opportunity not found')
      if (!req.file) throw new ValidationError('File required')

      const document = await prisma.opportunityDocument.create({
        data: {
          opportunityId: id,
          fileName: req.file.originalname,
          storageKey: req.file.filename,
          fileUrl: null,
          fileType: req.file.mimetype,
          fileSize: req.file.size,
          isAmendment: req.body.isAmendment === 'true',
        },
      })

      res.json({
        success: true,
        data: {
          ...document,
          fileUrl: `/api/documents/download/${document.id}`,
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

export default router
