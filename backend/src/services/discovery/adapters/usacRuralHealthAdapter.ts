// =============================================================
// USAC Rural Health Care adapter (COMMERCIAL, US).
//
// Rural US health care providers post FCC Form 461 / 465 requests for
// broadband and telecom services; any service provider can bid. Read from
// USAC Open Data (Socrata, keyless): GET {baseUrl}/resource/96rf-xd57.json
// ~92k posted service requests, newest first. Bids close at the posting end
// date. Built on the shared Socrata factory; backfills across sync runs.
// =============================================================
import { parseSourceDate, trimOrNull, deriveDataQuality, NormalizedOpportunity } from '../sourceAdapter'
import { createSocrataTenderAdapter } from './socrataTenderAdapterFactory'

const PROGRAMS: Record<string, string> = { HCF: 'Healthcare Connect Fund (Form 461)', Telecom: 'Telecommunications Program (Form 465)' }

interface RhcRow {
  program?: string
  application_number?: string
  funding_year?: string
  hcp_name?: string
  status?: string
  applicant_type?: string
  site_city?: string
  site_state?: string
  contact_first_name?: string
  contact_last_name?: string
  contact_phone?: string
  contact_email?: string
  posting_start_date?: string
  posting_end_date?: string
  allowable_contract_start_date?: string
  requested_contract_period?: string
  rfp_submitted?: string
  link_to_fcc_form_pdf?: string
}

function normalizeRow(r: RhcRow): NormalizedOpportunity | null {
  const externalId = trimOrNull(r.application_number, 120)
  const provider = trimOrNull(r.hcp_name, 300)
  if (!externalId || !provider) return null

  const deadline = parseSourceDate(r.posting_end_date)
  const place = [trimOrNull(r.site_city, 100), trimOrNull(r.site_state, 20)].filter(Boolean).join(', ')
  const program = PROGRAMS[r.program ?? ''] ?? trimOrNull(r.program, 120) ?? 'Rural Health Care'
  const contactName = [r.contact_first_name, r.contact_last_name].filter(Boolean).join(' ').trim() || null
  return {
    kind: 'OPPORTUNITY',
    externalId,
    title: `Broadband & telecom services for ${provider}`.slice(0, 500),
    agency: provider,
    office: program,
    description: [
      `Rural Health Care request ${externalId}${r.funding_year ? ` · Funding year ${r.funding_year}` : ''}`,
      `Program: ${program}`,
      r.requested_contract_period ? `Requested contract period: ${r.requested_contract_period} year(s)` : null,
      r.rfp_submitted === '1' ? 'An RFP is attached to the request.' : null,
      r.status ? `USAC status: ${r.status}` : null,
    ].filter(Boolean).join('\n'),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: r.program === 'Telecom' ? 'FCC Form 465' : 'FCC Form 461',
    solicitationNumber: externalId,
    postedDate: parseSourceDate(r.posting_start_date),
    responseDeadline: deadline,
    placeOfPerformance: place || null,
    estimatedValue: null,
    sourceUrl: trimOrNull(r.link_to_fcc_form_pdf, 500) ?? 'https://opendata.usac.org',
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'usac.org/rural-health-care',
      jurisdiction: trimOrNull(r.site_state, 20),
      fundingYear: r.funding_year ?? null,
      category: program,
      contact: { name: contactName, email: r.contact_email ?? null, phone: r.contact_phone ?? null },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(place)]),
  }
}

export const usacRuralHealthAdapter = createSocrataTenderAdapter<RhcRow>({
  key: 'usac_rural_health',
  displayName: 'USAC Rural Health Care (FCC Form 461/465)',
  defaultBaseUrl: 'https://datahub.usac.org',
  dataset: '96rf-xd57',
  query: { $order: 'posting_start_date DESC, application_number' },
  pageSize: 1000,
  defaultTarget: 100_000,
  coverageNote:
    'Rural US health care providers requesting bids for broadband and telecom services (FCC Forms 461 and 465), from USAC Open Data. Any service provider can bid — no SAM.gov registration. ~92k posted requests; most are past their posting window, the newest are open. Backfills up to configJson.maxRecords requests (default 100,000) across hourly runs, newest first.',
  normalize: normalizeRow,
})

export const __testing = { normalizeRow, PROGRAMS }
