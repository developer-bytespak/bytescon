// =============================================================
// Firm Routes
// Multi-tenant protected endpoints
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import axios from 'axios'
import rateLimit from 'express-rate-limit'
import { encryptSecret } from '../utils/fieldCrypto'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { NotFoundError } from '../utils/errors'
import { assertSafeLlmBaseUrl } from '../utils/ssrfGuard'
import { requirePlatformAdmin } from '../middleware/platformAdmin'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)

const UpdatePenaltySchema = z.object({
  flatLateFee: z.union([z.coerce.number().min(0), z.null()]).optional(),
  penaltyPercent: z.union([z.coerce.number().min(0).max(1), z.null()]).optional(),
})

// -------------------------------------------------------------
// GET /api/firm
// -------------------------------------------------------------
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const [firm, activeClientCount] = await Promise.all([
      prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        include: {
          _count: {
            select: {
              users: true,
              clientCompanies: true,
              opportunities: true,
              bidDecisions: true,
              documentTemplates: true,
            },
          },
        },
      }),
      prisma.clientCompany.count({
        where: { consultingFirmId, isActive: true },
      }),
    ])

    if (!firm || !firm.isActive) throw new NotFoundError('Consulting firm')

    res.json({
      success: true,
      data: {
        id: firm.id,
        name: firm.name,
        contactEmail: firm.contactEmail,
        flatLateFee: firm.flatLateFee != null ? Number(firm.flatLateFee) : null,
        penaltyPercent: firm.penaltyPercent != null ? Number(firm.penaltyPercent) : null,
        lastIngestedAt: firm.lastIngestedAt,
        isActive: firm.isActive,
        createdAt: firm.createdAt,
        updatedAt: firm.updatedAt,
        activeClientCount,
        _count: firm._count,
        samApiKeyConfigured: !!firm.samApiKey,
        anthropicApiKeyConfigured: !!firm.anthropicApiKey,
        llmProvider: firm.llmProvider ?? 'claude',
        openaiApiKeyConfigured: !!firm.openaiApiKey,
        insightEngineApiKeyConfigured: !!firm.insightEngineApiKey,
        localaiBaseUrl: firm.localaiBaseUrl ?? null,
        localaiModel: firm.localaiModel ?? null,
        proposalTokens: firm.proposalTokens ?? 0,
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/firm/metrics
// -------------------------------------------------------------
router.get('/metrics', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const [activeClients, activeOpportunities, openRequirements, totalPenalties, pipeline, perf] = await Promise.all([
      prisma.clientCompany.count({
        where: { consultingFirmId, isActive: true },
      }),
      prisma.opportunity.count({
        where: { consultingFirmId, status: 'ACTIVE' },
      }),
      prisma.documentRequirement.count({
        where: { consultingFirmId, status: 'PENDING' },
      }),
      prisma.financialPenalty.aggregate({
        where: { consultingFirmId },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.opportunity.aggregate({
        where: { consultingFirmId, status: 'ACTIVE' },
        _sum: { expectedValue: true, estimatedValue: true },
      }),
      prisma.performanceStats.aggregate({
        where: { clientCompany: { consultingFirmId } },
        _avg: { completionRate: true },
        _sum: { totalSubmitted: true, totalWon: true, totalLost: true, totalPenalties: true },
      }),
    ])

    res.json({
      success: true,
      data: {
        activeClients,
        activeOpportunities,
        openRequirements,
        totalPenalties: Number(totalPenalties._sum.amount || 0),
        totalPenaltyEvents: totalPenalties._count,
        pipelineExpectedValue: Number(pipeline._sum.expectedValue || 0),
        pipelineEstimatedValue: Number(pipeline._sum.estimatedValue || 0),
        aggregateCompletionRate: perf._avg.completionRate || 0,
        totalSubmitted: perf._sum.totalSubmitted || 0,
        totalWon: perf._sum.totalWon || 0,
        totalLost: perf._sum.totalLost || 0,
        totalPenaltyAppliedToClients: Number(perf._sum.totalPenalties || 0),
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/firm/users
// -------------------------------------------------------------
router.get('/users', requireRole('ADMIN', 'CONSULTANT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const users = await prisma.user.findMany({
      where: { consultingFirmId, isActive: true },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        lastLoginAt: true,
        createdAt: true,
      },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    })
    res.json({ success: true, data: users })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PUT /api/firm/penalty-config
// -------------------------------------------------------------
router.put('/penalty-config', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const body = UpdatePenaltySchema.parse(req.body)

    const updated = await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: {
        flatLateFee: body.flatLateFee,
        penaltyPercent: body.penaltyPercent,
      },
      select: {
        id: true,
        flatLateFee: true,
        penaltyPercent: true,
        updatedAt: true,
      },
    })

    res.json({
      success: true,
      data: {
        ...updated,
        flatLateFee: updated.flatLateFee != null ? Number(updated.flatLateFee) : null,
        penaltyPercent: updated.penaltyPercent != null ? Number(updated.penaltyPercent) : null,
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PUT /api/firm/sam-api-key  (ADMIN only — store/update SAM.gov API key)
// -------------------------------------------------------------
router.put('/sam-api-key', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { samApiKey } = req.body
    if (typeof samApiKey !== 'string') {
      return res.status(400).json({ success: false, error: 'samApiKey must be a string' })
    }
    await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: { samApiKey: encryptSecret(samApiKey.trim() || null) },
    })
    res.json({ success: true, message: 'SAM API key saved' })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/firm/test-sam-key  (ADMIN only — validate a SAM.gov key without
// saving it). Does one tiny live search so the user gets immediate feedback
// instead of discovering a bad/expired key during an ingest.
// Rate-limited so the endpoint can't be used as a fast SAM.gov key-probing
// oracle laundered through the platform's IP.
// -------------------------------------------------------------
const samTestRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many SAM key tests. Please wait a minute and try again.' },
})

router.post('/test-sam-key', samTestRateLimit, requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { samApiKey } = req.body
    const key = typeof samApiKey === 'string' ? samApiKey.trim() : ''
    if (!key) {
      return res.status(400).json({ success: false, error: 'samApiKey must be a non-empty string' })
    }

    const fmt = (d: Date) =>
      `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
    const now = new Date()
    const postedFrom = fmt(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000))
    const postedTo = fmt(now)

    try {
      const response = await axios.get('https://api.sam.gov/opportunities/v2/search', {
        params: { api_key: key, postedFrom, postedTo, limit: 1, offset: 0 },
        timeout: 10000,
      })
      const total = response.data?.totalRecords ?? response.data?.opportunitiesData?.length ?? 0
      return res.json({
        success: true,
        ok: true,
        message: `Key is valid — SAM.gov responded successfully (${total} recent records visible).`,
      })
    } catch (err: any) {
      const status = err.response?.status
      // A 429 means the key authenticated (otherwise SAM returns 401/403) but
      // hit its daily quota — the key itself is fine.
      if (status === 429) {
        return res.json({
          success: true,
          ok: true,
          message: 'Key is valid (currently rate-limited by SAM.gov — the daily quota resets automatically).',
        })
      }
      let message = 'Could not reach SAM.gov. Check your connection and try again.'
      if (status === 401 || status === 403) {
        message = 'SAM.gov rejected this key (401/403). It may be invalid or expired — keys expire every 90 days.'
      } else if (status) {
        message = `SAM.gov returned HTTP ${status}. Please try again.`
      }
      return res.json({ success: true, ok: false, message })
    }
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PUT /api/firm/anthropic-api-key  (ADMIN only — store/update Anthropic API key)
// -------------------------------------------------------------
router.put('/anthropic-api-key', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { anthropicApiKey } = req.body
    if (typeof anthropicApiKey !== 'string') {
      return res.status(400).json({ success: false, error: 'anthropicApiKey must be a string' })
    }
    await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: { anthropicApiKey: encryptSecret(anthropicApiKey.trim() || null) },
    })
    res.json({ success: true, message: 'Anthropic API key saved' })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PUT /api/firm/llm-provider  (ADMIN only)
// -------------------------------------------------------------
router.put('/llm-provider', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { llmProvider } = req.body
    const VALID = ['claude', 'openai', 'deepseek', 'insight_engine', 'localai']
    if (!VALID.includes(llmProvider)) {
      return res.status(400).json({ success: false, error: `llmProvider must be one of: ${VALID.join(', ')}` })
    }
    await prisma.consultingFirm.update({ where: { id: consultingFirmId }, data: { llmProvider } })
    res.json({ success: true, message: 'AI provider updated' })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PUT /api/firm/openai-api-key  (ADMIN only)
// -------------------------------------------------------------
router.put('/openai-api-key', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { openaiApiKey } = req.body
    if (typeof openaiApiKey !== 'string') {
      return res.status(400).json({ success: false, error: 'openaiApiKey must be a string' })
    }
    await prisma.consultingFirm.update({ where: { id: consultingFirmId }, data: { openaiApiKey: encryptSecret(openaiApiKey.trim() || null) } })
    res.json({ success: true, message: 'OpenAI API key saved' })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PUT /api/firm/insight-engine-api-key  (ADMIN only)
// -------------------------------------------------------------
router.put('/insight-engine-api-key', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { insightEngineApiKey } = req.body
    if (typeof insightEngineApiKey !== 'string') {
      return res.status(400).json({ success: false, error: 'insightEngineApiKey must be a string' })
    }
    await prisma.consultingFirm.update({ where: { id: consultingFirmId }, data: { insightEngineApiKey: encryptSecret(insightEngineApiKey.trim() || null) } })
    res.json({ success: true, message: 'Insight Engine API key saved' })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PUT /api/firm/localai-config  (ADMIN only)
// -------------------------------------------------------------
router.put('/localai-config', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { localaiBaseUrl, localaiModel } = req.body

    // SSRF guard: a base URL set here becomes an outbound target for the
    // server. Reject anything pointing at private/loopback/link-local hosts
    // (e.g. cloud metadata) before persisting. Empty string clears it.
    let baseUrlValue: string | null | undefined = undefined
    if (typeof localaiBaseUrl === 'string') {
      const trimmed = localaiBaseUrl.trim()
      baseUrlValue = trimmed ? await assertSafeLlmBaseUrl(trimmed) : null
    }

    await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: {
        localaiBaseUrl: baseUrlValue,
        localaiModel: typeof localaiModel === 'string' ? localaiModel.trim() || null : undefined,
      },
    })
    res.json({ success: true, message: 'LocalAI configuration saved' })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// PUT /api/firm/veteran-status  (ADMIN)
// -------------------------------------------------------------
router.put('/veteran-status', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { isVeteranOwned } = req.body
    if (typeof isVeteranOwned !== 'boolean') {
      return res.status(400).json({ error: 'isVeteranOwned must be a boolean' })
    }
    const firm = await prisma.consultingFirm.update({
      where: { id: consultingFirmId },
      data: { isVeteranOwned },
    })
    res.json({ success: true, isVeteranOwned: firm.isVeteranOwned })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/firm/ai-usage  (ADMIN + CONSULTANT)
// -------------------------------------------------------------
router.get('/ai-usage', requireRole('ADMIN', 'CONSULTANT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const days = Math.min(90, Math.max(1, parseInt(req.query.days as string) || 30))
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const [totals, byProvider, byTask, recentLogs] = await Promise.all([
      prisma.apiUsageLog.aggregate({
        where: { consultingFirmId, createdAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true, estimatedCostUsd: true },
        _count: true,
      }),
      prisma.apiUsageLog.groupBy({
        by: ['provider'],
        where: { consultingFirmId, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { estimatedCostUsd: true },
      }),
      prisma.apiUsageLog.groupBy({
        by: ['task'],
        where: { consultingFirmId, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { estimatedCostUsd: true },
      }),
      prisma.apiUsageLog.findMany({
        where: { consultingFirmId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { provider: true, model: true, task: true, inputTokens: true, outputTokens: true, estimatedCostUsd: true, cacheHit: true, durationMs: true, createdAt: true },
      }),
    ])

    res.json({
      success: true,
      data: {
        days,
        totalCalls: totals._count,
        totalInputTokens: totals._sum.inputTokens ?? 0,
        totalOutputTokens: totals._sum.outputTokens ?? 0,
        totalCostUsd: Number(totals._sum.estimatedCostUsd ?? 0),
        byProvider: byProvider.map((r) => ({ provider: r.provider, calls: r._count._all, costUsd: Number(r._sum.estimatedCostUsd ?? 0) })),
        byTask: byTask.map((r) => ({ task: r.task, calls: r._count._all, costUsd: Number(r._sum.estimatedCostUsd ?? 0) })),
        recentLogs: recentLogs.map((l) => ({ ...l, estimatedCostUsd: Number(l.estimatedCostUsd) })),
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/firm/platform/cogs-margin  (PLATFORM ADMIN)
// Fleet-wide gross margin per tenant: subscription revenue vs. LLM COGS
// (from api_usage_logs), normalized to a monthly figure. The diligence number
// (FIXES.md FIX-6). NOTE: LLM COGS only — BigQuery + infrastructure are external
// billing and are NOT captured here.
// -------------------------------------------------------------
router.get('/platform/cogs-margin', requirePlatformAdmin, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days as string) || 30))
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    const monthlyFactor = 30 / days

    const [firms, costByFirm, subs] = await Promise.all([
      prisma.consultingFirm.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
      prisma.apiUsageLog.groupBy({
        by: ['consultingFirmId'],
        where: { createdAt: { gte: since } },
        _sum: { estimatedCostUsd: true },
        _count: { _all: true },
      }),
      prisma.subscription.findMany({
        where: { status: { in: ['ACTIVE', 'TRIALING'] } },
        select: {
          consultingFirmId: true,
          status: true,
          billingCycle: true,
          plan: { select: { slug: true, monthlyPriceUsd: true, annualPriceUsd: true } },
        },
      }),
    ])

    const costMap = new Map(costByFirm.map((r) => [r.consultingFirmId, { cost: Number(r._sum.estimatedCostUsd ?? 0), calls: r._count._all }]))
    const subMap = new Map(subs.map((s) => [s.consultingFirmId, s]))
    const round2 = (n: number) => Math.round(n * 100) / 100

    const rows = firms.map((f) => {
      const c = costMap.get(f.id) ?? { cost: 0, calls: 0 }
      const llmCostMonthly = c.cost * monthlyFactor
      const sub = subMap.get(f.id)
      const monthlyRevenue = sub?.plan
        ? (sub.billingCycle === 'ANNUAL' ? Number(sub.plan.annualPriceUsd) / 12 : Number(sub.plan.monthlyPriceUsd))
        : 0
      const grossMarginUsd = round2(monthlyRevenue - llmCostMonthly)
      const grossMarginPct = monthlyRevenue > 0 ? Math.round((grossMarginUsd / monthlyRevenue) * 100) : null
      return {
        firmId: f.id,
        name: f.name,
        plan: sub?.plan?.slug ?? 'none',
        status: sub?.status ?? 'NONE',
        monthlyRevenueUsd: round2(monthlyRevenue),
        llmCostUsd: round2(llmCostMonthly),
        llmCalls: c.calls,
        grossMarginUsd,
        grossMarginPct,
      }
    })

    // Worst margin first — the money-losers the owner most needs to see.
    rows.sort((a, b) => (a.grossMarginPct ?? 9999) - (b.grossMarginPct ?? 9999))

    const totalRevenue = round2(rows.reduce((s, r) => s + r.monthlyRevenueUsd, 0))
    const totalCost = round2(rows.reduce((s, r) => s + r.llmCostUsd, 0))
    const fleet = {
      firms: rows.length,
      monthlyRevenueUsd: totalRevenue,
      llmCostUsd: totalCost,
      grossMarginUsd: round2(totalRevenue - totalCost),
      grossMarginPct: totalRevenue > 0 ? Math.round(((totalRevenue - totalCost) / totalRevenue) * 100) : null,
    }

    res.json({
      success: true,
      data: {
        days,
        note: 'LLM COGS only (from api_usage_logs) normalized to a monthly figure; BigQuery + infrastructure are external billing and NOT included.',
        fleet,
        firms: rows,
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/firm/audit-log/export  (ADMIN) — CSV of this firm's audit trail
// (FIXES.md FIX-3 quick win — a standard security-questionnaire artifact).
// Tenant-scoped; capped; the export itself is recorded as an EXPORT audit event
// by the audit middleware.
// -------------------------------------------------------------
router.get('/audit-log/export', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const days = Math.min(365, Math.max(1, parseInt(req.query.days as string) || 90))
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const events = await prisma.auditEvent.findMany({
      where: { consultingFirmId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 50000,
      select: {
        createdAt: true, action: true, entityType: true, entityId: true,
        actorRole: true, actorUserId: true, rationale: true, sourceIp: true,
      },
    })

    const esc = (v: unknown): string => {
      const s = v == null ? '' : String(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const header = ['timestamp', 'action', 'entityType', 'entityId', 'actorRole', 'actorUserId', 'rationale', 'sourceIp']
    const lines = events.map((e) =>
      [e.createdAt.toISOString(), e.action, e.entityType, e.entityId, e.actorRole, e.actorUserId, e.rationale, e.sourceIp]
        .map(esc)
        .join(','),
    )
    const csv = [header.join(','), ...lines].join('\r\n')

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`)
    res.send(csv)
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/firm/platform/metrics  (PLATFORM ADMIN)
// The operator "prove-it" dashboard: win-rate, outcome-capture rate (the
// calibration flywheel fuel gauge), MRR, and 30-day activity across the fleet.
// -------------------------------------------------------------
router.get('/platform/metrics', requirePlatformAdmin, async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const now = new Date()
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const deadlinePassed = { opportunity: { responseDeadline: { lt: now } } }

    const [activeFirms, subs, outcomeGroups, dpTotal, dpWithOutcome, opps30, subm30, ai30] = await Promise.all([
      prisma.consultingFirm.count({ where: { isActive: true } }),
      prisma.subscription.findMany({
        where: { status: { in: ['ACTIVE', 'TRIALING'] } },
        select: { billingCycle: true, plan: { select: { slug: true, monthlyPriceUsd: true, annualPriceUsd: true } } },
      }),
      prisma.submissionRecord.groupBy({ by: ['outcome'], _count: { _all: true } }),
      prisma.submissionRecord.count({ where: { ...deadlinePassed } }),
      prisma.submissionRecord.count({ where: { outcome: { not: null }, ...deadlinePassed } }),
      prisma.opportunity.count({ where: { createdAt: { gte: since30 } } }),
      prisma.submissionRecord.count({ where: { createdAt: { gte: since30 } } }),
      prisma.apiUsageLog.count({ where: { createdAt: { gte: since30 } } }),
    ])

    const mrrUsd =
      Math.round(
        subs.reduce(
          (s, x) => s + (x.plan ? (x.billingCycle === 'ANNUAL' ? Number(x.plan.annualPriceUsd) / 12 : Number(x.plan.monthlyPriceUsd)) : 0),
          0,
        ) * 100,
      ) / 100
    const byPlan: Record<string, number> = {}
    subs.forEach((x) => { const k = x.plan?.slug ?? 'none'; byPlan[k] = (byPlan[k] ?? 0) + 1 })

    const oc = (name: string) => outcomeGroups.find((g) => g.outcome === name)?._count._all ?? 0
    const won = oc('WON')
    const lost = oc('LOST')
    const decided = won + lost
    const winRatePct = decided > 0 ? Math.round((won / decided) * 100) : null
    const captureRatePct = dpTotal > 0 ? Math.round((dpWithOutcome / dpTotal) * 100) : null

    res.json({
      success: true,
      data: {
        activeFirms,
        subscriptions: { paying: subs.length, mrrUsd, byPlan },
        outcomes: {
          won,
          lost,
          noAward: oc('NO_AWARD'),
          withdrawn: oc('WITHDRAWN'),
          winRatePct,
          captureRatePct,
          note: 'Win-rate = WON / (WON + LOST). Capture-rate = deadline-passed bids with a recorded outcome — the fuel gauge for the calibration flywheel.',
        },
        activity30d: { opportunities: opps30, submissions: subm30, aiCalls: ai30 },
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// GET /api/firm/platform/funnel  (PLATFORM ADMIN)
// FIX-5 funnel instrumentation: the activation funnel (signed up →
// first opportunity scored → first bid decision → first proposal draft →
// first outcome logged), signup-month retention cohorts, and the
// north-star metric (outcomes logged — the flywheel's fuel). Derived
// entirely from existing per-firm timestamps; no event table needed.
// Test firms (isTest) are excluded so demos don't inflate activation.
// -------------------------------------------------------------
router.get('/platform/funnel', requirePlatformAdmin, async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const now = Date.now()
    const since30 = new Date(now - 30 * 24 * 60 * 60 * 1000)
    const since8w = new Date(now - 8 * 7 * 24 * 60 * 60 * 1000)

    const firms = await prisma.consultingFirm.findMany({
      where: { isActive: true, isTest: false },
      select: { id: true, createdAt: true },
    })
    const firmIds = firms.map((f) => f.id)
    const signupById = new Map(firms.map((f) => [f.id, f.createdAt.getTime()]))

    const [scored, decisions, proposals, outcomes, activeUserFirms, outcomes30, recentOutcomes] = await Promise.all([
      // "First scored" uses the earliest createdAt of a scored opportunity —
      // scoring happens minutes after ingest, so this is a close proxy (we
      // don't persist a scoredAt timestamp).
      prisma.opportunity.groupBy({
        by: ['consultingFirmId'],
        where: { consultingFirmId: { in: firmIds }, isScored: true },
        _min: { createdAt: true },
      }),
      prisma.bidDecision.groupBy({
        by: ['consultingFirmId'],
        where: { consultingFirmId: { in: firmIds } },
        _min: { createdAt: true },
      }),
      prisma.opportunity.groupBy({
        by: ['consultingFirmId'],
        where: { consultingFirmId: { in: firmIds }, savedProposalDraftAt: { not: null } },
        _min: { savedProposalDraftAt: true },
      }),
      prisma.submissionRecord.groupBy({
        by: ['consultingFirmId'],
        where: { consultingFirmId: { in: firmIds }, outcomeRecordedAt: { not: null } },
        _min: { outcomeRecordedAt: true },
      }),
      prisma.user.groupBy({
        by: ['consultingFirmId'],
        where: { consultingFirmId: { in: firmIds }, lastLoginAt: { gte: since30 } },
        _count: { _all: true },
      }),
      prisma.submissionRecord.count({
        where: { consultingFirmId: { in: firmIds }, outcomeRecordedAt: { gte: since30 } },
      }),
      prisma.submissionRecord.findMany({
        where: { consultingFirmId: { in: firmIds }, outcomeRecordedAt: { gte: since8w } },
        select: { outcomeRecordedAt: true },
      }),
    ])

    const median = (xs: number[]): number | null => {
      if (!xs.length) return null
      const s = [...xs].sort((a, b) => a - b)
      const mid = Math.floor(s.length / 2)
      const m = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
      return Math.round(m * 10) / 10
    }
    const DAY = 24 * 60 * 60 * 1000
    const stage = <T extends { consultingFirmId: string }>(
      key: string,
      label: string,
      rows: T[],
      firstAt: (r: T) => Date | null,
    ) => {
      const days: number[] = []
      for (const r of rows) {
        const signup = signupById.get(r.consultingFirmId)
        const at = firstAt(r)?.getTime()
        // Clamp at 0 — backfilled/demo data can predate the signup row.
        if (signup !== undefined && at !== undefined) days.push(Math.max(0, (at - signup) / DAY))
      }
      return { key, label, firms: rows.length, medianDaysFromSignup: median(days) }
    }

    const stages = [
      { key: 'signedUp', label: 'Signed up', firms: firms.length, medianDaysFromSignup: 0 },
      stage('firstOpportunityScored', 'First opportunity scored', scored, (r) => r._min.createdAt),
      stage('firstBidDecision', 'First bid decision', decisions, (r) => r._min.createdAt),
      stage('firstProposalDraft', 'First proposal drafted', proposals, (r) => r._min.savedProposalDraftAt),
      stage('firstOutcomeLogged', 'First outcome logged', outcomes, (r) => r._min.outcomeRecordedAt),
    ]

    // Retention cohorts by signup month (last 6 incl. current): a firm counts
    // as retained if any of its users logged in within the last 30 days.
    const activeFirmIds = new Set(activeUserFirms.map((g) => g.consultingFirmId))
    const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const cohortMonths: string[] = []
    for (let i = 5; i >= 0; i--) {
      const d = new Date()
      d.setUTCDate(1)
      d.setUTCMonth(d.getUTCMonth() - i)
      cohortMonths.push(monthKey(d))
    }
    const cohorts = cohortMonths.map((month) => {
      const inCohort = firms.filter((f) => monthKey(f.createdAt) === month)
      const retained = inCohort.filter((f) => activeFirmIds.has(f.id)).length
      return {
        month,
        firms: inCohort.length,
        activeLast30d: retained,
        retainedPct: inCohort.length > 0 ? Math.round((retained / inCohort.length) * 100) : null,
      }
    })

    // North star: outcomes logged. Proprietary WON/LOST labels are the moat
    // (FIX-1/FIX-2) — every other number improves when this one does.
    const weekStarts: string[] = []
    const weekCounts = new Map<string, number>()
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now - i * 7 * DAY)
      // Normalize to the Monday of that week (UTC).
      const day = d.getUTCDay()
      d.setUTCDate(d.getUTCDate() - ((day + 6) % 7))
      const k = d.toISOString().slice(0, 10)
      if (!weekCounts.has(k)) { weekCounts.set(k, 0); weekStarts.push(k) }
    }
    for (const r of recentOutcomes) {
      if (!r.outcomeRecordedAt) continue
      const d = new Date(r.outcomeRecordedAt)
      const day = d.getUTCDay()
      d.setUTCDate(d.getUTCDate() - ((day + 6) % 7))
      const k = d.toISOString().slice(0, 10)
      if (weekCounts.has(k)) weekCounts.set(k, (weekCounts.get(k) ?? 0) + 1)
    }

    res.json({
      success: true,
      data: {
        activation: {
          totalFirms: firms.length,
          stages,
          note: '"First scored" uses the earliest scored opportunity\'s createdAt as a close proxy (scoring runs minutes after ingest). Test firms excluded.',
        },
        cohorts,
        northStar: {
          label: 'Outcomes logged (30d)',
          outcomesLogged30d: outcomes30,
          weeklyTrend: weekStarts.map((weekStart) => ({ weekStart, outcomes: weekCounts.get(weekStart) ?? 0 })),
          note: 'Real WON/LOST labels are the calibration flywheel\'s fuel and the per-customer data moat — the single number every other metric depends on.',
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

// -------------------------------------------------------------
// POST /api/firm/seed-demo
// Adds realistic opportunities for demos/training.
// -------------------------------------------------------------
router.post('/seed-demo', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const now = new Date()
    const day = 24 * 60 * 60 * 1000

    const seedRows = [
      {
        samNoticeId: 'DEMO-SAM-001',
        title: 'Regional Medical Supply Chain Logistics Support',
        agency: 'Department of Veterans Affairs',
        naicsCode: '493110',
        setAsideType: 'SDVOSB',
        marketCategory: 'LOGISTICS',
        estimatedValue: 1450000,
        postedDate: new Date(now.getTime() - 3 * day),
        responseDeadline: new Date(now.getTime() + 11 * day),
        description: 'End-to-end warehousing, distribution, and last-mile logistics support for medical supplies.',
      },
      {
        samNoticeId: 'DEMO-SAM-002',
        title: 'DOT Fleet Maintenance and Dispatch Services',
        agency: 'Department of Transportation',
        naicsCode: '488510',
        setAsideType: 'SMALL_BUSINESS',
        marketCategory: 'TRANSPORTATION',
        estimatedValue: 890000,
        postedDate: new Date(now.getTime() - 2 * day),
        responseDeadline: new Date(now.getTime() + 17 * day),
        description: 'Fleet upkeep, dispatch operations, and route optimization services.',
      },
      {
        samNoticeId: 'DEMO-SAM-003',
        title: 'Federal Warehouse Inventory Management Platform',
        agency: 'General Services Administration',
        naicsCode: '541512',
        setAsideType: 'NONE',
        marketCategory: 'IT',
        estimatedValue: 3200000,
        postedDate: new Date(now.getTime() - 1 * day),
        responseDeadline: new Date(now.getTime() + 26 * day),
        description: 'SaaS-enabled inventory visibility and compliance reporting across federal sites.',
      },
      {
        samNoticeId: 'DEMO-SAM-004',
        title: 'DoD Ground Transportation Support',
        agency: 'Department of Defense',
        naicsCode: '484110',
        setAsideType: 'HUBZONE',
        marketCategory: 'TRANSPORTATION',
        estimatedValue: 2100000,
        postedDate: new Date(now.getTime() - 4 * day),
        responseDeadline: new Date(now.getTime() + 7 * day),
        description: 'Regional over-the-road cargo and mission-essential transportation support.',
      },
      {
        samNoticeId: 'DEMO-SAM-005',
        title: 'USDA Cold-Chain Distribution Contract',
        agency: 'Department of Agriculture',
        naicsCode: '484220',
        setAsideType: 'WOSB',
        marketCategory: 'LOGISTICS',
        estimatedValue: 760000,
        postedDate: new Date(now.getTime() - 6 * day),
        responseDeadline: new Date(now.getTime() + 14 * day),
        description: 'Temperature-controlled transport and chain-of-custody tracking for food programs.',
      },
      {
        samNoticeId: 'DEMO-SAM-006',
        title: 'FEMA Emergency Response Staging and Distribution',
        agency: 'Department of Homeland Security',
        naicsCode: '493190',
        setAsideType: 'SMALL_BUSINESS',
        marketCategory: 'LOGISTICS',
        estimatedValue: 5000000,
        postedDate: new Date(now.getTime() - 5 * day),
        responseDeadline: new Date(now.getTime() + 21 * day),
        description: 'Rapid staging, storage, and movement of emergency response supplies.',
      },
      {
        samNoticeId: 'DEMO-SAM-007',
        title: 'FAA Parts Procurement and Supplier Management',
        agency: 'Federal Aviation Administration',
        naicsCode: '423860',
        setAsideType: 'SDVOSB',
        marketCategory: 'SUPPLY_CHAIN',
        estimatedValue: 1100000,
        postedDate: new Date(now.getTime() - 7 * day),
        responseDeadline: new Date(now.getTime() + 9 * day),
        description: 'Strategic sourcing and replenishment of aviation-critical components.',
      },
      {
        samNoticeId: 'DEMO-SAM-008',
        title: 'Navy Base Contract Packaging and Kitting Services',
        agency: 'Department of the Navy',
        naicsCode: '561910',
        setAsideType: '8A',
        marketCategory: 'SERVICES',
        estimatedValue: 640000,
        postedDate: new Date(now.getTime() - 8 * day),
        responseDeadline: new Date(now.getTime() + 30 * day),
        description: 'Packaging, labeling, and kitting support for distributed military supply operations.',
      },
    ]

    const result = await prisma.opportunity.createMany({
      data: seedRows.map((row) => ({
        consultingFirmId,
        samNoticeId: row.samNoticeId,
        title: row.title,
        agency: row.agency,
        naicsCode: row.naicsCode,
        setAsideType: row.setAsideType,
        marketCategory: row.marketCategory,
        estimatedValue: row.estimatedValue,
        postedDate: row.postedDate,
        responseDeadline: row.responseDeadline,
        description: row.description,
        status: 'ACTIVE',
        isScored: false,
      })),
      skipDuplicates: true,
    })

    res.json({
      success: true,
      data: {
        created: result.count,
        skipped: seedRows.length - result.count,
      },
    })
  } catch (err) {
    next(err)
  }
})

router.get(
  '/dashboard',
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) => {
    try {
      const consultingFirmId = getTenantId(req)

      const now = new Date()
      const sevenDays = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      const twentyDays = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

      const [
        totalOpportunities,
        redOpps,
        yellowOpps,
        recentPenalties,
        topOpps,
        clientMetrics,
        pipelineValue,
        avgWinProb,
        recentDecisions,
        probDistribution,
      ] = await Promise.all([
        prisma.opportunity.count({
          where: { consultingFirmId },
        }),

        prisma.opportunity.count({
          where: {
            consultingFirmId,
            status: 'ACTIVE',
            responseDeadline: { gte: now, lte: sevenDays },
          },
        }),

        prisma.opportunity.count({
          where: {
            consultingFirmId,
            status: 'ACTIVE',
            responseDeadline: { gt: sevenDays, lte: twentyDays },
          },
        }),

        prisma.financialPenalty.aggregate({
          where: {
            consultingFirmId,
            createdAt: { gte: thirtyDaysAgo },
          },
          _sum: { amount: true },
          _count: true,
        }),

        prisma.opportunity.findMany({
          where: {
            consultingFirmId,
            status: 'ACTIVE',
            isScored: true,
            probabilityScore: { gt: 0 },
          },
          orderBy: [{ probabilityScore: 'desc' }, { responseDeadline: 'asc' }],
          take: 6,
          select: {
            id: true,
            title: true,
            agency: true,
            naicsCode: true,
            estimatedValue: true,
            probabilityScore: true,
            expectedValue: true,
            responseDeadline: true,
            setAsideType: true,
            isEnriched: true,
            historicalWinner: true,
            competitionCount: true,
            incumbentProbability: true,
            bidDecisions: {
              select: {
                recommendation: true,
                winProbability: true,
                complianceStatus: true,
                clientCompany: { select: { name: true } },
              },
              take: 3,
            },
          },
        }),

        prisma.clientCompany.findMany({
          where: { consultingFirmId, isActive: true },
          select: {
            id: true,
            name: true,
            performanceStats: {
              select: {
                completionRate: true,
                totalPenalties: true,
                totalWon: true,
                totalLost: true,
                totalSubmitted: true,
              },
            },
          },
        }),

        // Pipeline value: sum expectedValue from active (non-NO_BID) bid decisions
        // This reflects real decision-engine calculations with lifetime value, NPV, etc.
        prisma.bidDecision.aggregate({
          where: {
            consultingFirmId,
            recommendation: { in: ['BID_PRIME', 'BID_SUB'] },
          },
          _sum: { expectedValue: true, netExpectedValue: true },
        }),

        prisma.bidDecision.aggregate({
          where: { consultingFirmId },
          _avg: { winProbability: true },
        }),

        prisma.bidDecision.findMany({
          where: { consultingFirmId },
          orderBy: { updatedAt: 'desc' },
          take: 10,
          select: {
            id: true,
            recommendation: true,
            winProbability: true,
            expectedValue: true,
            complianceStatus: true,
            riskScore: true,
            opportunity: { select: { id: true, title: true, agency: true } },
            clientCompany: { select: { id: true, name: true } },
          },
        }),

        prisma.opportunity.groupBy({
          by: ['probabilityScore'],
          where: {
            consultingFirmId,
            isScored: true,
            probabilityScore: { gt: 0 },
          },
          _count: true,
        }),
      ])

      const clientBreakdown = clientMetrics.map((c) => ({
        id: c.id,
        name: c.name,
        completionRate: c.performanceStats?.completionRate || 0,
        totalPenalties: Number(c.performanceStats?.totalPenalties || 0),
        totalWon: c.performanceStats?.totalWon || 0,
        totalLost: c.performanceStats?.totalLost || 0,
        totalSubmitted: c.performanceStats?.totalSubmitted || 0,
      }))

      const totalClients = clientBreakdown.length
      const aggregateCompletionRate =
        totalClients > 0
          ? clientBreakdown.reduce((sum, c) => sum + c.completionRate, 0) / totalClients
          : 0

      const probBuckets = Array.from({ length: 10 }, (_, i) => ({
        range: `${i * 10}-${(i + 1) * 10}%`,
        count: 0,
      }))
      for (const row of probDistribution) {
        const bucket = Math.min(9, Math.floor(row.probabilityScore * 10))
        probBuckets[bucket].count += row._count
      }

      res.json({
        success: true,
        data: {
          totalOpportunities,

          deadlineAlerts: {
            red: redOpps,
            yellow: yellowOpps,
          },

          recentPenalties: {
            count: recentPenalties._count,
            total: Number(recentPenalties._sum.amount || 0),
          },

          pipelineValue: {
            totalExpected: Number(pipelineValue._sum.expectedValue || 0),
            totalNet: Number(pipelineValue._sum.netExpectedValue || 0),
          },

          avgWinProbability: avgWinProb._avg.winProbability || 0,

          topOpportunities: topOpps.map((o) => ({
            ...o,
            estimatedValue: Number(o.estimatedValue || 0),
            expectedValue: Number(o.expectedValue || 0),
            deadline: o.responseDeadline ? {
              daysUntil: Math.ceil(
                (o.responseDeadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
              ),
            } : null,
          })),

          recentDecisions: recentDecisions.map((d) => ({
            ...d,
            expectedValue: Number(d.expectedValue || 0),
          })),

          firmMetrics: {
            totalClients,
            aggregateCompletionRate,
            clientBreakdown,
          },

          probDistribution: probBuckets,
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

export default router
