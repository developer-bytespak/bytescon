// =============================================================
// §6.1A — SAM.gov adapter.
//
// Reuses the EXISTING, tested SAM primitives (requestSamPage, mapSetAside,
// resolveResponseDeadline) rather than reimplementing the client, and writes
// through the same Opportunity records keyed on samNoticeId. The legacy
// samApiService.searchAndIngest path is untouched and remains functional; this
// adapter is the same feed expressed through the §6.1A contract so SAM.gov
// gains cursors, run history, data-quality state and freshness reporting
// alongside every other source.
//
// The API key is optional at the platform level: it is read from the firm's
// stored key first, then SAM_API_KEY. With neither, the adapter reports
// NOT_CONFIGURED and nothing breaks.
// =============================================================
import { SourceCategory, SourceDataQuality } from '@prisma/client'
import {
  SourceAdapter,
  AdapterEnv,
  ConfigureResult,
  FetchPageArgs,
  FetchPageResult,
  NormalizedOpportunity,
  parseSourceDate,
  trimOrNull,
  deriveDataQuality,
} from '../sourceAdapter'
import { requestSamPage, mapSetAside, resolveResponseDeadline } from '../../samApi'

const PAGE_SIZE = 25

interface SamRecord {
  noticeId?: string
  solicitationNumber?: string
  title?: string
  department?: string
  subTier?: string
  office?: string
  fullParentPathName?: string
  naicsCode?: string
  classificationCode?: string
  typeOfSetAside?: string
  type?: string
  baseType?: string
  postedDate?: string
  responseDeadLine?: string
  archiveDate?: string
  uiLink?: string
  description?: string
  placeOfPerformance?: { city?: { name?: string }; state?: { code?: string } }
}

function formatSamDate(date: Date): string {
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(date.getUTCDate()).padStart(2, '0')
  return `${mm}/${dd}/${date.getUTCFullYear()}`
}

export function normalizeSamRecord(record: SamRecord, now: Date): NormalizedOpportunity | null {
  const externalId = trimOrNull(record.noticeId, 120)
  const title = trimOrNull(record.title, 500)
  if (!externalId || !title) return null

  const agency =
    trimOrNull(record.department, 300) ??
    trimOrNull(record.fullParentPathName?.split('.')[0], 300) ??
    'Unknown agency'

  const pop = record.placeOfPerformance
  const placeOfPerformance = pop
    ? [pop.city?.name, pop.state?.code].filter(Boolean).join(', ') || null
    : null

  const naicsCode = trimOrNull(record.naicsCode, 10)
  const responseDeadline = resolveResponseDeadline(
    { responseDeadLine: record.responseDeadLine ?? null, archiveDate: record.archiveDate ?? null },
    now,
  )

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency,
    subagency: trimOrNull(record.subTier, 300),
    office: trimOrNull(record.office, 300),
    description: trimOrNull(record.description, 8000),
    naicsCode,
    psc: trimOrNull(record.classificationCode, 20),
    setAsideType: mapSetAside(record.typeOfSetAside),
    noticeType: trimOrNull(record.type ?? record.baseType, 120),
    solicitationNumber: trimOrNull(record.solicitationNumber, 120),
    postedDate: parseSourceDate(record.postedDate),
    responseDeadline,
    archiveDate: parseSourceDate(record.archiveDate),
    placeOfPerformance,
    sourceUrl: trimOrNull(record.uiLink, 1000),
    // SAM search results carry no per-record modified timestamp; postedDate is
    // the closest honest signal and amendment detection uses content hashes.
    sourceUpdatedAt: parseSourceDate(record.postedDate),
    sourceMetadata: { provider: 'sam.gov', type: record.type ?? null, baseType: record.baseType ?? null },
    // Without an explicit response deadline the record fell back to archiveDate
    // (or now) — flag that rather than presenting it as a firm date.
    dataQuality: deriveDataQuality([Boolean(record.responseDeadLine), Boolean(naicsCode)]),
  }
}

export const samGovAdapter: SourceAdapter = {
  key: 'sam_gov',
  displayName: 'SAM.gov Contract Opportunities',
  category: SourceCategory.SAM_GOV,
  produces: 'OPPORTUNITY',
  supportsIncremental: true,
  pageSize: PAGE_SIZE,
  coverageNote:
    'Federal contract opportunities from the SAM.gov Get Opportunities public API. Requires a SAM.gov API key (firm setting or SAM_API_KEY); without one this source stays disabled and the rest of the platform is unaffected.',

  configure(env: AdapterEnv): ConfigureResult {
    const key = env.firmApiKey || env.getEnv('SAM_API_KEY')
    if (!key) {
      return {
        state: 'NOT_CONFIGURED',
        reason: 'No SAM.gov API key. Add one in Settings → SAM API Key, or set SAM_API_KEY.',
        requiredEnvKey: 'SAM_API_KEY',
      }
    }
    return { state: 'READY' }
  },

  async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
    const apiKey = env.firmApiKey || env.getEnv('SAM_API_KEY')
    if (!apiKey) throw new Error('SAM.gov API key not configured')

    const offset = Number(args.pageToken ?? '0') || 0
    // INCREMENTAL replays from the stored watermark; FULL uses the configured
    // lookback (default 30 days) so a first run is bounded, not a year-long pull.
    const lookbackDays = Number(env.config.lookbackDays ?? 30) || 30
    const cursorDate = args.mode === 'INCREMENTAL' ? parseSourceDate(args.cursor) : null
    const from = cursorDate ?? new Date(args.now.getTime() - lookbackDays * 86400000)

    const params: Record<string, unknown> = {
      api_key: apiKey,
      postedFrom: formatSamDate(from),
      postedTo: formatSamDate(args.now),
      limit: PAGE_SIZE,
      offset,
    }
    if (typeof env.config.naicsCode === 'string' && env.config.naicsCode) params.ncode = env.config.naicsCode
    if (typeof env.config.noticeType === 'string' && env.config.noticeType) params.ptype = env.config.noticeType

    let response
    try {
      response = await requestSamPage(params, { timeoutMs: args.timeoutMs })
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429) return { records: [], nextPageToken: null, rateLimited: true }
      throw err
    }

    const data = response.data as { opportunitiesData?: SamRecord[]; totalRecords?: number }
    const page = data?.opportunitiesData ?? []
    const records = page
      .map((r) => normalizeSamRecord(r, args.now))
      .filter((r): r is NormalizedOpportunity => r !== null)

    const total = data?.totalRecords ?? 0
    const consumed = offset + page.length
    const nextPageToken = page.length === PAGE_SIZE && consumed < total ? String(consumed) : null

    return {
      records,
      nextPageToken,
      // Watermark only advances to the run instant, so a record posted during
      // the run is re-seen next time rather than skipped.
      nextCursor: args.now.toISOString(),
    }
  },
}

export const __testing = { formatSamDate, PAGE_SIZE, SourceDataQuality }
