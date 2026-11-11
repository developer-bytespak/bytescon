// =============================================================
// Contractor accounts — firms that bid for themselves.
//
// A CONTRACTOR account (ConsultingFirm.accountType) has no clients and no
// client portal. Win-probability scoring, submissions and the other
// client-based features still need a ClientCompany, so each contractor firm
// keeps exactly one hidden "self" ClientCompany (isSelf = true):
//   - created with the firm at sign-up (createSelfClient);
//   - kept in step with the firm's registration profile and certifications,
//     which are what the contractor edits (syncSelfClient).
// Client management routes refuse contractor accounts (requireConsultingAccount).
// =============================================================
import { AccountType, Prisma } from '@prisma/client'
import { Request, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { ForbiddenError } from '../utils/errors'
import { normalizeCertKey } from './setAsideEligibility'

export const CONTRACTOR_NO_CLIENTS_MESSAGE =
  'Contractor accounts bid for their own company, so they do not manage clients or client portal logins.'

type Db = Prisma.TransactionClient | typeof prisma

export interface SelfClientSource {
  firmName: string
  contactEmail: string | null
  registration: {
    uei: string | null
    cageCode: string | null
    naicsCodes: string[]
    setAsideCerts: string[]
    samStatus: string
    samExpiryDate: Date | null
  } | null
  /** Names of the firm's active (non-archived, unexpired) certifications. */
  activeCertificationNames: string[]
}

/** The ClientCompany fields that mirror the contractor's own records. Pure. */
export function selfClientFields(src: SelfClientSource) {
  const keys = new Set(
    [...(src.registration?.setAsideCerts ?? []), ...src.activeCertificationNames]
      .map(normalizeCertKey)
      .filter((k): k is string => k !== null),
  )
  const reg = src.registration
  return {
    name: src.firmName,
    email: src.contactEmail,
    uei: reg?.uei ?? null,
    cage: reg?.cageCode ?? null,
    naicsCodes: reg?.naicsCodes ?? [],
    sdvosb: keys.has('SDVOSB'),
    wosb: keys.has('WOSB') || keys.has('EDWOSB'),
    hubzone: keys.has('HUBZONE'),
    eightA: keys.has('SBA_8A'),
    samRegStatus: !reg || reg.samStatus === 'UNKNOWN' ? null : reg.samStatus === 'ACTIVE' ? 'Active' : 'Inactive',
    samRegExpiry: reg?.samExpiryDate ?? null,
  }
}

export async function isContractorFirm(consultingFirmId: string, db: Db = prisma): Promise<boolean> {
  const firm = await db.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { accountType: true } })
  return firm?.accountType === AccountType.CONTRACTOR
}

/** Create the contractor's own company record. Call inside the sign-up transaction. */
export async function createSelfClient(db: Db, firm: { id: string; name: string; contactEmail: string }) {
  return db.clientCompany.create({
    data: {
      consultingFirmId: firm.id,
      isSelf: true,
      ...selfClientFields({ firmName: firm.name, contactEmail: firm.contactEmail, registration: null, activeCertificationNames: [] }),
    },
  })
}

/**
 * Bring the self client in line with the firm's registration profile and
 * certifications. A no-op for consulting firms. Creates the record if it is
 * missing, so a contractor account can never be left with nothing to score.
 */
export async function syncSelfClient(consultingFirmId: string, db: Db = prisma, now: Date = new Date()): Promise<void> {
  const firm = await db.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { id: true, name: true, contactEmail: true, accountType: true },
  })
  if (!firm || firm.accountType !== AccountType.CONTRACTOR) return

  const [registration, certifications, existing] = await Promise.all([
    db.registrationProfile.findUnique({
      where: { consultingFirmId },
      select: { uei: true, cageCode: true, naicsCodes: true, setAsideCerts: true, samStatus: true, samExpiryDate: true },
    }),
    db.certification.findMany({
      where: { consultingFirmId, isArchived: false, OR: [{ expiryDate: null }, { expiryDate: { gte: now } }] },
      select: { name: true },
    }),
    db.clientCompany.findFirst({ where: { consultingFirmId, isSelf: true }, select: { id: true } }),
  ])

  const data = selfClientFields({
    firmName: firm.name,
    contactEmail: firm.contactEmail,
    registration,
    activeCertificationNames: certifications.map((c) => c.name),
  })
  if (existing) {
    await db.clientCompany.update({ where: { id: existing.id }, data: { ...data, isActive: true, archivedAt: null } })
  } else {
    await db.clientCompany.create({ data: { consultingFirmId, isSelf: true, ...data } })
  }
}

/** Route guard: refuse client-management actions on contractor accounts. */
export function requireConsultingAccount(req: Request, _res: Response, next: NextFunction) {
  const firmId = (req as AuthenticatedRequest).user?.consultingFirmId
  if (!firmId) return next()
  isContractorFirm(firmId)
    .then((contractor) => next(contractor ? new ForbiddenError(CONTRACTOR_NO_CLIENTS_MESSAGE) : undefined))
    .catch(next)
}
