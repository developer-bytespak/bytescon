// =============================================================
// Winners Intel — distillation
//
// Reads raw rows from WinnersAwardStage and produces statistical
// slices (per-agency, per-NAICS) that are cheap to render to markdown.
// Pure functions — no I/O, no MD generation. The render layer takes
// these structures and turns them into the slice files.
//
// Why distill at all (instead of letting render query the DB directly):
//   - Rendering should be deterministic and unit-testable in isolation
//   - The same slice can feed multiple consumers (MD slice for LLM,
//     JSON-API slice for a future admin dashboard)
//   - Aggregations are cheaper to compute once per refresh than per slice
// =============================================================

import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'

// Cap how many slices we generate per refresh to keep MD storage + token
// budget bounded. Rationale matches spec §5.2 step 4.
const MIN_AWARDS_FOR_NAICS_SLICE = 50
const TOP_AGENCY_LIMIT = 30
const TOP_NAICS_LIMIT = 400
const TOP_RECIPIENT_LIMIT = 10
const TOP_OFFICE_LIMIT = 10
const TOP_STATE_LIMIT = 5

export interface ContractValueDistribution {
  p10: number
  p25: number
  p50: number
  p75: number
  p90: number
  p99: number
}

export interface CompetitionProfile {
  fullAndOpenPct: number
  soleSourcePct: number
  oneBidPct: number
  avgOffersReceived: number | null
}

export interface RecipientSummary {
  uei: string | null
  name: string
  awardCount: number
  totalObligation: number
}

export interface OfficeSummary {
  code: string
  awardCount: number
  totalObligation: number
}

export interface StateSummary {
  state: string
  pct: number
}

export interface PrimeWinnerSlice {
  /** Stable identifier used as filename: "agency:9700" → by-department/9700.md */
  sliceKey: string
  /** Human-friendly type tag for downstream consumers */
  sliceKind: 'global' | 'agency' | 'naics'
  agencyToptierCode?: string
  agencyToptierName?: string
  naics?: string
  windowStart: string
  windowEnd: string
  awardCount: number
  totalObligation: number
  contractValueDistribution: ContractValueDistribution
  competitionProfile: CompetitionProfile
  setAsideUtilization: Record<string, number>  // setAsideType → pct of obligation
  topAwardingOffices: OfficeSummary[]
  topRecipients: RecipientSummary[]
  geographyPattern: { topPlaceOfPerformanceStates: StateSummary[] }
  pricingPatterns: {
    avgBaseToTotalRatio: number | null
    avgPopMonths: number | null
  }
  refreshBatchId: string
  generatedAt: string
}

export interface DistillationOutput {
  global: PrimeWinnerSlice
  byAgency: PrimeWinnerSlice[]
  byNaics: PrimeWinnerSlice[]
  windowStart: string
  windowEnd: string
}

interface RawAwardRow {
  agencyToptierCode: string | null
  agencyToptierName: string | null
  awardingOfficeCode: string | null
  naics: string | null
  setAsideType: string | null
  competitionExtent: string | null
  numberOfOffersReceived: number | null
  totalObligation: { toNumber(): number } | null  // Prisma Decimal
  baseExercisedOptions: { toNumber(): number } | null
  baseAndAllOptions: { toNumber(): number } | null
  periodOfPerformanceStart: Date | null
  periodOfPerformanceEnd: Date | null
  awardDate: Date | null
  placeOfPerformanceState: string | null
  recipientUei: string | null
  recipientName: string | null
}

export interface DistillOptions {
  /**
   * Explicit pull-window dates. When provided, overrides the min/max
   * observed in the row data. The data-derived window can extend decades
   * back when long-running IDV contracts surface old base-obligation
   * dates; the operator-meaningful window is what was actually requested.
   */
  windowStart?: string
  windowEnd?: string
}

/**
 * Compute slices from the latest refresh batch in WinnersAwardStage.
 * Streams via cursor pagination so memory stays bounded even for batches
 * with millions of rows.
 */
export async function distillFromBatch(
  refreshBatchId: string,
  opts: DistillOptions = {},
): Promise<DistillationOutput> {
  const startMs = Date.now()
  logger.info('Winners intel distillation started', { refreshBatchId })

  // Aggregator state, populated by streaming over rows. Each entry is a
  // rolling stat record we close out at the end.
  const globalAgg = newAggregator()
  const byAgency = new Map<string, AgencyAccumulator>()
  const byNaics = new Map<string, NaicsAccumulator>()

  let cursor: string | undefined
  let totalScanned = 0
  const PAGE = 1000

  while (true) {
    const rows = await prisma.winnersAwardStage.findMany({
      where: { refreshBatchId },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        agencyToptierCode: true,
        agencyToptierName: true,
        awardingOfficeCode: true,
        naics: true,
        setAsideType: true,
        competitionExtent: true,
        numberOfOffersReceived: true,
        totalObligation: true,
        baseExercisedOptions: true,
        baseAndAllOptions: true,
        periodOfPerformanceStart: true,
        periodOfPerformanceEnd: true,
        awardDate: true,
        placeOfPerformanceState: true,
        recipientUei: true,
        recipientName: true,
      },
    })
    if (rows.length === 0) break

    for (const r of rows as Array<RawAwardRow & { id: string }>) {
      totalScanned++
      ingest(globalAgg, r)

      if (r.agencyToptierCode) {
        const key = r.agencyToptierCode
        let acc = byAgency.get(key)
        if (!acc) {
          acc = { ...newAggregator(), agencyToptierCode: key, agencyToptierName: r.agencyToptierName ?? null }
          byAgency.set(key, acc)
        }
        ingest(acc, r)
      }

      // Digit-shape check, not just length: legacy rows carried garbage like
      // the literal "[object Object]" (length 15), which passed a length gate
      // and produced a bogus by-naics slice.
      if (r.naics && /^\d{4,6}$/.test(r.naics)) {
        const key = r.naics
        let acc = byNaics.get(key)
        if (!acc) {
          acc = { ...newAggregator(), naics: key }
          byNaics.set(key, acc)
        }
        ingest(acc, r)
      }
    }

    cursor = rows[rows.length - 1].id
    if (rows.length < PAGE) break
  }

  // Prefer the operator-supplied pull window (the dates we actually told
  // USAspending to filter by). Fall back to the data-derived range only
  // when the caller didn't supply one — useful for ad-hoc distill runs.
  const windowStart = opts.windowStart
    ?? (globalAgg.minAwardDate ?? new Date()).toISOString().slice(0, 10)
  const windowEnd = opts.windowEnd
    ?? (globalAgg.maxAwardDate ?? new Date()).toISOString().slice(0, 10)

  const generatedAt = new Date().toISOString()
  const global = closeAggregator(globalAgg, {
    sliceKey: 'global',
    sliceKind: 'global',
    windowStart,
    windowEnd,
    refreshBatchId,
    generatedAt,
  })

  const byAgencyArr = Array.from(byAgency.values())
    .sort((a, b) => b.totalObligationCents - a.totalObligationCents)
    .slice(0, TOP_AGENCY_LIMIT)
    .map((acc) => closeAggregator(acc, {
      sliceKey: `agency:${acc.agencyToptierCode}`,
      sliceKind: 'agency',
      agencyToptierCode: acc.agencyToptierCode ?? undefined,
      agencyToptierName: acc.agencyToptierName ?? undefined,
      windowStart, windowEnd, refreshBatchId, generatedAt,
    }))

  const byNaicsArr = Array.from(byNaics.values())
    .filter((acc) => acc.awardCount >= MIN_AWARDS_FOR_NAICS_SLICE)
    .sort((a, b) => b.totalObligationCents - a.totalObligationCents)
    .slice(0, TOP_NAICS_LIMIT)
    .map((acc) => closeAggregator(acc, {
      sliceKey: `naics:${acc.naics}`,
      sliceKind: 'naics',
      naics: acc.naics ?? undefined,
      windowStart, windowEnd, refreshBatchId, generatedAt,
    }))

  logger.info('Winners intel distillation complete', {
    refreshBatchId,
    rowsScanned: totalScanned,
    agencySlices: byAgencyArr.length,
    naicsSlices: byNaicsArr.length,
    durationMs: Date.now() - startMs,
  })

  return { global, byAgency: byAgencyArr, byNaics: byNaicsArr, windowStart, windowEnd }
}

// ---------- internals: rolling aggregator ----------

interface BaseAccumulator {
  awardCount: number
  totalObligationCents: number  // store as cents to avoid float drift
  obligations: number[]          // for percentile computation
  // Competition counts
  fullAndOpenCount: number
  soleSourceCount: number
  oneBidCount: number
  offersReceivedSum: number
  offersReceivedCount: number
  // Set-asides: setAsideType → totalObligationCents
  setAsideObligation: Map<string, number>
  // Top recipients: uei|name → { count, obligationCents }
  recipientStats: Map<string, { name: string; uei: string | null; awardCount: number; obligationCents: number }>
  // Top offices
  officeStats: Map<string, { awardCount: number; obligationCents: number }>
  // Place of performance state counts
  popStateCount: Map<string, number>
  // Date bounds
  minAwardDate: Date | null
  maxAwardDate: Date | null
  // Pricing/POP
  baseToTotalRatios: number[]
  popMonths: number[]
}

interface AgencyAccumulator extends BaseAccumulator {
  agencyToptierCode: string | null
  agencyToptierName: string | null
}

interface NaicsAccumulator extends BaseAccumulator {
  naics: string | null
}

function newAggregator(): BaseAccumulator {
  return {
    awardCount: 0,
    totalObligationCents: 0,
    obligations: [],
    fullAndOpenCount: 0,
    soleSourceCount: 0,
    oneBidCount: 0,
    offersReceivedSum: 0,
    offersReceivedCount: 0,
    setAsideObligation: new Map(),
    recipientStats: new Map(),
    officeStats: new Map(),
    popStateCount: new Map(),
    minAwardDate: null,
    maxAwardDate: null,
    baseToTotalRatios: [],
    popMonths: [],
  }
}

function ingest(acc: BaseAccumulator, r: RawAwardRow): void {
  const obligation = r.totalObligation ? r.totalObligation.toNumber() : 0
  acc.awardCount++
  acc.totalObligationCents += Math.round(obligation * 100)
  if (obligation > 0) acc.obligations.push(obligation)

  const competition = (r.competitionExtent ?? '').toUpperCase()
  if (competition.includes('FULL')) acc.fullAndOpenCount++
  if (competition.includes('NOT COMPETED') || competition.includes('SOLE SOURCE')) acc.soleSourceCount++
  if (r.numberOfOffersReceived === 1) acc.oneBidCount++

  if (r.numberOfOffersReceived !== null && r.numberOfOffersReceived !== undefined) {
    acc.offersReceivedSum += r.numberOfOffersReceived
    acc.offersReceivedCount++
  }

  const setAside = r.setAsideType?.trim() || 'OPEN'
  acc.setAsideObligation.set(setAside, (acc.setAsideObligation.get(setAside) ?? 0) + Math.round(obligation * 100))

  // Recipient: prefer UEI as dedup key, fall back to name. Skip rows with no name.
  const recipientName = r.recipientName?.trim() || null
  if (recipientName) {
    const recipKey = r.recipientUei || `name:${recipientName.toLowerCase()}`
    let entry = acc.recipientStats.get(recipKey)
    if (!entry) {
      entry = { name: recipientName, uei: r.recipientUei, awardCount: 0, obligationCents: 0 }
      acc.recipientStats.set(recipKey, entry)
    }
    entry.awardCount++
    entry.obligationCents += Math.round(obligation * 100)
  }

  if (r.awardingOfficeCode) {
    const office = acc.officeStats.get(r.awardingOfficeCode) ?? { awardCount: 0, obligationCents: 0 }
    office.awardCount++
    office.obligationCents += Math.round(obligation * 100)
    acc.officeStats.set(r.awardingOfficeCode, office)
  }

  if (r.placeOfPerformanceState) {
    acc.popStateCount.set(r.placeOfPerformanceState, (acc.popStateCount.get(r.placeOfPerformanceState) ?? 0) + 1)
  }

  if (r.awardDate) {
    if (!acc.minAwardDate || r.awardDate < acc.minAwardDate) acc.minAwardDate = r.awardDate
    if (!acc.maxAwardDate || r.awardDate > acc.maxAwardDate) acc.maxAwardDate = r.awardDate
  }

  // Pricing patterns — only when both values are present and total is non-zero.
  const base = r.baseExercisedOptions?.toNumber()
  const total = r.baseAndAllOptions?.toNumber()
  if (base !== undefined && total !== undefined && total > 0) {
    acc.baseToTotalRatios.push(base / total)
  }

  if (r.periodOfPerformanceStart && r.periodOfPerformanceEnd) {
    const months = (r.periodOfPerformanceEnd.getTime() - r.periodOfPerformanceStart.getTime()) / (1000 * 60 * 60 * 24 * 30.4375)
    if (months > 0 && months < 600) {
      // Filter implausible POPs (>50yr) — usually data quality artifacts.
      acc.popMonths.push(months)
    }
  }
}

interface CloseContext {
  sliceKey: string
  sliceKind: 'global' | 'agency' | 'naics'
  agencyToptierCode?: string
  agencyToptierName?: string
  naics?: string
  windowStart: string
  windowEnd: string
  refreshBatchId: string
  generatedAt: string
}

function closeAggregator(acc: BaseAccumulator, ctx: CloseContext): PrimeWinnerSlice {
  const totalObligation = acc.totalObligationCents / 100
  const distribution = computePercentiles(acc.obligations)

  const competitionProfile: CompetitionProfile = {
    fullAndOpenPct: acc.awardCount ? (acc.fullAndOpenCount / acc.awardCount) * 100 : 0,
    soleSourcePct: acc.awardCount ? (acc.soleSourceCount / acc.awardCount) * 100 : 0,
    oneBidPct: acc.awardCount ? (acc.oneBidCount / acc.awardCount) * 100 : 0,
    avgOffersReceived: acc.offersReceivedCount ? acc.offersReceivedSum / acc.offersReceivedCount : null,
  }

  const setAsideUtilization: Record<string, number> = {}
  for (const [setAside, oblCents] of acc.setAsideObligation) {
    setAsideUtilization[setAside] = acc.totalObligationCents
      ? (oblCents / acc.totalObligationCents) * 100
      : 0
  }

  const topRecipients: RecipientSummary[] = Array.from(acc.recipientStats.values())
    .sort((a, b) => b.obligationCents - a.obligationCents)
    .slice(0, TOP_RECIPIENT_LIMIT)
    .map((r) => ({
      uei: r.uei,
      name: r.name,
      awardCount: r.awardCount,
      totalObligation: r.obligationCents / 100,
    }))

  const topAwardingOffices: OfficeSummary[] = Array.from(acc.officeStats.entries())
    .sort((a, b) => b[1].obligationCents - a[1].obligationCents)
    .slice(0, TOP_OFFICE_LIMIT)
    .map(([code, stats]) => ({
      code,
      awardCount: stats.awardCount,
      totalObligation: stats.obligationCents / 100,
    }))

  const totalStateCount = Array.from(acc.popStateCount.values()).reduce((a, b) => a + b, 0)
  const topStates: StateSummary[] = Array.from(acc.popStateCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_STATE_LIMIT)
    .map(([state, count]) => ({
      state,
      pct: totalStateCount ? (count / totalStateCount) * 100 : 0,
    }))

  const avgBaseToTotalRatio = acc.baseToTotalRatios.length
    ? acc.baseToTotalRatios.reduce((a, b) => a + b, 0) / acc.baseToTotalRatios.length
    : null

  const avgPopMonths = acc.popMonths.length
    ? acc.popMonths.reduce((a, b) => a + b, 0) / acc.popMonths.length
    : null

  return {
    sliceKey: ctx.sliceKey,
    sliceKind: ctx.sliceKind,
    agencyToptierCode: ctx.agencyToptierCode,
    agencyToptierName: ctx.agencyToptierName,
    naics: ctx.naics,
    windowStart: ctx.windowStart,
    windowEnd: ctx.windowEnd,
    awardCount: acc.awardCount,
    totalObligation,
    contractValueDistribution: distribution,
    competitionProfile,
    setAsideUtilization,
    topAwardingOffices,
    topRecipients,
    geographyPattern: { topPlaceOfPerformanceStates: topStates },
    pricingPatterns: { avgBaseToTotalRatio, avgPopMonths },
    refreshBatchId: ctx.refreshBatchId,
    generatedAt: ctx.generatedAt,
  }
}

function computePercentiles(values: number[]): ContractValueDistribution {
  if (values.length === 0) {
    return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0, p99: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)))
    return sorted[idx]
  }
  return {
    p10: at(10),
    p25: at(25),
    p50: at(50),
    p75: at(75),
    p90: at(90),
    p99: at(99),
  }
}

// Exposed for tests
export const _internals = {
  computePercentiles,
}
