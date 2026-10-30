// =============================================================
// US open-bid adapter factory (Socrata open-data portals).
//
// US cities, counties and states publish their open bids as Socrata datasets:
// keyless GET {baseUrl}/resource/{dataset}.json?$where=&$order=&$limit=&$offset=
// Each source differs only in its portal, dataset, filter and row shape, so
// paging, the record cap and rate-limit handling live here. Values are USD.
// =============================================================
import axios from 'axios'
import { SourceCategory } from '@prisma/client'
import {
  SourceAdapter, AdapterEnv, ConfigureResult, FetchPageArgs, FetchPageResult, NormalizedOpportunity,
} from '../sourceAdapter'
import { maxRecordsFor, startOffset, resumeCursor, pageSizeWithinCap, nextOffsetToken } from './tenderFeedHelpers'

const PAGE_SIZE = 50
/** City/state feeds hold a few hundred open bids at most, so one run takes them all. */
const DEFAULT_TARGET = 300

export interface SocrataTenderSource<Row> {
  key: string
  displayName: string
  defaultBaseUrl: string
  dataset: string
  /** SoQL query besides paging: $where, $order, and $select/$group for item-level feeds. */
  query: Record<string, string>
  coverageNote: string
  normalize: (row: Row) => NormalizedOpportunity | null
  /** Bulk feeds (USAC, ~100k+ rows) page larger and backfill across runs. */
  pageSize?: number
  defaultTarget?: number
}

export function createSocrataTenderAdapter<Row>(source: SocrataTenderSource<Row>): SourceAdapter {
  const pageSize = source.pageSize ?? PAGE_SIZE
  return {
    key: source.key,
    displayName: source.displayName,
    category: SourceCategory.COMMERCIAL,
    produces: 'OPPORTUNITY',
    supportsIncremental: false,
    pageSize,
    coverageNote: source.coverageNote,

    configure(): ConfigureResult {
      return { state: 'READY' }
    },

    async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
      const baseUrl = String(env.baseUrl || env.config.baseUrl || source.defaultBaseUrl).replace(/\/$/, '')
      const cap = maxRecordsFor(env, source.defaultTarget ?? DEFAULT_TARGET)
      const offset = startOffset(args.pageToken, args.cursor, cap)
      const limit = pageSizeWithinCap(offset, pageSize, cap)
      if (limit === 0) return { records: [], nextPageToken: null, nextCursor: resumeCursor(null) }

      let response
      try {
        response = await axios.get<Row[]>(`${baseUrl}/resource/${source.dataset}.json`, {
          params: { ...source.query, $limit: limit, $offset: offset },
          timeout: args.timeoutMs,
        })
      } catch (err: unknown) {
        if ((err as { response?: { status?: number } })?.response?.status === 429) return { records: [], nextPageToken: null, rateLimited: true }
        throw err
      }

      const rows = Array.isArray(response.data) ? response.data : []
      const records = rows.map(source.normalize).filter((r): r is NormalizedOpportunity => r !== null)
      const nextPageToken = nextOffsetToken(offset, rows.length, limit, cap)
      return { records, nextPageToken, nextCursor: resumeCursor(nextPageToken) }
    },
  }
}
