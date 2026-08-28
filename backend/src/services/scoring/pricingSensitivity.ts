// =============================================================
// §6.2E — Pricing sensitivity.
//
// Reads the EXISTING Pricing Workspace scenarios and produces a read-only
// price → win-probability curve. It never writes back to approved pricing.
//
// Honesty constraints encoded here:
//  - Labour-rate sensitivity is NOT inferred from total award values. The model
//    works only on TOTAL PRICE POSITION relative to a stated benchmark, and the
//    benchmark's source is always recorded and shown.
//  - Without sufficient tenant or comparable outcome data the result is labelled
//    UNVALIDATED_SCENARIO_ANALYSIS verbatim, and it is honest about being a
//    model-input comparison rather than a calibrated price effect.
//  - The curve is monotonically non-increasing in price by construction (a
//    higher price never raises modelled win probability), which the chosen
//    logit-on-price-position method guarantees. `isMonotonic` is verified, not
//    assumed.
//  - No price is ever presented as guaranteeing an award.
//  - All money is handled as Prisma Decimal / string and only converted for the
//    curve maths, never rounded mid-calculation.
// =============================================================
import { Prisma, SensitivityValidity } from '@prisma/client'
import { prisma } from '../../config/database'

export const SENSITIVITY_METHOD = 'price-position-logit-v1'
export const METHOD_VERSION = 'v1'
/** Tenant outcome samples needed before a curve may be called CALIBRATED. */
export const MIN_SAMPLES_FOR_CALIBRATED = 30
/**
 * Price-position elasticity in logit units per 1.0 of relative price position.
 * Conservative and fixed until a tenant has enough outcome data to justify a
 * fitted value; documented here rather than buried as a magic number.
 */
export const DEFAULT_PRICE_ELASTICITY = 2.2

export const UNVALIDATED_LABEL = 'UNVALIDATED_SCENARIO_ANALYSIS'

export interface PricePoint {
  label: string
  /** Total evaluated price. Decimal-safe: carried as a string. */
  price: string
  /** (price - benchmark) / benchmark. Negative = below benchmark. */
  pricePosition: number
  percentOfBenchmark: number
  probability: number
  lower: number | null
  upper: number | null
  scenarioId: string | null
  isBase: boolean
}

export interface SensitivityResult {
  benchmarkValue: string | null
  benchmarkSource: string | null
  basePrice: string | null
  baseProbability: number | null
  points: PricePoint[]
  assumptions: string[]
  validity: SensitivityValidity
  isMonotonic: boolean
  sampleSize: number
  method: string
  methodVersion: string
}

function logit(p: number): number {
  const c = Math.min(1 - 1e-6, Math.max(1e-6, p))
  return Math.log(c / (1 - c))
}
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

/**
 * Smallest and largest probability the curve will ever report. A price point
 * is never shown as 0% or 100%: no price makes an award impossible or certain,
 * and rounding an extreme position down to exactly zero would assert precisely
 * that.
 */
export const MIN_REPORTED_PROBABILITY = 0.0001
export const MAX_REPORTED_PROBABILITY = 0.9999

/**
 * Probability at a given price position.
 *
 * p(position) = sigmoid( logit(baseProbability) - elasticity * (position - basePosition) )
 *
 * Strictly decreasing in position because elasticity > 0, so the curve is
 * monotonic by construction, and clamped away from 0 and 1.
 */
export function probabilityAtPosition(
  baseProbability: number,
  basePosition: number,
  position: number,
  elasticity: number = DEFAULT_PRICE_ELASTICITY,
): number {
  const adjusted = logit(baseProbability) - elasticity * (position - basePosition)
  const raw = sigmoid(adjusted)
  const clamped = Math.min(MAX_REPORTED_PROBABILITY, Math.max(MIN_REPORTED_PROBABILITY, raw))
  return Number(clamped.toFixed(4))
}

export function verifyMonotonic(points: PricePoint[]): boolean {
  const sorted = [...points].sort((a, b) => a.pricePosition - b.pricePosition)
  for (let i = 1; i < sorted.length; i++) {
    // Allow floating-point noise but no real increase.
    if (sorted[i].probability > sorted[i - 1].probability + 1e-9) return false
  }
  return true
}

export interface ScenarioInput {
  id: string | null
  name: string
  /** Total evaluated price as a decimal string. */
  totalPrice: string
  isBase?: boolean
}

export interface ComputeArgs {
  scenarios: ScenarioInput[]
  benchmarkValue: string | null
  benchmarkSource: string | null
  baseProbability: number
  /** Interval half-widths from §6.2H, applied to each scenario probability. */
  intervalLowerHalfWidth?: number | null
  intervalUpperHalfWidth?: number | null
  tenantSampleSize: number
  elasticity?: number
}

/**
 * Build the sensitivity curve. Pure — no I/O — so it is fully unit-testable
 * and deterministic.
 */
export function computeSensitivity(args: ComputeArgs): SensitivityResult {
  const assumptions: string[] = []
  const elasticity = args.elasticity ?? DEFAULT_PRICE_ELASTICITY

  const base = {
    benchmarkValue: args.benchmarkValue,
    benchmarkSource: args.benchmarkSource,
    method: SENSITIVITY_METHOD,
    methodVersion: METHOD_VERSION,
    sampleSize: args.tenantSampleSize,
  }

  if (args.scenarios.length === 0) {
    return {
      ...base, basePrice: null, baseProbability: args.baseProbability, points: [],
      assumptions: ['No pricing scenarios exist for this opportunity, so there is nothing to compare.'],
      validity: SensitivityValidity.INSUFFICIENT_DATA, isMonotonic: true,
    }
  }

  const benchmark = args.benchmarkValue === null ? null : Number(args.benchmarkValue)
  if (benchmark === null || !Number.isFinite(benchmark) || benchmark <= 0) {
    // Without a benchmark there is no meaningful price POSITION, so no curve is
    // produced — the scenarios are returned with their prices and no fabricated
    // probability differences.
    return {
      ...base,
      basePrice: args.scenarios.find((s) => s.isBase)?.totalPrice ?? args.scenarios[0].totalPrice,
      baseProbability: args.baseProbability,
      points: args.scenarios.map((s) => ({
        label: s.name, price: s.totalPrice, pricePosition: 0, percentOfBenchmark: 0,
        probability: args.baseProbability, lower: null, upper: null,
        scenarioId: s.id, isBase: Boolean(s.isBase),
      })),
      assumptions: [
        'No price benchmark is available for this opportunity (no estimated value, forecast estimate or comparable award median).',
        'Without a benchmark, price position cannot be computed, so every scenario is shown at the same modelled probability. No price effect is implied.',
      ],
      validity: SensitivityValidity.INSUFFICIENT_DATA,
      isMonotonic: true,
    }
  }

  const baseScenario = args.scenarios.find((s) => s.isBase) ?? args.scenarios[0]
  const basePriceNum = Number(baseScenario.totalPrice)
  const basePosition = (basePriceNum - benchmark) / benchmark

  const points: PricePoint[] = args.scenarios.map((s) => {
    const priceNum = Number(s.totalPrice)
    const position = Number(((priceNum - benchmark) / benchmark).toFixed(6))
    const probability = probabilityAtPosition(args.baseProbability, basePosition, position, elasticity)
    const lower = args.intervalLowerHalfWidth != null ? Number(Math.max(0, probability - args.intervalLowerHalfWidth).toFixed(4)) : null
    const upper = args.intervalUpperHalfWidth != null ? Number(Math.min(1, probability + args.intervalUpperHalfWidth).toFixed(4)) : null
    return {
      label: s.name,
      price: s.totalPrice,
      pricePosition: position,
      percentOfBenchmark: Number(((priceNum / benchmark) * 100).toFixed(2)),
      probability,
      lower,
      upper,
      scenarioId: s.id,
      isBase: s.id === baseScenario.id,
    }
  }).sort((a, b) => Number(a.price) - Number(b.price))

  const calibrated = args.tenantSampleSize >= MIN_SAMPLES_FOR_CALIBRATED
  assumptions.push(
    `Price position is measured against the ${args.benchmarkSource ?? 'stated'} benchmark of ${args.benchmarkValue}.`,
    `A price-position elasticity of ${elasticity} logit units per 1.0 of relative price is applied; the curve is monotonic, so a higher price never raises the modelled probability.`,
    'Only total evaluated price is modelled. Labour-rate sensitivity is NOT inferred, because total award values do not support conclusions about individual rates.',
    'No price guarantees an award. Evaluation is multi-factor and the contracting officer decides.',
  )
  if (!calibrated) {
    assumptions.push(
      `Your firm has ${args.tenantSampleSize} verified pricing outcome(s); ${MIN_SAMPLES_FOR_CALIBRATED} are needed to calibrate a real price effect. ` +
      'This comparison therefore uses the available model inputs and is labelled UNVALIDATED_SCENARIO_ANALYSIS.',
    )
  }

  return {
    ...base,
    basePrice: baseScenario.totalPrice,
    baseProbability: args.baseProbability,
    points,
    assumptions,
    validity: calibrated ? SensitivityValidity.CALIBRATED : SensitivityValidity.UNVALIDATED_SCENARIO_ANALYSIS,
    isMonotonic: verifyMonotonic(points),
  }
}

/**
 * Resolve the price benchmark, using ONE documented hierarchy so the same
 * opportunity always benchmarks the same way:
 *   1. Opportunity.estimatedValue                (agency's own estimate)
 *   2. Median comparable award (AwardHistory)    (observed market)
 *   3. Linked forecast estimated value           (pre-solicitation estimate)
 * The chosen source is always reported.
 */
export async function resolveBenchmark(
  consultingFirmId: string,
  opportunityId: string,
): Promise<{ value: string | null; source: string | null }> {
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: { estimatedValue: true },
  })
  if (opportunity?.estimatedValue) {
    return { value: opportunity.estimatedValue.toString(), source: 'OPPORTUNITY_ESTIMATE' }
  }

  const awards = await prisma.awardHistory.findMany({
    where: { opportunityId },
    select: { awardAmount: true },
    take: 200,
  })
  const amounts = awards.map((a) => Number(a.awardAmount)).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b)
  if (amounts.length >= 3) {
    const mid = Math.floor(amounts.length / 2)
    const median = amounts.length % 2 === 0 ? (amounts[mid - 1] + amounts[mid]) / 2 : amounts[mid]
    return { value: median.toFixed(2), source: 'AWARD_HISTORY_MEDIAN' }
  }

  const forecast = await prisma.agencyForecast.findFirst({
    where: { consultingFirmId, linkedOpportunityId: opportunityId },
    select: { estimatedValue: true, estimatedValueMax: true },
  })
  const forecastValue = forecast?.estimatedValue ?? forecast?.estimatedValueMax
  if (forecastValue) return { value: forecastValue.toString(), source: 'FORECAST_ESTIMATE' }

  return { value: null, source: null }
}

/**
 * Run and persist a sensitivity analysis. Read-only with respect to pricing:
 * scenarios are read, never written.
 */
export async function runPricingSensitivity(
  consultingFirmId: string,
  opportunityId: string,
  options: {
    /** Ad-hoc user price points, in addition to the stored scenarios. */
    extraScenarios?: ScenarioInput[]
    baseProbability?: number
    intervalLowerHalfWidth?: number | null
    intervalUpperHalfWidth?: number | null
    now?: Date
  } = {},
): Promise<SensitivityResult & { id: string }> {
  const now = options.now ?? new Date()

  const workspace = await prisma.pricingWorkspace.findFirst({
    where: { consultingFirmId, opportunityId },
    select: {
      id: true,
      scenarios: {
        where: { isArchived: false },
        select: { id: true, name: true, totalPrice: true, isPreferred: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })

  // The firm's preferred scenario anchors the curve. Scenarios are READ only —
  // this analysis never writes back to approved pricing.
  const stored: ScenarioInput[] = (workspace?.scenarios ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    totalPrice: (s.totalPrice ?? 0).toString(),
    isBase: s.isPreferred,
  }))
  const scenarios = [...stored, ...(options.extraScenarios ?? [])].filter((s) => Number(s.totalPrice) > 0)

  const benchmark = await resolveBenchmark(consultingFirmId, opportunityId)

  let baseProbability = options.baseProbability
  if (baseProbability === undefined) {
    const opp = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId }, select: { probabilityScore: true } })
    const raw = opp?.probabilityScore ?? 0
    baseProbability = raw > 1 ? raw / 100 : raw
  }
  baseProbability = Math.min(0.999, Math.max(0.001, baseProbability))

  const tenantSampleSize = await prisma.calibrationSample.count({ where: { consultingFirmId } })

  const result = computeSensitivity({
    scenarios,
    benchmarkValue: benchmark.value,
    benchmarkSource: benchmark.source,
    baseProbability,
    intervalLowerHalfWidth: options.intervalLowerHalfWidth ?? null,
    intervalUpperHalfWidth: options.intervalUpperHalfWidth ?? null,
    tenantSampleSize,
  })

  const created = await prisma.pricingSensitivityAnalysis.create({
    data: {
      consultingFirmId,
      opportunityId,
      pricingWorkspaceId: workspace?.id ?? null,
      benchmarkValue: benchmark.value ? new Prisma.Decimal(benchmark.value) : null,
      benchmarkSource: benchmark.source,
      basePrice: result.basePrice ? new Prisma.Decimal(result.basePrice) : null,
      baseProbability: result.baseProbability,
      points: JSON.parse(JSON.stringify(result.points)) as Prisma.InputJsonValue,
      assumptions: result.assumptions,
      validity: result.validity,
      isMonotonic: result.isMonotonic,
      sampleSize: result.sampleSize,
      method: result.method,
      methodVersion: result.methodVersion,
      calculatedAt: now,
    },
    select: { id: true },
  })

  return { ...result, id: created.id }
}
