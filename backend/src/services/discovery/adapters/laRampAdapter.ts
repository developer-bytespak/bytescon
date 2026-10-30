// =============================================================
// Los Angeles RAMP adapter (COMMERCIAL, US).
//
// Open bids from the City of Los Angeles' Regional Alliance Marketplace for
// Procurement (rampla.org), published on LA Open Data (Socrata, keyless):
//   GET {baseUrl}/resource/hf3r-utnq.json
// The dataset only carries bids that are open or amended, so no filter is
// needed. Built on the shared Socrata factory.
// =============================================================
import { parseSourceDate, trimOrNull, deriveDataQuality, NormalizedOpportunity } from '../sourceAdapter'
import { createSocrataTenderAdapter } from './socrataTenderAdapterFactory'

interface RampRow {
  rampid?: string
  title?: string
  stagename?: string
  category?: string
  type?: string
  bidpost?: string
  closedate?: string
  department?: string
  url?: { url?: string }
}

/** "RFP - Request For Proposal" → kept as is; RAMP's literal "None" means no type. */
function noticeType(type: string | undefined): string {
  const t = trimOrNull(type, 120)
  return t && t.toLowerCase() !== 'none' ? t : 'Solicitation'
}

function normalizeRow(r: RampRow): NormalizedOpportunity | null {
  const externalId = trimOrNull(r.rampid, 120)
  const title = trimOrNull(r.title, 500)
  if (!externalId || !title) return null

  const deadline = parseSourceDate(r.closedate)
  const department = trimOrNull(r.department, 300)
  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency: department ? `City of Los Angeles — ${department}` : 'City of Los Angeles',
    description: [
      r.category ? `Category: ${r.category}` : null,
      r.stagename === 'Amended' ? 'This bid has been amended — check RAMP for the latest addenda.' : null,
    ].filter(Boolean).join('\n') || null,
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: noticeType(r.type),
    solicitationNumber: externalId,
    postedDate: parseSourceDate(r.bidpost),
    responseDeadline: deadline,
    placeOfPerformance: 'Los Angeles, CA',
    estimatedValue: null,
    sourceUrl: trimOrNull(r.url?.url, 500) ?? 'https://www.rampla.org',
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'rampla.org',
      jurisdiction: 'Los Angeles, CA',
      category: r.category ?? null,
      stage: r.stagename ?? null,
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(department)]),
  }
}

export const laRampAdapter = createSocrataTenderAdapter<RampRow>({
  key: 'la_ramp',
  displayName: 'Los Angeles RAMP',
  defaultBaseUrl: 'https://data.lacity.org',
  dataset: 'hf3r-utnq',
  query: { $order: 'bidpost DESC, rampid' },
  coverageNote:
    'Open bids from City of Los Angeles departments on RAMP (rampla.org), via the LA Open Data feed. Open to any registered vendor — no SAM.gov registration needed. Covers City of LA only. Syncs up to configJson.maxRecords bids (default 300), newest first.',
  normalize: normalizeRow,
})

export const __testing = { normalizeRow, noticeType }
