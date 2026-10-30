// =============================================================
// NYC City Record adapter (STATE_LOCAL).
//
// New York City's official procurement notices from the NYC Open Data
// "City Record Online" dataset (Socrata, keyless):
//   GET {baseUrl}/resource/dg92-zbpx.json?$where=...&$limit=&$offset=
// Only the Procurement section's Solicitation notices are requested — the
// dataset also carries rules, hearings and other non-bid notices.
// =============================================================
import axios from 'axios'
import { SourceCategory } from '@prisma/client'
import {
  SourceAdapter, AdapterEnv, ConfigureResult, FetchPageArgs, FetchPageResult, NormalizedOpportunity,
  parseSourceDate, trimOrNull, deriveDataQuality,
} from '../sourceAdapter'
import { maxRecordsFor, startOffset, resumeCursor, pageSizeWithinCap, nextOffsetToken, htmlToText, joinDescription } from './tenderFeedHelpers'

const DEFAULT_BASE_URL = 'https://data.cityofnewyork.us'
const DATASET = 'dg92-zbpx'
const PAGE_SIZE = 50
const WHERE = "section_name='Procurement' AND type_of_notice_description='Solicitation'"

interface CityRecordRow {
  request_id?: string
  start_date?: string
  agency_name?: string
  type_of_notice_description?: string
  category_description?: string
  short_title?: string
  selection_method_description?: string
  pin?: string
  due_date?: string
  address_to_request?: string
  contact_name?: string
  contact_phone?: string
  email?: string
  additional_description_1?: string
}

function normalizeRow(r: CityRecordRow): NormalizedOpportunity | null {
  const externalId = trimOrNull(r.request_id, 120)
  const title = trimOrNull(r.short_title, 500)
  if (!externalId || !title) return null

  const deadline = parseSourceDate(r.due_date)
  const facts = [
    r.category_description ? `Category: ${r.category_description}` : null,
    r.selection_method_description ? `Selection method: ${r.selection_method_description}` : null,
    r.contact_name ? `Contact: ${[r.contact_name, r.contact_phone, r.email?.trim()].filter(Boolean).join(' · ')}` : null,
  ].filter(Boolean).join('\n')

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency: trimOrNull(r.agency_name, 300) ? `NYC ${r.agency_name!.trim()}` : 'City of New York',
    description: joinDescription(facts, htmlToText(r.additional_description_1)),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: 'Solicitation',
    solicitationNumber: trimOrNull(r.pin, 120),
    postedDate: parseSourceDate(r.start_date),
    responseDeadline: deadline,
    placeOfPerformance: 'New York, NY',
    estimatedValue: null,
    sourceUrl: `https://a856-cityrecord.nyc.gov/RequestDetail/${encodeURIComponent(externalId)}`,
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'nyc-city-record',
      jurisdiction: 'New York City, NY',
      category: r.category_description ?? null,
      selectionMethod: r.selection_method_description ?? null,
      contact: { name: r.contact_name ?? null, phone: r.contact_phone ?? null, email: r.email?.trim() ?? null },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(r.agency_name)]),
  }
}

export const nycCityRecordAdapter: SourceAdapter = {
  key: 'nyc_city_record',
  displayName: 'NYC City Record',
  category: SourceCategory.STATE_LOCAL,
  produces: 'OPPORTUNITY',
  supportsIncremental: false,
  pageSize: PAGE_SIZE,
  coverageNote:
    'New York City procurement solicitations from the City Record Online open-data feed. Covers NYC agencies only — no other city or state. Each run pulls up to configJson.maxRecords solicitations, newest first.',

  configure(): ConfigureResult {
    return { state: 'READY' }
  },

  async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
    const baseUrl = String(env.baseUrl || env.config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    const cap = maxRecordsFor(env)
    const offset = startOffset(args.pageToken, args.cursor, cap)
    const limit = pageSizeWithinCap(offset, PAGE_SIZE, cap)
    if (limit === 0) return { records: [], nextPageToken: null, nextCursor: resumeCursor(null) }

    let response
    try {
      response = await axios.get<CityRecordRow[]>(`${baseUrl}/resource/${DATASET}.json`, {
        params: { $where: WHERE, $order: 'start_date DESC', $limit: limit, $offset: offset },
        timeout: args.timeoutMs,
      })
    } catch (err: unknown) {
      if ((err as { response?: { status?: number } })?.response?.status === 429) return { records: [], nextPageToken: null, rateLimited: true }
      throw err
    }

    const rows = Array.isArray(response.data) ? response.data : []
    const records = rows.map(normalizeRow).filter((r): r is NormalizedOpportunity => r !== null)
    const nextPageToken = nextOffsetToken(offset, rows.length, limit, cap)
    return { records, nextPageToken, nextCursor: resumeCursor(nextPageToken) }
  },
}

export const __testing = { normalizeRow, WHERE }
