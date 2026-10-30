// =============================================================
// Open Contracting (OCDS) tender adapter factory.
//
// UK Contracts Finder and UK Find a Tender both publish open tenders as OCDS
// release packages: keyless GET {baseUrl}{searchPath}?stages=tender&limit=,
// cursor paging via links.next. Each source differs only in its endpoint and in
// how a release maps to its public notice page, so both are built here.
//
// The page token carries links.next plus the running count used to honour
// configJson.maxRecords; the persisted cursor ("<prefix>" + token) lets a
// backfill resume across bounded sync runs. Only tenders still open
// (tender.status = "active") are kept. Values are usually GBP — kept in
// metadata, never stored as USD.
// =============================================================
import axios from 'axios'
import { SourceCategory } from '@prisma/client'
import {
  SourceAdapter, AdapterEnv, ConfigureResult, FetchPageArgs, FetchPageResult, NormalizedOpportunity,
  parseSourceDate, parseSourceAmount, trimOrNull, deriveDataQuality,
} from '../sourceAdapter'
import { maxRecordsFor, pageSizeWithinCap, joinDescription, valueLine, usdOnly } from './tenderFeedHelpers'

const PAGE_SIZE = 50

export interface OcdsRelease {
  ocid?: string
  id?: string
  date?: string
  tender?: {
    title?: string
    description?: string
    status?: string
    datePublished?: string
    value?: { amount?: number | string; currency?: string }
    tenderPeriod?: { endDate?: string }
    classification?: { scheme?: string; id?: string; description?: string }
    procurementMethodDetails?: string
    mainProcurementCategory?: string
    suitability?: { sme?: boolean; vcse?: boolean }
  }
  buyer?: { name?: string }
  parties?: { roles?: string[]; address?: { locality?: string; countryName?: string }; contactPoint?: { name?: string; email?: string } }[]
}

interface OcdsSearchResponse {
  releases?: OcdsRelease[]
  links?: { next?: string }
}

export interface PageState { next: string | null; consumed: number }

export interface OcdsTenderSource {
  key: string
  displayName: string
  /** Stored as sourceMetadata.provider; the UI labels rows by it. */
  provider: string
  defaultBaseUrl: string
  searchPath: string
  /** Prefix of the persisted resume cursor; unique per adapter. */
  cursorPrefix: string
  /** Records synced when configJson.maxRecords is unset. */
  defaultTarget?: number
  coverageNote: string
  /** Public page for one release, or null when it cannot be built. */
  noticeUrl(release: OcdsRelease): string | null
}

export function readToken(token: string | null | undefined): PageState {
  if (!token) return { next: null, consumed: 0 }
  try { const s = JSON.parse(token); return { next: s.next ?? null, consumed: Number(s.consumed) || 0 } } catch { return { next: null, consumed: 0 } }
}

export function resumeState(prefix: string, cursor: string | null | undefined, cap: number): PageState {
  if (!cursor?.startsWith(prefix)) return { next: null, consumed: 0 }
  const s = readToken(cursor.slice(prefix.length))
  return s.next && s.consumed < cap ? s : { next: null, consumed: 0 }
}

export function normalizeOcdsRelease(source: OcdsTenderSource, r: OcdsRelease): NormalizedOpportunity | null {
  const t = r.tender
  const externalId = trimOrNull(r.ocid, 120)
  const title = trimOrNull(t?.title, 500)
  if (!externalId || !title || !t) return null
  if (t.status && t.status !== 'active') return null

  const buyer = r.parties?.find((p) => p.roles?.includes('buyer'))
  const amount = parseSourceAmount(t.value?.amount)
  const currency = t.value?.currency ?? null
  const deadline = parseSourceDate(t.tenderPeriod?.endDate)
  const place = [buyer?.address?.locality, buyer?.address?.countryName ?? 'United Kingdom'].filter(Boolean).join(', ')

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency: trimOrNull(r.buyer?.name, 300) ?? 'UK public buyer',
    description: joinDescription(valueLine(amount, currency), trimOrNull(t.description, 7000)),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: trimOrNull(t.procurementMethodDetails, 120) ?? 'Tender',
    solicitationNumber: trimOrNull(r.id, 120),
    postedDate: parseSourceDate(t.datePublished ?? r.date),
    responseDeadline: deadline,
    placeOfPerformance: place || 'United Kingdom',
    estimatedValue: usdOnly(amount, currency),
    sourceUrl: source.noticeUrl(r),
    sourceUpdatedAt: parseSourceDate(r.date),
    sourceMetadata: {
      provider: source.provider,
      value: amount, currency,
      cpv: t.classification?.scheme === 'CPV' ? { code: t.classification.id ?? null, description: t.classification.description ?? null } : null,
      category: t.mainProcurementCategory ?? null,
      suitableForSme: t.suitability?.sme ?? null,
      contact: { name: buyer?.contactPoint?.name ?? null, email: buyer?.contactPoint?.email ?? null },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(r.buyer?.name)]),
  }
}

export function createOcdsTenderAdapter(source: OcdsTenderSource): SourceAdapter {
  return {
    key: source.key,
    displayName: source.displayName,
    category: SourceCategory.COMMERCIAL,
    produces: 'OPPORTUNITY',
    supportsIncremental: false,
    pageSize: PAGE_SIZE,
    coverageNote: source.coverageNote,

    configure(): ConfigureResult {
      return { state: 'READY' }
    },

    async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
      const baseUrl = String(env.baseUrl || env.config.baseUrl || source.defaultBaseUrl).replace(/\/$/, '')
      const cap = maxRecordsFor(env, source.defaultTarget)
      const state = args.pageToken ? readToken(args.pageToken) : resumeState(source.cursorPrefix, args.cursor, cap)
      const limit = pageSizeWithinCap(state.consumed, PAGE_SIZE, cap)
      if (limit === 0) return { records: [], nextPageToken: null, nextCursor: source.cursorPrefix + 'start' }

      let response
      try {
        response = state.next
          ? await axios.get<OcdsSearchResponse>(state.next, { timeout: args.timeoutMs })
          : await axios.get<OcdsSearchResponse>(`${baseUrl}${source.searchPath}`, {
              params: { stages: 'tender', limit },
              timeout: args.timeoutMs,
            })
      } catch (err: unknown) {
        if ((err as { response?: { status?: number } })?.response?.status === 429) return { records: [], nextPageToken: null, rateLimited: true }
        throw err
      }

      const releases = (response.data?.releases ?? []).slice(0, limit)
      const records = releases.map((r) => normalizeOcdsRelease(source, r)).filter((r): r is NormalizedOpportunity => r !== null)
      const consumed = state.consumed + releases.length
      const next = response.data?.links?.next
      const nextPageToken = next && releases.length > 0 && consumed < cap ? JSON.stringify({ next, consumed }) : null
      return { records, nextPageToken, nextCursor: source.cursorPrefix + (nextPageToken ?? 'start') }
    },
  }
}
