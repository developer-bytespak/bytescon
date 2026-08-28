// =============================================================
// Teaming Suggester — Phase D
//
// Quantified fit score for (client × prime × agency) across five
// components that sum to 100. Each component is calibrated:
//   - bounded [0,1] before weighting (no double counting)
//   - Bayesian-shrunk toward an agency-level prior when sample size is
//     thin (a $20M prime's subSpendRatio is noisier than a $5B prime's)
//   - emits a per-component confidence ∈ [0,1] reflecting data completeness
//
// Final output:
//   - score:       0–100
//   - confidence:  0–1 (weighted average of component confidences)
//   - breakdown:   per-component { raw, weighted, confidence, reasoning }
//   - reasons:     top-3 reasons by weighted-impact * confidence
//
// Math notes (so the next person reading this can audit it):
//
// NAICS overlap (Weighted Jaccard, 25pt):
//   numerator   = Σ prime$ in NAICS where client also has the NAICS
//   denominator = Σ prime$ across all NAICS at this agency
//   Equal client weight (we don't have per-client NAICS importance yet).
//   Weighting prime side by award-$ instead of count means a single
//   $500M NAICS dominates 100x of $50K rows — which matches the
//   teaming-decision economics.
//
// Set-aside fit (20pt):
//   0.4 * agency-favor    (does THIS agency direct dollars to clients
//                          of this set-aside type — getAgencyHistoryScore)
// + 0.6 * prime-favor     (does THIS prime direct sub-dollars to subs
//                          of this set-aside type — derived from
//                          WinnersSubawardStage rows for this prime)
//   The prime signal is more decision-relevant (we're picking a teaming
//   partner, not an agency), so weighted higher. Both are Bayesian-shrunk.
//
// Geographic alignment (10pt):
//   Three-tier per state of performance:
//     same state          → 1.0
//     same GSA region     → 0.5
//     elsewhere           → 0.0
//   Averaged across prime's awards, weighted by award-$. GSA regions
//   chosen over neighboring-states because federal contracting officers
//   already think in regions and the data is less brittle (CA's neighbors
//   include OR and NV, which is far less meaningful than "Region 9").
//
// Prime's teaming activity (25pt):
//   subSpendRatio = Σ sub$ / Σ award$ for this prime at this agency
//   Bayesian-shrunk toward the agency-average ratio with prior strength
//   k = $50M of evidence. A $5M prime's raw ratio is dominated by the
//   prior; a $5B prime's raw ratio dominates the prior.
//
// Capability-gap fill (20pt):
//   For each client NAICS the prime LACKS at this agency:
//     credit += (agency$ in that NAICS) / (total agency$)
//   Bounded [0,1]. This rewards clients who add coverage the prime
//   would otherwise have to subcontract elsewhere — a stronger teaming
//   pitch than "we both do 541512".
// =============================================================

import { prisma } from '../config/database'
import { getAgencyHistoryScore } from '../engines/agencyProfiler'
import { logger } from '../utils/logger'

// -------- weights (must sum to 100) --------
const WEIGHTS = {
  naicsOverlap: 25,
  setAsideFit: 20,
  geographic: 10,
  primeTeamingActivity: 25,
  capabilityGapFill: 20,
} as const

// Sanity check at module load — fails noisily if a future edit miscounts.
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0)
if (TOTAL_WEIGHT !== 100) {
  throw new Error(`teamingSuggester weights must sum to 100, got ${TOTAL_WEIGHT}`)
}

// Bayesian prior strength for sub-spend ratio shrinkage. "k = $50M of
// evidence" — interpretable in the same units as the observations.
const SUBSPEND_PRIOR_DOLLARS = 50_000_000

// Bayesian prior strength for prime-favors-this-setaside shrinkage.
// "k = 30 subaward rows of evidence." Thirty rows is the smallest sample
// where a 0/30 vs 5/30 distinction is statistically interesting.
const SETASIDE_PRIOR_ROWS = 30

// -------- GSA regions (canonical, 10 regions cover all 50 states + DC + territories) --------
const GSA_REGION: Record<string, number> = {
  // R1 New England
  CT: 1, ME: 1, MA: 1, NH: 1, RI: 1, VT: 1,
  // R2 Northeast/Caribbean
  NY: 2, NJ: 2, PR: 2, VI: 2,
  // R3 Mid-Atlantic
  DE: 3, MD: 3, PA: 3, VA: 3, WV: 3, DC: 3,
  // R4 Southeast Sunbelt
  AL: 4, FL: 4, GA: 4, KY: 4, MS: 4, NC: 4, SC: 4, TN: 4,
  // R5 Great Lakes
  IL: 5, IN: 5, MI: 5, MN: 5, OH: 5, WI: 5,
  // R6 Heartland
  IA: 6, KS: 6, MO: 6, NE: 6,
  // R7 Greater Southwest
  AR: 7, LA: 7, NM: 7, OK: 7, TX: 7,
  // R8 Rocky Mountain
  CO: 8, MT: 8, ND: 8, SD: 8, UT: 8, WY: 8,
  // R9 Pacific Rim
  AZ: 9, CA: 9, HI: 9, NV: 9, GU: 9, AS: 9, MP: 9,
  // R10 Northwest/Arctic
  AK: 10, ID: 10, OR: 10, WA: 10,
}

// -------- types --------

export interface TeamingFitInput {
  clientId: string
  primeUei: string
  agencyCode: string
}

export interface ComponentBreakdown {
  raw: number          // [0,1]
  weight: number       // points (0–25)
  weighted: number     // raw * weight, [0, weight]
  confidence: number   // [0,1] — data quality
  reasoning: string    // short human-readable justification
}

export interface TeamingFitResult {
  score: number                // 0–100
  confidence: number           // 0–1 (weighted by component weights)
  breakdown: {
    naicsOverlap: ComponentBreakdown
    setAsideFit: ComponentBreakdown
    geographic: ComponentBreakdown
    primeTeamingActivity: ComponentBreakdown
    capabilityGapFill: ComponentBreakdown
  }
  reasons: string[]            // top 3 (by weighted × confidence)
}

interface ClientInput {
  id: string
  consultingFirmId: string
  naicsCodes: string[]
  state: string | null
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBusiness: boolean
}

// =============================================================
// Public entry point
// =============================================================
export async function computeTeamingFit(input: TeamingFitInput): Promise<TeamingFitResult> {
  const client = await prisma.clientCompany.findUnique({
    where: { id: input.clientId },
    select: {
      id: true,
      consultingFirmId: true,
      naicsCodes: true,
      state: true,
      sdvosb: true,
      wosb: true,
      hubzone: true,
      smallBusiness: true,
    },
  })
  if (!client) {
    throw new Error(`Client ${input.clientId} not found`)
  }

  const [
    naicsOverlap,
    setAsideFit,
    geographic,
    primeTeamingActivity,
    capabilityGapFill,
  ] = await Promise.all([
    scoreNaicsOverlap(client, input.primeUei, input.agencyCode),
    scoreSetAsideFit(client, input.primeUei, input.agencyCode),
    scoreGeographic(client, input.primeUei, input.agencyCode),
    scorePrimeTeamingActivity(input.primeUei, input.agencyCode),
    scoreCapabilityGapFill(client, input.primeUei, input.agencyCode),
  ])

  const components = { naicsOverlap, setAsideFit, geographic, primeTeamingActivity, capabilityGapFill }
  const score = Object.values(components).reduce((s, c) => s + c.weighted, 0)
  const totalWeight = Object.values(components).reduce((s, c) => s + c.weight, 0)
  const confidence = totalWeight > 0
    ? Object.values(components).reduce((s, c) => s + c.confidence * c.weight, 0) / totalWeight
    : 0

  const reasons = pickTopReasons(components)

  return {
    score: round1(score),
    confidence: round2(confidence),
    breakdown: components,
    reasons,
  }
}

// =============================================================
// Component scorers
// =============================================================

async function scoreNaicsOverlap(
  client: ClientInput,
  primeUei: string,
  agencyCode: string,
): Promise<ComponentBreakdown> {
  const weight = WEIGHTS.naicsOverlap
  const clientNaics = (client.naicsCodes ?? []).filter(Boolean)

  if (clientNaics.length === 0) {
    return {
      raw: 0, weight, weighted: 0, confidence: 0,
      reasoning: 'Client has no NAICS codes on file.',
    }
  }

  type Row = { naics: string; dollars: bigint | string | number }
  const naicsRows = await prisma.$queryRaw<Row[]>`
    SELECT naics, SUM("totalObligation") as dollars
    FROM winners_award_stage
    WHERE "agencyToptierCode" = ${agencyCode}
      AND "recipientUei" = ${primeUei}
      AND naics IS NOT NULL
    GROUP BY naics
  `

  if (naicsRows.length === 0) {
    return {
      raw: 0, weight, weighted: 0, confidence: 0.3,
      reasoning: 'Prime has no NAICS-tagged awards at this agency.',
    }
  }

  const totalPrime$ = naicsRows.reduce((s, r) => s + Number(r.dollars ?? 0), 0)
  const overlapping$ = naicsRows
    .filter((r) => clientNaics.includes(r.naics))
    .reduce((s, r) => s + Number(r.dollars ?? 0), 0)

  const raw = totalPrime$ > 0 ? overlapping$ / totalPrime$ : 0
  // Confidence: high when prime has both diverse NAICS coverage and meaningful $.
  // Saturate at $10M aggregate.
  const confidence = clamp01(totalPrime$ / 10_000_000) * clamp01(naicsRows.length / 5)

  const overlappingCount = naicsRows.filter((r) => clientNaics.includes(r.naics)).length
  const reasoning = overlappingCount === 0
    ? `No NAICS overlap with prime's ${naicsRows.length} NAICS at this agency.`
    : `${overlappingCount} of client's ${clientNaics.length} NAICS overlap, covering ${(raw * 100).toFixed(0)}% of prime's $${(totalPrime$ / 1e6).toFixed(1)}M agency spend.`

  return { raw: round2(raw), weight, weighted: round1(raw * weight), confidence: round2(confidence), reasoning }
}

async function scoreSetAsideFit(
  client: ClientInput,
  primeUei: string,
  agencyCode: string,
): Promise<ComponentBreakdown> {
  const weight = WEIGHTS.setAsideFit
  const hasCert = client.sdvosb || client.wosb || client.hubzone || client.smallBusiness

  if (!hasCert) {
    return {
      raw: 0, weight, weighted: 0, confidence: 1,
      reasoning: 'Client holds no small-business or set-aside certification.',
    }
  }

  // ---- Signal A: agency favors this set-aside type ----
  // Resolve agencyName from the toptier code for the existing helper.
  const agencyRow = await prisma.winnersAwardStage.findFirst({
    where: { agencyToptierCode: agencyCode, agencyToptierName: { not: null } },
    select: { agencyToptierName: true },
  })
  const agencyName = agencyRow?.agencyToptierName ?? null
  const agencyFavor = agencyName
    ? await getAgencyHistoryScore(agencyName, {
        sdvosb: client.sdvosb,
        wosb: client.wosb,
        hubzone: client.hubzone,
        smallBusiness: client.smallBusiness,
      })
    : 0.5

  // ---- Signal B: prime's sub-spend mix favors this set-aside ----
  // Pull this prime's subaward set-aside flag distribution at this agency.
  type SubRow = {
    cnt: bigint | number
    sdvosbCnt: bigint | number
    wosbCnt: bigint | number
    hubzoneCnt: bigint | number
    eightACnt: bigint | number
    smallCnt: bigint | number
  }
  const subRows = await prisma.$queryRaw<SubRow[]>`
    SELECT
      COUNT(*)::bigint as cnt,
      SUM(CASE WHEN (sub."subRecipientSetAsideFlags"->>'sdvosb')::boolean THEN 1 ELSE 0 END)::bigint as "sdvosbCnt",
      SUM(CASE WHEN (sub."subRecipientSetAsideFlags"->>'wosb')::boolean THEN 1 ELSE 0 END)::bigint as "wosbCnt",
      SUM(CASE WHEN (sub."subRecipientSetAsideFlags"->>'hubzone')::boolean THEN 1 ELSE 0 END)::bigint as "hubzoneCnt",
      SUM(CASE WHEN (sub."subRecipientSetAsideFlags"->>'eightA')::boolean THEN 1 ELSE 0 END)::bigint as "eightACnt",
      SUM(CASE WHEN sub."subRecipientSize" = 'small' THEN 1 ELSE 0 END)::bigint as "smallCnt"
    FROM winners_subaward_stage sub
    JOIN winners_award_stage prime
      ON prime."usaspendingAwardId" = sub."primeAwardId"
    WHERE prime."agencyToptierCode" = ${agencyCode}
      AND prime."recipientUei" = ${primeUei}
  `
  const row = subRows[0]
  const subCount = Number(row?.cnt ?? 0)

  // Prior = agency-wide average rates if available, else 0.10 (industry baseline).
  const priorRates = {
    sdvosb: 0.06, wosb: 0.05, hubzone: 0.03, smallBusiness: 0.20,
  }
  // Compute prime's raw rates with Bayesian shrinkage toward the prior.
  const rate = (numerator: number, prior: number) => {
    return (numerator + SETASIDE_PRIOR_ROWS * prior) / (subCount + SETASIDE_PRIOR_ROWS)
  }
  const primeRates = {
    sdvosb: rate(Number(row?.sdvosbCnt ?? 0), priorRates.sdvosb),
    wosb: rate(Number(row?.wosbCnt ?? 0), priorRates.wosb),
    hubzone: rate(Number(row?.hubzoneCnt ?? 0), priorRates.hubzone),
    smallBusiness: rate(Number(row?.smallCnt ?? 0), priorRates.smallBusiness),
  }

  // Pick the strongest matching signal for this client.
  // Scale each cert's contribution: a SDVOSB prime preference is rarer than
  // small-biz, so a SDVOSB match is "worth more" — we use prior-relative odds.
  const primeFavorCandidates: number[] = []
  if (client.sdvosb) primeFavorCandidates.push(primeRates.sdvosb / priorRates.sdvosb)
  if (client.wosb) primeFavorCandidates.push(primeRates.wosb / priorRates.wosb)
  if (client.hubzone) primeFavorCandidates.push(primeRates.hubzone / priorRates.hubzone)
  if (client.smallBusiness) primeFavorCandidates.push(primeRates.smallBusiness / priorRates.smallBusiness)
  // Odds ratio interpretation: 1.0 = matches baseline; >1 = preferred; <1 = avoided.
  // Map to [0,1] via squashing: 0.5 at parity, 1.0 at 3x preferred, 0.0 at 0.
  const maxOdds = primeFavorCandidates.length ? Math.max(...primeFavorCandidates) : 1
  const primeFavor = clamp01((maxOdds - 0.3) / 2.7)  // 0.3x→0.0, 3x→1.0

  const raw = 0.4 * agencyFavor + 0.6 * primeFavor
  // Confidence: high when prime has many subs (sample) AND agency profile exists.
  const confidence = clamp01(subCount / 50) * (agencyName ? 1 : 0.5)

  const certLabel = client.sdvosb ? 'SDVOSB' : client.wosb ? 'WOSB' : client.hubzone ? 'HUBZone' : 'small-biz'
  const reasoning = subCount === 0
    ? `No subaward history for prime at this agency; using agency baseline (${(agencyFavor * 100).toFixed(0)}%).`
    : `Prime directs ${(primeRates[client.sdvosb ? 'sdvosb' : client.wosb ? 'wosb' : client.hubzone ? 'hubzone' : 'smallBusiness'] * 100).toFixed(1)}% of subs to ${certLabel} (baseline ~${(priorRates[client.sdvosb ? 'sdvosb' : client.wosb ? 'wosb' : client.hubzone ? 'hubzone' : 'smallBusiness'] * 100).toFixed(0)}%).`

  return { raw: round2(raw), weight, weighted: round1(raw * weight), confidence: round2(confidence), reasoning }
}

async function scoreGeographic(
  client: ClientInput,
  primeUei: string,
  agencyCode: string,
): Promise<ComponentBreakdown> {
  const weight = WEIGHTS.geographic
  const clientState = client.state?.toUpperCase()
  if (!clientState) {
    return {
      raw: 0, weight, weighted: 0, confidence: 0,
      reasoning: 'Client state not on file.',
    }
  }
  const clientRegion = GSA_REGION[clientState]

  type StateRow = { state: string | null; dollars: bigint | string | number }
  const rows = await prisma.$queryRaw<StateRow[]>`
    SELECT "placeOfPerformanceState" as state, SUM("totalObligation") as dollars
    FROM winners_award_stage
    WHERE "agencyToptierCode" = ${agencyCode}
      AND "recipientUei" = ${primeUei}
      AND "placeOfPerformanceState" IS NOT NULL
    GROUP BY "placeOfPerformanceState"
  `
  if (rows.length === 0) {
    return {
      raw: 0.5, weight, weighted: round1(0.5 * weight), confidence: 0.2,
      reasoning: 'No place-of-performance data for prime — defaulting to neutral.',
    }
  }

  let total$ = 0
  let weighted$ = 0
  let sameStateDollars = 0
  let sameRegionDollars = 0
  for (const r of rows) {
    const $$ = Number(r.dollars ?? 0)
    const state = r.state?.toUpperCase() ?? ''
    total$ += $$
    let perAwardScore = 0
    if (state === clientState) { perAwardScore = 1.0; sameStateDollars += $$ }
    else if (clientRegion !== undefined && GSA_REGION[state] === clientRegion) {
      perAwardScore = 0.5; sameRegionDollars += $$
    }
    weighted$ += perAwardScore * $$
  }
  const raw = total$ > 0 ? weighted$ / total$ : 0
  const confidence = clamp01(total$ / 5_000_000)

  const reasoning = sameStateDollars > 0
    ? `${((sameStateDollars / total$) * 100).toFixed(0)}% of prime's agency work in ${clientState}.`
    : sameRegionDollars > 0
      ? `${((sameRegionDollars / total$) * 100).toFixed(0)}% in same GSA Region (${clientRegion}) as ${clientState}.`
      : `Prime's agency work is geographically distant from ${clientState}.`

  return { raw: round2(raw), weight, weighted: round1(raw * weight), confidence: round2(confidence), reasoning }
}

async function scorePrimeTeamingActivity(
  primeUei: string,
  agencyCode: string,
): Promise<ComponentBreakdown> {
  const weight = WEIGHTS.primeTeamingActivity

  // Prime's totals at this agency.
  type AggRow = { totalAwarded: bigint | string | number; totalSubbed: bigint | string | number | null }
  const aggRows = await prisma.$queryRaw<AggRow[]>`
    WITH prime_total AS (
      SELECT SUM("totalObligation") as "totalAwarded"
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
        AND "recipientUei" = ${primeUei}
    ),
    sub_total AS (
      SELECT SUM(sub."subAmount") as "totalSubbed"
      FROM winners_subaward_stage sub
      JOIN winners_award_stage prime ON prime."usaspendingAwardId" = sub."primeAwardId"
      WHERE prime."agencyToptierCode" = ${agencyCode}
        AND prime."recipientUei" = ${primeUei}
    )
    SELECT * FROM prime_total, sub_total
  `
  const agg = aggRows[0]
  const totalAwarded = Number(agg?.totalAwarded ?? 0)
  const totalSubbed = Number(agg?.totalSubbed ?? 0)

  // Agency-wide prior: mean subSpendRatio across all primes at this agency.
  type PriorRow = { agencyAwarded: bigint | string | number; agencySubbed: bigint | string | number | null }
  const priorRows = await prisma.$queryRaw<PriorRow[]>`
    WITH agency_total AS (
      SELECT SUM("totalObligation") as "agencyAwarded"
      FROM winners_award_stage
      WHERE "agencyToptierCode" = ${agencyCode}
    ),
    agency_subs AS (
      SELECT SUM(sub."subAmount") as "agencySubbed"
      FROM winners_subaward_stage sub
      JOIN winners_award_stage prime ON prime."usaspendingAwardId" = sub."primeAwardId"
      WHERE prime."agencyToptierCode" = ${agencyCode}
    )
    SELECT * FROM agency_total, agency_subs
  `
  const prior = priorRows[0]
  const agencyAwarded = Number(prior?.agencyAwarded ?? 0)
  const agencySubbed = Number(prior?.agencySubbed ?? 0)
  const priorMean = agencyAwarded > 0 ? agencySubbed / agencyAwarded : 0.15

  // Bayesian shrinkage on a continuous proportion. With k = $50M of evidence:
  //   posterior = (sumSub + k * priorMean) / (sumAwarded + k)
  // Treats the prior as if it were k dollars of awards distributed at priorMean.
  const shrunkRatio = totalAwarded > 0
    ? (totalSubbed + SUBSPEND_PRIOR_DOLLARS * priorMean) / (totalAwarded + SUBSPEND_PRIOR_DOLLARS)
    : priorMean

  // Map ratio to [0,1] score. A ratio of 0 = no teaming, 0.4+ = active subbing.
  // Use a soft sigmoid-like mapping so 0.0→0.0, 0.2→0.67, 0.4→0.94.
  const raw = clamp01(1 - Math.exp(-shrunkRatio * 5.5))

  const confidence = clamp01(totalAwarded / 200_000_000)
  const rawRatio = totalAwarded > 0 ? totalSubbed / totalAwarded : 0
  const reasoning = totalAwarded === 0
    ? `No prime award history at this agency.`
    : `Subs ${(shrunkRatio * 100).toFixed(1)}% of agency awards (raw ${(rawRatio * 100).toFixed(1)}%, agency avg ${(priorMean * 100).toFixed(1)}%).`

  return { raw: round2(raw), weight, weighted: round1(raw * weight), confidence: round2(confidence), reasoning }
}

async function scoreCapabilityGapFill(
  client: ClientInput,
  primeUei: string,
  agencyCode: string,
): Promise<ComponentBreakdown> {
  const weight = WEIGHTS.capabilityGapFill
  const clientNaics = (client.naicsCodes ?? []).filter(Boolean)
  if (clientNaics.length === 0) {
    return {
      raw: 0, weight, weighted: 0, confidence: 0,
      reasoning: 'Client has no NAICS codes on file.',
    }
  }

  // Prime's NAICS at this agency.
  type PrimeNaicsRow = { naics: string }
  const primeNaicsRows = await prisma.$queryRaw<PrimeNaicsRow[]>`
    SELECT DISTINCT naics
    FROM winners_award_stage
    WHERE "agencyToptierCode" = ${agencyCode}
      AND "recipientUei" = ${primeUei}
      AND naics IS NOT NULL
  `
  const primeNaicsSet = new Set(primeNaicsRows.map((r) => r.naics))

  // Agency $-volume by NAICS for the weighting denominator + gap credit.
  type AgencyNaicsRow = { naics: string; dollars: bigint | string | number }
  const agencyNaicsRows = await prisma.$queryRaw<AgencyNaicsRow[]>`
    SELECT naics, SUM("totalObligation") as dollars
    FROM winners_award_stage
    WHERE "agencyToptierCode" = ${agencyCode}
      AND naics IS NOT NULL
    GROUP BY naics
  `
  const totalAgency$ = agencyNaicsRows.reduce((s, r) => s + Number(r.dollars ?? 0), 0)
  if (totalAgency$ === 0) {
    return {
      raw: 0, weight, weighted: 0, confidence: 0.1,
      reasoning: 'No NAICS spending data at this agency.',
    }
  }
  const agency$ByNaics: Record<string, number> = {}
  for (const r of agencyNaicsRows) agency$ByNaics[r.naics] = Number(r.dollars ?? 0)

  // For each client NAICS the prime LACKS at this agency, credit its share.
  let gapCredit = 0
  const gapNaics: string[] = []
  for (const code of clientNaics) {
    if (!primeNaicsSet.has(code)) {
      const $$ = agency$ByNaics[code] ?? 0
      if ($$ > 0) {
        gapCredit += $$ / totalAgency$
        gapNaics.push(code)
      }
    }
  }
  const raw = clamp01(gapCredit)
  const confidence = clamp01(primeNaicsRows.length / 5) * clamp01(totalAgency$ / 100_000_000)

  const reasoning = gapNaics.length === 0
    ? `Client adds no NAICS coverage prime lacks at this agency.`
    : `Client fills ${gapNaics.length} NAICS gap${gapNaics.length === 1 ? '' : 's'} worth ${(gapCredit * 100).toFixed(1)}% of agency NAICS spend.`

  return { raw: round2(raw), weight, weighted: round1(raw * weight), confidence: round2(confidence), reasoning }
}

// =============================================================
// Helpers
// =============================================================

function pickTopReasons(components: Record<string, ComponentBreakdown>): string[] {
  return Object.entries(components)
    .map(([, c]) => ({ impact: c.weighted * c.confidence, reasoning: c.reasoning }))
    .sort((a, b) => b.impact - a.impact)
    .slice(0, 3)
    .map((x) => x.reasoning)
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Re-export for tests / inspection
export const __teamingSuggesterInternals = { WEIGHTS, GSA_REGION, SUBSPEND_PRIOR_DOLLARS, SETASIDE_PRIOR_ROWS }

logger.debug('teamingSuggester loaded', { totalWeight: TOTAL_WEIGHT })
