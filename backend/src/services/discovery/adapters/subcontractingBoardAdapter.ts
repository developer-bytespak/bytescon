// =============================================================
// §6.1A — Subcontracting board adapter.
//
// Prime-contractor subcontracting boards publish opportunities through their
// own official feeds; there is no shared API. Each board an operator has
// legitimate, documented access to is configured as its own source row.
//
// Coverage is exactly the boards configured. The adapter makes no claim of
// broad subcontracting-board coverage, and it never scrapes a portal that does
// not publish an official feed.
// =============================================================
import { SourceCategory } from '@prisma/client'
import { createFeedAdapter } from './feedAdapterFactory'

export const subcontractingBoardAdapter = createFeedAdapter({
  key: 'subcontracting_board',
  displayName: 'Subcontracting Board Feed',
  category: SourceCategory.SUBCONTRACTING_BOARD,
  sourceLabel: 'subcontracting_board_feed',
  defaultNoticeType: 'Subcontracting Opportunity',
  coverageNote:
    'Reads one configured official prime-contractor subcontracting board feed (JSON or RSS) per source row. Coverage is limited to the boards you configure and have access to — no broad subcontracting-board coverage is claimed, and no portal is scraped.',
  notConfiguredReason:
    'No subcontracting board feed URL configured. Point this source at a board’s official JSON or RSS feed to enable it.',
})
