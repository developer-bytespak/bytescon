// =============================================================
// §6.2C / §6.2D — Incumbent retention and competitor mapping.
//
// Extends the existing Competitor evidence layer (§5.1 Stage 3) rather than
// introducing another incumbent or competitor model. Competitor rows stay the
// per-opportunity evidence; these aggregates are the cross-opportunity
// statistics those rows are read against.
//
// THE LABELLING RULE (§6.2D, non-negotiable):
//   Award share is NEVER called a bid win rate. We observe awards, not bids.
//   Unless real bid-participation data exists (a recorded loss against a known
//   competitor), the basis is OBSERVED_AWARD_SHARE or HISTORICAL_AWARD_FREQUENCY
//   and the label says so verbatim. `basisLabel` is the exact string the UI
//   renders — there is no second wording anywhere.
//
// Every rate carries its denominator. A rate with too small a denominator is
// null, not a misleading percentage.
// =============================================================
import { EvidenceConfidence, Prisma, RateBasis } from '@prisma/client'
import { prisma } from '../../config/database'

export const METHOD_VERSION = 'v1'
/** Below this many observations no rate is stated at all. */
export const MIN_SAMPLE_FOR_RATE = 3
/** Below this many observations a rate is stated but flagged AMBIGUOUS. */
export const MIN_SAMPLE_FOR_PROBABLE = 8
/** Default look-back window for award evidence. */
export const DEFAULT_WINDOW_YEARS = 5

/** The EXACT wording rendered for each basis. Never paraphrased downstream. */
export const BASIS_LABELS: Record<RateBasis, string> = {
  CONFIRMED_WIN_RATE: 'Confirmed win rate',
  OBSERVED_AWARD_SHARE: 'Observed award share',
  HISTORICAL_AWARD_FREQUENCY: 'Historical award frequency',
  INSUFFICIENT_DATA: 'Bid-participation data unavailable',
}

export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(inc|llc|l\.l\.c|corp|corporation|company|co|ltd|limited|lp|llp|plc|holdings|group|technologies|technology|solutions|services|systems)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function confidenceFor(sampleSize: number): EvidenceConfidence {
  if (sampleSize >= MIN_SAMPLE_FOR_PROBABLE) return EvidenceConfidence.PROBABLE
  if (sampleSize >= MIN_SAMPLE_FOR_RATE) return EvidenceConfidence.AMBIGUOUS
  return EvidenceConfidence.NOT_AVAILABLE
}

// -------------------------------------------------------------
// §6.2C — Incumbent retention
// -------------------------------------------------------------

export interface AwardObservation {
  contractNumber: string | null
  recipientName: string
  recipientUei: string | null
  agency: string
  naics: string | null
  psc: string | null
  awardDate: Date
  awardAmount: unknown
}

export interface RetentionComputation {
  similarAwardCount: number
  retainedCount: number
  lostRecompeteCount: number
  retentionRate: number | null
  basis: RateBasis
  sampleSize: number
  confidence: EvidenceConfidence
  explanation: string
  evidence: Array<Record<string, unknown>>
}

/**
 * Compute retention for one incumbent from award observations.
 *
 * Retention is defined observably: a contract number that appears MORE THAN
 * ONCE with the same recipient is a retained re-compete; one that appears again
 * with a DIFFERENT recipient is a lost re-compete. A contract number seen only
 * once tells us nothing about retention and is excluded from the denominator —
 * which is why a single ambiguous record can never produce a retention rate.
 */
export function computeRetention(
  incumbentNormalized: string,
  awards: AwardObservation[],
): RetentionComputation {
  const byContract = new Map<string, AwardObservation[]>()
  for (const a of awards) {
    if (!a.contractNumber) continue
    const list = byContract.get(a.contractNumber) ?? []
    list.push(a)
    byContract.set(a.contractNumber, list)
  }

  let retained = 0
  let lost = 0
  const evidence: Array<Record<string, unknown>> = []

  for (const [contractNumber, observations] of byContract) {
    if (observations.length < 2) continue // a single record proves nothing
    const sorted = [...observations].sort((x, y) => x.awardDate.getTime() - y.awardDate.getTime())
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const firstWasIncumbent = normalizeCompanyName(first.recipientName) === incumbentNormalized
    if (!firstWasIncumbent) continue

    const lastIsIncumbent = normalizeCompanyName(last.recipientName) === incumbentNormalized
    if (lastIsIncumbent) retained++
    else lost++

    evidence.push({
      contractNumber,
      observations: sorted.length,
      firstRecipient: first.recipientName,
      firstAwardDate: first.awardDate.toISOString().slice(0, 10),
      latestRecipient: last.recipientName,
      latestAwardDate: last.awardDate.toISOString().slice(0, 10),
      outcome: lastIsIncumbent ? 'RETAINED' : 'LOST',
    })
  }

  const similarAwardCount = awards.filter((a) => normalizeCompanyName(a.recipientName) === incumbentNormalized).length
  const denominator = retained + lost

  if (denominator < MIN_SAMPLE_FOR_RATE) {
    return {
      similarAwardCount, retainedCount: retained, lostRecompeteCount: lost,
      // No denominator, no percentage. This is the §6.2C rule.
      retentionRate: null,
      basis: RateBasis.INSUFFICIENT_DATA,
      sampleSize: denominator,
      confidence: EvidenceConfidence.NOT_AVAILABLE,
      explanation:
        `Only ${denominator} contract(s) in the available award history show a re-compete for this holder — fewer than the ${MIN_SAMPLE_FOR_RATE} needed to state a retention rate. ` +
        `${similarAwardCount} related award record(s) were seen in total, but a single award record does not establish whether the work was retained.`,
      evidence,
    }
  }

  const rate = Number((retained / denominator).toFixed(4))
  return {
    similarAwardCount, retainedCount: retained, lostRecompeteCount: lost,
    retentionRate: rate,
    basis: RateBasis.OBSERVED_AWARD_SHARE,
    sampleSize: denominator,
    confidence: confidenceFor(denominator),
    explanation:
      `Retained ${retained} of ${denominator} observed re-competes (${(rate * 100).toFixed(0)}%). ` +
      'This is derived from repeated contract numbers in public award history, so it reflects observed outcomes rather than confirmed bid participation.',
    evidence,
  }
}

/**
 * Refresh incumbent retention aggregates for a firm. Manual corrections on
 * Competitor rows are untouched — this writes only the aggregate table.
 */
export async function refreshIncumbentRetention(
  consultingFirmId: string,
  options: { windowYears?: number; now?: Date; limit?: number } = {},
): Promise<{ incumbents: number; withRate: number; insufficient: number }> {
  const now = options.now ?? new Date()
  const windowStart = new Date(now.getTime() - (options.windowYears ?? DEFAULT_WINDOW_YEARS) * 365 * 86400000)

  // Identified incumbents from the existing evidence layer.
  const incumbents = await prisma.competitor.findMany({
    where: { consultingFirmId, evidenceKind: 'INCUMBENT' },
    select: { name: true, normalizedName: true, uei: true, agency: true, opportunity: { select: { naicsCode: true, psc: true, agency: true } } },
    take: options.limit ?? 300,
  })
  if (incumbents.length === 0) return { incumbents: 0, withRate: 0, insufficient: 0 }

  const awards = await prisma.awardHistory.findMany({
    where: { opportunity: { consultingFirmId, isDemo: false }, awardDate: { gte: windowStart } },
    select: {
      contractNumber: true, recipientName: true, recipientUei: true,
      awardingAgency: true, naics: true, psc: true, awardDate: true, awardAmount: true,
    },
    take: 20000,
  })

  const observations: AwardObservation[] = awards.map((a) => ({
    contractNumber: a.contractNumber,
    recipientName: a.recipientName,
    recipientUei: a.recipientUei,
    agency: a.awardingAgency,
    naics: a.naics,
    psc: a.psc,
    awardDate: a.awardDate,
    awardAmount: a.awardAmount,
  }))

  // One aggregate per (incumbent, agency, NAICS) slice.
  const slices = new Map<string, { name: string; uei: string | null; agency: string | null; naics: string | null }>()
  for (const inc of incumbents) {
    const normalized = inc.normalizedName || normalizeCompanyName(inc.name)
    if (!normalized) continue
    const agency = inc.agency ?? inc.opportunity?.agency ?? null
    const naics = inc.opportunity?.naicsCode || null
    slices.set(`${normalized}|${agency ?? ''}|${naics ?? ''}`, { name: inc.name, uei: inc.uei, agency, naics })
  }

  let withRate = 0
  let insufficient = 0

  for (const [key, slice] of slices) {
    const normalized = key.split('|')[0]
    const scoped = observations.filter((o) => {
      if (slice.agency && o.agency.toLowerCase() !== slice.agency.toLowerCase()) return false
      if (slice.naics && o.naics && o.naics !== slice.naics) return false
      return true
    })
    const computed = computeRetention(normalized, scoped)

    // Agency-specific rate, computed only when the slice is agency-scoped.
    const agencyScoped = slice.agency ? computeRetention(normalized, observations.filter((o) => o.agency.toLowerCase() === slice.agency!.toLowerCase())) : null

    await prisma.incumbentRetentionStat.upsert({
      where: {
        consultingFirmId_normalizedName_agency_naicsCode: {
          consultingFirmId, normalizedName: normalized, agency: slice.agency ?? '', naicsCode: slice.naics ?? '',
        },
      },
      create: {
        consultingFirmId,
        incumbentName: slice.name,
        normalizedName: normalized,
        incumbentUei: slice.uei,
        agency: slice.agency,
        naicsCode: slice.naics,
        similarAwardCount: computed.similarAwardCount,
        retainedCount: computed.retainedCount,
        lostRecompeteCount: computed.lostRecompeteCount,
        retentionRate: computed.retentionRate,
        agencyRetentionRate: agencyScoped?.retentionRate ?? null,
        basis: computed.basis,
        sampleSize: computed.sampleSize,
        windowStart,
        windowEnd: now,
        evidence: JSON.parse(JSON.stringify(computed.evidence)) as Prisma.InputJsonValue,
        evidenceSource: 'USAspending award history (via AwardHistory)',
        confidence: computed.confidence,
        explanation: computed.explanation,
        methodVersion: METHOD_VERSION,
        lastRefreshedAt: now,
      },
      update: {
        incumbentName: slice.name,
        similarAwardCount: computed.similarAwardCount,
        retainedCount: computed.retainedCount,
        lostRecompeteCount: computed.lostRecompeteCount,
        retentionRate: computed.retentionRate,
        agencyRetentionRate: agencyScoped?.retentionRate ?? null,
        basis: computed.basis,
        sampleSize: computed.sampleSize,
        windowStart,
        windowEnd: now,
        evidence: JSON.parse(JSON.stringify(computed.evidence)) as Prisma.InputJsonValue,
        confidence: computed.confidence,
        explanation: computed.explanation,
        lastRefreshedAt: now,
      },
    })

    if (computed.retentionRate !== null) withRate++
    else insufficient++
  }

  return { incumbents: slices.size, withRate, insufficient }
}

// -------------------------------------------------------------
// §6.2D — Competitor award statistics
// -------------------------------------------------------------

export interface CompetitorComputation {
  observedAwards: number
  comparableAwardPool: number
  confirmedWins: number
  confirmedLosses: number
  confirmedBids: number
  confirmedWinRate: number | null
  observedAwardShare: number | null
  basis: RateBasis
  basisLabel: string
  sampleSize: number
  confidence: EvidenceConfidence
  explanation: string
}

/**
 * Decide the honest basis for a competitor's rate.
 *
 * CONFIRMED_WIN_RATE is used ONLY when real bid-participation data exists —
 * i.e. we know of bids this competitor lost as well as won. Award records alone
 * never qualify, because a public award tells us who won, not who bid.
 */
export function computeCompetitorStat(
  observedAwards: number,
  comparableAwardPool: number,
  confirmed: { wins: number; losses: number },
): CompetitorComputation {
  const confirmedBids = confirmed.wins + confirmed.losses

  if (confirmedBids >= MIN_SAMPLE_FOR_RATE) {
    const rate = Number((confirmed.wins / confirmedBids).toFixed(4))
    return {
      observedAwards, comparableAwardPool,
      confirmedWins: confirmed.wins, confirmedLosses: confirmed.losses, confirmedBids,
      confirmedWinRate: rate,
      observedAwardShare: null,
      basis: RateBasis.CONFIRMED_WIN_RATE,
      basisLabel: BASIS_LABELS.CONFIRMED_WIN_RATE,
      sampleSize: confirmedBids,
      confidence: confidenceFor(confirmedBids),
      explanation: `Won ${confirmed.wins} of ${confirmedBids} bids where participation is actually recorded (${(rate * 100).toFixed(0)}%).`,
    }
  }

  if (comparableAwardPool >= MIN_SAMPLE_FOR_RATE && observedAwards > 0) {
    const share = Number((observedAwards / comparableAwardPool).toFixed(4))
    return {
      observedAwards, comparableAwardPool,
      confirmedWins: confirmed.wins, confirmedLosses: confirmed.losses, confirmedBids,
      confirmedWinRate: null,
      observedAwardShare: share,
      basis: RateBasis.OBSERVED_AWARD_SHARE,
      basisLabel: BASIS_LABELS.OBSERVED_AWARD_SHARE,
      sampleSize: comparableAwardPool,
      confidence: confidenceFor(comparableAwardPool),
      explanation:
        `Holds ${observedAwards} of ${comparableAwardPool} comparable awards (${(share * 100).toFixed(0)}% award share). ` +
        'Bid-participation data is unavailable, so this is a share of awards observed — not a win rate.',
    }
  }

  if (observedAwards > 0) {
    return {
      observedAwards, comparableAwardPool,
      confirmedWins: confirmed.wins, confirmedLosses: confirmed.losses, confirmedBids,
      confirmedWinRate: null, observedAwardShare: null,
      basis: RateBasis.HISTORICAL_AWARD_FREQUENCY,
      basisLabel: BASIS_LABELS.HISTORICAL_AWARD_FREQUENCY,
      sampleSize: observedAwards,
      confidence: EvidenceConfidence.NOT_AVAILABLE,
      explanation: `${observedAwards} comparable award(s) observed. The comparable pool is too small to express this as a share, and bid-participation data is unavailable.`,
    }
  }

  return {
    observedAwards: 0, comparableAwardPool,
    confirmedWins: 0, confirmedLosses: 0, confirmedBids: 0,
    confirmedWinRate: null, observedAwardShare: null,
    basis: RateBasis.INSUFFICIENT_DATA,
    basisLabel: BASIS_LABELS.INSUFFICIENT_DATA,
    sampleSize: 0,
    confidence: EvidenceConfidence.NOT_AVAILABLE,
    explanation: 'No comparable award records were found for this competitor, and no bid-participation data is available.',
  }
}

export async function refreshCompetitorStats(
  consultingFirmId: string,
  options: { windowYears?: number; now?: Date; limit?: number } = {},
): Promise<{ competitors: number; withConfirmedWinRate: number; withAwardShare: number; insufficient: number }> {
  const now = options.now ?? new Date()
  const windowStart = new Date(now.getTime() - (options.windowYears ?? DEFAULT_WINDOW_YEARS) * 365 * 86400000)

  const competitors = await prisma.competitor.findMany({
    where: { consultingFirmId },
    select: {
      name: true, normalizedName: true, uei: true, agency: true, isIncumbent: true,
      opportunity: { select: { naicsCode: true, psc: true, agency: true } },
    },
    take: options.limit ?? 500,
  })
  if (competitors.length === 0) return { competitors: 0, withConfirmedWinRate: 0, withAwardShare: 0, insufficient: 0 }

  const awards = await prisma.awardHistory.findMany({
    where: { opportunity: { consultingFirmId, isDemo: false }, awardDate: { gte: windowStart } },
    select: { recipientName: true, awardingAgency: true, naics: true, awardAmount: true },
    take: 20000,
  })

  const slices = new Map<string, { name: string; uei: string | null; agency: string | null; naics: string | null; isIncumbent: boolean }>()
  for (const c of competitors) {
    const normalized = c.normalizedName || normalizeCompanyName(c.name)
    if (!normalized) continue
    const agency = c.agency ?? c.opportunity?.agency ?? null
    const naics = c.opportunity?.naicsCode || null
    const key = `${normalized}|${agency ?? ''}|${naics ?? ''}`
    const prior = slices.get(key)
    slices.set(key, {
      name: c.name, uei: c.uei ?? prior?.uei ?? null, agency, naics,
      isIncumbent: c.isIncumbent || Boolean(prior?.isIncumbent),
    })
  }

  let withConfirmedWinRate = 0
  let withAwardShare = 0
  let insufficient = 0

  for (const [key, slice] of slices) {
    const normalized = key.split('|')[0]
    const pool = awards.filter((a) => {
      if (slice.agency && a.awardingAgency.toLowerCase() !== slice.agency.toLowerCase()) return false
      if (slice.naics && a.naics && a.naics !== slice.naics) return false
      return true
    })
    const observedAwards = pool.filter((a) => normalizeCompanyName(a.recipientName) === normalized).length

    // Real bid participation would come from recorded head-to-head outcomes.
    // The platform does not currently capture who else bid, so this stays zero
    // and the basis can never be CONFIRMED_WIN_RATE from award data alone.
    const confirmed = { wins: 0, losses: 0 }

    const computed = computeCompetitorStat(observedAwards, pool.length, confirmed)

    await prisma.competitorAwardStat.upsert({
      where: {
        consultingFirmId_normalizedName_agency_naicsCode: {
          consultingFirmId, normalizedName: normalized, agency: slice.agency ?? '', naicsCode: slice.naics ?? '',
        },
      },
      create: {
        consultingFirmId,
        competitorName: slice.name,
        normalizedName: normalized,
        uei: slice.uei,
        agency: slice.agency,
        naicsCode: slice.naics,
        observedAwards: computed.observedAwards,
        comparableAwardPool: computed.comparableAwardPool,
        confirmedWins: computed.confirmedWins,
        confirmedLosses: computed.confirmedLosses,
        confirmedBids: computed.confirmedBids,
        confirmedWinRate: computed.confirmedWinRate,
        observedAwardShare: computed.observedAwardShare,
        basis: computed.basis,
        basisLabel: computed.basisLabel,
        isIncumbent: slice.isIncumbent,
        sampleSize: computed.sampleSize,
        windowStart,
        windowEnd: now,
        evidence: JSON.parse(JSON.stringify({ comparablePool: computed.comparableAwardPool, observedAwards: computed.observedAwards })) as Prisma.InputJsonValue,
        evidenceSource: 'USAspending award history (via AwardHistory)',
        confidence: computed.confidence,
        explanation: computed.explanation,
        methodVersion: METHOD_VERSION,
        lastRefreshedAt: now,
      },
      update: {
        competitorName: slice.name,
        observedAwards: computed.observedAwards,
        comparableAwardPool: computed.comparableAwardPool,
        confirmedWins: computed.confirmedWins,
        confirmedLosses: computed.confirmedLosses,
        confirmedBids: computed.confirmedBids,
        confirmedWinRate: computed.confirmedWinRate,
        observedAwardShare: computed.observedAwardShare,
        basis: computed.basis,
        basisLabel: computed.basisLabel,
        isIncumbent: slice.isIncumbent,
        sampleSize: computed.sampleSize,
        windowStart,
        windowEnd: now,
        confidence: computed.confidence,
        explanation: computed.explanation,
        lastRefreshedAt: now,
      },
    })

    if (computed.basis === RateBasis.CONFIRMED_WIN_RATE) withConfirmedWinRate++
    else if (computed.basis === RateBasis.OBSERVED_AWARD_SHARE) withAwardShare++
    else insufficient++
  }

  return { competitors: slices.size, withConfirmedWinRate, withAwardShare, insufficient }
}
