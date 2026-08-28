// =============================================================
// GB-104 Recipient Email Resolver
//
// Pure logic that turns the enrichment layer's cached contacts into a
// single best-available recipient email + a verification status that
// gates auto-send. No DB, no env, no network — so the composer's
// recipient behavior is unit-testable without an LLM round-trip.
//
// Auto-send rule (GB-104 resolved input): only `verified` addresses may
// auto-send. `probable`/`unknown` are surfaced with a flag and require
// explicit human confirmation. Missing email -> the draft ships in an
// explicit "recipient email missing" state rather than failing.
// =============================================================

import { EmailVerificationStatus } from '@prisma/client'
import { config } from '../../config/config'
import type { ContactRow } from '../contactProviders'

export interface ResolvedRecipient {
  email: string | null
  status: EmailVerificationStatus
  /** Provider/source tag for the chosen contact, e.g. 'sam.gov'. */
  source: string | null
  /** Display name of the chosen contact, when known. */
  contactName: string | null
}

const STATUS_RANK: Record<EmailVerificationStatus, number> = {
  [EmailVerificationStatus.verified]: 2,
  [EmailVerificationStatus.probable]: 1,
  [EmailVerificationStatus.unknown]: 0,
}

function toStatus(row: ContactRow): EmailVerificationStatus {
  if (!row.email) return EmailVerificationStatus.unknown
  switch (row.verificationStatus) {
    case 'verified':
      return EmailVerificationStatus.verified
    case 'unknown':
      return EmailVerificationStatus.unknown
    case 'probable':
    default:
      // An email from a provider with no explicit status is, at best,
      // probable — never silently treated as verified.
      return EmailVerificationStatus.probable
  }
}

/**
 * Pick the best-available recipient from the enrichment contacts.
 * Ranking: highest verification status first, then contacts that also
 * carry a name (more actionable). Returns the explicit "missing" shape
 * (email null, status unknown) when no contact has an email.
 */
export function resolveRecipientEmail(contacts: ContactRow[]): ResolvedRecipient {
  const withEmail = contacts.filter((c) => c.email && c.email.includes('@'))
  if (withEmail.length === 0) {
    return { email: null, status: EmailVerificationStatus.unknown, source: null, contactName: null }
  }

  const best = withEmail
    .map((c) => ({ row: c, status: toStatus(c) }))
    .sort((a, b) => {
      const byStatus = STATUS_RANK[b.status] - STATUS_RANK[a.status]
      if (byStatus !== 0) return byStatus
      // Prefer a named contact when status ties.
      return Number(Boolean(b.row.name)) - Number(Boolean(a.row.name))
    })[0]

  return {
    email: best.row.email,
    status: best.status,
    source: best.row.source ?? null,
    contactName: best.row.name ?? null,
  }
}

/**
 * Auto-send is permitted only for `verified` recipients. Everything else
 * is held for explicit confirmation (deliverability / wrong-recipient
 * safeguard, retained regardless of contact-source clearance).
 */
export function canAutoSend(status: EmailVerificationStatus): boolean {
  return status === EmailVerificationStatus.verified
}

/** GB-104 feature gate. Default off — composer keeps prior behavior. */
export function isEmailEnrichmentEnabled(): boolean {
  const raw = (process.env.SCW_EMAIL_ENRICHMENT_ENABLED || '').toLowerCase().trim()
  return raw === '1' || raw === 'true' || raw === 'yes'
}
