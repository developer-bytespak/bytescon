// =============================================================
// §8.5 — Calendar synchronization.
//
// A PROJECTION of records that already exist, not a second calendar. The
// sources are the canonical deadline entities — OpportunityMilestone, CRM
// follow-ups, contract deliverables — and nothing here stores a date of its
// own. The ICS export keeps working exactly as before and remains the
// zero-configuration path for anyone who does not want to connect an account.
//
// DIRECTION IS ONE-WAY: Bytescon → external calendar. A solicitation deadline
// is a fact about a government notice; letting somebody drag the event in
// their own calendar and have that change the deadline the firm is working to
// would be a data-integrity failure wearing a convenience feature's clothes.
// An external edit is simply overwritten on the next sync.
//
// Duplication is prevented by IntegrationSyncRecord: one row per
// (connection, source record), carrying the provider's event id. A repeated
// sync updates that event; it never creates a second one.
// =============================================================
import { IntegrationProvider, IntegrationStatus } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { findConnection, readCredential, recordFailure, recordSuccess } from '../connectionService'
import { ConnectorError } from '../accounting/connector'
import { googleCalendarAdapter } from './google'
import { microsoftCalendarAdapter } from './microsoft'
import type { DecryptedCredential } from '../connectionService'

export interface CalendarEventInput {
  /** The canonical record this event projects. */
  sourceType: 'OpportunityMilestone' | 'CrmFollowUp' | 'ContractDeliverable'
  sourceId: string
  title: string
  description: string | null
  startAt: Date
  endAt: Date | null
  isAllDay: boolean
  /** Cancelled sources are removed from the calendar rather than left stale. */
  cancelled?: boolean
}

export interface CalendarAdapter {
  provider: IntegrationProvider
  createEvent(cred: DecryptedCredential, event: CalendarEventInput): Promise<{ externalId: string }>
  updateEvent(cred: DecryptedCredential, externalId: string, event: CalendarEventInput): Promise<void>
  deleteEvent(cred: DecryptedCredential, externalId: string): Promise<void>
  testConnection(cred: DecryptedCredential): Promise<{ ok: boolean; accountName?: string; detail: string }>
}

const ADAPTERS: Partial<Record<IntegrationProvider, CalendarAdapter>> = {
  GOOGLE_CALENDAR: googleCalendarAdapter,
  MICROSOFT_CALENDAR: microsoftCalendarAdapter,
}

export function calendarAdapterFor(provider: IntegrationProvider): CalendarAdapter | null {
  return ADAPTERS[provider] ?? null
}

/** Test seam — the suite drives the full lifecycle without a live account. */
export function __setCalendarAdapter(provider: IntegrationProvider, adapter: CalendarAdapter | null): void {
  if (adapter) ADAPTERS[provider] = adapter
  else delete ADAPTERS[provider]
}

export type CalendarSyncAction = 'CREATED' | 'UPDATED' | 'DELETED' | 'UNCHANGED' | 'SKIPPED' | 'FAILED'

export interface CalendarSyncOutcome {
  sourceId: string
  externalId: string | null
  action: CalendarSyncAction
  detail?: string
}

function fingerprint(event: CalendarEventInput): string {
  return [
    event.title, event.description ?? '', event.startAt.toISOString(),
    event.endAt?.toISOString() ?? '', String(event.isAllDay),
  ].join('|')
}

/**
 * Push one source record to the tenant's connected calendar.
 *
 * Reads the ledger first, so an unchanged record costs nothing and a changed
 * one updates the event it already made. The provider's event id lives only in
 * the ledger, so nothing about the source record has to change to support
 * this.
 */
export async function syncCalendarEvent(
  consultingFirmId: string, provider: IntegrationProvider, event: CalendarEventInput,
): Promise<CalendarSyncOutcome> {
  const connection = await findConnection(consultingFirmId, provider)
  if (!connection || connection.status !== IntegrationStatus.CONNECTED) {
    return { sourceId: event.sourceId, externalId: null, action: 'SKIPPED', detail: 'not connected' }
  }
  const adapter = calendarAdapterFor(provider)
  if (!adapter) {
    return { sourceId: event.sourceId, externalId: null, action: 'SKIPPED', detail: 'no adapter' }
  }

  const key = {
    connectionId_localType_localId: {
      connectionId: connection.id, localType: event.sourceType, localId: event.sourceId,
    },
  }
  const existing = await prisma.integrationSyncRecord.findUnique({ where: key })
  const credential = readCredential(connection)
  const hash = fingerprint(event)

  try {
    if (event.cancelled) {
      if (!existing) return { sourceId: event.sourceId, externalId: null, action: 'UNCHANGED' }
      await adapter.deleteEvent(credential, existing.externalId)
      await prisma.integrationSyncRecord.delete({ where: { id: existing.id } })
      await recordSuccess(connection.id)
      return { sourceId: event.sourceId, externalId: existing.externalId, action: 'DELETED' }
    }

    if (existing) {
      if (existing.payloadHash === hash) {
        return { sourceId: event.sourceId, externalId: existing.externalId, action: 'UNCHANGED' }
      }
      await adapter.updateEvent(credential, existing.externalId, event)
      await prisma.integrationSyncRecord.update({
        where: { id: existing.id }, data: { payloadHash: hash, lastSyncedAt: new Date(), lastError: null },
      })
      await recordSuccess(connection.id)
      return { sourceId: event.sourceId, externalId: existing.externalId, action: 'UPDATED' }
    }

    const created = await adapter.createEvent(credential, event)
    await prisma.integrationSyncRecord.create({
      data: {
        connectionId: connection.id, consultingFirmId,
        localType: event.sourceType, localId: event.sourceId,
        externalId: created.externalId, externalType: 'CalendarEvent',
        direction: 'EXPORT', payloadHash: hash, lastSyncedAt: new Date(),
      },
    })
    await recordSuccess(connection.id)
    return { sourceId: event.sourceId, externalId: created.externalId, action: 'CREATED' }
  } catch (err) {
    const message = err instanceof ConnectorError ? err.message : 'The calendar rejected the event.'
    await recordFailure(connection.id, message)
    return { sourceId: event.sourceId, externalId: null, action: 'FAILED', detail: message }
  }
}

/**
 * Project this firm's upcoming milestones onto its connected calendar.
 *
 * Reads OpportunityMilestone — the record the platform already keeps — rather
 * than any calendar-specific store.
 */
export async function syncFirmMilestones(
  consultingFirmId: string, provider: IntegrationProvider, limit = 200,
): Promise<CalendarSyncOutcome[]> {
  const milestones = await prisma.opportunityMilestone.findMany({
    where: { consultingFirmId, endAt: { not: null }, status: { not: 'CANCELLED' } },
    select: {
      id: true, title: true, description: true, startAt: true, endAt: true, isAllDay: true,
      opportunity: { select: { title: true, agency: true } },
    },
    orderBy: { endAt: 'asc' }, take: limit,
  })

  const outcomes: CalendarSyncOutcome[] = []
  for (const m of milestones) {
    const start = m.startAt ?? m.endAt
    if (!start) continue
    outcomes.push(await syncCalendarEvent(consultingFirmId, provider, {
      sourceType: 'OpportunityMilestone',
      sourceId: m.id,
      title: m.title,
      description: [m.description, m.opportunity ? `${m.opportunity.title} — ${m.opportunity.agency}` : null]
        .filter(Boolean).join('\n') || null,
      startAt: start,
      endAt: m.endAt,
      isAllDay: m.isAllDay,
    }))
  }
  logger.info('Calendar milestone sync complete', {
    consultingFirmId, provider, count: outcomes.length,
    created: outcomes.filter((o) => o.action === 'CREATED').length,
  })
  return outcomes
}
