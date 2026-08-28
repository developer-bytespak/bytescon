// Resolve the public source link for an opportunity — or null when no valid
// external link exists (Section 4 #2).
//
// Live SAM.gov postings carry a 32-char hex notice id; seeded demo rows use
// placeholder ids (null / "demo-*" / "scw-demo-*") whose /opp/<id>/view URL
// resolves to a 404. Rendering that broken link reads to a prospect as a broken
// product, so we return null and let the UI show a label instead.
//
// §6.1 added further ingestion sources. Each record links back to the system it
// was ingested from — never to SAM.gov, which does not hold it.

export interface SamLinkInput {
  isDemo?: boolean
  samNoticeId?: string | null
  sourceUrl?: string | null
  source?: string | null
}

const REAL_NOTICE_ID = /^[0-9a-f]{32}$/i

/** Hosts a source is known to publish a per-record page on. */
const KNOWN_RECORD_HOSTS: Record<string, string[]> = {
  GRANTS_GOV: ['https://www.grants.gov/', 'https://grants.gov/'],
}

/** Sources whose link target is whatever official feed the operator configured. */
const OPERATOR_CONFIGURED_SOURCES = ['STATE_LOCAL', 'SUBCONTRACTING_BOARD', 'CONTRACT_AWARDS', 'AGENCY_FORECAST']

const SOURCE_LABELS: Record<string, string> = {
  SAM_GOV: 'SAM.gov',
  GRANTS_GOV: 'Grants.gov',
  STATE_LOCAL: 'State / Local',
  SUBCONTRACTING_BOARD: 'Subcontracting board',
  CONTRACT_AWARDS: 'Contract awards',
  AGENCY_FORECAST: 'Agency forecast',
  USA_SPENDING: 'USASpending',
}

/** Display name of the system a record links back to. */
export function sourceLinkLabel(source?: string | null): string {
  return (source && SOURCE_LABELS[source]) || 'source'
}

export function resolveSourceUrl(opp: SamLinkInput): string | null {
  if (opp.isDemo) return null

  const url = opp.sourceUrl ?? null
  const source = opp.source ?? null

  if (source && KNOWN_RECORD_HOSTS[source]) {
    return url && KNOWN_RECORD_HOSTS[source].some((host) => url.startsWith(host)) ? url : null
  }

  // The operator configured the feed these came from, so its own link is trusted;
  // http is rejected so a record can never downgrade the user to an insecure page.
  if (source && OPERATOR_CONFIGURED_SOURCES.includes(source)) {
    return url && url.startsWith('https://') ? url : null
  }

  // SAM.gov (and any record with no source recorded). A real web-UI sam.gov URL
  // from the feed is authoritative; api.sam.gov URLs and anything else are rejected.
  const rawSourceUrl = url?.startsWith('https://sam.gov/') ? url : null
  if (rawSourceUrl) return rawSourceUrl
  if (opp.samNoticeId && REAL_NOTICE_ID.test(opp.samNoticeId)) {
    return `https://sam.gov/opp/${opp.samNoticeId}/view`
  }
  return null
}
