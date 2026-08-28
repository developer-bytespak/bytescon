// =============================================================
// §6.2G — Portfolio expected value.
//
// Server-side, deterministic aggregation across a firm's active pursuits.
//
//   Expected Value = opportunity value × final win probability
//
// The rules that make the number trustworthy:
//  - ONE documented opportunity-value hierarchy (VALUE_SOURCE_ORDER below).
//    Every included row records which source its value came from.
//  - Each opportunity is counted exactly ONCE. The unit of aggregation is the
//    opportunity, not the pursuit, so two pursuits on one notice cannot
//    double-count it.
//  - Rows missing a value or a probability are EXCLUDED and reported in
//    `exclusions`, never silently treated as zero.
//  - Value TYPES are kept separate (ceiling / funded / estimated / forecast) and
//    never summed across incompatible types without an explicit label.
//  - Lower/upper expected value use the §6.2H confidence interval, not an
//    arbitrary percentage band.
// =============================================================
import { EligibilityState, PursuitStatus } from '@prisma/client'
import { prisma } from '../../config/database'
import { resolveStoredProbability } from '../winProbability'
import { getActiveTenantCalibration } from './tenantCalibration'
import { applyPlatt } from '../plattCalibration'
import { buildBins, computeConfidenceInterval, type CalibrationBin } from './confidenceInterval'

export const METHOD_VERSION = 'v1'

/** Value types, kept separate because they are not interchangeable. */
export type ValueType = 'CEILING' | 'FUNDED' | 'ESTIMATED' | 'FORECAST'

/**
 * The single documented value hierarchy. First match wins, and the winning
 * source is recorded on every row.
 */
export const VALUE_SOURCE_ORDER = [
  { key: 'CONTRACT_CEILING', type: 'CEILING' as ValueType, description: 'Ceiling value of a linked awarded contract' },
  { key: 'CONTRACT_FUNDED', type: 'FUNDED' as ValueType, description: 'Funded value of a linked awarded contract' },
  { key: 'OPPORTUNITY_ESTIMATE', type: 'ESTIMATED' as ValueType, description: 'Estimated value published on the notice' },
  { key: 'OPPORTUNITY_RANGE_MIDPOINT', type: 'ESTIMATED' as ValueType, description: 'Midpoint of the notice’s published value range' },
  { key: 'FORECAST_ESTIMATE', type: 'FORECAST' as ValueType, description: 'Estimated value from the linked agency forecast' },
] as const

export type ValueSourceKey = (typeof VALUE_SOURCE_ORDER)[number]['key']

export interface PortfolioRow {
  opportunityId: string
  title: string
  agency: string
  naicsCode: string
  value: number
  valueSource: ValueSourceKey
  valueType: ValueType
  probability: number
  probabilityLower: number | null
  probabilityUpper: number | null
  expectedValue: number
  expectedValueLower: number | null
  expectedValueUpper: number | null
  pipelineStage: string | null
  ownerUserId: string | null
  responseDeadline: Date
  eligibility: EligibilityState | null
  intervalAvailable: boolean
}

export interface Exclusion {
  opportunityId: string
  title: string
  reason: string
}

export interface PortfolioSummary {
  activeOpportunityCount: number
  totalNominalValue: number
  weightedExpectedValue: number
  lowerExpectedValue: number | null
  upperExpectedValue: number | null
  /** True when at least one included row had no usable interval. */
  intervalPartial: boolean
  byValueType: Record<ValueType, { count: number; nominal: number; expected: number }>
  byAgency: Array<{ key: string; count: number; nominal: number; expected: number }>
  byNaics: Array<{ key: string; count: number; nominal: number; expected: number }>
  byPipelineStage: Array<{ key: string; count: number; nominal: number; expected: number }>
  byOwner: Array<{ key: string; count: number; nominal: number; expected: number }>
  byPeriod: Array<{ key: string; count: number; nominal: number; expected: number }>
  highValueHighUncertainty: PortfolioRow[]
  concentration: {
    agencyHhi: number | null
    naicsHhi: number | null
    topAgencyShare: number | null
    interpretation: string
  }
  upcomingDeadlines: Array<{ opportunityId: string; title: string; responseDeadline: Date; daysRemaining: number }>
  capacityConflicts: Array<{ date: string; count: number; opportunityIds: string[] }>
  exclusions: Exclusion[]
  rows: PortfolioRow[]
  methodVersion: string
  calculatedAt: string
  valueHierarchy: typeof VALUE_SOURCE_ORDER
}

function round2(n: number): number {
  return Number(n.toFixed(2))
}

/** Herfindahl-Hirschman index over shares. Null when there is nothing to measure. */
export function hhi(values: number[]): number | null {
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0) return null
  const index = values.reduce((acc, v) => acc + (v / total) ** 2, 0)
  return Number(index.toFixed(4))
}

function groupBy(rows: PortfolioRow[], keyFn: (r: PortfolioRow) => string | null) {
  const map = new Map<string, { count: number; nominal: number; expected: number }>()
  for (const r of rows) {
    const key = keyFn(r) ?? 'Unassigned'
    const cur = map.get(key) ?? { count: 0, nominal: 0, expected: 0 }
    cur.count++
    cur.nominal += r.value
    cur.expected += r.expectedValue
    map.set(key, cur)
  }
  return [...map.entries()]
    .map(([key, v]) => ({ key, count: v.count, nominal: round2(v.nominal), expected: round2(v.expected) }))
    .sort((a, b) => b.expected - a.expected)
}

export interface PortfolioOptions {
  now?: Date
  agency?: string
  naicsCode?: string
  ownerUserId?: string
  pipelineStage?: string
  /** Deadline horizon in days. Default: everything still open. */
  withinDays?: number
  /** Number of pursuits due within 7 days that counts as a capacity conflict. */
  capacityConflictThreshold?: number
}

/**
 * Build the portfolio view. All aggregation is server-side; the frontend
 * renders these numbers and never recomputes them.
 */
export async function computePortfolio(
  consultingFirmId: string,
  options: PortfolioOptions = {},
): Promise<PortfolioSummary> {
  const now = options.now ?? new Date()
  const conflictThreshold = options.capacityConflictThreshold ?? 3

  const deadlineFilter: { gte: Date; lte?: Date } = { gte: now }
  if (options.withinDays !== undefined) {
    deadlineFilter.lte = new Date(now.getTime() + options.withinDays * 86400000)
  }

  // The unit of aggregation is the OPPORTUNITY, so an opportunity with two
  // pursuits is still counted once.
  const opportunities = await prisma.opportunity.findMany({
    where: {
      consultingFirmId,
      isDemo: false,
      status: 'ACTIVE',
      responseDeadline: deadlineFilter,
      ...(options.agency ? { agency: { contains: options.agency, mode: 'insensitive' } } : {}),
      ...(options.naicsCode ? { naicsCode: { startsWith: options.naicsCode } } : {}),
      ...(options.ownerUserId || options.pipelineStage
        ? {
            bidPursuits: {
              some: {
                ...(options.ownerUserId ? { ownerUserId: options.ownerUserId } : {}),
                ...(options.pipelineStage ? { pipelineStage: options.pipelineStage as never } : {}),
              },
            },
          }
        : {}),
    },
    select: {
      id: true, title: true, agency: true, naicsCode: true, probabilityScore: true,
      estimatedValue: true, estimatedValueMin: true, estimatedValueMax: true, responseDeadline: true,
      contract: { select: { ceilingValue: true, fundedValue: true } },
      match: { select: { eligibility: true } },
      originatingForecasts: { select: { estimatedValue: true, estimatedValueMax: true }, take: 1 },
      bidPursuits: {
        where: { status: { in: [PursuitStatus.REVIEWING, PursuitStatus.SUBMITTED] } },
        select: { ownerUserId: true, pipelineStage: true },
        orderBy: { updatedAt: 'desc' },
        take: 1,
      },
    },
    take: 2000,
  })

  // Tenant calibration + bins, loaded once for the whole portfolio.
  const tenantCalibration = await getActiveTenantCalibration(consultingFirmId, now)
  const samples = await prisma.calibrationSample.findMany({
    where: { consultingFirmId },
    select: { predictedProbability: true, observedOutcome: true },
    take: 5000,
  })
  const bins: CalibrationBin[] = buildBins(samples.map((s) => ({ predicted: s.predictedProbability, observed: s.observedOutcome })))

  const rows: PortfolioRow[] = []
  const exclusions: Exclusion[] = []
  let intervalPartial = false

  for (const opp of opportunities) {
    // --- value, via the single documented hierarchy ---
    let value: number | null = null
    let valueSource: ValueSourceKey | null = null
    let valueType: ValueType | null = null

    if (opp.contract?.ceilingValue) { value = Number(opp.contract.ceilingValue); valueSource = 'CONTRACT_CEILING'; valueType = 'CEILING' }
    else if (opp.contract?.fundedValue) { value = Number(opp.contract.fundedValue); valueSource = 'CONTRACT_FUNDED'; valueType = 'FUNDED' }
    else if (opp.estimatedValue) { value = Number(opp.estimatedValue); valueSource = 'OPPORTUNITY_ESTIMATE'; valueType = 'ESTIMATED' }
    else if (opp.estimatedValueMin && opp.estimatedValueMax) {
      value = (Number(opp.estimatedValueMin) + Number(opp.estimatedValueMax)) / 2
      valueSource = 'OPPORTUNITY_RANGE_MIDPOINT'; valueType = 'ESTIMATED'
    } else if (opp.originatingForecasts[0]) {
      const f = opp.originatingForecasts[0]
      const fv = f.estimatedValue ?? f.estimatedValueMax
      if (fv) { value = Number(fv); valueSource = 'FORECAST_ESTIMATE'; valueType = 'FORECAST' }
    }

    if (value === null || !Number.isFinite(value) || value <= 0) {
      exclusions.push({ opportunityId: opp.id, title: opp.title, reason: 'No usable contract, notice or forecast value — excluded rather than counted as zero.' })
      continue
    }

    // --- probability: the same single resolution path used everywhere ---
    const rawProb = opp.probabilityScore > 1 ? opp.probabilityScore / 100 : opp.probabilityScore
    if (!Number.isFinite(rawProb) || rawProb <= 0) {
      exclusions.push({ opportunityId: opp.id, title: opp.title, reason: 'No win probability has been scored yet — excluded rather than counted as zero.' })
      continue
    }

    let probability: number
    if (tenantCalibration && !tenantCalibration.isStale) {
      probability = Math.min(1, Math.max(0, applyPlatt(rawProb, tenantCalibration.params)))
    } else {
      probability = resolveStoredProbability(rawProb, now).finalScore / 100
    }

    const interval = computeConfidenceInterval({
      pointEstimate: probability,
      bins,
      tenantSampleSize: samples.length,
      modelVersion: METHOD_VERSION,
      dataCompleteness: 1,
      trainingSimilarity: 0.6,
    })
    if (!interval.available) intervalPartial = true

    const pursuit = opp.bidPursuits[0]
    rows.push({
      opportunityId: opp.id,
      title: opp.title,
      agency: opp.agency,
      naicsCode: opp.naicsCode,
      value: round2(value),
      valueSource: valueSource as ValueSourceKey,
      valueType: valueType as ValueType,
      probability: Number(probability.toFixed(4)),
      probabilityLower: interval.lower,
      probabilityUpper: interval.upper,
      expectedValue: round2(value * probability),
      expectedValueLower: interval.lower === null ? null : round2(value * interval.lower),
      expectedValueUpper: interval.upper === null ? null : round2(value * interval.upper),
      pipelineStage: pursuit?.pipelineStage ?? null,
      ownerUserId: pursuit?.ownerUserId ?? null,
      responseDeadline: opp.responseDeadline,
      eligibility: opp.match?.eligibility ?? null,
      intervalAvailable: interval.available,
    })
  }

  const totalNominalValue = round2(rows.reduce((a, r) => a + r.value, 0))
  const weightedExpectedValue = round2(rows.reduce((a, r) => a + r.expectedValue, 0))
  const withInterval = rows.filter((r) => r.intervalAvailable)
  const lowerExpectedValue = withInterval.length > 0 ? round2(withInterval.reduce((a, r) => a + (r.expectedValueLower ?? 0), 0)) : null
  const upperExpectedValue = withInterval.length > 0 ? round2(withInterval.reduce((a, r) => a + (r.expectedValueUpper ?? 0), 0)) : null

  // Value types are reported separately — never silently summed together.
  const byValueType = { CEILING: { count: 0, nominal: 0, expected: 0 }, FUNDED: { count: 0, nominal: 0, expected: 0 }, ESTIMATED: { count: 0, nominal: 0, expected: 0 }, FORECAST: { count: 0, nominal: 0, expected: 0 } }
  for (const r of rows) {
    byValueType[r.valueType].count++
    byValueType[r.valueType].nominal = round2(byValueType[r.valueType].nominal + r.value)
    byValueType[r.valueType].expected = round2(byValueType[r.valueType].expected + r.expectedValue)
  }

  const byAgency = groupBy(rows, (r) => r.agency)
  const byNaics = groupBy(rows, (r) => r.naicsCode || 'Unclassified')
  const byPipelineStage = groupBy(rows, (r) => r.pipelineStage)
  const byOwner = groupBy(rows, (r) => r.ownerUserId)
  const byPeriod = groupBy(rows, (r) => {
    const d = r.responseDeadline
    const q = Math.floor(d.getUTCMonth() / 3) + 1
    return `${d.getUTCFullYear()}-Q${q}`
  }).sort((a, b) => a.key.localeCompare(b.key))

  // High value, high uncertainty: top-quartile value with a wide or missing band.
  const sortedByValue = [...rows].sort((a, b) => b.value - a.value)
  const topQuartileCut = sortedByValue[Math.floor(sortedByValue.length / 4)]?.value ?? 0
  const highValueHighUncertainty = rows
    .filter((r) => {
      if (r.value < topQuartileCut) return false
      if (!r.intervalAvailable) return true
      const width = (r.probabilityUpper ?? 0) - (r.probabilityLower ?? 0)
      return width >= 0.3
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)

  const agencyHhi = hhi(byAgency.map((a) => a.nominal))
  const naicsHhi = hhi(byNaics.map((a) => a.nominal))
  const topAgencyShare = totalNominalValue > 0 && byAgency.length > 0
    ? Number((Math.max(...byAgency.map((a) => a.nominal)) / totalNominalValue).toFixed(4))
    : null

  const interpretation = agencyHhi === null
    ? 'Not enough portfolio value to assess concentration.'
    : agencyHhi >= 0.25
      ? `Highly concentrated by agency (HHI ${agencyHhi}). A single customer drives most of the pipeline value.`
      : agencyHhi >= 0.15
        ? `Moderately concentrated by agency (HHI ${agencyHhi}).`
        : `Well diversified by agency (HHI ${agencyHhi}).`

  const upcomingDeadlines = rows
    .filter((r) => r.responseDeadline.getTime() >= now.getTime())
    .sort((a, b) => a.responseDeadline.getTime() - b.responseDeadline.getTime())
    .slice(0, 15)
    .map((r) => ({
      opportunityId: r.opportunityId, title: r.title, responseDeadline: r.responseDeadline,
      daysRemaining: Math.ceil((r.responseDeadline.getTime() - now.getTime()) / 86400000),
    }))

  // Capacity conflict: several deadlines landing in the same week.
  const weekBuckets = new Map<string, string[]>()
  for (const r of rows) {
    const d = r.responseDeadline
    const weekStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - d.getUTCDay()))
    const key = weekStart.toISOString().slice(0, 10)
    weekBuckets.set(key, [...(weekBuckets.get(key) ?? []), r.opportunityId])
  }
  const capacityConflicts = [...weekBuckets.entries()]
    .filter(([, ids]) => ids.length >= conflictThreshold)
    .map(([date, ids]) => ({ date, count: ids.length, opportunityIds: ids }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return {
    activeOpportunityCount: rows.length,
    totalNominalValue,
    weightedExpectedValue,
    lowerExpectedValue,
    upperExpectedValue,
    intervalPartial,
    byValueType,
    byAgency,
    byNaics,
    byPipelineStage,
    byOwner,
    byPeriod,
    highValueHighUncertainty,
    concentration: { agencyHhi, naicsHhi, topAgencyShare, interpretation },
    upcomingDeadlines,
    capacityConflicts,
    exclusions,
    rows,
    methodVersion: METHOD_VERSION,
    calculatedAt: now.toISOString(),
    valueHierarchy: VALUE_SOURCE_ORDER,
  }
}
