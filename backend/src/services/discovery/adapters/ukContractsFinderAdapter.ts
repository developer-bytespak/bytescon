// =============================================================
// UK Contracts Finder adapter (COMMERCIAL).
//
// Open UK public-sector tenders (mostly below the Find a Tender threshold)
// from the keyless Contracts Finder OCDS search API. Built on the shared OCDS
// tender factory; see ocdsTenderAdapterFactory.ts for paging and normalization.
// =============================================================
import {
  createOcdsTenderAdapter, normalizeOcdsRelease, readToken, resumeState, OcdsRelease, OcdsTenderSource,
} from './ocdsTenderAdapterFactory'

/** ocid "ocds-b5fd17-<notice guid>" → public notice page. */
function noticeUrl(ocid: string): string {
  const guid = ocid.replace(/^ocds-[a-z0-9]+-/i, '')
  return `https://www.contractsfinder.service.gov.uk/Notice/${encodeURIComponent(guid)}`
}

const SOURCE: OcdsTenderSource = {
  key: 'uk_contracts_finder',
  displayName: 'UK Contracts Finder',
  provider: 'contractsfinder.service.gov.uk',
  defaultBaseUrl: 'https://www.contractsfinder.service.gov.uk',
  searchPath: '/Published/Notices/OCDS/Search',
  cursorPrefix: 'uk:',
  coverageNote:
    'Open UK public-sector tenders from the public Contracts Finder OCDS API. Buyers are UK bodies; values are in GBP and are not converted. Syncs up to configJson.maxRecords tenders, newest first.',
  noticeUrl: (r) => (r.ocid ? noticeUrl(r.ocid) : null),
}

export const ukContractsFinderAdapter = createOcdsTenderAdapter(SOURCE)

export const __testing = {
  normalizeRelease: (r: OcdsRelease) => normalizeOcdsRelease(SOURCE, r),
  noticeUrl,
  readToken,
  resumeState: (cursor: string | null | undefined, cap: number) => resumeState(SOURCE.cursorPrefix, cursor, cap),
}
