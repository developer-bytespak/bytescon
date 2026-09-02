import { Router, Request, Response, NextFunction } from 'express'
import { ClientDocumentType } from '@prisma/client'
import { prisma } from '../config/database'
import { ValidationError, NotFoundError, UnauthorizedError, ForbiddenError } from '../utils/errors'
import { logger } from '../utils/logger'
import { runBackground } from '../utils/asyncSafe'
import { upload } from '../middleware/upload'
import jwt from 'jsonwebtoken'
import { config } from '../config/config'
import { notifyDeliverableReady, notifyApprovalReceived } from '../services/emailService'
import { smsDeliverableReady } from '../services/smsService'
import { isTokenStale } from '../services/tokenRevocation'
import { loadPortalAccount } from '../services/portalAccountAccess'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { requireClientPortalEntitlement } from '../middleware/clientPortalGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'

const router = Router()

// Client JWT type
interface ClientJwtPayload {
  clientPortalUserId: string
  clientCompanyId: string
  role: 'CLIENT'
  email: string
  iat?: number
  exp?: number
}

// Authenticate client token (same as in clientPortal.ts)
async function authenticateClientJWT(req: Request, _res: Response, next: NextFunction): Promise<void> {
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
      return next(new UnauthorizedError('Invalid token'))
    }
    if (payload.role !== 'CLIENT') return next(new UnauthorizedError('Not a client token'))
    if (await isTokenStale('client', payload.clientPortalUserId, payload.iat)) {
      return next(new UnauthorizedError('Session expired, please sign in again'))
    }
    // Shared with the other two portal verifiers — see portalAccountAccess.ts.
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

// Dual auth — accepts either consultant JWT (consultingFirmId in payload)
// or client JWT (clientCompanyId in payload). Used by comment endpoints
// where both parties participate in the same thread.
interface ConsultantJwtPayload {
  userId: string
  consultingFirmId: string
  role: 'ADMIN' | 'CONSULTANT'
  email: string
}

interface DualAuthContext {
  authorType: 'CONSULTANT' | 'CLIENT'
  authorId: string
  authorName: string
  // For firm (CONSULTANT authorType) callers, the actual user role. Read-only
  // team members (role CONSULTANT) may view threads but not write to them.
  userRole?: 'ADMIN' | 'CONSULTANT'
  consultingFirmId?: string
  clientCompanyId?: string
}

async function authenticateAny(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return next(new UnauthorizedError('No token provided'))
    }
    const token = authHeader.split(' ')[1]
    let payload: any
    try {
      payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] })
    } catch {
      return next(new UnauthorizedError('Invalid token'))
    }

    // Single-purpose tokens are NOT sessions. Login's gating flow mints
    // `mfa_challenge` and `accept_agreements` tokens that already carry
    // role ADMIN|CONSULTANT and consultingFirmId, so without this check they
    // satisfied the firm branch below and reached these tenant data routes —
    // letting someone holding only a password (no second factor, no accepted
    // ToS) read and write client deliverable comment threads. Every other
    // tenant router is protected by enforceTenantScope / rejectScopedToken;
    // this hand-rolled verifier was the one path that checked neither.
    // Checked BEFORE the role branches so it holds for any future token kind.
    if (payload.scope) {
      return next(new ForbiddenError('This endpoint requires a full session. Complete the gating flow first.'))
    }

    if (payload.role === 'CLIENT') {
      if (await isTokenStale('client', payload.clientPortalUserId, payload.iat)) {
        return next(new UnauthorizedError('Session expired, please sign in again'))
      }
      // Same shared check as the two authenticateClientJWT copies — this branch
      // is where the drift lived: it re-read the portal user's own isActive but
      // NOT the client company's, so a contact of a soft-deleted client was
      // refused everywhere on /api/client-portal yet kept full read/write on
      // these comment threads. loadPortalAccount covers both flags and returns
      // the display name in the same query.
      //
      // No `.catch(() => null)` here on purpose: swallowing a database error
      // would turn an infrastructure fault into the authorization answer
      // "account disabled". Let it reach the outer catch → next(err) → 500.
      const portalUser = await loadPortalAccount(payload.clientPortalUserId)
      if (!portalUser?.active) {
        return next(new UnauthorizedError('Account access has been disabled'))
      }
      const ctx: DualAuthContext = {
        authorType: 'CLIENT',
        authorId: payload.clientPortalUserId,
        authorName: `${portalUser.firstName} ${portalUser.lastName}`.trim() || payload.email || 'Client',
        clientCompanyId: payload.clientCompanyId,
      }
      ;(req as any).authCtx = ctx
      return next()
    }

    if (payload.role === 'ADMIN' || payload.role === 'CONSULTANT') {
      if (await isTokenStale('user', payload.userId, payload.iat)) {
        return next(new UnauthorizedError('Session expired, please sign in again'))
      }
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        select: { firstName: true, lastName: true },
      }).catch(() => null)
      const ctx: DualAuthContext = {
        authorType: 'CONSULTANT',
        authorId: payload.userId,
        authorName: user
          ? `${user.firstName} ${user.lastName}`.trim()
          : payload.email || 'Consultant',
        userRole: payload.role,
        consultingFirmId: payload.consultingFirmId,
      }
      ;(req as any).authCtx = ctx
      return next()
    }

    next(new UnauthorizedError('Unrecognized token role'))
  } catch (err) {
    next(err)
  }
}

// Read-only team-member guard for the dual-auth comment WRITE routes. These
// routes use authenticateAny (not enforceTenantScope), so the global read-only
// policy doesn't reach them; mirror it here. CLIENT portal users and ADMIN firm
// users may write; CONSULTANT-role firm users are read-only.
function blockConsultantWrites(req: Request, _res: Response, next: NextFunction): void {
  const ctx = (req as any).authCtx as DualAuthContext | undefined
  if (ctx?.authorType === 'CONSULTANT' && ctx.userRole === 'CONSULTANT') {
    return next(new ForbiddenError('Your team-member account has read-only access. Ask a firm admin to make this change.'))
  }
  next()
}

// Verify the deliverable is visible to the caller's tenant scope
async function loadDeliverableForCaller(deliverableId: string, ctx: DualAuthContext) {
  const where: any = { id: deliverableId }
  if (ctx.authorType === 'CLIENT') {
    where.clientCompanyId = ctx.clientCompanyId
  } else {
    where.consultingFirmId = ctx.consultingFirmId
  }
  return prisma.clientDocument.findFirst({
    where,
    select: {
      id: true,
      title: true,
      consultingFirmId: true,
      clientCompanyId: true,
    },
  })
}

// =============================================================
// Deliverable Management Routes
// =============================================================

/**
 * GET /api/client-deliverables/list
 * List all deliverables (proposals, capability statements, etc.) for this client
 * Scoped to authenticated client only
 */
router.get('/list', authenticateClientJWT, requireClientPortalEntitlement, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload

    const deliverables = await prisma.clientDocument.findMany({
      where: { clientCompanyId },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        documentType: true,
        fileName: true,
        fileSize: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    res.json({
      success: true,
      data: deliverables,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/client-deliverables/create-for-review
 * Consultant creates a deliverable and sends it to client for review
 * This is called from the consultant backend (requires consultant JWT + enforceTenantScope)
 * Body: { clientCompanyId, title, documentType, notes, file }
 */
router.post(
  '/create-for-review',
  authenticateJWT,
  enforceTenantScope,
  requireActiveBase,
  requireAddon('client_portal'),
  upload.single('file'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Tenant scope comes from the verified JWT — never trust the body.
      const consultingFirmId = getTenantId(req as AuthenticatedRequest)
      const { clientCompanyId, title, documentType, notes } = req.body

      if (!clientCompanyId || !title || !req.file) {
        throw new ValidationError('clientCompanyId, title, and file are required')
      }

      // Verify the client belongs to the caller's firm (tenant-scoped lookup)
      const clientCompany = await prisma.clientCompany.findFirst({
        where: { id: clientCompanyId, consultingFirmId },
        select: { id: true, consultingFirmId: true },
      })

      if (!clientCompany) {
        throw new NotFoundError('Client not found')
      }

      // An unknown documentType must be a 422, not a Prisma 500. Multipart
      // fields arrive as raw strings, so validate against the enum here.
      const validTypes = Object.values(ClientDocumentType) as string[]
      if (documentType && !validTypes.includes(documentType)) {
        throw new ValidationError(`documentType must be one of: ${validTypes.join(', ')}`)
      }

      // Create the deliverable
      const deliverable = await prisma.clientDocument.create({
        data: {
          clientCompanyId,
          consultingFirmId,
          title,
          documentType: (documentType as ClientDocumentType) || 'OTHER',
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          fileSize: req.file.size,
          storageKey: req.file.filename,
          notes: notes || null,
        },
      })

      logger.info('Deliverable created for client review', {
        deliverableId: deliverable.id,
        clientId: clientCompanyId,
      })

      // Notify all opted-in portal users (email + optional SMS). Fire-and-forget
      // via runBackground so any rejection lands in Winston (error level) AND
      // an AuditEvent row, instead of disappearing silently like the old
      // logger.warn pattern. Response shape unchanged.
      runBackground(
        'client-deliverable-created-notify',
        async () => {
          const portalUsers = await prisma.clientPortalUser.findMany({
            where: {
              clientCompanyId,
              isActive: true,
              OR: [
                { notifyDeliverables: true },
                { smsEnabled: true },
              ],
            },
            select: {
              email: true,
              firstName: true,
              lastName: true,
              notifyDeliverables: true,
              smsEnabled: true,
              smsPhone: true,
            },
          })
          const portalUrl = (process.env.FRONTEND_URL || 'http://localhost:3000') + '/client-portal'

          // Fetch firm display name once for SMS branding
          const firm = await prisma.consultingFirm.findUnique({
            where: { id: clientCompany.consultingFirmId },
            select: { name: true, brandingDisplayName: true },
          })
          const firmDisplayName = firm?.brandingDisplayName || firm?.name || 'Bytescon'

          await Promise.all(portalUsers.flatMap(u => {
            const tasks: Promise<unknown>[] = []
            if (u.notifyDeliverables) {
              tasks.push(notifyDeliverableReady({
                firmId: clientCompany.consultingFirmId,
                recipientEmail: u.email,
                recipientName: `${u.firstName} ${u.lastName}`.trim(),
                deliverableTitle: title,
                portalUrl,
              }))
            }
            if (u.smsEnabled && u.smsPhone) {
              tasks.push(smsDeliverableReady({
                to: u.smsPhone,
                consultingFirmId: clientCompany.consultingFirmId,
                firmDisplayName,
                deliverableTitle: title,
              }))
            }
            return tasks
          }))
        },
        {
          consultingFirmId: clientCompany.consultingFirmId,
          entityType: 'DocumentRequirement',
          entityId: deliverable.id,
          failureAction: 'EMAIL_DELIVERY_FAILED',
        },
      )

      res.status(201).json({
        success: true,
        data: deliverable,
      })
    } catch (err) {
      next(err)
    }
  }
)

/**
 * GET /api/client-deliverables/:id
 * Get deliverable details + approval history + comments
 */
router.get('/:id', authenticateClientJWT, requireClientPortalEntitlement, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId } = (req as any).clientUser as ClientJwtPayload
    const { id } = req.params

    const deliverable = await prisma.clientDocument.findFirst({
      where: { id, clientCompanyId },
      include: {
        sharedTemplate: {
          select: { status: true, reviewNotes: true, updatedAt: true },
        },
      },
    })

    if (!deliverable) {
      throw new NotFoundError('Deliverable not found')
    }

    res.json({
      success: true,
      data: deliverable,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/client-deliverables/:id/approve
 * Client approves a deliverable
 * Body: { notes?: string }
 */
router.post('/:id/approve', authenticateClientJWT, requireClientPortalEntitlement, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { clientCompanyId, clientPortalUserId } = (req as any).clientUser as ClientJwtPayload
    const { id } = req.params
    const { notes } = req.body

    const deliverable = await prisma.clientDocument.findFirst({
      where: { id, clientCompanyId },
    })

    if (!deliverable) {
      throw new NotFoundError('Deliverable not found')
    }

    // Log approval in audit trail via ComplianceLog
    await prisma.complianceLog.create({
      data: {
        consultingFirmId: deliverable.consultingFirmId,
        entityType: 'DOCUMENT_REQUIREMENT',
        entityId: id,
        fromStatus: 'PENDING',
        toStatus: 'APPROVED',
        reason: notes || 'Client approved deliverable',
        triggeredBy: clientPortalUserId,
      },
    })

    // Notify consultant firm of approval. Fire-and-forget — runBackground
    // ensures any rejection is logged AND written to AuditEvent so a missed
    // notification is queryable for compliance, not just buried in Winston.
    runBackground(
      'client-deliverable-approval-notify',
      async () => {
        const firm = await prisma.consultingFirm.findUnique({
          where: { id: deliverable.consultingFirmId },
          select: { contactEmail: true, name: true },
        })
        const portalUser = await prisma.clientPortalUser.findUnique({
          where: { id: clientPortalUserId },
          select: { firstName: true, lastName: true },
        })
        if (firm && portalUser) {
          const portalUrl = (process.env.FRONTEND_URL || 'http://localhost:3000') + '/clients'
          await notifyApprovalReceived({
            firmId: deliverable.consultingFirmId,
            recipientEmail: firm.contactEmail,
            recipientName: firm.name,
            deliverableTitle: `${deliverable.title} (approved by ${portalUser.firstName} ${portalUser.lastName})`,
            portalUrl,
          })
        }
      },
      {
        consultingFirmId: deliverable.consultingFirmId,
        entityType: 'DocumentRequirement',
        entityId: id,
        failureAction: 'EMAIL_DELIVERY_FAILED',
      },
    )

    res.json({
      success: true,
      data: { message: 'Deliverable approved', deliverableId: id },
    })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/client-deliverables/:id/request-changes
 * Client requests revisions to a deliverable
 * Body: { feedback: string }
 */
router.post(
  '/:id/request-changes',
  authenticateClientJWT,
  requireClientPortalEntitlement,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientCompanyId, clientPortalUserId } = (req as any).clientUser as ClientJwtPayload
      const { id } = req.params
      const { feedback } = req.body

      if (!feedback) {
        throw new ValidationError('feedback is required')
      }

      const deliverable = await prisma.clientDocument.findFirst({
        where: { id, clientCompanyId },
      })

      if (!deliverable) {
        throw new NotFoundError('Deliverable not found')
      }

      // Log request for changes
      await prisma.complianceLog.create({
        data: {
          consultingFirmId: deliverable.consultingFirmId,
          entityType: 'DOCUMENT_REQUIREMENT',
          entityId: id,
          fromStatus: 'PENDING',
          toStatus: 'IN_PROGRESS',
          reason: feedback,
          triggeredBy: clientPortalUserId,
        },
      })

      res.json({
        success: true,
        data: { message: 'Changes requested', deliverableId: id },
      })
    } catch (err) {
      next(err)
    }
  }
)

// =============================================================
// THREADED COMMENTS — accepts both consultant and client JWTs
// Tenant scope enforced by loadDeliverableForCaller
// =============================================================

/**
 * GET /api/client-deliverables/:id/comments
 * Returns all comments for a deliverable as a flat list
 * (frontend rebuilds tree from parentId references)
 */
router.get(
  '/:id/comments',
  authenticateAny,
  requireClientPortalEntitlement,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = (req as any).authCtx as DualAuthContext
      const deliverable = await loadDeliverableForCaller(req.params.id, ctx)
      if (!deliverable) throw new NotFoundError('Deliverable not found')

      const comments = await prisma.deliverableComment.findMany({
        where: { deliverableId: deliverable.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          deliverableId: true,
          authorType: true,
          authorId: true,
          authorName: true,
          body: true,
          parentId: true,
          isResolved: true,
          createdAt: true,
          updatedAt: true,
        },
      })

      res.json({ success: true, data: { comments } })
    } catch (err) {
      next(err)
    }
  }
)

/**
 * POST /api/client-deliverables/:id/comments
 * Create a new comment or reply
 * Body: { body: string, parentId?: string }
 */
router.post(
  '/:id/comments',
  authenticateAny,
  requireClientPortalEntitlement,
  blockConsultantWrites,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = (req as any).authCtx as DualAuthContext
      const deliverable = await loadDeliverableForCaller(req.params.id, ctx)
      if (!deliverable) throw new NotFoundError('Deliverable not found')

      const { body, parentId } = req.body
      if (!body || typeof body !== 'string' || !body.trim()) {
        throw new ValidationError('Comment body is required')
      }
      if (body.length > 5000) {
        throw new ValidationError('Comment too long (max 5000 chars)')
      }

      // If reply, verify parent exists on same deliverable
      if (parentId) {
        const parent = await prisma.deliverableComment.findFirst({
          where: { id: parentId, deliverableId: deliverable.id },
          select: { id: true },
        })
        if (!parent) throw new ValidationError('Parent comment not found on this deliverable')
      }

      const comment = await prisma.deliverableComment.create({
        data: {
          deliverableId: deliverable.id,
          authorType: ctx.authorType,
          authorId: ctx.authorId,
          authorName: ctx.authorName,
          body: body.trim(),
          parentId: parentId || null,
        },
      })

      // Audit trail (compliance)
      await prisma.complianceLog.create({
        data: {
          consultingFirmId: deliverable.consultingFirmId,
          entityType: 'DOCUMENT_REQUIREMENT',
          entityId: deliverable.id,
          fromStatus: parentId ? 'COMMENT_REPLY' : 'COMMENT_NEW',
          toStatus: 'POSTED',
          reason: `${ctx.authorType} ${ctx.authorName}: ${body.trim().slice(0, 200)}`,
          triggeredBy: `${ctx.authorType.toLowerCase()}:${ctx.authorId}`,
        },
      }).catch(err => {
        logger.warn('Failed to audit comment', { commentId: comment.id, error: err.message })
      })

      // Notify the other party of the new comment. runBackground ensures
      // any rejection becomes a Winston error AND an AuditEvent row keyed
      // off the comment id, instead of disappearing into warn-level logs.
      runBackground(
        'client-deliverable-comment-notify',
        async () => {
          if (ctx.authorType === 'CLIENT') {
            // Client commented -> notify consultant firm contact
            const firm = await prisma.consultingFirm.findUnique({
              where: { id: deliverable.consultingFirmId },
              select: { contactEmail: true, name: true },
            })
            if (firm) {
              await notifyApprovalReceived({
                firmId: deliverable.consultingFirmId,
                recipientEmail: firm.contactEmail,
                recipientName: firm.name,
                deliverableTitle: `New comment on "${deliverable.title}" from ${ctx.authorName}`,
                portalUrl: (process.env.FRONTEND_URL || 'http://localhost:3000') + '/clients',
              })
            }
          } else {
            // Consultant commented -> notify all opted-in client portal users
            const portalUsers = await prisma.clientPortalUser.findMany({
              where: {
                clientCompanyId: deliverable.clientCompanyId,
                isActive: true,
                notifyDeliverables: true,
              },
              select: { email: true, firstName: true, lastName: true },
            })
            const portalUrl = (process.env.FRONTEND_URL || 'http://localhost:3000') + '/client-portal'
            await Promise.all(portalUsers.map(u =>
              notifyDeliverableReady({
                firmId: deliverable.consultingFirmId,
                recipientEmail: u.email,
                recipientName: `${u.firstName} ${u.lastName}`.trim(),
                deliverableTitle: `New comment on "${deliverable.title}"`,
                portalUrl,
              })
            ))
          }
        },
        {
          consultingFirmId: deliverable.consultingFirmId,
          entityType: 'DocumentRequirement',
          entityId: deliverable.id,
          failureAction: 'EMAIL_DELIVERY_FAILED',
        },
      )

      res.status(201).json({ success: true, data: { comment } })
    } catch (err) {
      next(err)
    }
  }
)

/**
 * PATCH /api/client-deliverables/:id/comments/:commentId/resolve
 * Mark a comment thread as resolved (toggle)
 * Body: { isResolved: boolean }
 */
router.patch(
  '/:id/comments/:commentId/resolve',
  authenticateAny,
  requireClientPortalEntitlement,
  blockConsultantWrites,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = (req as any).authCtx as DualAuthContext
      const deliverable = await loadDeliverableForCaller(req.params.id, ctx)
      if (!deliverable) throw new NotFoundError('Deliverable not found')

      const { isResolved } = req.body
      if (typeof isResolved !== 'boolean') {
        throw new ValidationError('isResolved must be boolean')
      }

      const updated = await prisma.deliverableComment.updateMany({
        where: {
          id: req.params.commentId,
          deliverableId: deliverable.id,
        },
        data: { isResolved },
      })

      if (updated.count === 0) throw new NotFoundError('Comment not found')

      res.json({ success: true, data: { commentId: req.params.commentId, isResolved } })
    } catch (err) {
      next(err)
    }
  }
)

/**
 * DELETE /api/client-deliverables/:id/comments/:commentId
 * Author can delete their own comment (soft constraint via authorId match)
 */
router.delete(
  '/:id/comments/:commentId',
  authenticateAny,
  requireClientPortalEntitlement,
  blockConsultantWrites,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = (req as any).authCtx as DualAuthContext
      const deliverable = await loadDeliverableForCaller(req.params.id, ctx)
      if (!deliverable) throw new NotFoundError('Deliverable not found')

      const comment = await prisma.deliverableComment.findFirst({
        where: {
          id: req.params.commentId,
          deliverableId: deliverable.id,
        },
        select: { id: true, authorId: true, authorType: true },
      })
      if (!comment) throw new NotFoundError('Comment not found')
      if (comment.authorId !== ctx.authorId || comment.authorType !== ctx.authorType) {
        throw new UnauthorizedError('You can only delete your own comments')
      }

      await prisma.deliverableComment.delete({ where: { id: comment.id } })

      res.json({ success: true, data: { commentId: comment.id, deleted: true } })
    } catch (err) {
      next(err)
    }
  }
)

export default router
