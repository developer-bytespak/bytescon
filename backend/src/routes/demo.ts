// =============================================================
// /api/demo: the demo site's status, and the operators' account screen.
//
// Only mounted on the demo flavour. Account management crosses firms on purpose,
// so it's limited to operators on PLATFORM_ADMIN_EMAILS.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { isPlatformAdmin, requirePlatformAdmin } from '../middleware/platformAdmin'
import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import { ValidationError } from '../utils/errors'
import {
  createDemoAccount,
  DEFAULT_DEMO_DAYS,
  endDemoAccount,
  extendDemoAccount,
  listDemoAccounts,
  resetDemoPassword,
} from '../services/demoAccounts'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)

const CreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  email: z.string().min(3).max(320),
  days: z.number().int().optional(),
  state: z.string().optional(),
})
const ExtendSchema = z.object({ days: z.number().int() })

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body)
  if (!result.success) throw new ValidationError(result.error.errors[0]?.message ?? 'Invalid request')
  return result.data
}

const audit = (req: AuthenticatedRequest, action: 'CREATE' | 'UPDATE', firmId: string, rationale: string) =>
  logAudit({ consultingFirmId: getTenantId(req), actorUserId: req.user?.userId ?? null, action, entityType: 'DemoAccount', entityId: firmId, rationale })

/** What the banner and the tour need to know about the signed-in account. */
router.get('/status', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const firm = await prisma.consultingFirm.findUnique({
      where: { id: getTenantId(req) },
      select: { demoExpiresAt: true },
    })
    res.json({
      success: true,
      data: { expiresAt: firm?.demoExpiresAt ?? null, isOperator: isPlatformAdmin(req.user?.email) },
    })
  } catch (err) {
    next(err)
  }
})

router.use('/accounts', requirePlatformAdmin)

router.get('/accounts', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { accounts: await listDemoAccounts(), defaultDays: DEFAULT_DEMO_DAYS } })
  } catch (err) {
    next(err)
  }
})

// The password is in this response once and never stored in readable form.
router.post('/accounts', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const created = await createDemoAccount(parse(CreateSchema, req.body))
    await audit(req, 'CREATE', created.firmId, `Demo account created until ${created.expiresAt.toISOString()}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) {
    next(err)
  }
})

router.post('/accounts/:firmId/extend', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { days } = parse(ExtendSchema, req.body)
    const expiresAt = await extendDemoAccount(req.params.firmId, days)
    await audit(req, 'UPDATE', req.params.firmId, `Demo extended until ${expiresAt.toISOString()}`)
    res.json({ success: true, data: { expiresAt } })
  } catch (err) {
    next(err)
  }
})

router.post('/accounts/:firmId/end', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await endDemoAccount(req.params.firmId)
    await audit(req, 'UPDATE', req.params.firmId, 'Demo ended by an operator')
    res.json({ success: true, data: { ended: true } })
  } catch (err) {
    next(err)
  }
})

router.post('/accounts/:firmId/reset-password', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const reset = await resetDemoPassword(req.params.firmId)
    await audit(req, 'UPDATE', req.params.firmId, 'Demo password reset by an operator')
    res.json({ success: true, data: reset })
  } catch (err) {
    next(err)
  }
})

export default router
