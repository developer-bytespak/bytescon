// =============================================================
// §6.1B — Forecast persistence, history and solicitation linking.
//
// A forecast is never an Opportunity. It is upserted on
// (consultingFirmId, externalId) so repeated syncs update rather than duplicate,
// and every field change writes an immutable AgencyForecastVersion so forecast
// history is preserved.
//
// Linking a forecast to the solicitation that later appears is DETERMINISTIC
// and conservative:
//   - a shared solicitation number is a strong identifier → AUTO_LINKED
//   - agency + NAICS + strong title similarity within the expected window is
//     suggestive, not conclusive → REVIEW_REQUIRED (a human decides)
//   - anything weaker links nothing at all
// Ambiguous forecasts and solicitations are never silently merged.
// =============================================================
import { ForecastLinkState, Prisma, SourceCategory } from '@prisma/client'
import { prisma } from '../../config/database'
import { NormalizedForecast, completenessOf } from './sourceAdapter'

/** Fields whose change is materially interesting and versioned. */
export const VERSIONED_FORECAST_FIELDS = [
  'title', 'description', 'agency', 'subAgency', 'contractingOffice',
  'anticipatedSolicitationDate', 'anticipatedAwardDate', 'fiscalYear',
  'naicsCode', 'psc', 'setAsideExpectation', 'contractVehicle',
  'estimatedValue', 'estimatedValueMin', 'estimatedValueMax',
  'incumbentName', 'placeOfPerformance', 'contactName', 'contactEmail', 'contactPhone',
] as const

type VersionedField = (typeof VERSIONED_FORECAST_FIELDS)[number]

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Date || b instanceof Date) {
    const da = a instanceof Date ? a.getTime() : a === null || a === undefined ? null : new Date(String(a)).getTime()
    const db = b instanceof Date ? b.getTime() : b === null || b === undefined ? null : new Date(String(b)).getTime()
    return da === db
  }
  if (a === null || a === undefined) return b === null || b === undefined
  if (b === null || b === undefined) return false
  // Prisma Decimal and numbers compare by string form.
  return String(a) === String(b)
}

export function diffForecastFields(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): VersionedField[] {
  return VERSIONED_FORECAST_FIELDS.filter((f) => !sameValue(existing[f], incoming[f]))
}

/**
 * Upsert a normalized forecast. Returns 'created' | 'updated' | 'unchanged'.
 * On any material field change the PRIOR state is snapshotted first, so
 * forecast history survives the update.
 */
export async function upsertForecast(
  consultingFirmId: string,
  sourceConfigId: string | null,
  record: NormalizedForecast,
  now: Date,
): Promise<'created' | 'updated' | 'unchanged'> {
  const completeness = completenessOf([
    record.description, record.anticipatedSolicitationDate, record.anticipatedAwardDate,
    record.fiscalYear, record.naicsCode, record.psc, record.setAsideExpectation,
    record.contractVehicle, record.estimatedValue ?? record.estimatedValueMax,
    record.placeOfPerformance, record.contactName ?? record.contactEmail,
  ])

  const incoming = {
    title: record.title,
    description: record.description ?? null,
    agency: record.agency,
    subAgency: record.subAgency ?? null,
    contractingOffice: record.contractingOffice ?? null,
    anticipatedSolicitationDate: record.anticipatedSolicitationDate ?? null,
    anticipatedAwardDate: record.anticipatedAwardDate ?? null,
    fiscalYear: record.fiscalYear ?? null,
    naicsCode: record.naicsCode ?? null,
    psc: record.psc ?? null,
    setAsideExpectation: record.setAsideExpectation ?? null,
    contractVehicle: record.contractVehicle ?? null,
    estimatedValue: record.estimatedValue ?? null,
    estimatedValueMin: record.estimatedValueMin ?? null,
    estimatedValueMax: record.estimatedValueMax ?? null,
    incumbentName: record.incumbentName ?? null,
    placeOfPerformance: record.placeOfPerformance ?? null,
    contactName: record.contactName ?? null,
    contactEmail: record.contactEmail ?? null,
    contactPhone: record.contactPhone ?? null,
  }

  const existing = await prisma.agencyForecast.findUnique({
    where: { consultingFirmId_externalId: { consultingFirmId, externalId: record.externalId } },
  })

  if (!existing) {
    await prisma.agencyForecast.create({
      data: {
        consultingFirmId,
        sourceConfigId,
        source: SourceCategory.AGENCY_FORECAST,
        externalId: record.externalId,
        sourceUrl: record.sourceUrl ?? null,
        sourceReference: record.sourceReference ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        sourceUpdatedAt: record.sourceUpdatedAt ?? null,
        lastSyncedAt: now,
        dataQuality: record.dataQuality,
        sourceMetadata: (record.sourceMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
        completeness,
        ...incoming,
      },
    })
    return 'created'
  }

  const changed = diffForecastFields(existing as unknown as Record<string, unknown>, incoming)

  if (changed.length === 0) {
    await prisma.agencyForecast.update({
      where: { id: existing.id },
      data: { lastSeenAt: now, lastSyncedAt: now, dataQuality: record.dataQuality },
    })
    return 'unchanged'
  }

  // Snapshot the PRIOR state before overwriting — history is preserved.
  const lastVersion = await prisma.agencyForecastVersion.findFirst({
    where: { forecastId: existing.id },
    orderBy: { versionNo: 'desc' },
    select: { versionNo: true },
  })
  await prisma.agencyForecastVersion.create({
    data: {
      forecastId: existing.id,
      versionNo: (lastVersion?.versionNo ?? 0) + 1,
      changedKeys: changed,
      snapshot: JSON.parse(JSON.stringify(existing)) as Prisma.InputJsonValue,
      observedAt: now,
    },
  })

  await prisma.agencyForecast.update({
    where: { id: existing.id },
    data: {
      ...incoming,
      sourceUrl: record.sourceUrl ?? existing.sourceUrl,
      sourceReference: record.sourceReference ?? existing.sourceReference,
      lastSeenAt: now,
      sourceUpdatedAt: record.sourceUpdatedAt ?? existing.sourceUpdatedAt,
      lastSyncedAt: now,
      dataQuality: record.dataQuality,
      sourceMetadata: (record.sourceMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
      completeness,
    },
  })
  return 'updated'
}

// -------------------------------------------------------------
// Deterministic forecast → solicitation linking
// -------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'of', 'to', 'a', 'an', 'in', 'on', 'with', 'services', 'service',
  'support', 'contract', 'program', 'project', 'system', 'systems', 'inc', 'llc',
])

export function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  )
}

/** Jaccard similarity over significant title tokens. 0 when either side is empty. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a)
  const tb = titleTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let intersection = 0
  ta.forEach((t) => { if (tb.has(t)) intersection++ })
  const union = ta.size + tb.size - intersection
  return union === 0 ? 0 : Number((intersection / union).toFixed(4))
}

export interface LinkCandidate {
  opportunityId: string
  state: ForecastLinkState
  confidence: number
  evidence: string
}

export const STRONG_TITLE_SIMILARITY = 0.6
/** How far after the anticipated solicitation date a match is still plausible. */
export const LINK_WINDOW_DAYS = 270

/**
 * Choose a link for one forecast. Returns null when nothing is strong enough —
 * an unlinked forecast is always preferable to a wrong merge.
 */
export function evaluateLinkCandidates(
  forecast: {
    title: string
    agency: string
    naicsCode: string | null
    anticipatedSolicitationDate: Date | null
    externalId: string
  },
  opportunities: Array<{
    id: string
    title: string
    agency: string
    naicsCode: string
    solicitationNumber: string | null
    samNoticeId: string | null
    postedDate: Date | null
  }>,
): LinkCandidate | null {
  // 1. Strong identifier match — the forecast id appears as the solicitation
  //    number (or notice id). Deterministic and conclusive.
  const idNeedle = forecast.externalId.trim().toLowerCase()
  for (const opp of opportunities) {
    const sol = opp.solicitationNumber?.trim().toLowerCase()
    const notice = opp.samNoticeId?.trim().toLowerCase()
    if (idNeedle && (sol === idNeedle || notice === idNeedle)) {
      return {
        opportunityId: opp.id,
        state: ForecastLinkState.AUTO_LINKED,
        confidence: 1,
        evidence: `Forecast identifier "${forecast.externalId}" matches the solicitation number on this notice exactly.`,
      }
    }
  }

  // 2. Suggestive match — same agency, same NAICS, strongly similar title,
  //    posted within the plausible window. Never auto-linked.
  let best: LinkCandidate | null = null
  for (const opp of opportunities) {
    if (opp.agency.trim().toLowerCase() !== forecast.agency.trim().toLowerCase()) continue
    if (!forecast.naicsCode || !opp.naicsCode || opp.naicsCode !== forecast.naicsCode) continue

    if (forecast.anticipatedSolicitationDate && opp.postedDate) {
      const deltaDays = (opp.postedDate.getTime() - forecast.anticipatedSolicitationDate.getTime()) / 86400000
      if (deltaDays < -LINK_WINDOW_DAYS || deltaDays > LINK_WINDOW_DAYS) continue
    }

    const similarity = titleSimilarity(forecast.title, opp.title)
    if (similarity < STRONG_TITLE_SIMILARITY) continue

    if (!best || similarity > best.confidence) {
      best = {
        opportunityId: opp.id,
        state: ForecastLinkState.REVIEW_REQUIRED,
        confidence: similarity,
        evidence:
          `Same agency and NAICS ${opp.naicsCode}, title similarity ${(similarity * 100).toFixed(0)}%` +
          (forecast.anticipatedSolicitationDate ? `, posted within ${LINK_WINDOW_DAYS} days of the anticipated solicitation date` : '') +
          '. Identifiers do not match, so this needs human confirmation.',
      }
    }
  }
  return best
}

/**
 * Scan a firm's unlinked forecasts and attach candidates. Idempotent: a
 * forecast a human has confirmed or rejected is never revisited.
 */
export async function linkForecastsToSolicitations(
  consultingFirmId: string,
  now: Date = new Date(),
): Promise<{ examined: number; autoLinked: number; flaggedForReview: number }> {
  const forecasts = await prisma.agencyForecast.findMany({
    where: {
      consultingFirmId,
      isArchived: false,
      linkState: { in: [ForecastLinkState.UNLINKED, ForecastLinkState.REVIEW_REQUIRED] },
    },
    select: {
      id: true, title: true, agency: true, naicsCode: true,
      anticipatedSolicitationDate: true, externalId: true, linkState: true,
    },
    take: 500,
  })
  if (forecasts.length === 0) return { examined: 0, autoLinked: 0, flaggedForReview: 0 }

  const agencies = [...new Set(forecasts.map((f) => f.agency))]
  const opportunities = await prisma.opportunity.findMany({
    where: { consultingFirmId, isDemo: false, agency: { in: agencies } },
    select: { id: true, title: true, agency: true, naicsCode: true, solicitationNumber: true, samNoticeId: true, postedDate: true },
    take: 5000,
  })

  let autoLinked = 0
  let flaggedForReview = 0

  for (const forecast of forecasts) {
    const candidate = evaluateLinkCandidates(forecast, opportunities)
    if (!candidate) continue
    // Do not downgrade an existing review flag by rewriting it every cycle.
    if (forecast.linkState === ForecastLinkState.REVIEW_REQUIRED && candidate.state === ForecastLinkState.REVIEW_REQUIRED) continue

    await prisma.agencyForecast.update({
      where: { id: forecast.id },
      data: {
        linkedOpportunityId: candidate.opportunityId,
        linkState: candidate.state,
        linkEvidence: candidate.evidence,
        linkConfidence: candidate.confidence,
        linkedAt: candidate.state === ForecastLinkState.AUTO_LINKED ? now : null,
      },
    })
    if (candidate.state === ForecastLinkState.AUTO_LINKED) autoLinked++
    else flaggedForReview++
  }

  return { examined: forecasts.length, autoLinked, flaggedForReview }
}
