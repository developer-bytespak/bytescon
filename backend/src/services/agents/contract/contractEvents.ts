// =============================================================
// §7.1 — Contract domain events.
//
// Thin, typed wrappers over the §7.0 transactional outbox. Each emitter takes a
// `Prisma.TransactionClient` so the event is written in the SAME transaction as
// the business mutation:
//
//   rolled-back domain write → zero AgentEvent
//   successful domain write  → exactly one AgentEvent
//   retried request          → no duplicate (dedupeKey is UNIQUE)
//
// Every event carries entityType 'Contract' + the contract id, so the resulting
// run targets that one contract instead of rescanning the tenant. The
// deliverable/modification/funding ids travel in the payload.
//
// Only the four events this slice needs are wired. The §7.1 brief is explicit:
// do not retrofit every possible contract event.
// =============================================================
import type { Prisma } from '@prisma/client'
import { emitAgentEvent } from '../outbox'
import { CONTRACT_ENTITY_TYPE } from './contractAdministrationHandler'

export const CONTRACT_AWARDED = 'CONTRACT_AWARDED'
export const CONTRACT_MODIFICATION_ADDED = 'CONTRACT_MODIFICATION_ADDED'
export const DELIVERABLE_STATUS_CHANGED = 'DELIVERABLE_STATUS_CHANGED'
export const FUNDING_TRANSACTION_ADDED = 'FUNDING_TRANSACTION_ADDED'

export const CONTRACT_EVENT_TYPES = [
  CONTRACT_AWARDED,
  CONTRACT_MODIFICATION_ADDED,
  DELIVERABLE_STATUS_CHANGED,
  FUNDING_TRANSACTION_ADDED,
] as const

/**
 * A contract became live.
 *
 * There is no separate AWARDED state in the Section 5 model — a contract is
 * DRAFT until it is set ACTIVE — so ACTIVE is the canonical award/activation
 * transition and no second state is invented. Deduped on the contract id, so a
 * contract that is deactivated and reactivated does not re-fire.
 */
export function emitContractAwarded(
  tx: Prisma.TransactionClient,
  args: { consultingFirmId: string; contractId: string; contractNumber: string },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: CONTRACT_AWARDED,
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: args.contractId,
      payload: { contractNumber: args.contractNumber },
      dedupeKey: `${CONTRACT_AWARDED}:${args.consultingFirmId}:${args.contractId}`,
    },
    tx,
  )
}

/**
 * A modification was recorded, or an existing one was applied.
 *
 * `stage` keeps the two moments distinct in the dedupe key: recording a
 * modification and applying it are both material changes that should refresh
 * contract health, but neither should re-fire on retry.
 */
export function emitContractModificationAdded(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    contractId: string
    modificationId: string
    modNumber: string
    stage: 'CREATED' | 'APPLIED'
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: CONTRACT_MODIFICATION_ADDED,
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: args.contractId,
      payload: { modificationId: args.modificationId, modNumber: args.modNumber, stage: args.stage },
      dedupeKey: `${CONTRACT_MODIFICATION_ADDED}:${args.consultingFirmId}:${args.modificationId}:${args.stage}`,
    },
    tx,
  )
}

/**
 * A deliverable moved workflow state.
 *
 * Emitted from the authoritative transition/submit/accept/reject paths, never
 * from UI state. Deduped per (deliverable, from→to) so a genuine later
 * transition still fires while a retried request does not.
 */
export function emitDeliverableStatusChanged(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    contractId: string
    deliverableId: string
    fromStatus: string
    toStatus: string
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: DELIVERABLE_STATUS_CHANGED,
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: args.contractId,
      payload: {
        deliverableId: args.deliverableId,
        fromStatus: args.fromStatus,
        toStatus: args.toStatus,
      },
      dedupeKey: `${DELIVERABLE_STATUS_CHANGED}:${args.consultingFirmId}:${args.deliverableId}:${args.fromStatus}->${args.toStatus}`,
    },
    tx,
  )
}

/**
 * A funding ledger entry was written. Deduped on the transaction id, which is
 * already unique per successful ledger write.
 */
export function emitFundingTransactionAdded(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    contractId: string
    fundingTransactionId: string
    type: string
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: FUNDING_TRANSACTION_ADDED,
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: args.contractId,
      payload: { fundingTransactionId: args.fundingTransactionId, type: args.type },
      dedupeKey: `${FUNDING_TRANSACTION_ADDED}:${args.consultingFirmId}:${args.fundingTransactionId}`,
    },
    tx,
  )
}
