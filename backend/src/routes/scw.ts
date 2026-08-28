// =============================================================
// SCW (Subcontracting Workflow) Routes
//
// Per SUBCONTRACTING_WORKFLOW_SPEC.md §5.
// Tenant-scoped via authenticateJWT + enforceTenantScope. All responses
// follow the house {success, data} envelope; errors flow through
// errorHandler middleware via next(err).
// =============================================================

import { Router, Response, NextFunction } from 'express'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { findLikelyPrimes } from '../services/scw/likelyPrimes'
import { analyzeSubawards } from '../services/scw/subawardAnalysis'
import { draftScwOutreach, OutreachType } from '../services/scw/outreachGenerator'
import { getNotificationInbox } from '../services/scw/notifications'
import { prisma } from '../config/database'
import { logAudit } from '../services/auditService'
import { ValidationError, NotFoundError } from '../utils/errors'

const VALID_OUTREACH_TYPES: OutreachType[] = ['cold_first_touch', 'warm_follow_up', 'urgent_deadline_driven']

// USAspending UEIs are 12 chars of [A-Z0-9]. We accept that exact shape on
// the :identifier route; anything else is treated as a URL-encoded prime
// recipient name (the corpus has UEI on only ~3% of rows, so name-keyed
// lookups must be supported).
const UEI_PATTERN = /^[A-Z0-9]{12}$/

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase, requireAddon('teaming_suite'))

/**
 * GET /api/scw/opportunities/:opportunityId/primes
 *
 * Returns the top-10 candidate primes for the given opportunity, ranked
 * by composite confidence. Each prime carries its decomposition, contact
 * (when known), SDVOSB status, and explicit dataQuality warnings — per
 * spec §2 "no silent failures".
 *
 * 404 when the opportunity does not exist for the calling tenant — the
 * NotFoundError thrown by the service surfaces via the errorHandler.
 */
router.get(
  '/opportunities/:opportunityId/primes',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const opportunityId = req.params.opportunityId

      const primes = await findLikelyPrimes({ opportunityId, consultingFirmId })

      res.json({ success: true, data: primes })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /api/scw/primes/:identifier/subaward-analysis
 *
 * Per spec §3 SCW-2. The :identifier may be either:
 *   - a USAspending UEI (12 chars [A-Z0-9]), OR
 *   - a URL-encoded prime recipient name (fallback for the ~97% of corpus
 *     rows that lack a UEI).
 *
 * Optional query: ?lookbackYears=3 (default 3, spec §3 SCW-2 default).
 *
 * Returns the SubawardAnalysis envelope including explicit warnings for
 * every field the underlying corpus cannot currently populate (see R4 in
 * docs/scw/data-layer-introspection.md §9). The data the corpus DOES have
 * (total subaward $, average sub size, sample size) ships as real values.
 *
 * Not tenant-scoped at the data layer — the winners corpus is platform-
 * wide public USAspending data — but the middleware still enforces a
 * valid tenant JWT so unauthenticated calls are rejected.
 */
router.get(
  '/primes/:identifier/subaward-analysis',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const raw = decodeURIComponent(req.params.identifier ?? '').trim()
      if (!raw) throw new ValidationError('identifier path param is required')

      const isUei = UEI_PATTERN.test(raw.toUpperCase())
      const lookbackYears = req.query.lookbackYears
        ? Math.max(1, Math.min(10, Number(req.query.lookbackYears)))
        : undefined

      const analysis = await analyzeSubawards({
        primeUei: isUei ? raw.toUpperCase() : null,
        primeName: isUei ? null : raw,
        lookbackYears,
      })

      res.json({ success: true, data: analysis })
    } catch (err) {
      next(err)
    }
  },
)

// =============================================================
// SCW-4: outreach drafts
// =============================================================

/**
 * POST /api/scw/outreach/draft
 *
 * Generates a personalized outreach draft for a (opportunity, prime) pair.
 * The draft is persisted with requiresHumanReview=true; no auto-send.
 *
 * Body:
 *   {
 *     opportunityId: string,
 *     primeUei?: string | null,    // either UEI or primeName required
 *     primeName?: string | null,
 *     outreachType: 'cold_first_touch' | 'warm_follow_up' | 'urgent_deadline_driven',
 *     tenantCapabilityStatement: string  // inline for v1
 *   }
 */
router.post(
  '/outreach/draft',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const b = req.body ?? {}
      if (!b.opportunityId) throw new ValidationError('opportunityId is required')
      if (!b.primeUei && !b.primeName) {
        throw new ValidationError('Either primeUei or primeName is required')
      }
      if (!b.outreachType || !VALID_OUTREACH_TYPES.includes(b.outreachType)) {
        throw new ValidationError(
          `outreachType must be one of: ${VALID_OUTREACH_TYPES.join(', ')}`,
        )
      }
      if (!b.tenantCapabilityStatement || typeof b.tenantCapabilityStatement !== 'string') {
        throw new ValidationError('tenantCapabilityStatement is required (inline for v1)')
      }

      const draft = await draftScwOutreach({
        opportunityId: b.opportunityId,
        consultingFirmId,
        primeUei: b.primeUei ?? null,
        primeName: b.primeName ?? null,
        outreachType: b.outreachType,
        tenantCapabilityStatement: b.tenantCapabilityStatement,
        actorUserId: req.user?.userId ?? null,
      })

      res.json({ success: true, data: draft })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * GET /api/scw/outreach/drafts
 *
 * Lists outreach drafts for the calling tenant, newest first. Optional
 * query filters: ?opportunityId, ?requiresHumanReview=true|false.
 */
router.get(
  '/outreach/drafts',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const opportunityId =
        typeof req.query.opportunityId === 'string' ? req.query.opportunityId : undefined
      const requiresHumanReview =
        req.query.requiresHumanReview === 'true'
          ? true
          : req.query.requiresHumanReview === 'false'
          ? false
          : undefined

      const drafts = await prisma.scwOutreachDraft.findMany({
        where: {
          consultingFirmId,
          ...(opportunityId ? { opportunityId } : {}),
          ...(requiresHumanReview !== undefined ? { requiresHumanReview } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })

      res.json({ success: true, data: drafts })
    } catch (err) {
      next(err)
    }
  },
)

/**
 * PATCH /api/scw/outreach/drafts/:id/approve
 *
 * Marks a draft human-approved. The caller's userId is recorded in
 * humanApprovedById and the timestamp in humanApprovedAt. This does NOT
 * send the email — operators send via their own email client.
 */
router.patch(
  '/outreach/drafts/:id/approve',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const id = req.params.id
      const userId = req.user?.userId ?? null

      const existing = await prisma.scwOutreachDraft.findFirst({
        where: { id, consultingFirmId },
      })
      if (!existing) throw new NotFoundError(`ScwOutreachDraft ${id}`)

      const updated = await prisma.scwOutreachDraft.update({
        where: { id },
        data: {
          requiresHumanReview: false,
          humanApprovedAt: new Date(),
          humanApprovedById: userId,
        },
      })

      await logAudit({
        consultingFirmId,
        actorUserId: userId,
        action: 'APPROVAL',
        entityType: 'ScwOutreachDraft',
        entityId: id,
        before: { requiresHumanReview: true },
        after: { requiresHumanReview: false, humanApprovedAt: updated.humanApprovedAt },
      })

      res.json({ success: true, data: updated })
    } catch (err) {
      next(err)
    }
  },
)

// =============================================================
// SCW-5: notification inbox (live query, no persistence in v1)
// =============================================================

/**
 * GET /api/scw/notifications/inbox
 *
 * Returns BID SUB notifications for the calling tenant. Each entry meets
 * spec §3 SCW-5 trigger criteria: BID_SUB recommendation on file,
 * deadline ≥ 5 days out, at least one likely prime with confidence ≥ 0.6.
 */
router.get(
  '/notifications/inbox',
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req)
      const limit = req.query.limit ? Math.min(100, Math.max(1, Number(req.query.limit))) : undefined
      const inbox = await getNotificationInbox({ consultingFirmId, limit })
      res.json({ success: true, data: inbox })
    } catch (err) {
      next(err)
    }
  },
)

export default router
