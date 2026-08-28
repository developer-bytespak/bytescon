// =============================================================
// §7.9 — Capability roadmap.
//
// Aggregates the firm's own `CapabilityGapAssessment` records to find which
// capability gaps recur across the most pipeline value.
//
// GROUPING IS EXACT, NOT FUZZY
// ------------------------------------------------------------
// Gaps are grouped by a normalised canonical key — case, punctuation and
// whitespace folded, nothing more. "Secret facility clearance" and "Top Secret
// facility clearance" are DIFFERENT capabilities and must never be merged
// because their names overlap. No embeddings, no similarity threshold, no
// model: a wrong merge here would tell a firm to invest in the wrong thing.
//
// The output is advisory and deliberately cautious. It never says "acquire
// this capability", never estimates a development cost, and never touches a
// FirmCapability record.
// =============================================================
import { createHash } from 'crypto'

export const ROADMAP_ALGORITHM_VERSION = 'intelligence-roadmap-v1'

/** Occurrences before a gap is called recurring rather than a one-off. */
export const MIN_RECURRENCE = 2

export const MAX_ROADMAP_ITEMS = 10

/** What the product suggests looking into. Never an autonomous directive. */
export type RoadmapRecommendation =
  | 'INVESTIGATE_CAPABILITY_DEVELOPMENT'
  | 'INVESTIGATE_PARTNER_COVERAGE'
  | 'RECURRING_GAP'
  | 'INSUFFICIENT_DATA'

/** Where in the assessment a gap came from. Kept distinct — they differ. */
export type GapCategory =
  | 'MISSING_CAPABILITY'
  | 'MISSING_CERTIFICATION'
  | 'MISSING_ELIGIBILITY'
  | 'CAPACITY'
  | 'GEOGRAPHY'
  | 'VEHICLE'
  | 'PARTIAL_COVERAGE'

/**
 * Severity by category.
 *
 * Eligibility outranks everything: a firm that is not eligible cannot win at
 * any price, whereas a geography gap is often solvable.
 */
export const CATEGORY_SEVERITY: Record<GapCategory, 'CRITICAL' | 'MAJOR' | 'MINOR'> = {
  MISSING_ELIGIBILITY: 'CRITICAL',
  MISSING_CERTIFICATION: 'CRITICAL',
  MISSING_CAPABILITY: 'MAJOR',
  VEHICLE: 'MAJOR',
  CAPACITY: 'MAJOR',
  GEOGRAPHY: 'MINOR',
  PARTIAL_COVERAGE: 'MINOR',
}

export interface GapObservation {
  assessmentId: string
  opportunityId: string
  category: GapCategory
  /** The raw text as recorded. Preserved for display. */
  rawLabel: string
  /** Expected value of the blocked opportunity. Null when not recorded. */
  opportunityValue: number | null
  /** True when a Teaming partner recommendation covers this gap. */
  partnerCoverage: boolean
  partnerNames: string[]
  /** True when the opportunity is an active pursuit rather than just watched. */
  isActivePursuit: boolean
}

export interface RoadmapItem {
  gapKey: string
  gapLabel: string
  category: GapCategory
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR'
  recommendation: RoadmapRecommendation
  affectedOpportunityCount: number
  affectedPursuitCount: number
  /** Summed value of the blocked opportunities that HAVE a recorded value. */
  knownAffectedValue: number
  /** Blocked opportunities with no recorded value. Never counted as zero. */
  unknownValueCount: number
  partnerCoverageCount: number
  partnerNames: string[]
  sourceGapIds: string[]
  evidence: string[]
  dataSufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT_DATA'
  limitations: string[]
  algorithmVersion: string
  inputHash: string
}

export interface RoadmapResult {
  items: RoadmapItem[]
  totalGapsObserved: number
  distinctGaps: number
  /** Gaps seen once. Reported as a count, not promoted to the roadmap. */
  nonRecurringGaps: number
  limitations: string[]
  algorithmVersion: string
}

/**
 * Canonical key for a gap.
 *
 * Case and punctuation are folded so "ISO 27001" and "iso-27001" are one gap.
 * Nothing further is normalised — no stemming, no synonyms, no truncation.
 * The category is part of the key, so a missing certification is never merged
 * with a capacity gap that happens to share a word.
 */
export function canonicalGapKey(category: GapCategory, rawLabel: string): string {
  const normalised = rawLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-')
  return `${category}:${normalised || 'unspecified'}`
}

/**
 * Aggregate gap observations into a roadmap.
 *
 * Pure. The caller supplies observations already scoped to one tenant.
 */
export function buildRoadmap(observations: GapObservation[]): RoadmapResult {
  const limitations: string[] = []
  const groups = new Map<string, GapObservation[]>()

  for (const o of observations) {
    const key = canonicalGapKey(o.category, o.rawLabel)
    groups.set(key, [...(groups.get(key) ?? []), o])
  }

  const nonRecurring = [...groups.values()].filter((g) => g.length < MIN_RECURRENCE).length
  if (nonRecurring > 0) {
    limitations.push(
      `${nonRecurring} gap(s) were observed only once. They are counted but not promoted to the roadmap, which reports gaps recurring across at least ${MIN_RECURRENCE} opportunities.`,
    )
  }

  const items: RoadmapItem[] = []

  for (const [gapKey, group] of groups) {
    if (group.length < MIN_RECURRENCE) continue

    const category = group[0].category
    const withValue = group.filter((g) => g.opportunityValue != null && Number.isFinite(g.opportunityValue))
    const knownAffectedValue = Number(withValue.reduce((s, g) => s + (g.opportunityValue ?? 0), 0).toFixed(2))
    const unknownValueCount = group.length - withValue.length
    const covered = group.filter((g) => g.partnerCoverage)
    const partnerNames = [...new Set(covered.flatMap((g) => g.partnerNames))].sort()
    const pursuits = group.filter((g) => g.isActivePursuit)

    const evidence: string[] = [
      `Recorded on ${group.length} opportunity assessment(s) as a ${category.replace(/_/g, ' ').toLowerCase()}.`,
    ]
    if (withValue.length > 0) {
      evidence.push(`${withValue.length} of those opportunities have a recorded value totalling $${knownAffectedValue.toLocaleString('en-US')}.`)
    }
    if (unknownValueCount > 0) {
      evidence.push(`${unknownValueCount} affected opportunity(ies) have no recorded value and are counted separately rather than as zero.`)
    }
    if (pursuits.length > 0) evidence.push(`${pursuits.length} of them are active pursuits.`)
    if (covered.length > 0) {
      evidence.push(`A partner in the current network is recorded as potentially covering this gap on ${covered.length} of them: ${partnerNames.slice(0, 5).join(', ')}.`)
    }

    const itemLimitations: string[] = []
    if (unknownValueCount > 0) {
      itemLimitations.push('Affected value is understated: opportunities with no recorded value are excluded rather than assumed to be zero.')
    }

    // Partner coverage on a majority points at teaming before building.
    const recommendation: RoadmapRecommendation =
      covered.length >= Math.ceil(group.length / 2)
        ? 'INVESTIGATE_PARTNER_COVERAGE'
        : group.length >= MIN_RECURRENCE
          ? 'INVESTIGATE_CAPABILITY_DEVELOPMENT'
          : 'RECURRING_GAP'

    const sourceGapIds = [...new Set(group.map((g) => g.assessmentId))].sort()

    items.push({
      gapKey,
      gapLabel: group[0].rawLabel,
      category,
      severity: CATEGORY_SEVERITY[category],
      recommendation,
      affectedOpportunityCount: new Set(group.map((g) => g.opportunityId)).size,
      affectedPursuitCount: pursuits.length,
      knownAffectedValue,
      unknownValueCount,
      partnerCoverageCount: covered.length,
      partnerNames,
      sourceGapIds,
      evidence,
      dataSufficiency: withValue.length === group.length ? 'SUFFICIENT' : withValue.length > 0 ? 'PARTIAL' : 'INSUFFICIENT_DATA',
      limitations: itemLimitations,
      algorithmVersion: ROADMAP_ALGORITHM_VERSION,
      inputHash: createHash('sha256')
        .update(JSON.stringify({ gapKey, ids: sourceGapIds, value: knownAffectedValue, unknown: unknownValueCount, v: ROADMAP_ALGORITHM_VERSION }))
        .digest('hex'),
    })
  }

  const severityRank = { CRITICAL: 0, MAJOR: 1, MINOR: 2 }
  items.sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] ||
    b.knownAffectedValue - a.knownAffectedValue ||
    b.affectedOpportunityCount - a.affectedOpportunityCount ||
    a.gapKey.localeCompare(b.gapKey),
  )

  return {
    items: items.slice(0, MAX_ROADMAP_ITEMS),
    totalGapsObserved: observations.length,
    distinctGaps: groups.size,
    nonRecurringGaps: nonRecurring,
    limitations,
    algorithmVersion: ROADMAP_ALGORITHM_VERSION,
  }
}
