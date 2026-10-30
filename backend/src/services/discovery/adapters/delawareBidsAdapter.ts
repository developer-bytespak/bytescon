// =============================================================
// Delaware Bids & Contracts adapter (COMMERCIAL, US).
//
// Open State of Delaware bids from the "Open Bids" dataset on Delaware Open
// Data (Socrata, keyless): GET {baseUrl}/resource/2hnj-zwix.json
// The dataset holds only open bids; each links to its mmp.delaware.gov page.
// Built on the shared Socrata factory.
// =============================================================
import { parseSourceDate, trimOrNull, deriveDataQuality, NormalizedOpportunity } from '../sourceAdapter'
import { createSocrataTenderAdapter } from './socrataTenderAdapterFactory'

interface DelawareRow {
  contractnumber?: string
  contracttitle?: string
  opendate?: string
  deadlinedate?: string
  agencycode?: string
  unspsc?: string
  bidurl?: { url?: string }
}

function normalizeRow(r: DelawareRow): NormalizedOpportunity | null {
  const externalId = trimOrNull(r.contractnumber, 120)
  const title = trimOrNull(r.contracttitle, 500)
  if (!externalId || !title) return null

  const deadline = parseSourceDate(r.deadlinedate)
  const agencyCode = trimOrNull(r.agencycode, 40)
  const unspsc = trimOrNull(r.unspsc, 200)
  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency: agencyCode ? `State of Delaware (${agencyCode})` : 'State of Delaware',
    description: unspsc ? `UNSPSC commodity codes: ${unspsc.split(';').join(', ')}` : null,
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: 'Solicitation',
    solicitationNumber: externalId,
    postedDate: parseSourceDate(r.opendate),
    responseDeadline: deadline,
    placeOfPerformance: 'Delaware',
    estimatedValue: null,
    sourceUrl: trimOrNull(r.bidurl?.url, 500) ?? 'https://mmp.delaware.gov/Bids/',
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'mmp.delaware.gov',
      jurisdiction: 'Delaware',
      agencyCode,
      unspsc,
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(agencyCode)]),
  }
}

export const delawareBidsAdapter = createSocrataTenderAdapter<DelawareRow>({
  key: 'delaware_bids',
  displayName: 'Delaware Bids & Contracts',
  defaultBaseUrl: 'https://data.delaware.gov',
  dataset: '2hnj-zwix',
  query: { $order: 'opendate DESC, contractnumber' },
  coverageNote:
    'Open State of Delaware bids (agencies, colleges, school districts) from the Delaware Open Data "Open Bids" feed, refreshed weekly by the state. Buyers are identified by agency code. Syncs up to configJson.maxRecords bids (default 300), newest first.',
  normalize: normalizeRow,
})

export const __testing = { normalizeRow }
