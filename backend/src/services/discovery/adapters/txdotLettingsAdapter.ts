// =============================================================
// TxDOT lettings adapter (COMMERCIAL, US).
//
// Upcoming Texas Department of Transportation construction and maintenance
// lettings from the "Official and Unofficial Bid Items" dataset on Texas Open
// Data (Socrata, keyless): GET {baseUrl}/resource/qh8x-rm8r.json
// The dataset is one row per bid ITEM; the query groups items by controlling
// project (CCSJ) so each project becomes one opportunity. Built on the shared
// Socrata factory.
// =============================================================
import { parseSourceDate, parseSourceAmount, trimOrNull, deriveDataQuality, NormalizedOpportunity } from '../sourceAdapter'
import { createSocrataTenderAdapter } from './socrataTenderAdapterFactory'
import { valueLine } from './tenderFeedHelpers'

const LETTINGS_PAGE = 'https://www.txdot.gov/business/letting-bids/plans-online.html'

/** One row per project: per-project columns are constant across its items, so max() reads them. */
const QUERY = {
  $select: [
    'controlling_project_id_ccsj',
    'max(project_number) as project_number',
    'max(county) as county',
    'max(district_division) as district',
    'max(highway) as highway',
    'max(project_classification) as classification',
    'max(project_type) as project_type',
    'max(let_type) as let_type',
    'max(proposal_status) as proposal_status',
    'max(bid_recieved_until_date_and) as deadline',
    'max(project_approved_let_date) as let_date',
    'max(sealed_engineer_s_estimate) as estimate',
    'max(maximum_number_of_working) as working_days',
    'max(proposal_guarantee_amount) as guarantee',
    'count(*) as items',
  ].join(','),
  $group: 'controlling_project_id_ccsj',
  $order: 'deadline DESC, controlling_project_id_ccsj',
}

interface TxdotProjectRow {
  controlling_project_id_ccsj?: string
  project_number?: string
  county?: string
  district?: string
  highway?: string
  classification?: string
  project_type?: string
  let_type?: string
  proposal_status?: string
  deadline?: string
  let_date?: string
  estimate?: string
  working_days?: string
  guarantee?: string
  items?: string
}

function normalizeRow(r: TxdotProjectRow): NormalizedOpportunity | null {
  const externalId = trimOrNull(r.controlling_project_id_ccsj, 120)
  if (!externalId) return null

  const county = trimOrNull(r.county, 100)
  const highway = trimOrNull(r.highway, 100)
  const work = trimOrNull(r.classification, 200) ?? trimOrNull(r.project_type, 200) ?? 'Highway project'
  const where = [highway, county ? `${county} County` : null].filter(Boolean).join(', ')
  const title = where ? `${work} — ${where}` : work
  const deadline = parseSourceDate(r.deadline)
  const estimate = parseSourceAmount(r.estimate)
  const guarantee = parseSourceAmount(r.guarantee)
  const unofficial = r.proposal_status === 'Unofficial'

  return {
    kind: 'OPPORTUNITY',
    externalId,
    title: title.slice(0, 500),
    agency: 'Texas Department of Transportation',
    office: r.district ? `${r.district} District` : null,
    description: [
      `CCSJ ${externalId}${r.project_number ? ` · Project ${r.project_number}` : ''} · ${r.let_type ?? 'Letting'}`,
      valueLine(estimate, 'USD')?.replace('Estimated value', "Engineer's estimate") ?? null,
      guarantee != null ? `Proposal guarantee: ${guarantee.toLocaleString('en-US')} USD` : null,
      r.working_days ? `Working days: ${Number(r.working_days)}` : null,
      r.items ? `Bid items: ${r.items}` : null,
      unofficial ? 'Proposal is still UNOFFICIAL — confirm on ESBD before bidding. Bidders must be TxDOT-prequalified.' : 'Bidders must be TxDOT-prequalified.',
    ].filter(Boolean).join('\n'),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: 'Invitation for Bid',
    solicitationNumber: trimOrNull(r.project_number, 120) ?? externalId,
    postedDate: null,
    responseDeadline: deadline,
    placeOfPerformance: county ? `${county} County, TX` : 'Texas',
    estimatedValue: estimate,
    sourceUrl: LETTINGS_PAGE,
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'txdot.gov',
      jurisdiction: 'Texas',
      value: estimate,
      currency: estimate != null ? 'USD' : null,
      category: r.project_type ?? null,
      procurementMethod: r.let_type ?? null,
      proposalStatus: r.proposal_status ?? null,
      lettingDate: r.let_date ?? null,
      district: r.district ?? null,
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(county)]),
  }
}

export const txdotLettingsAdapter = createSocrataTenderAdapter<TxdotProjectRow>({
  key: 'txdot_lettings',
  displayName: 'TxDOT Lettings',
  defaultBaseUrl: 'https://data.texas.gov',
  dataset: 'qh8x-rm8r',
  query: QUERY,
  coverageNote:
    "Upcoming Texas Department of Transportation highway construction and maintenance lettings (statewide and local district), one opportunity per project with the sealed engineer's estimate. Bidders must be TxDOT-prequalified. Syncs up to configJson.maxRecords projects (default 300).",
  normalize: normalizeRow,
})

export const __testing = { normalizeRow, QUERY, LETTINGS_PAGE }
