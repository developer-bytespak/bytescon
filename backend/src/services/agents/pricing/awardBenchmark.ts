// =============================================================
// §7.6 — Comparable public award benchmarking.
//
// THE HARD RULE THIS MODULE EXISTS TO ENFORCE
// A cohort is built from PUBLIC FEDERAL AWARD RECORDS ONLY. This file reads
// exactly one model for its evidence — `AwardHistory`, ingested from
// USAspending/FPDS — plus the public reference tables. It never reads
// PricingWorkspace, PricingScenario, PricingLaborLine, PricingIndirectRate,
// PricingTemplate or ContractLaborRate belonging to ANY firm, including the
// current one. The only private figure in play is the proposed price the
// caller passes in, and that is compared against the cohort, never added to it.
//
// A consequence worth stating plainly: another tenant's pricing cannot move
// this number, because another tenant's pricing is never queried. That is
// asserted directly in `awardBenchmark.isolation.test.ts`.
//
// Everything here is deterministic. No LLM, no heuristic, no sampling.
// =============================================================
import { createHash } from 'crypto'
import { Prisma, type AwardBenchmarkCohort } from '@prisma/client'
import { prisma } from '../../../config/database'

export const BENCHMARK_ALGORITHM_VERSION = 'award-benchmark-v1'

/**
 * Fewer comparable awards than this and no percentile, no median position and
 * no competitive-range verdict is produced. Seven is the point at which a
 * quartile stops being decided by one or two records.
 */
export const MIN_BENCHMARK_COHORT_SIZE = 7

/** At or above this the cohort is strong enough to call SUFFICIENT. */
export const STRONG_BENCHMARK_COHORT_SIZE = 15

/** Default lookback. Older awards are excluded rather than silently included. */
export const DEFAULT_LOOKBACK_MONTHS = 60

/**
 * Value band: an award is comparable in size when it falls within this ratio
 * of the reference price. A 4× spread either way is wide enough to survive
 * option years and narrow enough to exclude a different class of contract.
 */
export const VALUE_BAND_LOW_RATIO = 0.25
export const VALUE_BAND_HIGH_RATIO = 4

/**
 * Award types excluded outright: a multi-year vehicle ceiling is not
 * comparable to a single proposal price, and normalizing one into the other
 * would be fabrication.
 */
export const NON_COMPARABLE_AWARD_TYPES = ['IDIQ', 'BPA', 'GWAC', 'MATOC', 'SATOC', 'IDC']

export type FilterLevel =
  | 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND'
  | 'LEVEL_2_NAICS_AGENCY_BAND'
  | 'LEVEL_3_NAICS_BAND'
  | 'LEVEL_4_NAICS'
  | 'NONE'

export type DataSufficiency = 'INSUFFICIENT_DATA' | 'PARTIAL' | 'SUFFICIENT'

/** The deterministic ladder, in the order it is tried. Never reordered. */
export const FILTER_LADDER: Array<{ level: FilterLevel; relaxed: string | null }> = [
  { level: 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND', relaxed: null },
  { level: 'LEVEL_2_NAICS_AGENCY_BAND', relaxed: 'set-aside' },
  { level: 'LEVEL_3_NAICS_BAND', relaxed: 'agency' },
  { level: 'LEVEL_4_NAICS', relaxed: 'award-value band' },
]

export interface BenchmarkRequest {
  consultingFirmId: string
  opportunityId: string | null
  pricingWorkspaceId: string | null
  pricingScenarioId: string | null
  naics: string | null
  agency: string | null
  setAside: string | null
  /** The reference price the value band is centred on. Never enters the cohort. */
  referencePrice: Prisma.Decimal | null
  now: Date
  lookbackMonths?: number
}

export interface CohortAward {
  awardId: string
  agency: string
  naics: string | null
  setAside: string | null
  awardDate: Date
  awardAmount: Prisma.Decimal
  awardType: string | null
  contractNumber: string | null
  recipientName: string
}

export interface Distribution {
  minimum: Prisma.Decimal | null
  p25: Prisma.Decimal | null
  median: Prisma.Decimal | null
  p75: Prisma.Decimal | null
  maximum: Prisma.Decimal | null
  mean: Prisma.Decimal | null
}

export interface BenchmarkResult {
  filterLevel: FilterLevel
  relaxedFilters: string[]
  naics: string | null
  agency: string | null
  setAside: string | null
  valueBandLow: Prisma.Decimal | null
  valueBandHigh: Prisma.Decimal | null
  periodStart: Date
  periodEnd: Date
  cohortSize: number
  sourceIds: string[]
  excludedSourceIds: string[]
  exclusionReasons: Array<{ awardId: string; reason: string }>
  distribution: Distribution
  dataSufficiency: DataSufficiency
  limitations: string[]
  included: CohortAward[]
  inputHash: string
}

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)

// -------------------------------------------------------------
// Distribution — one implementation, deterministic interpolation
// -------------------------------------------------------------

/**
 * Linear-interpolation percentile (the "R type 7" convention) over a sorted
 * Decimal array.
 *
 * There is exactly ONE percentile implementation in this slice so two callers
 * can never disagree. `p` is a fraction in [0, 1]. Interpolation is done in
 * Decimal, so a value halfway between two cents lands where arithmetic says it
 * should rather than where a float happens to fall.
 */
export function percentile(sortedAscending: Prisma.Decimal[], p: number): Prisma.Decimal | null {
  if (sortedAscending.length === 0) return null
  if (sortedAscending.length === 1) return D(sortedAscending[0])
  if (p <= 0) return D(sortedAscending[0])
  if (p >= 1) return D(sortedAscending[sortedAscending.length - 1])

  const rank = D(p).times(sortedAscending.length - 1)
  const lowerIndex = Math.floor(Number(rank.toFixed(10)))
  const upperIndex = Math.min(lowerIndex + 1, sortedAscending.length - 1)
  const fraction = rank.minus(lowerIndex)

  const lower = D(sortedAscending[lowerIndex])
  const upper = D(sortedAscending[upperIndex])
  return lower.plus(upper.minus(lower).times(fraction)).toDecimalPlaces(2)
}

/** Min, p25, median, p75, max and mean over a Decimal sample. */
export function computeDistribution(values: Prisma.Decimal[]): Distribution {
  if (values.length === 0) {
    return { minimum: null, p25: null, median: null, p75: null, maximum: null, mean: null }
  }
  const sorted = [...values].sort((a, b) => (D(a).lessThan(D(b)) ? -1 : D(a).greaterThan(D(b)) ? 1 : 0))
  const total = sorted.reduce((acc, v) => acc.plus(D(v)), D(0))
  return {
    minimum: D(sorted[0]).toDecimalPlaces(2),
    p25: percentile(sorted, 0.25),
    median: percentile(sorted, 0.5),
    p75: percentile(sorted, 0.75),
    maximum: D(sorted[sorted.length - 1]).toDecimalPlaces(2),
    mean: total.dividedBy(sorted.length).toDecimalPlaces(2),
  }
}

// -------------------------------------------------------------
// Comparability
// -------------------------------------------------------------

export interface RawAward {
  id: string
  awardingAgency: string
  recipientName: string
  awardAmount: Prisma.Decimal
  baseAndAllOptions: Prisma.Decimal | null
  awardDate: Date
  naics: string | null
  awardType: string | null
  contractNumber: string | null
  setAside: string | null
}

/**
 * Is this public award comparable to a single proposal price?
 *
 * Conservative on purpose. A vehicle ceiling, a missing amount, and a
 * non-positive amount are all excluded with a stated reason rather than
 * normalized into something that looks like a unit price.
 */
export function assessComparability(award: RawAward): { comparable: boolean; reason: string | null } {
  if (award.awardAmount === null || award.awardAmount === undefined) {
    return { comparable: false, reason: 'NOT_COMPARABLE: the award records no value.' }
  }
  const amount = D(award.awardAmount)
  if (amount.lessThanOrEqualTo(0)) {
    return { comparable: false, reason: 'NOT_COMPARABLE: the award value is zero or negative.' }
  }

  const type = (award.awardType ?? '').toUpperCase()
  if (NON_COMPARABLE_AWARD_TYPES.some((t) => type.includes(t))) {
    return {
      comparable: false,
      reason: `NOT_COMPARABLE: ${award.awardType} is a multi-award vehicle ceiling, which cannot be compared to a single proposal price.`,
    }
  }

  // A base-and-all-options figure far above the award amount signals a
  // multi-year ceiling wearing a single-award label.
  if (award.baseAndAllOptions !== null) {
    const ceiling = D(award.baseAndAllOptions)
    if (ceiling.greaterThan(amount.times(3))) {
      return {
        comparable: false,
        reason: 'NOT_COMPARABLE: base-and-all-options exceeds the award amount more than threefold, so the record is a multi-year ceiling rather than a single-period price.',
      }
    }
  }

  return { comparable: true, reason: null }
}

/** Two-digit NAICS sector, used only when the ladder relaxes to LEVEL_4. */
function sector(naics: string | null): string | null {
  const digits = (naics ?? '').replace(/[^0-9]/g, '')
  return digits.length >= 2 ? digits.slice(0, 2) : null
}

function normaliseSetAside(v: string | null): string | null {
  const t = (v ?? '').trim().toUpperCase()
  return t && t !== 'NONE' ? t : null
}

/**
 * Deterministic digest of everything that defines this cohort.
 *
 * Identical normalized inputs reuse the cached row; a changed filter, period,
 * band or algorithm version produces a new one.
 */
export function buildCohortHash(args: {
  naics: string | null
  agency: string | null
  setAside: string | null
  valueBandLow: Prisma.Decimal | null
  valueBandHigh: Prisma.Decimal | null
  periodStart: Date
  periodEnd: Date
  filterLevel: FilterLevel
  sourceIds: string[]
}): string {
  const material = {
    algorithm: BENCHMARK_ALGORITHM_VERSION,
    naics: args.naics ?? null,
    agency: (args.agency ?? '').toUpperCase() || null,
    setAside: normaliseSetAside(args.setAside),
    bandLow: args.valueBandLow ? D(args.valueBandLow).toFixed(2) : null,
    bandHigh: args.valueBandHigh ? D(args.valueBandHigh).toFixed(2) : null,
    periodStart: args.periodStart.toISOString().slice(0, 10),
    periodEnd: args.periodEnd.toISOString().slice(0, 10),
    filterLevel: args.filterLevel,
    // Sorted, so award ordering can never change the identity of a cohort.
    sources: [...args.sourceIds].sort(),
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

// -------------------------------------------------------------
// Cohort construction
// -------------------------------------------------------------

/**
 * Load candidate PUBLIC awards.
 *
 * NOTE ON SCOPE — deliberate and load-bearing. This query is NOT filtered by
 * `consultingFirmId`, because `AwardHistory` holds public federal award facts
 * ingested from USAspending/FPDS. Two firms benchmarking the same NAICS should
 * see the same public awards; that is what makes the benchmark meaningful.
 *
 * What matters for isolation is what this query does NOT touch: no pricing
 * model of any firm appears in it, so no tenant's private price can reach a
 * cohort. The negative tests assert exactly that.
 */
async function loadPublicAwards(periodStart: Date, periodEnd: Date): Promise<RawAward[]> {
  const rows = await prisma.awardHistory.findMany({
    where: { awardDate: { gte: periodStart, lte: periodEnd } },
    select: {
      id: true, awardingAgency: true, recipientName: true, awardAmount: true,
      baseAndAllOptions: true, awardDate: true, naics: true, awardType: true, contractNumber: true,
      opportunity: { select: { setAsideType: true } },
    },
    orderBy: { id: 'asc' },
    take: 5000,
  })
  return rows.map((r) => ({
    id: r.id,
    awardingAgency: r.awardingAgency,
    recipientName: r.recipientName,
    awardAmount: r.awardAmount,
    baseAndAllOptions: r.baseAndAllOptions,
    awardDate: r.awardDate,
    naics: r.naics,
    awardType: r.awardType,
    contractNumber: r.contractNumber,
    // The set-aside of the notice the award was recorded against. Public.
    setAside: r.opportunity?.setAsideType ?? null,
  }))
}

/** Does an award pass the filters at a given rung of the ladder? */
function matchesLevel(
  award: RawAward,
  level: FilterLevel,
  req: { naics: string | null; agency: string | null; setAside: string | null },
  band: { low: Prisma.Decimal; high: Prisma.Decimal } | null,
): boolean {
  const naicsMatch = req.naics ? award.naics === req.naics : true
  const sectorMatch = req.naics ? sector(award.naics) === sector(req.naics) : true
  const agencyMatch = req.agency
    ? (award.awardingAgency ?? '').trim().toUpperCase() === req.agency.trim().toUpperCase()
    : true
  const setAsideMatch = normaliseSetAside(req.setAside)
    ? normaliseSetAside(award.setAside) === normaliseSetAside(req.setAside)
    : true
  const bandMatch = band
    ? D(award.awardAmount).greaterThanOrEqualTo(band.low) && D(award.awardAmount).lessThanOrEqualTo(band.high)
    : true

  switch (level) {
    case 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND':
      return naicsMatch && agencyMatch && setAsideMatch && bandMatch
    case 'LEVEL_2_NAICS_AGENCY_BAND':
      return naicsMatch && agencyMatch && bandMatch
    case 'LEVEL_3_NAICS_BAND':
      return naicsMatch && bandMatch
    case 'LEVEL_4_NAICS':
      // The last rung widens NAICS to its sector and drops the value band.
      return sectorMatch
    default:
      return false
  }
}

/**
 * Build the cohort.
 *
 * Walks the ladder from strictest to loosest, stopping at the FIRST rung that
 * reaches the minimum size. Every relaxation is recorded, so a broadened
 * filter is always visible to the reader.
 */
export async function buildAwardBenchmark(req: BenchmarkRequest): Promise<BenchmarkResult> {
  const limitations: string[] = []
  const lookbackMonths = req.lookbackMonths ?? DEFAULT_LOOKBACK_MONTHS
  const periodEnd = req.now
  const periodStart = new Date(req.now)
  periodStart.setUTCMonth(periodStart.getUTCMonth() - lookbackMonths)

  const band = req.referencePrice && D(req.referencePrice).greaterThan(0)
    ? {
        low: D(req.referencePrice).times(VALUE_BAND_LOW_RATIO).toDecimalPlaces(2),
        high: D(req.referencePrice).times(VALUE_BAND_HIGH_RATIO).toDecimalPlaces(2),
      }
    : null

  if (!band) {
    limitations.push('No proposed price was available, so awards could not be filtered to a comparable value band.')
  }
  if (!req.naics) {
    limitations.push('The opportunity records no NAICS code, so awards could not be filtered by industry.')
  }

  const candidates = await loadPublicAwards(periodStart, periodEnd)

  const empty = (): BenchmarkResult => ({
    filterLevel: 'NONE',
    relaxedFilters: [],
    naics: req.naics,
    agency: req.agency,
    setAside: normaliseSetAside(req.setAside),
    valueBandLow: band?.low ?? null,
    valueBandHigh: band?.high ?? null,
    periodStart,
    periodEnd,
    cohortSize: 0,
    sourceIds: [],
    excludedSourceIds: [],
    exclusionReasons: [],
    distribution: computeDistribution([]),
    dataSufficiency: 'INSUFFICIENT_DATA',
    limitations: [
      ...limitations,
      `No comparable public award was found in the last ${lookbackMonths} months. This says nothing about whether the proposed price is right.`,
    ],
    included: [],
    inputHash: '',
  })

  if (candidates.length === 0) {
    limitations.push('No public award record falls inside the lookback period.')
    return empty()
  }

  // Comparability is assessed once, before the ladder, so an award excluded
  // for structure is excluded at every rung with the same stated reason.
  const excludedSourceIds: string[] = []
  const exclusionReasons: Array<{ awardId: string; reason: string }> = []
  const comparable: RawAward[] = []
  const seenContracts = new Set<string>()

  for (const award of candidates) {
    const { comparable: isComparable, reason } = assessComparability(award)
    if (!isComparable) {
      excludedSourceIds.push(award.id)
      exclusionReasons.push({ awardId: award.id, reason: reason! })
      continue
    }
    // The same public contract ingested twice must not count twice.
    const dedupeKey = award.contractNumber?.trim().toUpperCase()
    if (dedupeKey) {
      if (seenContracts.has(dedupeKey)) {
        excludedSourceIds.push(award.id)
        exclusionReasons.push({ awardId: award.id, reason: `NOT_COMPARABLE: duplicate of contract ${dedupeKey}, already counted once.` })
        continue
      }
      seenContracts.add(dedupeKey)
    }
    comparable.push(award)
  }

  if (comparable.length === 0) {
    limitations.push(`${candidates.length} public award(s) fell in the period but none was structurally comparable to a single proposal price.`)
    const result = empty()
    return { ...result, excludedSourceIds, exclusionReasons, limitations: [...result.limitations, ...limitations.slice(-1)] }
  }

  let chosen: { level: FilterLevel; awards: RawAward[]; index: number } | null = null

  for (const [index, rung] of FILTER_LADDER.entries()) {
    // A rung that needs a filter the request cannot supply is skipped rather
    // than silently treated as matching everything.
    if (rung.level === 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND' && !normaliseSetAside(req.setAside)) continue
    if ((rung.level === 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND' || rung.level === 'LEVEL_2_NAICS_AGENCY_BAND') && !req.agency) continue
    if (rung.level !== 'LEVEL_4_NAICS' && !band) continue
    if (!req.naics) continue

    const matched = comparable.filter((a) => matchesLevel(a, rung.level, req, rung.level === 'LEVEL_4_NAICS' ? null : band))
    if (matched.length >= MIN_BENCHMARK_COHORT_SIZE) {
      chosen = { level: rung.level, awards: matched, index }
      break
    }
  }

  // Every rung UP TO AND INCLUDING the one that succeeded names the filter that
  // had to be given up to reach it. Deriving it from the chosen rung rather
  // than from the rungs that failed keeps the list exactly one entry per
  // relaxation actually applied.
  const relaxedFilters = FILTER_LADDER.slice(0, (chosen?.index ?? FILTER_LADDER.length - 1) + 1)
    .map((r) => r.relaxed)
    .filter((r): r is string => r !== null)

  // Nothing reached the minimum. Report the widest attempt honestly rather
  // than pretending the strictest rung produced it.
  if (!chosen) {
    const widest = req.naics
      ? comparable.filter((a) => matchesLevel(a, 'LEVEL_4_NAICS', req, null))
      : []
    const distribution = computeDistribution(widest.map((a) => D(a.awardAmount)))
    const sourceIds = widest.map((a) => a.id)
    limitations.push(
      `Only ${widest.length} comparable public award(s) were found (minimum ${MIN_BENCHMARK_COHORT_SIZE}). ` +
        'No percentile and no competitive-range conclusion was calculated. This is a statement about the available evidence, not about the price.',
    )
    return {
      filterLevel: widest.length > 0 ? 'LEVEL_4_NAICS' : 'NONE',
      relaxedFilters,
      naics: req.naics,
      agency: req.agency,
      setAside: normaliseSetAside(req.setAside),
      valueBandLow: band?.low ?? null,
      valueBandHigh: band?.high ?? null,
      periodStart,
      periodEnd,
      cohortSize: widest.length,
      sourceIds,
      excludedSourceIds,
      exclusionReasons,
      // Below the minimum, statistics stay null. A quartile computed from
      // three records reads as authority it has not earned.
      distribution: widest.length >= MIN_BENCHMARK_COHORT_SIZE ? distribution : computeDistribution([]),
      dataSufficiency: 'INSUFFICIENT_DATA',
      limitations,
      included: widest.map(toCohortAward),
      inputHash: buildCohortHash({
        naics: req.naics, agency: req.agency, setAside: req.setAside,
        valueBandLow: band?.low ?? null, valueBandHigh: band?.high ?? null,
        periodStart, periodEnd, filterLevel: widest.length > 0 ? 'LEVEL_4_NAICS' : 'NONE', sourceIds,
      }),
    }
  }

  if (relaxedFilters.length > 0) {
    limitations.push(
      `The strictest filters returned fewer than ${MIN_BENCHMARK_COHORT_SIZE} awards, so these were relaxed in order: ${relaxedFilters.join(', ')}.`,
    )
  }

  const sorted = [...chosen.awards].sort((a, b) => a.id.localeCompare(b.id))
  const sourceIds = sorted.map((a) => a.id)
  const distribution = computeDistribution(sorted.map((a) => D(a.awardAmount)))

  return {
    filterLevel: chosen.level,
    relaxedFilters,
    naics: req.naics,
    agency: req.agency,
    setAside: normaliseSetAside(req.setAside),
    valueBandLow: band?.low ?? null,
    valueBandHigh: band?.high ?? null,
    periodStart,
    periodEnd,
    cohortSize: sorted.length,
    sourceIds,
    excludedSourceIds,
    exclusionReasons,
    distribution,
    dataSufficiency: sorted.length >= STRONG_BENCHMARK_COHORT_SIZE ? 'SUFFICIENT' : 'PARTIAL',
    limitations,
    included: sorted.map(toCohortAward),
    inputHash: buildCohortHash({
      naics: req.naics, agency: req.agency, setAside: req.setAside,
      valueBandLow: band?.low ?? null, valueBandHigh: band?.high ?? null,
      periodStart, periodEnd, filterLevel: chosen.level, sourceIds,
    }),
  }
}

function toCohortAward(a: RawAward): CohortAward {
  return {
    awardId: a.id,
    agency: a.awardingAgency,
    naics: a.naics,
    setAside: a.setAside,
    awardDate: a.awardDate,
    awardAmount: a.awardAmount,
    awardType: a.awardType,
    contractNumber: a.contractNumber,
    recipientName: a.recipientName,
  }
}

// -------------------------------------------------------------
// Persistence
// -------------------------------------------------------------

/**
 * Cache the cohort against its input hash.
 *
 * Historical evidence is never mutated in place: an identical hash reuses the
 * existing row untouched, and a materially different one becomes a new row
 * with an incremented `cohortVersion`.
 */
export async function persistBenchmarkCohort(args: {
  consultingFirmId: string
  result: BenchmarkResult
  opportunityId: string | null
  pricingWorkspaceId: string | null
  pricingScenarioId: string | null
  staleAt?: Date | null
}): Promise<{ cohort: AwardBenchmarkCohort; created: boolean }> {
  const { result } = args

  const existing = await prisma.awardBenchmarkCohort.findUnique({
    where: { consultingFirmId_inputHash: { consultingFirmId: args.consultingFirmId, inputHash: result.inputHash } },
  })
  if (existing) return { cohort: existing, created: false }

  const priorVersions = await prisma.awardBenchmarkCohort.count({
    where: {
      consultingFirmId: args.consultingFirmId,
      ...(args.pricingScenarioId ? { pricingScenarioId: args.pricingScenarioId } : { opportunityId: args.opportunityId }),
    },
  })

  const cohort = await prisma.awardBenchmarkCohort.create({
    data: {
      consultingFirmId: args.consultingFirmId,
      opportunityId: args.opportunityId,
      pricingWorkspaceId: args.pricingWorkspaceId,
      pricingScenarioId: args.pricingScenarioId,
      inputHash: result.inputHash,
      algorithmVersion: BENCHMARK_ALGORITHM_VERSION,
      cohortVersion: priorVersions + 1,
      filterLevel: result.filterLevel,
      relaxedFilters: result.relaxedFilters,
      naics: result.naics,
      agency: result.agency,
      setAside: result.setAside,
      valueBandLow: result.valueBandLow,
      valueBandHigh: result.valueBandHigh,
      periodStart: result.periodStart,
      periodEnd: result.periodEnd,
      cohortSize: result.cohortSize,
      sourceIds: result.sourceIds,
      excludedSourceIds: result.excludedSourceIds,
      exclusionReasons: JSON.parse(JSON.stringify(result.exclusionReasons)) as Prisma.InputJsonValue,
      minimumValue: result.distribution.minimum,
      p25Value: result.distribution.p25,
      medianValue: result.distribution.median,
      p75Value: result.distribution.p75,
      maximumValue: result.distribution.maximum,
      meanValue: result.distribution.mean,
      distributionData: JSON.parse(JSON.stringify(
        result.included.map((a) => ({
          awardId: a.awardId,
          agency: a.agency,
          naics: a.naics,
          setAside: a.setAside,
          awardDate: a.awardDate.toISOString(),
          awardAmount: D(a.awardAmount).toFixed(2),
          awardType: a.awardType,
          contractNumber: a.contractNumber,
          recipientName: a.recipientName,
          included: true,
        })),
      )) as Prisma.InputJsonValue,
      dataSufficiency: result.dataSufficiency,
      limitations: result.limitations,
      staleAt: args.staleAt ?? null,
    },
  })
  return { cohort, created: true }
}
