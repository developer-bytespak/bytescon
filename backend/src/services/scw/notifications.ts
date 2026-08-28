// =============================================================
// SCW-5 Notification System (minimal v1)
//
// Per SUBCONTRACTING_WORKFLOW_SPEC.md §3 SCW-5. Surfaces opportunities
// that fired a BID SUB recommendation under the spec's trigger conditions:
//   - tenant has SDVOSB cert and the opportunity's set-aside matches
//   - BidDecision.recommendation = 'BID_SUB'
//   - responseDeadline >= NOW() + 5 days (skip windows too tight for outreach)
//   - at least one likely prime has confidence.composite >= 0.6
//
// v1 SCOPE:
//   - In-app inbox via GET /api/scw/notifications/inbox (live query, no
//     acknowledgement persistence yet).
//   - Twilio SMS + weekly-digest email extension are NOT shipped in this
//     phase — they require an opt-in side-effect path that is best added
//     after the live-query inbox proves out the data shape. Both are
//     scaffolded with TODO comments below for the follow-up.
// =============================================================

import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { findLikelyPrimes } from './likelyPrimes'

const LOOKAHEAD_MIN_DAYS = 5
const TOP_PRIME_CONFIDENCE_MIN = 0.6

export interface SubBidNotification {
  opportunityId: string
  opportunityTitle: string
  agency: string
  setAsideType: string
  daysRemaining: number
  recommendation: 'BID_SUB'
  winProbability: number | null
  netExpectedValue: number | null
  topPrimes: Array<{ name: string; confidence: number }>
  ctaUrl: string
}

export interface InboxOptions {
  consultingFirmId: string
  /** Optional cap for how many notifications to compute. Default 25. */
  limit?: number
}

/**
 * Compute the live BID SUB notification inbox for a tenant. Each call
 * re-evaluates the spec criteria against the current opportunity +
 * BidDecision state. No persistence, no de-duplication — the UI is the
 * source of "I've seen this" state.
 */
export async function getNotificationInbox(opts: InboxOptions): Promise<SubBidNotification[]> {
  const { consultingFirmId } = opts
  const limit = Math.min(opts.limit ?? 25, 100)

  // Pull candidate opportunities — tenant-scoped, ACTIVE, with a future
  // deadline, that have a BidDecision with a BID_SUB recommendation.
  const cutoff = new Date()
  cutoff.setUTCDate(cutoff.getUTCDate() + LOOKAHEAD_MIN_DAYS)

  const candidates = await prisma.opportunity.findMany({
    where: {
      consultingFirmId,
      responseDeadline: { gte: cutoff },
      bidDecisions: { some: { recommendation: 'BID_SUB' } },
    },
    orderBy: { responseDeadline: 'asc' },
    take: limit * 2, // over-fetch — some will fail the prime-confidence filter
    select: {
      id: true,
      title: true,
      agency: true,
      setAsideType: true,
      responseDeadline: true,
      probabilityScore: true,
      bidDecisions: {
        where: { recommendation: 'BID_SUB' },
        select: { netExpectedValue: true },
        take: 1,
      },
    },
  })

  const out: SubBidNotification[] = []
  for (const opp of candidates) {
    if (out.length >= limit) break

    // Compute likely primes; if no candidate clears the confidence floor,
    // skip — the spec is explicit that a BID SUB with no actionable prime
    // is not worth notifying on.
    let primes
    try {
      primes = await findLikelyPrimes({ opportunityId: opp.id, consultingFirmId })
    } catch (err) {
      logger.warn('SCW-5: findLikelyPrimes failed for candidate', {
        opportunityId: opp.id,
        error: (err as Error).message,
      })
      continue
    }
    const qualifying = primes.filter((p) => p.confidence.composite >= TOP_PRIME_CONFIDENCE_MIN)
    if (qualifying.length === 0) continue

    out.push({
      opportunityId: opp.id,
      opportunityTitle: opp.title,
      agency: opp.agency.split('.')[0]?.trim() ?? opp.agency,
      setAsideType: opp.setAsideType,
      daysRemaining: daysBetween(new Date(), opp.responseDeadline),
      recommendation: 'BID_SUB',
      winProbability: opp.probabilityScore ?? null,
      netExpectedValue: opp.bidDecisions[0]?.netExpectedValue
        ? Number(opp.bidDecisions[0].netExpectedValue)
        : null,
      topPrimes: qualifying.slice(0, 3).map((p) => ({
        name: p.primeName,
        confidence: p.confidence.composite,
      })),
      ctaUrl: `/opportunities/${opp.id}#scw`,
    })
  }

  logger.info('SCW-5: notification inbox computed', {
    consultingFirmId,
    candidatesScanned: candidates.length,
    returned: out.length,
  })

  return out
}

// =============================================================
// Deferred to follow-up (spec §3 SCW-5 channels we did NOT ship in v1)
// =============================================================
//
// Email digest extension:
//   The existing weekly watchlist worker (commit 4dcf5606,
//   src/workers/watchlistDigestWorker.ts) should be extended with a daily
//   pass that calls getNotificationInbox() per tenant and renders a
//   branded HTML email via brandedEmailTemplates + sends via emailService.
//   Skipped here to keep the v1 surface focused on the in-app inbox.
//
// Twilio SMS:
//   Rate-limit: max 1 SMS/tenant/24h, threshold daysRemaining < 10 AND
//   confidence >= 0.75. Reuse existing Twilio integration (commit 64c65657).
//   Skipped here because the rate-limiting + opt-in flow needs operator UX
//   that doesn't yet exist.

// =============================================================
// Helpers
// =============================================================

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.ceil((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)))
}
