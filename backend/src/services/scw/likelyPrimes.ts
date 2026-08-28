// =============================================================
// SCW-1 Likely Prime Identifier
//
// Per SUBCONTRACTING_WORKFLOW_SPEC.md §3, given an opportunity, return the
// top 10 ranked candidate primes — bidders who have historically won
// similar work and might therefore be persuaded to take this tenant on as
// a sub. Tenant-scoped via the opportunity's consultingFirmId.
//
// Spec adaptations against actual data (see docs/scw/data-layer-
// introspection.md §9):
//   - Corpus = winners_award_stage (USAspending V2 bulk), NOT award_history
//     (which is per-opportunity history and lacks UEIs).
//   - Aggregation key = recipientName (UEI coverage is only 381 / 11,222
//     rows — too sparse for primary identity). UEI is JOINed when present
//     for contact + SDVOSB lookup against recipient_profiles.
//   - Agency match = Opportunity.agency's first dotted segment ILIKE'd
//     against winners_award_stage.agencyToptierName (SAM.gov ships the
//     hierarchy in dotted form, e.g. "GSA.PBS.PROJECT DELIVERY EAST").
//   - SDVOSB exclusion uses recipient_profiles.sdvosb (SAM.gov source of
//     truth per the data tier model) — NOT winners_award_stage.setAsideType
//     which is sparsely populated and inherently a per-award stamp.
//   - Primes without a RecipientProfile entry are INCLUDED with an explicit
//     "SDVOSB status unverified" warning per spec §2.5 "no silent failures."
// =============================================================

import { Prisma, RecipientProfile } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { NotFoundError } from '../../utils/errors'
import { readCachedContacts } from '../recipientProfileService'
import {
  scoreAwardFrequency,
  scoreAwardRecency,
  scoreDollarVolume,
  scoreSubawardPropensity,
  scoreSdvosbGoalGap,
  composeConfidence,
  PrimeStats,
  SubawardStats,
  SdvosbStats,
  AggregateContext,
  CompositeConfidence,
} from './confidence'

const LOOKBACK_YEARS = 5
const TOP_N = 10

// =============================================================
// Public types (matches SUBCONTRACTING_WORKFLOW_SPEC.md §3 SCW-1)
// =============================================================

export interface LikelyPrime {
  /** USAspending UEI when known; empty string when only name is available. */
  primeUei: string
  primeName: string
  pastAwardsCount: number
  totalPastValue: number
  mostRecentAward: Date | null
  contact: {
    name: string | null
    email: string | null
    phone: string | null
    source: 'recipient_profiles_cache' | 'sam_gov_live' | 'manual_research_required'
  }
  sdvosbCertified: boolean
  businessSize: string | null
  confidence: CompositeConfidence
  dataQuality: {
    hasContact: boolean
    hasSubawardHistory: boolean
    hasSdvosbGoalData: boolean
    warnings: string[]
  }
}

export interface FindLikelyPrimesInput {
  opportunityId: string
  consultingFirmId: string
}

// =============================================================
// Internal row shapes from raw SQL aggregations
// =============================================================

interface CandidateAggRow {
  prime_name: string
  prime_uei: string | null
  past_awards_count: bigint
  total_past_value: string  // Decimal serialized; convert to number
  most_recent_award: Date | null
}

interface SubawardAggRow {
  prime_name: string
  total_award_dollars: string
  total_subaward_dollars: string
  sample_size: bigint
}

// =============================================================
// Public entry point
// =============================================================

export async function findLikelyPrimes(input: FindLikelyPrimesInput): Promise<LikelyPrime[]> {
  const { opportunityId, consultingFirmId } = input

  // Tenant-scoped opportunity load. NotFoundError if the opportunity exists
  // for a different firm — never reveal cross-tenant data.
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: {
      id: true,
      naicsCode: true,
      agency: true,
      subagency: true,
      setAsideType: true,
      postedDate: true,
      responseDeadline: true,
    },
  })
  if (!opp) {
    throw new NotFoundError(`Opportunity ${opportunityId}`)
  }
  if (!opp.naicsCode) {
    logger.warn('SCW-1: opportunity missing NAICS code', { opportunityId, consultingFirmId })
    return []
  }

  // Normalize the agency: SAM.gov ships hierarchy in dotted form
  // ("GSA.PBS.PROJECT DELIVERY EAST"). Take the first segment for ILIKE.
  const agencyFirstSegment = (opp.agency ?? '').split('.')[0]?.trim()
  if (!agencyFirstSegment) {
    logger.warn('SCW-1: opportunity missing agency', { opportunityId })
    return []
  }
  const agencyPattern = `${agencyFirstSegment}%`

  // Pass 1: aggregate prime-side awards in (NAICS, agency) over the lookback
  // window. Pick a representative UEI per name (any non-null) so we can
  // optionally join to recipient_profiles downstream. The 5-year cutoff
  // matches the spec's "past 5 years" requirement.
  const lookbackCutoff = new Date()
  lookbackCutoff.setUTCFullYear(lookbackCutoff.getUTCFullYear() - LOOKBACK_YEARS)

  const candidates = await prisma.$queryRaw<CandidateAggRow[]>`
    SELECT
      "recipientName"                                         AS prime_name,
      MAX("recipientUei") FILTER (WHERE "recipientUei" <> '') AS prime_uei,
      COUNT(*)                                                AS past_awards_count,
      SUM("totalObligation")                                  AS total_past_value,
      MAX("awardDate")                                        AS most_recent_award
    FROM winners_award_stage
    WHERE naics = ${opp.naicsCode}
      AND "agencyToptierName" ILIKE ${agencyPattern}
      AND "awardDate" >= ${lookbackCutoff}
      AND "recipientName" IS NOT NULL
      AND "recipientName" <> ''
    GROUP BY "recipientName"
    ORDER BY past_awards_count DESC, total_past_value DESC
    LIMIT 50
  `

  if (candidates.length === 0) {
    logger.info('SCW-1: no candidate primes found', {
      opportunityId,
      naics: opp.naicsCode,
      agency: agencyFirstSegment,
    })
    return []
  }

  // Pass 2: pull RecipientProfile rows for the candidates with UEI. Used
  // for SDVOSB exclusion and contact attribution. Empty table is fine —
  // dataQuality.hasContact stays false and warnings fire per spec §2.5.
  const candidateUeis = candidates
    .map((c) => c.prime_uei)
    .filter((u): u is string => !!u && u.length > 0)
  const profilesByUei = new Map<string, RecipientProfile>()
  if (candidateUeis.length > 0) {
    const profiles = await loadProfiles(candidateUeis)
    for (const p of profiles) profilesByUei.set(p.uei, p)
  }

  // Pass 3: aggregate subaward stats per candidate prime (joined via the
  // prime's award IDs). Powers scoreSubawardPropensity.
  const subStatsByName = await aggregateSubawardStatsByName(
    candidates.map((c) => c.prime_name),
    opp.naicsCode,
    agencyPattern,
    lookbackCutoff,
  )

  // Build aggregate context for cross-candidate normalization.
  const top = candidates.reduce(
    (acc, c) => ({
      topPastAwardsCount: Math.max(acc.topPastAwardsCount, Number(c.past_awards_count)),
      topTotalPastValue: Math.max(acc.topTotalPastValue, Number(c.total_past_value ?? 0)),
    }),
    { topPastAwardsCount: 0, topTotalPastValue: 0 } as AggregateContext,
  )

  // Citation string surfaced in the UI per spec §2.2 "cite the data source".
  const citation = `Based on past awards in NAICS ${opp.naicsCode} to ${agencyFirstSegment}, ${lookbackCutoff.toISOString().slice(0, 10)}–${new Date().toISOString().slice(0, 10)}, USAspending V2 corpus.`

  const ranked: LikelyPrime[] = []
  let excludedSdvosbCount = 0

  for (const c of candidates) {
    const profile = c.prime_uei ? profilesByUei.get(c.prime_uei) : undefined

    // Spec §3 SCW-1 step 5: exclude primes that are themselves SDVOSB.
    // Only when we KNOW they're SDVOSB from RecipientProfile — never silently
    // include or exclude when unknown.
    if (profile?.sdvosb === true) {
      excludedSdvosbCount++
      continue
    }

    const stats: PrimeStats = {
      pastAwardsCount: Number(c.past_awards_count),
      totalPastValue: Number(c.total_past_value ?? 0),
      mostRecentAward: c.most_recent_award,
    }
    const subStats: SubawardStats = subStatsByName.get(c.prime_name) ?? {
      totalAwardDollars: stats.totalPastValue,
      totalSubawardDollars: 0,
      sampleSize: 0,
    }
    const sdvosbStats: SdvosbStats = {
      // R4: SDVOSB subaward flags currently unavailable from USAspending.
      // hasGoalData stays false until SAM enrichment or BigQuery pivot.
      hasGoalData: false,
      goalPercent: null,
      actualPercent: null,
    }

    const components = {
      awardFrequency: scoreAwardFrequency(stats, top),
      awardRecency: scoreAwardRecency(stats),
      dollarVolume: scoreDollarVolume(stats, top),
      subawardPropensity: scoreSubawardPropensity(subStats),
      sdvosbGoalGap: scoreSdvosbGoalGap(sdvosbStats),
    }
    const confidence = composeConfidence(components, citation)

    const warnings: string[] = []
    if (!profile) {
      warnings.push('SDVOSB status unverified — RecipientProfile not on file (SAM.gov enrichment pending).')
    }
    if (subStats.sampleSize === 0) {
      warnings.push('No subaward history available — propensity defaulted to zero.')
    }
    if (!sdvosbStats.hasGoalData) {
      warnings.push('SDVOSB goal-gap data unavailable (R4 in data-layer-introspection.md).')
    }

    ranked.push({
      primeUei: c.prime_uei ?? '',
      primeName: c.prime_name,
      pastAwardsCount: stats.pastAwardsCount,
      totalPastValue: stats.totalPastValue,
      mostRecentAward: stats.mostRecentAward,
      contact: buildContact(profile),
      sdvosbCertified: profile?.sdvosb ?? false,
      businessSize: deriveBusinessSize(profile),
      confidence,
      dataQuality: {
        hasContact: hasAnyContact(profile),
        hasSubawardHistory: subStats.sampleSize > 0,
        hasSdvosbGoalData: sdvosbStats.hasGoalData,
        warnings,
      },
    })
  }

  ranked.sort((a, b) => b.confidence.composite - a.confidence.composite)
  const top10 = ranked.slice(0, TOP_N)

  logger.info('SCW-1: likely primes computed', {
    opportunityId,
    consultingFirmId,
    candidates: candidates.length,
    excludedSdvosb: excludedSdvosbCount,
    returned: top10.length,
  })

  return top10
}

// =============================================================
// Helpers
// =============================================================

async function loadProfiles(ueis: string[]): Promise<RecipientProfile[]> {
  // Return the full RecipientProfile shape so we can hand each row to
  // readCachedContacts() in recipientProfileService — the canonical layer
  // that owns the contactsJson schema. Avoids reimplementing contact
  // parsing locally (we did, and PR #4 moved it elsewhere on us).
  return prisma.recipientProfile.findMany({ where: { uei: { in: ueis } } })
}

async function aggregateSubawardStatsByName(
  names: string[],
  naics: string,
  agencyPattern: string,
  lookbackCutoff: Date,
): Promise<Map<string, SubawardStats>> {
  if (names.length === 0) return new Map()

  // Aggregate sub-side $ joined back to the prime-side row that matches
  // our (NAICS, agency, recency) filter. This keeps subaward propensity
  // scoped to the same window we evaluate prime activity over — spec §3
  // expects window-scoped ratios, not cross-portfolio bleed.
  const rows = await prisma.$queryRaw<SubawardAggRow[]>`
    SELECT
      was."recipientName"             AS prime_name,
      SUM(was."totalObligation")      AS total_award_dollars,
      SUM(wss."subAmount")            AS total_subaward_dollars,
      COUNT(wss.id)                   AS sample_size
    FROM winners_award_stage was
    LEFT JOIN winners_subaward_stage wss ON wss."primeAwardId" = was."usaspendingAwardId"
    WHERE was."recipientName" IN (${Prisma.join(names)})
      AND was.naics = ${naics}
      AND was."agencyToptierName" ILIKE ${agencyPattern}
      AND was."awardDate" >= ${lookbackCutoff}
    GROUP BY was."recipientName"
  `

  const out = new Map<string, SubawardStats>()
  for (const r of rows) {
    out.set(r.prime_name, {
      totalAwardDollars: Number(r.total_award_dollars ?? 0),
      totalSubawardDollars: Number(r.total_subaward_dollars ?? 0),
      sampleSize: Number(r.sample_size),
    })
  }
  return out
}

function buildContact(profile: RecipientProfile | undefined): LikelyPrime['contact'] {
  if (!profile) {
    return { name: null, email: null, phone: null, source: 'manual_research_required' }
  }
  // readCachedContacts is the canonical reader for RecipientProfile.contactsJson
  // (PR #4 / recipientProfileService). Returns the provider-tagged ContactRow[]
  // exactly as the contact-provider plugin layer wrote it. Pick the first row
  // as the "primary" for display — SCW-3 will add a UI affordance to switch.
  const { contacts } = readCachedContacts(profile)
  const primary = contacts.find((c) => c.name || c.email || c.phone)
  if (primary) {
    return {
      name: primary.name,
      email: primary.email,
      phone: primary.phone ?? profile.phone,
      source: 'recipient_profiles_cache',
    }
  }
  // No structured contact rows yet — fall back to SAM Entity's flat phone
  // column if present, else explicit manual-research-required state.
  if (profile.phone) {
    return { name: null, email: null, phone: profile.phone, source: 'recipient_profiles_cache' }
  }
  return { name: null, email: null, phone: null, source: 'manual_research_required' }
}

function hasAnyContact(profile: RecipientProfile | undefined): boolean {
  if (!profile) return false
  if (profile.phone) return true
  return readCachedContacts(profile).contacts.length > 0
}

function deriveBusinessSize(profile: RecipientProfile | undefined): string | null {
  if (!profile) return null
  if (profile.smallBusiness) return 'small'
  // SAM Entity doesn't return a "large" classification directly — if any of
  // the small-biz cert flags are set, treat as small; otherwise null
  // (honest unknown) rather than guessing "large".
  if (profile.sdvosb || profile.wosb || profile.hubzone) return 'small'
  return null
}
