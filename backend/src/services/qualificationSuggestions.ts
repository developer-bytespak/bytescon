// =============================================================
// Suggested scorecard scores — so qualification starts from the firm's own
// records instead of a blank form.
//
// For each default criterion (scorecardScoring.DEFAULT_CRITERIA) this proposes
// a 0–100 score and the reason, from data Bytescon already holds:
//   capability_fit    NAICS match + capability keywords found in the notice
//   eligibility       the readiness check's SAM and set-aside items
//   past_performance  relevant projects (same agency, NAICS or keywords)
//   relationship      past work for this agency
//   timeline          days left before the response deadline
//   competition       bidder counts and incumbent signals
//   pricing           the Pricing agent's calculations: where your priced
//                     scenario sits among comparable public awards, or, before
//                     you've priced it, how the notice's estimate compares
//   strategic_value   new agency (market entry), recompete / incumbency, and
//                     the contract's size against your annual revenue
// Capacity gets no score — guessing it wrong means winning work you can't
// staff — but its note lists the facts to weigh (active contracts, bids in
// progress, headcount). A firm's own criteria are left alone.
//
// Suggestions are a starting point the person reviews; they never record a
// decision. Pure: the loader below gathers the inputs.
// =============================================================
import { prisma } from '../config/database'
import { NotFoundError } from '../utils/errors'
import { computeNaicsOverlap, matchCapabilityKeywords } from '../engines/probabilityEngine'
import { Prisma } from '@prisma/client'
import { loadBidReadiness } from './bidReadinessLoader'
import type { BidReadinessResult, ReadinessItem } from './bidReadiness'
import { buildAwardBenchmark, MIN_BENCHMARK_COHORT_SIZE } from './agents/pricing/awardBenchmark'
import { assessCompetitiveRange, type RangeState } from './agents/pricing/competitiveRange'

export interface Suggestion {
  /** 0–100, or null when there is no data: a person scores it. */
  score: number | null
  note: string
}

export interface SuggestionInput {
  opportunity: {
    title: string
    description: string | null
    agency: string
    naicsCode: string | null
    responseDeadline: Date
    competitionCount: number | null
    offersReceived: number | null
    incumbentProbability: number | null
    incumbentSignalDetected: boolean
    estimatedValue?: number | null
    recompeteFlag?: boolean
    historicalWinner?: string | null
  }
  company: { name: string; naicsCodes: string[]; capabilityKeywords: string[]; annualRevenue?: number | null; employeeCount?: number | null }
  readiness: BidReadinessResult
  pastPerformance: Array<{ customerName: string; customerAgency: string | null; naicsCode: string | null; relevanceTags: string[]; scopeSummary: string }>
  /** From the Pricing agent's calculations (agents/pricing). */
  pricing?: {
    /** Your priced scenario's total, when one exists. */
    proposedPrice: number | null
    rangeState: RangeState | null
    percentile: number | null
    cohortSize: number
    p25: number | null
    median: number | null
    p75: number | null
  }
  /** Work already on the go, to weigh capacity. */
  workload?: { activeContracts: number; bidsInProgress: number }
  now?: Date
}

const DAY_MS = 86_400_000
const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)))
const NO_DATA = 'Your judgement: Bytescon has no records to suggest a score from.'

/** Agency names compared on their significant words ("Department of the Army" ~ "U.S. Army"). */
const agencyWords = (s: string | null | undefined) =>
  new Set((s ?? '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !['the', 'and', 'department', 'dept', 'office', 'agency', 'administration', 'u.s', 'united', 'states'].includes(w)))
function sameAgency(a: string | null | undefined, b: string | null | undefined): boolean {
  const wa = agencyWords(a)
  return [...agencyWords(b)].some((w) => wa.has(w))
}

function capabilityFit(i: SuggestionInput): Suggestion {
  const overlap = computeNaicsOverlap(i.company.naicsCodes, i.opportunity.naicsCode ?? '')
  const keywords = matchCapabilityKeywords(i.company.capabilityKeywords, `${i.opportunity.title}\n${i.opportunity.description ?? ''}`)
  const base = overlap >= 1 ? 80 : overlap >= 0.6 ? 60 : overlap >= 0.3 ? 35 : 15
  const naicsNote = !i.opportunity.naicsCode
    ? 'The notice has no NAICS code'
    : overlap >= 1 ? `NAICS ${i.opportunity.naicsCode} is one of your codes`
      : overlap >= 0.6 ? `NAICS ${i.opportunity.naicsCode} is in the same industry group as your codes`
        : overlap >= 0.3 ? `NAICS ${i.opportunity.naicsCode} is in the same sector as your codes`
          : `NAICS ${i.opportunity.naicsCode} does not match your codes`
  const kwNote = keywords.length ? `; your capabilities ${keywords.map((k) => `"${k}"`).join(', ')} appear in the notice` : ''
  return { score: clamp(base + Math.min(20, keywords.length * 10)), note: `${naicsNote}${kwNote}.` }
}

function eligibility(i: SuggestionInput): Suggestion {
  const items = i.readiness.items.filter((it) => it.key === 'SET_ASIDE' || it.key === 'SAM')
  const worst = (it: ReadinessItem) => (it.status === 'FAIL' ? (it.blocking === 'HARD' ? 0 : 30) : it.status === 'WARN' ? 60 : 100)
  const score = items.length ? Math.min(...items.map(worst)) : 50
  const lead = items.find((it) => worst(it) === score) ?? items[0]
  return { score, note: lead ? `${lead.label}: ${lead.detail}` : 'No registration records to check eligibility against.' }
}

function relevantProjects(i: SuggestionInput) {
  const naics4 = (i.opportunity.naicsCode ?? '').slice(0, 4)
  return i.pastPerformance.filter((p) =>
    sameAgency(p.customerAgency ?? p.customerName, i.opportunity.agency)
    || (naics4.length === 4 && ((p.naicsCode ?? '').startsWith(naics4) || p.relevanceTags.some((t) => t.startsWith(naics4))))
    // A project and the notice both mentioning one of the company's capabilities.
    || (matchCapabilityKeywords(i.company.capabilityKeywords, p.scopeSummary).length > 0
      && matchCapabilityKeywords(i.company.capabilityKeywords, `${i.opportunity.title}\n${i.opportunity.description ?? ''}`).length > 0))
}

function pastPerformance(i: SuggestionInput): Suggestion {
  const total = i.pastPerformance.length
  if (total === 0) return { score: 0, note: 'No past-performance projects on record.' }
  const relevant = relevantProjects(i).length
  const score = relevant >= 3 ? 90 : relevant === 2 ? 75 : relevant === 1 ? 60 : 30
  return {
    score,
    note: relevant
      ? `${relevant} of your ${total} projects are relevant (same agency, industry or capabilities).`
      : `None of your ${total} projects match this agency, industry or capabilities.`,
  }
}

function relationship(i: SuggestionInput): Suggestion {
  const withAgency = i.pastPerformance.filter((p) => sameAgency(p.customerAgency ?? p.customerName, i.opportunity.agency)).length
  if (withAgency === 0) return { score: 20, note: `No past work for ${i.opportunity.agency} on record.` }
  return { score: withAgency >= 2 ? 80 : 60, note: `${withAgency} past project${withAgency === 1 ? '' : 's'} for ${i.opportunity.agency}.` }
}

function timeline(i: SuggestionInput): Suggestion {
  const days = Math.floor((i.opportunity.responseDeadline.getTime() - (i.now ?? new Date()).getTime()) / DAY_MS)
  if (days < 0) return { score: 0, note: 'The response deadline has passed.' }
  const score = days >= 30 ? 90 : days >= 21 ? 75 : days >= 14 ? 60 : days >= 7 ? 40 : days >= 3 ? 20 : 5
  return { score, note: `${days} day${days === 1 ? '' : 's'} until the response deadline.` }
}

function competition(i: SuggestionInput): Suggestion {
  const o = i.opportunity
  const bidders = o.offersReceived ?? o.competitionCount
  const incumbent = o.incumbentSignalDetected || (o.incumbentProbability ?? 0) >= 0.5
  if (bidders == null && o.incumbentProbability == null && !o.incumbentSignalDetected) {
    return { score: null, note: 'No competition data yet for this notice: your judgement.' }
  }
  let score = 60
  const notes: string[] = []
  if (bidders != null) {
    score += bidders <= 3 ? 15 : bidders > 8 ? -20 : 0
    notes.push(`about ${bidders} bidder${bidders === 1 ? '' : 's'} on similar awards`)
  }
  if (incumbent) { score -= 20; notes.push('an incumbent is likely') }
  const sa = i.readiness.items.find((it) => it.key === 'SET_ASIDE')
  if (sa?.status === 'PASS' && !/not set aside/i.test(sa.detail)) { score += 10; notes.push('the set-aside narrows the field and you qualify') }
  const text = notes.join('; ')
  return { score: clamp(score), note: `${text.charAt(0).toUpperCase()}${text.slice(1)}.` }
}

/** Above this upper/lower-quartile ratio, comparable awards are too varied to place an estimate. */
export const WIDE_SPREAD_RATIO = 6

const usd = (n: number) => n >= 1_000_000
  ? `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  : n >= 1_000 ? `$${Math.round(n / 1_000)}K` : `$${Math.round(n)}`

function pricing(i: SuggestionInput): Suggestion {
  const p = i.pricing
  if (!p) return { score: null, note: NO_DATA }
  const range = p.p25 != null && p.p75 != null ? `${usd(p.p25)}–${usd(p.p75)}` : null
  const typical = p.median != null ? `, typically ${usd(p.median)}` : ''
  // Your own price, positioned among comparable awards.
  if (p.proposedPrice != null && p.rangeState && p.rangeState !== 'INSUFFICIENT_DATA') {
    const where = p.percentile != null ? ` (${Math.round(p.percentile)}th percentile of ${p.cohortSize} comparable awards)` : ''
    const byState: Record<Exclude<RangeState, 'INSUFFICIENT_DATA'>, Suggestion> = {
      WITHIN_HISTORICAL_RANGE: { score: 80, note: `Your price ${usd(p.proposedPrice)} is within the usual range${where}.` },
      BELOW_HISTORICAL_RANGE: { score: 60, note: `Your price ${usd(p.proposedPrice)} is below comparable awards${where}: competitive, but check your margin.` },
      ABOVE_HISTORICAL_RANGE: { score: 35, note: `Your price ${usd(p.proposedPrice)} is above comparable awards${where}: check the scope justifies it.` },
      EXTREME_OUTLIER: { score: 15, note: `Your price ${usd(p.proposedPrice)} is far outside comparable awards${where}: review it.` },
    }
    return byState[p.rangeState]
  }
  if (p.cohortSize < MIN_BENCHMARK_COHORT_SIZE || !range) {
    return { score: null, note: `Not enough comparable public awards (${p.cohortSize}) to judge pricing yet: your judgement. Pricing it in the Pricing workspace gives a better read.` }
  }
  // Not priced yet: what the market pays for this kind of work. When those
  // awards are spread too widely, an estimate landing among them says nothing.
  if (p.p25 != null && p.p75 != null && p.p25 > 0 && p.p75 / p.p25 > WIDE_SPREAD_RATIO) {
    return { score: 60, note: `Similar awards vary too widely (${range}${typical}) to judge from the estimate. Price it in the Pricing workspace to compare your own number.` }
  }
  const est = i.opportunity.estimatedValue ?? null
  if (est == null) return { score: 60, note: `Similar awards: ${range}${typical} (${p.cohortSize} awards). The notice gives no estimate; price it to compare.` }
  const inRange = p.p25 != null && p.p75 != null && est >= p.p25 && est <= p.p75
  return inRange
    ? { score: 65, note: `Similar awards: ${range}${typical}. The estimate of ${usd(est)} is in that range. Price it to compare your own number.` }
    : { score: 55, note: `Similar awards: ${range}${typical}. The estimate of ${usd(est)} is ${est > (p.p75 ?? est) ? 'above' : 'below'} that range: check the scope.` }
}

function strategicValue(i: SuggestionInput): Suggestion {
  let score = 50
  const notes: string[] = []
  const withAgency = i.pastPerformance.filter((p) => sameAgency(p.customerAgency ?? p.customerName, i.opportunity.agency)).length
  if (withAgency === 0) { score += 15; notes.push(`a new agency for you (market entry)`) }
  else if (withAgency >= 2) { score += 5; notes.push(`deepens an existing relationship (${withAgency} past projects)`) }
  const winner = (i.opportunity.historicalWinner ?? '').toLowerCase()
  const isIncumbent = !!winner && agencyWords(i.company.name).size > 0 && [...agencyWords(i.company.name)].every((w) => winner.includes(w))
  if (isIncumbent) { score += 25; notes.push('you appear to be the incumbent: worth defending') }
  else if (i.opportunity.recompeteFlag) { score += 5; notes.push('a recompete, with follow-on potential') }
  const est = i.opportunity.estimatedValue ?? null
  const revenue = i.company.annualRevenue ?? null
  if (est != null && revenue && revenue > 0) {
    const share = est / revenue
    if (share >= 0.5) { score += 10; notes.push(`large for your size (${Math.round(share * 100)}% of annual revenue)`) }
    else if (share <= 0.02) { score -= 10; notes.push(`small for your size (${(share * 100).toFixed(1)}% of annual revenue)`) }
  }
  if (notes.length === 0) notes.push('no strong strategic signal in your records')
  const text = notes.join('; ')
  return { score: clamp(score), note: `${text.charAt(0).toUpperCase()}${text.slice(1)}. Adjust for your own goals.` }
}

/** No score — winning work you can't staff is the costliest mistake — but the facts to weigh. */
function capacity(i: SuggestionInput): Suggestion {
  const facts: string[] = []
  if (i.workload) {
    facts.push(`${i.workload.activeContracts} active contract${i.workload.activeContracts === 1 ? '' : 's'}`)
    facts.push(`${i.workload.bidsInProgress} other bid${i.workload.bidsInProgress === 1 ? '' : 's'} in progress`)
  }
  if (i.company.employeeCount != null) facts.push(`${i.company.employeeCount} employees on your profile`)
  return {
    score: null,
    note: facts.length
      ? `Your call: do you have the people free to deliver this? To weigh: ${facts.join(', ')}.`
      : 'Your call: do you have the people free to deliver this? Bytescon has no workload records to suggest a score from.',
  }
}

const RULES: Record<string, (i: SuggestionInput) => Suggestion> = {
  capability_fit: capabilityFit,
  eligibility,
  past_performance: pastPerformance,
  relationship,
  timeline,
  competition,
  pricing,
  strategic_value: strategicValue,
  capacity,
}

/** A suggestion for each key; keys without a rule (or data) get a null score. */
export function suggestScores(keys: string[], input: SuggestionInput): Record<string, Suggestion> {
  return Object.fromEntries(keys.map((key) => [key, RULES[key]?.(input) ?? { score: null, note: NO_DATA }]))
}

/**
 * Gather the inputs for one opportunity and the company that would bid: a
 * consulting firm's client, or a contractor's own company. Past performance
 * counts that company's projects plus firm-wide ones for a contractor.
 */
export async function loadSuggestionInput(consultingFirmId: string, opportunityId: string, clientCompanyId: string | null): Promise<SuggestionInput> {
  const [opportunity, client] = await Promise.all([
    prisma.opportunity.findFirst({
      where: { id: opportunityId, consultingFirmId },
      select: {
        title: true, description: true, agency: true, naicsCode: true, responseDeadline: true, setAsideType: true,
        competitionCount: true, offersReceived: true, incumbentProbability: true, incumbentSignalDetected: true,
        estimatedValue: true, recompeteFlag: true, historicalWinner: true,
      },
    }),
    clientCompanyId
      ? prisma.clientCompany.findFirst({
          where: { id: clientCompanyId, consultingFirmId },
          select: { id: true, name: true, isSelf: true, naicsCodes: true, capabilityKeywords: true, annualRevenue: true, employeeCount: true },
        })
      : null,
  ])
  if (!opportunity) throw new NotFoundError('Opportunity')
  const estimatedValue = opportunity.estimatedValue == null ? null : Number(opportunity.estimatedValue)

  const ppWhere = client
    ? { consultingFirmId, isArchived: false, OR: [{ clientCompanyId: client.id }, ...(client.isSelf ? [{ clientCompanyId: null }] : [])] }
    : { consultingFirmId, isArchived: false }
  const [readiness, pastPerformance, registration, pricingInput, workload] = await Promise.all([
    loadBidReadiness(consultingFirmId, opportunityId, clientCompanyId),
    prisma.pastPerformanceRecord.findMany({
      where: ppWhere,
      select: { customerName: true, customerAgency: true, naicsCode: true, relevanceTags: true, scopeSummary: true },
      take: 200,
    }),
    client ? null : prisma.registrationProfile.findUnique({ where: { consultingFirmId }, select: { naicsCodes: true } }),
    loadPricingInput(consultingFirmId, opportunityId, clientCompanyId, { naics: opportunity.naicsCode, agency: opportunity.agency, setAside: opportunity.setAsideType, estimatedValue }),
    loadWorkload(consultingFirmId, opportunityId, client),
  ])

  return {
    opportunity: { ...opportunity, estimatedValue },
    company: client
      ? {
          name: client.name, naicsCodes: client.naicsCodes, capabilityKeywords: client.capabilityKeywords,
          annualRevenue: client.annualRevenue == null ? null : Number(client.annualRevenue), employeeCount: client.employeeCount,
        }
      : { name: 'Your firm', naicsCodes: registration?.naicsCodes ?? [], capabilityKeywords: [] },
    readiness,
    pastPerformance,
    pricing: pricingInput,
    workload,
  }
}

/**
 * The Pricing agent's view, computed directly (the agent itself is opt-in):
 * comparable public awards (agents/pricing/awardBenchmark.ts), and, when you
 * have priced the bid, where your price sits among them (competitiveRange.ts).
 * Deterministic; reads local award history only. Never fails the scorecard.
 */
async function loadPricingInput(
  consultingFirmId: string, opportunityId: string, clientCompanyId: string | null,
  opp: { naics: string | null; agency: string; setAside: string | null; estimatedValue: number | null },
): Promise<SuggestionInput['pricing']> {
  try {
    // The latest live workspace for this notice (this client's, or one with no client).
    const workspace = await prisma.pricingWorkspace.findFirst({
      where: {
        consultingFirmId, opportunityId, isArchived: false,
        status: { notIn: ['SUPERSEDED', 'ARCHIVED', 'REJECTED'] },
        ...(clientCompanyId ? { OR: [{ clientCompanyId }, { clientCompanyId: null }] } : {}),
      },
      orderBy: { version: 'desc' },
      select: { id: true, scenarios: { where: { isArchived: false, totalPrice: { gt: 0 } }, orderBy: [{ isPreferred: 'desc' }, { updatedAt: 'desc' }], take: 1, select: { id: true, totalPrice: true } } },
    })
    const scenario = workspace?.scenarios[0] ?? null
    const proposed = scenario ? new Prisma.Decimal(scenario.totalPrice) : null
    // With your price, the cohort is centred on it, exactly as the Pricing
    // agent does. Without one, the market range is built without the notice's
    // estimate: centring on the estimate would put it "in range" by construction.
    const reference = proposed
    const benchmark = await buildAwardBenchmark({
      consultingFirmId, opportunityId,
      pricingWorkspaceId: workspace?.id ?? null, pricingScenarioId: scenario?.id ?? null,
      naics: opp.naics, agency: opp.agency, setAside: opp.setAside,
      referencePrice: reference, now: new Date(),
    })
    const range = proposed ? assessCompetitiveRange({ proposedPrice: proposed, benchmark }) : null
    const num = (d: Prisma.Decimal | null) => (d == null ? null : Number(d))
    return {
      proposedPrice: num(proposed),
      rangeState: range?.state ?? null,
      percentile: range?.percentile ?? null,
      cohortSize: benchmark.cohortSize,
      p25: num(benchmark.distribution.p25),
      median: num(benchmark.distribution.median),
      p75: num(benchmark.distribution.p75),
    }
  } catch {
    return undefined
  }
}

/** Active contracts and other bids in progress for the bidding company. */
async function loadWorkload(consultingFirmId: string, opportunityId: string, client: { id: string; isSelf: boolean } | null): Promise<SuggestionInput['workload']> {
  if (!client) return undefined
  const [activeContracts, bidsInProgress] = await Promise.all([
    prisma.contract.count({
      where: { consultingFirmId, status: 'ACTIVE', OR: [{ clientCompanyId: client.id }, ...(client.isSelf ? [{ clientCompanyId: null }] : [])] },
    }),
    // Bids this company decided to pursue that are still being worked on.
    prisma.scorecard.count({
      where: {
        consultingFirmId, clientCompanyId: client.id, finalDecision: 'BID', opportunityId: { not: opportunityId },
        bidPursuit: { pipelineStage: { in: ['CAPTURE', 'PROPOSAL'] }, closedAt: null },
      },
    }),
  ])
  return { activeContracts, bidsInProgress }
}
