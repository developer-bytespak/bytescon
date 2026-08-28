import { prisma } from '../config/database'
import { logger } from '../utils/logger'

export interface TrendPoint {
  period: string   // "2026-01"
  value: number
  ema: number      // Exponential moving average
}

export interface TrendSeries {
  label: string
  points: TrendPoint[]
  direction: 'up' | 'down' | 'flat'
  changePercent: number
}

/**
 * Exponential Moving Average.
 * alpha = 2 / (span + 1) — standard EMA formula
 *
 * Exported since §7.9 so the Intelligence Agent smooths its confirmed-outcome
 * series with THIS implementation rather than growing a second trend engine.
 */
export function computeEMA(values: number[], span: number = 3): number[] {
  if (values.length === 0) return []
  const alpha = 2 / (span + 1)
  const ema: number[] = [values[0]]
  for (let i = 1; i < values.length; i++) {
    ema.push(alpha * values[i] + (1 - alpha) * ema[i - 1])
  }
  return ema
}

/**
 * Direction from the last two smoothed points, with a 5% dead band.
 * Exported since §7.9 for the same reason as `computeEMA`.
 */
export function detectDirection(emaValues: number[]): { direction: 'up' | 'down' | 'flat'; changePercent: number } {
  if (emaValues.length < 2) return { direction: 'flat', changePercent: 0 }
  const last = emaValues[emaValues.length - 1]
  const prev = emaValues[emaValues.length - 2]
  if (prev === 0) return { direction: last > 0 ? 'up' : 'flat', changePercent: 0 }
  const change = ((last - prev) / prev) * 100
  if (Math.abs(change) < 5) return { direction: 'flat', changePercent: change }
  return { direction: change > 0 ? 'up' : 'down', changePercent: change }
}

function generateMonthKeys(months: number): string[] {
  const keys: string[] = []
  const now = new Date()
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    keys.push(d.toISOString().substring(0, 7))
  }
  return keys
}

export async function getSubmissionTrends(
  consultingFirmId: string,
  months: number = 12
): Promise<TrendSeries> {
  try {
    const startDate = new Date()
    startDate.setMonth(startDate.getMonth() - months)

    const raw: { period: string; count: bigint }[] = await prisma.$queryRaw`
      SELECT to_char(date_trunc('month', "submittedAt"), 'YYYY-MM') as period,
             COUNT(*)::bigint as count
      FROM submission_records
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND "submittedAt" >= ${startDate}
      GROUP BY date_trunc('month', "submittedAt")
      ORDER BY period
    `

    const monthKeys = generateMonthKeys(months)
    const dataMap = new Map(raw.map((r) => [r.period, Number(r.count)]))
    const values = monthKeys.map((k) => dataMap.get(k) || 0)
    const emaValues = computeEMA(values)
    const { direction, changePercent } = detectDirection(emaValues)

    return {
      label: 'Submissions',
      points: monthKeys.map((period, i) => ({
        period,
        value: values[i],
        ema: Math.round(emaValues[i] * 100) / 100,
      })),
      direction,
      changePercent: Math.round(changePercent * 10) / 10,
    }
  } catch (err) {
    logger.error('Failed to compute submission trends', { error: err })
    return { label: 'Submissions', points: [], direction: 'flat', changePercent: 0 }
  }
}

export async function getPenaltyTrends(
  consultingFirmId: string,
  months: number = 12
): Promise<TrendSeries> {
  try {
    const startDate = new Date()
    startDate.setMonth(startDate.getMonth() - months)

    const raw: { period: string; total: number }[] = await prisma.$queryRaw`
      SELECT to_char(date_trunc('month', "appliedAt"), 'YYYY-MM') as period,
             COALESCE(SUM(amount)::float, 0) as total
      FROM financial_penalties
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND "appliedAt" >= ${startDate}
      GROUP BY date_trunc('month', "appliedAt")
      ORDER BY period
    `

    const monthKeys = generateMonthKeys(months)
    const dataMap = new Map(raw.map((r) => [r.period, Number(r.total)]))
    const values = monthKeys.map((k) => dataMap.get(k) || 0)
    const emaValues = computeEMA(values)
    const { direction, changePercent } = detectDirection(emaValues)

    return {
      label: 'Penalties ($)',
      points: monthKeys.map((period, i) => ({
        period,
        value: Math.round(values[i] * 100) / 100,
        ema: Math.round(emaValues[i] * 100) / 100,
      })),
      direction,
      changePercent: Math.round(changePercent * 10) / 10,
    }
  } catch (err) {
    logger.error('Failed to compute penalty trends', { error: err })
    return { label: 'Penalties ($)', points: [], direction: 'flat', changePercent: 0 }
  }
}

export async function getWinRateTrends(
  consultingFirmId: string,
  months: number = 12
): Promise<TrendSeries> {
  try {
    const startDate = new Date()
    startDate.setMonth(startDate.getMonth() - months)

    // Win rate = decisions with BID_PRIME recommendation / total decisions per month
    const raw: { period: string; total: bigint; wins: bigint }[] = await prisma.$queryRaw`
      SELECT to_char(date_trunc('month', "updatedAt"), 'YYYY-MM') as period,
             COUNT(*)::bigint as total,
             COUNT(*) FILTER (WHERE recommendation = 'BID_PRIME')::bigint as wins
      FROM bid_decisions
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND "updatedAt" >= ${startDate}
      GROUP BY date_trunc('month', "updatedAt")
      ORDER BY period
    `

    const monthKeys = generateMonthKeys(months)
    const dataMap = new Map(
      raw.map((r) => [
        r.period,
        Number(r.total) > 0 ? Number(r.wins) / Number(r.total) : 0,
      ])
    )
    const values = monthKeys.map((k) => dataMap.get(k) || 0)
    const emaValues = computeEMA(values)
    const { direction, changePercent } = detectDirection(emaValues)

    return {
      label: 'Win Rate',
      points: monthKeys.map((period, i) => ({
        period,
        value: Math.round(values[i] * 1000) / 10, // percentage
        ema: Math.round(emaValues[i] * 1000) / 10,
      })),
      direction,
      changePercent: Math.round(changePercent * 10) / 10,
    }
  } catch (err) {
    logger.error('Failed to compute win rate trends', { error: err })
    return { label: 'Win Rate', points: [], direction: 'flat', changePercent: 0 }
  }
}

export async function getOpportunityVolumeTrends(
  consultingFirmId: string,
  months: number = 12
): Promise<TrendSeries> {
  try {
    const startDate = new Date()
    startDate.setMonth(startDate.getMonth() - months)

    const raw: { period: string; count: bigint }[] = await prisma.$queryRaw`
      SELECT to_char(date_trunc('month', "createdAt"), 'YYYY-MM') as period,
             COUNT(*)::bigint as count
      FROM opportunities
      WHERE "consultingFirmId" = ${consultingFirmId}
        AND "createdAt" >= ${startDate}
      GROUP BY date_trunc('month', "createdAt")
      ORDER BY period
    `

    const monthKeys = generateMonthKeys(months)
    const dataMap = new Map(raw.map((r) => [r.period, Number(r.count)]))
    const values = monthKeys.map((k) => dataMap.get(k) || 0)
    const emaValues = computeEMA(values)
    const { direction, changePercent } = detectDirection(emaValues)

    return {
      label: 'Opportunities',
      points: monthKeys.map((period, i) => ({
        period,
        value: values[i],
        ema: Math.round(emaValues[i] * 100) / 100,
      })),
      direction,
      changePercent: Math.round(changePercent * 10) / 10,
    }
  } catch (err) {
    logger.error('Failed to compute opportunity volume trends', { error: err })
    return { label: 'Opportunities', points: [], direction: 'flat', changePercent: 0 }
  }
}
