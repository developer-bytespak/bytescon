// =============================================================
// §7.4 — Qualification domain events.
//
// ONE new emitter. The other three triggers already exist and are simply
// subscribed to:
//
//   PURSUIT_STAGE_CHANGED   §7.2 owns the emitter
//   EXTRACTION_COMPLETED    §7.3 owns the emitter
//   AMENDMENT_RECORDED      §7.3 owns the emitter
//
// Re-emitting any of those would duplicate work and double-fire every agent
// that listens, so this module deliberately contains only the one event nobody
// emits yet.
//
// Same transactional discipline as §7.1–§7.3: the emitter takes a
// `Prisma.TransactionClient` so the event shares the business write's
// transaction, and the outbox inserts with ON CONFLICT DO NOTHING so a benign
// duplicate cannot abort the caller's transaction.
// =============================================================
import type { Prisma } from '@prisma/client'
import { emitAgentEvent } from '../outbox'

export const OPPORTUNITY_MATCH_HIGH = 'OPPORTUNITY_MATCH_HIGH'

/** Entity type the runtime uses to target a qualification run. */
export const OPPORTUNITY_ENTITY_TYPE = 'Opportunity'

/**
 * A capability match CROSSED the high-match threshold.
 *
 * Fired on the transition only — a match that was already high and stays high
 * emits nothing, so a six-hourly match refresh does not re-trigger
 * qualification on an unchanged surface. The dedupe key additionally pins the
 * event to the (opportunity, score) pair, so even a flapping score cannot
 * produce two events for the same value.
 *
 * A HIGH MATCH MEANS "qualification analysis is warranted". It does not mean
 * bid, and it never moves a pursuit forward on its own.
 */
export function emitOpportunityMatchHigh(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    opportunityId: string
    overallScore: number
    previousScore: number | null
    threshold: number
    eligibility: string
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: OPPORTUNITY_MATCH_HIGH,
      entityType: OPPORTUNITY_ENTITY_TYPE,
      entityId: args.opportunityId,
      payload: {
        opportunityId: args.opportunityId,
        overallScore: args.overallScore,
        previousScore: args.previousScore,
        threshold: args.threshold,
        eligibility: args.eligibility,
      },
      dedupeKey: `${OPPORTUNITY_MATCH_HIGH}:${args.consultingFirmId}:${args.opportunityId}:${args.overallScore}`,
    },
    tx,
  )
}

/**
 * Whether this match refresh represents a CROSSING of the threshold.
 *
 * Pure so the rule is testable on its own: the previous score must be absent or
 * below the line, and the new score at or above it.
 */
export function crossedHighMatchThreshold(
  previousScore: number | null,
  newScore: number,
  threshold: number,
): boolean {
  if (newScore < threshold) return false
  return previousScore === null || previousScore < threshold
}
