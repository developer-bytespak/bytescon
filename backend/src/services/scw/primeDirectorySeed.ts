// =============================================================
// Prime SBLO directory seeding — federal published POCs into the pool.
//
// DLA's subcontracting page publishes the contacts that administer prime
// subcontracting plans: its Strategic Subcontracting OEM POC spreadsheet
// and the DoD/DoW Prime Contractor Directory (Comprehensive Subcontracting
// Plan) it links to. Those primes are exactly who a small business asks
// for subcontract work, so the contacts belong in the same perpetual pool
// that opportunity-derived POCs land in (subcontract_contacts).
//
// The directory is a baked corpus (src/data/primeSbloDirectory.ts), not a
// live fetch — both publishers 403 non-browser clients. Seeding therefore
// costs no network I/O and is safe to run on every sync: captureContact()
// is an idempotent per-tenant upsert, so repeat runs bump timesSeen and
// backfill fields rather than duplicating rows.
//
// Directory rows carry no opportunity, so lastOpportunityId/Title stay
// null — that absence is how a standing directory contact is told apart
// from one captured off a specific solicitation (alongside `source`).
// =============================================================

import { PRIME_SBLO_DIRECTORY, PrimeSbloRecord } from '../../data/primeSbloDirectory'
import { captureContact, CapturableOpportunity } from './subcontractContacts'
import { logger } from '../../utils/logger'

export interface SeedDirectoryResult {
  attempted: number
  created: number
  merged: number
  skipped: number
}

export interface SeedDirectoryOptions {
  /** Restrict to specific source keys (e.g. ['dla_captains_of_industry']). */
  sourceKeys?: string[]
  /** Inject the corpus in tests. Defaults to the baked directory. */
  records?: PrimeSbloRecord[]
  /** Inject the capture function in tests. */
  capture?: typeof captureContact
}

/**
 * Map a published directory row onto the pool's capture DTO. Pure.
 *
 * `agency` carries the publishing agency (DLA / DOD) so directory contacts
 * filter alongside solicitation-derived ones in the existing agency facet.
 * NAICS and set-aside are absent from both source documents and are left
 * null rather than guessed.
 */
export function directoryRecordToCapturable(
  record: PrimeSbloRecord,
  consultingFirmId: string
): CapturableOpportunity {
  return {
    consultingFirmId,
    primeContractor: record.prime,
    contactName: record.pocName,
    contactEmail: record.email,
    contactPhone: record.phone,
    agency: record.agency,
    sourceUrl: record.sourceUrl,
    source: record.sourceKey,
  }
}

/**
 * Upsert every published directory POC into one tenant's contact pool.
 *
 * Best-effort like the rest of the capture path: captureContact swallows
 * its own errors, so a bad row degrades to `skipped` and never fails the
 * caller's sync.
 */
export async function seedPrimeDirectoryContacts(
  consultingFirmId: string,
  opts: SeedDirectoryOptions = {}
): Promise<SeedDirectoryResult> {
  const capture = opts.capture ?? captureContact
  const all = opts.records ?? PRIME_SBLO_DIRECTORY
  const records = opts.sourceKeys?.length
    ? all.filter((r) => opts.sourceKeys!.includes(r.sourceKey))
    : all

  const result: SeedDirectoryResult = { attempted: records.length, created: 0, merged: 0, skipped: 0 }

  for (const record of records) {
    const outcome = await capture(directoryRecordToCapturable(record, consultingFirmId))
    if (!outcome) result.skipped++
    else if (outcome.created) result.created++
    else result.merged++
  }

  logger.info('Prime SBLO directory seeded', { consultingFirmId, ...result })
  return result
}
