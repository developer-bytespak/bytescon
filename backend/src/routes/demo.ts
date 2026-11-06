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
import { isPlatformAdmin, isPoolAdmin, requirePlatformAdmin, requirePoolAdmin } from '../middleware/platformAdmin'
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
import { US_STATES } from '../services/demoSampleData'
import { demoPoolStatus, MAX_PULL_REQUESTS, poolPullStatus, startPoolPull } from '../services/demoOpportunityPool'
import { logger } from '../utils/logger'
import { DEMO_BUSINESS_TYPES } from '../services/demoBusinessTypes'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)

const CreateSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z.string().min(1).max(200),
  email: z.string().min(3).max(320),
  days: z.number().int().optional(),
  state: z.string().max(40).optional(),
  otherLocation: z.string().max(100).optional(),
  businessType: z.string().max(40).optional(),
})
const ExtendSchema = z.object({ days: z.number().int() })
const PullSchema = z.object({ requests: z.number().int().min(1).max(MAX_PULL_REQUESTS) })

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
      data: { expiresAt: firm?.demoExpiresAt ?? null, isOperator: isPlatformAdmin(req.user?.email), isPoolAdmin: isPoolAdmin(req.user?.email) },
    })
  } catch (err) {
    next(err)
  }
})

/** The signed-in account's own records, so the tour can point at real screens and name real data. */
router.get('/tour', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const now = new Date()
    const open = { consultingFirmId, status: 'ACTIVE' as const, isDemo: false, responseDeadline: { gte: now } }
    const [clients, openOpportunities, top, proposal, contract] = await Promise.all([
      prisma.clientCompany.count({ where: { consultingFirmId, isActive: true } }),
      prisma.opportunity.count({ where: open }),
      prisma.bidDecision.findFirst({
        where: { consultingFirmId, recommendation: { in: ['BID_PRIME', 'BID_SUB'] }, opportunity: open },
        orderBy: { winProbability: 'desc' },
        select: { winProbability: true, recommendation: true, opportunity: { select: { id: true, title: true, agency: true, probabilityScore: true } }, clientCompany: { select: { name: true } } },
      }),
      prisma.proposal.findFirst({ where: { consultingFirmId }, orderBy: { createdAt: 'asc' }, select: { opportunityId: true, title: true, _count: { select: { sections: true } } } }),
      prisma.contract.findFirst({ where: { consultingFirmId, isArchived: false }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true, awardValue: true } }),
    ])
    const verifiedRequirements = proposal
      ? await prisma.matrixRequirement.count({ where: { verificationStatus: 'VERIFIED', matrix: { consultingFirmId, opportunityId: proposal.opportunityId } } })
      : 0
    res.json({
      success: true,
      data: {
        clients,
        openOpportunities,
        topOpportunity: top && { id: top.opportunity.id, title: top.opportunity.title, agency: top.opportunity.agency, baselineScore: top.opportunity.probabilityScore ?? 0, client: top.clientCompany.name, winProbability: top.winProbability ?? 0, recommendation: top.recommendation },
        proposal: proposal && { opportunityId: proposal.opportunityId, title: proposal.title, sections: proposal._count.sections, verifiedRequirements },
        contract: contract && { id: contract.id, title: contract.title, awardValue: contract.awardValue ? Number(contract.awardValue) : null },
      },
    })
  } catch (err) {
    next(err)
  }
})

router.use('/pool', requirePoolAdmin)

router.get('/pool', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: await poolPullStatus() })
  } catch (err) {
    next(err)
  }
})

// A pull takes minutes, so it answers straight away and the page watches its progress.
router.post('/pool/pull', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { requests, run } = await startPoolPull(parse(PullSchema, req.body).requests)
    await logAudit({ consultingFirmId: getTenantId(req), actorUserId: req.user?.userId ?? null, action: 'UPDATE', entityType: 'DemoPool', entityId: 'sam-pool', rationale: `On-demand SAM.gov pull of up to ${requests} requests` })
    res.status(202).json({ success: true, data: { requests } })
    run().catch((err: Error) => logger.error('On-demand pool pull failed', { error: err.message }))
  } catch (err) {
    next(err)
  }
})

router.use('/accounts', requirePlatformAdmin)

router.get('/accounts', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: { accounts: await listDemoAccounts(), pool: await demoPoolStatus(), defaultDays: DEFAULT_DEMO_DAYS, states: US_STATES.map(({ code, name }) => ({ code, name })), businessTypes: DEMO_BUSINESS_TYPES.map(({ key, label }) => ({ key, label })) } })
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
