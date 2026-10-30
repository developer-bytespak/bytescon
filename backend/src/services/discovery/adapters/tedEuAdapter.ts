// =============================================================
// EU TED (Tenders Electronic Daily) adapter (COMMERCIAL).
//
// Public anonymous Search API v3: POST {baseUrl}/notices/search with an
// expert query, the eForms field list, and page/limit paging. Only contract
// notices (calls for competition) are requested. TED returns multilingual
// objects ({ eng: ... }) and arrays per lot, so every field is read
// defensively. The query is configurable via configJson.query.
// =============================================================
import axios from 'axios'
import { SourceCategory } from '@prisma/client'
import {
  SourceAdapter, AdapterEnv, ConfigureResult, FetchPageArgs, FetchPageResult, NormalizedOpportunity,
  parseSourceAmount, trimOrNull, deriveDataQuality,
} from '../sourceAdapter'
import { maxRecordsFor, startOffset, resumeCursor, pageSizeWithinCap, joinDescription, valueLine, usdOnly } from './tenderFeedHelpers'

const DEFAULT_BASE_URL = 'https://api.ted.europa.eu/v3'
const DEFAULT_QUERY = 'notice-type IN (cn-standard cn-social) SORT BY publication-date DESC'
const PAGE_SIZE = 50
const FIELDS = [
  'publication-number', 'notice-title', 'buyer-name', 'buyer-country', 'publication-date',
  'deadline-receipt-tender-date-lot', 'classification-cpv', 'estimated-value-lot',
  'estimated-value-cur-lot', 'description-lot', 'notice-type',
]

type TedValue = unknown
type TedNotice = Record<string, TedValue> & { links?: { html?: Record<string, string> } }

interface TedResponse {
  notices?: TedNotice[]
  totalNoticeCount?: number
}

/** First usable string out of a TED value: string | string[] | { eng|ENG|<lang>: string|string[] }. */
function tedText(value: TedValue): string | null {
  if (value == null) return null
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    for (const v of value) { const s = tedText(v); if (s) return s }
    return null
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, TedValue>
    for (const key of ['eng', 'ENG', 'en', 'EN']) if (obj[key] != null) return tedText(obj[key])
    for (const v of Object.values(obj)) { const s = tedText(v); if (s) return s }
  }
  return null
}

/** TED dates look like "2026-11-20+01:00" or "2026-11-20Z"; keep the calendar day (UTC midnight). */
function tedDate(value: TedValue): Date | null {
  const s = tedText(value)
  const m = s ? /^(\d{4})-(\d{2})-(\d{2})/.exec(s) : null
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null
}

function normalizeNotice(n: TedNotice): NormalizedOpportunity | null {
  const externalId = trimOrNull(tedText(n['publication-number']), 120)
  const title = trimOrNull(tedText(n['notice-title']), 500)
  if (!externalId || !title) return null

  const amount = parseSourceAmount(tedText(n['estimated-value-lot']))
  const currency = tedText(n['estimated-value-cur-lot']) ?? (amount != null ? 'EUR' : null)
  const deadline = tedDate(n['deadline-receipt-tender-date-lot'])
  const buyer = trimOrNull(tedText(n['buyer-name']), 300)
  const htmlLinks = n.links?.html ?? {}

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency: buyer ?? 'EU public buyer',
    description: joinDescription(valueLine(amount, currency), trimOrNull(tedText(n['description-lot']), 7000)),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: 'Contract Notice (EU)',
    solicitationNumber: externalId,
    postedDate: tedDate(n['publication-date']),
    responseDeadline: deadline,
    placeOfPerformance: trimOrNull(tedText(n['buyer-country']), 120),
    estimatedValue: usdOnly(amount, currency),
    sourceUrl: htmlLinks.ENG ?? htmlLinks.eng ?? `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(externalId)}`,
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'ted.europa.eu',
      value: amount, currency,
      cpv: tedText(n['classification-cpv']),
      noticeType: tedText(n['notice-type']),
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(buyer)]),
  }
}

export const tedEuAdapter: SourceAdapter = {
  key: 'ted_eu',
  displayName: 'EU TED Tenders',
  category: SourceCategory.COMMERCIAL,
  produces: 'OPPORTUNITY',
  supportsIncremental: false,
  pageSize: PAGE_SIZE,
  coverageNote:
    'Contract notices from the EU Tenders Electronic Daily (TED) public Search API — public tenders across EU member states. Values are usually EUR and are not converted. Each run pulls up to configJson.maxRecords notices, newest first.',

  configure(): ConfigureResult {
    return { state: 'READY' }
  },

  async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
    const baseUrl = String(env.baseUrl || env.config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    const query = typeof env.config.query === 'string' && env.config.query.trim() ? env.config.query : DEFAULT_QUERY
    const cap = maxRecordsFor(env)
    const offset = startOffset(args.pageToken, args.cursor, cap)
    const limit = pageSizeWithinCap(offset, PAGE_SIZE, cap)
    if (limit === 0) return { records: [], nextPageToken: null, nextCursor: resumeCursor(null) }

    let response
    try {
      response = await axios.post<TedResponse>(
        `${baseUrl}/notices/search`,
        // Page numbers are 1-based; offsets stay page-aligned because every page but the last is full.
        { query, fields: FIELDS, page: Math.floor(offset / PAGE_SIZE) + 1, limit: PAGE_SIZE, scope: 'ACTIVE', paginationMode: 'PAGE_NUMBER' },
        { timeout: args.timeoutMs, headers: { 'Content-Type': 'application/json' } },
      )
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429) return { records: [], nextPageToken: null, rateLimited: true }
      throw err
    }

    const notices = (response.data?.notices ?? []).slice(0, limit)
    const records = notices.map(normalizeNotice).filter((r): r is NormalizedOpportunity => r !== null)
    const consumed = offset + notices.length
    const total = response.data?.totalNoticeCount ?? null
    const exhausted = notices.length < limit || consumed >= cap || (total != null && consumed >= total)
    const nextPageToken = exhausted ? null : String(consumed)
    return { records, nextPageToken, nextCursor: resumeCursor(nextPageToken) }
  },
}

export const __testing = { normalizeNotice, tedText, tedDate, DEFAULT_QUERY }
