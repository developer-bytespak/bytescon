// =============================================================
// §7.7 — Capability library retrieval.
//
// THE SOURCE RULE THIS MODULE EXISTS TO ENFORCE
// Only an APPROVED CapabilityNarrativeVersion may be quoted as a contractor
// fact. A DRAFT is a person's work in progress; an ARCHIVED version is
// superseded wording. Neither is evidence, and neither is ever returned as a
// drafting source — when nothing approved exists the honest answer is that
// source material is insufficient.
//
// Retrieval is DETERMINISTIC: a scored filter over stored metadata. No
// embeddings, no vector store, no new provider. Ranking is reproducible, so
// two runs over unchanged data select the same sources in the same order.
//
// No AI rewriting happens here. This module retrieves and ranks; drafting is
// somewhere else entirely.
// =============================================================
import { createHash } from 'crypto'
import type { CapabilityNarrativeVersion, Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'

export const CAPABILITY_LIBRARY_VERSION = 'capability-library-v1'

/** A source must clear this to be offered as drafting material. */
export const MIN_RELEVANCE_SCORE = 10

/** At most this many approved sources are passed to a single draft call. */
export const MAX_SOURCES_PER_SECTION = 6

export type LibraryDataSufficiency = 'INSUFFICIENT_DATA' | 'PARTIAL' | 'SUFFICIENT'

export interface CapabilitySource {
  narrativeId: string
  versionId: string
  versionNumber: number
  title: string
  category: string
  content: string
  contentHash: string
  sourceReferences: string[]
  approvedAt: Date | null
  approvedByUserId: string | null
  relevanceScore: number
  matchedOn: string[]
}

export interface CapabilityRetrieval {
  sources: CapabilitySource[]
  /** Narratives that matched but have no approved version — never quotable. */
  unapprovedMatches: Array<{ narrativeId: string; title: string; reason: string }>
  totalApprovedInLibrary: number
  dataSufficiency: LibraryDataSufficiency
  limitations: string[]
}

export interface RetrievalContext {
  /** Requirement / section keywords the section must speak to. */
  keywords: string[]
  naicsCode: string | null
  agency: string | null
  categories?: string[]
}

const norm = (v: string) => v.trim().toLowerCase()

/**
 * Deterministic relevance.
 *
 * Weighted, integer, and explainable: every point is attributable to a named
 * match, and `matchedOn` carries those names so a reader can check the ranking
 * rather than trust it.
 */
export function scoreCapabilityRelevance(
  narrative: { title: string; capabilityKeys: string[]; naicsCodes: string[]; agencyTags: string[]; tags: string[]; category: string },
  context: RetrievalContext,
): { score: number; matchedOn: string[] } {
  const matchedOn: string[] = []
  let score = 0

  const keywords = context.keywords.map(norm).filter(Boolean)
  const haystack = [
    ...narrative.capabilityKeys.map(norm),
    ...narrative.tags.map(norm),
    norm(narrative.title),
  ]

  for (const keyword of keywords) {
    if (haystack.some((h) => h.includes(keyword) || keyword.includes(h))) {
      score += 20
      matchedOn.push(`capability keyword "${keyword}"`)
    }
  }

  if (context.naicsCode && narrative.naicsCodes.map(norm).includes(norm(context.naicsCode))) {
    score += 25
    matchedOn.push(`NAICS ${context.naicsCode}`)
  }

  if (context.agency && narrative.agencyTags.some((t) => norm(t) === norm(context.agency!))) {
    score += 20
    matchedOn.push(`agency ${context.agency}`)
  }

  if (context.categories && context.categories.includes(narrative.category)) {
    score += 15
    matchedOn.push(`category ${narrative.category}`)
  }

  return { score, matchedOn }
}

/**
 * Approved capability sources for one section, most relevant first.
 *
 * TENANT SCOPE: every read filters on `consultingFirmId`. A narrative belonging
 * to another firm is never a source, and its existence is never reported.
 */
export async function retrieveApprovedSources(
  consultingFirmId: string,
  context: RetrievalContext,
): Promise<CapabilityRetrieval> {
  const limitations: string[] = []

  const narratives = await prisma.capabilityNarrative.findMany({
    where: { consultingFirmId, status: 'ACTIVE' },
    include: {
      versions: {
        where: { status: 'APPROVED' },
        orderBy: { versionNumber: 'desc' },
        take: 1,
      },
    },
    orderBy: { id: 'asc' },
    take: 500,
  })

  if (narratives.length === 0) {
    return {
      sources: [],
      unapprovedMatches: [],
      totalApprovedInLibrary: 0,
      dataSufficiency: 'INSUFFICIENT_DATA',
      limitations: ['The capability library is empty, so no approved contractor narrative could be quoted.'],
    }
  }

  const totalApprovedInLibrary = narratives.filter((n) => n.versions.length > 0).length
  const unapprovedMatches: CapabilityRetrieval['unapprovedMatches'] = []
  const scored: CapabilitySource[] = []

  for (const narrative of narratives) {
    const { score, matchedOn } = scoreCapabilityRelevance(narrative, context)
    if (score < MIN_RELEVANCE_SCORE) continue

    const approved = narrative.versions[0]
    if (!approved) {
      // It matched, but no human has approved any version of it. Reported so
      // the gap is visible, never quoted as a fact.
      unapprovedMatches.push({
        narrativeId: narrative.id,
        title: narrative.title,
        reason: 'This narrative matches the section but has no approved version, so it cannot be used as a contractor fact.',
      })
      continue
    }

    scored.push({
      narrativeId: narrative.id,
      versionId: approved.id,
      versionNumber: approved.versionNumber,
      title: narrative.title,
      category: narrative.category,
      content: approved.content,
      contentHash: approved.contentHash,
      sourceReferences: approved.sourceReferences,
      approvedAt: approved.approvedAt,
      approvedByUserId: approved.approvedByUserId,
      relevanceScore: score,
      matchedOn,
    })
  }

  // Deterministic ordering: score desc, then version id asc so ties never shuffle.
  scored.sort((a, b) => b.relevanceScore - a.relevanceScore || a.versionId.localeCompare(b.versionId))
  const sources = scored.slice(0, MAX_SOURCES_PER_SECTION)

  if (sources.length === 0) {
    limitations.push(
      totalApprovedInLibrary === 0
        ? 'No capability narrative has an approved version, so no contractor fact could be sourced. A draft version is a person\'s work in progress and is never quoted.'
        : 'No approved capability narrative was relevant to this section.',
    )
  }
  if (unapprovedMatches.length > 0) {
    limitations.push(
      `${unapprovedMatches.length} relevant narrative(s) have no approved version and were excluded. Approving them would make them available as drafting sources.`,
    )
  }
  if (scored.length > MAX_SOURCES_PER_SECTION) {
    limitations.push(`${scored.length} approved sources were relevant; the ${MAX_SOURCES_PER_SECTION} strongest were used.`)
  }

  return {
    sources,
    unapprovedMatches,
    totalApprovedInLibrary,
    dataSufficiency: sources.length === 0 ? 'INSUFFICIENT_DATA' : sources.length < 2 ? 'PARTIAL' : 'SUFFICIENT',
    limitations,
  }
}

/**
 * A digest of exactly which approved source versions a draft was built from.
 *
 * Included in the section draft fingerprint, so approving a NEW capability
 * version changes the fingerprint and a fresh draft becomes available — while
 * an unchanged library produces no new draft at all.
 */
export function sourceVersionFingerprint(sources: CapabilitySource[]): string {
  const material = sources
    .map((s) => `${s.versionId}:${s.versionNumber}:${s.contentHash}`)
    .sort()
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

/** Content hash used when a human saves a version. Stable and cheap. */
export function hashNarrativeContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * The next version number for a narrative.
 *
 * Editing approved text creates a NEW draft rather than replacing the approved
 * one, which is what keeps an earlier proposal's citations reproducible.
 */
export async function nextVersionNumber(capabilityNarrativeId: string): Promise<number> {
  const latest = await prisma.capabilityNarrativeVersion.findFirst({
    where: { capabilityNarrativeId },
    orderBy: { versionNumber: 'desc' },
    select: { versionNumber: true },
  })
  return (latest?.versionNumber ?? 0) + 1
}

/**
 * Library health for the status artifact.
 *
 * Reports what a human would need to do to make drafting possible, rather than
 * simply reporting that drafting failed.
 */
export async function summariseLibrary(consultingFirmId: string): Promise<{
  narratives: number
  approvedVersions: number
  draftVersions: number
  narrativesWithoutApproval: number
  available: boolean
  detail: string
}> {
  const [narratives, approvedVersions, draftVersions] = await Promise.all([
    prisma.capabilityNarrative.count({ where: { consultingFirmId, status: 'ACTIVE' } }),
    prisma.capabilityNarrativeVersion.count({ where: { consultingFirmId, status: 'APPROVED' } }),
    prisma.capabilityNarrativeVersion.count({ where: { consultingFirmId, status: 'DRAFT' } }),
  ])

  const withApproval = await prisma.capabilityNarrative.count({
    where: { consultingFirmId, status: 'ACTIVE', versions: { some: { status: 'APPROVED' } } },
  })
  const narrativesWithoutApproval = narratives - withApproval

  return {
    narratives,
    approvedVersions,
    draftVersions,
    narrativesWithoutApproval,
    available: approvedVersions > 0,
    detail:
      approvedVersions === 0
        ? narratives === 0
          ? 'The capability library is empty. Add narratives and approve a version to make them available for drafting.'
          : `${narratives} narrative(s) exist but none has an approved version. Only approved versions may be quoted as contractor facts.`
        : `${approvedVersions} approved version(s) across ${withApproval} narrative(s) are available for drafting.` +
          (narrativesWithoutApproval > 0 ? ` ${narrativesWithoutApproval} narrative(s) still await a first approval.` : ''),
  }
}

/** Narrow read used by the citation validator. Tenant-scoped. */
export async function loadApprovedVersionsByIds(
  consultingFirmId: string,
  versionIds: string[],
): Promise<CapabilityNarrativeVersion[]> {
  if (versionIds.length === 0) return []
  return prisma.capabilityNarrativeVersion.findMany({
    where: { consultingFirmId, status: 'APPROVED', id: { in: versionIds } },
  })
}

export type { Prisma }
