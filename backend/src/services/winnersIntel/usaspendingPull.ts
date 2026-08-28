// =============================================================
// USAspending Pull — Winners Intel
//
// Page-by-page fetch of prime contract award rows from USAspending's
// /search/spending_by_award endpoint, mapped to the WinnersAwardStage
// shape. Pure function — caller decides time windows, persists results.
//
// Why this lives next to (not inside) the BigQuery ingestionService:
//   - Different output target (Postgres staging vs BigQuery)
//   - Different field selection (the staging schema is denser)
//   - Different time-window pattern (24 months sliced, not per-NAICS)
// Reusing the HTTP client + retry shape, not the persist layer.
// =============================================================

import axios from 'axios'
import { logger } from '../../utils/logger'

const USA_SPENDING_BASE = process.env.USASPENDING_BASE_URL || 'https://api.usaspending.gov/api/v2'

/** Shape that matches WinnersAwardStage on the persistence side. */
export interface RawWinnerAward {
  usaspendingAwardId: string
  pieceOfTheActionId: string | null
  recipientUei: string | null
  recipientName: string | null
  recipientParentUei: string | null
  agencyToptierCode: string | null
  agencyToptierName: string | null
  agencySubtierCode: string | null
  awardingOfficeCode: string | null
  fundingAgencyToptier: string | null
  naics: string | null
  pscCode: string | null
  setAsideType: string | null
  contractType: string | null
  competitionExtent: string | null
  numberOfOffersReceived: number | null
  totalObligation: number | null
  baseExercisedOptions: number | null
  baseAndAllOptions: number | null
  periodOfPerformanceStart: Date | null
  periodOfPerformanceEnd: Date | null
  awardDate: Date | null
  fiscalYear: number | null
  placeOfPerformanceState: string | null
  placeOfPerformanceCountry: string | null
  recipientStateCode: string | null
  recipientCountryCode: string | null
}

export interface PullWindowOptions {
  /** Inclusive window start (YYYY-MM-DD). */
  startDate: string
  /** Inclusive window end (YYYY-MM-DD). */
  endDate: string
  /** Hard ceiling on pages fetched per window. USAspending caps page size at 100, so 100 pages = 10k rows. */
  maxPages?: number
  /** Sort order — 'desc' puts highest-dollar first, useful when the window has more rows than maxPages allows. */
  sortOrder?: 'asc' | 'desc'
  /**
   * Filter the pull to one or more set-aside type codes (SDVOSBC, WOSB, 8A, HZC, etc.).
   * When provided, every returned row is tagged with the FIRST code as its setAsideType
   * — the API doesn't return set-aside as a response field, but filtering at the API
   * level lets us guarantee the value for downstream distillation.
   */
  setAsideTypeCodes?: string[]
}

export interface PullResult {
  windowStart: string
  windowEnd: string
  pagesFetched: number
  rowsReturned: number
  totalAvailable: number
  awards: RawWinnerAward[]
  /** Set when one or more page fetches failed; the partial result is still usable. */
  partialFailure?: { failedPages: number[]; lastError: string }
}

/**
 * Pull all federal prime contract awards in a date window.
 *
 * USAspending has no per-request guard against extremely large windows —
 * 24 months of all-federal awards would be millions of rows and tens of
 * thousands of pages. Callers MUST chunk the time window (~90 days is the
 * sweet spot) and accept that maxPages will truncate the largest windows.
 * The truncation is recorded in totalAvailable so the orchestrator can warn.
 */
export async function pullPrimeAwardsWindow(opts: PullWindowOptions): Promise<PullResult> {
  const { startDate, endDate, maxPages = 100, sortOrder = 'desc', setAsideTypeCodes } = opts

  const filters: Record<string, unknown> = {
    time_period: [{ start_date: startDate, end_date: endDate }],
    // A=BPA-call, B=Purchase Order, C=Delivery Order, D=Definitive Contract.
    // These four codes cover the vast majority of federal prime contracts;
    // grants/loans are intentionally excluded — Winners Intel is contract-focused.
    award_type_codes: ['A', 'B', 'C', 'D'],
  }

  // Set-aside filtering: USAspending exposes set-aside as a filter input but
  // NOT as a response field. Filtering at the API level lets us guarantee the
  // set-aside type of every returned row, which the mapper then stamps onto
  // each award. Without this, the slice's set-aside column is always empty.
  if (setAsideTypeCodes && setAsideTypeCodes.length > 0) {
    filters.type_set_aside = setAsideTypeCodes
  }

  // Field set sized to populate WinnersAwardStage; we tolerate missing values
  // (USAspending fills sparsely for some agencies) by mapping to null.
  // Field name caveats verified against the live spending_by_award response:
  //   - 'NAICS' returns an object { code, description } — must pluck .code
  //   - 'Type of Set Aside' is filter-only on this endpoint; it does NOT
  //     come back as a response field. Set-aside enrichment requires a
  //     per-award detail call (planned as a separate worker phase).
  //   - 'Award Date' IS valid here even though the existing
  //     bigquery/ingestionService.ts uses 'Base Obligation Date'. Both
  //     work; we request both and prefer Award Date when present.
  const fields = [
    'generated_internal_id',
    'piid',
    'recipient_uei',
    'Recipient Name',
    'recipient_id',
    'Awarding Agency Code',
    'Awarding Agency',
    'Awarding Sub Agency Code',
    'Awarding Office Code',
    'Funding Agency',
    'NAICS',
    'PSC Code',
    'Contract Award Type',
    'Award Type',
    'Extent Competed',
    'Number of Offers Received',
    'Award Amount',
    'Base Exercised Options Value',
    'Base and All Options Value',
    'Period of Performance Start Date',
    'Period of Performance Current End Date',
    'Award Date',
    'Base Obligation Date',
    'Last Modified Date',
    'Place of Performance State Code',
    'Place of Performance Country Code',
    'Recipient Location State Code',
    'Recipient Location Country Code',
  ]

  const awards: RawWinnerAward[] = []
  const failedPages: number[] = []
  let lastError = ''
  let totalAvailable = 0
  let page = 1
  let pagesFetched = 0

  while (page <= maxPages) {
    try {
      const resp = await axios.post(
        `${USA_SPENDING_BASE}/search/spending_by_award/`,
        {
          filters,
          fields,
          page,
          limit: 100,
          // 'Award Amount' is the only sort field USAspending accepts on
          // spending_by_award. Tried 'Award Date' — the API 400'd every
          // request. Tradeoff: top-dollar bias in the sample. Mitigated
          // by alternating sortOrder per window in refresh.ts so each
          // refresh covers both extremes of the distribution.
          sort: 'Award Amount',
          order: sortOrder,
        },
        { timeout: 30000 },
      )

      const results: Record<string, unknown>[] = resp.data?.results ?? []
      totalAvailable = resp.data?.page_metadata?.total ?? totalAvailable
      pagesFetched++

      // NOTE 2026-05-26: USAspending's `type_set_aside` filter on this endpoint
      // is being silently ignored. Verified via scripts/probeSetAsideFilter.ts:
      // requests for SDVOSBC/WOSB/8A/HZC all return the same $40-50B mega-prime
      // rows (Lockheed Martin, Sandia, etc) as an unfiltered pull. Stamping the
      // filter value as setAsideType produced contaminated data — mega-primes
      // mislabeled as HUBZone, etc. Stamping is therefore DISABLED. setAsideType
      // stays null on this endpoint; correct per-award set-aside is the job of
      // the /awards/<id>/ enrichment pass in awardEnrichment.ts. Keeping the
      // setAsideTypeCodes option so callers can opt back in if USAspending
      // restores the filter behavior.
      for (const r of results) {
        awards.push(mapToWinnerAward(r))
      }

      // USAspending paginates with page_metadata.hasNext. Trust that when
      // present, otherwise fall back to "got fewer results than the limit".
      const hasNext = resp.data?.page_metadata?.hasNext
      if (hasNext === false || results.length < 100) break
      page++
    } catch (err) {
      // Don't abort the whole window on a single bad page — record and move on.
      // USAspending occasionally 502s on individual pages; the next attempt
      // typically succeeds. We cap retries by simply moving to the next page.
      const msg = (err as Error).message
      logger.warn('Winners intel: USAspending page fetch failed', {
        startDate, endDate, page, error: msg,
      })
      failedPages.push(page)
      lastError = msg
      page++
    }
  }

  const result: PullResult = {
    windowStart: startDate,
    windowEnd: endDate,
    pagesFetched,
    rowsReturned: awards.length,
    totalAvailable,
    awards,
  }
  if (failedPages.length) {
    result.partialFailure = { failedPages, lastError }
  }
  return result
}

/** Best-effort map USAspending row → staging-table shape. Missing values → null. */
function mapToWinnerAward(r: Record<string, unknown>): RawWinnerAward {
  const internalId = String(r['generated_internal_id'] ?? r['piid'] ?? '').trim()
  // Date priority: 'Award Date' is the most semantically correct
  // ("when did this award happen"), but USAspending populates it sparsely
  // for older rows. Fall back through Base Obligation, Last Modified,
  // and finally Period of Performance Start.
  const rawAwardDate =
    (r['Award Date'] as string | null) ||
    (r['Base Obligation Date'] as string | null) ||
    (r['Last Modified Date'] as string | null) ||
    (r['Period of Performance Start Date'] as string | null) ||
    null

  const awardDate = parseDate(rawAwardDate)
  const popStart = parseDate(r['Period of Performance Start Date'] as string | null)
  const popEnd = parseDate(r['Period of Performance Current End Date'] as string | null)
  const fiscalYear = awardDate ? toFiscalYear(awardDate) : null

  return {
    usaspendingAwardId: internalId,
    pieceOfTheActionId: asString(r['piid']),
    recipientUei: pickString(r, ['recipient_uei', 'Recipient UEI', 'recipient_unique_id']),
    recipientName: asString(r['Recipient Name']),
    recipientParentUei: asString(r['recipient_id']),
    agencyToptierCode: asString(r['Awarding Agency Code']),
    agencyToptierName: asString(r['Awarding Agency']),
    agencySubtierCode: asString(r['Awarding Sub Agency Code']),
    awardingOfficeCode: asString(r['Awarding Office Code']),
    fundingAgencyToptier: asString(r['Funding Agency']),
    naics: extractNaicsCode(r['NAICS']),
    pscCode: extractObjectCode(r['PSC Code']),
    // Set-aside not returned by the spending_by_award endpoint — left null;
    // the distill + render layers detect the all-null case and report it
    // honestly rather than defaulting to a misleading "100% OPEN".
    setAsideType: null,
    contractType: asString(r['Contract Award Type']) ?? asString(r['Award Type']),
    competitionExtent: pickString(r, ['Extent Competed', 'extent_competed']),
    numberOfOffersReceived: pickNumber(r, ['Number of Offers Received', 'number_of_offers_received']),
    totalObligation: asNumber(r['Award Amount']),
    baseExercisedOptions: asNumber(r['Base Exercised Options Value']),
    baseAndAllOptions: asNumber(r['Base and All Options Value']),
    periodOfPerformanceStart: popStart,
    periodOfPerformanceEnd: popEnd,
    awardDate,
    fiscalYear,
    placeOfPerformanceState: asString(r['Place of Performance State Code']),
    placeOfPerformanceCountry: asString(r['Place of Performance Country Code']),
    recipientStateCode: asString(r['Recipient Location State Code']),
    recipientCountryCode: asString(r['Recipient Location Country Code']),
  }
}

/**
 * USAspending sometimes returns NAICS / PSC as { code, description } objects
 * and sometimes as plain strings. Pluck the code in either case; null for
 * anything else.
 *
 * The final value is validated against the code's known shape (NAICS =
 * 2-6 digits, PSC = short alphanumeric). An early version of this mapper
 * coerced the object form with String(), which persisted the literal
 * "[object Object]" into winners_award_stage for ~19K rows and surfaced
 * at the top of every NAICS aggregation. Validating here protects every
 * downstream consumer no matter what shape USAspending returns next.
 */
const NAICS_SHAPE = /^\d{2,6}$/
const PSC_SHAPE = /^[A-Za-z0-9]{1,6}$/

export function extractNaicsCode(v: unknown): string | null {
  let code: string | null = null
  if (v && typeof v === 'object') {
    const raw = (v as { code?: unknown }).code
    code = raw ? String(raw).trim() : null
  } else if (typeof v === 'string') {
    // Sometimes "541512 — Computer Systems Design" — take the leading code.
    code = v.split(/\s|—|-/)[0].trim() || null
  }
  return code && NAICS_SHAPE.test(code) ? code : null
}

export function extractObjectCode(v: unknown): string | null {
  let code: string | null = null
  if (v && typeof v === 'object') {
    const raw = (v as { code?: unknown }).code
    code = raw ? String(raw).trim() : null
  } else if (typeof v === 'string') {
    code = v.trim() || null
  }
  return code && PSC_SHAPE.test(code) ? code : null
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * USAspending field names occasionally differ between title-case ("Recipient
 * UEI") and snake-case ("recipient_uei") forms even within the same endpoint
 * across releases. Try each candidate in order; first non-empty wins.
 */
function pickString(r: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = asString(r[k])
    if (v !== null) return v
  }
  return null
}

function pickNumber(r: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = asNumber(r[k])
    if (v !== null) return v
  }
  return null
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null
  const trimmed = v.slice(0, 10)
  const d = new Date(trimmed + 'T00:00:00.000Z')
  return Number.isNaN(d.getTime()) ? null : d
}

/** US federal fiscal year: Oct 1 → Sep 30. Date in Oct 2025 → FY2026. */
function toFiscalYear(d: Date): number {
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() // 0=Jan
  return m >= 9 ? y + 1 : y
}
