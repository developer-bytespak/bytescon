// =============================================================
// §6.1A — Grants.gov adapter.
//
// Uses the documented public Grants.gov Search2 REST API
// (POST {baseUrl}/v1/api/search2), which requires no API key. The base URL is
// configurable so a firm can point at a mirror; it is never a mandatory
// third-party credential.
//
// Grants are normalized into the existing Opportunity domain with
// noticeType = "Grant Opportunity" (or "Grant Forecast") so they classify and
// badge correctly rather than masquerading as federal contract solicitations.
//
// Posted and forecasted grants are both fetched (about 1,500, two requests),
// every 6 hours. Forecasts and posted grants with no close date have no real
// deadline, but every notice needs one: they get a placeholder a year after the
// fetch, refreshed on every run while Grants.gov still lists them, and their
// title and sourceMetadata.deadlineLabel say so, so the date is never mistaken
// for a real one.
// =============================================================
import axios from 'axios'
import { SourceCategory, SourceDataQuality } from '@prisma/client'
import {
  SourceAdapter,
  AdapterEnv,
  ConfigureResult,
  FetchPageArgs,
  FetchPageResult,
  NormalizedOpportunity,
  parseSourceDate,
  parseSourceAmount,
  trimOrNull,
  deriveDataQuality,
} from '../sourceAdapter'

const DEFAULT_BASE_URL = 'https://api.grants.gov/v1/api'
const PAGE_SIZE = 1000
/** Placeholder deadline for a grant with none: kept open while Grants.gov lists it. */
const NO_DEADLINE_DAYS = 365
export const FORECAST_LABEL = 'Forecast: not open yet'
export const ROLLING_LABEL = 'Rolling: no closing date'

interface Search2Hit {
  id?: string | number
  number?: string
  title?: string
  agencyCode?: string
  agencyName?: string
  agency?: string
  openDate?: string
  closeDate?: string
  oppStatus?: string
  docType?: string
  alnist?: string[]
  cfdaList?: string[]
  awardCeiling?: string | number
  awardFloor?: string | number
  description?: string
}

interface Search2Response {
  errorcode?: number
  msg?: string
  data?: {
    hitCount?: number
    oppHits?: Search2Hit[]
  }
}

function normalizeHit(hit: Search2Hit, baseUrl: string, now: Date = new Date()): NormalizedOpportunity | null {
  const externalId = trimOrNull(hit.id ?? hit.number, 120)
  const rawTitle = trimOrNull(hit.title, 500)
  if (!externalId || !rawTitle) return null
  const forecast = hit.oppStatus === 'forecasted' || hit.docType === 'forecast'

  const agency = trimOrNull(hit.agencyName ?? hit.agency ?? hit.agencyCode, 300) ?? 'Unknown agency'
  const closeDate = parseSourceDate(hit.closeDate)
  const openDate = parseSourceDate(hit.openDate)
  // Shown instead of the placeholder date wherever the app knows to.
  const deadlineLabel = closeDate ? null : forecast ? FORECAST_LABEL : ROLLING_LABEL
  const prefix = forecast ? 'Forecast: ' : closeDate ? '' : 'Rolling: '
  const title = `${prefix}${rawTitle}`.slice(0, 500)
  const deadline = closeDate ?? new Date(now.getTime() + NO_DEADLINE_DAYS * 86_400_000)
  const ceiling = parseSourceAmount(hit.awardCeiling)
  const floor = parseSourceAmount(hit.awardFloor)

  // Grants.gov exposes Assistance Listing (formerly CFDA) numbers, not NAICS.
  // Those are kept as source metadata rather than being coerced into naicsCode,
  // which would be a fabricated classification.
  const listings = [...(hit.alnist ?? []), ...(hit.cfdaList ?? [])].filter(Boolean)

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency,
    description: [deadlineLabel ? `${deadlineLabel}.` : forecast ? 'Forecast: not open for applications yet.' : null, trimOrNull(hit.description, 8000)].filter(Boolean).join('\n\n') || null,
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: forecast ? 'Grant Forecast' : 'Grant Opportunity',
    solicitationNumber: trimOrNull(hit.number, 120),
    postedDate: openDate,
    responseDeadline: deadline,
    estimatedValue: ceiling ?? null,
    estimatedValueMin: floor ?? null,
    estimatedValueMax: ceiling ?? null,
    sourceUrl: `https://www.grants.gov/search-results-detail/${encodeURIComponent(String(externalId))}`,
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'grants.gov',
      apiBase: baseUrl,
      oppStatus: hit.oppStatus ?? null,
      docType: hit.docType ?? null,
      assistanceListings: listings,
      deadlineLabel,
    },
    // A grant without a close date cannot drive deadline logic — say so.
    dataQuality: deriveDataQuality([Boolean(closeDate), Boolean(agency !== 'Unknown agency')]),
  }
}

export const grantsGovAdapter: SourceAdapter = {
  key: 'grants_gov',
  displayName: 'Grants.gov',
  category: SourceCategory.GRANTS_GOV,
  produces: 'OPPORTUNITY',
  supportsIncremental: false,
  pageSize: PAGE_SIZE,
  runIntervalMinutes: 360,
  coverageNote:
    'Federal grant opportunities from the public Grants.gov Search2 API. Covers grants only — not federal contract solicitations, and not state or local grant portals.',

  configure(env: AdapterEnv): ConfigureResult {
    const baseUrl = env.baseUrl || (env.config.baseUrl as string | undefined) || DEFAULT_BASE_URL
    if (!baseUrl) {
      return { state: 'NOT_CONFIGURED', reason: 'No Grants.gov base URL configured.' }
    }
    return { state: 'READY' }
  },

  async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
    const baseUrl = String(env.baseUrl || env.config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    const startRecord = Number(args.pageToken ?? '0') || 0
    const keyword = typeof env.config.keyword === 'string' ? env.config.keyword : ''
    const agencies = Array.isArray(env.config.agencies) ? (env.config.agencies as string[]).join('|') : ''

    let response
    try {
      response = await axios.post<Search2Response>(
        `${baseUrl}/search2`,
        {
          rows: PAGE_SIZE,
          startRecordNum: startRecord,
          keyword,
          oppNum: '',
          eligibilities: '',
          agencies,
          oppStatuses: 'forecasted|posted',
          sortBy: 'openDate|desc',
        },
        { timeout: args.timeoutMs, headers: { 'Content-Type': 'application/json' } },
      )
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429) return { records: [], nextPageToken: null, rateLimited: true }
      throw err
    }

    const body = response.data
    if (body?.errorcode && body.errorcode !== 0) {
      throw new Error(`Grants.gov error ${body.errorcode}: ${body.msg ?? 'unknown'}`)
    }

    const hits = body?.data?.oppHits ?? []
    const records = hits
      .map((h) => normalizeHit(h, baseUrl, args.now))
      .filter((r): r is NormalizedOpportunity => r !== null)

    const total = body?.data?.hitCount ?? 0
    const consumed = startRecord + hits.length
    const nextPageToken = hits.length === PAGE_SIZE && consumed < total ? String(consumed) : null

    return {
      records,
      nextPageToken,
      // Search2 has no change-watermark, so the cursor records the last run
      // instant purely for display. It is never used to skip records.
      nextCursor: args.now.toISOString(),
    }
  },
}

export const __testing = { normalizeHit, DEFAULT_BASE_URL, PAGE_SIZE, NO_DEADLINE_DAYS }
