// =============================================================
// SubcontractContact service — perpetual POC directory capture + cleanup.
//
// Every subcontracting opportunity that carries a point-of-contact is
// upserted into subcontract_contacts (deduped per tenant) so the contact
// survives the 7-day purge of the opportunity itself. Operator-facing +
// internal analytics; never exposed on the client portal.
//
// Capture is best-effort by design: a failure here must never break a
// sync or a manual opportunity create, so captureContact() swallows its
// own errors (logs + returns null).
//
// Cleanup ("junk data as it ages"): pruneContacts() drops rows with
// nothing usable to contact immediately, and stale low-value rows
// (seen once, not seen in a long time) on demand. Called by the
// maintenance worker daily and by POST /subcontracting/contacts/prune.
// =============================================================

import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'

/** Default staleness threshold (months) for low-value contact pruning. */
export const DEFAULT_STALE_MONTHS = 18

export interface CapturableOpportunity {
  consultingFirmId: string
  primeContractor: string
  primeContractorUei?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  agency?: string | null
  naicsCode?: string | null
  setAside?: string | null
  sourceUrl?: string | null
  /**
   * Provenance of this sighting: 'sba_subnet' | 'sam_setaside' | 'manual'
   * | a published-directory key (see services/scw/primeDirectorySeed.ts).
   */
  source?: string | null
  opportunityId?: string | null
  opportunityTitle?: string | null
}

export interface PruneOptions {
  /** Restrict pruning to a single tenant. Omit to prune across all firms. */
  consultingFirmId?: string
  /** Explicit stale cutoff; rows last seen before this are stale-eligible. */
  staleCutoff?: Date
  /** Convenience: derive staleCutoff = now - staleMonths. Default 18. */
  staleMonths?: number
  /** Injected clock for tests. */
  now?: Date
}

export interface PruneResult {
  junkDeleted: number
  staleDeleted: number
}

// Conservative email shape check — good enough to flag obvious junk
// (missing @, no domain dot) without rejecting unusual-but-valid addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidEmail(email?: string | null): boolean {
  if (!email) return false
  return EMAIL_RE.test(email.trim())
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Per-tenant identity for a POC. Prefer a normalized email (the strongest
 * dedup signal); otherwise fall back to a "prime|name" slug. Returns null
 * when there is nothing to key on (no email and no name).
 */
export function normalizeDedupeKey(input: {
  contactEmail?: string | null
  primeContractor: string
  contactName?: string | null
}): string | null {
  const email = input.contactEmail?.trim().toLowerCase()
  if (email && isValidEmail(email)) return `email:${email}`

  const prime = slug(input.primeContractor || '')
  const name = slug(input.contactName || '')
  if (!name && !prime) return null
  if (!name) return null // a prime with no contact name is not a capturable POC
  return `name:${prime}|${name}`
}

/**
 * Upsert a POC into the perpetual directory. Idempotent per
 * (consultingFirmId, dedupeKey): first sighting creates the row, repeat
 * sightings bump lastSeenAt + timesSeen and backfill newly-known fields
 * (latest non-null wins). Returns { created } or null when there is
 * nothing to capture / on a swallowed error.
 */
export async function captureContact(
  opp: CapturableOpportunity
): Promise<{ created: boolean } | null> {
  try {
    const dedupeKey = normalizeDedupeKey({
      contactEmail: opp.contactEmail,
      primeContractor: opp.primeContractor,
      contactName: opp.contactName,
    })
    if (!dedupeKey) return null // no email and no usable name -> nothing to capture

    const hasValidEmail = isValidEmail(opp.contactEmail)
    const now = new Date()

    const result = await prisma.subcontractContact.upsert({
      where: {
        consultingFirmId_dedupeKey: {
          consultingFirmId: opp.consultingFirmId,
          dedupeKey,
        },
      },
      create: {
        consultingFirmId: opp.consultingFirmId,
        primeContractor: opp.primeContractor,
        primeContractorUei: opp.primeContractorUei ?? undefined,
        contactName: opp.contactName ?? undefined,
        contactEmail: opp.contactEmail ?? undefined,
        contactPhone: opp.contactPhone ?? undefined,
        agency: opp.agency ?? undefined,
        naicsCode: opp.naicsCode ?? undefined,
        setAside: opp.setAside ?? undefined,
        sourceUrl: opp.sourceUrl ?? undefined,
        source: opp.source ?? undefined,
        dedupeKey,
        hasValidEmail,
        firstSeenAt: now,
        createdAt: now,
        lastSeenAt: now,
        timesSeen: 1,
        lastOpportunityId: opp.opportunityId ?? undefined,
        lastOpportunityTitle: opp.opportunityTitle ?? undefined,
      },
      update: {
        // Latest non-null wins; `?? undefined` leaves a field unchanged
        // when the new sighting has nothing for it.
        primeContractorUei: opp.primeContractorUei ?? undefined,
        contactName: opp.contactName ?? undefined,
        contactEmail: opp.contactEmail ?? undefined,
        contactPhone: opp.contactPhone ?? undefined,
        agency: opp.agency ?? undefined,
        naicsCode: opp.naicsCode ?? undefined,
        setAside: opp.setAside ?? undefined,
        sourceUrl: opp.sourceUrl ?? undefined,
        source: opp.source ?? undefined,
        // Only ever upgrade hasValidEmail to true; never downgrade.
        hasValidEmail: hasValidEmail ? true : undefined,
        lastSeenAt: now,
        timesSeen: { increment: 1 },
        lastOpportunityId: opp.opportunityId ?? undefined,
        lastOpportunityTitle: opp.opportunityTitle ?? undefined,
      },
      select: { createdAt: true, lastSeenAt: true },
    })

    // created iff this upsert inserted the row: the create branch stamps
    // createdAt and lastSeenAt from the same JS `now`, so they are equal only
    // for a fresh insert (an update leaves createdAt at its original value).
    // Telemetry only; not load-bearing.
    const created = result.createdAt.getTime() === result.lastSeenAt.getTime()
    return { created }
  } catch (err) {
    logger.warn('captureContact failed (non-fatal)', {
      consultingFirmId: opp.consultingFirmId,
      primeContractor: opp.primeContractor,
      error: (err as Error).message,
    })
    return null
  }
}

/**
 * Remove junk and (optionally) stale low-value contacts.
 *   junk  = nothing usable to contact: no name AND (no email OR invalid email)
 *   stale = seen exactly once AND not seen since the stale cutoff
 */
export async function pruneContacts(opts: PruneOptions = {}): Promise<PruneResult> {
  const now = opts.now ?? new Date()
  const staleCutoff =
    opts.staleCutoff ??
    new Date(now.getTime() - (opts.staleMonths ?? DEFAULT_STALE_MONTHS) * 30 * 24 * 60 * 60 * 1000)

  const tenant = opts.consultingFirmId ? { consultingFirmId: opts.consultingFirmId } : {}

  // Junk: no contact name, and no valid email to reach them by.
  const junk = await prisma.subcontractContact.deleteMany({
    where: {
      ...tenant,
      AND: [
        { OR: [{ contactName: null }, { contactName: '' }] },
        { OR: [{ contactEmail: null }, { hasValidEmail: false }] },
      ],
    },
  })

  // Stale: only ever seen once and gone quiet past the cutoff.
  const stale = await prisma.subcontractContact.deleteMany({
    where: {
      ...tenant,
      timesSeen: { lte: 1 },
      lastSeenAt: { lt: staleCutoff },
    },
  })

  logger.info('pruneContacts complete', {
    consultingFirmId: opts.consultingFirmId ?? 'ALL',
    junkDeleted: junk.count,
    staleDeleted: stale.count,
    staleCutoff: staleCutoff.toISOString(),
  })

  return { junkDeleted: junk.count, staleDeleted: stale.count }
}
