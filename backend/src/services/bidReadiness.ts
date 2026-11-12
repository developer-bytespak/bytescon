// =============================================================
// "Can I bid on this?" — per-opportunity bid readiness.
//
// One checklist per opportunity, built from the firm's own records:
//   DEADLINE   is the notice still open, and is there time to respond
//   SAM        SAM.gov registration active through the deadline (FAR 52.204-7)
//   NAICS      the notice's NAICS against the firm's registered codes
//   SET_ASIDE  set-aside eligibility (reuses setAsideEligibility.ts)
//   BONDING    construction over the Miller Act threshold (FAR 28.102-1)
//              against the surety's single-project limit and headroom
//
// Each item is PASS / WARN / FAIL. A FAIL is HARD (cannot be fixed before
// this bid) or FIXABLE (a step the firm can take). The verdict:
//   NOT_ELIGIBLE  any HARD fail
//   FIX_FIRST     any FIXABLE fail or any WARN
//   READY         everything passes
//
// Pure and clock-injected. Like setAsideEligibility, nothing here is a legal
// determination; missing data is reported as a step to take, never guessed.
// =============================================================
import { EligibilityState, Prisma } from '@prisma/client'
import { evaluateEligibility, type CertificationRecord, type RegistrationRecord } from './setAsideEligibility'

/** FAR 28.102-1: performance and payment bonds above this contract value. */
export const BOND_THRESHOLD = 150_000
/** A new SAM.gov registration typically takes this long to go active. */
const SAM_REGISTRATION_DAYS = 28
const SHORT_DEADLINE_DAYS = 3
const DAY_MS = 86_400_000

export const READINESS_DISCLAIMER =
  'This checklist compares the notice with the records stored in Bytescon. It is not a legal determination of eligibility — the contracting officer decides. Licences and other notice-specific requirements are not checked; read the solicitation.'

export type ReadinessStatus = 'PASS' | 'WARN' | 'FAIL'
export type ReadinessVerdict = 'READY' | 'FIX_FIRST' | 'NOT_ELIGIBLE'
export type ReadinessKey = 'DEADLINE' | 'SAM' | 'NAICS' | 'SET_ASIDE' | 'BONDING'

export interface ReadinessItem {
  key: ReadinessKey
  label: string
  status: ReadinessStatus
  /** Only on FAIL: HARD cannot be fixed for this bid, FIXABLE can. */
  blocking?: 'HARD' | 'FIXABLE'
  detail: string
  /** What to do about a WARN or FAIL. */
  fix?: string
}

export interface BidReadinessResult {
  verdict: ReadinessVerdict
  items: ReadinessItem[]
  disclaimer: string
}

export interface BondingRecord {
  singleProjectLimit: Prisma.Decimal | null
  aggregateLimit: Prisma.Decimal | null
  committedAmount: Prisma.Decimal | null
  expiryDate: Date | null
  status: 'ACTIVE' | 'EXPIRED' | 'ARCHIVED'
}

export interface BidReadinessInput {
  opportunity: {
    setAsideType: string | null
    naicsCode: string | null
    responseDeadline: Date
    estimatedValue: Prisma.Decimal | null
  }
  registration: RegistrationRecord | null
  certifications: CertificationRecord[]
  partnerCertifications?: Array<{ partnerId: string; partnerName: string; certifications: string[] }>
  /** The firm's current bonding record, or null when none is recorded. */
  bonding: BondingRecord | null
  now?: Date
}

const money = (d: Prisma.Decimal | number) =>
  `$${Number(d).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
/** Federal deadlines are set in US time; show dates as US Eastern, e.g. "Nov 30, 2026". */
const day = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })

function deadlineItem(deadline: Date, now: Date): ReadinessItem {
  const days = (deadline.getTime() - now.getTime()) / DAY_MS
  if (days < 0) {
    return {
      key: 'DEADLINE', label: 'Response deadline', status: 'FAIL', blocking: 'HARD',
      detail: `The response deadline (${day(deadline)}) has passed.`,
    }
  }
  if (days < SHORT_DEADLINE_DAYS) {
    return {
      key: 'DEADLINE', label: 'Response deadline', status: 'WARN',
      detail: `The response is due ${day(deadline)}, less than ${SHORT_DEADLINE_DAYS} days away.`,
      fix: 'Decide today whether to bid; there is little time to prepare a response.',
    }
  }
  return {
    key: 'DEADLINE', label: 'Response deadline', status: 'PASS',
    detail: `Due ${day(deadline)}, ${Math.floor(days)} days from now.`,
  }
}

function samItem(reg: RegistrationRecord | null, deadline: Date, now: Date): ReadinessItem {
  const daysLeft = (deadline.getTime() - now.getTime()) / DAY_MS
  const tooLate = daysLeft < SAM_REGISTRATION_DAYS
  const registerFix = tooLate
    ? 'Register or reactivate at SAM.gov now. It usually takes 2 to 4 weeks, so it may not be active before the deadline.'
    : 'Register or reactivate at SAM.gov. It usually takes 2 to 4 weeks, so start now.'

  if (!reg || reg.samStatus === 'UNKNOWN') {
    return {
      key: 'SAM', label: 'SAM.gov registration', status: 'FAIL', blocking: 'FIXABLE',
      detail: reg ? 'Your SAM.gov status is not recorded.' : 'No SAM.gov registration is recorded for your firm.',
      fix: `If you are already registered, add it to the company profile. Otherwise: ${registerFix}`,
    }
  }
  if (reg.samStatus !== 'ACTIVE') {
    return {
      key: 'SAM', label: 'SAM.gov registration', status: 'FAIL', blocking: 'FIXABLE',
      detail: `Your SAM.gov registration is recorded as ${reg.samStatus}. An active registration is required to submit an offer.`,
      fix: registerFix,
    }
  }
  if (reg.samExpiryDate && reg.samExpiryDate.getTime() < deadline.getTime()) {
    return {
      key: 'SAM', label: 'SAM.gov registration', status: 'WARN',
      detail: `Active, but it expires ${day(reg.samExpiryDate)}, before the response deadline.`,
      fix: 'Renew your SAM.gov registration before the deadline. Renewal can take several weeks.',
    }
  }
  return {
    key: 'SAM', label: 'SAM.gov registration', status: 'PASS',
    detail: reg.samExpiryDate ? `Active until ${day(reg.samExpiryDate)}.` : 'Active (no expiry date recorded).',
  }
}

function naicsItem(oppNaics: string | null, reg: RegistrationRecord | null): ReadinessItem {
  const code = (oppNaics ?? '').trim()
  if (!code) {
    return {
      key: 'NAICS', label: 'Industry code (NAICS)', status: 'WARN',
      detail: 'The notice lists no NAICS code.',
      fix: 'Check the solicitation for the NAICS code and its size standard.',
    }
  }
  const firmCodes = reg?.naicsCodes ?? []
  if (firmCodes.length === 0) {
    return {
      key: 'NAICS', label: 'Industry code (NAICS)', status: 'WARN',
      detail: `The notice is under NAICS ${code}. No NAICS codes are recorded for your firm.`,
      fix: 'Add the NAICS codes from your SAM.gov registration to the company profile.',
    }
  }
  if (firmCodes.includes(code)) {
    return { key: 'NAICS', label: 'Industry code (NAICS)', status: 'PASS', detail: `NAICS ${code} is one of your registered codes.` }
  }
  const group = code.slice(0, 4)
  const near = firmCodes.filter((c) => c.startsWith(group))
  if (near.length > 0) {
    return {
      key: 'NAICS', label: 'Industry code (NAICS)', status: 'WARN',
      detail: `NAICS ${code} is not one of your codes, but ${near.join(', ')} is in the same industry group (${group}).`,
      fix: `If this is work you do, add ${code} to your SAM.gov registration so you can represent your size under it.`,
    }
  }
  return {
    key: 'NAICS', label: 'Industry code (NAICS)', status: 'WARN',
    detail: `NAICS ${code} is not one of your registered codes.`,
    fix: `Check this is work you do. If so, add ${code} to your SAM.gov registration before bidding.`,
  }
}

const SET_ASIDE_STATUS: Record<EligibilityState, ReadinessStatus> = {
  ELIGIBLE: 'PASS',
  POSSIBLY_ELIGIBLE: 'WARN',
  EXPIRING_BEFORE_DEADLINE: 'WARN',
  INSUFFICIENT_DATA: 'WARN',
  NOT_ELIGIBLE: 'FAIL',
}

function setAsideItem(input: BidReadinessInput, now: Date): ReadinessItem {
  const result = evaluateEligibility({
    setAsideType: input.opportunity.setAsideType ?? 'NONE',
    responseDeadline: input.opportunity.responseDeadline,
    naicsCode: input.opportunity.naicsCode,
    registration: input.registration,
    certifications: input.certifications,
    partnerCertifications: input.partnerCertifications,
    now,
  })
  const status = SET_ASIDE_STATUS[result.state] ?? 'WARN'
  const fix =
    result.state === EligibilityState.NOT_ELIGIBLE ? 'Only firms with this certification can bid as the prime. Consider subcontracting to a firm that holds it.'
      : result.state === EligibilityState.EXPIRING_BEFORE_DEADLINE ? 'Renew the expiring record before the deadline.'
        : result.state === EligibilityState.INSUFFICIENT_DATA ? 'Add your certifications, with their expiry dates.'
          : result.state === EligibilityState.POSSIBLY_ELIGIBLE ? 'Add the certification record, with its expiry date.'
            : undefined
  return {
    key: 'SET_ASIDE', label: 'Set-aside eligibility', status,
    ...(status === 'FAIL' ? { blocking: 'HARD' as const } : {}),
    detail: result.reason,
    ...(fix ? { fix } : {}),
  }
}

function isConstruction(naics: string | null): boolean {
  return (naics ?? '').trim().startsWith('23')
}

function bondingItem(input: BidReadinessInput, now: Date): ReadinessItem | null {
  if (!isConstruction(input.opportunity.naicsCode)) return null
  const value = input.opportunity.estimatedValue
  if (value === null) {
    return {
      key: 'BONDING', label: 'Bonding', status: 'WARN',
      detail: `Construction contracts over $150,000 need performance and payment bonds. The notice gives no value, so this cannot be checked.`,
      fix: 'Check the solicitation for bond requirements and confirm your surety will bond this job.',
    }
  }
  if (value.lessThanOrEqualTo(BOND_THRESHOLD)) return null

  const b = input.bonding
  const expired = !b || b.status !== 'ACTIVE' || (b.expiryDate !== null && b.expiryDate.getTime() < now.getTime())
  if (expired) {
    return {
      key: 'BONDING', label: 'Bonding', status: 'FAIL', blocking: 'FIXABLE',
      detail: `This ${money(value)} construction job needs performance and payment bonds. ${b ? 'Your recorded bonding capacity has expired.' : 'No bonding capacity is recorded.'}`,
      fix: 'Get a current bonding capacity letter from your surety and record it.',
    }
  }
  if (b.singleProjectLimit !== null && value.greaterThan(b.singleProjectLimit)) {
    return {
      key: 'BONDING', label: 'Bonding', status: 'FAIL', blocking: 'HARD',
      detail: `The job (${money(value)}) is larger than your single-project bonding limit of ${money(b.singleProjectLimit)}.`,
      fix: 'Ask your surety about a higher limit, or bid as a subcontractor on this job.',
    }
  }
  if (b.aggregateLimit !== null && b.committedAmount !== null) {
    const headroom = b.aggregateLimit.minus(b.committedAmount)
    if (value.greaterThan(headroom)) {
      return {
        key: 'BONDING', label: 'Bonding', status: 'FAIL', blocking: 'HARD',
        detail: `The job (${money(value)}) is more than your remaining bonding capacity of ${money(headroom.isNegative() ? 0 : headroom)}.`,
        fix: 'Ask your surety about more capacity, or wait until current bonded work completes.',
      }
    }
  }
  if (b.singleProjectLimit === null || b.aggregateLimit === null || b.committedAmount === null) {
    return {
      key: 'BONDING', label: 'Bonding', status: 'WARN',
      detail: `This ${money(value)} job needs bonds, and your bonding record is missing a limit or the amount already committed.`,
      fix: 'Complete your bonding record.',
    }
  }
  return {
    key: 'BONDING', label: 'Bonding', status: 'PASS',
    detail: `The job (${money(value)}) fits your single-project limit and remaining bonding capacity.`,
  }
}

export function evaluateBidReadiness(input: BidReadinessInput): BidReadinessResult {
  const now = input.now ?? new Date()
  const items: ReadinessItem[] = [
    deadlineItem(input.opportunity.responseDeadline, now),
    samItem(input.registration, input.opportunity.responseDeadline, now),
    naicsItem(input.opportunity.naicsCode, input.registration),
    setAsideItem(input, now),
  ]
  const bonding = bondingItem(input, now)
  if (bonding) items.push(bonding)

  const verdict: ReadinessVerdict =
    items.some((i) => i.status === 'FAIL' && i.blocking === 'HARD') ? 'NOT_ELIGIBLE'
      : items.some((i) => i.status !== 'PASS') ? 'FIX_FIRST'
        : 'READY'

  return { verdict, items, disclaimer: READINESS_DISCLAIMER }
}
