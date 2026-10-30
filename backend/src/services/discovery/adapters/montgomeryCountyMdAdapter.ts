// =============================================================
// Montgomery County, MD solicitations adapter (COMMERCIAL, US).
//
// County solicitations from the "Solicitations" dataset on dataMontgomery
// (Socrata, keyless): GET {baseUrl}/resource/eeq6-nnwe.json?$where=status='Active'
// The dataset keeps seven years of history, so only Active rows are requested.
// Rows have no per-notice link; they point at the county's solicitations page.
// Built on the shared Socrata factory.
// =============================================================
import { parseSourceDate, trimOrNull, deriveDataQuality, NormalizedOpportunity } from '../sourceAdapter'
import { createSocrataTenderAdapter } from './socrataTenderAdapterFactory'

const SOLICITATIONS_PAGE = 'https://www.montgomerycountymd.gov/office-procurement/solicitations-contracts/formal-solicitations'
const WHERE = "status='Active'"

interface MontgomeryRow {
  status?: string
  type?: string
  number?: string
  description?: string
  issuancedate?: string
  closingdate?: string
  cancelledpostponed?: string
  construction?: string
  lsbrpindicator?: string
  buyer?: string
  department?: string
  deptcontact?: string
}

function normalizeRow(r: MontgomeryRow): NormalizedOpportunity | null {
  const externalId = trimOrNull(r.number, 120)
  const title = trimOrNull(r.description, 500)
  if (!externalId || !title) return null

  const deadline = parseSourceDate(r.closingdate)
  const department = trimOrNull(r.department, 300)
  const construction = r.construction === 'Y'
  const localSmallBusiness = r.lsbrpindicator === 'Y'
  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency: department ? `Montgomery County, MD — ${department}` : 'Montgomery County, MD',
    description: [
      construction ? 'Construction solicitation.' : null,
      localSmallBusiness ? 'Reserved for the Local Small Business Reserve Program (LSBRP).' : null,
      trimOrNull(r.cancelledpostponed, 300) ? `Status note: ${r.cancelledpostponed!.trim()}` : null,
      r.buyer ? `Buyer: ${r.buyer}` : null,
      r.deptcontact ? `Department contact: ${r.deptcontact}` : null,
    ].filter(Boolean).join('\n') || null,
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: trimOrNull(r.type, 120) ?? 'Solicitation',
    solicitationNumber: externalId,
    postedDate: parseSourceDate(r.issuancedate),
    responseDeadline: deadline,
    placeOfPerformance: 'Montgomery County, MD',
    estimatedValue: null,
    sourceUrl: SOLICITATIONS_PAGE,
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'montgomerycountymd.gov',
      jurisdiction: 'Montgomery County, MD',
      category: construction ? 'Construction' : null,
      localSmallBusinessReserve: localSmallBusiness,
      contact: { name: r.buyer ?? null, email: null, phone: null },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(department)]),
  }
}

export const montgomeryCountyMdAdapter = createSocrataTenderAdapter<MontgomeryRow>({
  key: 'montgomery_county_md',
  displayName: 'Montgomery County, MD Solicitations',
  defaultBaseUrl: 'https://data.montgomerycountymd.gov',
  dataset: 'eeq6-nnwe',
  query: { $where: WHERE, $order: 'issuancedate DESC, number' },
  coverageNote:
    'Active Montgomery County, Maryland solicitations (RFPs, IFBs) from the county open-data feed, updated daily. Covers county departments only. Syncs up to configJson.maxRecords solicitations (default 300), newest first.',
  normalize: normalizeRow,
})

export const __testing = { normalizeRow, WHERE, SOLICITATIONS_PAGE }
