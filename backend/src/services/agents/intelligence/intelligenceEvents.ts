// =============================================================
// §7.9 — Intelligence domain events.
//
// Two NEW emitters. The third trigger, CONTRACT_AWARDED, already exists from
// §7.1 with a real emitter on the contract-activation transition and is REUSED
// unchanged — adding a second emitter for the same fact would double-count
// every award.
//
// Both new emitters fire only when an AUTHORITATIVE business fact changes:
//   · SUBMISSION_OUTCOME_RECORDED — a person recorded the award result
//   · CALIBRATION_UPDATED — a calibration actually became the active one
//
// Neither can be produced by the Intelligence Agent: it records no outcome and
// fits no calibration. That is what stops the agent triggering itself into a
// loop over its own analysis.
// =============================================================
import type { Prisma, SubmissionOutcome } from '@prisma/client'
import { emitAgentEvent } from '../outbox'

export const SUBMISSION_OUTCOME_RECORDED = 'SUBMISSION_OUTCOME_RECORDED'
export const CALIBRATION_UPDATED = 'CALIBRATION_UPDATED'

/** Reused from §7.1. Declared here for the subscription list only. */
export const CONTRACT_AWARDED = 'CONTRACT_AWARDED'

export const INTELLIGENCE_EVENT_TYPES = [
  SUBMISSION_OUTCOME_RECORDED,
  CONTRACT_AWARDED,
  CALIBRATION_UPDATED,
] as const

export const SUBMISSION_ENTITY_TYPE = 'SubmissionRecord'
export const CALIBRATION_ENTITY_TYPE = 'TenantCalibration'

/**
 * Is this a real change to the recorded outcome?
 *
 * Pure, so the rule is testable without a database. Re-saving the same outcome
 * with different notes is not new information for the analysis; a correction
 * from WON to LOST very much is.
 */
export function isOutcomeChange(
  fromOutcome: SubmissionOutcome | null,
  toOutcome: SubmissionOutcome,
): boolean {
  return fromOutcome !== toOutcome
}

/**
 * A person recorded the result of a bid.
 *
 * Emitted from `PATCH /api/submissions/:id/outcome`, the single chokepoint
 * where an outcome is written, inside the same transaction as the write.
 *
 * Note this fires for a CORRECTION too, and it should: an outcome corrected
 * from WON to LOST changes the firm's measured win rate and the analysis must
 * be redone. What it does not fire on is a notes-only re-save.
 */
export function emitSubmissionOutcomeRecorded(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    submissionRecordId: string
    opportunityId: string
    fromOutcome: SubmissionOutcome | null
    toOutcome: SubmissionOutcome
    recordedByUserId: string | null
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: SUBMISSION_OUTCOME_RECORDED,
      entityType: SUBMISSION_ENTITY_TYPE,
      entityId: args.submissionRecordId,
      payload: {
        submissionRecordId: args.submissionRecordId,
        opportunityId: args.opportunityId,
        fromOutcome: args.fromOutcome,
        toOutcome: args.toOutcome,
        recordedByUserId: args.recordedByUserId,
      },
      // Keyed on the transition, so recording an outcome fires once and a
      // later correction to a different result fires once more.
      dedupeKey: `${SUBMISSION_OUTCOME_RECORDED}:${args.consultingFirmId}:${args.submissionRecordId}:${args.toOutcome}`,
    },
    tx,
  )
}

/**
 * A calibration became the firm's active one.
 *
 * Emitted from `activateCalibration` and `rollbackCalibration` — the only two
 * paths that change which calibration is ACTIVE. The nightly recalibration
 * worker produces DRAFT rows and activates nothing on its own, so it emits
 * nothing: a recalibration attempt that changed no active model is not news,
 * and firing on it would create the event storm §57 warns about.
 *
 * Calibration changes how a PREDICTION is interpreted. It never changes a
 * recorded win or loss — those are facts — so the analysis is refreshed but no
 * historical outcome is rewritten.
 */
export function emitCalibrationUpdated(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    calibrationId: string
    version: number
    previousCalibrationId: string | null
    reason: 'ACTIVATED' | 'ROLLED_BACK';
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: CALIBRATION_UPDATED,
      entityType: CALIBRATION_ENTITY_TYPE,
      entityId: args.calibrationId,
      payload: {
        calibrationId: args.calibrationId,
        version: args.version,
        previousCalibrationId: args.previousCalibrationId,
        reason: args.reason,
      },
      // Keyed on the calibration and the reason: activating version 3 fires
      // once, and rolling back to it later is a separate, real change.
      dedupeKey: `${CALIBRATION_UPDATED}:${args.consultingFirmId}:${args.calibrationId}:${args.reason}`,
    },
    tx,
  )
}
