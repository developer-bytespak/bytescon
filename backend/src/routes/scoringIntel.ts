// =============================================================
// §6.2 — Win-probability intelligence API.
//
// Score transparency · tenant calibration admin · incumbent retention ·
// competitor mapping · pricing sensitivity · capability gaps · portfolio EV.
//
// Mounted at /api/scoring-intel. Every handler is tenant-scoped; no route can
// reach another firm's evidence, partners, pricing or outcomes.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { CalibrationState, Prisma } from '@prisma/client'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { prisma } from '../config/database'
import { explainOpportunityScore } from '../services/scoring/scoreExplanation'
import {
  fitTenantCalibration,
  rollbackCalibration,
  activateCalibration,
  getActiveTenantCalibration,
  tenantCalibrationEnabled,
  collectOutcomeSamples,
} from '../services/scoring/tenantCalibration'
import { refreshIncumbentRetention, refreshCompetitorStats, BASIS_LABELS } from '../services/scoring/evidenceStats'
import { runPricingSensitivity } from '../services/scoring/pricingSensitivity'
import { assessCapabilityGaps } from '../services/scoring/capabilityGap'
import { computePortfolio } from '../services/scoring/portfolioValue'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const audit = (req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction, entityType: string, id: string, rationale?: string) =>
  logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action, entityType, entityId: id, rationale })

/** Outcome samples for the confidence-interval bins, loaded once per request. */
async function loadSamples(consultingFirmId: string) {
  const rows = await prisma.calibrationSample.findMany({
    where: { consultingFirmId },
    select: { predictedProbability: true, observedOutcome: true },
    take: 5000,
  })
  return rows.map((r) => ({ predicted: r.predictedProbability, observed: r.observedOutcome }))
}

// -------------------------------------------------------------
// §6.2A — Transparent score
// -------------------------------------------------------------

router.get('/score/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const opportunity = await prisma.opportunity.findFirst({
      where: { id: req.params.opportunityId, consultingFirmId },
      select: {
        probabilityScore: true, scoreBreakdown: true, naicsCode: true, agency: true, setAsideType: true,
        estimatedValue: true, responseDeadline: true, competitionCount: true,
        incumbentProbability: true, historicalAwardCount: true, isEnriched: true,
      },
    })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    const samples = await loadSamples(consultingFirmId)
    const explained = await explainOpportunityScore(consultingFirmId, opportunity, samples)
    res.json({ success: true, data: explained })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.2B — Calibration admin
// -------------------------------------------------------------

router.get('/calibration', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [versions, active, sampleCount] = await Promise.all([
      prisma.tenantCalibration.findMany({ where: { consultingFirmId }, orderBy: { version: 'desc' }, take: 25 }),
      getActiveTenantCalibration(consultingFirmId),
      prisma.calibrationSample.count({ where: { consultingFirmId } }),
    ])
    res.json({
      success: true,
      data: {
        featureEnabled: tenantCalibrationEnabled(),
        active,
        versions,
        verifiedSampleCount: sampleCount,
        note: tenantCalibrationEnabled()
          ? 'A calibration is only activated when it beats the uncalibrated baseline on held-out data. Fitting a curve is not enough on its own.'
          : 'Probability calibration is disabled platform-wide (ENABLE_PROBABILITY_CALIBRATION). Scores are shown uncalibrated.',
      },
    })
  } catch (err) { next(err) }
})

/** GET /calibration/samples — the verified outcomes a fit would use. */
router.get('/calibration/samples', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const samples = await collectOutcomeSamples(consultingFirmId)
    res.json({
      success: true,
      data: {
        count: samples.length,
        wins: samples.filter((s) => s.observed === 1).length,
        losses: samples.filter((s) => s.observed === 0).length,
        bySource: samples.reduce((acc, s) => ({ ...acc, [s.outcomeSource]: (acc[s.outcomeSource] ?? 0) + 1 }), {} as Record<string, number>),
        earliest: samples[0]?.observedAt ?? null,
        latest: samples[samples.length - 1]?.observedAt ?? null,
      },
    })
  } catch (err) { next(err) }
})

router.post('/calibration/fit', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const minSampleSize = Number(req.body?.minSampleSize)
    const result = await fitTenantCalibration(consultingFirmId, {
      ...(Number.isInteger(minSampleSize) && minSampleSize > 0 ? { minSampleSize } : {}),
      actorUserId: req.user?.userId,
    })
    if (result.calibrationId) {
      await audit(req, consultingFirmId, 'UPDATE', 'TenantCalibration', result.calibrationId,
        `Calibration fit v${result.version}: ${result.activated ? 'ACTIVATED' : 'NOT ACTIVATED'} — ${result.reason}`)
    }
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

router.post('/calibration/:id/activate', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const candidate = await prisma.tenantCalibration.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!candidate) throw new NotFoundError('Calibration not found')
    // A rejected calibration failed its acceptance criteria; forcing it live
    // would defeat the whole safety mechanism.
    if (candidate.state === CalibrationState.REJECTED) {
      throw new ValidationError(`This calibration was rejected and cannot be activated: ${candidate.rejectionReason ?? 'it did not beat the baseline.'}`)
    }
    const activated = await activateCalibration(consultingFirmId, candidate.id, {
      actorUserId: req.user?.userId,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : 'Manually activated by an administrator.',
    })
    await audit(req, consultingFirmId, 'UPDATE', 'TenantCalibration', candidate.id, `Calibration v${candidate.version} activated`)
    res.json({ success: true, data: activated })
  } catch (err) { next(err) }
})

router.post('/calibration/rollback', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const result = await rollbackCalibration(consultingFirmId, { actorUserId: req.user?.userId })
    await audit(req, consultingFirmId, 'UPDATE', 'TenantCalibration', result.restoredId ?? 'none', result.reason)
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.2C / §6.2D — Incumbent retention + competitor mapping
// -------------------------------------------------------------

router.get('/incumbent-retention', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.IncumbentRetentionStatWhereInput = { consultingFirmId }
    if (typeof req.query.name === 'string' && req.query.name) {
      where.normalizedName = { contains: req.query.name.toLowerCase() }
    }
    const stats = await prisma.incumbentRetentionStat.findMany({
      where, orderBy: [{ sampleSize: 'desc' }], take: Math.min(Number(req.query.limit ?? 100) || 100, 300),
    })
    res.json({
      success: true,
      data: {
        stats,
        note: 'Every rate is shown with the denominator it was computed from. Where the sample is too small to state a rate, the rate is null and the counts are shown instead.',
      },
    })
  } catch (err) { next(err) }
})

router.get('/competitors', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const stats = await prisma.competitorAwardStat.findMany({
      where: {
        consultingFirmId,
        ...(typeof req.query.name === 'string' && req.query.name ? { normalizedName: { contains: req.query.name.toLowerCase() } } : {}),
      },
      orderBy: [{ observedAwards: 'desc' }],
      take: Math.min(Number(req.query.limit ?? 100) || 100, 300),
    })
    res.json({
      success: true,
      data: {
        stats,
        // The exact labels the UI must render. Award share is never presented
        // as a bid win rate.
        basisLabels: BASIS_LABELS,
        note: 'Public award data records who won, not who bid. Unless confirmed bid-participation data exists, figures are labelled as observed award share or historical award frequency — never as a win rate.',
      },
    })
  } catch (err) { next(err) }
})

router.post('/evidence/refresh', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [retention, competitors] = await Promise.all([
      refreshIncumbentRetention(consultingFirmId),
      refreshCompetitorStats(consultingFirmId),
    ])
    res.json({ success: true, data: { retention, competitors } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.2E — Pricing sensitivity
// -------------------------------------------------------------

const SensitivitySchema = z.object({
  extraScenarios: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    // Decimal-safe: prices travel as strings.
    totalPrice: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'totalPrice must be a decimal string'),
  })).max(20).optional(),
  /** Percentage adjustments applied to the base scenario, e.g. [-10, -5, 5]. */
  percentAdjustments: z.array(z.number().min(-90).max(200)).max(20).optional(),
})

router.get('/pricing-sensitivity/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const latest = await prisma.pricingSensitivityAnalysis.findFirst({
      where: { consultingFirmId, opportunityId: req.params.opportunityId },
      orderBy: { calculatedAt: 'desc' },
    })
    res.json({ success: true, data: latest })
  } catch (err) { next(err) }
})

router.post('/pricing-sensitivity/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = SensitivitySchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid sensitivity payload')

    const opportunity = await prisma.opportunity.findFirst({ where: { id: req.params.opportunityId, consultingFirmId }, select: { id: true } })
    if (!opportunity) throw new NotFoundError('Opportunity not found')

    // Percentage adjustments expand into explicit price points off the
    // preferred scenario. Approved pricing is only ever READ.
    const extra = [...(parsed.data.extraScenarios ?? []).map((s) => ({ id: null, name: s.name, totalPrice: s.totalPrice }))]
    if (parsed.data.percentAdjustments?.length) {
      const workspace = await prisma.pricingWorkspace.findFirst({
        where: { consultingFirmId, opportunityId: opportunity.id },
        select: { scenarios: { where: { isArchived: false }, select: { totalPrice: true, isPreferred: true }, orderBy: { sortOrder: 'asc' } } },
      })
      const baseScenario = workspace?.scenarios.find((s) => s.isPreferred) ?? workspace?.scenarios[0]
      if (baseScenario) {
        const basePrice = new Prisma.Decimal(baseScenario.totalPrice)
        for (const pct of parsed.data.percentAdjustments) {
          const adjusted = basePrice.mul(new Prisma.Decimal(100 + pct)).div(100).toFixed(2)
          extra.push({ id: null, name: `${pct > 0 ? '+' : ''}${pct}% of preferred`, totalPrice: adjusted })
        }
      }
    }

    const result = await runPricingSensitivity(consultingFirmId, opportunity.id, { extraScenarios: extra })
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.2F — Capability gaps + partner recommendations
// -------------------------------------------------------------

router.get('/gaps/:opportunityId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.capabilityGapAssessment.findFirst({
      where: { consultingFirmId, opportunityId: req.params.opportunityId },
    })
    if (existing) return res.json({ success: true, data: existing })
    const computed = await assessCapabilityGaps(consultingFirmId, req.params.opportunityId)
    if (!computed) throw new NotFoundError('Opportunity not found')
    const created = await prisma.capabilityGapAssessment.findUnique({ where: { opportunityId: req.params.opportunityId } })
    res.json({ success: true, data: created })
  } catch (err) { next(err) }
})

router.post('/gaps/:opportunityId/refresh', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const computed = await assessCapabilityGaps(consultingFirmId, req.params.opportunityId)
    if (!computed) throw new NotFoundError('Opportunity not found')
    res.json({ success: true, data: computed })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// §6.2G — Portfolio expected value
// -------------------------------------------------------------

router.get('/portfolio', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const withinDays = req.query.withinDays ? Number(req.query.withinDays) : undefined
    const portfolio = await computePortfolio(consultingFirmId, {
      agency: typeof req.query.agency === 'string' ? req.query.agency : undefined,
      naicsCode: typeof req.query.naicsCode === 'string' ? req.query.naicsCode : undefined,
      ownerUserId: typeof req.query.ownerUserId === 'string' ? req.query.ownerUserId : undefined,
      pipelineStage: typeof req.query.pipelineStage === 'string' ? req.query.pipelineStage : undefined,
      ...(Number.isFinite(withinDays) ? { withinDays: withinDays as number } : {}),
    })
    res.json({ success: true, data: portfolio })
  } catch (err) { next(err) }
})

/** GET /portfolio/export — CSV, matching the existing export convention. */
router.get('/portfolio/export', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const portfolio = await computePortfolio(consultingFirmId, {
      agency: typeof req.query.agency === 'string' ? req.query.agency : undefined,
      naicsCode: typeof req.query.naicsCode === 'string' ? req.query.naicsCode : undefined,
    })

    const header = ['Opportunity', 'Agency', 'NAICS', 'Value', 'Value Source', 'Value Type', 'Probability', 'Expected Value', 'EV Lower', 'EV Upper', 'Deadline', 'Eligibility']
    const escape = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const rows = portfolio.rows.map((r) => [
      r.title, r.agency, r.naicsCode, r.value, r.valueSource, r.valueType,
      r.probability, r.expectedValue, r.expectedValueLower ?? '', r.expectedValueUpper ?? '',
      r.responseDeadline.toISOString().slice(0, 10), r.eligibility ?? '',
    ].map(escape).join(','))

    // Excluded rows are exported too, so the CSV never looks more complete
    // than the data behind it.
    const exclusions = portfolio.exclusions.map((e) => [e.title, '', '', '', 'EXCLUDED', '', '', '', '', '', '', e.reason].map(escape).join(','))

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="portfolio-expected-value.csv"')
    res.send([header.map(escape).join(','), ...rows, ...exclusions].join('\n'))
  } catch (err) { next(err) }
})

export default router
