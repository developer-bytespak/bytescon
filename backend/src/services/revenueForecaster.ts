import { prisma } from '../config/database'
import { logger } from '../utils/logger'

export interface ForecastMonth {
  period: string        // "2026-04"
  expected: number      // mean
  p10: number           // 10th percentile (pessimistic)
  p50: number           // median
  p90: number           // 90th percentile (optimistic)
  opportunityCount: number
}

export interface PortfolioHealth {
  revenueForecast: ForecastMonth[]
  totalExpectedRevenue: number
  diversification: {
    naicsConcentration: number         // HHI (0-1, lower = more diverse)
    agencyConcentration: number        // HHI (0-1)
    /** Share of pipeline in top-3 NAICS sectors. Complements HHI which can
     *  miss "2 huge + 20 tiny" excess concentration patterns. */
    naicsTopThreeShare: number         // 0-1
    /** Share of pipeline in top-3 agencies. Same rationale as above. */
    agencyTopThreeShare: number        // 0-1
    setAsideDistribution: { type: string; count: number; percent: number }[]
  }
  riskIndicators: {
    singleClientDependency: number     // % pipeline value from top client
    overdueSubmissionRate: number
    avgDaysToDeadlineAtSubmission: number
    pipelineCoverage: number           // total pipeline value / expected wins
  }
}

/**
 * Deterministic PRNG (mulberry32). Given the same 32-bit seed it always
 * yields the same sequence — this is what keeps the forecast reproducible
 * across page reloads instead of drifting on every request.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * FNV-1a 32-bit string hash — turns a stable description of the pipeline
 * into a seed. Same pipeline → same seed → same percentile bands.
 */
function hashSeed(str: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * Box-Muller transform for a standard normal random variable. Accepts the
 * RNG so callers can pass a seeded generator; defaults to Math.random for
 * ad-hoc use and unit tests.
 */
function gaussianRandom(rng: () => number = Math.random): number {
  // Protect against rng() returning 0 (log(0) = -Infinity -> NaN)
  const u1 = rng() || Number.EPSILON
  const u2 = rng() || Number.EPSILON
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/**
 * Revenue forecast.
 *
 * The headline `expected` figure is computed ANALYTICALLY as
 * Σ (winProbability × value) per month. Because the lognormal noise is
 * unbiased (E[noise] = 1) and wins are Bernoulli, this is the exact mean —
 * no sampling error, so it never drifts between page reloads.
 *
 * The p10/p50/p90 bands still come from a Monte Carlo run, but the PRNG is
 * SEEDED from a hash of the month's pipeline. Same pipeline → identical
 * bands on every request; the bands only move when the underlying
 * opportunities actually change.
 */
export async function forecastRevenue(
  consultingFirmId: string,
  monthsAhead: number = 6,
  simulations: number = 1000
): Promise<ForecastMonth[]> {
  try {
    const now = new Date()
    const futureLimit = new Date(now)
    futureLimit.setMonth(futureLimit.getMonth() + monthsAhead)

    const opportunities = await prisma.opportunity.findMany({
      where: {
        consultingFirmId,
        status: 'ACTIVE',
        responseDeadline: { gte: now, lte: futureLimit },
      },
      select: {
        id: true,
        estimatedValue: true,
        probabilityScore: true,
        responseDeadline: true,
        recompeteFlag: true,
        incumbentProbability: true,
        bidDecisions: {
          select: { winProbability: true, recommendation: true },
          orderBy: { updatedAt: 'desc' },
          take: 1,
        },
      },
    })

    // Time-to-Award NPV Discount: federal avg 9 months from deadline to award
    const TIME_TO_AWARD_DISCOUNT = 1 / Math.pow(1.08, 9 / 12) // ≈ 0.943
    const SUB_REVENUE_SHARE = 0.30
    const OPTION_YEAR_FACTOR = 2.5

    // Group opportunities by month
    const monthBuckets = new Map<string, { id: string; prob: number; value: number }[]>()

    for (const opp of opportunities) {
      const month = opp.responseDeadline.toISOString().substring(0, 7)
      const bestDecision = opp.bidDecisions[0]
      let prob = Number(bestDecision?.winProbability ?? opp.probabilityScore ?? 0)
      const baseValue = Number(opp.estimatedValue || 0)

      if (baseValue <= 0) continue
      // Floor for unscored opportunities. Set deliberately LOW (5%) to avoid
      // inflating forecasts with speculative deals — better to under-show an
      // unscored opp than over-promise. Operators see scored opps move toward
      // their real probability as soon as the scoring worker runs. Previous
      // 12% floor was selected arbitrarily and biased forecasts upward.
      if (prob <= 0) prob = 0.05

      // Recompete boost (same logic as decisionEngine)
      if (opp.recompeteFlag) {
        const incProb = opp.incumbentProbability ? Number(opp.incumbentProbability) : null
        if (incProb !== null && incProb < 0.4) prob = Math.min(prob * 1.15, 0.90)
        else if (incProb !== null && incProb < 0.65) prob = Math.min(prob * 1.08, 0.90)
        else prob = Math.min(prob * 1.08, 0.90)
      }

      // Sub-contract revenue share: BID_SUB captures 30% of prime value
      const isSub = bestDecision?.recommendation === 'BID_SUB'
      const effectiveValue = isSub ? baseValue * SUB_REVENUE_SHARE : baseValue

      // Option Year Lifetime Value (use for pipeline projection)
      const lifetimeValue = effectiveValue * OPTION_YEAR_FACTOR

      // Apply time-to-award discount
      const value = lifetimeValue * TIME_TO_AWARD_DISCOUNT

      if (!monthBuckets.has(month)) monthBuckets.set(month, [])
      monthBuckets.get(month)!.push({ id: opp.id, prob, value })
    }

    // Per-month: exact analytic mean + seeded Monte Carlo for the bands.
    const results = new Map<string, { sims: number[]; oppCount: number; analyticMean: number }>()

    for (const [month, opps] of monthBuckets) {
      // Exact expected revenue. E[Σ Bernoulli(prob)·value·noise] = Σ prob·value
      // because E[noise] = 1. No RNG here, so this number never drifts.
      const analyticMean = opps.reduce((sum, o) => sum + o.prob * o.value, 0)

      // Seed the PRNG from this month's pipeline so the percentile bands are
      // identical across reloads and only shift when the pipeline changes.
      const seed = hashSeed(
        month + '|' + opps.map((o) => `${o.id}:${o.prob.toFixed(6)}:${o.value}`).join(',')
      )
      const rng = mulberry32(seed)

      const sims: number[] = []
      for (let s = 0; s < simulations; s++) {
        let total = 0
        for (const { prob, value } of opps) {
          if (rng() < prob) {
            // Unbiased lognormal noise. For X = exp(μ + σZ) with Z~N(0,1):
            //   E[X] = exp(μ + σ²/2)
            // With σ=0.2 (σ²=0.04) and μ=-σ²/2=-0.02:
            //   E[noise] = exp(-0.02 + 0.02) = exp(0) = 1.0   ← unbiased
            //   Median[noise] = exp(μ) = exp(-0.02) ≈ 0.980    ← below 1 (expected)
            // The median is below 1.0 because lognormal is right-skewed; the
            // mean (which is what aggregates to expected revenue) is exactly 1.
            const SIGMA = 0.2
            const MU = -(SIGMA * SIGMA) / 2  // = -0.02
            const noise = Math.exp(MU + SIGMA * gaussianRandom(rng))
            total += value * noise
          }
        }
        sims.push(total)
      }
      sims.sort((a, b) => a - b)
      results.set(month, { sims, oppCount: opps.length, analyticMean })
    }

    // Generate month keys and extract percentiles
    const forecast: ForecastMonth[] = []
    for (let i = 0; i < monthsAhead; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
      const period = d.toISOString().substring(0, 7)
      const data = results.get(period)

      if (!data || data.sims.length === 0) {
        forecast.push({ period, expected: 0, p10: 0, p50: 0, p90: 0, opportunityCount: 0 })
        continue
      }

      const { sims, oppCount, analyticMean } = data

      // Bounded percentile lookup. Math.floor(N*0.9) on a 10-element array
      // gives index 9 which is fine, but if N=1 then any percentile gives
      // index 0 — clamp explicitly so we never index out of range.
      const pct = (p: number) => sims[Math.max(0, Math.min(sims.length - 1, Math.floor(sims.length * p)))]

      forecast.push({
        period,
        expected: Math.round(analyticMean),   // exact analytic mean — stable across reloads
        p10: Math.round(pct(0.1)),
        p50: Math.round(pct(0.5)),
        p90: Math.round(pct(0.9)),
        opportunityCount: oppCount,
      })
    }

    return forecast
  } catch (err) {
    logger.error('Failed to forecast revenue', { error: err })
    return []
  }
}

/**
 * Herfindahl-Hirschman Index for concentration measurement.
 * 0 = perfectly diverse, 1 = fully concentrated in one category.
 */
function computeHHI(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  return counts.reduce((hhi, count) => hhi + Math.pow(count / total, 2), 0)
}

/**
 * Share of total represented by the top-N categories. Pairs with HHI:
 * HHI misses "2 huge + 20 tiny" excess concentration because the long tail
 * pulls HHI down; topNShare surfaces it directly.
 */
function topNShare(counts: number[], n: number = 3): number {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return 0
  const sorted = [...counts].sort((a, b) => b - a)
  const topSum = sorted.slice(0, n).reduce((a, b) => a + b, 0)
  return topSum / total
}

/** Exposed for unit tests — do not import in app code. */
export const __revenueForecasterInternals = { computeHHI, topNShare, gaussianRandom, mulberry32, hashSeed }

export async function getPortfolioHealth(consultingFirmId: string): Promise<PortfolioHealth> {
  try {
    // Revenue forecast
    const revenueForecast = await forecastRevenue(consultingFirmId)
    const totalExpectedRevenue = revenueForecast.reduce((sum, m) => sum + m.expected, 0)

    // NAICS concentration
    const naicsGroups: { naics: string; count: bigint }[] = await prisma.$queryRaw`
      SELECT LEFT("naicsCode", 2) as naics, COUNT(*)::bigint as count
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId} AND status = 'ACTIVE'
      GROUP BY LEFT("naicsCode", 2)
    `
    const naicsCounts = naicsGroups.map((g) => Number(g.count))
    const naicsConcentration = computeHHI(naicsCounts)
    const naicsTopThreeShare = topNShare(naicsCounts, 3)

    // Agency concentration
    const agencyGroups: { agency: string; count: bigint }[] = await prisma.$queryRaw`
      SELECT agency, COUNT(*)::bigint as count
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId} AND status = 'ACTIVE'
      GROUP BY agency
    `
    const agencyCounts = agencyGroups.map((g) => Number(g.count))
    const agencyConcentration = computeHHI(agencyCounts)
    const agencyTopThreeShare = topNShare(agencyCounts, 3)

    // Set-aside distribution
    const setAsideGroups = await prisma.opportunity.groupBy({
      by: ['setAsideType'],
      where: { consultingFirmId, status: 'ACTIVE' },
      _count: true,
    })
    const totalSetAside = setAsideGroups.reduce((sum, g) => sum + g._count, 0)
    const setAsideDistribution = setAsideGroups.map((g) => ({
      type: g.setAsideType || 'NONE',
      count: g._count,
      percent: totalSetAside > 0 ? Math.round((g._count / totalSetAside) * 100) : 0,
    }))

    // Client dependency: top client's share of pipeline value via bid decisions
    const clientValues: { client_id: string; total_value: number }[] = await prisma.$queryRaw`
      SELECT "clientCompanyId" as client_id,
             COALESCE(SUM("expectedValue"::float), 0) as total_value
      FROM bid_decisions
      WHERE "consultingFirmId" = ${consultingFirmId}
      GROUP BY "clientCompanyId"
      ORDER BY total_value DESC
    `
    const totalPipelineValue = clientValues.reduce((s, c) => s + Number(c.total_value), 0)
    const singleClientDependency =
      totalPipelineValue > 0 && clientValues.length > 0
        ? Math.round((Number(clientValues[0].total_value) / totalPipelineValue) * 100)
        : 0

    // Overdue submission rate
    const submissionStats = await prisma.submissionRecord.aggregate({
      where: { consultingFirmId },
      _count: true,
    })
    const lateSubmissions = await prisma.submissionRecord.count({
      where: { consultingFirmId, wasOnTime: false },
    })
    const overdueSubmissionRate =
      submissionStats._count > 0
        ? Math.round((lateSubmissions / submissionStats._count) * 100)
        : 0

    // Avg days to deadline at submission time
    const avgDaysRaw: { avg_days: number }[] = await prisma.$queryRaw`
      SELECT COALESCE(
        AVG(
          EXTRACT(EPOCH FROM (o."responseDeadline" - sr."submittedAt")) / 86400
        )::float, 0
      ) as avg_days
      FROM submission_records sr
      JOIN opportunities o ON sr."opportunityId" = o.id
      WHERE sr."consultingFirmId" = ${consultingFirmId}
    `
    const avgDaysToDeadlineAtSubmission = Math.round(Number(avgDaysRaw[0]?.avg_days || 0))

    return {
      revenueForecast,
      totalExpectedRevenue,
      diversification: {
        naicsConcentration: Math.round(naicsConcentration * 100) / 100,
        agencyConcentration: Math.round(agencyConcentration * 100) / 100,
        naicsTopThreeShare: Math.round(naicsTopThreeShare * 100) / 100,
        agencyTopThreeShare: Math.round(agencyTopThreeShare * 100) / 100,
        setAsideDistribution,
      },
      riskIndicators: {
        singleClientDependency,
        overdueSubmissionRate,
        avgDaysToDeadlineAtSubmission,
        pipelineCoverage:
          totalExpectedRevenue > 0
            ? Math.round((totalPipelineValue / totalExpectedRevenue) * 100) / 100
            : 0,
      },
    }
  } catch (err) {
    logger.error('Failed to compute portfolio health', { error: err })
    return {
      revenueForecast: [],
      totalExpectedRevenue: 0,
      diversification: { naicsConcentration: 0, agencyConcentration: 0, naicsTopThreeShare: 0, agencyTopThreeShare: 0, setAsideDistribution: [] },
      riskIndicators: {
        singleClientDependency: 0,
        overdueSubmissionRate: 0,
        avgDaysToDeadlineAtSubmission: 0,
        pipelineCoverage: 0,
      },
    }
  }
}
