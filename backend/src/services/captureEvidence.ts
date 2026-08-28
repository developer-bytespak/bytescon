// =============================================================
// Capture & Qualification evidence (§5.1 Stage 3) — the single service layer for
// collecting, normalizing, ranking, and attributing INCUMBENT and COMPETITOR
// evidence. Evidence is derived ONLY from already-ingested reliable data
// (AwardHistory from the SAM.gov / USASpending integrations + the opportunity's
// enrichment fields) and persisted into the (repaired) Competitor model. No live
// external calls, no LLM guessing, no fabrication — missing award data yields an
// honest NOT_AVAILABLE / "no reliable evidence" state.
//
// The collect* functions are PURE and deterministic (unit-testable); the
// refresh/get functions persist while preserving manual verification/notes.
// =============================================================
import { Prisma, PrismaClient, EvidenceConfidence } from '@prisma/client'
import { prisma as defaultPrisma } from '../config/database'

export const EVIDENCE_SOURCE_AWARD = 'Award history (USASpending/FPDS)'
export const EVIDENCE_SOURCE_ENRICHMENT = 'USASpending enrichment (historical winner)'

export interface AwardRow {
  recipientName: string
  recipientUei: string | null
  awardAmount: number
  baseAndAllOptions: number | null
  awardDate: Date
  awardingAgency: string
  naics: string | null
  psc: string | null
  contractNumber: string | null
}

export interface OppContext {
  agency: string
  naicsCode: string
  psc: string | null
  historicalWinner?: string | null
  incumbentProbability?: number | null
}

// Normalize a company name for grouping/dedup: uppercase, drop punctuation and
// common corporate suffixes, collapse whitespace. Deterministic.
export function normalizeCompany(name: string): string {
  return (name || '')
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(INCORPORATED|INC|LLC|L L C|CORPORATION|CORP|COMPANY|CO|LIMITED|LTD|LLP|LP|PLLC|PC)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function naicsPrefix(code: string | null | undefined): string {
  return (code || '').slice(0, 4)
}

// ---- INCUMBENT ------------------------------------------------------------
export interface IncumbentCandidate { name: string; uei: string | null; awardCount: number; latestAwardDate: Date }
export interface IncumbentEvidence {
  confidence: EvidenceConfidence
  company: string | null
  uei: string | null
  awardReference: string | null
  awardValue: number | null
  agency: string | null
  periodOfPerformance: string | null
  sourceRecordDate: Date | null
  evidenceSource: string | null
  whyShown: string
  candidates: IncumbentCandidate[]
}

export function collectIncumbentEvidence(opp: OppContext, awards: AwardRow[]): IncumbentEvidence {
  const none = (whyShown: string): IncumbentEvidence => ({
    confidence: 'NOT_AVAILABLE', company: null, uei: null, awardReference: null, awardValue: null,
    agency: null, periodOfPerformance: null, sourceRecordDate: null, evidenceSource: null, whyShown, candidates: [],
  })

  if (awards.length === 0) {
    // Fall back to the enrichment signal — but an inferred name is NEVER CONFIRMED.
    if (opp.historicalWinner && opp.historicalWinner.trim()) {
      const strong = typeof opp.incumbentProbability === 'number' && opp.incumbentProbability >= 0.6
      return {
        confidence: strong ? 'PROBABLE' : 'AMBIGUOUS',
        company: opp.historicalWinner.trim(), uei: null, awardReference: null, awardValue: null,
        agency: opp.agency, periodOfPerformance: null, sourceRecordDate: null, evidenceSource: EVIDENCE_SOURCE_ENRICHMENT,
        whyShown: strong
          ? `Enrichment identifies a likely prior winner (incumbent probability ${(opp.incumbentProbability! * 100).toFixed(0)}%). No award record on file — not confirmed.`
          : `Enrichment names a possible prior winner but the signal is weak — treat as ambiguous.`,
        candidates: [],
      }
    }
    return none('No award history or historical-winner signal for this opportunity.')
  }

  // Group by UEI when present, else normalized name.
  const groups = new Map<string, { display: string; uei: string | null; rows: AwardRow[] }>()
  for (const a of awards) {
    const key = a.recipientUei || normalizeCompany(a.recipientName)
    const g = groups.get(key)
    if (g) g.rows.push(a)
    else groups.set(key, { display: a.recipientName, uei: a.recipientUei, rows: [a] })
  }

  const ranked = Array.from(groups.values())
    .map((g) => {
      const latest = g.rows.reduce((m, r) => (r.awardDate > m.awardDate ? r : m), g.rows[0])
      return { ...g, awardCount: g.rows.length, latest }
    })
    .sort((a, b) =>
      b.awardCount - a.awardCount ||
      b.latest.awardDate.getTime() - a.latest.awardDate.getTime() ||
      normalizeCompany(a.display).localeCompare(normalizeCompany(b.display)),
    )

  const top = ranked[0]
  const refOf = (r: { latest: AwardRow; awardCount: number }): Partial<IncumbentEvidence> => ({
    awardReference: r.latest.contractNumber, awardValue: r.latest.baseAndAllOptions ?? r.latest.awardAmount,
    agency: r.latest.awardingAgency || opp.agency, sourceRecordDate: r.latest.awardDate, evidenceSource: EVIDENCE_SOURCE_AWARD,
  })

  if (ranked.length === 1) {
    return {
      confidence: 'CONFIRMED', company: top.display, uei: top.uei, periodOfPerformance: null,
      whyShown: `Sole award recipient on ${top.awardCount} award record${top.awardCount === 1 ? '' : 's'} for this opportunity.`,
      candidates: [], ...refOf(top),
    } as IncumbentEvidence
  }

  const second = ranked[1]
  if (top.awardCount > second.awardCount) {
    return {
      confidence: 'PROBABLE', company: top.display, uei: top.uei, periodOfPerformance: null,
      whyShown: `Most award records (${top.awardCount} of ${awards.length}) among ${ranked.length} recipients — likely incumbent, not confirmed.`,
      candidates: ranked.slice(0, 3).map((r) => ({ name: r.display, uei: r.uei, awardCount: r.awardCount, latestAwardDate: r.latest.awardDate })),
      ...refOf(top),
    } as IncumbentEvidence
  }

  // Comparable evidence across multiple recipients → ambiguous (never confirmed).
  return {
    confidence: 'AMBIGUOUS', company: null, uei: null, awardReference: null, awardValue: null,
    agency: opp.agency, periodOfPerformance: null, sourceRecordDate: top.latest.awardDate, evidenceSource: EVIDENCE_SOURCE_AWARD,
    whyShown: `${ranked.length} recipients with comparable award history — needs manual verification.`,
    candidates: ranked.slice(0, 3).map((r) => ({ name: r.display, uei: r.uei, awardCount: r.awardCount, latestAwardDate: r.latest.awardDate })),
  }
}

// ---- COMPETITORS ----------------------------------------------------------
export interface CompetitorEvidence {
  name: string
  uei: string | null
  relevantAwardCount: number
  relevantAwardValue: number
  agencyRelevant: boolean
  naicsRelevant: boolean
  pscRelevant: boolean
  sourceRecordDate: Date
  confidence: EvidenceConfidence
  evidenceSource: string
  whyShown: string
}

// Historical competitor evidence (NOT a prediction). `relevantAwards` must
// already be firm-scoped and relevant (agency/NAICS/PSC) to `opp`.
export function collectCompetitorEvidence(opp: OppContext, relevantAwards: AwardRow[], limit = 15): CompetitorEvidence[] {
  const oppNaics = naicsPrefix(opp.naicsCode)
  const groups = new Map<string, { display: string; uei: string | null; rows: AwardRow[] }>()
  for (const a of relevantAwards) {
    const key = a.recipientUei || normalizeCompany(a.recipientName)
    if (!key) continue
    const g = groups.get(key)
    if (g) g.rows.push(a)
    else groups.set(key, { display: a.recipientName, uei: a.recipientUei, rows: [a] })
  }

  const evidence: CompetitorEvidence[] = Array.from(groups.values()).map((g) => {
    const agencyRelevant = g.rows.some((r) => !!r.awardingAgency && !!opp.agency && (r.awardingAgency.toLowerCase().includes(opp.agency.toLowerCase()) || opp.agency.toLowerCase().includes(r.awardingAgency.toLowerCase())))
    const naicsRelevant = !!oppNaics && g.rows.some((r) => naicsPrefix(r.naics) === oppNaics)
    const pscRelevant = !!opp.psc && g.rows.some((r) => (r.psc || '') === opp.psc)
    const relevantAwardValue = g.rows.reduce((s, r) => s + (r.awardAmount || 0), 0)
    const latest = g.rows.reduce((m, r) => (r.awardDate > m.awardDate ? r : m), g.rows[0])
    const reasons: string[] = []
    if (agencyRelevant) reasons.push(`same agency`)
    if (naicsRelevant) reasons.push(`NAICS ${oppNaics}xx`)
    if (pscRelevant) reasons.push(`PSC ${opp.psc}`)
    const strong = g.rows.length >= 2 && (agencyRelevant || naicsRelevant)
    return {
      name: g.display, uei: g.uei, relevantAwardCount: g.rows.length, relevantAwardValue,
      agencyRelevant, naicsRelevant, pscRelevant, sourceRecordDate: latest.awardDate,
      confidence: (strong ? 'PROBABLE' : 'AMBIGUOUS') as EvidenceConfidence, evidenceSource: EVIDENCE_SOURCE_AWARD,
      whyShown: `${g.rows.length} relevant historical award${g.rows.length === 1 ? '' : 's'}${reasons.length ? ` (${reasons.join(', ')})` : ''}. Historical evidence — not a prediction they will bid.`,
    }
  })

  // Deterministic ranking: award count, then value, then normalized name.
  return evidence
    .sort((a, b) => b.relevantAwardCount - a.relevantAwardCount || b.relevantAwardValue - a.relevantAwardValue || normalizeCompany(a.name).localeCompare(normalizeCompany(b.name)))
    .slice(0, limit)
}

// ---- PERSISTENCE ----------------------------------------------------------
type Db = PrismaClient | Prisma.TransactionClient

function toAwardRow(a: { recipientName: string; recipientUei: string | null; awardAmount: Prisma.Decimal; baseAndAllOptions: Prisma.Decimal | null; awardDate: Date; awardingAgency: string; naics: string | null; psc: string | null; contractNumber: string | null }): AwardRow {
  return {
    recipientName: a.recipientName, recipientUei: a.recipientUei, awardAmount: Number(a.awardAmount),
    baseAndAllOptions: a.baseAndAllOptions == null ? null : Number(a.baseAndAllOptions), awardDate: a.awardDate,
    awardingAgency: a.awardingAgency, naics: a.naics, psc: a.psc, contractNumber: a.contractNumber,
  }
}

// Recompute + persist evidence for one opportunity. Preserves manual incumbent
// verification/correction and any competitor notes across refreshes.
export async function refreshOpportunityEvidence(consultingFirmId: string, opportunityId: string, db: Db = defaultPrisma) {
  const opp = await db.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: { id: true, agency: true, naicsCode: true, psc: true, historicalWinner: true, incumbentProbability: true },
  })
  if (!opp) return null

  const ownAwards = (await db.awardHistory.findMany({ where: { opportunityId } })).map(toAwardRow)

  // Relevant awards across the firm's own opportunities (agency / NAICS / PSC).
  const oppNaics4 = (opp.naicsCode || '').slice(0, 4)
  const relevant = (await db.awardHistory.findMany({
    where: {
      opportunity: { consultingFirmId },
      OR: [
        ...(opp.agency ? [{ awardingAgency: { contains: opp.agency, mode: 'insensitive' as const } }] : []),
        ...(oppNaics4 ? [{ naics: { startsWith: oppNaics4 } }] : []),
        ...(opp.psc ? [{ psc: opp.psc }] : []),
      ],
    },
    take: 500,
  })).map(toAwardRow)

  const incumbent = collectIncumbentEvidence(opp, ownAwards)
  const competitors = collectCompetitorEvidence(opp, relevant)
  const incNorm = incumbent.company ? normalizeCompany(incumbent.company) : ''
  const now = new Date()

  // --- Incumbent (single row per opportunity) ---
  const existingInc = await db.competitor.findFirst({ where: { consultingFirmId, opportunityId, evidenceKind: 'INCUMBENT' } })
  const incData = {
    name: incumbent.company ?? 'Not available', normalizedName: incNorm, uei: incumbent.uei,
    confidence: incumbent.confidence, evidenceSource: incumbent.evidenceSource, whyShown: incumbent.whyShown,
    agency: incumbent.agency, awardReference: incumbent.awardReference,
    awardValue: incumbent.awardValue == null ? null : new Prisma.Decimal(incumbent.awardValue),
    periodOfPerformance: incumbent.periodOfPerformance, sourceRecordDate: incumbent.sourceRecordDate,
    isIncumbent: incumbent.confidence !== 'NOT_AVAILABLE', lastRefreshedAt: now,
  }
  if (existingInc) {
    // Preserve a human decision: don't overwrite name/uei/verification once
    // verified or corrected — only refresh the underlying award aggregates.
    const preserve = existingInc.verification === 'VERIFIED' || existingInc.verification === 'CORRECTED'
    await db.competitor.update({
      where: { id: existingInc.id },
      data: preserve
        ? { agency: incData.agency, awardReference: incData.awardReference, awardValue: incData.awardValue, sourceRecordDate: incData.sourceRecordDate, lastRefreshedAt: now }
        : { ...incData, normalizedName: incNorm || `__incumbent__${opportunityId}` },
    })
  } else {
    await db.competitor.create({ data: { consultingFirmId, opportunityId, evidenceKind: 'INCUMBENT', ...incData, normalizedName: incNorm || `__incumbent__${opportunityId}`, originalName: incumbent.company, originalUei: incumbent.uei } })
  }

  // --- Competitors (upsert by normalizedName; preserve notes; prune stale auto rows) ---
  const freshNorms = new Set<string>()
  for (const c of competitors) {
    const norm = normalizeCompany(c.name)
    freshNorms.add(norm)
    const data = {
      name: c.name, uei: c.uei, confidence: c.confidence, evidenceSource: c.evidenceSource, whyShown: c.whyShown,
      agencyRelevant: c.agencyRelevant, naicsRelevant: c.naicsRelevant, pscRelevant: c.pscRelevant,
      relevantAwardCount: c.relevantAwardCount, relevantAwardValue: new Prisma.Decimal(c.relevantAwardValue),
      sourceRecordDate: c.sourceRecordDate, isIncumbent: incNorm !== '' && norm === incNorm, lastRefreshedAt: now,
    }
    await db.competitor.upsert({
      where: { consultingFirmId_opportunityId_evidenceKind_normalizedName: { consultingFirmId, opportunityId, evidenceKind: 'COMPETITOR', normalizedName: norm } },
      update: data,
      create: { consultingFirmId, opportunityId, evidenceKind: 'COMPETITOR', normalizedName: norm, ...data },
    })
  }
  // Remove auto-managed competitor rows no longer supported by evidence (keep
  // any that carry manual notes).
  const stale = await db.competitor.findMany({ where: { consultingFirmId, opportunityId, evidenceKind: 'COMPETITOR', notes: null } })
  const toDelete = stale.filter((s) => !freshNorms.has(s.normalizedName)).map((s) => s.id)
  if (toDelete.length) await db.competitor.deleteMany({ where: { id: { in: toDelete } } })

  return getOpportunityEvidence(consultingFirmId, opportunityId, db)
}

export async function getOpportunityEvidence(consultingFirmId: string, opportunityId: string, db: Db = defaultPrisma) {
  const rows = await db.competitor.findMany({ where: { consultingFirmId, opportunityId } })
  const incumbent = rows.find((r) => r.evidenceKind === 'INCUMBENT') ?? null
  const competitors = rows
    .filter((r) => r.evidenceKind === 'COMPETITOR')
    .sort((a, b) => (b.relevantAwardCount ?? 0) - (a.relevantAwardCount ?? 0) || Number(b.relevantAwardValue ?? 0) - Number(a.relevantAwardValue ?? 0) || a.normalizedName.localeCompare(b.normalizedName))
  const lastRefreshedAt = rows.reduce<Date | null>((m, r) => (r.lastRefreshedAt && (!m || r.lastRefreshedAt > m) ? r.lastRefreshedAt : m), null)
  return { incumbent, competitors, lastRefreshedAt }
}
