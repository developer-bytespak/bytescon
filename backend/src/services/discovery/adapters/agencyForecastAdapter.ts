// =============================================================
// §6.1B — Agency procurement forecast adapter.
//
// Agencies publish procurement forecasts in a handful of shapes: a JSON array,
// a JSON envelope with a records array, or a CSV export. There is no single
// government-wide forecast API, so this adapter reads a CONFIGURED official
// feed URL per firm (config.feedUrl) and normalizes whichever of those three
// shapes it receives, using a configurable column map.
//
// Everything it produces is an AgencyForecast — never an Opportunity. A
// forecast can therefore never be rendered as a released solicitation.
//
// No credential is required. With no feedUrl configured the adapter reports
// NOT_CONFIGURED and the platform runs unchanged.
// =============================================================
import axios from 'axios'
import { SourceCategory, SourceDataQuality } from '@prisma/client'
import {
  SourceAdapter,
  AdapterEnv,
  ConfigureResult,
  FetchPageArgs,
  FetchPageResult,
  NormalizedForecast,
  parseSourceDate,
  parseSourceAmount,
  trimOrNull,
  deriveDataQuality,
} from '../sourceAdapter'

/**
 * Default field aliases. Agencies label the same concept many ways; each
 * target field lists the source headers we accept, lower-cased and stripped of
 * non-alphanumerics. A firm can extend/replace this via config.columnMap.
 */
const DEFAULT_COLUMN_MAP: Record<string, string[]> = {
  externalId: ['forecastid', 'id', 'listingid', 'sequencenumber', 'recordid', 'apfsnumber'],
  title: ['title', 'requirementtitle', 'projecttitle', 'description', 'requirementdescription'],
  description: ['description', 'requirementdescription', 'scope', 'summary'],
  agency: ['agency', 'department', 'organization', 'agencyname'],
  subAgency: ['subagency', 'bureau', 'component', 'suborganization'],
  contractingOffice: ['office', 'contractingoffice', 'contractingofficename'],
  anticipatedSolicitationDate: ['anticipatedsolicitationdate', 'estimatedsolicitationdate', 'solicitationdate', 'anticipatedsolicitationreleasedate', 'targetsolicitationdate'],
  anticipatedAwardDate: ['anticipatedawarddate', 'estimatedawarddate', 'awarddate', 'targetawarddate'],
  fiscalYear: ['fiscalyear', 'fy'],
  naicsCode: ['naics', 'naicscode', 'naicscodes'],
  psc: ['psc', 'productservicecode', 'psccode'],
  setAsideExpectation: ['setaside', 'anticipatedsetaside', 'setasidetype', 'competitiontype'],
  contractVehicle: ['contractvehicle', 'vehicle', 'contracttype'],
  estimatedValue: ['estimatedvalue', 'estimatedcontractvalue', 'dollarvalue', 'estimatedtotalvalue'],
  estimatedValueMin: ['estimatedvaluemin', 'dollarrangelow', 'valuelow'],
  estimatedValueMax: ['estimatedvaluemax', 'dollarrangehigh', 'valuehigh'],
  incumbentName: ['incumbent', 'incumbentname', 'currentcontractor'],
  placeOfPerformance: ['placeofperformance', 'location', 'popcity', 'performancelocation'],
  contactName: ['contact', 'contactname', 'pointofcontact', 'smallbusinessspecialist'],
  contactEmail: ['contactemail', 'email', 'pocemail'],
  contactPhone: ['contactphone', 'phone', 'pocphone'],
  sourceUrl: ['url', 'link', 'sourceurl'],
  sourceUpdatedAt: ['lastupdated', 'lastmodified', 'updateddate', 'datemodified'],
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Builds a lookup of normalized-header → raw value for one source row. */
function indexRow(row: Record<string, unknown>): Map<string, unknown> {
  const idx = new Map<string, unknown>()
  for (const [k, v] of Object.entries(row)) idx.set(normalizeKey(k), v)
  return idx
}

function pick(idx: Map<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    const v = idx.get(alias)
    if (v !== undefined && v !== null && String(v).trim() !== '') return v
  }
  return undefined
}

/**
 * Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, embedded
 * newlines). Avoids adding a dependency for a single feed shape.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else field += ch
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''))
  if (nonEmpty.length < 2) return []
  const headers = nonEmpty[0].map((h) => h.trim())
  return nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = (r[i] ?? '').trim() })
    return obj
  })
}

/** Accepts a JSON array, a JSON envelope, or CSV text. */
export function extractRows(payload: unknown, contentType: string): Record<string, unknown>[] {
  if (typeof payload === 'string') {
    const text = payload.trim()
    if (text.startsWith('[') || text.startsWith('{')) {
      try { return extractRows(JSON.parse(text), 'application/json') } catch { /* fall through to CSV */ }
    }
    if (contentType.includes('csv') || text.includes(',')) return parseCsv(text)
    return []
  }
  if (Array.isArray(payload)) return payload.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
  if (payload && typeof payload === 'object') {
    const env = payload as Record<string, unknown>
    for (const key of ['records', 'results', 'data', 'items', 'forecasts', 'opportunities']) {
      if (Array.isArray(env[key])) return extractRows(env[key], 'application/json')
    }
  }
  return []
}

export function normalizeForecastRow(
  row: Record<string, unknown>,
  columnMap: Record<string, string[]>,
  defaults: { agency?: string | null; feedUrl?: string | null },
): NormalizedForecast | null {
  const idx = indexRow(row)
  const get = (field: string) => pick(idx, columnMap[field] ?? DEFAULT_COLUMN_MAP[field] ?? [])

  const title = trimOrNull(get('title'), 500)
  const agency = trimOrNull(get('agency'), 300) ?? trimOrNull(defaults.agency, 300)
  if (!title || !agency) return null

  // A feed without a stable id gets a deterministic surrogate so repeated syncs
  // update the same record instead of creating duplicates.
  const rawId = trimOrNull(get('externalId'), 200)
  const solDate = parseSourceDate(get('anticipatedSolicitationDate'))
  const externalId =
    rawId ??
    `${normalizeKey(agency)}:${normalizeKey(title).slice(0, 80)}:${solDate ? solDate.toISOString().slice(0, 10) : 'nodate'}`

  const fyRaw = get('fiscalYear')
  const fyNum = fyRaw === undefined ? null : Number(String(fyRaw).replace(/[^0-9]/g, ''))
  const fiscalYear = fyNum && fyNum >= 1990 && fyNum <= 2100 ? fyNum : null

  const naicsRaw = trimOrNull(get('naicsCode'), 60)
  const naicsCode = naicsRaw ? (naicsRaw.match(/\d{2,6}/)?.[0] ?? null) : null

  const awardDate = parseSourceDate(get('anticipatedAwardDate'))

  return {
    kind: 'FORECAST',
    externalId,
    agency,
    subAgency: trimOrNull(get('subAgency'), 300),
    contractingOffice: trimOrNull(get('contractingOffice'), 300),
    title,
    description: trimOrNull(get('description'), 8000),
    anticipatedSolicitationDate: solDate,
    anticipatedAwardDate: awardDate,
    fiscalYear,
    naicsCode,
    psc: trimOrNull(get('psc'), 20),
    setAsideExpectation: trimOrNull(get('setAsideExpectation'), 80),
    contractVehicle: trimOrNull(get('contractVehicle'), 120),
    estimatedValue: parseSourceAmount(get('estimatedValue')),
    estimatedValueMin: parseSourceAmount(get('estimatedValueMin')),
    estimatedValueMax: parseSourceAmount(get('estimatedValueMax')),
    // Only carried through when the source explicitly supplies it.
    incumbentName: trimOrNull(get('incumbentName'), 300),
    placeOfPerformance: trimOrNull(get('placeOfPerformance'), 300),
    contactName: trimOrNull(get('contactName'), 200),
    contactEmail: trimOrNull(get('contactEmail'), 200),
    contactPhone: trimOrNull(get('contactPhone'), 60),
    sourceUrl: trimOrNull(get('sourceUrl'), 1000) ?? defaults.feedUrl ?? null,
    sourceReference: defaults.feedUrl ?? null,
    sourceUpdatedAt: parseSourceDate(get('sourceUpdatedAt')),
    sourceMetadata: { provider: 'agency_forecast_feed', raw: row },
    // A forecast with neither an anticipated solicitation nor award date cannot
    // support timeline features; that is reported, not hidden.
    dataQuality: deriveDataQuality([Boolean(solDate || awardDate), Boolean(naicsCode || get('psc'))]),
  }
}

export const agencyForecastAdapter: SourceAdapter = {
  key: 'agency_forecast',
  displayName: 'Agency Procurement Forecast',
  category: SourceCategory.AGENCY_FORECAST,
  produces: 'FORECAST',
  supportsIncremental: false,
  pageSize: 1000,
  coverageNote:
    'Reads one configured official agency procurement-forecast feed (JSON or CSV) per source. Coverage is exactly the feed you configure — there is no government-wide forecast API, so this makes no claim of all-agency coverage.',

  configure(env: AdapterEnv): ConfigureResult {
    const feedUrl = (env.config.feedUrl as string | undefined) || env.baseUrl
    if (!feedUrl) {
      return {
        state: 'NOT_CONFIGURED',
        reason: 'No forecast feed URL configured. Set the source’s feedUrl to an official agency forecast JSON or CSV endpoint.',
      }
    }
    return { state: 'READY' }
  },

  async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
    // The feed is a full document; it is fetched once per run and all rows are
    // returned in a single page.
    if (args.pageToken) return { records: [], nextPageToken: null }

    const feedUrl = String(env.config.feedUrl || env.baseUrl)
    const columnMap = {
      ...DEFAULT_COLUMN_MAP,
      ...((env.config.columnMap as Record<string, string[]> | undefined) ?? {}),
    }

    let response
    try {
      response = await axios.get(feedUrl, {
        timeout: args.timeoutMs,
        responseType: 'text',
        transformResponse: [(d) => d],
        headers: { Accept: 'application/json, text/csv;q=0.9, */*;q=0.5' },
      })
    } catch (err: unknown) {
      const status = (err as { response?: { status?: number } })?.response?.status
      if (status === 429) return { records: [], nextPageToken: null, rateLimited: true }
      throw err
    }

    const contentType = String(response.headers?.['content-type'] ?? '')
    const rows = extractRows(response.data, contentType)
    const defaults = {
      agency: (env.config.defaultAgency as string | undefined) ?? null,
      feedUrl,
    }

    const records = rows
      .map((r) => normalizeForecastRow(r, columnMap, defaults))
      .filter((r): r is NormalizedForecast => r !== null)

    return { records, nextPageToken: null, nextCursor: args.now.toISOString() }
  },
}

export const __testing = { DEFAULT_COLUMN_MAP, normalizeKey, indexRow, pick, SourceDataQuality }
