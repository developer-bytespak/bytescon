import { Router, Request, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import path from 'path'
import fs from 'fs'
import { prisma } from '../config/database'
import { config } from '../config/config'
import { scoreTier } from '../utils/scoreTier'
import { explainFeatures } from '../engines/probabilityEngine'
import { ProbabilityFeatures } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { UnauthorizedError, ValidationError, NotFoundError } from '../utils/errors'
import { requireClientPortalEntitlement, clientCompanyHasPortal } from '../middleware/clientPortalGate'
import { isTokenStale, revokeClientTokens } from '../services/tokenRevocation'
import { loadPortalAccount } from '../services/portalAccountAccess'
import { logger } from '../utils/logger'
import { upload } from '../middleware/upload'
import { normalizeEmail } from '../utils/email'

const router = Router()

/**
 * Build the score fields a client is allowed to see for an opportunity, from
 * THAT CLIENT'S own BidDecision.
 *
 * Never expose `Opportunity.probabilityScore` / `scoreBreakdown` directly on a
 * portal response: scoringWorker sets those to the firm-wide best-matching
 * client's values, so passing them through shows one client another client's Fit
 * score and score breakdown. Every portal surface that renders a Fit number must
 * go through here.
 */
function clientOwnScore(
  decision: { winProbability?: number | null; expectedValue?: unknown; explanationJson?: unknown },
  opportunityEstimatedValue?: unknown
): {
  probabilityScore: number | null
  expectedValue: number | null
  scoreBreakdown: { factorContributions: ReturnType<typeof explainFeatures>; probability: number } | null
} {
  const features = (decision.explanationJson as any)?.featureBreakdown ?? null

  // NULL, not 0, when this client has no probability: 0 renders as "Weak fit",
  // which asserts a judgement we have not made. fitDisplay(null) correctly says
  // "not yet scored".
  const probability = decision.winProbability ?? null

  // explainFeatures carries factor/label/weight/contribution/pct — the portal
  // sorts the "Why You're a Good Fit" panel by weight, so a bare
  // {factor,score,pct} shape would have silently broken that ordering. Same
  // source of truth as the engine, so labels/weights can never drift.
  // scoreBreakdown stays NULL when there are no features, so the UI's existing
  // `scoreBreakdown &&` guard suppresses the panel instead of rendering it empty.
  const scoreBreakdown =
    features && probability !== null
      ? { factorContributions: explainFeatures(features as ProbabilityFeatures), probability }
      : null

  // expectedValue must ALSO be this client's own. Opportunity.expectedValue is
  // written by scoringWorker as bestProbability × estimatedValue for the
  // best-matching client, so it is a linear function of another client's
  // probability: a client who can see both expectedValue and estimatedValue for
  // the same opportunity recovers the competitor's exact Fit score by division.
  // Prefer the client's own stored BidDecision.expectedValue; otherwise derive
  // it from their own probability.
  const ownExpected =
    decision.expectedValue != null
      ? Number(decision.expectedValue)
      : probability !== null && opportunityEstimatedValue != null
        ? probability * Number(opportunityEstimatedValue)
        : null

  return { probabilityScore: probability, expectedValue: ownExpected, scoreBreakdown }
}

// -------------------------------------------------------------
// Client JWT helpers — separate from consultant JWT
// -------------------------------------------------------------
interface ClientJwtPayload {
  clientPortalUserId: string
  clientCompanyId: string
  role: 'CLIENT'
  email: string
  iat?: number
  exp?: number
}

function generateClientToken(payload: ClientJwtPayload): string {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: '24h', algorithm: 'HS256' } as jwt.SignOptions)
}

async function authenticateClientJWT(req: Request, _res: Response, next: NextFunction): Promise<void> {
  // Whole body wrapped: the account lookup below awaits the DB, and in Express 4
  // a rejected promise from an async middleware is NOT routed to the error
  // handler — the request would hang with no response until the client gave up.
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new UnauthorizedError('No token provided'))
    }
    const token = authHeader.split(' ')[1]
    let payload: ClientJwtPayload
    try {
      payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as ClientJwtPayload
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) return next(new UnauthorizedError('Token expired'))
      return next(new UnauthorizedError('Invalid token'))
    }
    if (payload.role !== 'CLIENT') return next(new UnauthorizedError('Not a client token'))
    if (await isTokenStale('client', payload.clientPortalUserId, payload.iat)) {
      return next(new UnauthorizedError('Session expired, please sign in again'))
    }
    // Per-request account check, shared with the other two portal verifiers so
    // they cannot drift apart again. Covers both the portal user and its client
    // company being deactivated. See services/portalAccountAccess.ts for why
    // this cannot rely on the Redis cutoff alone.
    const account = await loadPortalAccount(payload.clientPortalUserId)
    if (!account?.active) {
      return next(new UnauthorizedError('Account access has been disabled'))
    }
    ;(req as any).clientUser = payload
    next()
  } catch (err) {
    next(err)
  }
}

// -------------------------------------------------------------
// POST /api/client-portal/auth/register
// Called by consultants to create portal access for a client contact
// -------------------------------------------------------------
router.post(
  '/auth/register',
  authenticateJWT,
  enforceTenantScope,
  requireRole('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId, email: rawEmail, password, firstName, lastName } = req.body
    if (!clientCompanyId || !rawEmail || !password || !firstName || !lastName) {
      throw new ValidationError('clientCompanyId, email, password, firstName, lastName all required')
    }
    const email = normalizeEmail(rawEmail)

    const consultingFirmId = getTenantId(req as any)
    const client = await prisma.clientCompany.findFirst({
      where: { id: clientCompanyId, consultingFirmId, isActive: true },
      select: { id: true },
    })
    if (!client) throw new NotFoundError('Client not found')

    const existing = await prisma.clientPortalUser.findUnique({ where: { email } })
    if (existing) throw new ValidationError('Email already registered')

    const passwordHash = await bcrypt.hash(password, 12)
    const user = await prisma.clientPortalUser.create({
      data: { clientCompanyId, email, passwordHash, firstName, lastName },
      select: { id: true, email: true, firstName: true, lastName: true, clientCompanyId: true, createdAt: true },
    })

    logger.info('Client portal user created', { id: user.id, clientCompanyId })
    res.status(201).json({ success: true, data: user })
  } catch (err) { next(err) }
  }
)

// -------------------------------------------------------------
// POST /api/client-portal/auth/login
// -------------------------------------------------------------
// Brute-force protection for the separate client-portal credential login
// (mirrors the consultant login limiter). Previously this endpoint was
// completely unthrottled, unlike the consultant /login route.
const clientLoginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Please try again later.' },
})

router.post('/auth/login', clientLoginRateLimit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email: rawEmail, password } = req.body
    if (!rawEmail || !password) throw new ValidationError('email and password required')
    const email = normalizeEmail(rawEmail)

    // The company's own isActive matters as much as the user's: DELETE
    // /api/clients/:id soft-deletes a ClientCompany, and without this a contact
    // of a "deleted" client could still mint a brand-new 24h token — the
    // per-request check would then reject every call, which looks like a broken
    // portal rather than a revoked account. Same neutral error either way so the
    // response can't be used to probe account or client state.
    const user = await prisma.clientPortalUser.findUnique({
      where: { email },
      include: { clientCompany: { select: { isActive: true } } },
    })
    if (!user || !user.isActive || !user.clientCompany?.isActive) {
      throw new UnauthorizedError('Invalid credentials')
    }

    const valid = await bcrypt.compare(password, user.passwordHash)
    if (!valid) throw new UnauthorizedError('Invalid credentials')

    // The portal is a firm add-on: when the firm's client_portal entitlement
    // lapses, its clients can't sign in. Checked after credential
    // verification so the response can't be used to probe for accounts.
    if (!(await clientCompanyHasPortal(user.clientCompanyId))) {
      return res.status(403).json({
        success: false,
        code: 'PORTAL_UNAVAILABLE',
        error: 'The client portal is currently unavailable. Please contact your consulting firm.',
      })
    }

    await prisma.clientPortalUser.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    })

    const token = generateClientToken({
      clientPortalUserId: user.id,
      clientCompanyId: user.clientCompanyId,
      role: 'CLIENT',
      email: user.email,
    })

    const clientCompany = await prisma.clientCompany.findUnique({
      where: { id: user.clientCompanyId },
      select: { id: true, name: true },
    })

    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        clientCompany,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/client-portal/dashboard
// -------------------------------------------------------------
router.get('/dashboard', authenticateClientJWT, requireClientPortalEntitlement, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload

    const [docRequirements, penalties, rewards, bidDecisions, client] = await Promise.all([
      prisma.documentRequirement.findMany({
        where: { clientCompanyId },
        // probabilityScore/scoreBreakdown are deliberately NOT selected here.
        // scoringWorker writes the firm-wide BEST-MATCHING client's score onto
        // Opportunity, so selecting them showed THIS client another client's Fit
        // score (the portal renders it as "Fit: …"). This client's own score is
        // overlaid below from their own BidDecision.
        include: { opportunity: { select: { id: true, title: true, responseDeadline: true, estimatedValue: true } } },
        orderBy: { dueDate: 'asc' },
      }),
      prisma.financialPenalty.findMany({
        where: { clientCompanyId },
        orderBy: { appliedAt: 'desc' },
        take: 20,
      }),
      prisma.complianceReward.findMany({
        where: { clientCompanyId, isRedeemed: false },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.bidDecision.findMany({
        where: { clientCompanyId },
        // Firm-wide score fields intentionally not selected — safeBidDecisions
        // overlays this client's own via clientOwnScore(). Leaving them out means
        // a future change to that mapping cannot silently re-expose them (the
        // scoreBreakdown JSON also embeds matchedClientId, naming the other
        // client the score belonged to).
        include: { opportunity: { select: { id: true, title: true, agency: true, responseDeadline: true, estimatedValue: true } } },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      prisma.clientCompany.findUnique({
        where: { id: clientCompanyId },
        include: { performanceStats: true },
      }),
    ])

    // This client's OWN decisions for the opportunities behind their document
    // requirements. Keyed lookup rather than reusing `bidDecisions` above, which
    // is capped at 10 and so would silently leave most requirements unscored.
    const requirementOppIds = [
      ...new Set(docRequirements.map((r: any) => r.opportunityId).filter(Boolean)),
    ] as string[]
    const ownDecisions = requirementOppIds.length
      ? await prisma.bidDecision.findMany({
          where: { clientCompanyId, opportunityId: { in: requirementOppIds } },
          select: { opportunityId: true, winProbability: true, expectedValue: true, explanationJson: true },
        })
      : []
    const ownScoreByOpp = new Map(ownDecisions.map((d: any) => [d.opportunityId, d]))

    const now = new Date()
    const enrichedRequirements = docRequirements.map((r: any) => {
      const daysUntil = Math.ceil((new Date(r.dueDate).getTime() - now.getTime()) / 86400000)
      let urgency: string
      if (r.status === 'SUBMITTED') urgency = 'SUBMITTED'
      else if (daysUntil < 0) urgency = 'OVERDUE'
      else if (daysUntil <= 7) urgency = 'URGENT'
      else if (daysUntil <= 14) urgency = 'SOON'
      else urgency = 'OK'

      // Attach the score only when this client has their own decision for it.
      // No decision => no Fit shown, rather than someone else's number. The
      // portal UI already guards on scoreBreakdown being present.
      const own = r.opportunityId ? ownScoreByOpp.get(r.opportunityId) : undefined
      const opportunity = r.opportunity
        ? own
          ? { ...r.opportunity, ...clientOwnScore(own, r.opportunity.estimatedValue) }
          // No decision of their own: emit explicit nulls so nothing downstream
          // can fall back to a firm-wide figure.
          : { ...r.opportunity, probabilityScore: null, expectedValue: null, scoreBreakdown: null }
        : r.opportunity

      return { ...r, opportunity, daysUntil, urgency }
    })

    const totalOutstandingFees = penalties
      .filter((p: any) => !p.isPaid)
      .reduce((sum: number, p: any) => sum + Number(p.amount), 0)

    // Override each opportunity's firm-wide aggregate score with THIS client's
    // own BidDecision score, so the dashboard never shows another client's
    // probability/breakdown as this client's. (See score-breakdown above.)
    const safeBidDecisions = bidDecisions.map((bd: any) => ({
      ...bd,
      // scoreTier already maps null/undefined to the UNSCORED tier, so pass the
      // real value through rather than coercing a missing probability to 0.
      fitTier: scoreTier(bd.winProbability ?? null),
      opportunity: bd.opportunity
        ? { ...bd.opportunity, ...clientOwnScore(bd, bd.opportunity.estimatedValue) }
        : bd.opportunity,
    }))

    res.json({
      success: true,
      data: {
        client,
        docRequirements: enrichedRequirements,
        penalties,
        rewards,
        bidDecisions: safeBidDecisions,
        showNumericScore: config.scoring.showNumericFitScore,
        summary: {
          totalDocuments: docRequirements.length,
          submitted: docRequirements.filter((r: any) => r.status === 'SUBMITTED').length,
          pending: docRequirements.filter((r: any) => r.status === 'PENDING').length,
          overdue: enrichedRequirements.filter((r: any) => r.urgency === 'OVERDUE').length,
          totalOutstandingFees,
          activeRewards: rewards.length,
        },
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/client-portal/score-breakdown/:opportunityId
// Returns score breakdown with plain-language explanations
// -------------------------------------------------------------
router.get('/score-breakdown/:opportunityId', authenticateClientJWT, requireClientPortalEntitlement, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload

    const bidDecision = await prisma.bidDecision.findFirst({
      where: { opportunityId: req.params.opportunityId, clientCompanyId },
      include: {
        opportunity: {
          select: {
            // expectedValue / probabilityScore / scoreBreakdown deliberately
            // omitted — all three are the firm-wide best-matching client's
            // values. estimatedValue is the solicitation's own public figure and
            // is safe. This client's numbers are overlaid below.
            id: true, title: true, agency: true, naicsCode: true, setAsideType: true,
            estimatedValue: true,
          },
        },
      },
    })

    if (!bidDecision) throw new NotFoundError('Score breakdown not found for this opportunity')

    // Source the Fit score + breakdown from THIS client's BidDecision, NOT the
    // opportunity-level aggregate. opportunity.probabilityScore / scoreBreakdown
    // hold the MAX across all of the firm's clients (scoringWorker keeps only the
    // best-matching client), so surfacing them here exposed another client's
    // score. winProbability and probabilityScore share the same 0-1 scale.
    const own = clientOwnScore(bidDecision, bidDecision.opportunity?.estimatedValue)
    const factorContributions = own.scoreBreakdown?.factorContributions ?? []
    const clientProbability = own.probabilityScore
    const breakdown = {
      factorContributions,
      probability: clientProbability,
      generatedAt: new Date().toISOString(),
    }

    // Build plain-language explanations per factor
    const plainExplanations = factorContributions.map((f) => ({
      ...f,
      plainText: buildPlainExplanation(f.factor, f.score),
    }))

    res.json({
      success: true,
      data: {
        // Override the opportunity-level aggregate with this client's own values
        // so the existing frontend contract keeps working but shows correct data.
        opportunity: { ...bidDecision.opportunity, probabilityScore: clientProbability, scoreBreakdown: breakdown },
        breakdown,
        plainExplanations,
        summary: buildSummary(clientProbability),
        fitTier: scoreTier(clientProbability),
        showNumericScore: config.scoring.showNumericFitScore,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/client-portal/rewards
// -------------------------------------------------------------
router.get('/rewards', authenticateClientJWT, requireClientPortalEntitlement, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload
    const rewards = await prisma.complianceReward.findMany({
      where: { clientCompanyId },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, data: rewards })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// PUT /api/client-portal/doc-requirements/:id/submit
// Allows client users to mark their own requirement as submitted.
// -------------------------------------------------------------
// -------------------------------------------------------------
// GET /api/client-portal/notification-preferences
// Returns the current user's notification preferences
// -------------------------------------------------------------
router.get(
  '/notification-preferences',
  authenticateClientJWT,
  requireClientPortalEntitlement,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientPortalUserId } = (req as any).clientUser as ClientJwtPayload
      const user = await prisma.clientPortalUser.findUnique({
        where: { id: clientPortalUserId },
        select: {
          notifyDeliverables: true,
          notifyDeadlines: true,
          notifyApprovals: true,
          smsPhone: true,
          smsEnabled: true,
          email: true,
        },
      })
      if (!user) throw new NotFoundError('User not found')
      res.json({ success: true, data: user })
    } catch (err) { next(err) }
  }
)

// -------------------------------------------------------------
// PUT /api/client-portal/notification-preferences
// Updates the current user's notification preferences
// -------------------------------------------------------------
router.put(
  '/notification-preferences',
  authenticateClientJWT,
  requireClientPortalEntitlement,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientPortalUserId } = (req as any).clientUser as ClientJwtPayload
      const { notifyDeliverables, notifyDeadlines, notifyApprovals, smsPhone, smsEnabled } = req.body

      const updated = await prisma.clientPortalUser.update({
        where: { id: clientPortalUserId },
        data: {
          notifyDeliverables: notifyDeliverables ?? undefined,
          notifyDeadlines: notifyDeadlines ?? undefined,
          notifyApprovals: notifyApprovals ?? undefined,
          smsPhone: smsPhone === '' ? null : (smsPhone ?? undefined),
          smsEnabled: smsEnabled ?? undefined,
        },
        select: {
          notifyDeliverables: true,
          notifyDeadlines: true,
          notifyApprovals: true,
          smsPhone: true,
          smsEnabled: true,
        },
      })
      res.json({ success: true, data: updated })
    } catch (err) { next(err) }
  }
)

router.put(
  '/doc-requirements/:id/submit',
  authenticateClientJWT,
  requireClientPortalEntitlement,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload

      const existing = await prisma.documentRequirement.findFirst({
        where: { id: req.params.id, clientCompanyId },
        select: { id: true, status: true, submittedAt: true },
      })
      if (!existing) throw new NotFoundError('Document requirement not found')

      if (existing.status === 'SUBMITTED') {
        return res.json({ success: true, data: { id: existing.id, status: existing.status } })
      }

      const updated = await prisma.documentRequirement.update({
        where: { id: req.params.id },
        data: {
          status: 'SUBMITTED',
          submittedAt: existing.submittedAt || new Date(),
        },
      })

      res.json({ success: true, data: updated })
    } catch (err) {
      next(err)
    }
  }
)

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function buildPlainExplanation(factor: string, score: number): string {
  const pct = Math.round(score * 100)
  const map: Record<string, (p: number) => string> = {
    naicsOverlapScore: (p) => p >= 70
      ? `Your NAICS industry codes align well with this contract (${p}% match). You operate in the right space.`
      : `Your industry codes are a partial match (${p}%). This contract is somewhat outside your core focus area.`,
    setAsideAlignmentScore: (p) => p >= 80
      ? `Your business certifications (SDVOSB, WOSB, etc.) qualify you for this set-aside contract (${p}%).`
      : p === 0
      ? `This contract is set aside for certifications you don't currently hold.`
      : `Your certifications partially align with this contract's set-aside requirements (${p}%).`,
    incumbentWeaknessScore: (p) => p >= 60
      ? `The current contract holder appears weak or there is no strong incumbent, giving you a good opening (${p}%).`
      : `There is a strong incumbent contractor on this award, which reduces new entrant chances (${p}%).`,
    documentAlignmentScore: (p) => p >= 60
      ? `The work scope described in the solicitation documents matches your capabilities well (${p}%).`
      : `The technical requirements in this solicitation are a stretch from your typical work (${p}%).`,
    agencyAlignmentScore: (p) => p >= 60
      ? `This agency has a strong history of awarding to companies like yours (${p}% favorable rate).`
      : `This agency awards fewer contracts to small businesses similar to yours (${p}%).`,
    awardSizeFitScore: (p) => p >= 60
      ? `The contract value is well within your company's typical capacity to perform (${p}%).`
      : `This contract may be larger or smaller than what your company typically handles (${p}%).`,
    competitionDensityScore: (p) => p >= 60
      ? `There are relatively few competitors for this contract, improving your odds (${p}%).`
      : `This contract is expected to attract many bidders, increasing competition (${p}%).`,
    historicalDistribution: (p) => p >= 50
      ? `Historical data shows companies with your profile have won similar contracts (${p}% base rate).`
      : `Historically, companies like yours have a lower win rate on similar contracts (${p}% base rate).`,
  }
  return (map[factor] ?? ((p: number) => `Score: ${p}%`))(pct)
}

function buildSummary(probability: number | null): string {
  // A decision can exist with no probability recorded. Say so rather than
  // implying a 0% fit, which reads as a judgement we have not made.
  if (probability == null || Number.isNaN(probability)) {
    return 'This opportunity has not been scored for your company yet. Your consultant will review it and follow up.'
  }
  const pct = Math.round(probability * 100)
  // Directional FIT signal only — NOT a literal win probability and NOT a
  // client-facing bid threshold (platform scores are uncalibrated pending
  // outcome data). The consultant makes the actual bid decision.
  const tail = ' This is a directional fit estimate — not a win prediction or guarantee of award; your consultant makes the final bid decision.'
  if (pct >= 65) return `Strong fit (${pct}/100) — this opportunity aligns well with your company's profile.${tail}`
  if (pct >= 45) return `Solid fit (${pct}/100) — a competitive potential match.${tail}`
  if (pct >= 25) return `Partial fit (${pct}/100) — some alignment; worth a closer look.${tail}`
  return `Limited fit (${pct}/100) — low alignment with your company's profile.${tail}`
}

// -------------------------------------------------------------
// GET /api/client-portal/opportunities
// Returns opportunities matched to client's NAICS codes + their decline status
// -------------------------------------------------------------
router.get('/opportunities', authenticateClientJWT, requireClientPortalEntitlement, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload
    const client = await prisma.clientCompany.findUnique({
      where: { id: clientCompanyId },
      select: { naicsCodes: true, consultingFirmId: true },
    })
    if (!client) throw new NotFoundError('Client')

    const declines = await prisma.clientOpportunityDecline.findMany({
      where: { clientCompanyId },
      select: { opportunityId: true },
    })
    const declinedIds = new Set(declines.map((d) => d.opportunityId))

    const where: any = {
      consultingFirmId: client.consultingFirmId,
      responseDeadline: { gte: new Date() },
    }
    if (client.naicsCodes.length > 0) {
      where.naicsCode = { in: client.naicsCodes }
    }

    const opps = await prisma.opportunity.findMany({
      where,
      // Ordering by the firm-wide score is fine — it is a relevance proxy and
      // exposes no number — but the score itself must NOT be selected: it
      // belongs to whichever client matched best, not necessarily this one.
      orderBy: { probabilityScore: 'desc' },
      take: 50,
      select: {
        id: true, title: true, agency: true, naicsCode: true,
        setAsideType: true, noticeType: true, estimatedValue: true,
        responseDeadline: true, recompeteFlag: true,
        description: true, placeOfPerformance: true,
      },
    })

    // Overlay this client's own win probability where they have a decision.
    // Absent one, probabilityScore stays null and the UI renders "not yet
    // scored" rather than another client's Fit score.
    const oppOwnDecisions = opps.length
      ? await prisma.bidDecision.findMany({
          where: { clientCompanyId, opportunityId: { in: opps.map((o) => o.id) } },
          select: { opportunityId: true, winProbability: true },
        })
      : []
    const ownProbByOpp = new Map(oppOwnDecisions.map((d: any) => [d.opportunityId, d.winProbability]))

    const result = opps.map((o) => ({
      ...o,
      isDeclined: declinedIds.has(o.id),
      probabilityScore: ownProbByOpp.get(o.id) ?? null,
    }))
    res.json({ success: true, data: result })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// POST /api/client-portal/uploads   — client uploads a file to consultant
// -------------------------------------------------------------
router.post('/uploads', authenticateClientJWT, requireClientPortalEntitlement, upload.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload
    if (!req.file) throw new ValidationError('File required')
    const { title, notes } = req.body

    const client = await prisma.clientCompany.findUnique({
      where: { id: clientCompanyId },
      select: { consultingFirmId: true },
    })
    if (!client) throw new NotFoundError('Client')

    const record = await prisma.clientPortalUpload.create({
      data: {
        clientCompanyId,
        consultingFirmId: client.consultingFirmId,
        fileName: req.file.originalname,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        storageKey: req.file.filename,
        title: title || req.file.originalname,
        notes: notes || null,
      },
    })
    res.status(201).json({ success: true, data: record })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/client-portal/uploads   — list files the client has uploaded
// -------------------------------------------------------------
router.get('/uploads', authenticateClientJWT, requireClientPortalEntitlement, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload
    const uploads = await prisma.clientPortalUpload.findMany({
      where: { clientCompanyId },
      orderBy: { createdAt: 'desc' },
    })
    res.json({ success: true, data: uploads })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// GET /api/client-portal/uploads/:clientId  (ADMIN) — view uploads for a client
// -------------------------------------------------------------
router.get(
  '/admin/uploads/:clientId',
  authenticateJWT,
  enforceTenantScope,
  requireRole('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req as any)
      const client = await prisma.clientCompany.findFirst({
        where: { id: req.params.clientId, consultingFirmId },
      })
      if (!client) throw new NotFoundError('Client')

      const uploads = await prisma.clientPortalUpload.findMany({
        where: { clientCompanyId: req.params.clientId },
        orderBy: { createdAt: 'desc' },
      })
      res.json({ success: true, data: uploads })
    } catch (err) { next(err) }
  }
)

// -------------------------------------------------------------
// GET /api/client-portal/admin/users/:clientId  (ADMIN)
// List all portal users for a client — so consultants can see who has access
// -------------------------------------------------------------
router.get(
  '/admin/users/:clientId',
  authenticateJWT,
  enforceTenantScope,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req as any)
      const client = await prisma.clientCompany.findFirst({
        where: { id: req.params.clientId, consultingFirmId },
        select: { id: true },
      })
      if (!client) throw new NotFoundError('Client')

      const users = await prisma.clientPortalUser.findMany({
        where: { clientCompanyId: req.params.clientId },
        select: {
          id: true, email: true, firstName: true, lastName: true,
          isActive: true, lastLoginAt: true, createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      })

      res.json({ success: true, data: users })
    } catch (err) { next(err) }
  }
)

// -------------------------------------------------------------
// PUT /api/client-portal/admin/users/:userId/reset-password  (ADMIN)
// Consultant sets a new temporary password for a locked-out client
// -------------------------------------------------------------
router.put(
  '/admin/users/:userId/reset-password',
  authenticateJWT,
  enforceTenantScope,
  requireRole('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req as any)
      const { newPassword } = req.body
      if (!newPassword || newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' })
      }

      // Verify this user belongs to a client under this firm
      const user = await prisma.clientPortalUser.findFirst({
        where: { id: req.params.userId, clientCompany: { consultingFirmId } },
        select: { id: true, email: true, clientCompany: { select: { isActive: true } } },
      })
      if (!user) throw new NotFoundError('Portal user not found')

      // Do not resurrect access to a soft-deleted client. This handler used to
      // set isActive:true unconditionally, so a password reset silently undid a
      // deactivation — including for contacts of a client that had been deleted.
      if (!user.clientCompany?.isActive) {
        return res.status(409).json({
          success: false,
          error: 'This client is inactive. Reactivate the client before restoring portal access.',
          code: 'CLIENT_INACTIVE',
        })
      }

      const passwordHash = await bcrypt.hash(newPassword, 12)
      await prisma.clientPortalUser.update({
        where: { id: req.params.userId },
        data: { passwordHash, isActive: true },
      })

      // Terminate existing sessions. Without this a password reset changed
      // nothing for whoever already held a token: client tokens live 24h, so
      // the person being locked out kept full access for up to a day after the
      // consultant "reset" their password.
      await revokeClientTokens(req.params.userId)

      logger.info('Portal user password reset by consultant', { userId: req.params.userId })
      res.json({ success: true, data: { message: `Password reset for ${user.email}` } })
    } catch (err) { next(err) }
  }
)

// -------------------------------------------------------------
// PUT /api/client-portal/admin/users/:userId/toggle-active  (ADMIN)
// Enable or disable a portal user's access
// -------------------------------------------------------------
router.put(
  '/admin/users/:userId/toggle-active',
  authenticateJWT,
  enforceTenantScope,
  requireRole('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req as any)
      const user = await prisma.clientPortalUser.findFirst({
        where: { id: req.params.userId, clientCompany: { consultingFirmId } },
        select: { id: true, isActive: true },
      })
      if (!user) throw new NotFoundError('Portal user not found')

      const updated = await prisma.clientPortalUser.update({
        where: { id: req.params.userId },
        data: { isActive: !user.isActive },
        select: { id: true, isActive: true },
      })

      // Deactivation must actually end access. isActive was only consulted at
      // login, so a disabled user's existing 24h token kept working — the
      // offboarding control in the UI did nothing until the token expired.
      if (!updated.isActive) {
        await revokeClientTokens(req.params.userId)
        logger.info('Portal user deactivated — sessions revoked', { userId: req.params.userId })
      }

      res.json({ success: true, data: updated })
    } catch (err) { next(err) }
  }
)

// -------------------------------------------------------------
// GET /api/client-portal/admin/uploads/:clientId/download/:uploadId  (ADMIN)
// -------------------------------------------------------------
router.get(
  '/admin/uploads/:clientId/download/:uploadId',
  authenticateJWT,
  enforceTenantScope,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req as any)
      const record = await prisma.clientPortalUpload.findFirst({
        where: { id: req.params.uploadId, consultingFirmId },
      })
      if (!record) throw new NotFoundError('Upload not found')

      const filePath = path.join(process.cwd(), 'uploads', record.storageKey)
      if (!fs.existsSync(filePath)) throw new NotFoundError('File not found on disk')
      res.download(filePath, record.fileName)
    } catch (err) { next(err) }
  }
)

export default router
