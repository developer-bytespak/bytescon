// =============================================================
// §6.1A — Grants.gov adapter.
//
// Uses the documented public Grants.gov Search2 REST API
// (POST {baseUrl}/v1/api/search2), which requires no API key. The base URL is
// configurable so a firm can point at a mirror; it is never a mandatory
// third-party credential.
//
// Grants are normalized into the existing Opportunity domain with
// noticeType = "Grant Opportunity" so they classify and badge correctly rather
// than masquerading as federal contract solicitations.
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
const PAGE_SIZE = 25

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

function normalizeHit(hit: Search2Hit, baseUrl: string): NormalizedOpportunity | null {
  const externalId = trimOrNull(hit.id ?? hit.number, 120)
  const title = trimOrNull(hit.title, 500)
  if (!externalId || !title) return null

  const agency = trimOrNull(hit.agencyName ?? hit.agency ?? hit.agencyCode, 300) ?? 'Unknown agency'
  const closeDate = parseSourceDate(hit.closeDate)
  const openDate = parseSourceDate(hit.openDate)
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
    description: trimOrNull(hit.description, 8000),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: 'Grant Opportunity',
    solicitationNumber: trimOrNull(hit.number, 120),
    postedDate: openDate,
    responseDeadline: closeDate,
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
      .map((h) => normalizeHit(h, baseUrl))
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

export const __testing = { normalizeHit, DEFAULT_BASE_URL, PAGE_SIZE }
