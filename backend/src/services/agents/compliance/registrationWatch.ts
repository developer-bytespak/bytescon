// =============================================================
// §7.3 — Registration, certification, insurance and bonding watch.
//
// ENTIRELY DETERMINISTIC. No LLM, no provider call, no inference. Everything
// here is computed from structured platform records the firm maintains, so it
// works identically with or without an AI provider configured and with or
// without SAM.gov connectivity.
//
// Section 5's `buildRegistrationHealth` already classifies SAM, certification
// and insurance expiry against each record's own `reminderLeadDays`. It is
// reused verbatim rather than reimplemented; this module adds only what it does
// not cover — the SAM 30-day escalation window, per-opportunity certification
// deadlines, and bonding capacity, which had no model until §7.3.
//
// The agent NEVER writes to any of these records. It reads them and reports.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { buildRegistrationHealth, classifyExpiry, daysUntil, type ExpiryStatus, type RegistrationHealth } from '../../registrationHealth'
import { SAM_EXPIRY_ESCALATION_DAYS } from './policy'
import type { ProposedEscalation } from '../types'

export type BondingState = 'SUFFICIENT' | 'INSUFFICIENT' | 'EXPIRED' | 'MISSING' | 'INSUFFICIENT_DATA'

export interface BondingAssessment {
  recordId: string | null
  suretyName: string | null
  /** Decimal strings — never floats. Null when the firm has not recorded them. */
  singleProjectLimit: string | null
  aggregateLimit: string | null
  committedAmount: string | null
  /** Derived at read time: aggregate − committed. Null when either is absent. */
  availableCapacity: string | null
  effectiveDate: Date | null
  expiryDate: Date | null
  daysUntilExpiry: number | null
  status: string | null
  state: BondingState
  reasons: string[]
}

export interface RegistrationWatchResult {
  health: RegistrationHealth
  sam: {
    status: string
    expiryDate: Date | null
    daysUntilExpiry: number | null
    expiryStatus: ExpiryStatus
    withinEscalationWindow: boolean
    /** True when the firm has no RegistrationProfile row at all. */
    missing: boolean
    /** How fresh the stored SAM data is. No provider is called here. */
    dataFreshness: string
  }
  certifications: Array<{
    id: string
    name: string
    expiryDate: Date | null
    expiryStatus: ExpiryStatus
    daysUntilExpiry: number | null
    ownerUserId: string | null
  }>
  insurance: Array<{
    id: string
    policyType: string
    expiryDate: Date | null
    expiryStatus: ExpiryStatus
    daysUntilExpiry: number | null
    ownerUserId: string | null
  }>
  bonding: BondingAssessment
  blockers: string[]
  attention: string[]
  insufficient: string[]
  warnings: string[]
  escalations: ProposedEscalation[]
}

export function registrationEscalationDedupeHint(kind: 'SAM_EXPIRY' | 'CERT_EXPIRY' | 'INSURANCE_EXPIRY' | 'BONDING', id: string): string {
  return `compliance-${kind.toLowerCase()}:${id}`
}

/**
 * Read the firm's compliance-relevant records and classify them.
 *
 * `now` is injected so the whole assessment is a pure function of stored state
 * plus a clock, which is what makes it testable at exact expiry boundaries.
 */
export async function assessRegistration(
  consultingFirmId: string,
  now: Date = new Date(),
): Promise<RegistrationWatchResult> {
  const [profile, certifications, policies, bondingRow] = await Promise.all([
    prisma.registrationProfile.findUnique({
      where: { consultingFirmId },
      select: { samStatus: true, samExpiryDate: true, reminderLeadDays: true, ownerUserId: true, uei: true, cageCode: true, updatedAt: true },
    }),
    prisma.certification.findMany({
      where: { consultingFirmId, isArchived: false },
      select: { id: true, name: true, expiryDate: true, reminderLeadDays: true, ownerUserId: true },
    }),
    prisma.insurancePolicy.findMany({
      where: { consultingFirmId, isArchived: false },
      select: { id: true, policyType: true, expiryDate: true, reminderLeadDays: true, ownerUserId: true },
    }),
    // The most recently effective non-archived record is the one in force.
    prisma.bondingCapacity.findFirst({
      where: { consultingFirmId, status: { not: 'ARCHIVED' } },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
    }),
  ])

  // Section 5's canonical classifier — reused, not reimplemented.
  const health = buildRegistrationHealth(profile, certifications, policies, now)

  const blockers: string[] = []
  const attention: string[] = []
  const insufficient: string[] = []
  const warnings: string[] = []
  const escalations: ProposedEscalation[] = []

  // --- SAM -----------------------------------------------------------
  const samDays = daysUntil(profile?.samExpiryDate ?? null, now)
  const samExpiryStatus = profile
    ? classifyExpiry(profile.samExpiryDate, now, profile.reminderLeadDays)
    : ('MISSING' as ExpiryStatus)
  const samWithinWindow = samDays !== null && samDays >= 0 && samDays <= SAM_EXPIRY_ESCALATION_DAYS

  if (!profile) {
    insufficient.push('No registration profile is recorded, so SAM status, UEI and CAGE cannot be assessed.')
  } else {
    if (samExpiryStatus === 'EXPIRED') {
      blockers.push(`SAM registration expired on ${profile.samExpiryDate?.toISOString().slice(0, 10)}. Federal award is not possible without an active registration.`)
      escalations.push({
        severity: 'CRITICAL',
        title: 'SAM registration has expired',
        reason: `SAM.gov registration expired on ${profile.samExpiryDate?.toISOString().slice(0, 10)}. An expired registration blocks award.`,
        recommendedAction: 'Renew the SAM.gov registration and update the expiry date on /registration.',
        entityType: 'RegistrationProfile',
        entityId: consultingFirmId,
        dedupeHint: registrationEscalationDedupeHint('SAM_EXPIRY', 'expired'),
      })
    } else if (samWithinWindow) {
      attention.push(`SAM registration expires in ${samDays} day(s).`)
      escalations.push({
        severity: samDays !== null && samDays <= 7 ? 'HIGH' : 'MEDIUM',
        title: `SAM registration expires in ${samDays} day(s)`,
        reason:
          `SAM.gov registration expires on ${profile.samExpiryDate?.toISOString().slice(0, 10)}, inside the ` +
          `${SAM_EXPIRY_ESCALATION_DAYS}-day window. Renewal takes time and an expired registration blocks award.`,
        recommendedAction: 'Start the SAM.gov renewal now and update the expiry date on /registration.',
        entityType: 'RegistrationProfile',
        entityId: consultingFirmId,
        // One item per (tenant, condition) — a daily re-run refreshes it.
        dedupeHint: registrationEscalationDedupeHint('SAM_EXPIRY', 'expiring'),
      })
    }
    if (!profile.samExpiryDate) {
      insufficient.push('No SAM expiry date is recorded, so renewal risk cannot be assessed.')
    }
    if (!profile.uei) insufficient.push('No UEI is recorded on the registration profile.')
    if (profile.samStatus && profile.samStatus.toUpperCase() !== 'ACTIVE') {
      attention.push(`Recorded SAM status is ${profile.samStatus}.`)
    }
  }

  // --- certifications --------------------------------------------------
  const certRows = certifications.map((c) => ({
    id: c.id,
    name: c.name,
    expiryDate: c.expiryDate,
    expiryStatus: classifyExpiry(c.expiryDate, now, c.reminderLeadDays),
    daysUntilExpiry: daysUntil(c.expiryDate, now),
    ownerUserId: c.ownerUserId,
  }))
  for (const cert of certRows) {
    if (cert.expiryStatus === 'EXPIRED') {
      attention.push(`Certification "${cert.name}" expired on ${cert.expiryDate?.toISOString().slice(0, 10)}.`)
      escalations.push({
        severity: 'HIGH',
        title: `Certification expired: ${cert.name}`,
        reason: `"${cert.name}" expired on ${cert.expiryDate?.toISOString().slice(0, 10)}. An expired certification does not count towards set-aside eligibility.`,
        recommendedAction: 'Renew the certification and update its expiry date, or archive it if it no longer applies.',
        entityType: 'Certification',
        entityId: cert.id,
        assignedToUserId: cert.ownerUserId,
        dedupeHint: registrationEscalationDedupeHint('CERT_EXPIRY', `${cert.id}:expired`),
      })
    } else if (cert.expiryStatus === 'EXPIRING_SOON') {
      attention.push(`Certification "${cert.name}" expires in ${cert.daysUntilExpiry} day(s).`)
    }
  }

  // --- insurance --------------------------------------------------------
  const policyRows = policies.map((p) => ({
    id: p.id,
    policyType: p.policyType,
    expiryDate: p.expiryDate,
    expiryStatus: classifyExpiry(p.expiryDate, now, p.reminderLeadDays),
    daysUntilExpiry: daysUntil(p.expiryDate, now),
    ownerUserId: p.ownerUserId,
  }))
  for (const policy of policyRows) {
    if (policy.expiryStatus === 'EXPIRED') {
      attention.push(`Insurance policy "${policy.policyType}" expired on ${policy.expiryDate?.toISOString().slice(0, 10)}.`)
      escalations.push({
        severity: 'MEDIUM',
        title: `Insurance expired: ${policy.policyType}`,
        reason: `The "${policy.policyType}" policy expired on ${policy.expiryDate?.toISOString().slice(0, 10)}.`,
        recommendedAction: 'Renew the policy and update its expiry date on /registration.',
        entityType: 'InsurancePolicy',
        entityId: policy.id,
        assignedToUserId: policy.ownerUserId,
        dedupeHint: registrationEscalationDedupeHint('INSURANCE_EXPIRY', `${policy.id}:expired`),
      })
    } else if (policy.expiryStatus === 'EXPIRING_SOON') {
      attention.push(`Insurance policy "${policy.policyType}" expires in ${policy.daysUntilExpiry} day(s).`)
    }
  }
  if (policies.length === 0) {
    // Absence is reported, never turned into an inferred requirement.
    insufficient.push('No insurance policies are recorded. Required coverage cannot be assessed from platform data alone.')
  }

  // --- bonding -----------------------------------------------------------
  const bonding = assessBonding(bondingRow, now)
  if (bonding.state === 'EXPIRED') {
    attention.push(`Recorded bonding capacity expired on ${bonding.expiryDate?.toISOString().slice(0, 10)}.`)
    escalations.push({
      severity: 'MEDIUM',
      title: 'Surety bonding capacity has expired',
      reason: `The recorded bonding capacity from ${bonding.suretyName ?? 'the surety'} expired on ${bonding.expiryDate?.toISOString().slice(0, 10)}.`,
      recommendedAction: 'Obtain a current capacity letter and update the bonding record.',
      entityType: 'BondingCapacity',
      entityId: bonding.recordId ?? consultingFirmId,
      dedupeHint: registrationEscalationDedupeHint('BONDING', `${bonding.recordId ?? 'none'}:expired`),
    })
  } else if (bonding.state === 'INSUFFICIENT') {
    attention.push('Recorded bonding capacity is fully committed — no headroom remains.')
  } else if (bonding.state === 'MISSING' || bonding.state === 'INSUFFICIENT_DATA') {
    insufficient.push(...bonding.reasons)
  }

  warnings.push(...health.attention.map((i) => `${i.kind}: ${i.label} is ${i.status}.`))

  return {
    health,
    sam: {
      status: profile?.samStatus ?? 'UNKNOWN',
      expiryDate: profile?.samExpiryDate ?? null,
      daysUntilExpiry: samDays,
      expiryStatus: samExpiryStatus,
      withinEscalationWindow: samWithinWindow,
      missing: !profile,
      // No SAM.gov entity call is made here. The freshness of the stored record
      // is reported so the reader knows exactly what this is based on.
      dataFreshness: profile
        ? `Based on the stored registration profile, last updated ${profile.updatedAt.toISOString().slice(0, 10)}. No live SAM.gov lookup was performed.`
        : 'No registration profile is stored for this firm.',
    },
    certifications: certRows,
    insurance: policyRows,
    bonding,
    blockers,
    attention,
    insufficient,
    warnings,
    escalations,
  }
}

type BondingRow = Prisma.BondingCapacityGetPayload<Record<string, never>> | null

/**
 * Classify one bonding record.
 *
 * Headroom is computed with Prisma.Decimal, never floats. When either the
 * aggregate limit or the committed amount is absent the answer is
 * INSUFFICIENT_DATA — a bonding figure invented from partial inputs would be
 * worse than saying nothing.
 */
export function assessBonding(row: BondingRow, now: Date = new Date()): BondingAssessment {
  if (!row) {
    return {
      recordId: null, suretyName: null,
      singleProjectLimit: null, aggregateLimit: null, committedAmount: null, availableCapacity: null,
      effectiveDate: null, expiryDate: null, daysUntilExpiry: null, status: null,
      state: 'MISSING',
      reasons: ['No surety bonding capacity is recorded, so bonding requirements cannot be assessed.'],
    }
  }

  const reasons: string[] = []
  const expiryDays = daysUntil(row.expiryDate, now)
  const expired = row.status === 'EXPIRED' || (row.expiryDate !== null && row.expiryDate.getTime() < now.getTime())

  let availableCapacity: Prisma.Decimal | null = null
  if (row.aggregateLimit !== null && row.committedAmount !== null) {
    availableCapacity = row.aggregateLimit.minus(row.committedAmount)
  } else if (row.aggregateLimit !== null && row.committedAmount === null) {
    // An aggregate with nothing recorded as committed is not the same as an
    // aggregate that is fully free. Say so rather than assume zero committed.
    reasons.push('No committed amount is recorded, so available bonding headroom cannot be calculated.')
  } else {
    reasons.push('No aggregate bonding limit is recorded, so available headroom cannot be calculated.')
  }

  let state: BondingState
  if (expired) {
    state = 'EXPIRED'
    reasons.push(`The bonding capacity expired on ${row.expiryDate?.toISOString().slice(0, 10) ?? 'an unrecorded date'}.`)
  } else if (availableCapacity === null) {
    state = 'INSUFFICIENT_DATA'
  } else if (availableCapacity.lessThanOrEqualTo(0)) {
    state = 'INSUFFICIENT'
    reasons.push('Committed bonding equals or exceeds the aggregate limit, so no headroom remains.')
  } else {
    state = 'SUFFICIENT'
  }

  return {
    recordId: row.id,
    suretyName: row.suretyName,
    singleProjectLimit: row.singleProjectLimit?.toFixed(2) ?? null,
    aggregateLimit: row.aggregateLimit?.toFixed(2) ?? null,
    committedAmount: row.committedAmount?.toFixed(2) ?? null,
    availableCapacity: availableCapacity?.toFixed(2) ?? null,
    effectiveDate: row.effectiveDate,
    expiryDate: row.expiryDate,
    daysUntilExpiry: expiryDays,
    status: row.status,
    state,
    reasons,
  }
}

/**
 * Certifications that expire before a specific opportunity's response
 * deadline. A certification a bid depends on expiring before the bid is even
 * due is a blocker, not a reminder.
 */
export function certificationsExpiringBeforeDeadline(
  certifications: RegistrationWatchResult['certifications'],
  responseDeadline: Date | null,
): RegistrationWatchResult['certifications'] {
  if (!responseDeadline) return []
  return certifications.filter((c) => c.expiryDate !== null && c.expiryDate.getTime() < responseDeadline.getTime())
}
