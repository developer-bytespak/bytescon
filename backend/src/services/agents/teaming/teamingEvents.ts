// =============================================================
// §7.5 — The four Teaming Agent triggers.
//
// All four are emitted through the §7.0 transactional outbox, inside the same
// transaction as the business write they describe. A rolled-back write emits
// nothing; a benign duplicate never rolls the business write back.
//
// PAYLOADS CARRY IDs AND STATUS ONLY. No recommendation text, no probability,
// no private note, no partner contact detail ever enters an AgentEvent — the
// handler re-reads what it needs under its own tenant scope.
// =============================================================
import type { Prisma } from '@prisma/client'
import { emitAgentEvent } from '../outbox'

export const BID_DECISION_RECORDED = 'BID_DECISION_RECORDED'
export const CAPABILITY_GAP_DETECTED = 'CAPABILITY_GAP_DETECTED'
export const PARTNER_ADDED = 'PARTNER_ADDED'
export const SUBCONTRACT_MILESTONE_DUE = 'SUBCONTRACT_MILESTONE_DUE'

export const PURSUIT_ENTITY_TYPE = 'BidPursuit'
export const OPPORTUNITY_ENTITY_TYPE = 'Opportunity'
export const PARTNER_ENTITY_TYPE = 'Partner'
export const SUBCONTRACTING_GOAL_ENTITY_TYPE = 'SubcontractingGoal'

/**
 * A HUMAN recorded a qualification decision.
 *
 * Emitted for every final decision, because the event is a statement of fact
 * that several agents consume. Whether a decision is worth acting on is each
 * handler's business: §7.5 acts on BID and deliberately does nothing on NO_BID.
 */
export function emitBidDecisionRecorded(
  args: {
    consultingFirmId: string
    pursuitId: string
    opportunityId: string
    decision: string
    isOverride: boolean
    /** Present so downstream audit can prove a person, not a system, decided. */
    decidedByUserId: string
  },
  tx: Prisma.TransactionClient,
): Promise<{ eventId: string | null; created: boolean }> {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: BID_DECISION_RECORDED,
      entityType: PURSUIT_ENTITY_TYPE,
      entityId: args.pursuitId,
      payload: {
        pursuitId: args.pursuitId,
        opportunityId: args.opportunityId,
        decision: args.decision,
        isOverride: args.isOverride,
        decidedByUserId: args.decidedByUserId,
      },
      // One event per decision write. A re-decision after reassessment is a new
      // fact and gets its own event via the timestamp in the key.
      dedupeKey: `bid-decision:${args.consultingFirmId}:${args.pursuitId}:${args.decision}:${Date.now()}`,
    },
    tx,
  )
}

/**
 * Did this gap snapshot become materially worse than the last one?
 *
 * Pure, so the rule is testable without a database. A gap set that is unchanged
 * — or that improved — emits nothing, which is what stops a daily re-assessment
 * from paging somebody every morning about the same gap.
 */
export function gapSnapshotWorsened(
  previous: { missingCapabilities: string[]; missingCertifications: string[]; missingEligibility: string[] } | null,
  next: { missingCapabilities: string[]; missingCertifications: string[]; missingEligibility: string[] },
): { worsened: boolean; newGaps: string[] } {
  const key = (s: { missingCapabilities: string[]; missingCertifications: string[]; missingEligibility: string[] }) =>
    new Set([
      ...s.missingCapabilities.map((v) => `capability:${v}`),
      ...s.missingCertifications.map((v) => `certification:${v}`),
      ...s.missingEligibility.map((v) => `eligibility:${v}`),
    ])

  const after = key(next)
  if (after.size === 0) return { worsened: false, newGaps: [] }

  const before = previous ? key(previous) : new Set<string>()
  const newGaps = [...after].filter((g) => !before.has(g)).sort()
  return { worsened: newGaps.length > 0, newGaps }
}

/**
 * A material NEW capability gap appeared for an opportunity.
 *
 * Only critical gap classes (certification and eligibility) or any genuinely
 * new missing capability qualify. The payload names the gap keys, never the
 * evidence behind them.
 */
export function emitCapabilityGapDetected(
  args: {
    consultingFirmId: string
    opportunityId: string
    newGaps: string[]
    criticalGapCount: number
  },
  tx: Prisma.TransactionClient,
): Promise<{ eventId: string | null; created: boolean }> {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: CAPABILITY_GAP_DETECTED,
      entityType: OPPORTUNITY_ENTITY_TYPE,
      entityId: args.opportunityId,
      payload: {
        opportunityId: args.opportunityId,
        newGaps: args.newGaps,
        criticalGapCount: args.criticalGapCount,
      },
      // Keyed on the gap set itself: the same unchanged gaps never re-fire, and
      // a genuinely different gap set does.
      dedupeKey: `capability-gap:${args.consultingFirmId}:${args.opportunityId}:${args.newGaps.join('|')}`,
    },
    tx,
  )
}

/**
 * A partner was added to a firm's private network.
 *
 * Being added establishes NOTHING: not verified, not eligible, not recommended.
 * The event exists so unresolved gaps can be re-evaluated against one more
 * candidate, and the payload says so explicitly.
 */
export function emitPartnerAdded(
  args: { consultingFirmId: string; partnerId: string },
  tx: Prisma.TransactionClient,
): Promise<{ eventId: string | null; created: boolean }> {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: PARTNER_ADDED,
      entityType: PARTNER_ENTITY_TYPE,
      entityId: args.partnerId,
      payload: {
        partnerId: args.partnerId,
        verified: false,
        eligible: false,
        recommended: false,
      },
      dedupeKey: `partner-added:${args.consultingFirmId}:${args.partnerId}`,
    },
    tx,
  )
}

/**
 * A tracked subcontracting obligation entered its due/risk window.
 *
 * Emitted from the goal-tracking path with a working-day figure the caller
 * computed from the shared calendar — never from naive calendar days, and never
 * from a second milestone engine.
 */
export function emitSubcontractMilestoneDue(
  args: {
    consultingFirmId: string
    goalId: string
    riskState: string
    workingDaysRemaining: number | null
    dueDateIso: string | null
  },
  tx: Prisma.TransactionClient,
): Promise<{ eventId: string | null; created: boolean }> {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: SUBCONTRACT_MILESTONE_DUE,
      entityType: SUBCONTRACTING_GOAL_ENTITY_TYPE,
      entityId: args.goalId,
      payload: {
        goalId: args.goalId,
        riskState: args.riskState,
        workingDaysRemaining: args.workingDaysRemaining,
        dueDate: args.dueDateIso,
      },
      // One event per goal per risk state: a goal that stays AT_RISK for a week
      // does not produce seven events.
      dedupeKey: `subcontract-milestone:${args.consultingFirmId}:${args.goalId}:${args.riskState}`,
    },
    tx,
  )
}
