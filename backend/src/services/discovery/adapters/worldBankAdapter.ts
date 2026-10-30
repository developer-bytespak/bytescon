// =============================================================
// World Bank procurement notices adapter (COMMERCIAL).
//
// Public, keyless JSON API: GET {baseUrl}/procnotices?format=json&rows=&os=
// Notices are tenders issued by borrower governments on World Bank-financed
// projects; any qualified company worldwide may bid. Most of the feed is
// Contract Award notices (nothing to bid on, no deadline), so only biddable
// notice types are requested (~108k). configJson.noticeTypes overrides the
// list; configJson.maxRecords caps the backfill.
// =============================================================
import axios from 'axios'
import { SourceCategory } from '@prisma/client'
import {
  SourceAdapter, AdapterEnv, ConfigureResult, FetchPageArgs, FetchPageResult, NormalizedOpportunity,
  parseSourceDate, trimOrNull, deriveDataQuality,
} from '../sourceAdapter'
import { maxRecordsFor, startOffset, resumeCursor, pageSizeWithinCap, nextOffsetToken, htmlToText, joinDescription } from './tenderFeedHelpers'

const DEFAULT_BASE_URL = 'https://search.worldbank.org/api/v2'
const PAGE_SIZE = 50
/** Notice types a company can respond to; the API takes them "^"-separated. */
const BIDDABLE_NOTICE_TYPES = ['Invitation for Bids', 'Request for Expression of Interest', 'Invitation for Prequalification']

function noticeTypeFilter(env: AdapterEnv): string {
  const configured = Array.isArray(env.config.noticeTypes)
    ? (env.config.noticeTypes as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : []
  return (configured.length > 0 ? configured : BIDDABLE_NOTICE_TYPES).join('^')
}
const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }

interface WbNotice {
  id?: string
  notice_type?: string
  noticedate?: string
  notice_status?: string
  submission_deadline_date?: string
  project_ctry_name?: string
  project_id?: string
  project_name?: string
  bid_reference_no?: string
  bid_description?: string
  procurement_group?: string
  procurement_method_name?: string
  contact_organization?: string
  contact_name?: string
  contact_email?: string
  contact_phone_no?: string
  notice_text?: string
}

interface WbResponse {
  total?: string | number
  procnotices?: WbNotice[]
}

/** noticedate is "29-Oct-2026"; anchored to UTC midnight. */
function parseWbDate(value: unknown): Date | null {
  if (typeof value === 'string') {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(value.trim())
    if (m && MONTHS[m[2].toLowerCase()] !== undefined) return new Date(Date.UTC(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1])))
  }
  return parseSourceDate(value)
}

function normalizeNotice(n: WbNotice): NormalizedOpportunity | null {
  const externalId = trimOrNull(n.id, 120)
  const title = trimOrNull(n.bid_description ?? n.project_name, 500)
  if (!externalId || !title) return null

  const country = trimOrNull(n.project_ctry_name, 200)
  const agency = trimOrNull(n.contact_organization, 300) ?? (country ? `World Bank project — ${country}` : 'World Bank project')
  const deadline = parseSourceDate(n.submission_deadline_date)
  const project = n.project_name ? `Project: ${n.project_name}${n.project_id ? ` (${n.project_id})` : ''}` : null

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency,
    office: trimOrNull(n.project_name, 300),
    description: joinDescription(project, htmlToText(n.notice_text)),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: trimOrNull(n.notice_type, 120) ?? 'Procurement Notice',
    solicitationNumber: trimOrNull(n.bid_reference_no, 120),
    postedDate: parseWbDate(n.noticedate),
    responseDeadline: deadline,
    placeOfPerformance: country,
    estimatedValue: null,
    sourceUrl: `https://projects.worldbank.org/en/projects-operations/procurement-detail/${encodeURIComponent(externalId)}`,
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'worldbank.org',
      projectId: n.project_id ?? null,
      noticeStatus: n.notice_status ?? null,
      procurementGroup: n.procurement_group ?? null,
      procurementMethod: n.procurement_method_name ?? null,
      contact: { name: n.contact_name ?? null, email: n.contact_email ?? null, phone: n.contact_phone_no ?? null },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(n.contact_organization)]),
  }
}

export const worldBankAdapter: SourceAdapter = {
  key: 'world_bank',
  displayName: 'World Bank Procurement',
  category: SourceCategory.COMMERCIAL,
  produces: 'OPPORTUNITY',
  supportsIncremental: false,
  pageSize: PAGE_SIZE,
  coverageNote:
    'Procurement notices on World Bank-financed projects (goods, works, consulting) from the public World Bank API. Open to qualified companies worldwide; buyers are borrower governments, not the US federal government. Only biddable notices (invitations for bids, expressions of interest, prequalification) — contract award notices are skipped. Syncs up to configJson.maxRecords notices, newest first.',

  configure(): ConfigureResult {
    return { state: 'READY' }
  },

  async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
    const baseUrl = String(env.baseUrl || env.config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    const cap = maxRecordsFor(env)
    const offset = startOffset(args.pageToken, args.cursor, cap)
    const rows = pageSizeWithinCap(offset, PAGE_SIZE, cap)
    if (rows === 0) return { records: [], nextPageToken: null, nextCursor: resumeCursor(null) }

    let response
    try {
      response = await axios.get<WbResponse>(`${baseUrl}/procnotices`, {
        params: { format: 'json', rows, os: offset, notice_type_exact: noticeTypeFilter(env) },
        timeout: args.timeoutMs,
      })
    } catch (err: unknown) {
      if ((err as { response?: { status?: number } })?.response?.status === 429) return { records: [], nextPageToken: null, rateLimited: true }
      throw err
    }

    const notices = response.data?.procnotices ?? []
    const records = notices.map(normalizeNotice).filter((r): r is NormalizedOpportunity => r !== null)
    const total = Number(response.data?.total) || null
    const nextPageToken = nextOffsetToken(offset, notices.length, rows, cap, total)
    return { records, nextPageToken, nextCursor: resumeCursor(nextPageToken) }
  },
}

export const __testing = { normalizeNotice, parseWbDate, noticeTypeFilter, BIDDABLE_NOTICE_TYPES, DEFAULT_BASE_URL }
