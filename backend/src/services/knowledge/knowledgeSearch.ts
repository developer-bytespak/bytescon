// =============================================================
// §8.4 — Cross-asset knowledge search.
//
// A READ over the stores that already exist. There is no knowledge index, no
// second copy of anything, and no embedding: each asset type is queried in its
// own table with a case-insensitive `contains`, and the results are normalized
// into one shape for the caller.
//
// It is called search because that is what it is. Ranking is deterministic
// (title match before body match, then recency) rather than semantic, and the
// response says so, because a text match dressed up as understanding is how a
// user comes to believe an empty result means "we have nothing".
//
// Every query is tenant-scoped in its own WHERE clause. Nothing here reads
// across firms, and nothing infers a value: an asset's evidence state is the
// column a human set, copied through untouched.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'

export const KNOWLEDGE_RESULT_TYPES = [
  'CAPABILITY', 'CAPABILITY_NARRATIVE', 'PAST_PERFORMANCE',
  'PERSONNEL', 'PERSONNEL_RESUME', 'TEMPLATE', 'STANDING_DOCUMENT',
] as const

export type KnowledgeResultType = (typeof KNOWLEDGE_RESULT_TYPES)[number]

export interface KnowledgeResult {
  type: KnowledgeResultType
  id: string
  title: string
  summary: string | null
  /** The frontend route that shows this record. */
  sourceRoute: string
  /** The human-set evidence/approval state, verbatim. Never derived. */
  evidenceState: string
  updatedAt: string
}

export interface KnowledgeSearchOptions {
  query: string
  types?: KnowledgeResultType[]
  /** Archived and inactive assets are excluded unless explicitly asked for. */
  includeArchived?: boolean
  limit: number
  offset: number
}

export interface KnowledgeSearchResponse {
  query: string
  results: KnowledgeResult[]
  totalByType: Record<string, number>
  total: number
  limit: number
  offset: number
  method: string
}

export const KNOWLEDGE_SEARCH_METHOD =
  'Case-insensitive text match across the existing knowledge tables, ranked by title match then recency. This is a database text search, not a semantic or AI search: a record whose wording differs from your query will not be found.'

const MAX_PER_TYPE = 100

/** Postgres `contains` treats these literally, so nothing needs escaping — but empty does. */
function normalize(query: string): string {
  return query.trim()
}

function iso(d: Date): string {
  return d.toISOString()
}

function truncate(text: string | null | undefined, max = 240): string | null {
  if (!text) return null
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length === 0) return null
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

async function searchCapabilities(firmId: string, q: string, includeArchived: boolean): Promise<KnowledgeResult[]> {
  const rows = await prisma.firmCapability.findMany({
    where: {
      consultingFirmId: firmId,
      ...(includeArchived ? {} : { isArchived: false }),
      OR: [
        { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { description: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { keywords: { has: q } },
      ],
    },
    select: { id: true, name: true, description: true, verification: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' }, take: MAX_PER_TYPE,
  })
  return rows.map((r) => ({
    type: 'CAPABILITY' as const, id: r.id, title: r.name, summary: truncate(r.description),
    sourceRoute: '/discovery?tab=capabilities', evidenceState: r.verification, updatedAt: iso(r.updatedAt),
  }))
}

async function searchNarratives(firmId: string, q: string, includeArchived: boolean): Promise<KnowledgeResult[]> {
  const rows = await prisma.capabilityNarrative.findMany({
    where: {
      consultingFirmId: firmId,
      ...(includeArchived ? {} : { status: 'ACTIVE' }),
      OR: [
        { title: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { tags: { has: q } },
        { capabilityKeys: { has: q } },
      ],
    },
    select: { id: true, title: true, category: true, status: true, currentApprovedVersionId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' }, take: MAX_PER_TYPE,
  })
  return rows.map((r) => ({
    type: 'CAPABILITY_NARRATIVE' as const, id: r.id, title: r.title,
    summary: truncate(String(r.category).replace(/_/g, ' ').toLowerCase()),
    sourceRoute: '/capability-narratives',
    // An unapproved narrative says so. A proposal may only quote an approved one.
    evidenceState: r.currentApprovedVersionId ? 'APPROVED_VERSION_AVAILABLE' : 'NO_APPROVED_VERSION',
    updatedAt: iso(r.updatedAt),
  }))
}

async function searchPastPerformance(firmId: string, q: string, includeArchived: boolean): Promise<KnowledgeResult[]> {
  const rows = await prisma.pastPerformanceRecord.findMany({
    where: {
      consultingFirmId: firmId,
      ...(includeArchived ? {} : { isCurrent: true }),
      OR: [
        { contractTitle: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { customerName: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { customerAgency: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { contractNumber: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { scopeSummary: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { relevanceTags: { has: q } },
      ],
    },
    select: {
      id: true, contractTitle: true, contractNumber: true, customerName: true,
      scopeSummary: true, cparsRating: true, updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' }, take: MAX_PER_TYPE,
  })
  return rows.map((r) => ({
    type: 'PAST_PERFORMANCE' as const, id: r.id,
    title: r.contractTitle || `${r.customerName} — ${r.contractNumber}`,
    summary: truncate(r.scopeSummary),
    sourceRoute: '/past-performance-library',
    evidenceState: r.cparsRating ? `CPARS_${r.cparsRating}` : 'NO_CPARS_RATING',
    updatedAt: iso(r.updatedAt),
  }))
}

async function searchPersonnel(firmId: string, q: string, includeArchived: boolean): Promise<KnowledgeResult[]> {
  const rows = await prisma.personnel.findMany({
    where: {
      consultingFirmId: firmId,
      ...(includeArchived ? {} : { isArchived: false }),
      OR: [
        { firstName: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { lastName: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { jobTitle: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { summary: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { qualifications: { some: { laborCategory: { contains: q, mode: Prisma.QueryMode.insensitive } } } },
      ],
    },
    select: {
      id: true, firstName: true, lastName: true, jobTitle: true, updatedAt: true,
      qualifications: { where: { verification: 'VERIFIED' }, select: { id: true } },
      resumes: { where: { status: 'APPROVED' }, select: { id: true } },
    },
    orderBy: { updatedAt: 'desc' }, take: MAX_PER_TYPE,
  })
  return rows.map((r) => ({
    type: 'PERSONNEL' as const, id: r.id, title: `${r.firstName} ${r.lastName}`,
    summary: truncate(r.jobTitle),
    sourceRoute: '/knowledge',
    // What a proposal may actually rest on, stated rather than implied.
    evidenceState: r.resumes.length > 0
      ? `APPROVED_RESUME · ${r.qualifications.length} verified qualification(s)`
      : 'NO_APPROVED_RESUME',
    updatedAt: iso(r.updatedAt),
  }))
}

async function searchResumes(firmId: string, q: string, includeArchived: boolean): Promise<KnowledgeResult[]> {
  const rows = await prisma.personnelResume.findMany({
    where: {
      consultingFirmId: firmId,
      // A draft is a work in progress and a superseded version is history;
      // neither is offered unless the caller asks to see everything.
      ...(includeArchived ? {} : { status: 'APPROVED' }),
      OR: [
        { title: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { personnel: { firstName: { contains: q, mode: Prisma.QueryMode.insensitive } } },
        { personnel: { lastName: { contains: q, mode: Prisma.QueryMode.insensitive } } },
      ],
    },
    select: {
      id: true, title: true, versionNumber: true, status: true, updatedAt: true,
      personnel: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { updatedAt: 'desc' }, take: MAX_PER_TYPE,
  })
  return rows.map((r) => ({
    type: 'PERSONNEL_RESUME' as const, id: r.id,
    title: r.title || `${r.personnel.firstName} ${r.personnel.lastName} — resume v${r.versionNumber}`,
    summary: `Version ${r.versionNumber}`,
    sourceRoute: '/knowledge',
    evidenceState: r.status, updatedAt: iso(r.updatedAt),
  }))
}

async function searchTemplates(firmId: string, q: string, includeArchived: boolean): Promise<KnowledgeResult[]> {
  const rows = await prisma.documentTemplate.findMany({
    where: {
      consultingFirmId: firmId,
      ...(includeArchived ? {} : { isActive: true }),
      OR: [
        { title: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { description: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { category: { contains: q, mode: Prisma.QueryMode.insensitive } },
      ],
    },
    select: { id: true, title: true, description: true, category: true, isActive: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' }, take: MAX_PER_TYPE,
  })
  return rows.map((r) => ({
    type: 'TEMPLATE' as const, id: r.id, title: r.title,
    summary: truncate(r.description ?? r.category),
    sourceRoute: '/templates', evidenceState: r.isActive ? 'ACTIVE' : 'INACTIVE', updatedAt: iso(r.updatedAt),
  }))
}

async function searchStandingDocuments(firmId: string, q: string, includeArchived: boolean): Promise<KnowledgeResult[]> {
  const rows = await prisma.standingDocument.findMany({
    where: {
      consultingFirmId: firmId,
      ...(includeArchived ? {} : { isArchived: false }),
      OR: [
        { name: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { description: { contains: q, mode: Prisma.QueryMode.insensitive } },
        { tags: { has: q } },
      ],
    },
    select: {
      id: true, name: true, description: true, verification: true,
      approvedForReuse: true, sensitivity: true, updatedAt: true,
    },
    orderBy: { updatedAt: 'desc' }, take: MAX_PER_TYPE,
  })
  return rows.map((r) => ({
    type: 'STANDING_DOCUMENT' as const, id: r.id, title: r.name,
    summary: truncate(r.description),
    sourceRoute: '/document-library',
    evidenceState: r.approvedForReuse ? `${r.verification} · APPROVED_FOR_REUSE` : String(r.verification),
    updatedAt: iso(r.updatedAt),
  }))
}

const SEARCHERS: Record<KnowledgeResultType, (f: string, q: string, a: boolean) => Promise<KnowledgeResult[]>> = {
  CAPABILITY: searchCapabilities,
  CAPABILITY_NARRATIVE: searchNarratives,
  PAST_PERFORMANCE: searchPastPerformance,
  PERSONNEL: searchPersonnel,
  PERSONNEL_RESUME: searchResumes,
  TEMPLATE: searchTemplates,
  STANDING_DOCUMENT: searchStandingDocuments,
}

/**
 * Rank deterministically: a title match outranks a body-only match, then more
 * recently updated first, then id. No scoring model, so the same query always
 * returns the same order.
 */
function rank(results: KnowledgeResult[], q: string): KnowledgeResult[] {
  const needle = q.toLowerCase()
  return [...results].sort((a, b) => {
    const at = a.title.toLowerCase().includes(needle) ? 0 : 1
    const bt = b.title.toLowerCase().includes(needle) ? 0 : 1
    if (at !== bt) return at - bt
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
    return a.id < b.id ? -1 : 1
  })
}

export async function searchKnowledge(
  consultingFirmId: string, opts: KnowledgeSearchOptions,
): Promise<KnowledgeSearchResponse> {
  const q = normalize(opts.query)
  const types = opts.types?.length ? opts.types : [...KNOWLEDGE_RESULT_TYPES]
  const empty: KnowledgeSearchResponse = {
    query: q, results: [], totalByType: {}, total: 0,
    limit: opts.limit, offset: opts.offset, method: KNOWLEDGE_SEARCH_METHOD,
  }
  if (q.length === 0) return empty

  const batches = await Promise.all(
    types.map((t) => SEARCHERS[t](consultingFirmId, q, Boolean(opts.includeArchived))),
  )
  const all = rank(batches.flat(), q)

  const totalByType: Record<string, number> = {}
  for (const r of all) totalByType[r.type] = (totalByType[r.type] ?? 0) + 1

  return {
    query: q,
    results: all.slice(opts.offset, opts.offset + opts.limit),
    totalByType,
    total: all.length,
    limit: opts.limit,
    offset: opts.offset,
    method: KNOWLEDGE_SEARCH_METHOD,
  }
}
