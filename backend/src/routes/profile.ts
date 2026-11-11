// =============================================================
// Company profiles: how complete they are, and a contractor's own profile.
//
//   GET /api/profile/status       completeness of every profile the firm keeps
//                                 (a contractor's own company, or each client
//                                 of a consulting firm) — feeds the
//                                 "Complete your profile" card on every page
//   GET /api/profile/my-company   a contractor's own company profile
//   PUT /api/profile/my-company   update it (fields kept in Registration &
//                                 Compliance are synced from there, not here)
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
import { isContractorFirm } from '../services/contractorAccount'
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
    const status = await clientProfileStatus(consultingFirmId, self.id)
    res.json({ success: true, data: { company: self, status } })
  } catch (err) {
    next(err)
  }
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
}).strict()

router.put('/my-company', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const self = await ownCompany(consultingFirmId)
    const body = MyCompanySchema.parse(req.body)
    const updated = await prisma.clientCompany.update({ where: { id: self.id }, data: body })
    await logAudit({
      consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
      action: 'UPDATE', entityType: 'ClientCompany', entityId: self.id, rationale: 'Own company profile updated',
    })
    const status = await clientProfileStatus(consultingFirmId, self.id)
    res.json({ success: true, data: { company: updated, status } })
  } catch (err) {
    next(err)
  }
})

export default router
