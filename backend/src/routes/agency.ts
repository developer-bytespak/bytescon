// =============================================================
// Agency Routes — Agency-centric subcontracting + teaming view
// Powers the new /agency SPA page.
//
// Endpoints:
//   GET  /api/agency                              — agencies with signal, ranked
//   GET  /api/agency/:agencyCode/primes           — primes >$100M at agency
//   GET  /api/agency/:agencyCode/subs             — open sub opps <$100M
//   GET  /api/agency/:agencyCode/primes/:uei      — prime drill-down
//
// All endpoints follow the {success, data, error?, code?} envelope.
// All endpoints tenant-scoped via the standard authenticateJWT +
// enforceTenantScope middleware. WinnersAwardStage + WinnersSubawardStage
// data is platform-wide (public USAspending) — no tenant filter applies
// there. SubcontractOpportunity IS tenant-scoped and filtered accordingly.
// =============================================================

import { Router, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { logger } from '../utils/logger'
import { computeTeamingFit } from '../services/teamingSuggester'
import { draftTeamingOutreach } from '../services/teamingOutreachService'
import { checkProposalTokens } from '../middleware/tierGate'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)
// Agency profiling/primes/subs/relationships are Market Intel; the AI
// outreach drafter belongs to Teaming & Subcontracting. One dispatcher so
// the two module gates never stack on the same request.
router.use((req, res, next) =>
  (req.path === '/draft-outreach'
    ? requireAddon('teaming_suite')
    : requireAddon('market_intel'))(req as AuthenticatedRequest, res, next),
)

// Primes <$100M threshold per the plan. Configurable here so we can tune
// without redeploying if the operator wants the cutoff at $50M or $250M.
const PRIME_DOLLAR_THRESHOLD = 100_000_000

// In-process cache for the agency-list endpoint. Per-firm key, 15-min TTL.
// Sized for hundreds of firms; tiny memory footprint. No-op on cold start.
interface CacheEntry<T> { value: T; expiresAt: number }
const agencyListCache = new Map<string, CacheEntry<AgencyListItem[]>>()
const AGENCY_LIST_TTL_MS = 15 * 60 * 1000

interface AgencyListItem {
  agencyToptierCode: string
  agencyToptierName: string | null
  totalAwardDollars: number
  awardCount: number
  openOppCount: number
  openSubCount: number
}

// --- GB-105 Agency View v2 profile types + cache ---
interface ClassificationStat {
  code: string
  count: number
  dollars: number
  dollarShare: number
}
interface AgencyProfile {
  agencyCode: string
  agencyName: string | null
  window: { windowYears: number; fyStart: number | null; fyEnd: number | null }
  spendActivity: {
    totalDollars: number
    totalAwards: number
    byFiscalYear: { fiscalYear: number; dollars: number; awards: number }[]
  }
  topClassifications: { topNaics: ClassificationStat[]; topPsc: ClassificationStat[] }
  setAsideUtilization: { setAsideType: string; count: number; dollars: number; dollarShare: number }[]
  recurringPatterns: { naics: string; yearsActive: number; awards: number; dollars: number; hasRecompete: boolean }[]
}
const agencyProfileCache = new Map<string, CacheEntry<AgencyProfile>>()
const AGENCY_PROFILE_TTL_MS = 15 * 60 * 1000

// =============================================================
// GET /api/agency
// Returns top agencies the firm has signal at (or platform-wide if the
// firm has no opportunities yet). Cached 15 min per firm.
// =============================================================
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const cached = agencyListCache.get(consultingFirmId)
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ success: true, data: cached.value })
    }

    // Step 1: top agencies by total prime-award obligation (platform-wide).
    // Limit 50 — we surface the operator's busiest agencies plus a long-tail
    // for browsing. Frontend orders by openOppCount+openSubCount once we
    // overlay the firm's pipeline counts.
    type AgencyAggRow = {
      agencyToptierCode: string
      agencyToptierName: string | null
      totalDollars: bigint | string | number
      awardCount: bigint | number
    }
    const topAgencies = await prisma.$queryRaw<AgencyAggRow[]>`
      SELECT
        "agencyToptierCode",
        MAX("agencyToptierName") as "agencyToptierName",
        SUM("totalObligation") as "totalDollars",
        COUNT(*) as "awardCount"
      FROM winners_award_stage
      WHERE "agencyToptierCode" IS NOT NULL
      GROUP BY "agencyToptierCode"
      ORDER BY SUM("totalObligation") DESC NULLS LAST
      LIMIT 50
    `

    // Step 2: firm-scoped open opportunity + subcontract counts grouped by
    // agency string. We match on agency NAME (case-insensitive contains)
    // because SAM.gov uses the string form ("Department of Defense") while
    // USAspending uses the toptier code form ("9700"). Imperfect — some
    // agencies will miss the join — but good enough as a relevance signal.
    type FirmAgencySignal = { agency: string; openOppCount: bigint | number; openSubCount: bigint | number }
    const firmSignals = await prisma.$queryRaw<FirmAgencySignal[]>`
      SELECT
        COALESCE(opp_agg.agency, sub_agg.agency) as agency,
        COALESCE(opp_agg.cnt, 0) as "openOppCount",
        COALESCE(sub_agg.cnt, 0) as "openSubCount"
      FROM
        (SELECT agency, COUNT(*) as cnt FROM opportunities
         WHERE "consultingFirmId" = ${consultingFirmId}
           AND status = 'ACTIVE' AND agency IS NOT NULL
         GROUP BY agency) opp_agg
      FULL OUTER JOIN
        (SELECT agency, COUNT(*) as cnt FROM subcontract_opportunities
         WHERE "consultingFirmId" = ${consultingFirmId}
           AND status = 'OPEN' AND agency IS NOT NULL
         GROUP BY agency) sub_agg
      ON LOWER(opp_agg.agency) = LOWER(sub_agg.agency)
    `

    // Step 3: merge — overlay firm signals onto the top agencies list by
    // fuzzy name match (lowercase contains). Agencies the firm has signal
    // at but that aren't in the platform-wide top 50 are appended at the
    // end so we don't lose them.
    const result: AgencyListItem[] = topAgencies.map((a) => {
      const name = a.agencyToptierName ?? ''
      const matchedSignal = firmSignals.find((s) =>
        name && s.agency && fuzzyAgencyMatch(name, s.agency),
      )
      return {
        agencyToptierCode: a.agencyToptierCode,
        agencyToptierName: a.agencyToptierName,
        totalAwardDollars: Number(a.totalDollars ?? 0),
        awardCount: Number(a.awardCount ?? 0),
        openOppCount: Number(matchedSignal?.openOppCount ?? 0),
        openSubCount: Number(matchedSignal?.openSubCount ?? 0),
      }
    })

    // Sort by firm relevance (openOppCount + openSubCount) first, then by
    // platform-wide award dollars as the tiebreaker. Firms with no opps
    // anywhere get the platform-wide ordering.
    result.sort((a, b) => {
      const aSignal = a.openOppCount + a.openSubCount
      const bSignal = b.openOppCount + b.openSubCount
      if (aSignal !== bSignal) return bSignal - aSignal
      return b.totalAwardDollars - a.totalAwardDollars
    })

    agencyListCache.set(consultingFirmId, {
      value: result,
      expiresAt: Date.now() + AGENCY_LIST_TTL_MS,
    })

    res.json({ success: true, data: result })
  } catch (err) {
    logger.error('Failed to list agencies', {
      consultingFirmId: req.user?.consultingFirmId,
      error: (err as Error).message,
    })
    next(err)
  }
})

// =============================================================
// GET /api/agency/:agencyCode/primes
// Top primes at this agency with >$100M total obligation.
// Aggregates sub-spend ratio + small-biz sub-spend rate from the sub table.
// Sortable via ?sort=totalDollars|awardCount|subSpendRatio|naicsCoverage
// =============================================================
router.get('/:agencyCode/primes', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const agencyCode = req.params.agencyCode
    const sort = (req.query.sort as string) || 'totalDollars'

    // Threshold defaults to $100M (the original "big-prime partnership target"
    // cutoff from the plan). Operator-overridable per-request — small agencies
    // (e.g. MCC, Peace Corps) don't have ANY $100M primes, so the UI lets the
    // user lower it. Clamped 0 → $10B so a typo in the URL can't blow up the
    // page.
    const reqThreshold = Number(req.query.minDollars ?? PRIME_DOLLAR_THRESHOLD)
    const threshold = Number.isFinite(reqThreshold)
      ? Math.max(0, Math.min(10_000_000_000, reqThreshold))
      : PRIME_DOLLAR_THRESHOLD

    type PrimeRow = {
      recipientUei: string
      recipientName: string | null
      totalDollars: bigint | string | number
      awardCount: bigint | number
      totalSubAmount: bigint | string | number | null
      smallBizSubAmount: bigint | string | number | null
      naicsList: string[] | null
    }
    const primes = await prisma.$queryRaw<PrimeRow[]>`
      WITH prime_totals AS (
        SELECT
          "recipientUei",
          MAX("recipientName") as "recipientName",
          SUM("totalObligation") as "totalDollars",
          COUNT(*) as "awardCount",
          ARRAY_AGG(DISTINCT naics) FILTER (WHERE naics ~ '^[0-9]{2,6}$') as "naicsList"
        FROM winners_award_stage
        WHERE "agencyToptierCode" = ${agencyCode}
          AND "recipientUei" IS NOT NULL AND "recipientUei" <> ''
        GROUP BY "recipientUei"
        HAVING SUM("totalObligation") >= ${threshold}
      ),
      sub_totals AS (
        SELECT
          prime."recipientUei",
          SUM(sub."subAmount") as "totalSubAmount",
          SUM(CASE WHEN sub."subRecipientSize" = 'small'
                   THEN sub."subAmount" ELSE 0 END) as "smallBizSubAmount"
        FROM winners_award_stage prime
        JOIN winners_subaward_stage sub
          ON sub."primeAwardId" = prime."usaspendingAwardId"
        WHERE prime."agencyToptierCode" = ${agencyCode}
          AND prime."recipientUei" IN (SELECT "recipientUei" FROM prime_totals)
        GROUP BY prime."recipientUei"
      )
      SELECT
        p."recipientUei",
        p."recipientName",
        p."totalDollars",
        p."awardCount",
        s."totalSubAmount",
        s."smallBizSubAmount",
        p."naicsList"
      FROM prime_totals p
      LEFT JOIN sub_totals s ON s."recipientUei" = p."recipientUei"
      ORDER BY p."totalDollars" DESC
      LIMIT 100
    `

    // Diagnostic counts so the UI can show "0 primes ≥$100M but top prime
    // is $34M — try lowering the threshold." instead of a dead-end blank
    // state. Single fast query because we already have an index on
    // agencyToptierCode.
    type DiagRow = {
      primesWithUei: bigint | number
      topPrimeDollars: bigint | string | number | null
      awardsWithNullUei: bigint | number
    }
    const diagRows = await prisma.$queryRaw<DiagRow[]>`
      SELECT
        COUNT(DISTINCT "recipientUei") FILTER (WHERE "recipientUei" IS NOT NULL AND "recipientUei" <> '') as "primesWithUei",
        MAX(prime_sum.total) as "topPrimeDollars",
        SUM(CASE WHEN "recipientUei" IS NULL OR "recipientUei" = '' THEN 1 ELSE 0 END) as "awardsWithNullUei"
      FROM winners_award_stage,
      LATERAL (
        SELECT SUM("totalObligation") as total
        FROM winners_award_stage prime_inner
        WHERE prime_inner."agencyToptierCode" = ${agencyCode}
          AND prime_inner."recipientUei" = winners_award_stage."recipientUei"
          AND prime_inner."recipientUei" IS NOT NULL
      ) prime_sum
      WHERE "agencyToptierCode" = ${agencyCode}
    `

    const enriched = primes.map((p) => {
      const totalDollars = Number(p.totalDollars ?? 0)
      const totalSub = Number(p.totalSubAmount ?? 0)
      const smallBizSub = Number(p.smallBizSubAmount ?? 0)
      const naicsList = Array.isArray(p.naicsList) ? p.naicsList : []
      return {
        recipientUei: p.recipientUei,
        recipientName: p.recipientName,
        totalDollars,
        awardCount: Number(p.awardCount ?? 0),
        totalSubAmount: totalSub,
        smallBizSubAmount: smallBizSub,
        subSpendRatio: totalDollars > 0 ? totalSub / totalDollars : 0,
        smallBizSubSpendRate: totalSub > 0 ? smallBizSub / totalSub : 0,
        naicsCoverage: naicsList.length,
        topNaics: naicsList.slice(0, 5),
      }
    })

    // Client-side sort applied here so the frontend can flip columns without
    // re-fetching. SQL already returns the totalDollars-desc default.
    if (sort === 'awardCount') {
      enriched.sort((a, b) => b.awardCount - a.awardCount)
    } else if (sort === 'subSpendRatio') {
      enriched.sort((a, b) => b.subSpendRatio - a.subSpendRatio)
    } else if (sort === 'naicsCoverage') {
      enriched.sort((a, b) => b.naicsCoverage - a.naicsCoverage)
    }

    const diag = diagRows[0]
    res.json({
      success: true,
      data: {
        primes: enriched,
        threshold,
        // Diagnostics for the empty-state UX:
        diagnostics: {
          primesWithUei: Number(diag?.primesWithUei ?? 0),
          topPrimeDollars: Number(diag?.topPrimeDollars ?? 0),
          awardsWithNullUei: Number(diag?.awardsWithNullUei ?? 0),
        },
      },
    })
  } catch (err) {
    logger.error('Failed to load primes for agency', {
      agencyCode: req.params.agencyCode,
      error: (err as Error).message,
    })
    next(err)
  }
})

// =============================================================
// GET /api/agency/:agencyCode/subs
// Returns two sub-related datasets for the agency:
//   1. recentSubawards — historical sub-awards from WinnersSubawardStage
//      (platform-wide data, always populated once Winners Intel has run).
//      Shows who primes actually paid for sub work, biased toward small
//      business. This is what most operators want to see — actual small-
//      biz traction at the agency.
//   2. openPostings — current SubcontractOpportunity rows from the firm's
//      SubNet sync (firm-scoped, empty until the firm runs the sync).
//      Forward-looking, but most firms don't have any populated.
//
// Both filtered to <$100M to mirror the "big primes vs small subs" split
// on the left panel.
// =============================================================
router.get('/:agencyCode/subs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const agencyCode = req.params.agencyCode

    // Resolve agencyCode → agencyName for SubNet string-form matching.
    const agencyNameRow = await prisma.winnersAwardStage.findFirst({
      where: { agencyToptierCode: agencyCode, agencyToptierName: { not: null } },
      select: { agencyToptierName: true },
    })
    const agencyName = agencyNameRow?.agencyToptierName ?? null

    // ---- 1. Recent sub-awards (platform-wide historical) ----
    // Join sub_awards → prime_awards to scope by agency, filter <$100M,
    // and prefer small-biz subs first (ranking signal).
    type SubawardRow = {
      id: string
      subRecipientUei: string | null
      subRecipientName: string | null
      subRecipientSize: string | null
      subAmount: bigint | string | number | null
      subActionDate: Date | null
      subNaics: string | null
      primeUei: string | null
      primeRecipientName: string | null
      primeAwardId: string
    }
    const recentSubawards = await prisma.$queryRaw<SubawardRow[]>`
      SELECT
        sub.id,
        sub."subRecipientUei",
        sub."subRecipientName",
        sub."subRecipientSize",
        sub."subAmount",
        sub."subActionDate",
        sub."subNaics",
        prime."recipientUei" as "primeUei",
        prime."recipientName" as "primeRecipientName",
        sub."primeAwardId"
      FROM winners_subaward_stage sub
      JOIN winners_award_stage prime
        ON prime."usaspendingAwardId" = sub."primeAwardId"
      WHERE prime."agencyToptierCode" = ${agencyCode}
        AND (sub."subAmount" IS NULL OR sub."subAmount" < ${PRIME_DOLLAR_THRESHOLD})
        AND sub."subAmount" IS NOT NULL
      ORDER BY
        -- small biz first (small > unknown > large), then by dollar size
        CASE sub."subRecipientSize"
          WHEN 'small' THEN 0
          WHEN 'unknown' THEN 1
          ELSE 2
        END,
        sub."subAmount" DESC NULLS LAST
      LIMIT 100
    `

    // ---- 2. Open SubNet postings (firm-scoped, may be empty) ----
    const openPostings = await prisma.subcontractOpportunity.findMany({
      where: {
        consultingFirmId,
        status: 'OPEN',
        OR: [
          { estimatedValue: null },
          { estimatedValue: { lt: PRIME_DOLLAR_THRESHOLD } },
        ],
        ...(agencyName ? { agency: { contains: agencyName, mode: 'insensitive' } } : {}),
      },
      orderBy: { scrapedAt: 'desc' },
      take: 50,
    })

    res.json({
      success: true,
      data: {
        agencyName,
        recentSubawards: recentSubawards.map((s) => ({
          id: s.id,
          subRecipientUei: s.subRecipientUei,
          subRecipientName: s.subRecipientName,
          subRecipientSize: s.subRecipientSize,
          subAmount: Number(s.subAmount ?? 0),
          subActionDate: s.subActionDate,
          subNaics: s.subNaics,
          primeUei: s.primeUei,
          primeRecipientName: s.primeRecipientName,
        })),
        openPostings,
        totals: {
          recentSubawards: recentSubawards.length,
          openPostings: openPostings.length,
        },
      },
    })
  } catch (err) {
    logger.error('Failed to load subs for agency', {
      agencyCode: req.params.agencyCode,
      error: (err as Error).message,
    })
    next(err)
  }
})

// =============================================================
// GET /api/agency/:agencyCode/profile?windowYears=3
// GB-105 Agency View v2 — analytical drill-down profile.
// Returns four SQL-aggregated datasets for the agency over a
// rolling fiscal-year window (data-relative: the window ends at the
// latest fiscalYear present for the agency, so historical datasets
// still populate):
//   1. spendActivity      — obligated $ + award count, with per-FY trend
//   2. topClassifications — top NAICS and top PSC (consumes GB-102 pscCode)
//   3. setAsideUtilization— award $ + share by set-aside type
//   4. recurringPatterns  — NAICS recurring across >=2 fiscal years
//
// All datasets read winners_award_stage (platform-wide USAspending,
// no tenant filter) but the route still requires auth + tenant scope.
// Each dataset is a single GROUP BY; total query count is constant
// regardless of row volume (no N+1). Cached 15 min per agency+window.
// The 5th baseline dimension (drill-down to opportunities) is served
// by the existing GET /api/opportunities filters via frontend nav.
// =============================================================
router.get('/:agencyCode/profile', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const agencyCode = req.params.agencyCode

    // Window: 1..10 fiscal years, default 3. Clamped so a URL typo can't
    // produce a pathological scan.
    const reqWindow = Number(req.query.windowYears ?? 3)
    const windowYears = Number.isFinite(reqWindow)
      ? Math.max(1, Math.min(10, Math.trunc(reqWindow)))
      : 3

    const cacheKey = `${agencyCode}:${windowYears}`
    const cached = agencyProfileCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return res.json({ success: true, data: cached.value })
    }

    // Resolve the window relative to the latest FY present for the agency.
    type MaxFyRow = { maxFy: number | null; agencyName: string | null }
    const maxFyRows = await prisma.$queryRaw<MaxFyRow[]>`
      SELECT MAX("fiscalYear") as "maxFy", MAX("agencyToptierName") as "agencyName"
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
    `
    const maxFy = maxFyRows[0]?.maxFy ?? null
    const agencyName = maxFyRows[0]?.agencyName ?? null

    if (maxFy === null) {
      // No award history for this agency — return a well-formed empty profile.
      const empty: AgencyProfile = {
        agencyCode,
        agencyName,
        window: { windowYears, fyStart: null, fyEnd: null },
        spendActivity: { totalDollars: 0, totalAwards: 0, byFiscalYear: [] },
        topClassifications: { topNaics: [], topPsc: [] },
        setAsideUtilization: [],
        recurringPatterns: [],
      }
      agencyProfileCache.set(cacheKey, { value: empty, expiresAt: Date.now() + AGENCY_PROFILE_TTL_MS })
      return res.json({ success: true, data: empty })
    }

    const fyStart = maxFy - (windowYears - 1)
    const fyEnd = maxFy

    // ---- 1. Spend + activity, broken out by fiscal year ----
    type FyRow = { fiscalYear: number; dollars: bigint | string | number | null; awards: bigint | number }
    const fyRows = await prisma.$queryRaw<FyRow[]>`
      SELECT
        "fiscalYear",
        SUM("totalObligation") as dollars,
        COUNT(*) as awards
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
        AND "fiscalYear" BETWEEN ${fyStart} AND ${fyEnd}
      GROUP BY "fiscalYear"
      ORDER BY "fiscalYear"
    `
    const byFiscalYear = fyRows.map((r) => ({
      fiscalYear: Number(r.fiscalYear),
      dollars: Number(r.dollars ?? 0),
      awards: Number(r.awards ?? 0),
    }))
    const totalDollars = byFiscalYear.reduce((s, r) => s + r.dollars, 0)
    const totalAwards = byFiscalYear.reduce((s, r) => s + r.awards, 0)

    // Denominator for dollar-share figures. Guard divide-by-zero.
    const shareDenom = totalDollars > 0 ? totalDollars : 1

    // ---- 2a. Top NAICS ----
    type ClassRow = { code: string; cnt: bigint | number; dollars: bigint | string | number | null }
    const naicsRows = await prisma.$queryRaw<ClassRow[]>`
      SELECT naics as code, COUNT(*) as cnt, SUM("totalObligation") as dollars
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
        AND "fiscalYear" BETWEEN ${fyStart} AND ${fyEnd}
        -- Shape guard, not just NOT NULL: legacy ingest wrote garbage like
        -- the literal '[object Object]' which then topped this aggregation.
        AND naics ~ '^[0-9]{2,6}$'
      GROUP BY naics
      ORDER BY SUM("totalObligation") DESC NULLS LAST
      LIMIT 10
    `

    // ---- 2b. Top PSC (validates GB-102 pscCode end to end) ----
    const pscRows = await prisma.$queryRaw<ClassRow[]>`
      SELECT "pscCode" as code, COUNT(*) as cnt, SUM("totalObligation") as dollars
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
        AND "fiscalYear" BETWEEN ${fyStart} AND ${fyEnd}
        AND "pscCode" ~ '^[A-Za-z0-9]{1,6}$'
      GROUP BY "pscCode"
      ORDER BY SUM("totalObligation") DESC NULLS LAST
      LIMIT 10
    `
    const toClassification = (r: ClassRow) => {
      const dollars = Number(r.dollars ?? 0)
      return {
        code: r.code,
        count: Number(r.cnt ?? 0),
        dollars,
        dollarShare: dollars / shareDenom,
      }
    }

    // ---- 3. Set-aside utilization ----
    type SetAsideRow = { setAside: string; cnt: bigint | number; dollars: bigint | string | number | null }
    const setAsideRows = await prisma.$queryRaw<SetAsideRow[]>`
      SELECT
        COALESCE(NULLIF("setAsideType", ''), 'NONE') as "setAside",
        COUNT(*) as cnt,
        SUM("totalObligation") as dollars
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
        AND "fiscalYear" BETWEEN ${fyStart} AND ${fyEnd}
      GROUP BY 1
      ORDER BY SUM("totalObligation") DESC NULLS LAST
    `
    const setAsideUtilization = setAsideRows.map((r) => {
      const dollars = Number(r.dollars ?? 0)
      return {
        setAsideType: r.setAside,
        count: Number(r.cnt ?? 0),
        dollars,
        dollarShare: dollars / shareDenom,
      }
    })

    // ---- 4. Recurring NAICS (appears in >=2 distinct fiscal years) ----
    type RecurringRow = {
      naics: string
      years: bigint | number
      awards: bigint | number
      dollars: bigint | string | number | null
      hasRecompete: boolean | null
    }
    const recurringRows = await prisma.$queryRaw<RecurringRow[]>`
      SELECT
        naics,
        COUNT(DISTINCT "fiscalYear") as years,
        COUNT(*) as awards,
        SUM("totalObligation") as dollars,
        BOOL_OR("isRecompete") as "hasRecompete"
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
        AND "fiscalYear" BETWEEN ${fyStart} AND ${fyEnd}
        AND naics ~ '^[0-9]{2,6}$'
      GROUP BY naics
      HAVING COUNT(DISTINCT "fiscalYear") >= 2
      ORDER BY COUNT(DISTINCT "fiscalYear") DESC, SUM("totalObligation") DESC NULLS LAST
      LIMIT 15
    `
    const recurringPatterns = recurringRows.map((r) => ({
      naics: r.naics,
      yearsActive: Number(r.years ?? 0),
      awards: Number(r.awards ?? 0),
      dollars: Number(r.dollars ?? 0),
      hasRecompete: Boolean(r.hasRecompete),
    }))

    const profile: AgencyProfile = {
      agencyCode,
      agencyName,
      window: { windowYears, fyStart, fyEnd },
      spendActivity: { totalDollars, totalAwards, byFiscalYear },
      topClassifications: {
        topNaics: naicsRows.map(toClassification),
        topPsc: pscRows.map(toClassification),
      },
      setAsideUtilization,
      recurringPatterns,
    }

    agencyProfileCache.set(cacheKey, { value: profile, expiresAt: Date.now() + AGENCY_PROFILE_TTL_MS })
    res.json({ success: true, data: profile })
  } catch (err) {
    logger.error('Failed to load agency profile', {
      agencyCode: req.params.agencyCode,
      error: (err as Error).message,
    })
    next(err)
  }
})

// =============================================================
// GET /api/agency/:agencyCode/primes/:uei
// Drill-down: prime's history at this agency.
// =============================================================
router.get('/:agencyCode/primes/:uei', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const agencyCode = req.params.agencyCode
    const uei = req.params.uei

    // Top NAICS for this prime at this agency.
    type NaicsRow = {
      naics: string
      awardCount: bigint | number
      dollars: bigint | string | number
    }
    const topNaicsRows = await prisma.$queryRaw<NaicsRow[]>`
      SELECT
        naics,
        COUNT(*) as "awardCount",
        SUM("totalObligation") as dollars
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
        AND "recipientUei" = ${uei}
        AND naics ~ '^[0-9]{2,6}$'
      GROUP BY naics
      ORDER BY SUM("totalObligation") DESC NULLS LAST
      LIMIT 10
    `

    // Sub partners aggregated by sub-recipient UEI.
    type SubPartnerRow = {
      subRecipientUei: string | null
      subRecipientName: string | null
      subRecipientSize: string | null
      subAwardCount: bigint | number
      totalSubAmount: bigint | string | number | null
    }
    const subPartners = await prisma.$queryRaw<SubPartnerRow[]>`
      SELECT
        sub."subRecipientUei",
        MAX(sub."subRecipientName") as "subRecipientName",
        MAX(sub."subRecipientSize") as "subRecipientSize",
        COUNT(*) as "subAwardCount",
        SUM(sub."subAmount") as "totalSubAmount"
      FROM winners_subaward_stage sub
      JOIN winners_award_stage prime
        ON prime."usaspendingAwardId" = sub."primeAwardId"
      WHERE prime."agencyToptierCode" = ${agencyCode}
        AND prime."recipientUei" = ${uei}
        AND sub."subRecipientUei" IS NOT NULL
      GROUP BY sub."subRecipientUei"
      ORDER BY SUM(sub."subAmount") DESC NULLS LAST
      LIMIT 20
    `

    // Prime header line — name + total + small-biz sub %
    type PrimeHeader = {
      recipientName: string | null
      totalDollars: bigint | string | number
      awardCount: bigint | number
      totalSubAmount: bigint | string | number | null
      smallBizSubAmount: bigint | string | number | null
    }
    const headerRows = await prisma.$queryRaw<PrimeHeader[]>`
      WITH prime_agg AS (
        SELECT
          MAX("recipientName") as "recipientName",
          SUM("totalObligation") as "totalDollars",
          COUNT(*) as "awardCount"
        FROM winners_award_stage
        WHERE "agencyToptierCode" = ${agencyCode}
          AND "recipientUei" = ${uei}
      ),
      sub_agg AS (
        SELECT
          SUM(sub."subAmount") as "totalSubAmount",
          SUM(CASE WHEN sub."subRecipientSize" = 'small'
                   THEN sub."subAmount" ELSE 0 END) as "smallBizSubAmount"
        FROM winners_subaward_stage sub
        JOIN winners_award_stage prime
          ON prime."usaspendingAwardId" = sub."primeAwardId"
        WHERE prime."agencyToptierCode" = ${agencyCode}
          AND prime."recipientUei" = ${uei}
      )
      SELECT * FROM prime_agg, sub_agg
    `

    const header = headerRows[0]
    if (!header) {
      return res.status(404).json({
        success: false,
        error: 'Prime not found at this agency.',
        code: 'NOT_FOUND',
      })
    }
    const totalDollars = Number(header.totalDollars ?? 0)
    const totalSub = Number(header.totalSubAmount ?? 0)
    const smallBizSub = Number(header.smallBizSubAmount ?? 0)

    res.json({
      success: true,
      data: {
        uei,
        recipientName: header.recipientName,
        totalDollars,
        awardCount: Number(header.awardCount ?? 0),
        totalSubAmount: totalSub,
        subSpendRatio: totalDollars > 0 ? totalSub / totalDollars : 0,
        smallBizSubSpendRate: totalSub > 0 ? smallBizSub / totalSub : 0,
        topNaics: topNaicsRows.map((n) => ({
          naics: n.naics,
          awardCount: Number(n.awardCount ?? 0),
          dollars: Number(n.dollars ?? 0),
        })),
        subPartners: subPartners.map((s) => ({
          uei: s.subRecipientUei,
          name: s.subRecipientName,
          size: s.subRecipientSize,
          subAwardCount: Number(s.subAwardCount ?? 0),
          totalSubAmount: Number(s.totalSubAmount ?? 0),
        })),
      },
    })
  } catch (err) {
    logger.error('Failed to load prime drill-down', {
      agencyCode: req.params.agencyCode,
      uei: req.params.uei,
      error: (err as Error).message,
    })
    next(err)
  }
})

// =============================================================
// GET /api/agency/:agencyCode/primes/:uei/fit?clientId=...
// Teaming-fit score for (client × prime × agency). Tenant-scoped:
// the clientId must belong to the JWT's firm.
// =============================================================
router.get('/:agencyCode/primes/:uei/fit', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { agencyCode, uei } = req.params
    const clientId = (req.query.clientId as string | undefined) ?? ''
    if (!clientId) {
      return res.status(400).json({
        success: false,
        error: 'clientId query param is required.',
        code: 'MISSING_CLIENT_ID',
      })
    }

    // Tenant ownership check — refuse to score a client the firm doesn't own.
    const client = await prisma.clientCompany.findFirst({
      where: { id: clientId, consultingFirmId },
      select: { id: true },
    })
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found for this firm.',
        code: 'CLIENT_NOT_FOUND',
      })
    }

    const fit = await computeTeamingFit({ clientId, primeUei: uei, agencyCode })
    res.json({ success: true, data: fit })
  } catch (err) {
    next(err)
  }
})

// =============================================================
// POST /api/agency/draft-outreach
// Generates an LLM-drafted intro email from a client to a prime.
// Costs 1 proposal token. Returns 402 if the firm is short.
// Body: { clientId, primeUei, agencyCode }
// =============================================================
router.post('/draft-outreach', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const actorUserId = req.user?.userId ?? null
    const { clientId, primeUei, agencyCode } = (req.body || {}) as {
      clientId?: string
      primeUei?: string
      agencyCode?: string
    }
    if (!clientId || !primeUei || !agencyCode) {
      return res.status(400).json({
        success: false,
        error: 'clientId, primeUei, and agencyCode are required.',
        code: 'VALIDATION_ERROR',
      })
    }

    // Tenant ownership check (also enforced inside the service, but checking
    // here lets us 404 fast without a doomed LLM call setup).
    const client = await prisma.clientCompany.findFirst({
      where: { id: clientId, consultingFirmId },
      select: { id: true },
    })
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found for this firm.',
        code: 'CLIENT_NOT_FOUND',
      })
    }

    // Token gate. 1 token per outreach draft.
    const TOKEN_COST = 1
    const tokenCheck = await checkProposalTokens(consultingFirmId, TOKEN_COST)
    if (!tokenCheck.allowed) {
      return res.status(402).json({
        success: false,
        error: `Insufficient proposal tokens. Required: ${TOKEN_COST}, available: ${tokenCheck.balance}.`,
        code: 'INSUFFICIENT_TOKENS',
        data: { balance: tokenCheck.balance, required: TOKEN_COST },
      })
    }

    try {
      const result = await draftTeamingOutreach({
        consultingFirmId,
        clientId,
        primeUei,
        agencyCode,
        actorUserId,
      })

      // Auto-track on saved relationships only — drafting is exploratory
      // and shouldn't auto-pollute the saved list. Always bump
      // lastOutreachAt; only advance the status field FROM IDENTIFIED so
      // we don't walk a relationship backward from CONVERSATION/MOU.
      // Fire-and-forget — a tracking failure shouldn't fail the draft.
      void Promise.all([
        prisma.teamingRelationship.updateMany({
          where: { consultingFirmId, clientCompanyId: clientId, primeUei, agencyCode },
          data: { lastOutreachAt: new Date() },
        }),
        prisma.teamingRelationship.updateMany({
          where: {
            consultingFirmId, clientCompanyId: clientId, primeUei, agencyCode,
            status: 'IDENTIFIED',
          },
          data: { status: 'CONTACTED' },
        }),
      ]).catch((err) => logger.warn('Failed to bump teaming relationship after draft', {
        error: (err as Error).message,
      }))

      res.json({ success: true, data: result })
    } catch (err) {
      const msg = (err as Error).message
      if (msg === 'NO_LLM_KEY') {
        return res.status(503).json({
          success: false,
          error: 'LLM provider not configured for this firm.',
          code: 'NO_LLM_KEY',
        })
      }
      if (msg === 'RATE_LIMITED') {
        return res.status(429).json({
          success: false,
          error: 'LLM provider is rate-limited. Try again shortly.',
          code: 'RATE_LIMITED',
        })
      }
      if (msg === 'EMPTY_LLM_OUTPUT') {
        return res.status(502).json({
          success: false,
          error: 'The LLM returned no usable output. No token was charged.',
          code: 'EMPTY_LLM_OUTPUT',
        })
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// =============================================================
// GET /api/agency/relationships
// List the firm's saved teaming relationships, optionally filtered
// by ?status= or ?clientId=. Default sort: newest first.
// =============================================================
router.get('/relationships', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const status = req.query.status as string | undefined
    const clientId = req.query.clientId as string | undefined

    const where: Record<string, unknown> = { consultingFirmId }
    if (status) where.status = status
    if (clientId) where.clientCompanyId = clientId

    const rows = await prisma.teamingRelationship.findMany({
      where,
      include: {
        clientCompany: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    })

    res.json({ success: true, data: rows })
  } catch (err) {
    logger.error('Failed to list teaming relationships', {
      error: (err as Error).message,
    })
    next(err)
  }
})

// =============================================================
// POST /api/agency/relationships
// Create a new saved relationship. Idempotent via the unique
// (firm, client, prime, agency) constraint — re-saving updates notes.
// =============================================================
router.post('/relationships', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const actorUserId = req.user?.userId ?? null
    const { clientId, primeUei, agencyCode, fitScoreAtSave, notes } = (req.body || {}) as {
      clientId?: string
      primeUei?: string
      agencyCode?: string
      fitScoreAtSave?: number
      notes?: string
    }
    if (!clientId || !primeUei || !agencyCode) {
      return res.status(400).json({
        success: false,
        error: 'clientId, primeUei, and agencyCode are required.',
        code: 'VALIDATION_ERROR',
      })
    }

    // Tenant ownership check + name resolution.
    const [client, primeMeta] = await Promise.all([
      prisma.clientCompany.findFirst({
        where: { id: clientId, consultingFirmId },
        select: { id: true },
      }),
      prisma.winnersAwardStage.findFirst({
        where: { recipientUei: primeUei, agencyToptierCode: agencyCode },
        select: { recipientName: true, agencyToptierName: true },
      }),
    ])
    if (!client) {
      return res.status(404).json({
        success: false,
        error: 'Client not found for this firm.',
        code: 'CLIENT_NOT_FOUND',
      })
    }

    const row = await prisma.teamingRelationship.upsert({
      where: {
        consultingFirmId_clientCompanyId_primeUei_agencyCode: {
          consultingFirmId,
          clientCompanyId: clientId,
          primeUei,
          agencyCode,
        },
      },
      create: {
        consultingFirmId,
        clientCompanyId: clientId,
        primeUei,
        primeName: primeMeta?.recipientName ?? null,
        agencyCode,
        agencyName: primeMeta?.agencyToptierName ?? null,
        fitScoreAtSave: typeof fitScoreAtSave === 'number' ? fitScoreAtSave : null,
        notes: notes ?? null,
        createdBy: actorUserId,
      },
      update: {
        notes: notes ?? undefined,
        fitScoreAtSave: typeof fitScoreAtSave === 'number' ? fitScoreAtSave : undefined,
      },
    })

    res.json({ success: true, data: row })
  } catch (err) {
    logger.error('Failed to save teaming relationship', { error: (err as Error).message })
    next(err)
  }
})

// =============================================================
// PATCH /api/agency/relationships/:id
// Update status or notes. Body: { status?, notes? }.
// =============================================================
router.patch('/relationships/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { status, notes } = (req.body || {}) as { status?: string; notes?: string }

    const ALLOWED_STATUS = new Set(['IDENTIFIED', 'CONTACTED', 'CONVERSATION', 'MOU', 'TEAMED', 'DECLINED'])
    if (status && !ALLOWED_STATUS.has(status)) {
      return res.status(400).json({
        success: false,
        error: `Invalid status. Allowed: ${Array.from(ALLOWED_STATUS).join(', ')}.`,
        code: 'VALIDATION_ERROR',
      })
    }

    // Ownership check (avoid leaking cross-firm rows via id-guess).
    const existing = await prisma.teamingRelationship.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true },
    })
    if (!existing) {
      return res.status(404).json({
        success: false,
        error: 'Relationship not found.',
        code: 'NOT_FOUND',
      })
    }

    const updated = await prisma.teamingRelationship.update({
      where: { id: req.params.id },
      data: {
        ...(status ? { status: status as 'IDENTIFIED' | 'CONTACTED' | 'CONVERSATION' | 'MOU' | 'TEAMED' | 'DECLINED' } : {}),
        ...(notes !== undefined ? { notes } : {}),
      },
    })

    res.json({ success: true, data: updated })
  } catch (err) {
    logger.error('Failed to update teaming relationship', {
      id: req.params.id,
      error: (err as Error).message,
    })
    next(err)
  }
})

// =============================================================
// DELETE /api/agency/relationships/:id
// Hard delete. We don't keep these for audit purposes — operators
// hide-then-restore via DECLINED status if they want to keep history.
// =============================================================
router.delete('/relationships/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const result = await prisma.teamingRelationship.deleteMany({
      where: { id: req.params.id, consultingFirmId },
    })
    if (result.count === 0) {
      return res.status(404).json({
        success: false,
        error: 'Relationship not found.',
        code: 'NOT_FOUND',
      })
    }
    res.json({ success: true, data: { deleted: true } })
  } catch (err) {
    logger.error('Failed to delete teaming relationship', {
      id: req.params.id,
      error: (err as Error).message,
    })
    next(err)
  }
})

// ---------- helpers ----------

/**
 * Loose agency-name match: returns true if either string contains a
 * meaningful token from the other after stripping common stop words
 * (department, of, the, etc.). Imperfect; intended only for relevance
 * ranking, not for authoritative joins.
 */
function fuzzyAgencyMatch(a: string, b: string): boolean {
  const norm = (s: string) => s
    .toLowerCase()
    .replace(/[(),.]/g, ' ')
    .replace(/\bdepartment\s+of\s+(the\s+)?\b/g, '')
    .replace(/\bof\s+the\b/g, '')
    .trim()
  const an = norm(a)
  const bn = norm(b)
  if (!an || !bn) return false
  return an.includes(bn) || bn.includes(an)
}

logger.info('Agency routes mounted')

export default router
