// =============================================================
// Beta Access + Feedback Routes
//
// Public endpoints (no auth):
//   POST /api/beta/request  — capture waitlist signup
//
// Authenticated firm admin endpoints:
//   POST /api/beta/feedback — submit NPS-light feedback
//   GET  /api/beta/metrics  — aggregated activity for the firm (admin only)
// =============================================================
import { Router, Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { ValidationError } from '../utils/errors'
import { EmailField } from '../utils/email'

const router = Router()

// ---------------------------------------------------------------
// POST /api/beta/request — public waitlist signup
// ---------------------------------------------------------------
const RequestSchema = z.object({
  email: EmailField.refine((s) => s.length <= 254, 'Email too long'),
  firmName: z.string().max(200).optional(),
  contactName: z.string().max(200).optional(),
  naicsFocus: z.string().max(20).optional(),
  source: z.string().max(50).optional(),
  notes: z.string().max(2000).optional(),
})

router.post('/request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = RequestSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0]?.message ?? 'Invalid input')
    }
    const { email, firmName, contactName, naicsFocus, source, notes } = parsed.data

    // Best-effort IP capture (works through nginx + Caddy with X-Forwarded-For)
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || null
    const userAgent = (req.headers['user-agent'] as string) || null

    // Idempotent re-signup — same email re-submitting just updates timestamps + notes.
    const existing = await prisma.betaAccessRequest.findFirst({ where: { email } })
    if (existing) {
      await prisma.betaAccessRequest.update({
        where: { id: existing.id },
        data: {
          firmName: firmName ?? existing.firmName,
          contactName: contactName ?? existing.contactName,
          naicsFocus: naicsFocus ?? existing.naicsFocus,
          source: source ?? existing.source,
          notes: notes ?? existing.notes,
          ipAddress: ip ?? existing.ipAddress,
          userAgent: userAgent ?? existing.userAgent,
        },
      })
      logger.info('Beta access request updated (re-submission)', { email, source })
      return res.status(200).json({
        success: true,
        message: 'Thanks — we already have your request on file. We\'ll be in touch.',
      })
    }

    const created = await prisma.betaAccessRequest.create({
      data: {
        email,
        firmName: firmName ?? null,
        contactName: contactName ?? null,
        naicsFocus: naicsFocus ?? null,
        source: source ?? 'landing',
        notes: notes ?? null,
        ipAddress: ip,
        userAgent,
      },
    })
    logger.info('Beta access request created', { id: created.id, email, firmName, source })

    return res.status(201).json({
      success: true,
      message: 'Thanks for your interest. We\'ll review and reach out within 2 business days.',
    })
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------
// Authenticated admin endpoints below
// ---------------------------------------------------------------
const authedRouter = Router()
authedRouter.use(authenticateJWT, enforceTenantScope)

// POST /api/beta/feedback — submit NPS-light feedback (any role)
const FeedbackSchema = z.object({
  npsScore: z.number().int().min(0).max(10),
  killFeature: z.string().max(2000).optional(),
  addFeature: z.string().max(2000).optional(),
  freeText: z.string().max(5000).optional(),
})

authedRouter.post('/feedback', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId
    if (!userId) throw new ValidationError('Missing user context')

    const parsed = FeedbackSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new ValidationError(parsed.error.errors[0]?.message ?? 'Invalid input')
    }

    const created = await prisma.betaFeedback.create({
      data: {
        consultingFirmId,
        submittedByUserId: userId,
        npsScore: parsed.data.npsScore,
        killFeature: parsed.data.killFeature ?? null,
        addFeature: parsed.data.addFeature ?? null,
        freeText: parsed.data.freeText ?? null,
      },
    })
    logger.info('Beta feedback submitted', {
      consultingFirmId,
      submittedByUserId: userId,
      npsScore: parsed.data.npsScore,
      feedbackId: created.id,
    })
    res.status(201).json({ success: true, data: { id: created.id } })
  } catch (err) {
    next(err)
  }
})

// GET /api/beta/metrics — aggregated firm activity (ADMIN only)
authedRouter.get('/metrics', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const since = req.query.since
      ? new Date(req.query.since as string)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // 30d default

    const [
      opportunitiesScored,
      decisionsMade,
      submissions,
      proposalDrafts,
      activeClients,
      feedback,
    ] = await Promise.all([
      // Opportunity has no scoredAt; use updatedAt as proxy for "scored within window"
      // (the scoring worker writes probabilityScore + sets isScored, which updates the row).
      prisma.opportunity.count({ where: { consultingFirmId, isScored: true, updatedAt: { gte: since } } }),
      // BidDecision uses createdAt for "when the decision was first made".
      prisma.bidDecision.count({ where: { consultingFirmId, createdAt: { gte: since } } }),
      prisma.submissionRecord.count({ where: { consultingFirmId, submittedAt: { gte: since } } }),
      prisma.opportunity.count({ where: { consultingFirmId, savedProposalDraftAt: { gte: since } } }),
      prisma.clientCompany.count({ where: { consultingFirmId, isActive: true } }),
      prisma.betaFeedback.findMany({
        where: { consultingFirmId, createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, npsScore: true, killFeature: true, addFeature: true, freeText: true, createdAt: true },
      }),
    ])

    const npsScores = feedback.map((f) => f.npsScore)
    const avgNps = npsScores.length > 0
      ? Math.round((npsScores.reduce((sum, n) => sum + n, 0) / npsScores.length) * 10) / 10
      : null

    res.json({
      success: true,
      data: {
        windowDays: Math.round((Date.now() - since.getTime()) / 86400000),
        opportunitiesScored,
        decisionsMade,
        submissions,
        proposalDrafts,
        activeClients,
        feedback: {
          count: feedback.length,
          avgNps,
          recent: feedback,
        },
      },
    })
  } catch (err) {
    next(err)
  }
})

router.use('/', authedRouter)

export default router
