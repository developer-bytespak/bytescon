// =============================================================
// §7.2 — Opportunity domain events.
//
// Thin, typed wrappers over the §7.0 transactional outbox, following exactly the
// pattern §7.1 established. Each emitter takes a `Prisma.TransactionClient` so
// the event is written in the SAME transaction as the business mutation:
//
//   rolled-back domain write → zero AgentEvent
//   successful domain write  → exactly one AgentEvent
//   retried request          → no duplicate (dedupeKey is UNIQUE, and the
//                              outbox inserts with ON CONFLICT DO NOTHING so a
//                              benign duplicate cannot abort the caller's
//                              transaction — the §7.1 fix, preserved here)
//
// DEDUPE STRATEGY
// Capability and profile events key on a CONTENT FINGERPRINT of the fields that
// actually matter to matching and alerting. That gives the behaviour the brief
// asks for on both sides: a genuine material change fires a new event, while a
// no-op save or a retried request collapses onto the existing one. It is the
// same discipline §6.1G already uses for MonitoringProfileAlert.
// =============================================================
import { createHash } from 'crypto'
import type { Prisma } from '@prisma/client'
import { emitAgentEvent } from '../outbox'

export const SOURCE_SYNC_COMPLETED = 'SOURCE_SYNC_COMPLETED'
export const FIRM_CAPABILITY_CHANGED = 'FIRM_CAPABILITY_CHANGED'
export const MONITORING_PROFILE_SAVED = 'MONITORING_PROFILE_SAVED'
export const PURSUIT_STAGE_CHANGED = 'PURSUIT_STAGE_CHANGED'

export const OPPORTUNITY_EVENT_TYPES = [
  SOURCE_SYNC_COMPLETED,
  FIRM_CAPABILITY_CHANGED,
  MONITORING_PROFILE_SAVED,
  PURSUIT_STAGE_CHANGED,
] as const

/** Entity types the runtime uses to target an Opportunity Agent run. */
export const SOURCE_CONFIG_ENTITY_TYPE = 'OpportunitySourceConfig'
export const CAPABILITY_ENTITY_TYPE = 'FirmCapability'
export const PROFILE_ENTITY_TYPE = 'SavedMonitoringProfile'
export const PURSUIT_ENTITY_TYPE = 'BidPursuit'

function fingerprint(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

/**
 * A source sync finished successfully enough to produce valid downstream work.
 *
 * Emitted from the canonical Section 6 `runSourceSync`, never from a second sync
 * path. Only the identifiers and counters the agent actually needs travel in the
 * payload — a source's records are already persisted and must not be duplicated
 * into an event row.
 *
 * Deduped on the SourceSyncRun id, which is already unique per completed run, so
 * one completed sync can never produce two events.
 */
export function emitSourceSyncCompleted(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    sourceConfigId: string
    adapterKey: string
    category: string
    syncRunId: string
    status: string
    recordsCreated: number
    recordsUpdated: number
    recordsSkipped: number
    errorCount: number
    cursorAfter: string | null
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: SOURCE_SYNC_COMPLETED,
      entityType: SOURCE_CONFIG_ENTITY_TYPE,
      entityId: args.sourceConfigId,
      payload: {
        adapterKey: args.adapterKey,
        category: args.category,
        syncRunId: args.syncRunId,
        status: args.status,
        recordsCreated: args.recordsCreated,
        recordsUpdated: args.recordsUpdated,
        recordsSkipped: args.recordsSkipped,
        changedRecordCount: args.recordsCreated + args.recordsUpdated,
        errorCount: args.errorCount,
        cursorAfter: args.cursorAfter,
      },
      dedupeKey: `${SOURCE_SYNC_COMPLETED}:${args.consultingFirmId}:${args.syncRunId}`,
    },
    tx,
  )
}

/**
 * A capability was created, materially updated, verified or archived.
 *
 * The dedupe key fingerprints the fields matching actually reads, plus the
 * verification state. A rolled-back change emits nothing; a cosmetic re-save
 * collapses onto the existing event; changing the verification state fires a new
 * one because eligibility and match evidence both depend on it.
 *
 * The event records that verification CHANGED. It never implies the capability
 * is verified — only the human verify endpoint sets that.
 */
export function emitFirmCapabilityChanged(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    capabilityId: string
    changeType: 'CREATED' | 'UPDATED' | 'VERIFICATION_CHANGED' | 'ARCHIVED'
    material: {
      name: string
      keywords: string[]
      naicsCodes: string[]
      pscCodes: string[]
      geographies: string[]
      contractVehicles: string[]
      verification: string
      isArchived: boolean
    }
  },
) {
  const contentHash = fingerprint([
    args.material.name,
    [...args.material.keywords].sort(),
    [...args.material.naicsCodes].sort(),
    [...args.material.pscCodes].sort(),
    [...args.material.geographies].sort(),
    [...args.material.contractVehicles].sort(),
    args.material.verification,
    args.material.isArchived,
  ])

  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: FIRM_CAPABILITY_CHANGED,
      entityType: CAPABILITY_ENTITY_TYPE,
      entityId: args.capabilityId,
      payload: {
        changeType: args.changeType,
        verification: args.material.verification,
        isArchived: args.material.isArchived,
        contentHash,
      },
      dedupeKey: `${FIRM_CAPABILITY_CHANGED}:${args.consultingFirmId}:${args.capabilityId}:${contentHash}`,
    },
    tx,
  )
}

/**
 * A saved monitoring profile was created, materially updated or reactivated.
 *
 * Fingerprinted over the filters, cadence, priority and active/archived flags —
 * the inputs that decide what the profile matches and how loudly. Renaming a
 * profile alone does not warrant a fresh evaluation and does not fire a new
 * event.
 */
export function emitMonitoringProfileSaved(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    profileId: string
    changeType: 'CREATED' | 'UPDATED' | 'REACTIVATED'
    material: {
      filters: unknown
      alertFrequency: string
      priority: string
      isActive: boolean
      isArchived: boolean
      visibility: string
    }
  },
) {
  const contentHash = fingerprint([
    args.material.filters ?? {},
    args.material.alertFrequency,
    args.material.priority,
    args.material.isActive,
    args.material.isArchived,
    args.material.visibility,
  ])

  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: MONITORING_PROFILE_SAVED,
      entityType: PROFILE_ENTITY_TYPE,
      entityId: args.profileId,
      payload: {
        changeType: args.changeType,
        alertFrequency: args.material.alertFrequency,
        isActive: args.material.isActive,
        isArchived: args.material.isArchived,
        contentHash,
      },
      dedupeKey: `${MONITORING_PROFILE_SAVED}:${args.consultingFirmId}:${args.profileId}:${contentHash}`,
    },
    tx,
  )
}

/**
 * A pursuit moved through the capture lifecycle, or the firm declared a decision
 * on it.
 *
 * Emitted only from the canonical BidPursuit workflow, never inferred from
 * frontend state. This is the event that feeds the pursuit-learning loop, so it
 * carries the pursuit, the opportunity and both stages.
 *
 * Deduped per (pursuit, from→to). A retried request is absorbed; the learning
 * loop then recomputes from the pursuit's full current state rather than from
 * the event, so a collapsed duplicate can never skew the sample.
 */
export function emitPursuitStageChanged(
  tx: Prisma.TransactionClient,
  args: {
    consultingFirmId: string
    pursuitId: string
    opportunityId: string
    fromStage: string
    toStage: string
    /** Present when the transition came from a SUBMITTED/PASSED declaration. */
    declaredStatus?: string | null
  },
) {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: PURSUIT_STAGE_CHANGED,
      entityType: PURSUIT_ENTITY_TYPE,
      entityId: args.pursuitId,
      payload: {
        pursuitId: args.pursuitId,
        opportunityId: args.opportunityId,
        fromStage: args.fromStage,
        toStage: args.toStage,
        declaredStatus: args.declaredStatus ?? null,
      },
      dedupeKey: `${PURSUIT_STAGE_CHANGED}:${args.consultingFirmId}:${args.pursuitId}:${args.fromStage}->${args.toStage}`,
    },
    tx,
  )
}
