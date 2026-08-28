import { Router, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError, ValidationError } from '../utils/errors'
import { logger } from '../utils/logger'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

// GET /api/rewards
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { clientCompanyId } = req.query

    // Verify client belongs to this firm if filtering
    if (clientCompanyId) {
      const client = await prisma.clientCompany.findFirst({ where: { id: clientCompanyId as string, consultingFirmId } })
      if (!client) throw new NotFoundError('Client not found')
    }

    // Get all client IDs belonging to this firm
    const clients = await prisma.clientCompany.findMany({
      where: clientCompanyId
        ? { id: clientCompanyId as string, consultingFirmId }
        : { consultingFirmId },
      select: { id: true },
    })
    const clientIds = clients.map((c: any) => c.id)

    const rewards = await prisma.complianceReward.findMany({
      where: { clientCompanyId: { in: clientIds } },
      orderBy: { createdAt: 'desc' },
    })

    res.json({ success: true, data: rewards })
  } catch (err) { next(err) }
})

// POST /api/rewards — manually grant a reward
router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { clientCompanyId, rewardType, description, value, percentDiscount, expiresAt, triggerReason } = req.body

    if (!clientCompanyId) throw new ValidationError('clientCompanyId required')
    if (!rewardType) throw new ValidationError('rewardType required')
    if (!description) throw new ValidationError('description required')
    if (!triggerReason) throw new ValidationError('triggerReason required')

    const client = await prisma.clientCompany.findFirst({ where: { id: clientCompanyId, consultingFirmId } })
    if (!client) throw new NotFoundError('Client not found')

    const reward = await prisma.complianceReward.create({
      data: {
        clientCompanyId,
        rewardType,
        description,
        value: value ? parseFloat(value) : null,
        percentDiscount: percentDiscount ? parseFloat(percentDiscount) : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        triggerReason,
        isRedeemed: false,
      },
    })

    logger.info('Compliance reward granted', { rewardId: reward.id, clientCompanyId })
    res.status(201).json({ success: true, data: reward })
  } catch (err) { next(err) }
})

// POST /api/rewards/evaluate/:clientCompanyId — auto-evaluate and grant rewards
router.post('/evaluate/:clientCompanyId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { clientCompanyId } = req.params

    const client = await prisma.clientCompany.findFirst({
      where: { id: clientCompanyId, consultingFirmId },
      include: { performanceStats: true },
    })
    if (!client) throw new NotFoundError('Client not found')

    const submissions = await prisma.submissionRecord.findMany({
      where: { clientCompanyId, consultingFirmId },
      orderBy: { submittedAt: 'desc' },
    })

    const existing = await prisma.complianceReward.findMany({
      where: { clientCompanyId },
      select: { triggerReason: true },
    })
    const alreadyGranted = new Set(existing.map((r: any) => r.triggerReason))

    const granted: any[] = []

    // Check FIRST_ONTIME: first on-time submission
    if (!alreadyGranted.has('FIRST_ONTIME')) {
      const hasOnTime = submissions.some((s: any) => s.wasOnTime)
      if (hasOnTime) {
        const reward = await prisma.complianceReward.create({
          data: {
            clientCompanyId,
            rewardType: 'SUBSCRIPTION_CREDIT',
            description: 'First On-Time Submission Reward: $50 account credit',
            value: 50,
            triggerReason: 'FIRST_ONTIME',
            expiresAt: new Date(Date.now() + 90 * 86400000), // 90 days
          },
        })
        granted.push(reward)
        logger.info('FIRST_ONTIME reward granted', { clientCompanyId })
      }
    }

    // Check 5_CONSECUTIVE_ONTIME
    if (!alreadyGranted.has('5_CONSECUTIVE_ONTIME') && submissions.length >= 5) {
      const last5 = submissions.slice(0, 5)
      if (last5.every((s: any) => s.wasOnTime)) {
        const reward = await prisma.complianceReward.create({
          data: {
            clientCompanyId,
            rewardType: 'FEE_DISCOUNT',
            description: '5 Consecutive On-Time Submissions: 10% late fee discount for next 6 months',
            percentDiscount: 10,
            triggerReason: '5_CONSECUTIVE_ONTIME',
            expiresAt: new Date(Date.now() + 180 * 86400000),
          },
        })
        granted.push(reward)
        logger.info('5_CONSECUTIVE_ONTIME reward granted', { clientCompanyId })
      }
    }

    // Check PERFECT_COMPLIANCE: 100% on-time rate with >= 10 submissions
    if (!alreadyGranted.has('PERFECT_COMPLIANCE') && submissions.length >= 10) {
      const onTimeCount = submissions.filter((s: any) => s.wasOnTime).length
      if (onTimeCount === submissions.length) {
        const reward = await prisma.complianceReward.create({
          data: {
            clientCompanyId,
            rewardType: 'PERK',
            description: 'Perfect Compliance Award: Priority opportunity matching and dedicated advisor access',
            triggerReason: 'PERFECT_COMPLIANCE',
          },
        })
        granted.push(reward)
        logger.info('PERFECT_COMPLIANCE reward granted', { clientCompanyId })
      }
    }

    res.json({ success: true, data: { granted, count: granted.length } })
  } catch (err) { next(err) }
})

// PUT /api/rewards/:id/redeem
router.put('/:id/redeem', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const reward = await prisma.complianceReward.findUnique({ where: { id: req.params.id } })
    if (!reward) throw new NotFoundError('Reward not found')

    // Verify belongs to this firm
    const client = await prisma.clientCompany.findFirst({ where: { id: reward.clientCompanyId, consultingFirmId } })
    if (!client) throw new NotFoundError('Reward not found')

    const updated = await prisma.complianceReward.update({
      where: { id: req.params.id },
      data: { isRedeemed: true, redeemedAt: new Date() },
    })

    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

export default router
