// =============================================================
// Market Analytics Routes — BigQuery-powered decision intelligence
// All routes require JWT auth. Scoped to the firm's NAICS portfolio.
// =============================================================
import { Router, Response } from 'express'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { prisma } from '../config/database'
import { ensureBigQueryDataset } from '../config/bigquery'
import {
  getCompetitionProfile,
  getAgencyProfile,
  getContractorProfile,
  getMarketSnapshot,
  getAwardHistoryCount,
} from '../services/bigquery/analyticsService'
import { ingestAwardsForNaics, ingestBulkNaics } from '../services/bigquery/ingestionService'
import { claimIngestWarm } from '../services/bigquery/ingestGuard'
import { getMarketInsights } from '../services/bigquery/marketInsights'
import { logger } from '../utils/logger'
import { runBackground } from '../utils/asyncSafe'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('market_intel'))

// ── Status ────────────────────────────────────────────────────

/**
 * GET /api/market-analytics/status
 * Returns BQ connectivity + row count. Used by frontend to show "data available" state.
 */
router.get('/status', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    await ensureBigQueryDataset()
    const count = await getAwardHistoryCount()
    res.json({
      success: true,
      data: {
        connected: count >= 0,
        awardRows: count < 0 ? 0 : count,
        hasData: count > 0,
      },
    })
  } catch (err) {
    logger.error('BQ status check failed', { error: (err as Error).message })
    res.json({ success: true, data: { connected: false, awardRows: 0, hasData: false } })
  }
})

// ── Competition Profile ───────────────────────────────────────

/**
 * GET /api/market-analytics/competition/:naicsCode
 * Full competition profile: top winners, HHI, offers received, set-aside breakdown.
 * Optional query param: ?agency=Department+of+Veterans+Affairs
 */
router.get('/competition/:naicsCode', async (req: AuthenticatedRequest, res: Response) => {
  const { naicsCode } = req.params
  const agency = req.query.agency as string | undefined

  if (!naicsCode || naicsCode.length < 4) {
    return res.status(400).json({ success: false, error: 'naicsCode must be at least 4 digits' })
  }

  try {
    const profile = await getCompetitionProfile(naicsCode, agency)
    if (!profile || profile.dataPoints === 0) {
      return res.json({
        success: true,
        data: null,
        message: 'No data in BigQuery for this NAICS. Run /ingest first.',
      })
    }
    res.json({ success: true, data: profile })
  } catch (err) {
    logger.error('Competition profile route failed', { naicsCode, error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to load competition profile' })
  }
})

// ── Agency Profile ────────────────────────────────────────────

/**
 * GET /api/market-analytics/agency/:agencyName
 * Agency buying profile: SB/SDVOSB/WOSB/HUBZone rates, top NAICS, avg award.
 */
router.get('/agency/:agencyName', async (req: AuthenticatedRequest, res: Response) => {
  const agency = decodeURIComponent(req.params.agencyName)

  try {
    const profile = await getAgencyProfile(agency)
    if (!profile || profile.dataPoints === 0) {
      return res.json({
        success: true,
        data: null,
        message: 'No data in BigQuery for this agency. Run /ingest first.',
      })
    }
    res.json({ success: true, data: profile })
  } catch (err) {
    logger.error('Agency profile route failed', { agency, error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to load agency profile' })
  }
})

// ── Contractor Profile ────────────────────────────────────────

/**
 * GET /api/market-analytics/contractor/:name
 * Incumbent / competitor win history by recipient name.
 */
router.get('/contractor/:name', async (req: AuthenticatedRequest, res: Response) => {
  const recipientName = decodeURIComponent(req.params.name)

  try {
    const profile = await getContractorProfile(recipientName)
    if (!profile) {
      return res.json({
        success: true,
        data: null,
        message: 'No award history found for this contractor.',
      })
    }
    res.json({ success: true, data: profile })
  } catch (err) {
    logger.error('Contractor profile route failed', { recipientName, error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to load contractor profile' })
  }
})

// ── Market Snapshot ───────────────────────────────────────────

/**
 * GET /api/market-analytics/snapshot
 * Firm-wide multi-NAICS market snapshot.
 * Automatically uses the consulting firm's client NAICS codes.
 * Optional: ?naics=541511,541519  ?years=1|3|5|10  (default 5)
 *
 * Response includes a per-NAICS portfolio overlay:
 *   { naicsCode, ..., myActiveOpps, myExpectedValue }
 * sourced from Postgres so users see "your slice of this market".
 */
router.get('/snapshot', async (req: AuthenticatedRequest, res: Response) => {
  const firmId = req.user?.consultingFirmId
  if (!firmId) return res.status(401).json({ success: false, error: 'Unauthorized' })

  try {
    let naicsCodes: string[]

    if (req.query.naics) {
      naicsCodes = (req.query.naics as string).split(',').map((s) => s.trim()).filter(Boolean)
    } else {
      const clients = await prisma.clientCompany.findMany({
        where: { consultingFirmId: firmId, isActive: true },
        select: { naicsCodes: true },
      })
      const allCodes = clients.flatMap((c) => c.naicsCodes)
      naicsCodes = [...new Set(allCodes)]
    }

    if (naicsCodes.length === 0) {
      return res.json({ success: true, data: null, message: 'No NAICS codes found for this firm.' })
    }

    const yearsBack = Math.min(10, Math.max(1, parseInt((req.query.years as string) ?? '5', 10) || 5))

    const snapshot = await getMarketSnapshot(naicsCodes, { yearsBack })
    if (!snapshot) {
      return res.json({ success: true, data: null, message: 'No BigQuery data for these NAICS yet.' })
    }

    // Portfolio overlay — count firm's own active opps per NAICS + probability-weighted value
    const opps = await prisma.opportunity.findMany({
      where: {
        consultingFirmId: firmId,
        status: 'ACTIVE',
        naicsCode: { in: naicsCodes },
      },
      select: { naicsCode: true, probabilityScore: true, estimatedValue: true },
    })
    const portfolioByNaics: Record<string, { count: number; expected: number }> = {}
    for (const o of opps) {
      const key = o.naicsCode
      if (!portfolioByNaics[key]) portfolioByNaics[key] = { count: 0, expected: 0 }
      portfolioByNaics[key].count++
      portfolioByNaics[key].expected += Number(o.probabilityScore) * Number(o.estimatedValue ?? 0)
    }

    const heatmapWithOverlay = snapshot.heatmap.map((row) => ({
      ...row,
      myActiveOpps: portfolioByNaics[row.naicsCode]?.count ?? 0,
      myExpectedValue: portfolioByNaics[row.naicsCode]?.expected ?? 0,
    }))

    res.json({
      success: true,
      data: {
        ...snapshot,
        heatmap: heatmapWithOverlay,
        firmActiveOppCount: opps.length,
        firmActivePipelineValue: opps.reduce(
          (s, o) => s + (Number(o.probabilityScore) * Number(o.estimatedValue ?? 0)),
          0,
        ),
      },
    })
  } catch (err) {
    logger.error('Market snapshot route failed', { error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to load market snapshot' })
  }
})

/**
 * GET /api/market-analytics/insights
 * Returns 3-5 plain-English market insights tailored to the firm's
 * client portfolio (certifications, NAICS coverage, pipeline activity).
 */
router.get('/insights', async (req: AuthenticatedRequest, res: Response) => {
  const firmId = req.user?.consultingFirmId
  if (!firmId) return res.status(401).json({ success: false, error: 'Unauthorized' })

  try {
    const clients = await prisma.clientCompany.findMany({
      where: { consultingFirmId: firmId, isActive: true },
      select: { naicsCodes: true, sdvosb: true, wosb: true, hubzone: true, smallBusiness: true },
    })
    if (clients.length === 0) {
      return res.json({ success: true, data: [], message: 'Add active clients to see insights.' })
    }

    const naicsCodes = [...new Set(clients.flatMap((c) => c.naicsCodes))]
    if (naicsCodes.length === 0) {
      return res.json({ success: true, data: [], message: 'Set NAICS codes on a client to enable insights.' })
    }

    const snapshot = await getMarketSnapshot(naicsCodes)
    if (!snapshot) {
      return res.json({ success: true, data: [], message: 'No BigQuery data for these NAICS yet — run ingest first.' })
    }

    // Aggregate firm-level certifications (any active client with the cert flips the firm flag)
    const firmCertifications = {
      sdvosb: clients.some((c) => c.sdvosb),
      wosb: clients.some((c) => c.wosb),
      hubzone: clients.some((c) => c.hubzone),
      smallBiz: clients.some((c) => c.smallBusiness),
    }

    // Pipeline context (probability-weighted active opps in tracked NAICS)
    const opps = await prisma.opportunity.findMany({
      where: {
        consultingFirmId: firmId,
        status: 'ACTIVE',
        naicsCode: { in: naicsCodes },
      },
      select: { probabilityScore: true, estimatedValue: true },
    })
    const firmActiveOppCount = opps.length
    const firmActivePipelineValue = opps.reduce(
      (sum, o) => sum + (Number(o.probabilityScore) * Number(o.estimatedValue ?? 0)),
      0,
    )

    const insights = await getMarketInsights({
      snapshot,
      firmCertifications,
      firmActivePipelineValue,
      firmActiveOppCount,
    })

    res.json({ success: true, data: insights })
  } catch (err) {
    logger.error('Market insights route failed', { error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to load insights' })
  }
})

// ── Market Preview (all tiers) ────────────────────────────────

// Common federal professional-services NAICS, used when a firm has no client
// NAICS yet so the preview still shows real market data on day one.
const DEFAULT_PREVIEW_NAICS = ['541512', '541511', '541330', '541611', '561210', '541519']

/**
 * GET /api/market-analytics/preview
 * A LIMITED, all-tiers market overview (no enterprise gate): headline market
 * size, avg contract value, top buying agencies, aggregated set-aside rates,
 * a trimmed per-NAICS list, and the firm's own matching active-opp count.
 * The full heatmap, named competitor/top-winner lists, and multi-year
 * drill-downs remain in the enterprise /snapshot + /competition endpoints.
 *
 * Scope resolution: ?naics=CSV  >  ?clientId=  >  all active clients  >  defaults.
 * If BigQuery has no rows for the resolved NAICS yet, returns { status: 'warming' }
 * and kicks a background ingest so it fills in shortly.
 */
router.get('/preview', async (req: AuthenticatedRequest, res: Response) => {
  const firmId = req.user?.consultingFirmId
  if (!firmId) return res.status(401).json({ success: false, error: 'Unauthorized' })

  try {
    let naicsCodes: string[] = []
    let scope: 'custom' | 'client' | 'firm' | 'default' = 'default'

    if (req.query.naics) {
      naicsCodes = String(req.query.naics).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25)
      scope = 'custom'
    } else if (req.query.clientId) {
      const client = await prisma.clientCompany.findFirst({
        where: { id: String(req.query.clientId), consultingFirmId: firmId },
        select: { naicsCodes: true },
      })
      naicsCodes = [...new Set(client?.naicsCodes ?? [])]
      scope = client && naicsCodes.length > 0 ? 'client' : 'default'
    } else {
      const clients = await prisma.clientCompany.findMany({
        where: { consultingFirmId: firmId, isActive: true },
        select: { naicsCodes: true },
      })
      naicsCodes = [...new Set(clients.flatMap((c) => c.naicsCodes))]
      scope = naicsCodes.length > 0 ? 'firm' : 'default'
    }

    let usedDefault = false
    if (naicsCodes.length === 0) {
      naicsCodes = DEFAULT_PREVIEW_NAICS
      usedDefault = true
    }

    const yearsBack = Math.min(10, Math.max(1, parseInt((req.query.years as string) ?? '5', 10) || 5))

    // Firm's own matching active opportunities (Postgres — always available)
    const opps = await prisma.opportunity.findMany({
      where: { consultingFirmId: firmId, status: 'ACTIVE', naicsCode: { in: naicsCodes } },
      select: { naicsCode: true },
    })
    const oppCountByNaics: Record<string, number> = {}
    for (const o of opps) oppCountByNaics[o.naicsCode] = (oppCountByNaics[o.naicsCode] ?? 0) + 1
    const clientMatchCount = opps.length

    await ensureBigQueryDataset()
    const snapshot = await getMarketSnapshot(naicsCodes, { yearsBack })

    if (!snapshot || snapshot.heatmap.length === 0 || snapshot.totalOpportunityVolume === 0) {
      // No central data for these NAICS yet — warm it in the background, but only
      // once per NAICS set per cooldown so concurrent loads don't stack ingests
      // and inflate the aggregates (append-only ingestion).
      if (claimIngestWarm(naicsCodes)) {
        runBackground(
          'bq-ingest-preview-warm',
          async () => {
            await ingestBulkNaics(naicsCodes, { maxPages: 3, yearsBack: 5 })
          },
          { consultingFirmId: firmId, entityType: 'BQIngest' },
        )
      }
      return res.json({
        success: true,
        data: { status: 'warming', scope, usedDefault, naicsCodes, clientMatchCount },
      })
    }

    // Aggregate set-aside mix across the tracked NAICS
    const setAsideAgg: Record<string, number> = {}
    for (const row of snapshot.heatmap) {
      for (const sa of row.setAsideBreakdown ?? []) {
        setAsideAgg[sa.type] = (setAsideAgg[sa.type] ?? 0) + sa.count
      }
    }
    const setAsideTotal = Object.values(setAsideAgg).reduce((s, n) => s + n, 0)
    const setAsideRates = Object.entries(setAsideAgg)
      .map(([type, count]) => ({ type, count, pct: setAsideTotal > 0 ? count / setAsideTotal : 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6)

    // Trimmed per-NAICS list (no HHI / unique winners / sparklines — those are enterprise)
    const perNaics = snapshot.heatmap
      .map((r) => ({
        naicsCode: r.naicsCode,
        awards: r.awards,
        avgAmount: r.avgAmount,
        myActiveOpps: oppCountByNaics[r.naicsCode] ?? 0,
      }))
      .sort((a, b) => b.awards - a.awards)
      .slice(0, 12)

    res.json({
      success: true,
      data: {
        status: 'ready',
        scope,
        usedDefault,
        naicsCodes,
        yearsBack: snapshot.yearsBack,
        totalMarketVolume: snapshot.totalOpportunityVolume,
        avgContractSize: snapshot.avgContractSize,
        competitorCount: snapshot.competitorCount,
        topAgencies: snapshot.topAgencies.slice(0, 5),
        setAsideRates,
        perNaics,
        clientMatchCount,
      },
    })
  } catch (err) {
    logger.error('Market preview route failed', { error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to load market preview' })
  }
})

// ── Market Watchlist ──────────────────────────────────────────

/**
 * GET /api/market-analytics/watchlist
 * List the firm's watched NAICS codes and agencies.
 */
router.get('/watchlist', async (req: AuthenticatedRequest, res: Response) => {
  const firmId = req.user?.consultingFirmId
  if (!firmId) return res.status(401).json({ success: false, error: 'Unauthorized' })
  try {
    const entries = await prisma.marketWatchlistEntry.findMany({
      where: { consultingFirmId: firmId },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, data: entries })
  } catch (err) {
    logger.error('Watchlist list failed', { error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to load watchlist' })
  }
})

/**
 * POST /api/market-analytics/watchlist
 * Body: { naicsCode?: string, agency?: string }  (exactly one)
 */
router.post('/watchlist', async (req: AuthenticatedRequest, res: Response) => {
  const firmId = req.user?.consultingFirmId
  if (!firmId) return res.status(401).json({ success: false, error: 'Unauthorized' })
  const { naicsCode, agency } = req.body ?? {}
  const trimmedNaics = typeof naicsCode === 'string' ? naicsCode.trim() : null
  const trimmedAgency = typeof agency === 'string' ? agency.trim() : null
  if ((trimmedNaics && trimmedAgency) || (!trimmedNaics && !trimmedAgency)) {
    return res.status(400).json({ success: false, error: 'Provide exactly one of naicsCode or agency.' })
  }
  try {
    // Prisma's generated compound-unique input type doesn't accept null for
    // nullable scalar parts; we deduplicate manually since exactly one of the
    // two fields is set.
    const existing = await prisma.marketWatchlistEntry.findFirst({
      where: { consultingFirmId: firmId, naicsCode: trimmedNaics, agency: trimmedAgency },
    })
    const entry = existing
      ? existing
      : await prisma.marketWatchlistEntry.create({
          data: {
            consultingFirmId: firmId,
            naicsCode: trimmedNaics,
            agency: trimmedAgency,
            createdBy: req.user?.userId,
          },
        })
    res.json({ success: true, data: entry })
  } catch (err) {
    logger.error('Watchlist add failed', { error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to add to watchlist' })
  }
})

/**
 * DELETE /api/market-analytics/watchlist/:id
 */
router.delete('/watchlist/:id', async (req: AuthenticatedRequest, res: Response) => {
  const firmId = req.user?.consultingFirmId
  if (!firmId) return res.status(401).json({ success: false, error: 'Unauthorized' })
  try {
    await prisma.marketWatchlistEntry.deleteMany({
      where: { id: req.params.id, consultingFirmId: firmId },
    })
    res.json({ success: true })
  } catch (err) {
    logger.error('Watchlist delete failed', { error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Failed to remove watchlist entry' })
  }
})

// ── Ingestion (Admin) ─────────────────────────────────────────

/**
 * POST /api/market-analytics/ingest
 * Trigger USAspending → BigQuery ingestion for a NAICS code.
 * Body: { naicsCode: string, agency?: string, maxPages?: number }
 *
 * For bulk firm-wide backfill:
 * Body: { bulk: true } — uses all client NAICS codes
 */
router.post('/ingest', async (req: AuthenticatedRequest, res: Response) => {
  const firmId = req.user?.consultingFirmId
  const role   = req.user?.role

  if (!firmId) return res.status(401).json({ success: false, error: 'Unauthorized' })
  if (role !== 'ADMIN') return res.status(403).json({ success: false, error: 'Admin only' })

  try {
    await ensureBigQueryDataset()

    if (req.body.bulk) {
      // Bulk ingest — fire and forget, return immediately
      const clients = await prisma.clientCompany.findMany({
        where: { consultingFirmId: firmId, isActive: true },
        select: { naicsCodes: true },
      })
      const allCodes = [...new Set(clients.flatMap((c) => c.naicsCodes))]

      if (allCodes.length === 0) {
        return res.json({ success: true, message: 'No NAICS codes to ingest.' })
      }

      runBackground(
        'bq-ingest-bulk-naics',
        async () => {
          await ingestBulkNaics(allCodes, { maxPages: req.body.maxPages ?? 5, yearsBack: req.body.yearsBack ?? 5 })
        },
        { consultingFirmId: firmId, entityType: 'BQIngest' },
      )

      return res.json({
        success: true,
        message: `Bulk ingestion started for ${allCodes.length} NAICS codes. Runs in background.`,
        naicsCodes: allCodes,
      })
    }

    // Custom list ingest — { naicsCodes: string[], maxPages?, yearsBack? }
    if (Array.isArray(req.body.naicsCodes) && req.body.naicsCodes.length > 0) {
      const codes: string[] = [...new Set(req.body.naicsCodes as string[])]
      runBackground(
        'bq-ingest-naics-list',
        async () => {
          await ingestBulkNaics(codes, { maxPages: req.body.maxPages ?? 20, yearsBack: req.body.yearsBack ?? 7 })
        },
        { consultingFirmId: firmId, entityType: 'BQIngest' },
      )
      return res.json({
        success: true,
        message: `Mass ingestion started for ${codes.length} NAICS codes (${req.body.maxPages ?? 20} pages × ${req.body.yearsBack ?? 7}yr each). Runs in background.`,
        naicsCodes: codes,
      })
    }

    const { naicsCode, agency, maxPages = 20, yearsBack = 7 } = req.body
    if (!naicsCode) {
      return res.status(400).json({ success: false, error: 'naicsCode is required' })
    }

    const result = await ingestAwardsForNaics({ naicsCode, agency, maxPages, yearsBack })
    res.json({ success: true, data: result })
  } catch (err) {
    logger.error('Ingest route failed', { error: (err as Error).message })
    res.status(500).json({ success: false, error: 'Ingestion failed' })
  }
})

export default router
