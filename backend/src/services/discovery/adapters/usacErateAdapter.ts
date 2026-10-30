// =============================================================
// USAC E-Rate FCC Form 470 adapter (COMMERCIAL, US).
//
// US schools and libraries post an FCC Form 470 to open competitive bidding
// for internet, network and Wi-Fi services; any vendor with an FCC SPIN can
// bid, no SAM.gov registration needed. Read from USAC Open Data (Socrata,
// keyless): GET {baseUrl}/resource/jp7a-89nd.json?$where=f470_status='Certified'
// ~280k certified forms since 2016, newest first. Bids are accepted until the
// allowable contract date (28+ days after posting), which is the deadline here.
// Built on the shared Socrata factory; backfills across sync runs.
// =============================================================
import { parseSourceDate, trimOrNull, deriveDataQuality, NormalizedOpportunity } from '../sourceAdapter'
import { createSocrataTenderAdapter } from './socrataTenderAdapterFactory'
import { joinDescription } from './tenderFeedHelpers'

const WHERE = "f470_status='Certified'"
const FIELDS = [
  'application_number', 'form_nickname', 'f470_number', 'funding_year', 'allowable_contract_date', 'certified_datetime',
  'last_modified_datetime', 'billed_entity_name', 'applicant_type', 'billed_entity_city', 'billed_entity_state',
  'contact_name', 'contact_email', 'contact_phone', 'category_one_description', 'category_two_description',
  'rfp_identifier', 'number_of_eligible_entities',
]

interface Form470Row {
  application_number?: string
  form_nickname?: string
  f470_number?: { url?: string }
  funding_year?: string
  allowable_contract_date?: string
  certified_datetime?: string
  last_modified_datetime?: string
  billed_entity_name?: string
  applicant_type?: string
  billed_entity_city?: string
  billed_entity_state?: string
  contact_name?: string
  contact_email?: string
  contact_phone?: string
  category_one_description?: string
  category_two_description?: string
  rfp_identifier?: string
  number_of_eligible_entities?: string
}

function normalizeRow(r: Form470Row): NormalizedOpportunity | null {
  const externalId = trimOrNull(r.application_number, 120)
  const applicant = trimOrNull(r.billed_entity_name, 300)
  if (!externalId || !applicant) return null

  const deadline = parseSourceDate(r.allowable_contract_date)
  const place = [trimOrNull(r.billed_entity_city, 100), trimOrNull(r.billed_entity_state, 20)].filter(Boolean).join(', ')
  const categories = [r.category_one_description ? 'Category 1 (internet & data transmission)' : null, r.category_two_description ? 'Category 2 (internal connections, Wi-Fi)' : null].filter(Boolean)
  return {
    kind: 'OPPORTUNITY',
    externalId,
    title: (trimOrNull(r.form_nickname, 500) ?? `E-Rate services for ${applicant}`).slice(0, 500),
    agency: applicant,
    office: trimOrNull(r.applicant_type, 120),
    description: joinDescription(
      [
        `E-Rate FCC Form 470 #${externalId}${r.funding_year ? ` · Funding year ${r.funding_year}` : ''}`,
        categories.length ? `Services: ${categories.join('; ')}` : null,
        r.number_of_eligible_entities ? `Eligible entities: ${Number(r.number_of_eligible_entities)}` : null,
        'Bidders need an FCC Service Provider ID (SPIN / Form 498).',
      ].filter(Boolean).join('\n'),
      r.category_one_description,
      r.category_two_description,
    ),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: 'FCC Form 470',
    solicitationNumber: trimOrNull(r.rfp_identifier, 120) ?? externalId,
    postedDate: parseSourceDate(r.certified_datetime),
    responseDeadline: deadline,
    placeOfPerformance: place || null,
    estimatedValue: null,
    sourceUrl: trimOrNull(r.f470_number?.url, 500) ?? 'https://opendata.usac.org',
    sourceUpdatedAt: parseSourceDate(r.last_modified_datetime),
    sourceMetadata: {
      provider: 'usac.org/e-rate',
      jurisdiction: trimOrNull(r.billed_entity_state, 20),
      fundingYear: r.funding_year ?? null,
      category: categories.join('; ') || null,
      contact: { name: r.contact_name ?? null, email: r.contact_email ?? null, phone: r.contact_phone ?? null },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(place)]),
  }
}

export const usacErateAdapter = createSocrataTenderAdapter<Form470Row>({
  key: 'usac_erate',
  displayName: 'USAC E-Rate (FCC Form 470)',
  defaultBaseUrl: 'https://datahub.usac.org',
  dataset: 'jp7a-89nd',
  query: { $select: FIELDS.join(','), $where: WHERE, $order: 'certified_datetime DESC, application_number' },
  pageSize: 1000,
  defaultTarget: 150_000,
  coverageNote:
    'US schools and libraries requesting bids for internet, network and Wi-Fi services under the federal E-Rate program (FCC Form 470), from USAC Open Data. Any vendor with an FCC SPIN can bid — no SAM.gov registration. ~280k certified forms since 2016; most are past their bid window, the newest are open. Backfills up to configJson.maxRecords forms (default 150,000) across hourly runs, newest first.',
  normalize: normalizeRow,
})

export const __testing = { normalizeRow, WHERE }
