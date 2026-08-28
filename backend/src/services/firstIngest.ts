// =============================================================
// First-ingest ("starter board") for a brand-new firm
// -------------------------------------------------------------
// Triggered fire-and-forget at signup so a new firm sees recent SAM.gov
// opportunities the moment they log in — WITHOUT them having to connect their
// own SAM.gov API key.
//
// This MUST stay bounded: samApiService.searchAndIngest paginates until the
// date window is exhausted, so an unbounded first run for a firm with no
// lastIngestedAt would pull the entire year (hundreds of paged calls) and
// exhaust the shared SAM.gov daily rate-limit budget on a single signup. We
// pull a small, recent slice instead; the nightly delta worker and the firm's
// own NAICS profile refine it from there.
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { samApiService } from './samApi'
import { enqueueAllOpportunitiesForScoring } from '../workers/scoringWorker'

const STARTER_RECORD_CAP = 50
const STARTER_WINDOW_DAYS = 21

export async function runFirstIngest(consultingFirmId: string): Promise<void> {
  try {
    // Idempotency guard: only the very first ingest for a firm runs here, so
    // additional users verifying their email later never re-spend the shared
    // SAM.gov quota or duplicate the starter pull. lastIngestedAt is set by
    // searchAndIngest on completion, so once a firm has any ingest history we
    // skip.
    const firm = await prisma.consultingFirm.findUnique({
      where: { id: consultingFirmId },
      select: { lastIngestedAt: true },
    })
    if (!firm || firm.lastIngestedAt) {
      return
    }

    const sinceDate = new Date(Date.now() - STARTER_WINDOW_DAYS * 24 * 60 * 60 * 1000)

    const stats = await samApiService.searchAndIngest(
      { limit: STARTER_RECORD_CAP, maxRecords: STARTER_RECORD_CAP, sinceDate },
      consultingFirmId
    )

    // Enqueue scoring via the canonical helper. Scoring is per-client, and a
    // brand-new firm has no clients yet (they're added after first login), so
    // this is a clean no-op now and correctly scores the starter board later,
    // once the firm adds its first client. The opportunities themselves are
    // already visible — the board just isn't empty.
    const scoringJobsQueued = await enqueueAllOpportunitiesForScoring(consultingFirmId)

    logger.info('First ingest complete for new firm', {
      consultingFirmId,
      found: stats.found,
      ingested: stats.ingested,
      scoringJobsQueued,
    })
  } catch (err) {
    // Fire-and-forget: a starter-ingest failure must never surface to signup.
    // Missing SAM_API_KEY, a rate limit, or a network blip just means the board
    // fills on the next nightly sync instead.
    logger.warn('First ingest failed for new firm (non-fatal)', {
      consultingFirmId,
      error: (err as Error).message,
    })
  }
}
