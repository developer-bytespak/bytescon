// =============================================================
// UK Find a Tender adapter (COMMERCIAL).
//
// Find a Tender (FTS) is the UK's service for higher-value public tenders —
// NHS trusts, universities, councils, airports — published as OCDS release
// packages by the keyless API:
//   GET {baseUrl}/api/1.0/ocdsReleasePackages?stages=tender&limit=
// A release id ("103248-2026") is the FTS notice id, whose public page is
// /Notice/<id>. Built on the shared OCDS tender factory.
// =============================================================
import { createOcdsTenderAdapter, normalizeOcdsRelease, OcdsRelease, OcdsTenderSource } from './ocdsTenderAdapterFactory'

const NOTICE_ID = /^\d{6}-\d{4}$/

const SOURCE: OcdsTenderSource = {
  key: 'uk_find_a_tender',
  displayName: 'UK Find a Tender',
  provider: 'find-tender.service.gov.uk',
  defaultBaseUrl: 'https://www.find-tender.service.gov.uk',
  searchPath: '/api/1.0/ocdsReleasePackages',
  cursorPrefix: 'fts:',
  defaultTarget: 200,
  coverageNote:
    'Higher-value UK public tenders (NHS, universities, councils and other public bodies) from the public Find a Tender OCDS API. Values are in GBP and are not converted. Syncs up to configJson.maxRecords tenders (default 200), newest first.',
  noticeUrl: (r) => (r.id && NOTICE_ID.test(r.id) ? `https://www.find-tender.service.gov.uk/Notice/${r.id}` : null),
}

export const ukFindATenderAdapter = createOcdsTenderAdapter(SOURCE)

export const __testing = {
  normalizeRelease: (r: OcdsRelease) => normalizeOcdsRelease(SOURCE, r),
  noticeUrl: SOURCE.noticeUrl,
}
