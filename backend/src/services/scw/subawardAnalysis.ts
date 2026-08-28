// =============================================================
// SCW-2 Subaward History Analysis
//
// Per SUBCONTRACTING_WORKFLOW_SPEC.md §3 SCW-2. Given a prime (UEI or
// name), compute their subcontracting pattern + SDVOSB compliance posture
// from winners_subaward_stage.
//
// Data-reality caveats — see docs/scw/data-layer-introspection.md §9:
//   - winners_subaward_stage.subRecipientUei: 0 / 215k rows populated.
//   - winners_subaward_stage.subRecipientSetAsideFlags: all flags=false
//     across every row (USAspending /api/v2/subawards/ does not return
//     them).
//   - winners_subaward_stage.subRecipientSize: 'unknown' on every row.
//   - winners_subaward_stage.subNaics: null on every row.
//
// As a result, smallBusinessPercent / sdvosbPercent / topNaicsSubbed /
// sdvosbGoalGap are NOT computable from the corpus and ship as null with
// explicit warnings per spec §2.5 "no silent failures". The fields that
// ARE computable (total $, average sub size, sample size, set of distinct
// sub recipients) ship as real numbers.
//
// Cached in scw_subaward_analyses with 7-day expiration per spec §6
// Phase 4 step 2.
// =============================================================

import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_LOOKBACK_YEARS = 3

export interface AnalyzeInput {
  /** UEI (preferred) or null when only name is available. */
  primeUei?: string | null
  /** Recipient name as it appears in winners_award_stage. Used as fallback
   * identifier and for the prime → subaward join when UEI is absent. */
  primeName?: string | null
  lookbackYears?: number
}

export interface SubawardAnalysis {
  primeUei: string | null
  primeName: string | null
  lookbackYears: number

  totalSubawardDollars: number | null
  averageSubSize: number | null

  // Fields below ship null in v1 — see R4 in docs/scw/data-layer-
  // introspection.md. dataQuality.warnings explains why.
  smallBusinessSubAwardPercent: number | null
  sdvosbSubAwardPercent: number | null
  topNaicsSubbed: Array<{ naicsCode: string; dollars: number; count: number }> | null

  sdvosbGoalGap: {
    fiscalYear: string
    goalPercent: number | null
    actualPercent: number | null
    gapPercent: number | null
    underPressure: boolean
    source: 'esrs' | 'computed_proxy' | 'unknown'
  }

  dataQuality: {
    sampleSize: number
    warnings: string[]
  }

  /** Cache provenance — useful for UI freshness display. */
  computedAt: Date
  fromCache: boolean
}

export async function analyzeSubawards(input: AnalyzeInput): Promise<SubawardAnalysis> {
  const lookbackYears = input.lookbackYears ?? DEFAULT_LOOKBACK_YEARS
  const primeUei = input.primeUei?.trim() || null
  const primeName = input.primeName?.trim() || null

  if (!primeUei && !primeName) {
    throw new Error('analyzeSubawards requires either primeUei or primeName')
  }

  const primeKey = buildPrimeKey(primeUei, primeName)

  // Cache hit?
  const cached = await prisma.scwSubawardAnalysis.findUnique({
    where: { primeKey_lookbackYears: { primeKey, lookbackYears } },
  })
  if (cached && cached.expiresAt > new Date()) {
    return hydrateCacheRow(cached, true)
  }

  // Compute fresh. Aggregate by recipient identifier (UEI when available,
  // else name) joined back through the prime row that links subawards to
  // their issuing prime contract.
  const lookbackCutoff = new Date()
  lookbackCutoff.setUTCFullYear(lookbackCutoff.getUTCFullYear() - lookbackYears)

  type AggRow = {
    total_sub_dollars: string | null
    total_award_dollars: string | null
    sample_size: bigint
    distinct_subs: bigint
  }

  let rows: AggRow[]
  if (primeUei) {
    rows = await prisma.$queryRaw<AggRow[]>`
      SELECT
        SUM(wss."subAmount")                            AS total_sub_dollars,
        SUM(was."totalObligation")                      AS total_award_dollars,
        COUNT(wss.id)                                   AS sample_size,
        COUNT(DISTINCT wss."subRecipientName")          AS distinct_subs
      FROM winners_award_stage was
      LEFT JOIN winners_subaward_stage wss
        ON wss."primeAwardId" = was."usaspendingAwardId"
      WHERE was."recipientUei" = ${primeUei}
        AND was."awardDate" >= ${lookbackCutoff}
    `
  } else {
    rows = await prisma.$queryRaw<AggRow[]>`
      SELECT
        SUM(wss."subAmount")                            AS total_sub_dollars,
        SUM(was."totalObligation")                      AS total_award_dollars,
        COUNT(wss.id)                                   AS sample_size,
        COUNT(DISTINCT wss."subRecipientName")          AS distinct_subs
      FROM winners_award_stage was
      LEFT JOIN winners_subaward_stage wss
        ON wss."primeAwardId" = was."usaspendingAwardId"
      WHERE was."recipientName" = ${primeName}
        AND was."awardDate" >= ${lookbackCutoff}
    `
  }

  const agg = rows[0] ?? { total_sub_dollars: null, total_award_dollars: null, sample_size: BigInt(0), distinct_subs: BigInt(0) }
  const totalSubawardDollars = agg.total_sub_dollars ? Number(agg.total_sub_dollars) : null
  const sampleSize = Number(agg.sample_size)
  const distinctSubs = Number(agg.distinct_subs)
  const averageSubSize =
    totalSubawardDollars !== null && sampleSize > 0
      ? Math.round((totalSubawardDollars / sampleSize) * 100) / 100
      : null

  // Build warnings list per spec §2.5. Every null field gets a row
  // explaining WHY it's null — the operator must never wonder.
  const warnings: string[] = []
  if (sampleSize === 0) {
    warnings.push('No subaward history available in the corpus for this prime.')
  }
  warnings.push(
    'SDVOSB / small-business / NAICS breakdown unavailable — USAspending /api/v2/subawards/ does not return set-aside flags or NAICS codes. See docs/scw/data-layer-introspection.md §9 (R4).',
  )

  const fiscalYear = currentFiscalYear()
  const sdvosbGoalGap: SubawardAnalysis['sdvosbGoalGap'] = {
    fiscalYear,
    goalPercent: null,
    actualPercent: null,
    gapPercent: null,
    underPressure: false,
    source: 'unknown',
  }

  const analysis: SubawardAnalysis = {
    primeUei,
    primeName,
    lookbackYears,
    totalSubawardDollars,
    averageSubSize,
    smallBusinessSubAwardPercent: null,
    sdvosbSubAwardPercent: null,
    topNaicsSubbed: null,
    sdvosbGoalGap,
    dataQuality: { sampleSize, warnings },
    computedAt: new Date(),
    fromCache: false,
  }

  // Persist cache row.
  await prisma.scwSubawardAnalysis.upsert({
    where: { primeKey_lookbackYears: { primeKey, lookbackYears } },
    create: {
      primeKey,
      primeUei,
      primeName,
      lookbackYears,
      totalSubawardDollars:
        totalSubawardDollars !== null ? new Prisma.Decimal(totalSubawardDollars) : null,
      averageSubSize:
        averageSubSize !== null ? new Prisma.Decimal(averageSubSize) : null,
      sampleSize,
      smallBusinessPercent: null,
      sdvosbPercent: null,
      topNaicsSubbed: null as unknown as Prisma.InputJsonValue,
      sdvosbGoalGap: { ...sdvosbGoalGap } as Prisma.InputJsonValue,
      dataQuality: { sampleSize, warnings } as unknown as Prisma.InputJsonValue,
      computedAt: analysis.computedAt,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    },
    update: {
      primeUei,
      primeName,
      totalSubawardDollars:
        totalSubawardDollars !== null ? new Prisma.Decimal(totalSubawardDollars) : null,
      averageSubSize:
        averageSubSize !== null ? new Prisma.Decimal(averageSubSize) : null,
      sampleSize,
      sdvosbGoalGap: { ...sdvosbGoalGap } as Prisma.InputJsonValue,
      dataQuality: { sampleSize, warnings } as unknown as Prisma.InputJsonValue,
      computedAt: analysis.computedAt,
      expiresAt: new Date(Date.now() + CACHE_TTL_MS),
    },
  })

  logger.info('SCW-2: subaward analysis computed', {
    primeKey,
    sampleSize,
    distinctSubs,
    totalSubawardDollars,
  })

  return analysis
}

// =============================================================
// Helpers
// =============================================================

function buildPrimeKey(uei: string | null, name: string | null): string {
  if (uei) return `uei:${uei.toUpperCase()}`
  return `name:${(name ?? '').toUpperCase()}`
}

function currentFiscalYear(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  // US federal FY runs Oct 1 → Sep 30; Oct/Nov/Dec belong to next FY.
  const fy = now.getUTCMonth() >= 9 ? y + 1 : y
  return `FY${String(fy).slice(-2)}`
}

type CacheRow = Awaited<ReturnType<typeof prisma.scwSubawardAnalysis.findUnique>>

function hydrateCacheRow(row: NonNullable<CacheRow>, fromCache: boolean): SubawardAnalysis {
  const dq = row.dataQuality as { sampleSize: number; warnings: string[] }
  const goalGap = row.sdvosbGoalGap as SubawardAnalysis['sdvosbGoalGap'] | null
  return {
    primeUei: row.primeUei,
    primeName: row.primeName,
    lookbackYears: row.lookbackYears,
    totalSubawardDollars:
      row.totalSubawardDollars !== null ? Number(row.totalSubawardDollars) : null,
    averageSubSize: row.averageSubSize !== null ? Number(row.averageSubSize) : null,
    smallBusinessSubAwardPercent: row.smallBusinessPercent,
    sdvosbSubAwardPercent: row.sdvosbPercent,
    topNaicsSubbed: (row.topNaicsSubbed as SubawardAnalysis['topNaicsSubbed']) ?? null,
    sdvosbGoalGap: goalGap ?? {
      fiscalYear: currentFiscalYear(),
      goalPercent: null,
      actualPercent: null,
      gapPercent: null,
      underPressure: false,
      source: 'unknown',
    },
    dataQuality: dq,
    computedAt: row.computedAt,
    fromCache,
  }
}
