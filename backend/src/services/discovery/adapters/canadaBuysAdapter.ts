// =============================================================
// CanadaBuys adapter (COMMERCIAL).
//
// The Government of Canada's official open-data file of every OPEN tender
// notice (federal departments and Crown corporations, many published via
// MERX). Keyless CSV, refreshed daily, ~6 MB, bilingual columns:
//   GET {baseUrl}/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv
// The file has no paging, so one run downloads it once and takes the newest
// rows up to configJson.maxRecords (default 200), resuming by offset on later
// runs like the other tender adapters.
// =============================================================
import axios from 'axios'
import { SourceCategory } from '@prisma/client'
import {
  SourceAdapter, AdapterEnv, ConfigureResult, FetchPageArgs, FetchPageResult, NormalizedOpportunity,
  parseSourceDate, trimOrNull, deriveDataQuality,
} from '../sourceAdapter'
import { parseCsv } from './agencyForecastAdapter'
import { maxRecordsFor, startOffset, resumeCursor, joinDescription } from './tenderFeedHelpers'

const DEFAULT_BASE_URL = 'https://canadabuys.canada.ca'
const FILE_PATH = '/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv'
const DEFAULT_TARGET = 200
/** Rows normalized per run; the orchestrator persists them in one pass. */
const ROWS_PER_RUN = 2000

type Row = Record<string, string>

// Column names are bilingual "english-french" keys; read the English ones.
const COL = {
  title: 'title-titre-eng',
  reference: 'referenceNumber-numeroReference',
  solicitation: 'solicitationNumber-numeroSollicitation',
  published: 'publicationDate-datePublication',
  closing: 'tenderClosingDate-appelOffresDateCloture',
  amended: 'amendmentDate-dateModification',
  status: 'tenderStatus-appelOffresStatut-eng',
  category: 'procurementCategory-categorieApprovisionnement',
  unspscDescription: 'unspscDescription-eng',
  noticeType: 'noticeType-avisType-eng',
  method: 'procurementMethod-methodeApprovisionnement-eng',
  tradeAgreements: 'tradeAgreements-accordsCommerciaux-eng',
  regionsOfDelivery: 'regionsOfDelivery-regionsLivraison-eng',
  entity: 'contractingEntityName-nomEntitContractante-eng',
  entityCity: 'contractingEntityAddressCity-entiteContractanteAdresseVille-eng',
  entityProvince: 'contractingEntityAddressProvince-entiteContractanteAdresseProvince-eng',
  contactName: 'contactInfoName-informationsContactNom',
  contactEmail: 'contactInfoEmail-informationsContactCourriel',
  contactPhone: 'contactInfoPhone-contactInfoTelephone',
  url: 'noticeURL-URLavis-eng',
  description: 'tenderDescription-descriptionAppelOffres-eng',
} as const

const CATEGORY_LABELS: Record<string, string> = { GD: 'Goods', SRV: 'Services', CNST: 'Construction', SRVTGD: 'Services related to goods' }

/** Category cells hold codes like '*GD*SRV'; spell them out. */
function categoryText(value: string | undefined): string | null {
  const codes = starList(value)?.split('; ') ?? []
  return codes.length ? codes.map((c) => CATEGORY_LABELS[c] ?? c).join(', ') : null
}

/** Multi-value cells are "*A *B" lists (often with line breaks); flatten to "A; B". */
function starList(value: string | undefined): string | null {
  if (!value) return null
  const items = value.split('*').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)
  return items.length ? items.join('; ') : null
}

function normalizeRow(r: Row): NormalizedOpportunity | null {
  const externalId = trimOrNull(r[COL.reference], 120)
  const title = trimOrNull(r[COL.title], 500)
  if (!externalId || !title) return null
  if (r[COL.status] && r[COL.status] !== 'Open') return null

  const deadline = parseSourceDate(r[COL.closing])
  const where = [r[COL.entityCity], r[COL.entityProvince]].filter(Boolean).join(', ')
  const facts = [
    starList(r[COL.regionsOfDelivery]) ? `Delivery regions: ${starList(r[COL.regionsOfDelivery])}` : null,
    starList(r[COL.tradeAgreements]) ? `Trade agreements: ${starList(r[COL.tradeAgreements])}` : null,
  ].filter(Boolean).join('\n')
  // MERX-published notices carry their MERX link; CanadaBuys-native ones live at a stable notice page.
  const merx = trimOrNull(r[COL.url], 1000)
  const url = merx && merx.startsWith('https://') ? merx : `https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/${encodeURIComponent(externalId.toLowerCase())}`

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency: trimOrNull(r[COL.entity], 300) ?? 'Government of Canada',
    description: joinDescription(trimOrNull(r[COL.description], 7000), facts),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: trimOrNull(r[COL.noticeType], 120) ?? trimOrNull(r[COL.method], 120) ?? 'Tender Notice',
    solicitationNumber: trimOrNull(r[COL.solicitation], 120),
    postedDate: parseSourceDate(r[COL.published]),
    responseDeadline: deadline,
    placeOfPerformance: where ? `${where}, Canada` : 'Canada',
    estimatedValue: null,
    sourceUrl: url,
    sourceUpdatedAt: parseSourceDate(r[COL.amended]),
    sourceMetadata: {
      provider: 'canadabuys.canada.ca',
      category: categoryText(r[COL.category]),
      unspsc: starList(r[COL.unspscDescription]),
      procurementMethod: trimOrNull(r[COL.method], 200),
      contact: {
        name: trimOrNull(r[COL.contactName], 200),
        email: trimOrNull(r[COL.contactEmail], 200),
        phone: trimOrNull(r[COL.contactPhone], 60),
      },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(r[COL.entity])]),
  }
}

/** Parses the CSV (stripping the UTF-8 BOM) and orders rows newest first. */
function parseFile(text: string): Row[] {
  const rows = parseCsv(text.replace(/^﻿/, ''))
  return rows.sort((a, b) => (b[COL.published] ?? '').localeCompare(a[COL.published] ?? ''))
}

export const canadaBuysAdapter: SourceAdapter = {
  key: 'canada_buys',
  displayName: 'CanadaBuys Tenders',
  category: SourceCategory.COMMERCIAL,
  produces: 'OPPORTUNITY',
  supportsIncremental: false,
  pageSize: ROWS_PER_RUN,
  coverageNote:
    'Open tender notices of the Government of Canada (federal departments and Crown corporations) from the official CanadaBuys open-data file. Canadian and many international suppliers may bid under the listed trade agreements. Syncs up to configJson.maxRecords tenders (default 200), newest first.',

  configure(): ConfigureResult {
    return { state: 'READY' }
  },

  async fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult> {
    const baseUrl = String(env.baseUrl || env.config.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
    const cap = maxRecordsFor(env, DEFAULT_TARGET)
    const offset = startOffset(null, args.cursor, cap)

    let response
    try {
      response = await axios.get<string>(`${baseUrl}${FILE_PATH}`, { timeout: args.timeoutMs, responseType: 'text', transformResponse: (d) => d })
    } catch (err: unknown) {
      if ((err as { response?: { status?: number } })?.response?.status === 429) return { records: [], nextPageToken: null, rateLimited: true }
      throw err
    }

    const rows = parseFile(String(response.data ?? ''))
    const end = Math.min(rows.length, cap, offset + ROWS_PER_RUN)
    const slice = rows.slice(offset, end)
    const records = slice.map(normalizeRow).filter((r): r is NormalizedOpportunity => r !== null)
    // Whole file read in one request; the resume cursor carries a backfill into the next run.
    const done = end >= Math.min(rows.length, cap)
    return { records, nextPageToken: null, nextCursor: resumeCursor(done ? null : String(end)) }
  },
}

export const __testing = { normalizeRow, parseFile, starList, categoryText, COL }
