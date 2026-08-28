// =============================================================
// §6.1A — Generic official-feed adapter factory.
//
// State/local procurement portals and subcontracting boards have no single
// national API. What they DO commonly publish is an official machine-readable
// feed per jurisdiction/board: an Open Data (Socrata/CKAN) JSON endpoint, a
// plain JSON array, or an RSS/Atom bid feed.
//
// This factory turns any of those into a §6.1A adapter driven entirely by
// per-source configuration — a documented official interface, no scraping, no
// terms-violating access, no mandatory credential. A source with no configured
// feedUrl reports NOT_CONFIGURED and simply does not sync.
//
// Coverage is explicitly whatever the operator configures. Neither adapter
// claims national state/local or subcontracting-board coverage anywhere in the
// API or the UI.
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

export type FeedFormat = 'JSON' | 'RSS'

/** Maps a source's own field names onto the normalized opportunity fields. */
export interface FeedFieldMap {
  externalId?: string[]
  title?: string[]
  agency?: string[]
  description?: string[]
  naicsCode?: string[]
  psc?: string[]
  setAsideType?: string[]
  noticeType?: string[]
  solicitationNumber?: string[]
  postedDate?: string[]
  responseDeadline?: string[]
  placeOfPerformance?: string[]
  estimatedValue?: string[]
  sourceUrl?: string[]
  sourceUpdatedAt?: string[]
}

const GENERIC_FIELD_MAP: Required<FeedFieldMap> = {
  externalId: ['id', 'bid_id', 'solicitation_id', 'guid', 'number', 'reference_number', 'bidnumber'],
  title: ['title', 'name', 'bid_title', 'solicitation_title', 'subject'],
  agency: ['agency', 'department', 'organization', 'entity', 'buyer', 'jurisdiction', 'prime'],
  description: ['description', 'summary', 'details', 'scope', 'content'],
  naicsCode: ['naics', 'naics_code', 'naicscode'],
  psc: ['psc', 'psc_code', 'commodity_code'],
  setAsideType: ['set_aside', 'setaside', 'set_aside_type', 'preference', 'diversity_goal'],
  noticeType: ['type', 'bid_type', 'notice_type', 'category', 'solicitation_type'],
  solicitationNumber: ['solicitation_number', 'bid_number', 'rfp_number', 'number'],
  postedDate: ['posted_date', 'published', 'pubdate', 'issue_date', 'open_date', 'start_date'],
  responseDeadline: ['due_date', 'close_date', 'closing_date', 'response_date', 'deadline', 'bid_due_date', 'end_date'],
  placeOfPerformance: ['location', 'place_of_performance', 'city', 'county', 'region'],
  estimatedValue: ['estimated_value', 'value', 'amount', 'contract_value', 'budget'],
  sourceUrl: ['url', 'link', 'permalink', 'detail_url'],
  sourceUpdatedAt: ['updated', 'last_updated', 'modified', 'last_modified'],
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function indexRow(row: Record<string, unknown>): Map<string, unknown> {
  const idx = new Map<string, unknown>()
  for (const [k, v] of Object.entries(row)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // Socrata/CKAN nest url values as { url: "..." }.
      const nested = v as Record<string, unknown>
      idx.set(normalizeKey(k), nested.url ?? nested.value ?? nested['#text'] ?? JSON.stringify(v))
      continue
    }
    idx.set(normalizeKey(k), v)
  }
  return idx
}

function pick(idx: Map<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    const v = idx.get(normalizeKey(alias))
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return undefined
}

/** Minimal RSS/Atom item extractor — no XML dependency, no scraping. */
export function parseRssItems(xml: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = []
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []
  for (const block of blocks) {
    const row: Record<string, unknown> = {}
    // Strip the enclosing <item>/<entry> tags first, otherwise the child-tag
    // scan below matches the wrapper itself and swallows the whole element.
    const inner = block.replace(/^<(item|entry)\b[^>]*>/i, '').replace(/<\/(item|entry)>$/i, '')
    const tagRe = /<([a-zA-Z0-9:_-]+)(\s[^>]*)?>([\s\S]*?)<\/\1>/g
    let m: RegExpExecArray | null
    while ((m = tagRe.exec(inner)) !== null) {
      const tag = m[1].split(':').pop() as string
      let value = m[3]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim()
      if (!value && m[2]) {
        // Atom <link href="..."/> style.
        const href = /href\s*=\s*"([^"]+)"/i.exec(m[2])
        if (href) value = href[1]
      }
      if (value && row[tag] === undefined) row[tag] = value
    }
    // Self-closing Atom link.
    if (row.link === undefined) {
      const href = /<link\b[^>]*href\s*=\s*"([^"]+)"/i.exec(block)
      if (href) row.link = href[1]
    }
    if (Object.keys(row).length > 0) items.push(row)
  }
  return items
}

export function extractFeedRows(payload: unknown, format: FeedFormat, rootKey?: string): Record<string, unknown>[] {
  if (format === 'RSS') return parseRssItems(typeof payload === 'string' ? payload : String(payload))

  let parsed: unknown = payload
  if (typeof payload === 'string') {
    try { parsed = JSON.parse(payload) } catch { return [] }
  }
  if (Array.isArray(parsed)) return parsed.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
  if (parsed && typeof parsed === 'object') {
    const env = parsed as Record<string, unknown>
    const keys = rootKey ? [rootKey] : ['results', 'records', 'data', 'items', 'result', 'bids', 'opportunities']
    for (const key of keys) {
      const v = env[key]
      if (Array.isArray(v)) return v.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      // CKAN wraps as { result: { records: [] } }.
      if (v && typeof v === 'object') {
        const inner = v as Record<string, unknown>
        for (const k2 of ['records', 'results', 'items']) {
          if (Array.isArray(inner[k2])) return (inner[k2] as unknown[]).filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        }
      }
    }
  }
  return []
}

export interface FeedNormalizeDefaults {
  agency?: string | null
  jurisdiction?: string | null
  noticeType?: string | null
  feedUrl: string
  sourceLabel: string
}

export function normalizeFeedRow(
  row: Record<string, unknown>,
  fieldMap: Required<FeedFieldMap>,
  defaults: FeedNormalizeDefaults,
): NormalizedOpportunity | null {
  const idx = indexRow(row)
  const get = (f: keyof FeedFieldMap) => pick(idx, fieldMap[f])

  const title = trimOrNull(get('title'), 500)
  if (!title) return null
  const agency =
    trimOrNull(get('agency'), 300) ??
    trimOrNull(defaults.agency, 300) ??
    trimOrNull(defaults.jurisdiction, 300)
  if (!agency) return null

  const deadline = parseSourceDate(get('responseDeadline'))
  const posted = parseSourceDate(get('postedDate'))
  const rawId = trimOrNull(get('externalId'), 200)
  // Deterministic surrogate so repeated syncs update, never duplicate.
  const externalId = rawId ?? `${normalizeKey(agency)}:${normalizeKey(title).slice(0, 90)}`

  const naicsRaw = trimOrNull(get('naicsCode'), 40)
  const naicsCode = naicsRaw ? (naicsRaw.match(/\d{2,6}/)?.[0] ?? null) : null

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency,
    description: trimOrNull(get('description'), 8000),
    naicsCode,
    psc: trimOrNull(get('psc'), 20),
    // Jurisdictional preference programs are NOT federal set-asides. They are
    // preserved as metadata and the federal set-aside field stays NONE so
    // eligibility logic never treats them as a federal certification match.
    setAsideType: 'NONE',
    noticeType: trimOrNull(get('noticeType'), 120) ?? defaults.noticeType ?? null,
    solicitationNumber: trimOrNull(get('solicitationNumber'), 120),
    postedDate: posted,
    responseDeadline: deadline,
    placeOfPerformance: trimOrNull(get('placeOfPerformance'), 300) ?? trimOrNull(defaults.jurisdiction, 300),
    estimatedValue: parseSourceAmount(get('estimatedValue')),
    sourceUrl: trimOrNull(get('sourceUrl'), 1000) ?? defaults.feedUrl,
    sourceUpdatedAt: parseSourceDate(get('sourceUpdatedAt')),
    sourceMetadata: {
      provider: defaults.sourceLabel,
      feedUrl: defaults.feedUrl,
      jurisdiction: defaults.jurisdiction ?? null,
      localPreference: trimOrNull(get('setAsideType'), 120),
      raw: row,
    },
    // Without a response deadline the record cannot drive deadline logic.
    dataQuality: deriveDataQuality([Boolean(deadline)]),
  }
}

export interface FeedAdapterSpec {
  key: string
  displayName: string
  category: SourceCategory
  coverageNote: string
  notConfiguredReason: string
  sourceLabel: string
  defaultNoticeType?: string
}

/**
 * Builds a §6.1A adapter over a configured official feed. All behaviour comes
 * from OpportunitySourceConfig.configJson:
 *   feedUrl        (required) official JSON / Open Data / RSS endpoint
 *   format         'JSON' | 'RSS'                (default JSON)
 *   rootKey        envelope key holding the array
 *   fieldMap       per-field alias overrides
 *   jurisdiction   label applied when rows omit an agency
 *   defaultAgency  fallback agency name
 *   pageParam/limitParam/pageSize  optional server-side paging
 */
export function createFeedAdapter(spec: FeedAdapterSpec): SourceAdapter {
  return {
    key: spec.key,
    displayName: spec.displayName,
    category: spec.category,
    produces: 'OPPORTUNITY',
    supportsIncremental: false,
    pageSize: 100,
    coverageNote: spec.coverageNote,

    configure(env: AdapterEnv): ConfigureResult {
      const feedUrl = (env.config.feedUrl as string | undefined) || env.baseUrl
      if (!feedUrl) return { state: 'NOT_CONFIGURED', reason: spec.notConfiguredReason }
      return { state: 'READY' }
    },

    async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
      const feedUrl = String(env.config.feedUrl || env.baseUrl)
      const format: FeedFormat = (env.config.format as FeedFormat) === 'RSS' ? 'RSS' : 'JSON'
      const rootKey = typeof env.config.rootKey === 'string' ? env.config.rootKey : undefined
      const fieldMap: Required<FeedFieldMap> = {
        ...GENERIC_FIELD_MAP,
        ...((env.config.fieldMap as Partial<Required<FeedFieldMap>> | undefined) ?? {}),
      }

      // Optional server-side paging. Absent config = single-document feed.
      const pageParam = typeof env.config.pageParam === 'string' ? env.config.pageParam : null
      const limitParam = typeof env.config.limitParam === 'string' ? env.config.limitParam : null
      const pageSize = Number(env.config.pageSize ?? 100) || 100
      const offset = Number(args.pageToken ?? '0') || 0
      if (!pageParam && args.pageToken) return { records: [], nextPageToken: null }

      const params: Record<string, unknown> = {}
      if (pageParam) params[pageParam] = offset
      if (limitParam) params[limitParam] = pageSize

      let response
      try {
        response = await axios.get(feedUrl, {
          params,
          timeout: args.timeoutMs,
          responseType: 'text',
          transformResponse: [(d) => d],
          headers: { Accept: format === 'RSS' ? 'application/rss+xml, application/xml, text/xml' : 'application/json' },
        })
      } catch (err: unknown) {
        const status = (err as { response?: { status?: number } })?.response?.status
        if (status === 429) return { records: [], nextPageToken: null, rateLimited: true }
        throw err
      }

      const rows = extractFeedRows(response.data, format, rootKey)
      const defaults: FeedNormalizeDefaults = {
        agency: (env.config.defaultAgency as string | undefined) ?? null,
        jurisdiction: (env.config.jurisdiction as string | undefined) ?? null,
        noticeType: spec.defaultNoticeType ?? null,
        feedUrl,
        sourceLabel: spec.sourceLabel,
      }

      const records = rows
        .map((r) => normalizeFeedRow(r, fieldMap, defaults))
        .filter((r): r is NormalizedOpportunity => r !== null)

      const nextPageToken = pageParam && rows.length === pageSize ? String(offset + pageSize) : null
      return { records, nextPageToken, nextCursor: args.now.toISOString() }
    },
  }
}

export const __testing = { GENERIC_FIELD_MAP, normalizeKey, indexRow, pick, SourceDataQuality }
