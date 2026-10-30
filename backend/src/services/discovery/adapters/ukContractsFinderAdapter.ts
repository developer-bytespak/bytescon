// =============================================================
// UK Contracts Finder adapter (COMMERCIAL).
//
// Public, keyless OCDS search API:
//   GET {baseUrl}/Published/Notices/OCDS/Search?stages=tender&limit=
// Paging is cursor-based (links.next), so the page token carries that URL plus
// the running count used to honour configJson.maxRecords. Only tenders still
// open (tender.status = "active") are kept. Values are GBP — kept in metadata,
// never stored as USD.
// =============================================================
import axios from 'axios'
import { SourceCategory } from '@prisma/client'
import {
  SourceAdapter, AdapterEnv, ConfigureResult, FetchPageArgs, FetchPageResult, NormalizedOpportunity,
  parseSourceDate, parseSourceAmount, trimOrNull, deriveDataQuality,
} from '../sourceAdapter'
import { maxRecordsFor, pageSizeWithinCap, joinDescription, valueLine, usdOnly } from './tenderFeedHelpers'

const DEFAULT_BASE_URL = 'https://www.contractsfinder.service.gov.uk'
const PAGE_SIZE = 50

interface OcdsRelease {
  ocid?: string
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
    items?: { deliveryAddresses?: { postalCode?: string; region?: string }[] }[]
  }
  buyer?: { name?: string }
  parties?: { roles?: string[]; address?: { locality?: string; countryName?: string }; contactPoint?: { name?: string; email?: string } }[]
}

interface OcdsSearchResponse {
  releases?: OcdsRelease[]
  links?: { next?: string }
}

interface PageState { next: string | null; consumed: number }

// The persisted cursor is 'uk:' + a page token, so a backfill resumes across
// bounded sync runs; 'uk:start' (or a cap already met) starts from the newest.
const CURSOR_PREFIX = 'uk:'

function resumeState(cursor: string | null | undefined, cap: number): PageState {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return { next: null, consumed: 0 }
  const s = readToken(cursor.slice(CURSOR_PREFIX.length))
  return s.next && s.consumed < cap ? s : { next: null, consumed: 0 }
}

function readToken(token: string | null | undefined): PageState {
  if (!token) return { next: null, consumed: 0 }
  try { const s = JSON.parse(token); return { next: s.next ?? null, consumed: Number(s.consumed) || 0 } } catch { return { next: null, consumed: 0 } }
}

/** ocid "ocds-b5fd17-<notice guid>" → public notice page. */
function noticeUrl(ocid: string): string {
  const guid = ocid.replace(/^ocds-[a-z0-9]+-/i, '')
  return `https://www.contractsfinder.service.gov.uk/Notice/${encodeURIComponent(guid)}`
}

function normalizeRelease(r: OcdsRelease): NormalizedOpportunity | null {
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
    solicitationNumber: null,
    postedDate: parseSourceDate(t.datePublished ?? r.date),
    responseDeadline: deadline,
    placeOfPerformance: place || 'United Kingdom',
    estimatedValue: usdOnly(amount, currency),
    sourceUrl: noticeUrl(externalId),
    sourceUpdatedAt: parseSourceDate(r.date),
    sourceMetadata: {
      provider: 'contractsfinder.service.gov.uk',
      value: amount, currency,
      cpv: t.classification?.scheme === 'CPV' ? { code: t.classification.id ?? null, description: t.classification.description ?? null } : null,
      category: t.mainProcurementCategory ?? null,
      suitableForSme: t.suitability?.sme ?? null,
      contact: { name: buyer?.contactPoint?.name ?? null, email: buyer?.contactPoint?.email ?? null },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(r.buyer?.name)]),
  }
}

export const ukContractsFinderAdapter: SourceAdapter = {
  key: 'uk_contracts_finder',
  displayName: 'UK Contracts Finder',
  category: SourceCategory.COMMERCIAL,
  produces: 'OPPORTUNITY',
  supportsIncremental: false,
  pageSize: PAGE_SIZE,
  coverageNote:
    'Open UK public-sector tenders from the public Contracts Finder OCDS API. Buyers are UK bodies; values are in GBP and are not converted. Each run pulls up to configJson.maxRecords tenders, newest first.',

  configure(): ConfigureResult {
    return { state: 'READY' }
  },

  async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
    const baseUrl = String(env.baseUrl || env.config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    const cap = maxRecordsFor(env)
    const state = args.pageToken ? readToken(args.pageToken) : resumeState(args.cursor, cap)
    const limit = pageSizeWithinCap(state.consumed, PAGE_SIZE, cap)
    if (limit === 0) return { records: [], nextPageToken: null, nextCursor: CURSOR_PREFIX + 'start' }

    let response
    try {
      response = state.next
        ? await axios.get<OcdsSearchResponse>(state.next, { timeout: args.timeoutMs })
        : await axios.get<OcdsSearchResponse>(`${baseUrl}/Published/Notices/OCDS/Search`, {
            params: { stages: 'tender', limit },
            timeout: args.timeoutMs,
          })
    } catch (err: unknown) {
      if ((err as { response?: { status?: number } })?.response?.status === 429) return { records: [], nextPageToken: null, rateLimited: true }
      throw err
    }

    const releases = (response.data?.releases ?? []).slice(0, limit)
    const records = releases.map(normalizeRelease).filter((r): r is NormalizedOpportunity => r !== null)
    const consumed = state.consumed + releases.length
    const next = response.data?.links?.next
    const nextPageToken = next && releases.length > 0 && consumed < cap ? JSON.stringify({ next, consumed }) : null
    return { records, nextPageToken, nextCursor: CURSOR_PREFIX + (nextPageToken ?? 'start') }
  },
}

export const __testing = { normalizeRelease, noticeUrl, readToken, resumeState }
