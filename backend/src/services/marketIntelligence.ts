import { prisma } from '../config/database'
import { logger } from '../utils/logger'

export interface NaicsSectorTrend {
  naicsCode: string
  sector: string
  opportunityCount: number
  /** Average estimatedValue across opps WITH a price; null if none have one. */
  avgEstimatedValue: number | null
  /** Count of opps in this sector that have an estimatedValue set. */
  pricedOpportunityCount: number
  avgCompetitionCount: number
  avgIncumbentDominance: number
  /** "insufficient_data" when fewer than 3 months × ≥10 opps to compute a trustworthy slope. */
  trend: 'growing' | 'declining' | 'stable' | 'insufficient_data'
}

export interface AgencyProfile {
  agency: string
  totalOpportunities: number
  smallBizRate: number
  sdvosbRate: number
  avgAwardSize: number
  topIncumbents: { name: string; winCount: number }[]
}

export interface CompetitiveLandscape {
  totalEnrichedOpportunities: number
  avgCompetitors: number
  incumbentDominanceDistribution: { bucket: string; count: number }[]
  recompetePercent: number
}

// NAICS sector labels (2-digit prefixes)
const NAICS_SECTORS: Record<string, string> = {
  '11': 'Agriculture', '21': 'Mining', '22': 'Utilities',
  '23': 'Construction', '31': 'Manufacturing', '32': 'Manufacturing',
  '33': 'Manufacturing', '42': 'Wholesale Trade', '44': 'Retail Trade',
  '45': 'Retail Trade', '48': 'Transportation', '49': 'Transportation',
  '51': 'Information', '52': 'Finance/Insurance', '53': 'Real Estate',
  '54': 'Professional Services', '55': 'Management', '56': 'Admin/Support',
  '61': 'Education', '62': 'Health Care', '71': 'Arts/Entertainment',
  '72': 'Accommodation/Food', '81': 'Other Services', '92': 'Public Admin',
}

/**
 * Linear regression slope for trend detection.
 * Positive slope = growing, negative = declining.
 *
 * Note: this is OLS — a single extreme observation can flip the slope sign.
 * Use linearSlopeRobust() when one big-sync month could dominate.
 */
function linearSlope(values: number[]): number {
  const n = values.length
  if (n < 2) return 0
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0
  for (let i = 0; i < n; i++) {
    sumX += i
    sumY += values[i]
    sumXY += i * values[i]
    sumX2 += i * i
  }
  const denom = n * sumX2 - sumX * sumX
  if (denom === 0) return 0
  return (n * sumXY - sumX * sumY) / denom
}

/**
 * Outlier-robust slope. Trims observations more than `trimZScore` standard
 * deviations from the series mean, then runs OLS on what's left. Trims at
 * most ~10% of observations per call so a series of consistently rising
 * values doesn't get "trimmed" into a flat slope.
 *
 * Why we need this: a single big-sync month (one SAM.gov backfill landing
 * 26K opps for a sector in May, then a normal 200/month) reads as
 * "declining" under OLS, which then mislabels every other sector that
 * happened to coincide with that month. Audit finding #11 (CRITICAL).
 */
function linearSlopeRobust(values: number[], trimZScore: number = 2): number {
  const n = values.length
  if (n < 3) return linearSlope(values)
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n
  const stdev = Math.sqrt(variance)
  if (stdev === 0) return 0

  // Identify outlier indices; cap removals at 10% of series so we never trim
  // a legitimate trend down to flatness.
  const maxTrim = Math.max(1, Math.floor(n * 0.1))
  const outliers = values
    .map((v, i) => ({ i, dist: Math.abs(v - mean) / stdev }))
    .filter((x) => x.dist > trimZScore)
    .sort((a, b) => b.dist - a.dist)
    .slice(0, maxTrim)
    .map((x) => x.i)

  if (outliers.length === 0) return linearSlope(values)

  const filtered = values.filter((_, i) => !outliers.includes(i))
  // Need at least 3 points post-trim to bother re-computing.
  return filtered.length >= 3 ? linearSlope(filtered) : linearSlope(values)
}

export async function getNaicsTrends(consultingFirmId: string): Promise<NaicsSectorTrend[]> {
  try {
    const raw: {
      naics: string
      count: bigint
      priced_count: bigint
      avg_value: number | null
      avg_competition: number
      avg_incumbent: number
    }[] = await prisma.$queryRaw`
      SELECT
        LEFT("naicsCode", 2) as naics,
        COUNT(*)::bigint as count,
        COUNT("estimatedValue")::bigint as priced_count,
        AVG("estimatedValue"::float) as avg_value,
        COALESCE(AVG("competitionCount"::float), 0) as avg_competition,
        COALESCE(AVG("incumbentProbability"::float), 0) as avg_incumbent
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND "naicsCode" IS NOT NULL AND "naicsCode" != ''
      GROUP BY LEFT("naicsCode", 2)
      HAVING COUNT(*) >= 2
      ORDER BY count DESC
      LIMIT 20
    `

    // For trend detection, get monthly counts per sector over last 6 months
    const sixMonthsAgo = new Date()
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)

    const monthly: { naics: string; period: string; count: bigint }[] = await prisma.$queryRaw`
      SELECT
        LEFT("naicsCode", 2) as naics,
        to_char(date_trunc('month', "createdAt"), 'YYYY-MM') as period,
        COUNT(*)::bigint as count
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND "createdAt" >= ${sixMonthsAgo}
        AND "naicsCode" IS NOT NULL AND "naicsCode" != ''
      GROUP BY LEFT("naicsCode", 2), date_trunc('month', "createdAt")
      ORDER BY naics, period
    `

    // Build monthly count arrays per sector
    const monthlyBySector = new Map<string, number[]>()
    let currentSector = ''
    let currentValues: number[] = []
    for (const row of monthly) {
      if (row.naics !== currentSector) {
        if (currentSector) monthlyBySector.set(currentSector, currentValues)
        currentSector = row.naics
        currentValues = []
      }
      currentValues.push(Number(row.count))
    }
    if (currentSector) monthlyBySector.set(currentSector, currentValues)

    return raw.map((r) => {
      const values = monthlyBySector.get(r.naics) || []
      // Trend signal needs at least 3 monthly buckets with ≥10 opps each
      // before we trust the slope. A single big-burst sync (e.g. one
      // 26K-opp month followed by a partial month) otherwise reads as
      // "declining" for every sector — false-positive that misled users.
      const sufficientMonths = values.filter((v) => v >= 10).length
      const totalOps = values.reduce((a, b) => a + b, 0)
      let trend: 'growing' | 'declining' | 'stable' | 'insufficient_data'
      // Require ≥3 months at ≥10 opps each AND ≥30 total opps in the window.
      // The total-opps floor catches edge cases like [10,11,12,9,8] where
      // 3 months pass the per-month gate but the absolute volume is too thin
      // for a slope to mean anything (audit finding #13).
      if (sufficientMonths < 3 || totalOps < 30) {
        trend = 'insufficient_data'
      } else {
        // Outlier-robust slope so a single backfill month doesn't flip the
        // sign for a sector (audit #11). Normalize slope by the series mean
        // so "growing" means "monthly delta > 5% of typical level" rather
        // than an absolute count — works for sectors with 12 opps/mo and
        // sectors with 1200 opps/mo (audit #12).
        const slope = linearSlopeRobust(values)
        const mean = totalOps / values.length
        const normalizedSlope = mean > 0 ? slope / mean : 0
        if (normalizedSlope > 0.05) trend = 'growing'
        else if (normalizedSlope < -0.05) trend = 'declining'
        else trend = 'stable'
      }

      const pricedCount = Number(r.priced_count)
      const avgValue = r.avg_value === null || pricedCount === 0
        ? null
        : Math.round(Number(r.avg_value))

      return {
        naicsCode: r.naics,
        sector: NAICS_SECTORS[r.naics] || 'Other',
        opportunityCount: Number(r.count),
        avgEstimatedValue: avgValue,
        pricedOpportunityCount: pricedCount,
        avgCompetitionCount: Math.round(Number(r.avg_competition) * 10) / 10,
        avgIncumbentDominance: Math.round(Number(r.avg_incumbent) * 100) / 100,
        trend,
      }
    })
  } catch (err) {
    logger.error('Failed to compute NAICS trends', { error: err })
    return []
  }
}

export async function getAgencyProfiles(consultingFirmId: string): Promise<AgencyProfile[]> {
  try {
    const raw: {
      agency: string
      count: bigint
      avg_sbr: number
      avg_sdvosb: number
      avg_award: number
    }[] = await prisma.$queryRaw`
      SELECT
        agency,
        COUNT(*)::bigint as count,
        -- Only average enriched records to avoid fallback 0.25 polluting rates
        COALESCE(AVG(CASE WHEN "isEnriched" = true THEN "agencySmallBizRate"::float END), 0) as avg_sbr,
        COALESCE(AVG(CASE WHEN "isEnriched" = true THEN "agencySdvosbRate"::float END), 0) as avg_sdvosb,
        COALESCE(AVG(CASE WHEN "isEnriched" = true AND "historicalAvgAward" > 0 THEN "historicalAvgAward"::float END), 0) as avg_award
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND agency IS NOT NULL AND agency != ''
      GROUP BY agency
      HAVING COUNT(*) >= 2
      ORDER BY count DESC
      LIMIT 15
    `

    // Get top incumbents per agency
    const incumbents: { agency: string; winner: string; win_count: bigint }[] = await prisma.$queryRaw`
      SELECT
        o.agency,
        o."historicalWinner" as winner,
        COUNT(*)::bigint as win_count
      FROM opportunities o
      WHERE o."consultingFirmId" = ${consultingFirmId}
        AND o."historicalWinner" IS NOT NULL
        AND o."historicalWinner" != ''
      GROUP BY o.agency, o."historicalWinner"
      ORDER BY o.agency, win_count DESC
    `

    const incumbentMap = new Map<string, { name: string; winCount: number }[]>()
    for (const row of incumbents) {
      if (!incumbentMap.has(row.agency)) incumbentMap.set(row.agency, [])
      const arr = incumbentMap.get(row.agency)!
      if (arr.length < 3) arr.push({ name: row.winner, winCount: Number(row.win_count) })
    }

    return raw.map((r) => ({
      agency: r.agency,
      totalOpportunities: Number(r.count),
      smallBizRate: Math.round(Number(r.avg_sbr) * 100) / 100,
      sdvosbRate: Math.round(Number(r.avg_sdvosb) * 100) / 100,
      avgAwardSize: Math.round(Number(r.avg_award)),
      topIncumbents: incumbentMap.get(r.agency) || [],
    }))
  } catch (err) {
    logger.error('Failed to compute agency profiles', { error: err })
    return []
  }
}

export async function getCompetitiveLandscape(
  consultingFirmId: string
): Promise<CompetitiveLandscape> {
  try {
    const stats: { total: bigint; avg_comp: number; recompete_count: bigint }[] = await prisma.$queryRaw`
      SELECT
        COUNT(*)::bigint as total,
        COALESCE(AVG("competitionCount"::float), 0) as avg_comp,
        COUNT(*) FILTER (WHERE "recompeteFlag" = true)::bigint as recompete_count
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND "isEnriched" = true
    `

    // Incumbent dominance distribution — bucket by probability ranges
    const buckets: { bucket: string; count: bigint }[] = await prisma.$queryRaw`
      SELECT
        CASE
          WHEN "incumbentProbability" IS NULL THEN 'Unknown'
          WHEN "incumbentProbability" < 0.2 THEN '0-20% (Open)'
          WHEN "incumbentProbability" < 0.4 THEN '20-40% (Moderate)'
          WHEN "incumbentProbability" < 0.6 THEN '40-60% (Competitive)'
          WHEN "incumbentProbability" < 0.8 THEN '60-80% (Dominant)'
          ELSE '80-100% (Locked)'
        END as bucket,
        COUNT(*)::bigint as count
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND "isEnriched" = true
      GROUP BY bucket
      ORDER BY bucket
    `

    const s = stats[0]
    const total = Number(s?.total || 0)

    return {
      totalEnrichedOpportunities: total,
      avgCompetitors: Math.round(Number(s?.avg_comp || 0) * 10) / 10,
      incumbentDominanceDistribution: buckets.map((b) => ({
        bucket: b.bucket,
        count: Number(b.count),
      })),
      recompetePercent: total > 0
        ? Math.round((Number(s?.recompete_count || 0) / total) * 100)
        : 0,
    }
  } catch (err) {
    logger.error('Failed to compute competitive landscape', { error: err })
    return {
      totalEnrichedOpportunities: 0,
      avgCompetitors: 0,
      incumbentDominanceDistribution: [],
      recompetePercent: 0,
    }
  }
}
