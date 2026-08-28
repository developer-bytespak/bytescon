// =============================================================
// §6.1F — Set-aside eligibility.
//
// Compares an opportunity's set-aside requirement against the firm's ACTUAL
// registration and certification records (Section 5 Module 2), and returns a
// graded state with the evidence behind it.
//
// Non-negotiable rules encoded here:
//  - An expired certification NEVER counts as active eligibility.
//  - Eligibility is never inferred without a verified record — absent data
//    produces INSUFFICIENT_DATA, not NOT_ELIGIBLE, so nothing is silently
//    filtered out for want of data.
//  - Nothing here asserts legal eligibility. Every result is accompanied by the
//    standard disclaimer below.
//  - Joint-venture / partner eligibility is only considered when a partner
//    explicitly carries the certification; it is never assumed.
// =============================================================
import { EligibilityState } from '@prisma/client'

export const ELIGIBILITY_DISCLAIMER =
  'This is a records-based comparison of your stored registrations and certifications against the notice’s stated set-aside. It is not a legal determination of eligibility — the contracting officer decides.'

export interface CertificationRecord {
  id: string
  name: string
  category: string
  expiryDate: Date | null
  isArchived: boolean
}

export interface RegistrationRecord {
  samStatus: string
  samExpiryDate: Date | null
  setAsideCerts: string[]
  naicsCodes: string[]
}

export interface EligibilityInput {
  setAsideType: string
  responseDeadline: Date
  naicsCode?: string | null
  registration: RegistrationRecord | null
  certifications: CertificationRecord[]
  /** Partner certifications, considered only for explicit JV support. */
  partnerCertifications?: Array<{ partnerId: string; partnerName: string; certifications: string[] }>
  now?: Date
}

export interface EligibilityEvidenceItem {
  source: 'REGISTRATION' | 'CERTIFICATION' | 'PARTNER' | 'NOTICE'
  recordId?: string
  detail: string
}

export interface EligibilityResult {
  state: EligibilityState
  reason: string
  requiredCertKeys: string[]
  matchedCertificationIds: string[]
  /** Certifications that satisfy the notice but expire before the deadline. */
  expiringCertificationIds: string[]
  partnerCoverage: Array<{ partnerId: string; partnerName: string; certKey: string }>
  evidence: EligibilityEvidenceItem[]
  disclaimer: string
}

/**
 * Canonical set-aside → the certification keys that satisfy it. Values match
 * the platform's canonical set-aside vocabulary (see samApi.mapSetAside).
 */
export const SET_ASIDE_REQUIREMENTS: Record<string, string[]> = {
  NONE: [],
  SMALL_BUSINESS: ['SMALL_BUSINESS'],
  TOTAL_SMALL_BUSINESS: ['SMALL_BUSINESS'],
  SDVOSB: ['SDVOSB'],
  VOSB: ['VOSB', 'SDVOSB'], // an SDVOSB is also veteran-owned
  WOSB: ['WOSB', 'EDWOSB'],
  EDWOSB: ['EDWOSB'],
  HUBZONE: ['HUBZONE'],
  SBA_8A: ['SBA_8A'],
  INDIAN: ['INDIAN'],
}

/** Normalizes free-text certification names onto the canonical keys. */
export function normalizeCertKey(name: string): string | null {
  const v = name.toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (/SDVOSB|SERVICEDISABLED/.test(v)) return 'SDVOSB'
  if (/EDWOSB|ECONOMICALLYDISADVANTAGED/.test(v)) return 'EDWOSB'
  if (/WOSB|WOMANOWNED|WOMENOWNED/.test(v)) return 'WOSB'
  if (/HUBZONE|HZ$/.test(v)) return 'HUBZONE'
  if (/8A|SBA8A/.test(v)) return 'SBA_8A'
  if (/VOSB|VETERANOWNED/.test(v)) return 'VOSB'
  if (/INDIAN|TRIBAL|ANC|NHO/.test(v)) return 'INDIAN'
  if (/SMALLBUSINESS|SMALLBIZ/.test(v)) return 'SMALL_BUSINESS'
  return null
}

function isExpired(expiry: Date | null, at: Date): boolean {
  return expiry !== null && expiry.getTime() < at.getTime()
}

/**
 * Evaluate eligibility. Pure and deterministic — the same inputs always give
 * the same state, reason and evidence.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const now = input.now ?? new Date()
  const evidence: EligibilityEvidenceItem[] = []
  const setAside = (input.setAsideType || 'NONE').toUpperCase()
  const required = SET_ASIDE_REQUIREMENTS[setAside]

  evidence.push({ source: 'NOTICE', detail: `Notice set-aside: ${setAside}` })

  const base = {
    requiredCertKeys: required ?? [],
    matchedCertificationIds: [] as string[],
    expiringCertificationIds: [] as string[],
    partnerCoverage: [] as EligibilityResult['partnerCoverage'],
    disclaimer: ELIGIBILITY_DISCLAIMER,
  }

  // An unrecognised set-aside string is reported honestly, not guessed at.
  if (required === undefined) {
    return {
      ...base,
      state: EligibilityState.INSUFFICIENT_DATA,
      reason: `The notice's set-aside value "${setAside}" is not one this platform can map to a certification requirement, so eligibility cannot be assessed.`,
      evidence,
    }
  }

  // Full and open — everyone may bid; SAM registration still matters.
  if (required.length === 0) {
    if (!input.registration) {
      return {
        ...base,
        state: EligibilityState.POSSIBLY_ELIGIBLE,
        reason: 'This notice is not set aside, so no certification is required. No registration record exists to confirm active SAM status.',
        evidence,
      }
    }
    const samActive = input.registration.samStatus === 'ACTIVE'
    const samExpiresFirst = isExpired(input.registration.samExpiryDate, input.responseDeadline)
    evidence.push({
      source: 'REGISTRATION',
      detail: `SAM status ${input.registration.samStatus}${input.registration.samExpiryDate ? `, expires ${input.registration.samExpiryDate.toISOString().slice(0, 10)}` : ', no expiry recorded'}`,
    })
    if (samActive && samExpiresFirst) {
      return {
        ...base,
        state: EligibilityState.EXPIRING_BEFORE_DEADLINE,
        reason: 'No set-aside certification is required, but your SAM registration expires before the response deadline.',
        evidence,
      }
    }
    return {
      ...base,
      state: samActive ? EligibilityState.ELIGIBLE : EligibilityState.POSSIBLY_ELIGIBLE,
      reason: samActive
        ? 'This notice is not set aside and your SAM registration is recorded as active.'
        : `This notice is not set aside, but your SAM status is recorded as ${input.registration.samStatus}.`,
      evidence,
    }
  }

  // A set-aside notice with no registration record at all: not enough data.
  if (!input.registration && input.certifications.length === 0) {
    return {
      ...base,
      state: EligibilityState.INSUFFICIENT_DATA,
      reason: `This notice requires ${required.join(' or ')}. No registration profile or certification records exist yet, so eligibility cannot be assessed.`,
      evidence,
    }
  }

  // Active (non-archived, non-expired) certifications the firm holds.
  const activeCerts: Array<{ id: string; key: string; expiry: Date | null }> = []
  const expiredCerts: Array<{ id: string; key: string; expiry: Date | null }> = []
  const expiringBeforeDeadline: string[] = []

  for (const cert of input.certifications) {
    if (cert.isArchived) continue
    const key = normalizeCertKey(cert.name)
    if (!key || !required.includes(key)) continue

    if (isExpired(cert.expiryDate, now)) {
      expiredCerts.push({ id: cert.id, key, expiry: cert.expiryDate })
      evidence.push({
        source: 'CERTIFICATION', recordId: cert.id,
        detail: `${cert.name} (${key}) EXPIRED on ${cert.expiryDate?.toISOString().slice(0, 10)} — does not count as active eligibility.`,
      })
      continue
    }

    activeCerts.push({ id: cert.id, key, expiry: cert.expiryDate })
    const expiresBeforeDeadline = isExpired(cert.expiryDate, input.responseDeadline)
    if (expiresBeforeDeadline) expiringBeforeDeadline.push(cert.id)
    evidence.push({
      source: 'CERTIFICATION', recordId: cert.id,
      detail: `${cert.name} (${key}) active${cert.expiryDate ? `, expires ${cert.expiryDate.toISOString().slice(0, 10)}` : ', no expiry recorded'}${expiresBeforeDeadline ? ' — BEFORE the response deadline' : ''}`,
    })
  }

  // Registration-declared set-aside status is corroborating evidence. It is
  // never treated as a certification on its own, because it carries no expiry.
  const declared = new Set(
    (input.registration?.setAsideCerts ?? [])
      .map(normalizeCertKey)
      .filter((k): k is string => k !== null),
  )
  const declaredMatch = required.filter((k) => declared.has(k))
  if (declaredMatch.length > 0) {
    evidence.push({
      source: 'REGISTRATION',
      detail: `Registration profile declares ${declaredMatch.join(', ')}. This is a self-declared status with no expiry, so it supports but does not by itself establish eligibility.`,
    })
  }

  const matchedKeys = new Set(activeCerts.map((c) => c.key))
  const satisfied = required.some((k) => matchedKeys.has(k))

  // Partner coverage — only when a partner explicitly holds the certification.
  const partnerCoverage: EligibilityResult['partnerCoverage'] = []
  if (!satisfied && input.partnerCertifications) {
    for (const partner of input.partnerCertifications) {
      for (const raw of partner.certifications) {
        const key = normalizeCertKey(raw)
        if (key && required.includes(key)) {
          partnerCoverage.push({ partnerId: partner.partnerId, partnerName: partner.partnerName, certKey: key })
          evidence.push({
            source: 'PARTNER', recordId: partner.partnerId,
            detail: `Partner ${partner.partnerName} holds ${key}. A joint venture or mentor-protégé arrangement may support eligibility, but this platform does not assert that it does.`,
          })
        }
      }
    }
  }

  const result = { ...base, matchedCertificationIds: activeCerts.map((c) => c.id), expiringCertificationIds: expiringBeforeDeadline, partnerCoverage, evidence }

  if (satisfied) {
    // A certification that lapses before the deadline is its own state — it is
    // not silently treated as eligible.
    const criticalExpiry = activeCerts.some((c) => matchedKeys.has(c.key) && isExpired(c.expiry, input.responseDeadline))
    const samExpiring = input.registration ? isExpired(input.registration.samExpiryDate, input.responseDeadline) : false
    if (criticalExpiry || samExpiring) {
      return {
        ...result,
        state: EligibilityState.EXPIRING_BEFORE_DEADLINE,
        reason: criticalExpiry
          ? `You hold the required ${required.join(' or ')} certification, but it expires before the ${input.responseDeadline.toISOString().slice(0, 10)} response deadline.`
          : `You hold the required ${required.join(' or ')} certification, but your SAM registration expires before the response deadline.`,
      }
    }
    return {
      ...result,
      state: EligibilityState.ELIGIBLE,
      reason: `You hold an active ${[...matchedKeys].join(', ')} certification, which matches this notice's ${setAside} set-aside.`,
    }
  }

  if (expiredCerts.length > 0) {
    return {
      ...result,
      state: EligibilityState.NOT_ELIGIBLE,
      reason: `This notice requires ${required.join(' or ')}. Your matching certification has expired, and an expired certification does not establish eligibility. Renew it to change this status.`,
    }
  }

  if (partnerCoverage.length > 0) {
    return {
      ...result,
      state: EligibilityState.POSSIBLY_ELIGIBLE,
      reason: `You do not hold ${required.join(' or ')} directly. ${partnerCoverage.length} partner record(s) carry it, so a teaming or joint-venture route may exist. This is not a determination that a joint venture would qualify.`,
    }
  }

  // Self-declared status with no supporting certification record: possible, not
  // established — and never filtered away.
  if (declaredMatch.length > 0) {
    return {
      ...result,
      state: EligibilityState.POSSIBLY_ELIGIBLE,
      reason: `Your registration profile declares ${declaredMatch.join(', ')}, but there is no certification record with an expiry date to confirm it. Add the certification to resolve this.`,
    }
  }

  return {
    ...result,
    state: EligibilityState.NOT_ELIGIBLE,
    reason: `This notice is set aside for ${required.join(' or ')} and no active certification, declared status, or partner coverage for it was found in your records.`,
  }
}
