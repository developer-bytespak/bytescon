// =============================================================
// §6.1 — Opportunity Discovery API.
//
// Sources + sync runs · agency forecasts + linking · re-compete signals ·
// pre-solicitation notices · capability library · match/eligibility refresh.
//
// Every handler is tenant-scoped via getTenantId(req); no route trusts a
// client-supplied firm id. Mounted at /api/discovery.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import {
  AdapterVerification,
  ForecastLinkState,
  Prisma,
  RecompeteVerification,
  SourceCategory,
  SyncMode,
} from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
import { listAdapters, getAdapter } from '../services/discovery/sourceAdapter'
import { registerBuiltInAdapters } from '../services/discovery/adapters'
import { runSourceSync, deriveFreshness } from '../services/discovery/sourceSync'
import { linkForecastsToSolicitations } from '../services/discovery/forecastIngest'
import { detectRecompetes } from '../services/discovery/recompeteDetection'
import { refreshFirmMatches, refreshOpportunityMatch } from '../services/discovery/matchRefresh'
import { classifyNotice, PRESOLICITATION_KINDS } from '../services/noticeClassification'
import { emitFirmCapabilityChanged } from '../services/agents/opportunity/opportunityEvents'

registerBuiltInAdapters()

/** The capability fields that actually change matching, for the event fingerprint. */
function capabilityMaterial(row: {
  name: string
  keywords: string[]
  naicsCodes: string[]
  pscCodes: string[]
  geographies: string[]
  contractVehicles: string[]
  verification: string
  isArchived: boolean
}) {
  return {
    name: row.name,
    keywords: row.keywords,
    naicsCodes: row.naicsCodes,
    pscCodes: row.pscCodes,
    geographies: row.geographies,
    contractVehicles: row.contractVehicles,
    verification: row.verification,
    isArchived: row.isArchived,
  }
}

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityType: string, id: string, rationale?: string, before?: unknown, after?: unknown) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId: id, rationale, before, after })

// -------------------------------------------------------------
// §6.1A — Source adapters + configuration
// -------------------------------------------------------------

/** GET /adapters — the adapter catalogue, including honest coverage notes. */
router.get('/adapters', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({
      success: true,
      data: listAdapters().map((a) => ({
        key: a.key,
        displayName: a.displayName,
        category: a.category,
        produces: a.produces,
        supportsIncremental: a.supportsIncremental,
        // Rendered verbatim so the UI cannot overstate coverage.
        coverageNote: a.coverageNote,
        isDelegated: typeof a.runDelegatedSync === 'function',
      })),
    })
  } catch (err) { next(err) }
})

/** GET /sources — configured sources with real freshness state. */
router.get('/sources', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const configs = await prisma.opportunitySourceConfig.findMany({
      where: { consultingFirmId },
      orderBy: [{ isEnabled: 'desc' }, { displayName: 'asc' }],
      include: { syncRuns: { orderBy: { createdAt: 'desc' }, take: 1 } },
    })

    res.json({
      success: true,
      data: configs.map((c) => {
        const adapter = getAdapter(c.adapterKey)
        return {
          ...c,
          // Secrets are never returned — only the NAME of the env var.
          authEnvKey: c.authEnvKey,
          coverageNote: adapter?.coverageNote ?? null,
          freshness: deriveFreshness(c),
          lastRun: c.syncRuns[0] ?? null,
        }
      }),
    })
  } catch (err) { next(err) }
})

const SourceCreateSchema = z.object({
  adapterKey: z.string().trim().min(1).max(60),
  displayName: z.string().trim().min(1).max(160).optional(),
  isEnabled: z.boolean().optional(),
  baseUrl: z.string().trim().url().max(2000).nullable().optional(),
  authEnvKey: z.string().trim().max(120).nullable().optional(),
  config: z.record(z.unknown()).optional(),
  rateLimitPerMinute: z.number().int().min(1).max(6000).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  stalenessHours: z.number().int().min(1).max(720).optional(),
})

router.post('/sources', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = SourceCreateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid source payload')

    const adapter = getAdapter(parsed.data.adapterKey)
    if (!adapter) throw new ValidationError(`Unknown adapter "${parsed.data.adapterKey}"`)

    const existing = await prisma.opportunitySourceConfig.findUnique({
      where: { consultingFirmId_adapterKey: { consultingFirmId, adapterKey: parsed.data.adapterKey } },
      select: { id: true },
    })
    if (existing) throw new ValidationError('This source is already configured. Update it instead.')

    const created = await prisma.opportunitySourceConfig.create({
      data: {
        consultingFirmId,
        adapterKey: adapter.key,
        displayName: parsed.data.displayName ?? adapter.displayName,
        category: adapter.category,
        isEnabled: parsed.data.isEnabled ?? false,
        baseUrl: parsed.data.baseUrl ?? null,
        authEnvKey: parsed.data.authEnvKey ?? null,
        configJson: (parsed.data.config ?? {}) as Prisma.InputJsonValue,
        rateLimitPerMinute: parsed.data.rateLimitPerMinute ?? 60,
        timeoutMs: parsed.data.timeoutMs ?? 30000,
        maxAttempts: parsed.data.maxAttempts ?? 3,
        stalenessHours: parsed.data.stalenessHours ?? 48,
        // Never presented as live until a run proves it.
        verification: AdapterVerification.NOT_CONFIGURED,
      },
    })
    await audit(req, consultingFirmId, 'CREATE', 'OpportunitySourceConfig', created.id, `Configured source ${adapter.key}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

const SourceUpdateSchema = SourceCreateSchema.partial().omit({ adapterKey: true })

router.put('/sources/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = SourceUpdateSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid source payload')

    const existing = await prisma.opportunitySourceConfig.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Source configuration not found')

    const updated = await prisma.opportunitySourceConfig.update({
      where: { id: existing.id },
      data: {
        ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
        ...(parsed.data.isEnabled !== undefined ? { isEnabled: parsed.data.isEnabled } : {}),
        ...(parsed.data.baseUrl !== undefined ? { baseUrl: parsed.data.baseUrl } : {}),
        ...(parsed.data.authEnvKey !== undefined ? { authEnvKey: parsed.data.authEnvKey } : {}),
        ...(parsed.data.config !== undefined ? { configJson: parsed.data.config as Prisma.InputJsonValue } : {}),
        ...(parsed.data.rateLimitPerMinute !== undefined ? { rateLimitPerMinute: parsed.data.rateLimitPerMinute } : {}),
        ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
        ...(parsed.data.maxAttempts !== undefined ? { maxAttempts: parsed.data.maxAttempts } : {}),
        ...(parsed.data.stalenessHours !== undefined ? { stalenessHours: parsed.data.stalenessHours } : {}),
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'OpportunitySourceConfig', existing.id, 'Source configuration updated',
      { isEnabled: existing.isEnabled }, { isEnabled: updated.isEnabled })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/** POST /sources/:id/sync — run one source now (ADMIN). */
router.post('/sources/:id/sync', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const mode = req.body?.mode === 'FULL' ? SyncMode.FULL : SyncMode.INCREMENTAL
    const config = await prisma.opportunitySourceConfig.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true, adapterKey: true } })
    if (!config) throw new NotFoundError('Source configuration not found')

    const outcome = await runSourceSync(consultingFirmId, config.id, { mode })
    await audit(req, consultingFirmId, 'UPDATE', 'OpportunitySourceConfig', config.id, `Manual ${mode} sync: ${outcome.status}`)
    res.json({ success: true, data: outcome })
  } catch (err) { next(err) }
})

/** GET /sources/:id/runs — run history for observability. */
router.get('/sources/:id/runs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const config = await prisma.opportunitySourceConfig.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!config) throw new NotFoundError('Source configuration not found')
    const runs = await prisma.sourceSyncRun.findMany({
      where: { sourceConfigId: config.id },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(req.query.limit ?? 25) || 25, 100),
    })
    res.json({ success: true, data: runs })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.1B — Agency forecasts
// -------------------------------------------------------------

router.get('/forecasts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const q = req.query
    const where: Prisma.AgencyForecastWhereInput = { consultingFirmId, isArchived: false }

    if (typeof q.agency === 'string' && q.agency) where.agency = { contains: q.agency, mode: 'insensitive' }
    if (typeof q.naicsCode === 'string' && q.naicsCode) where.naicsCode = { startsWith: q.naicsCode }
    if (typeof q.setAside === 'string' && q.setAside) where.setAsideExpectation = { contains: q.setAside, mode: 'insensitive' }
    if (typeof q.vehicle === 'string' && q.vehicle) where.contractVehicle = { contains: q.vehicle, mode: 'insensitive' }
    if (typeof q.fiscalYear === 'string' && q.fiscalYear) where.fiscalYear = Number(q.fiscalYear)
    if (typeof q.linkState === 'string' && q.linkState) where.linkState = q.linkState as ForecastLinkState

    const from = typeof q.solicitationFrom === 'string' ? new Date(q.solicitationFrom) : null
    const to = typeof q.solicitationTo === 'string' ? new Date(q.solicitationTo) : null
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) {
      where.anticipatedSolicitationDate = {
        ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
        ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
      }
    }
    const valueMin = q.valueMin ? Number(q.valueMin) : null
    const valueMax = q.valueMax ? Number(q.valueMax) : null
    if (valueMin !== null || valueMax !== null) {
      where.estimatedValue = {
        ...(valueMin !== null && Number.isFinite(valueMin) ? { gte: valueMin } : {}),
        ...(valueMax !== null && Number.isFinite(valueMax) ? { lte: valueMax } : {}),
      }
    }

    const page = Math.max(1, Number(q.page ?? 1) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(q.pageSize ?? 25) || 25))

    const [items, total] = await Promise.all([
      prisma.agencyForecast.findMany({
        where,
        orderBy: [{ anticipatedSolicitationDate: 'asc' }, { agency: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { linkedOpportunity: { select: { id: true, title: true, responseDeadline: true } } },
      }),
      prisma.agencyForecast.count({ where }),
    ])

    res.json({
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        // The UI renders this badge verbatim on every row.
        recordKind: 'FORECAST',
        disclaimer: 'Forecasts are agency planning estimates published before a solicitation exists. They are not released solicitations and their dates frequently change.',
      },
    })
  } catch (err) { next(err) }
})

router.get('/forecasts/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const forecast = await prisma.agencyForecast.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        linkedOpportunity: { select: { id: true, title: true, responseDeadline: true, samNoticeId: true } },
        versions: { orderBy: { versionNo: 'desc' }, take: 25 },
      },
    })
    if (!forecast) throw new NotFoundError('Forecast not found')
    res.json({ success: true, data: { ...forecast, recordKind: 'FORECAST' } })
  } catch (err) { next(err) }
})

/** POST /forecasts/link — run deterministic forecast → solicitation linking. */
router.post('/forecasts/link', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const result = await linkForecastsToSolicitations(consultingFirmId)
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

const ForecastDecisionSchema = z.object({
  decision: z.enum(['CONFIRM', 'REJECT']),
  opportunityId: z.string().trim().min(1).optional(),
  reason: z.string().trim().max(1000).optional(),
})

/** POST /forecasts/:id/link-decision — human confirms or rejects a proposed link. */
router.post('/forecasts/:id/link-decision', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = ForecastDecisionSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid decision payload')

    const forecast = await prisma.agencyForecast.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!forecast) throw new NotFoundError('Forecast not found')

    const opportunityId = parsed.data.opportunityId ?? forecast.linkedOpportunityId
    if (parsed.data.decision === 'CONFIRM') {
      if (!opportunityId) throw new ValidationError('No opportunity to link. Supply opportunityId.')
      const opportunity = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId }, select: { id: true } })
      if (!opportunity) throw new NotFoundError('Opportunity not found')
    }

    const updated = await prisma.agencyForecast.update({
      where: { id: forecast.id },
      data: parsed.data.decision === 'CONFIRM'
        ? {
            linkedOpportunityId: opportunityId,
            linkState: ForecastLinkState.HUMAN_CONFIRMED,
            linkedAt: new Date(),
            linkedByUserId: req.user?.userId ?? null,
            linkEvidence: parsed.data.reason ?? forecast.linkEvidence,
          }
        : {
            linkedOpportunityId: null,
            linkState: ForecastLinkState.HUMAN_REJECTED,
            linkedAt: null,
            linkedByUserId: req.user?.userId ?? null,
            linkEvidence: parsed.data.reason ?? 'Rejected by reviewer.',
          },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'AgencyForecast', forecast.id, `Forecast link ${parsed.data.decision}`,
      { linkState: forecast.linkState }, { linkState: updated.linkState })
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.1C — Re-compete signals
// -------------------------------------------------------------

router.get('/recompetes', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.RecompeteSignalWhereInput = { consultingFirmId }
    if (typeof req.query.verification === 'string' && req.query.verification) {
      where.verification = req.query.verification as RecompeteVerification
    }
    if (req.query.hideDismissed === 'true') where.verification = { not: RecompeteVerification.DISMISSED }

    const signals = await prisma.recompeteSignal.findMany({
      where,
      orderBy: [{ windowStart: 'asc' }],
      take: Math.min(Number(req.query.limit ?? 100) || 100, 300),
    })
    res.json({
      success: true,
      data: {
        signals,
        disclaimer: 'These are estimated re-compete windows derived from recorded periods of performance and award history. They are not announced solicitation dates, and a re-compete is never certain.',
      },
    })
  } catch (err) { next(err) }
})

router.post('/recompetes/detect', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const leadDays = Number(req.body?.leadDays)
    const result = await detectRecompetes(consultingFirmId, {
      ...(Number.isInteger(leadDays) && leadDays > 0 ? { leadDays } : {}),
    })
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

const RecompeteDecisionSchema = z.object({
  verification: z.enum(['VERIFIED', 'CORRECTED', 'DISMISSED']),
  reason: z.string().trim().max(1000).optional(),
  windowStart: z.string().datetime().optional(),
  windowEnd: z.string().datetime().optional(),
})

/** PATCH /recompetes/:id — ADMIN verifies, corrects or dismisses a signal. */
router.patch('/recompetes/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = RecompeteDecisionSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid decision payload')

    const signal = await prisma.recompeteSignal.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!signal) throw new NotFoundError('Re-compete signal not found')

    if (parsed.data.verification === 'DISMISSED' && !parsed.data.reason) {
      throw new ValidationError('A reason is required when dismissing a signal.')
    }
    if (parsed.data.verification === 'CORRECTED' && !parsed.data.reason) {
      throw new ValidationError('A reason is required when correcting a signal.')
    }

    const updated = await prisma.recompeteSignal.update({
      where: { id: signal.id },
      data: {
        verification: parsed.data.verification as RecompeteVerification,
        verifiedByUserId: req.user?.userId ?? null,
        verifiedAt: new Date(),
        ...(parsed.data.verification === 'DISMISSED' ? { dismissedReason: parsed.data.reason } : { correctionReason: parsed.data.reason ?? null }),
        ...(parsed.data.windowStart ? { windowStart: new Date(parsed.data.windowStart) } : {}),
        ...(parsed.data.windowEnd ? { windowEnd: new Date(parsed.data.windowEnd) } : {}),
        // The original machine result is preserved, never overwritten.
        originalWindowStart: signal.originalWindowStart ?? signal.windowStart,
        originalWindowEnd: signal.originalWindowEnd ?? signal.windowEnd,
        originalConfidence: signal.originalConfidence ?? signal.confidence,
      },
    })
    await audit(req, consultingFirmId, 'UPDATE', 'RecompeteSignal', signal.id, `Re-compete ${parsed.data.verification}: ${parsed.data.reason ?? ''}`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.1D — Pre-solicitation notices
// -------------------------------------------------------------

router.get('/notices', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const kinds = typeof req.query.kinds === 'string' && req.query.kinds
      ? req.query.kinds.split(',').map((k) => k.trim()).filter((k) => (PRESOLICITATION_KINDS as readonly string[]).includes(k))
      : [...PRESOLICITATION_KINDS]

    const notices = await prisma.opportunity.findMany({
      where: {
        consultingFirmId,
        isDemo: false,
        presolicitationKind: { in: kinds },
        ...(req.query.showExpired === 'true' ? {} : { responseDeadline: { gte: new Date() } }),
      },
      select: {
        id: true, title: true, agency: true, noticeType: true, presolicitationKind: true,
        responseDeadline: true, postedDate: true, sourceUrl: true, source: true,
        sourceLastSeenAt: true, sourceUpdatedAt: true, dataQuality: true, naicsCode: true, setAsideType: true,
        match: { select: { overallScore: true, eligibility: true, eligibilityReason: true, hasSufficientData: true } },
        _count: { select: { amendments: true } },
        bidPursuits: { select: { ownerUserId: true }, take: 1, orderBy: { updatedAt: 'desc' } },
      },
      orderBy: { responseDeadline: 'asc' },
      take: Math.min(Number(req.query.limit ?? 100) || 100, 300),
    })

    res.json({
      success: true,
      data: notices.map((n) => {
        const classification = classifyNotice(n.noticeType, n.title)
        return {
          ...n,
          ownerUserId: n.bidPursuits[0]?.ownerUserId ?? null,
          amendmentCount: n._count.amendments,
          classification: {
            kind: n.presolicitationKind ?? classification.kind,
            label: classification.label,
            basis: classification.basis,
            // Carefully worded: opportunity, never a promise of influence.
            whyEarlyResponseMayMatter: classification.whyEarlyResponseMayMatter,
            priority: classification.suggestedPriority,
          },
        }
      }),
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.1E — Capability library
// -------------------------------------------------------------

const CapabilitySchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(['TECHNICAL', 'DOMAIN', 'CERTIFICATION', 'PERSONNEL', 'GEOGRAPHIC', 'VEHICLE', 'OTHER']).optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  keywords: z.array(z.string().trim().max(80)).max(60).optional(),
  naicsCodes: z.array(z.string().trim().regex(/^\d{2,6}$/)).max(60).optional(),
  pscCodes: z.array(z.string().trim().max(10)).max(60).optional(),
  geographies: z.array(z.string().trim().max(80)).max(60).optional(),
  contractVehicles: z.array(z.string().trim().max(80)).max(40).optional(),
  capacityNote: z.string().trim().max(1000).nullable().optional(),
  concurrentCapacity: z.number().int().min(0).max(1000).nullable().optional(),
  evidenceNote: z.string().trim().max(2000).nullable().optional(),
})

router.get('/capabilities', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const items = await prisma.firmCapability.findMany({
      where: { consultingFirmId, ...(req.query.includeArchived === 'true' ? {} : { isArchived: false }) },
      orderBy: [{ verification: 'asc' }, { name: 'asc' }],
    })
    res.json({ success: true, data: items })
  } catch (err) { next(err) }
})

router.post('/capabilities', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = CapabilitySchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid capability payload')
    // §7.2 — the capability write and its FIRM_CAPABILITY_CHANGED event share
    // one transaction, so a rolled-back create emits zero events.
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.firmCapability.create({
        data: { consultingFirmId, ...parsed.data, keywords: parsed.data.keywords ?? [], naicsCodes: parsed.data.naicsCodes ?? [], pscCodes: parsed.data.pscCodes ?? [], geographies: parsed.data.geographies ?? [], contractVehicles: parsed.data.contractVehicles ?? [] },
      })
      await emitFirmCapabilityChanged(tx, { consultingFirmId, capabilityId: row.id, changeType: 'CREATED', material: capabilityMaterial(row) })
      return row
    })
    await audit(req, consultingFirmId, 'CREATE', 'FirmCapability', created.id, `Capability added: ${created.name}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.put('/capabilities/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = CapabilitySchema.partial().safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid capability payload')
    const existing = await prisma.firmCapability.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!existing) throw new NotFoundError('Capability not found')
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.firmCapability.update({ where: { id: existing.id }, data: parsed.data })
      // The dedupe key fingerprints the matching-relevant fields, so a no-op
      // save collapses onto the existing event rather than re-triggering a run.
      await emitFirmCapabilityChanged(tx, { consultingFirmId, capabilityId: row.id, changeType: 'UPDATED', material: capabilityMaterial(row) })
      return row
    })
    await audit(req, consultingFirmId, 'UPDATE', 'FirmCapability', existing.id, 'Capability updated')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/** POST /capabilities/:id/verify — only a human sets the verified flag. */
router.post('/capabilities/:id/verify', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const verification = req.body?.verification
    if (!['VERIFIED', 'REJECTED', 'UNVERIFIED'].includes(verification)) {
      throw new ValidationError('verification must be VERIFIED, REJECTED or UNVERIFIED')
    }
    const existing = await prisma.firmCapability.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!existing) throw new NotFoundError('Capability not found')
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.firmCapability.update({
        where: { id: existing.id },
        data: {
          verification,
          verifiedByUserId: req.user?.userId ?? null,
          verifiedAt: verification === 'UNVERIFIED' ? null : new Date(),
          evidenceNote: typeof req.body?.evidenceNote === 'string' ? req.body.evidenceNote : undefined,
        },
      })
      // Verification is a HUMAN act. The event records that it changed; it never
      // makes a capability verified.
      await emitFirmCapabilityChanged(tx, { consultingFirmId, capabilityId: row.id, changeType: 'VERIFICATION_CHANGED', material: capabilityMaterial(row) })
      return row
    })
    await audit(req, consultingFirmId, 'UPDATE', 'FirmCapability', existing.id, `Capability ${verification}`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.post('/capabilities/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.firmCapability.findFirst({ where: { id: req.params.id, consultingFirmId }, select: { id: true } })
    if (!existing) throw new NotFoundError('Capability not found')
    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.firmCapability.update({ where: { id: existing.id }, data: { isArchived: true } })
      await emitFirmCapabilityChanged(tx, { consultingFirmId, capabilityId: row.id, changeType: 'ARCHIVED', material: capabilityMaterial(row) })
      return row
    })
    await audit(req, consultingFirmId, 'UPDATE', 'FirmCapability', existing.id, 'Capability archived')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.1E / §6.1F — Match + eligibility
// -------------------------------------------------------------

router.get('/match/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const match = await prisma.opportunityMatch.findFirst({
      where: { opportunityId: req.params.opportunityId, consultingFirmId },
    })
    if (!match) {
      // Compute on first read rather than showing an empty panel.
      const computed = await refreshOpportunityMatch(consultingFirmId, req.params.opportunityId)
      if (!computed) throw new NotFoundError('Opportunity not found')
      const created = await prisma.opportunityMatch.findUnique({ where: { opportunityId: req.params.opportunityId } })
      return res.json({ success: true, data: created })
    }
    res.json({ success: true, data: match })
  } catch (err) { next(err) }
})

router.post('/match/:opportunityId/refresh', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const computed = await refreshOpportunityMatch(consultingFirmId, req.params.opportunityId)
    if (!computed) throw new NotFoundError('Opportunity not found')
    const match = await prisma.opportunityMatch.findUnique({ where: { opportunityId: req.params.opportunityId } })
    res.json({ success: true, data: match })
  } catch (err) { next(err) }
})

router.post('/match/refresh-all', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const limit = Math.min(Number(req.body?.limit ?? 200) || 200, 500)
    const result = await refreshFirmMatches(consultingFirmId, { limit })
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

export default router
export { SourceCategory }
