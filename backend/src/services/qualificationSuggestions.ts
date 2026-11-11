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
// Capacity, strategic value and pricing have no data behind them, so they get
// no score: a person judges them. A firm's own criteria are left alone too.
//
// Suggestions are a starting point the person reviews; they never record a
// decision. Pure: the loader below gathers the inputs.
// =============================================================
import { prisma } from '../config/database'
import { NotFoundError } from '../utils/errors'
import { computeNaicsOverlap, matchCapabilityKeywords } from '../engines/probabilityEngine'
import { loadBidReadiness } from './bidReadinessLoader'
import type { BidReadinessResult, ReadinessItem } from './bidReadiness'

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
  }
  company: { name: string; naicsCodes: string[]; capabilityKeywords: string[] }
  readiness: BidReadinessResult
  pastPerformance: Array<{ customerName: string; customerAgency: string | null; naicsCode: string | null; relevanceTags: string[]; scopeSummary: string }>
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

const RULES: Record<string, (i: SuggestionInput) => Suggestion> = {
  capability_fit: capabilityFit,
  eligibility,
  past_performance: pastPerformance,
  relationship,
  timeline,
  competition,
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
        title: true, description: true, agency: true, naicsCode: true, responseDeadline: true,
        competitionCount: true, offersReceived: true, incumbentProbability: true, incumbentSignalDetected: true,
      },
    }),
    clientCompanyId
      ? prisma.clientCompany.findFirst({ where: { id: clientCompanyId, consultingFirmId }, select: { id: true, name: true, isSelf: true, naicsCodes: true, capabilityKeywords: true } })
      : null,
  ])
  if (!opportunity) throw new NotFoundError('Opportunity')

  const ppWhere = client
    ? { consultingFirmId, isArchived: false, OR: [{ clientCompanyId: client.id }, ...(client.isSelf ? [{ clientCompanyId: null }] : [])] }
    : { consultingFirmId, isArchived: false }
  const [readiness, pastPerformance, registration] = await Promise.all([
    loadBidReadiness(consultingFirmId, opportunityId, clientCompanyId),
    prisma.pastPerformanceRecord.findMany({
      where: ppWhere,
      select: { customerName: true, customerAgency: true, naicsCode: true, relevanceTags: true, scopeSummary: true },
      take: 200,
    }),
    client ? null : prisma.registrationProfile.findUnique({ where: { consultingFirmId }, select: { naicsCodes: true } }),
  ])

  return {
    opportunity,
    company: client
      ? { name: client.name, naicsCodes: client.naicsCodes, capabilityKeywords: client.capabilityKeywords }
      : { name: 'Your firm', naicsCodes: registration?.naicsCodes ?? [], capabilityKeywords: [] },
    readiness,
    pastPerformance,
  }
}
