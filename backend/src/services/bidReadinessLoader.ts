// =============================================================
// Load the records a bid-readiness check needs (services/bidReadiness.ts),
// for the company that would bid:
//   - a contractor's own company, or a firm with no client chosen: the firm's
//     registration profile, certifications, partners and bonding
//   - a consulting firm's client: that client's profile — SAM status, NAICS,
//     and set-aside flags with their certification expiry dates
// =============================================================
import { prisma } from '../config/database'
import { NotFoundError } from '../utils/errors'
import { evaluateBidReadiness, type BidReadinessResult } from './bidReadiness'
import type { CertificationRecord, RegistrationRecord } from './setAsideEligibility'

const OPPORTUNITY_SELECT = { setAsideType: true, naicsCode: true, responseDeadline: true, estimatedValue: true } as const

/** A client's set-aside flags, with the certification expiry each one has. */
const CLIENT_CERTS = [
  { flag: 'sdvosb', expiry: 'sdvosbCertExpiry', name: 'SDVOSB' },
  { flag: 'wosb', expiry: 'wosbCertExpiry', name: 'WOSB' },
  { flag: 'hubzone', expiry: 'hubzoneCertExpiry', name: 'HUBZone' },
  { flag: 'eightA', expiry: 'eightACertExpiry', name: '8(a)' },
] as const

type ClientRow = {
  id: string
  isSelf: boolean
  naicsCodes: string[]
  samRegStatus: string | null
  samRegExpiry: Date | null
  smallBusiness: boolean
  sdvosb: boolean; wosb: boolean; hubzone: boolean; eightA: boolean
  sdvosbCertExpiry: Date | null; wosbCertExpiry: Date | null; hubzoneCertExpiry: Date | null; eightACertExpiry: Date | null
}

/** A client's profile as the registration and certification records readiness reads. */
export function clientEligibilityRecords(client: ClientRow): { registration: RegistrationRecord; certifications: CertificationRecord[] } {
  const declared: string[] = CLIENT_CERTS.filter((c) => client[c.flag]).map((c) => c.name)
  if (client.smallBusiness) declared.push('SB')
  return {
    registration: {
      // Client profiles store "Active" / "Inactive"; readiness compares to ACTIVE.
      samStatus: (client.samRegStatus ?? 'UNKNOWN').toUpperCase(),
      samExpiryDate: client.samRegExpiry,
      setAsideCerts: declared,
      naicsCodes: client.naicsCodes,
    },
    // Only a flag with an expiry date is a certification record; a flag alone
    // is a self-declared status, as on a registration profile.
    certifications: CLIENT_CERTS
      .filter((c) => client[c.flag] && client[c.expiry])
      .map((c) => ({ id: `${client.id}:${c.name}`, name: c.name, category: c.name, expiryDate: client[c.expiry], isArchived: false })),
  }
}

type ReadinessOpportunity = Parameters<typeof evaluateBidReadiness>[0]['opportunity']

/**
 * Load the bidding company's records once, then check any number of
 * opportunities against them (the qualify queue checks a page at a time).
 * With a consulting firm's client it uses that client's profile; otherwise (a
 * contractor's own company, or no client) the firm's own records.
 */
export async function readinessChecker(consultingFirmId: string, clientCompanyId?: string | null): Promise<(opp: ReadinessOpportunity) => BidReadinessResult> {
  if (clientCompanyId) {
    const client = await prisma.clientCompany.findFirst({
      where: { id: clientCompanyId, consultingFirmId },
      select: {
        id: true, isSelf: true, naicsCodes: true, samRegStatus: true, samRegExpiry: true, smallBusiness: true,
        sdvosb: true, wosb: true, hubzone: true, eightA: true,
        sdvosbCertExpiry: true, wosbCertExpiry: true, hubzoneCertExpiry: true, eightACertExpiry: true,
      },
    })
    if (!client) throw new NotFoundError('Client company')
    // A contractor's own company is kept in step with the firm's registration,
    // which holds more (certification records, bonding), so use the firm's.
    if (!client.isSelf) {
      const records = clientEligibilityRecords(client)
      return (opportunity) => evaluateBidReadiness({ opportunity, ...records, bonding: null })
    }
  }

  const [registration, certifications, partners, bonding] = await Promise.all([
    prisma.registrationProfile.findUnique({
      where: { consultingFirmId },
      select: { samStatus: true, samExpiryDate: true, setAsideCerts: true, naicsCodes: true },
    }),
    prisma.certification.findMany({
      where: { consultingFirmId, isArchived: false },
      select: { id: true, name: true, category: true, expiryDate: true, isArchived: true },
    }),
    prisma.partner.findMany({
      where: { consultingFirmId },
      select: { id: true, name: true, certifications: true, primarySetAsides: true },
      take: 500,
    }),
    prisma.bondingCapacity.findFirst({
      where: { consultingFirmId, status: 'ACTIVE' },
      orderBy: [{ effectiveDate: 'desc' }, { createdAt: 'desc' }],
      select: { singleProjectLimit: true, aggregateLimit: true, committedAmount: true, expiryDate: true, status: true },
    }),
  ])
  const partnerCertifications = partners.map((p) => ({
    partnerId: p.id,
    partnerName: p.name,
    certifications: [...new Set([...(p.certifications ?? []), ...(p.primarySetAsides ?? [])])],
  }))
  return (opportunity) => evaluateBidReadiness({ opportunity, registration, certifications, partnerCertifications, bonding })
}

/** The readiness checklist for one opportunity, for the company that would bid. */
export async function loadBidReadiness(consultingFirmId: string, opportunityId: string, clientCompanyId?: string | null): Promise<BidReadinessResult> {
  const opp = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId }, select: OPPORTUNITY_SELECT })
  if (!opp) throw new NotFoundError('Opportunity')
  return (await readinessChecker(consultingFirmId, clientCompanyId))(opp)
}
