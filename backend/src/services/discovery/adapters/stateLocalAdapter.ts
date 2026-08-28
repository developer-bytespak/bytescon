// =============================================================
// §6.1A — State / local procurement adapter.
//
// There is no national state-and-local procurement API. Each jurisdiction that
// publishes an official machine-readable bid feed (Open Data / CKAN / Socrata
// JSON, or an official RSS bid feed) is configured as its own source row.
//
// Coverage is exactly the jurisdictions an operator configures. This is stated
// in coverageNote and rendered verbatim in the UI, so the platform never
// implies universal state/local coverage.
// =============================================================
import { SourceCategory } from '@prisma/client'
import { createFeedAdapter } from './feedAdapterFactory'

export const stateLocalAdapter = createFeedAdapter({
  key: 'state_local',
  displayName: 'State / Local Procurement Feed',
  category: SourceCategory.STATE_LOCAL,
  sourceLabel: 'state_local_feed',
  defaultNoticeType: 'State/Local Solicitation',
  coverageNote:
    'Reads one configured official state or local procurement feed (Open Data JSON or official RSS) per source row. Coverage is limited to the jurisdictions you configure — this is not, and does not claim to be, national state and local coverage.',
  notConfiguredReason:
    'No state/local feed URL configured. Point this source at an official jurisdiction bid feed (Open Data JSON or RSS) to enable it.',
})
