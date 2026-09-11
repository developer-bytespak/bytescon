// =============================================================
// §6.1A — Civilian-program feed adapter.
//
// Public buying programs that are open to ordinary commercial vendors
// with no SAM.gov registration or federal contractor status — the
// canonical examples being USAC's E-Rate (FCC Form 470: schools and
// libraries requesting internet/IT services) and Rural Health Care
// (Forms 461/465) open-data feeds. Each program feed is one entry in
// configJson.feeds, exactly like the state/local adapter.
//
// Coverage is exactly the program feeds an operator configures; no
// broad "civilian marketplace" coverage is claimed.
// =============================================================
import { SourceCategory } from '@prisma/client'
import { createFeedAdapter } from './feedAdapterFactory'

export const civilianFeedAdapter = createFeedAdapter({
  key: 'civilian_feed',
  displayName: 'Civilian Program Feed',
  category: SourceCategory.CIVILIAN,
  sourceLabel: 'civilian_program_feed',
  defaultNoticeType: 'Civilian Program Request',
  coverageNote:
    'Reads configured official feeds of public buying programs that are open to commercial vendors without federal contractor registration (e.g. USAC E-Rate Form 470s, Rural Health Care service requests). Coverage is limited to the program feeds you configure — no broad civilian-market coverage is claimed.',
  notConfiguredReason:
    'No civilian program feed configured. Point this source at an official program feed (Open Data JSON or RSS) to enable it.',
})
