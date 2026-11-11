// =============================================================
// Company profiles: how complete they are, and a contractor's own profile.
//
//   GET /api/profile/status       completeness of every profile the firm keeps
//                                 (a contractor's own company, or each client
//                                 of a consulting firm) — feeds the
//                                 "Complete your profile" card on every page
//   GET /api/profile/my-company   a contractor's own company profile
//   PUT /api/profile/my-company   update it — every field, including the
//                                 registration ones (UEI, CAGE, NAICS, SAM
//                                 status, set-asides), which are saved to the
//                                 registration profile so Registration &
//                                 Compliance shows the same values
//
// Scoring, analysis and proposals are refused until the profile they use is
// complete (services/profileGate.ts).
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { prisma } from '../config/database'
import { ForbiddenError, NotFoundError } from '../utils/errors'
import { logAudit } from '../services/auditService'
import { clientProfileStatuses, clientProfileStatus } from '../services/profileGate'
import { isContractorFirm, syncSelfClient } from '../services/contractorAccount'
import { cageField, dateField, ueiField } from './registration'
import { OPTIONAL_FIELDS, REQUIRED_FIELDS } from '../services/profileCompleteness'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)

router.get('/status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { accountType, clients } = await clientProfileStatuses(getTenantId(req))
    res.json({
      success: true,
      data: {
        accountType,
        complete: clients.length > 0 && clients.every((c) => c.complete),
        incompleteCount: clients.filter((c) => !c.complete).length,
        clients,
        fields: {
          required: REQUIRED_FIELDS.map(({ key, label }) => ({ key, label })),
          optional: OPTIONAL_FIELDS.map(({ key, label }) => ({ key, label })),
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

/** The contractor's own company record, or a refusal for a consulting firm. */
async function ownCompany(consultingFirmId: string) {
  if (!(await isContractorFirm(consultingFirmId))) {
    throw new ForbiddenError('My Company is for contractor accounts. Consulting firms keep a profile for each client.')
  }
  const self = await prisma.clientCompany.findFirst({ where: { consultingFirmId, isSelf: true } })
  if (!self) throw new NotFoundError('Company profile')
  return self
}

router.get('/my-company', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const self = await ownCompany(consultingFirmId)
    const [status, registration] = await Promise.all([
      clientProfileStatus(consultingFirmId, self.id),
      registrationOf(consultingFirmId),
    ])
    res.json({ success: true, data: { company: self, registration, status } })
  } catch (err) {
    next(err)
  }
})

const registrationOf = (consultingFirmId: string) => prisma.registrationProfile.findUnique({
  where: { consultingFirmId },
  select: { uei: true, cageCode: true, naicsCodes: true, samStatus: true, samExpiryDate: true, setAsideCerts: true },
})

const text = (max: number) => z.string().trim().max(max).nullable().optional()
const list = (item: number, max: number) => z.array(z.string().trim().min(1).max(item)).max(max).optional()

const MyCompanySchema = z.object({
  streetAddress: text(200),
  city: text(100),
  state: text(40),
  zipCode: text(20),
  phone: text(40),
  website: text(200),
  capabilityKeywords: list(60, 100),
  pscCodes: list(10, 100),
  contractVehicles: list(80, 50),
  employeeCount: z.number().int().nonnegative().nullable().optional(),
  annualRevenue: z.number().nonnegative().nullable().optional(),
  securityClearances: list(80, 50),
  isoCertifications: list(60, 25),
  agenciesOfInterest: list(120, 100),
  // Company name (the account's name) and the registration details. These are
  // saved to the firm and its registration profile, then copied to the
  // own-company record (contractorAccount.syncSelfClient).
  name: z.string().trim().min(2).max(120).optional(),
  uei: ueiField,
  cageCode: cageField,
  naicsCodes: z.array(z.string().trim().regex(/^\d{2,6}$/, 'NAICS codes are 2 to 6 digits')).max(200).optional(),
  samStatus: z.enum(['ACTIVE', 'PENDING', 'EXPIRED', 'NOT_REGISTERED']).optional(),
  samExpiryDate: dateField,
  setAsideCerts: z.array(z.string().trim().max(40)).max(50).optional(),
}).strict()

const REGISTRATION_KEYS = ['uei', 'cageCode', 'naicsCodes', 'samStatus', 'samExpiryDate', 'setAsideCerts'] as const

router.put('/my-company', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const self = await ownCompany(consultingFirmId)
    const { name, ...rest } = MyCompanySchema.parse(req.body)
    const registration: Record<string, unknown> = {}
    const profile: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined) continue
      ;((REGISTRATION_KEYS as readonly string[]).includes(key) ? registration : profile)[key] = value
    }

    await prisma.$transaction(async (tx) => {
      if (name) await tx.consultingFirm.update({ where: { id: consultingFirmId }, data: { name } })
      if (Object.keys(registration).length > 0) {
        await tx.registrationProfile.upsert({
          where: { consultingFirmId },
          create: { consultingFirmId, ...registration },
          update: registration,
        })
      }
      if (Object.keys(profile).length > 0) await tx.clientCompany.update({ where: { id: self.id }, data: profile })
      // Copies the name and registration details onto the own-company record.
      await syncSelfClient(consultingFirmId, tx)
    })
    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      action: 'UPDATE', entityType: 'ClientCompany', entityId: self.id,
      rationale: Object.keys(registration).length > 0 ? 'Own company profile and registration details updated' : 'Own company profile updated',
    })
    const [company, status, savedRegistration] = await Promise.all([
      prisma.clientCompany.findUniqueOrThrow({ where: { id: self.id } }),
      clientProfileStatus(consultingFirmId, self.id),
      registrationOf(consultingFirmId),
    ])
    res.json({ success: true, data: { company, registration: savedRegistration, status } })
  } catch (err) {
    next(err)
  }
})

export default router
