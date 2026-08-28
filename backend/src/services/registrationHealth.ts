// =============================================================
// Registration / Certification / Insurance health (Section 5 Module 2)
//
// Expiry status is COMPUTED from the record's expiry date + its reminder lead
// time, never stored — so it can never go stale. Pure + clock-injected so the
// classification and the "what's expiring" reminder set are deterministically
// unit-testable.
// =============================================================

export type ExpiryStatus = 'ACTIVE' | 'EXPIRING_SOON' | 'EXPIRED' | 'MISSING'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Classify a record by its expiry date relative to `now`:
 *   MISSING       — no expiry date recorded
 *   EXPIRED       — expiry date is in the past
 *   EXPIRING_SOON — expires within `leadDays`
 *   ACTIVE        — expires beyond the lead window
 */
export function classifyExpiry(
  expiryDate: Date | null | undefined,
  now: Date,
  leadDays: number,
): ExpiryStatus {
  if (!expiryDate) return 'MISSING'
  const diffMs = expiryDate.getTime() - now.getTime()
  if (diffMs < 0) return 'EXPIRED'
  if (diffMs <= Math.max(0, leadDays) * DAY_MS) return 'EXPIRING_SOON'
  return 'ACTIVE'
}

/** Whole days until expiry (negative if past); null when no date. */
export function daysUntil(expiryDate: Date | null | undefined, now: Date): number | null {
  if (!expiryDate) return null
  return Math.ceil((expiryDate.getTime() - now.getTime()) / DAY_MS)
}

export interface HealthItem {
  kind: 'SAM_REGISTRATION' | 'CERTIFICATION' | 'INSURANCE'
  id: string
  label: string
  expiryDate: Date | null
  status: ExpiryStatus
  daysUntil: number | null
  ownerUserId: string | null
}

export interface RegistrationHealth {
  summary: { active: number; expiringSoon: number; expired: number; missing: number; total: number }
  /** Items needing attention (EXPIRING_SOON or EXPIRED) — the in-app reminder set. */
  attention: HealthItem[]
  items: HealthItem[]
}

interface ProfileLike {
  samExpiryDate: Date | null
  reminderLeadDays: number
  ownerUserId: string | null
}
interface DatedRecord {
  id: string
  expiryDate: Date | null
  reminderLeadDays: number
  ownerUserId: string | null
}

/**
 * Build the whole-firm registration health view from the profile + active
 * (non-archived) certifications + insurance policies. Deterministic given `now`.
 */
export function buildRegistrationHealth(
  profile: ProfileLike | null,
  certifications: Array<DatedRecord & { name: string }>,
  policies: Array<DatedRecord & { policyType: string }>,
  now: Date,
): RegistrationHealth {
  const items: HealthItem[] = []

  if (profile) {
    items.push({
      kind: 'SAM_REGISTRATION',
      id: 'sam',
      label: 'SAM.gov registration',
      expiryDate: profile.samExpiryDate,
      status: classifyExpiry(profile.samExpiryDate, now, profile.reminderLeadDays),
      daysUntil: daysUntil(profile.samExpiryDate, now),
      ownerUserId: profile.ownerUserId,
    })
  }

  for (const c of certifications) {
    items.push({
      kind: 'CERTIFICATION',
      id: c.id,
      label: c.name,
      expiryDate: c.expiryDate,
      status: classifyExpiry(c.expiryDate, now, c.reminderLeadDays),
      daysUntil: daysUntil(c.expiryDate, now),
      ownerUserId: c.ownerUserId,
    })
  }

  for (const p of policies) {
    items.push({
      kind: 'INSURANCE',
      id: p.id,
      label: p.policyType,
      expiryDate: p.expiryDate,
      status: classifyExpiry(p.expiryDate, now, p.reminderLeadDays),
      daysUntil: daysUntil(p.expiryDate, now),
      ownerUserId: p.ownerUserId,
    })
  }

  const summary = {
    active: items.filter((i) => i.status === 'ACTIVE').length,
    expiringSoon: items.filter((i) => i.status === 'EXPIRING_SOON').length,
    expired: items.filter((i) => i.status === 'EXPIRED').length,
    missing: items.filter((i) => i.status === 'MISSING').length,
    total: items.length,
  }

  // Attention list: soonest-expiring first, expired at the very top.
  const attention = items
    .filter((i) => i.status === 'EXPIRING_SOON' || i.status === 'EXPIRED')
    .sort((a, b) => (a.daysUntil ?? 0) - (b.daysUntil ?? 0))

  return { summary, attention, items }
}
