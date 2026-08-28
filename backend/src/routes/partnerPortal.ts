// =============================================================
// §8.3 — Partner / subcontractor portal.
//
// An external surface on the same backend and database, deliberately narrow.
// Every response on this router is assembled field by field: nothing is spread
// from a Prisma row, because a spread is how internal margin, cost build-up or
// another vendor's terms leak the first time a model gains a column.
//
// What a partner can never reach, by construction rather than by filtering:
// win probability, qualification recommendations, bid decisions, capture
// strategy, prime margin, budgets, cash flow, receivables, other partners'
// orders, invoices or rates, internal users, agent runs and audit logs. None of
// those tables is queried anywhere in this file.
//
// Prime approval stays with the prime: a partner submits an invoice, and a
// prime human approves it through the existing ERP route, which is the only
// path that posts cost.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { z } from 'zod'
import {
  PartnerDeliverableSubmissionStatus, PartnerEngagementScope, PartnerSubmissionStatus,
  Prisma, SubcontractInvoiceStatus,
} from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { ValidationError, NotFoundError, UnauthorizedError, ForbiddenError } from '../utils/errors'
import { logAudit, AuditAction } from '../services/auditService'
import { upload } from '../middleware/upload'
import { logger } from '../utils/logger'
import { encryptSecret, decryptSecret } from '../utils/fieldCrypto'
import { generateMfaEnrollment, verifyTotp, generateRecoveryCodes, matchRecoveryCode } from '../services/mfaService'
import { sendEmail } from '../services/mailer'
import { renderBrandedEmail } from '../services/brandedEmailTemplates'
import { revokePartnerTokens } from '../services/tokenRevocation'
import { sendAuthorizedFile } from '../services/partnerPortal/partnerFiles'
import {
  PartnerProfileProposalSchema, buildApprovedProfileUpdate, currentProfileSnapshot,
} from '../services/partnerPortal/partnerProfile'
import {
  authenticatePartnerJWT, authenticatePartnerChallenge, generatePartnerToken,
  generatePartnerChallengeToken, getPartnerCtx, loadGrants, assertGrant, hasGrant,
  resolveAccessiblePurchaseOrder, resolveAccessibleDeliverable, type PartnerRequest,
} from '../services/partnerPortal/partnerAccess'

const router = Router()

/** Audit for an EXTERNAL actor — actorUserId stays null, never borrowed. */
const partnerAudit = (
  ctx: { consultingFirmId: string; partnerPortalUserId: string },
  action: AuditAction, entityType: string, entityId: string, rationale?: string,
) => logAudit({
  consultingFirmId: ctx.consultingFirmId,
  actorUserId: null,
  actorKind: 'PARTNER_PORTAL_USER',
  externalActorId: ctx.partnerPortalUserId,
  actorRole: 'PARTNER',
  action, entityType, entityId, rationale,
})

const internalAudit = (
  req: AuthenticatedRequest, consultingFirmId: string, action: AuditAction,
  entityType: string, entityId: string, rationale?: string,
) => logAudit({
  consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
  actorKind: 'INTERNAL_USER', action, entityType, entityId, rationale,
})

// =============================================================
// INTERNAL — prime-side administration of partner portal access
// =============================================================

const adminRouter = Router()
adminRouter.use(authenticateJWT, enforceTenantScope, requireActiveBase)

const InviteSchema = z.object({
  partnerId: z.string().min(1),
  partnerContactId: z.string().uuid().nullable().optional(),
  email: z.string().trim().email().max(200),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
})

/** Invite is human-only. No agent has route access, and none may grant any of this. */
adminRouter.post('/users', requirePermission('PARTNER_ACCESS_GRANT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = InviteSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid invitation payload')
    const d = parsed.data

    const partner = await prisma.partner.findFirst({ where: { id: d.partnerId, consultingFirmId }, select: { id: true } })
    if (!partner) throw new NotFoundError('Partner not found')
    if (d.partnerContactId) {
      const c = await prisma.partnerContact.findFirst({
        where: { id: d.partnerContactId, consultingFirmId, partnerId: partner.id }, select: { id: true },
      })
      if (!c) throw new NotFoundError('Partner contact not found')
    }

    const existing = await prisma.partnerPortalUser.findFirst({
      where: { consultingFirmId, email: d.email.toLowerCase() },
      select: { id: true, revokedAt: true },
    })
    // A live account is a genuine duplicate. A REVOKED one is not: revoking is
    // a soft delete, and `[consultingFirmId, email]` is unique, so refusing
    // here would lock that address out of the portal permanently.
    if (existing && !existing.revokedAt) {
      throw new ValidationError('A portal user with that email already exists for this firm')
    }

    // Single-use invite: the raw token is returned once and only its hash stored.
    const rawToken = crypto.randomBytes(32).toString('hex')
    const invite = {
      partnerId: partner.id,
      partnerContactId: d.partnerContactId ?? null,
      firstName: d.firstName, lastName: d.lastName,
      inviteTokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
      inviteExpiresAt: new Date(Date.now() + 7 * 86400000),
      invitedAt: new Date(), invitedByUserId: req.user?.userId ?? null,
    }
    const selection = { id: true, email: true, firstName: true, lastName: true, invitedAt: true, inviteExpiresAt: true }

    const created = existing
      ? await prisma.partnerPortalUser.update({
        where: { id: existing.id },
        // Restored as a FRESH invite, never as the old account resumed. The old
        // password and second factor are destroyed, so a revoked credential can
        // never sign in again, and acceptance has to happen a second time.
        //
        // Engagement grants stay revoked. Access is default-deny, and letting
        // someone back in is a separate decision from what they may see.
        data: {
          ...invite,
          isActive: true, revokedAt: null, revokedByUserId: null,
          passwordHash: null, acceptedAt: null, lastLoginAt: null,
          mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [], mfaEnrolledAt: null,
        },
        select: selection,
      })
      : await prisma.partnerPortalUser.create({
        data: { ...invite, consultingFirmId, email: d.email.toLowerCase() },
        select: selection,
      })

    await internalAudit(req, consultingFirmId, existing ? 'UPDATE' : 'CREATE', 'PartnerPortalUser', created.id,
      existing
        ? `Revoked partner portal user re-invited: ${created.email} (password and second factor cleared, engagement grants left revoked)`
        : `Partner portal user invited: ${created.email}`)
    res.status(201).json({ success: true, data: { ...created, inviteToken: rawToken } })
  } catch (err) { next(err) }
})

adminRouter.get('/users', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.PartnerPortalUserWhereInput = { consultingFirmId }
    if (typeof req.query.partnerId === 'string' && req.query.partnerId) where.partnerId = req.query.partnerId
    const rows = await prisma.partnerPortalUser.findMany({
      where,
      select: {
        id: true, email: true, firstName: true, lastName: true, isActive: true,
        invitedAt: true, acceptedAt: true, lastLoginAt: true, revokedAt: true,
        partner: { select: { id: true, name: true } },
        access: { where: { revokedAt: null }, select: { id: true, scopeType: true, scopeId: true, grantedAt: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 300,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

const GrantSchema = z.object({
  partnerPortalUserId: z.string().uuid(),
  scopeType: z.nativeEnum(PartnerEngagementScope),
  scopeId: z.string().min(1),
  notes: z.string().trim().max(500).nullable().optional(),
})

/**
 * Grant one engagement. The scoped record is re-validated against the tenant
 * AND against the portal user's own partner company, so a prime cannot grant a
 * partner access to another partner's purchase order by mistake.
 */
adminRouter.post('/access', requirePermission('PARTNER_ACCESS_GRANT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = GrantSchema.safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid grant payload')
    const d = parsed.data

    const portalUser = await prisma.partnerPortalUser.findFirst({
      where: { id: d.partnerPortalUserId, consultingFirmId }, select: { id: true, partnerId: true },
    })
    if (!portalUser) throw new NotFoundError('Portal user not found')

    let ok = false
    if (d.scopeType === PartnerEngagementScope.CONTRACT) {
      ok = Boolean(await prisma.contract.findFirst({ where: { id: d.scopeId, consultingFirmId }, select: { id: true } }))
    } else if (d.scopeType === PartnerEngagementScope.OPPORTUNITY) {
      ok = Boolean(await prisma.opportunity.findFirst({ where: { id: d.scopeId, consultingFirmId }, select: { id: true } }))
    } else if (d.scopeType === PartnerEngagementScope.TEAMING_ARRANGEMENT) {
      ok = Boolean(await prisma.teamingArrangement.findFirst({
        where: { id: d.scopeId, consultingFirmId, partnerId: portalUser.partnerId }, select: { id: true },
      }))
    } else {
      ok = Boolean(await prisma.purchaseOrder.findFirst({
        where: { id: d.scopeId, consultingFirmId, partnerId: portalUser.partnerId }, select: { id: true },
      }))
    }
    if (!ok) throw new NotFoundError('That engagement was not found for this partner')

    const created = await prisma.partnerEngagementAccess.upsert({
      where: {
        partnerPortalUserId_scopeType_scopeId: {
          partnerPortalUserId: portalUser.id, scopeType: d.scopeType, scopeId: d.scopeId,
        },
      },
      create: {
        consultingFirmId, partnerPortalUserId: portalUser.id, scopeType: d.scopeType,
        scopeId: d.scopeId, notes: d.notes ?? null, grantedByUserId: req.user!.userId,
      },
      // Re-granting a revoked engagement reopens it rather than duplicating.
      update: { revokedAt: null, revokedByUserId: null, grantedByUserId: req.user!.userId, grantedAt: new Date() },
    })
    await internalAudit(req, consultingFirmId, 'CREATE', 'PartnerEngagementAccess', created.id,
      `Granted ${d.scopeType} access to partner portal user`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

adminRouter.post('/access/:id/revoke', requirePermission('PARTNER_ACCESS_GRANT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.partnerEngagementAccess.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Access grant not found')
    const updated = await prisma.partnerEngagementAccess.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), revokedByUserId: req.user?.userId ?? null },
    })
    await internalAudit(req, consultingFirmId, 'UPDATE', 'PartnerEngagementAccess', existing.id, 'Engagement access revoked')
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

adminRouter.post('/users/:id/revoke', requirePermission('PARTNER_ACCESS_GRANT'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const existing = await prisma.partnerPortalUser.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!existing) throw new NotFoundError('Portal user not found')
    const updated = await prisma.$transaction(async (tx) => {
      await tx.partnerEngagementAccess.updateMany({
        where: { partnerPortalUserId: existing.id, revokedAt: null },
        data: { revokedAt: new Date(), revokedByUserId: req.user?.userId ?? null },
      })
      return tx.partnerPortalUser.update({
        where: { id: existing.id },
        data: { isActive: false, revokedAt: new Date(), revokedByUserId: req.user?.userId ?? null },
      })
    })
    await internalAudit(req, consultingFirmId, 'UPDATE', 'PartnerPortalUser', existing.id, 'Partner portal user revoked')
    res.json({ success: true, data: { id: updated.id, isActive: updated.isActive, revokedAt: updated.revokedAt } })
  } catch (err) { next(err) }
})

adminRouter.get('/submissions', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const [uploads, personnel] = await Promise.all([
      prisma.partnerPortalUpload.findMany({
        where: { consultingFirmId }, orderBy: { createdAt: 'desc' }, take: 200,
        include: { partner: { select: { id: true, name: true } } },
      }),
      prisma.partnerPersonnelSubmission.findMany({
        where: { consultingFirmId }, orderBy: { createdAt: 'desc' }, take: 200,
        include: { partner: { select: { id: true, name: true } } },
      }),
    ])
    res.json({ success: true, data: { uploads, personnelSubmissions: personnel } })
  } catch (err) { next(err) }
})

/**
 * Accept or reject a document the partner uploaded.
 *
 * The decision is recorded against the upload and nothing else. Accepting a
 * file is the prime saying "we received what we asked for" — it never moves
 * the file into the document library and never changes any engagement, because
 * a partner handing something in is not the prime adopting it.
 */
adminRouter.post('/submissions/uploads/:id/review', requirePermission('PARTNER_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({
      status: z.enum(['ACCEPTED', 'REJECTED']),
      reviewNotes: z.string().trim().max(2000).nullable().optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid review decision is required')

    const upload = await prisma.partnerPortalUpload.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, title: true, reviewStatus: true },
    })
    if (!upload) throw new NotFoundError('Upload not found')
    if (upload.reviewStatus !== PartnerSubmissionStatus.PENDING_REVIEW) {
      throw new ValidationError('That document has already been reviewed')
    }

    const updated = await prisma.partnerPortalUpload.update({
      where: { id: upload.id },
      data: {
        reviewStatus: parsed.data.status as PartnerSubmissionStatus,
        reviewedByUserId: req.user?.userId ?? null,
        reviewedAt: new Date(),
        reviewNotes: parsed.data.reviewNotes ?? null,
      },
      select: { id: true, reviewStatus: true, reviewedAt: true, reviewNotes: true },
    })
    await internalAudit(req, consultingFirmId, 'UPDATE', 'PartnerPortalUpload', upload.id,
      `Partner document ${parsed.data.status}: ${upload.title}`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

/**
 * Review a partner personnel submission. Accepting it optionally promotes the
 * evidence into the personnel library as a DRAFT resume — never as approved,
 * and always carrying PARTNER_SUBMITTED provenance.
 */
adminRouter.post('/submissions/personnel/:id/review', requirePermission('PARTNER_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({
      status: z.enum(['ACCEPTED', 'REJECTED']),
      reviewNotes: z.string().trim().max(2000).optional(),
      importIntoLibrary: z.boolean().optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid review decision is required')

    const submission = await prisma.partnerPersonnelSubmission.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!submission) throw new NotFoundError('Submission not found')

    // Re-derived inside the tenant rather than followed from the submission's
    // own column, so a stale or crafted upload id cannot attach another
    // partner's file to a promoted resume.
    const sourceUpload = submission.sourceUploadId
      ? await prisma.partnerPortalUpload.findFirst({
        where: { id: submission.sourceUploadId, consultingFirmId, partnerId: submission.partnerId },
        select: { id: true, fileName: true, fileType: true, fileSize: true, storageKey: true },
      })
      : null

    const result = await prisma.$transaction(async (tx) => {
      let importedPersonnelId: string | null = submission.importedPersonnelId
      if (parsed.data.status === 'ACCEPTED' && parsed.data.importIntoLibrary && !importedPersonnelId) {
        const [firstName, ...rest] = submission.fullName.trim().split(/\s+/)
        const person = await tx.personnel.create({
          data: {
            consultingFirmId,
            firstName: firstName || submission.fullName,
            lastName: rest.join(' ') || '(partner staff)',
            jobTitle: submission.proposedRole,
            employmentType: 'SUBCONTRACTOR_STAFF',
            source: 'PARTNER_SUBMITTED',
            sourcePartnerId: submission.partnerId,
            createdByUserId: req.user?.userId ?? null,
          },
          select: { id: true },
        })
        // Promoted as a DRAFT. A partner's word is evidence, not approval.
        //
        // The attachment is referenced, not re-uploaded: the same stored file
        // now backs both the partner's original submission and the draft
        // resume, and the provenance columns say exactly which partner, which
        // submission and which upload it came from.
        await tx.personnelResume.create({
          data: {
            consultingFirmId, personnelId: person.id, versionNumber: 1,
            status: 'DRAFT', title: `Partner-submitted resume — ${submission.fullName}`,
            content: submission.content as Prisma.InputJsonObject,
            source: 'PARTNER_SUBMITTED', createdByUserId: req.user?.userId ?? null,
            fileName: sourceUpload?.fileName ?? null,
            fileType: sourceUpload?.fileType ?? null,
            fileSize: sourceUpload?.fileSize ?? null,
            storageKey: sourceUpload?.storageKey ?? null,
            sourcePartnerId: submission.partnerId,
            sourcePartnerSubmissionId: submission.id,
            sourcePartnerUploadId: sourceUpload?.id ?? null,
          },
        })
        importedPersonnelId = person.id
      }
      return tx.partnerPersonnelSubmission.update({
        where: { id: submission.id },
        data: {
          status: parsed.data.status as PartnerSubmissionStatus,
          reviewedByUserId: req.user?.userId ?? null,
          reviewedAt: new Date(),
          reviewNotes: parsed.data.reviewNotes ?? null,
          importedPersonnelId,
        },
      })
    })

    await internalAudit(req, consultingFirmId, 'UPDATE', 'PartnerPersonnelSubmission', submission.id,
      `Partner personnel submission ${parsed.data.status}`)
    res.json({
      success: true,
      data: {
        ...result,
        note: 'An accepted submission is promoted as a DRAFT resume with partner provenance. It still needs prime approval before a proposal may use it.',
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Prime-side review of what partners sent in
// -------------------------------------------------------------

/** A prime reads a partner's uploaded document. Tenant-scoped, like everything internal. */
adminRouter.get('/uploads/:id/download', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const doc = await prisma.partnerPortalUpload.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, fileName: true, fileType: true, storageKey: true },
    })
    if (!doc) throw new NotFoundError('Document not found')
    sendAuthorizedFile(res, doc)
  } catch (err) { next(err) }
})

adminRouter.get('/deliverable-submissions', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.PartnerDeliverableSubmissionWhereInput = { consultingFirmId }
    if (typeof req.query.status === 'string' && req.query.status in PartnerDeliverableSubmissionStatus) {
      where.status = req.query.status as PartnerDeliverableSubmissionStatus
    }
    const rows = await prisma.partnerDeliverableSubmission.findMany({
      where,
      select: {
        id: true, status: true, note: true, fileName: true, fileSize: true, submittedAt: true,
        reviewedAt: true, reviewNotes: true, createdAt: true,
        partner: { select: { id: true, name: true } },
        deliverable: { select: { id: true, name: true, cdrlNumber: true, dueDate: true, status: true, contractId: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 200,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

adminRouter.get('/deliverable-submissions/:id/download', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const row = await prisma.partnerDeliverableSubmission.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, fileName: true, fileType: true, storageKey: true },
    })
    if (!row) throw new NotFoundError('Submission not found')
    sendAuthorizedFile(res, row)
  } catch (err) { next(err) }
})

/**
 * Accept a partner's response, or send it back for changes.
 *
 * ADMIN only, and human only — no agent holds route access. Accepting records
 * that the PRIME accepted the partner's response. It deliberately does not
 * touch `ContractDeliverable.status`, `acceptanceStatus` or `acceptanceDate`:
 * those are the prime's record of the government's acceptance, and a
 * subcontractor handing in work is not the government accepting it.
 */
adminRouter.post('/deliverable-submissions/:id/review', requirePermission('PARTNER_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({
      status: z.enum(['ACCEPTED_BY_PRIME', 'CHANGES_REQUESTED']),
      reviewNotes: z.string().trim().max(2000).nullable().optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid review decision is required')

    const row = await prisma.partnerDeliverableSubmission.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, status: true, deliverableId: true },
    })
    if (!row) throw new NotFoundError('Submission not found')
    if (row.status === PartnerDeliverableSubmissionStatus.DRAFT) {
      throw new ValidationError('That response is still a draft and has not been submitted for review')
    }

    const updated = await prisma.partnerDeliverableSubmission.update({
      where: { id: row.id },
      data: {
        status: parsed.data.status as PartnerDeliverableSubmissionStatus,
        reviewedByUserId: req.user?.userId ?? null,
        reviewedAt: new Date(),
        reviewNotes: parsed.data.reviewNotes ?? null,
      },
      select: { id: true, status: true, reviewedAt: true, reviewNotes: true },
    })
    await internalAudit(req, consultingFirmId, 'UPDATE', 'PartnerDeliverableSubmission', row.id,
      `Partner deliverable response ${parsed.data.status}`)
    res.json({
      success: true,
      data: {
        ...updated,
        note: 'This records the prime contractor’s acceptance of the partner’s response. The deliverable’s own status and any government acceptance remain a separate, human decision.',
      },
    })
  } catch (err) { next(err) }
})

adminRouter.get('/profile-change-requests', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const where: Prisma.PartnerProfileChangeRequestWhereInput = { consultingFirmId }
    if (typeof req.query.status === 'string' && req.query.status in PartnerSubmissionStatus) {
      where.status = req.query.status as PartnerSubmissionStatus
    }
    const rows = await prisma.partnerProfileChangeRequest.findMany({
      where,
      select: {
        id: true, status: true, proposed: true, previous: true, submittedNote: true,
        reviewNotes: true, reviewedAt: true, appliedAt: true, createdAt: true,
        partner: { select: { id: true, name: true } },
        portalUser: { select: { id: true, email: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' }, take: 200,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

/**
 * Approve or reject a proposed profile change. ADMIN only.
 *
 * Approval re-filters the stored proposal through the allowlist before it
 * touches `Partner`: the JSON was written by an external actor, and reading it
 * back does not make it trusted.
 */
adminRouter.post('/profile-change-requests/:id/review', requirePermission('PARTNER_MANAGE'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({
      status: z.enum(['ACCEPTED', 'REJECTED']),
      reviewNotes: z.string().trim().max(2000).nullable().optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid review decision is required')

    const request = await prisma.partnerProfileChangeRequest.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true, status: true, partnerId: true, proposed: true },
    })
    if (!request) throw new NotFoundError('Change request not found')
    if (request.status !== PartnerSubmissionStatus.PENDING_REVIEW) {
      throw new ValidationError('That change request has already been reviewed')
    }

    const accepted = parsed.data.status === 'ACCEPTED'
    const updateData = accepted ? buildApprovedProfileUpdate(request.proposed) : {}
    const appliedFields = Object.keys(updateData)

    const result = await prisma.$transaction(async (tx) => {
      if (accepted && appliedFields.length > 0) {
        await tx.partner.update({ where: { id: request.partnerId }, data: updateData })
      }
      return tx.partnerProfileChangeRequest.update({
        where: { id: request.id },
        data: {
          status: parsed.data.status as PartnerSubmissionStatus,
          reviewedByUserId: req.user?.userId ?? null,
          reviewedAt: new Date(),
          reviewNotes: parsed.data.reviewNotes ?? null,
          appliedAt: accepted && appliedFields.length > 0 ? new Date() : null,
        },
        select: { id: true, status: true, reviewedAt: true, appliedAt: true, reviewNotes: true },
      })
    })

    await internalAudit(req, consultingFirmId, 'UPDATE', 'PartnerProfileChangeRequest', request.id,
      `Partner profile change ${parsed.data.status}${appliedFields.length > 0 ? ` (applied: ${appliedFields.join(', ')})` : ''}`)
    res.json({ success: true, data: { ...result, appliedFields } })
  } catch (err) { next(err) }
})

router.use('/admin', adminRouter)

// =============================================================
// EXTERNAL — partner-facing
// =============================================================

router.post('/auth/accept-invite', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({
      token: z.string().min(10),
      password: z.string().min(12).max(200),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid invite token and a password of at least 12 characters are required')

    const hash = crypto.createHash('sha256').update(parsed.data.token).digest('hex')
    const user = await prisma.partnerPortalUser.findFirst({
      where: { inviteTokenHash: hash, revokedAt: null, isActive: true },
      select: { id: true, inviteExpiresAt: true, consultingFirmId: true, partnerId: true, email: true },
    })
    if (!user || !user.inviteExpiresAt || user.inviteExpiresAt < new Date()) {
      throw new UnauthorizedError('That invitation is invalid or has expired')
    }

    await prisma.partnerPortalUser.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(parsed.data.password, 10),
        acceptedAt: new Date(),
        // Single use: the invite cannot be replayed.
        inviteTokenHash: null, inviteExpiresAt: null,
      },
    })
    await partnerAudit({ consultingFirmId: user.consultingFirmId, partnerPortalUserId: user.id },
      'UPDATE', 'PartnerPortalUser', user.id, 'Partner accepted portal invitation')
    res.json({ success: true, data: { accepted: true } })
  } catch (err) { next(err) }
})

router.post('/auth/login', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({
      email: z.string().trim().email(), password: z.string().min(1),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new UnauthorizedError('Invalid credentials')

    // An address is unique per FIRM, not globally: the same subcontractor
    // employee can hold an account with two different primes. Matching on
    // email alone would silently resolve to whichever row the database
    // returned first and lock them out of the other. So every candidate is
    // considered, and the password decides which account this is.
    const candidates = await prisma.partnerPortalUser.findMany({
      where: { email: parsed.data.email.toLowerCase(), isActive: true, revokedAt: null },
      select: {
        id: true, passwordHash: true, acceptedAt: true, consultingFirmId: true,
        partnerId: true, email: true, firstName: true, lastName: true, mfaEnabled: true,
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    })

    let user: (typeof candidates)[number] | null = null
    for (const candidate of candidates) {
      if (!candidate.passwordHash || !candidate.acceptedAt) continue
      if (await bcrypt.compare(parsed.data.password, candidate.passwordHash)) { user = candidate; break }
    }
    // Uniform failure: never reveal whether the account exists or is unaccepted.
    if (!user) throw new UnauthorizedError('Invalid credentials')

    // A correct password alone is not a session when a second factor is on.
    // The challenge token carries a scope that every data route rejects.
    if (user.mfaEnabled) {
      return res.json({
        success: false,
        error: 'A second-factor code is required to finish signing in',
        code: 'MFA_REQUIRED',
        mfaChallengeToken: generatePartnerChallengeToken({
          partnerPortalUserId: user.id, partnerId: user.partnerId,
          consultingFirmId: user.consultingFirmId, role: 'PARTNER', email: user.email,
        }),
      })
    }

    await prisma.partnerPortalUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    const branding = await prisma.consultingFirm.findUnique({
      where: { id: user.consultingFirmId },
      select: { brandingDisplayName: true, brandingLogoUrl: true, brandingPrimaryColor: true, brandingSecondaryColor: true },
    })

    res.json({
      success: true,
      data: {
        token: generatePartnerToken({
          partnerPortalUserId: user.id, partnerId: user.partnerId,
          consultingFirmId: user.consultingFirmId, role: 'PARTNER', email: user.email,
        }),
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        branding,
      },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Password reset — single-use, hash-stored, and deliberately incurious
// -------------------------------------------------------------

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000

/**
 * The one response this endpoint gives.
 *
 * Identical for a known address, an unknown address, a revoked account and an
 * account that never accepted its invitation — otherwise the endpoint becomes
 * a directory of who works for which subcontractor.
 */
const GENERIC_RESET_RESPONSE = {
  success: true,
  data: { message: 'If that email address has a portal account, a reset link has been sent to it.' },
}

const partnerAuthRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again later.' },
  // The integration suite drives dozens of resets and code attempts from one
  // address on purpose. Skipping under NODE_ENV=test keeps the throttle real
  // everywhere it protects a real account.
  skip: () => process.env.NODE_ENV === 'test',
})

router.post('/auth/forgot-password', partnerAuthRateLimit, async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({ email: z.string().trim().email().max(200) }).safeParse(req.body ?? {})
    // Even a malformed address gets the same answer.
    if (!parsed.success) return res.json(GENERIC_RESET_RESPONSE)

    // Same reasoning as login: the address may belong to an account at more
    // than one prime, and each of those accounts deserves its own reset.
    const users = await prisma.partnerPortalUser.findMany({
      where: { email: parsed.data.email.toLowerCase(), isActive: true, revokedAt: null, acceptedAt: { not: null } },
      select: { id: true, email: true, firstName: true, consultingFirmId: true },
      take: 20,
    })
    if (users.length === 0) return res.json(GENERIC_RESET_RESPONSE)

    for (const user of users) await issuePartnerReset(user)
    res.json(GENERIC_RESET_RESPONSE)
  } catch (err) { next(err) }
})

/** Spend any outstanding reset for this account and email a fresh single-use link. */
async function issuePartnerReset(
  user: { id: string; email: string; firstName: string; consultingFirmId: string },
): Promise<void> {
    const rawToken = crypto.randomBytes(32).toString('hex')
    await prisma.$transaction([
      // An outstanding reset is spent the moment a new one is requested.
      prisma.partnerPortalPasswordReset.updateMany({
        where: { partnerPortalUserId: user.id, usedAt: null }, data: { usedAt: new Date() },
      }),
      prisma.partnerPortalPasswordReset.create({
        data: {
          consultingFirmId: user.consultingFirmId,
          partnerPortalUserId: user.id,
          // Only the hash is stored, so a database read cannot be replayed.
          tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
        },
      }),
    ])

    const base = process.env.PUBLIC_APP_URL || 'http://localhost:5173'
    const resetUrl = `${base}/partner/reset-password?token=${encodeURIComponent(rawToken)}`
    const email = await renderBrandedEmail({
      firmId: user.consultingFirmId,
      recipientName: user.firstName,
      subject: 'Partner portal — password reset link',
      preheader: 'Reset your partner portal password — this link expires in 1 hour.',
      bodyHtml: '<p>We received a request to reset your partner portal password. Choose a new one using the link below.</p><p style="color:#94a3b8;font-size:13px;">This link expires in 1 hour and can be used once. If you did not request it, you can ignore this email.</p>',
      ctaUrl: resetUrl,
      ctaText: 'Choose a new password',
    })
    const delivery = await sendEmail({
      to: user.email,
      subject: 'Partner portal — password reset link',
      category: 'PASSWORD_RESET',
      htmlBody: email.html,
      textBody: email.text,
      consultingFirmId: user.consultingFirmId,
    })
    // The token itself is never logged, in any environment.
    if (!delivery.delivered && !delivery.devFallback) {
      logger.warn('Partner portal reset email failed to send', {
        partnerPortalUserId: user.id, provider: delivery.provider, error: delivery.error,
      })
    }

    await partnerAudit({ consultingFirmId: user.consultingFirmId, partnerPortalUserId: user.id },
      'UPDATE', 'PartnerPortalUser', user.id, 'Partner portal password reset requested')
}

router.post('/auth/reset-password', partnerAuthRateLimit, async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = z.object({
      token: z.string().min(10),
      password: z.string().min(12).max(200),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A valid reset token and a password of at least 12 characters are required')

    const tokenHash = crypto.createHash('sha256').update(parsed.data.token).digest('hex')
    const reset = await prisma.partnerPortalPasswordReset.findUnique({
      where: { tokenHash },
      select: {
        id: true, usedAt: true, expiresAt: true, partnerPortalUserId: true, consultingFirmId: true,
        portalUser: { select: { id: true, isActive: true, revokedAt: true, acceptedAt: true } },
      },
    })
    // Expired, spent, unknown and revoked all fail the same way.
    const usable = reset && !reset.usedAt && reset.expiresAt > new Date() &&
      reset.portalUser.isActive && !reset.portalUser.revokedAt && reset.portalUser.acceptedAt
    if (!usable) throw new UnauthorizedError('That reset link is invalid or has expired')

    await prisma.$transaction([
      prisma.partnerPortalUser.update({
        where: { id: reset!.partnerPortalUserId },
        data: { passwordHash: await bcrypt.hash(parsed.data.password, 10) },
      }),
      prisma.partnerPortalPasswordReset.update({ where: { id: reset!.id }, data: { usedAt: new Date() } }),
    ])
    // Whoever triggered the reset does not get to keep an older session.
    await revokePartnerTokens(reset!.partnerPortalUserId)

    await partnerAudit(
      { consultingFirmId: reset!.consultingFirmId, partnerPortalUserId: reset!.partnerPortalUserId },
      'UPDATE', 'PartnerPortalUser', reset!.partnerPortalUserId, 'Partner portal password reset completed')
    res.json({ success: true, data: { reset: true, message: 'Your password has been changed. Please sign in.' } })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Second factor — the same otpauth library, window and recovery-code
// handling as an internal account. No second MFA implementation.
// -------------------------------------------------------------

router.post('/auth/mfa/verify', partnerAuthRateLimit, authenticatePartnerChallenge, async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const parsed = z.object({ code: z.string().trim().min(1).max(40) }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A code is required')

    const user = await prisma.partnerPortalUser.findUnique({
      where: { id: ctx.partnerPortalUserId },
      select: {
        id: true, email: true, firstName: true, lastName: true, mfaEnabled: true,
        mfaSecret: true, mfaRecoveryCodes: true, consultingFirmId: true, partnerId: true,
      },
    })
    if (!user?.mfaEnabled || !user.mfaSecret) throw new UnauthorizedError('Invalid credentials')

    let ok = verifyTotp(decryptSecret(user.mfaSecret), parsed.data.code)
    if (!ok) {
      const idx = await matchRecoveryCode(user.mfaRecoveryCodes, parsed.data.code)
      if (idx >= 0) {
        const usedHash = user.mfaRecoveryCodes[idx]
        // Consume exactly this code, atomically, so two concurrent requests
        // cannot spend it twice.
        const consumed = await prisma.$executeRaw`UPDATE "partner_portal_users" SET "mfaRecoveryCodes" = array_remove("mfaRecoveryCodes", ${usedHash}) WHERE "id" = ${user.id} AND ${usedHash} = ANY("mfaRecoveryCodes")`
        if (consumed > 0) {
          ok = true
          await partnerAudit({ consultingFirmId: user.consultingFirmId, partnerPortalUserId: user.id },
            'UPDATE', 'PartnerPortalUser', user.id, 'Partner portal recovery code used')
        }
      }
    }
    if (!ok) throw new UnauthorizedError('Invalid code')

    await prisma.partnerPortalUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    const branding = await prisma.consultingFirm.findUnique({
      where: { id: user.consultingFirmId },
      select: { brandingDisplayName: true, brandingLogoUrl: true, brandingPrimaryColor: true, brandingSecondaryColor: true },
    })
    res.json({
      success: true,
      data: {
        token: generatePartnerToken({
          partnerPortalUserId: user.id, partnerId: user.partnerId,
          consultingFirmId: user.consultingFirmId, role: 'PARTNER', email: user.email,
        }),
        user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName },
        branding,
      },
    })
  } catch (err) { next(err) }
})

const portal = Router()
portal.use(authenticatePartnerJWT)

portal.get('/me', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const [user, partner, grants] = await Promise.all([
      prisma.partnerPortalUser.findUnique({
        where: { id: ctx.partnerPortalUserId },
        select: { id: true, email: true, firstName: true, lastName: true, lastLoginAt: true },
      }),
      // Only the partner's own company facts — never prime-side scoring or notes.
      prisma.partner.findUnique({
        where: { id: ctx.partnerId },
        select: { id: true, name: true, uei: true, cage: true, capabilities: true, certifications: true, geography: true },
      }),
      loadGrants(ctx.partnerPortalUserId),
    ])
    res.json({ success: true, data: { user, partner, engagementCount: grants.length } })
  } catch (err) { next(err) }
})

/** Engagements the caller has been granted — nothing else, ever. */
portal.get('/engagements', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const grants = await loadGrants(ctx.partnerPortalUserId)
    const byType = (t: PartnerEngagementScope) => grants.filter((g) => g.scopeType === t).map((g) => g.scopeId)

    const [opportunities, contracts, orders] = await Promise.all([
      prisma.opportunity.findMany({
        where: { id: { in: byType(PartnerEngagementScope.OPPORTUNITY) }, consultingFirmId: ctx.consultingFirmId },
        // Deliberately minimal: no probability, no expected value, no scoring.
        select: { id: true, title: true, agency: true, solicitationNumber: true, responseDeadline: true },
      }),
      prisma.contract.findMany({
        where: { id: { in: byType(PartnerEngagementScope.CONTRACT) }, consultingFirmId: ctx.consultingFirmId },
        // No ceiling, award value, funding or budget — that is prime-internal.
        select: { id: true, contractNumber: true, title: true, agency: true, startDate: true, endDate: true },
      }),
      prisma.purchaseOrder.findMany({
        where: {
          id: { in: byType(PartnerEngagementScope.PURCHASE_ORDER) },
          consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId,
        },
        select: { id: true, poNumber: true, status: true, ceilingAmount: true, startDate: true, endDate: true },
      }),
    ])

    res.json({
      success: true,
      data: {
        opportunities, contracts,
        purchaseOrders: orders.map((o) => ({ ...o, ceilingAmount: o.ceilingAmount.toFixed(2) })),
        note: 'You see only the engagements the prime contractor has explicitly granted you.',
      },
    })
  } catch (err) { next(err) }
})

portal.get('/purchase-orders/:id', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const po = await resolveAccessiblePurchaseOrder(ctx, req.params.id)

    const invoices = await prisma.subcontractInvoice.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, purchaseOrderId: po.id, partnerId: ctx.partnerId },
      select: { id: true, invoiceNumber: true, invoiceDate: true, amount: true, status: true, postedAt: true, paymentRecordedAt: true },
      orderBy: { invoiceDate: 'desc' },
    })
    const submitted = invoices
      .filter((i) => i.status !== SubcontractInvoiceStatus.REJECTED)
      .reduce((s, i) => s.plus(i.amount), new Prisma.Decimal(0))

    res.json({
      success: true,
      data: {
        id: po.id, poNumber: po.poNumber, status: po.status, description: po.description,
        startDate: po.startDate, endDate: po.endDate, isSubcontract: po.isSubcontract,
        ceilingAmount: po.ceilingAmount.toFixed(2),
        invoicedTotal: submitted.toFixed(2),
        remainingBalance: new Prisma.Decimal(po.ceilingAmount).minus(submitted).toFixed(2),
        lines: po.lines.map((l) => ({
          id: l.id, description: l.description, amount: l.amount.toFixed(2),
          quantity: l.quantity?.toFixed(4) ?? null, unit: l.unit, unitPrice: l.unitPrice?.toFixed(4) ?? null,
        })),
        invoices: invoices.map((i) => ({
          id: i.id, invoiceNumber: i.invoiceNumber, invoiceDate: i.invoiceDate,
          amount: i.amount.toFixed(2), status: i.status,
          postedByPrime: Boolean(i.postedAt), paymentRecorded: Boolean(i.paymentRecordedAt),
        })),
      },
    })
  } catch (err) { next(err) }
})

/** Deliverables explicitly attributed to this partner on a granted contract. */
portal.get('/deliverables', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const grants = await loadGrants(ctx.partnerPortalUserId)
    const contractIds = grants.filter((g) => g.scopeType === PartnerEngagementScope.CONTRACT).map((g) => g.scopeId)
    if (contractIds.length === 0) return res.json({ success: true, data: [] })

    const rows = await prisma.contractDeliverable.findMany({
      where: {
        consultingFirmId: ctx.consultingFirmId,
        contractId: { in: contractIds },
        // Only rows a prime human explicitly attributed to this partner.
        partnerId: ctx.partnerId,
      },
      select: { id: true, name: true, cdrlNumber: true, description: true, dueDate: true, status: true },
      orderBy: { dueDate: 'asc' }, take: 200,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

/** Flow-downs the prime has explicitly shared with this subcontract. */
portal.get('/purchase-orders/:id/flow-downs', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const po = await resolveAccessiblePurchaseOrder(ctx, req.params.id)
    const rows = await prisma.subcontractFlowDown.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, purchaseOrderId: po.id, partnerVisible: true },
      select: {
        id: true, clauseNumber: true, clauseTitle: true, state: true, evidence: true,
        partnerAcknowledgedAt: true,
      },
      orderBy: { clauseNumber: 'asc' },
    })
    res.json({
      success: true,
      data: {
        items: rows,
        disclaimer:
          'These are the clauses the prime contractor has shared with you. Acknowledging one records that you received it. It is not a legal determination, and it does not clear the prime’s legal review.',
      },
    })
  } catch (err) { next(err) }
})

portal.post('/flow-downs/:id/acknowledge', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const row = await prisma.subcontractFlowDown.findFirst({
      where: { id: req.params.id, consultingFirmId: ctx.consultingFirmId, partnerVisible: true },
      select: { id: true, purchaseOrderId: true, state: true },
    })
    if (!row) throw new ForbiddenError('You do not have access to this record')
    await resolveAccessiblePurchaseOrder(ctx, row.purchaseOrderId)

    const updated = await prisma.subcontractFlowDown.update({
      where: { id: row.id },
      // Acknowledgment only. `state` is the prime's legal field and is untouched.
      data: { partnerAcknowledgedAt: new Date(), partnerAcknowledgedByPortalUserId: ctx.partnerPortalUserId },
      select: { id: true, clauseNumber: true, state: true, partnerAcknowledgedAt: true },
    })
    await partnerAudit(ctx, 'UPDATE', 'SubcontractFlowDown', row.id, `Partner acknowledged flow-down ${updated.clauseNumber}`)
    res.json({
      success: true,
      data: { ...updated, note: 'Receipt recorded. The prime contractor’s legal review state is unchanged.' },
    })
  } catch (err) { next(err) }
})

/**
 * Submit an invoice against the caller's own accessible purchase order.
 *
 * The partner may create; only a prime human may approve, reject, post cost or
 * record payment — those live on the internal ERP route.
 */
portal.post('/invoices', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const parsed = z.object({
      purchaseOrderId: z.string().uuid(),
      invoiceNumber: z.string().trim().min(1).max(80),
      invoiceDate: z.string().datetime(),
      amount: z.union([z.number(), z.string()]),
      servicePeriodStart: z.string().datetime().nullable().optional(),
      servicePeriodEnd: z.string().datetime().nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid invoice payload')
    const d = parsed.data

    // Ownership, tenancy and grant are all re-derived server-side.
    const po = await resolveAccessiblePurchaseOrder(ctx, d.purchaseOrderId)
    if (po.status === 'DRAFT' || po.status === 'CANCELLED') {
      throw new ValidationError(`An invoice cannot be submitted against a ${po.status} purchase order`)
    }

    const amount = new Prisma.Decimal(d.amount)
    if (amount.isNegative() || amount.isZero()) throw new ValidationError('An invoice amount must be greater than zero')

    const dup = await prisma.subcontractInvoice.findFirst({
      where: { consultingFirmId: ctx.consultingFirmId, purchaseOrderId: po.id, invoiceNumber: d.invoiceNumber },
      select: { id: true },
    })
    if (dup) throw new ValidationError('You have already submitted an invoice with that number against this order')

    const created = await prisma.subcontractInvoice.create({
      data: {
        consultingFirmId: ctx.consultingFirmId,
        purchaseOrderId: po.id,
        partnerId: ctx.partnerId,
        vendorName: po.vendorName,
        invoiceNumber: d.invoiceNumber,
        invoiceDate: new Date(d.invoiceDate),
        servicePeriodStart: d.servicePeriodStart ? new Date(d.servicePeriodStart) : null,
        servicePeriodEnd: d.servicePeriodEnd ? new Date(d.servicePeriodEnd) : null,
        amount,
        notes: d.notes ?? null,
        // Enters the prime's existing ERP queue, unapproved and unposted.
        status: SubcontractInvoiceStatus.RECEIVED,
        submittedByPortalUserId: ctx.partnerPortalUserId,
      },
      select: { id: true, invoiceNumber: true, amount: true, status: true, invoiceDate: true },
    })
    await partnerAudit(ctx, 'CREATE', 'SubcontractInvoice', created.id, `Partner submitted invoice ${created.invoiceNumber}`)
    res.status(201).json({
      success: true,
      data: {
        ...created, amount: created.amount.toFixed(2),
        note: 'Submitted for the prime contractor’s review. It becomes a cost on their books only after they approve it.',
      },
    })
  } catch (err) { next(err) }
})

portal.get('/invoices', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const rows = await prisma.subcontractInvoice.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId },
      select: {
        id: true, invoiceNumber: true, invoiceDate: true, amount: true, status: true,
        postedAt: true, paymentRecordedAt: true, rejectionReason: true,
        purchaseOrder: { select: { id: true, poNumber: true } },
      },
      orderBy: { invoiceDate: 'desc' }, take: 200,
    })
    res.json({ success: true, data: rows.map((r) => ({ ...r, amount: r.amount.toFixed(2) })) })
  } catch (err) { next(err) }
})

/** Upload a requested document against a granted engagement. */
portal.post('/documents', upload.single('file'), async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const parsed = z.object({
      scopeType: z.nativeEnum(PartnerEngagementScope),
      scopeId: z.string().min(1),
      category: z.string().trim().min(1).max(80),
      title: z.string().trim().min(1).max(200),
      notes: z.string().trim().max(2000).optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid document payload')
    const file = (req as unknown as { file?: Express.Multer.File }).file
    if (!file) throw new ValidationError('A file is required')

    // The grant is checked before the file is ever associated with anything.
    await assertGrant(ctx.partnerPortalUserId, parsed.data.scopeType, parsed.data.scopeId)

    const created = await prisma.partnerPortalUpload.create({
      data: {
        consultingFirmId: ctx.consultingFirmId,
        partnerId: ctx.partnerId,
        partnerPortalUserId: ctx.partnerPortalUserId,
        scopeType: parsed.data.scopeType,
        scopeId: parsed.data.scopeId,
        category: parsed.data.category,
        title: parsed.data.title,
        notes: parsed.data.notes ?? null,
        fileName: file.originalname,
        // MIME comes from the upload middleware's validation, never the filename.
        fileType: file.mimetype,
        fileSize: file.size,
        storageKey: file.filename ?? file.path,
      },
      select: { id: true, title: true, fileName: true, reviewStatus: true, createdAt: true },
    })
    await partnerAudit(ctx, 'CREATE', 'PartnerPortalUpload', created.id, `Partner uploaded document: ${created.title}`)
    res.status(201).json({ success: true, data: created })
  } catch (err) { next(err) }
})

portal.get('/documents', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const rows = await prisma.partnerPortalUpload.findMany({
      // Own partner only — never another subcontractor's submissions.
      where: { consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId },
      select: {
        id: true, title: true, category: true, fileName: true, fileSize: true,
        reviewStatus: true, reviewNotes: true, createdAt: true, scopeType: true, scopeId: true,
      },
      orderBy: { createdAt: 'desc' }, take: 200,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

/**
 * Offer personnel for a granted engagement. Lands as evidence pending review.
 *
 * An attached resume file becomes an ordinary `PartnerPortalUpload` and the
 * submission points at it, so the file has exactly one record, one download
 * authorization path, and one provenance chain into the personnel library.
 */
portal.post('/personnel-contributions', upload.single('file'), async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const parsed = z.object({
      scopeType: z.nativeEnum(PartnerEngagementScope),
      scopeId: z.string().min(1),
      fullName: z.string().trim().min(1).max(200),
      proposedRole: z.string().trim().max(200).nullable().optional(),
      laborCategory: z.string().trim().max(160).nullable().optional(),
      content: z.union([z.record(z.unknown()), z.string()]).optional(),
    }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid contribution payload')
    await assertGrant(ctx.partnerPortalUserId, parsed.data.scopeType, parsed.data.scopeId)

    // A multipart body delivers `content` as a JSON string; a JSON body
    // delivers it as an object. Malformed JSON is an empty document, never a
    // guess at what the partner meant.
    let content: Record<string, unknown> = {}
    if (typeof parsed.data.content === 'string') {
      try {
        const decoded = JSON.parse(parsed.data.content) as unknown
        if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) content = decoded as Record<string, unknown>
      } catch { throw new ValidationError('The structured resume content is not valid JSON') }
    } else if (parsed.data.content) {
      content = parsed.data.content
    }

    const file = (req as unknown as { file?: Express.Multer.File }).file
    const created = await prisma.$transaction(async (tx) => {
      let uploadId: string | null = null
      if (file) {
        const upl = await tx.partnerPortalUpload.create({
          data: {
            consultingFirmId: ctx.consultingFirmId,
            partnerId: ctx.partnerId,
            partnerPortalUserId: ctx.partnerPortalUserId,
            scopeType: parsed.data.scopeType,
            scopeId: parsed.data.scopeId,
            category: 'PERSONNEL_RESUME',
            title: `Resume — ${parsed.data.fullName}`,
            fileName: file.originalname,
            fileType: file.mimetype,
            fileSize: file.size,
            storageKey: file.filename ?? file.path,
          },
          select: { id: true },
        })
        uploadId = upl.id
      }
      return tx.partnerPersonnelSubmission.create({
        data: {
          consultingFirmId: ctx.consultingFirmId,
          partnerId: ctx.partnerId,
          partnerPortalUserId: ctx.partnerPortalUserId,
          scopeType: parsed.data.scopeType,
          scopeId: parsed.data.scopeId,
          fullName: parsed.data.fullName,
          proposedRole: parsed.data.proposedRole ?? null,
          laborCategory: parsed.data.laborCategory ?? null,
          content: content as Prisma.InputJsonObject,
          fileName: file?.originalname ?? null,
          storageKey: file ? (file.filename ?? file.path) : null,
          sourceUploadId: uploadId,
          status: PartnerSubmissionStatus.PENDING_REVIEW,
        },
        select: { id: true, fullName: true, status: true, createdAt: true, fileName: true },
      })
    })
    await partnerAudit(ctx, 'CREATE', 'PartnerPersonnelSubmission', created.id, `Partner submitted personnel: ${created.fullName}`)
    res.status(201).json({
      success: true,
      data: { ...created, note: 'Submitted for the prime contractor’s review. It is not added to their approved library automatically.' },
    })
  } catch (err) { next(err) }
})

/**
 * Download a document this partner uploaded.
 *
 * Authorization happens before a byte is read, and every condition is
 * re-derived here rather than inferred from the id in the URL: the row must
 * belong to the prime tenant on the token AND to the caller's own partner
 * company, and the caller must still hold an unrevoked grant for the
 * engagement the document was filed against. A previously copied id is
 * therefore worth nothing after a revocation — the grant is checked on this
 * request, not at upload time.
 */
portal.get('/documents/:id/download', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const doc = await prisma.partnerPortalUpload.findFirst({
      where: { id: req.params.id, consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId },
      select: { id: true, fileName: true, fileType: true, storageKey: true, scopeType: true, scopeId: true, title: true },
    })
    if (!doc) throw new ForbiddenError('You do not have access to this document')
    await assertGrant(ctx.partnerPortalUserId, doc.scopeType, doc.scopeId)

    await partnerAudit(ctx, 'ACCESS', 'PartnerPortalUpload', doc.id, `Partner downloaded document: ${doc.title}`)
    sendAuthorizedFile(res, doc)
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Deliverables — a partner responds; a prime accepts
// -------------------------------------------------------------

/** One attributed deliverable, with this partner's own submission history. */
portal.get('/deliverables/:id', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const deliverable = await resolveAccessibleDeliverable(ctx, req.params.id)
    const submissions = await prisma.partnerDeliverableSubmission.findMany({
      where: {
        consultingFirmId: ctx.consultingFirmId, deliverableId: deliverable.id, partnerId: ctx.partnerId,
      },
      select: {
        id: true, status: true, note: true, fileName: true, fileSize: true,
        submittedAt: true, reviewedAt: true, reviewNotes: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })
    res.json({
      success: true,
      data: {
        id: deliverable.id, name: deliverable.name, cdrlNumber: deliverable.cdrlNumber,
        description: deliverable.description, dueDate: deliverable.dueDate,
        frequency: deliverable.frequency,
        // The prime's own status, read-only. Nothing on this router writes it.
        primeStatus: deliverable.status,
        submissions,
        note: 'Submitting a response records it for the prime contractor to review. The prime decides whether it is accepted, and the government acceptance record stays with them.',
      },
    })
  } catch (err) { next(err) }
})

/**
 * Create or replace this partner's DRAFT response to a deliverable.
 *
 * A submitted or accepted response is never edited in place — a partner starts
 * a new draft instead, so the evidence trail of what was submitted when is not
 * rewritten after the fact.
 */
portal.post('/deliverables/:id/submissions', upload.single('file'), async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const parsed = z.object({ note: z.string().trim().max(4000).optional() }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('Invalid submission payload')
    const deliverable = await resolveAccessibleDeliverable(ctx, req.params.id)
    const file = (req as unknown as { file?: Express.Multer.File }).file

    const existingDraft = await prisma.partnerDeliverableSubmission.findFirst({
      where: {
        consultingFirmId: ctx.consultingFirmId, deliverableId: deliverable.id, partnerId: ctx.partnerId,
        status: { in: [PartnerDeliverableSubmissionStatus.DRAFT, PartnerDeliverableSubmissionStatus.CHANGES_REQUESTED] },
      },
      select: { id: true, fileName: true, fileType: true, fileSize: true, storageKey: true },
      orderBy: { createdAt: 'desc' },
    })

    const fileFields = file
      ? { fileName: file.originalname, fileType: file.mimetype, fileSize: file.size, storageKey: file.filename ?? file.path }
      : {}

    const row = existingDraft
      ? await prisma.partnerDeliverableSubmission.update({
        where: { id: existingDraft.id },
        data: {
          note: parsed.data.note ?? null,
          status: PartnerDeliverableSubmissionStatus.DRAFT,
          ...fileFields,
        },
        select: { id: true, status: true, note: true, fileName: true, createdAt: true },
      })
      : await prisma.partnerDeliverableSubmission.create({
        data: {
          consultingFirmId: ctx.consultingFirmId,
          deliverableId: deliverable.id,
          partnerId: ctx.partnerId,
          partnerPortalUserId: ctx.partnerPortalUserId,
          status: PartnerDeliverableSubmissionStatus.DRAFT,
          note: parsed.data.note ?? null,
          ...fileFields,
        },
        select: { id: true, status: true, note: true, fileName: true, createdAt: true },
      })

    await partnerAudit(ctx, existingDraft ? 'UPDATE' : 'CREATE', 'PartnerDeliverableSubmission', row.id,
      `Partner saved a draft response to deliverable ${deliverable.name}`)
    res.status(existingDraft ? 200 : 201).json({
      success: true,
      data: { ...row, message: 'Saved as a draft. It is not visible to the prime contractor as a response until you submit it.' },
    })
  } catch (err) { next(err) }
})

/** Hand a draft to the prime. The deliverable's own status is untouched. */
portal.post('/deliverable-submissions/:id/submit', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const row = await prisma.partnerDeliverableSubmission.findFirst({
      where: { id: req.params.id, consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId },
      select: { id: true, status: true, deliverableId: true, storageKey: true, note: true },
    })
    if (!row) throw new ForbiddenError('You do not have access to this submission')
    // The grant is re-checked here too: a revocation between saving and
    // submitting must stop the submission.
    const deliverable = await resolveAccessibleDeliverable(ctx, row.deliverableId)

    if (row.status === PartnerDeliverableSubmissionStatus.ACCEPTED_BY_PRIME) {
      throw new ValidationError('That response has already been accepted and cannot be resubmitted')
    }
    if (row.status === PartnerDeliverableSubmissionStatus.SUBMITTED) {
      throw new ValidationError('That response has already been submitted and is awaiting the prime contractor’s review')
    }
    if (!row.storageKey && !row.note) {
      throw new ValidationError('Attach a file or add a note before submitting')
    }

    const updated = await prisma.partnerDeliverableSubmission.update({
      where: { id: row.id },
      data: { status: PartnerDeliverableSubmissionStatus.SUBMITTED, submittedAt: new Date() },
      select: { id: true, status: true, submittedAt: true },
    })
    await partnerAudit(ctx, 'UPDATE', 'PartnerDeliverableSubmission', row.id,
      `Partner submitted a response to deliverable ${deliverable.name}`)
    res.json({
      success: true,
      data: {
        ...updated,
        note: 'Submitted for the prime contractor’s review. Only the prime can accept it, and the deliverable’s official status is theirs to set.',
      },
    })
  } catch (err) { next(err) }
})

portal.get('/deliverable-submissions/:id/download', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const row = await prisma.partnerDeliverableSubmission.findFirst({
      where: { id: req.params.id, consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId },
      select: { id: true, fileName: true, fileType: true, storageKey: true, deliverableId: true },
    })
    if (!row) throw new ForbiddenError('You do not have access to this submission')
    await resolveAccessibleDeliverable(ctx, row.deliverableId)
    sendAuthorizedFile(res, row)
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Self-service profile — proposals only
// -------------------------------------------------------------

portal.get('/profile', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const [partner, requests] = await Promise.all([
      prisma.partner.findFirst({
        where: { id: ctx.partnerId, consultingFirmId: ctx.consultingFirmId },
        // The editable allowlist plus the identity fields, and nothing the
        // prime formed an opinion with.
        select: {
          id: true, name: true, uei: true, cage: true, website: true, geography: true,
          contactName: true, contactEmail: true, contactPhone: true,
          capabilities: true, certifications: true, primaryNaicsCodes: true,
        },
      }),
      prisma.partnerProfileChangeRequest.findMany({
        where: { consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId },
        select: { id: true, status: true, proposed: true, submittedNote: true, reviewNotes: true, reviewedAt: true, appliedAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' }, take: 50,
      }),
    ])
    if (!partner) throw new ForbiddenError('You do not have access to this record')
    res.json({
      success: true,
      data: {
        partner,
        changeRequests: requests,
        editableFields: ['website', 'geography', 'contactName', 'contactEmail', 'contactPhone', 'capabilities', 'certifications', 'primaryNaicsCodes'],
        note: 'Changes are proposed, not applied. The prime contractor reviews each one before it takes effect on their record of your company.',
      },
    })
  } catch (err) { next(err) }
})

portal.post('/profile/change-requests', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const body = z.object({
      proposed: z.unknown(),
      submittedNote: z.string().trim().max(1000).nullable().optional(),
    }).safeParse(req.body ?? {})
    if (!body.success) throw new ValidationError('Invalid change request payload')

    // `.strict()` — a field outside the allowlist is a rejection, not a
    // silently dropped key, so a caller cannot believe it changed something.
    const proposal = PartnerProfileProposalSchema.safeParse(body.data.proposed ?? {})
    if (!proposal.success) {
      throw new ValidationError(
        proposal.error.issues[0]?.code === 'unrecognized_keys'
          ? 'That field cannot be changed from the partner portal'
          : proposal.error.issues[0]?.message ?? 'Invalid change request payload',
      )
    }
    if (Object.keys(proposal.data).length === 0) throw new ValidationError('No changes were proposed')

    const partner = await prisma.partner.findFirst({
      where: { id: ctx.partnerId, consultingFirmId: ctx.consultingFirmId },
    })
    if (!partner) throw new ForbiddenError('You do not have access to this record')

    const pending = await prisma.partnerProfileChangeRequest.findFirst({
      where: {
        consultingFirmId: ctx.consultingFirmId, partnerId: ctx.partnerId,
        status: PartnerSubmissionStatus.PENDING_REVIEW,
      },
      select: { id: true },
    })
    if (pending) throw new ValidationError('You already have a change request awaiting review')

    const created = await prisma.partnerProfileChangeRequest.create({
      data: {
        consultingFirmId: ctx.consultingFirmId,
        partnerId: ctx.partnerId,
        partnerPortalUserId: ctx.partnerPortalUserId,
        proposed: proposal.data as Prisma.InputJsonObject,
        previous: currentProfileSnapshot(partner as unknown as Record<string, unknown>),
        submittedNote: body.data.submittedNote ?? null,
        status: PartnerSubmissionStatus.PENDING_REVIEW,
      },
      select: { id: true, status: true, proposed: true, createdAt: true },
    })
    await partnerAudit(ctx, 'CREATE', 'PartnerProfileChangeRequest', created.id, 'Partner proposed a profile change')
    res.status(201).json({
      success: true,
      data: { ...created, note: 'Submitted for the prime contractor’s review. Nothing on their record has changed yet.' },
    })
  } catch (err) { next(err) }
})

// -------------------------------------------------------------
// Second factor — enrollment and removal
// -------------------------------------------------------------

portal.get('/mfa/status', async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const row = await prisma.partnerPortalUser.findUnique({
      where: { id: ctx.partnerPortalUserId }, select: { mfaEnabled: true, mfaEnrolledAt: true },
    })
    res.json({ success: true, data: { enabled: Boolean(row?.mfaEnabled), enrolledAt: row?.mfaEnrolledAt ?? null } })
  } catch (err) { next(err) }
})

/** Begin enrollment. The secret is stored encrypted and returned exactly once. */
portal.post('/mfa/enroll', partnerAuthRateLimit, async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const user = await prisma.partnerPortalUser.findUnique({
      where: { id: ctx.partnerPortalUserId }, select: { email: true, mfaEnabled: true },
    })
    if (!user) throw new UnauthorizedError('Account access has been disabled')
    if (user.mfaEnabled) throw new ValidationError('Two-factor authentication is already on. Turn it off before enrolling again.')

    const { secret, otpauthUri } = generateMfaEnrollment(user.email)
    await prisma.partnerPortalUser.update({
      where: { id: ctx.partnerPortalUserId }, data: { mfaSecret: encryptSecret(secret) },
    })
    // The only response that ever carries the secret. Once enrollment is
    // confirmed there is no endpoint that returns it again.
    res.json({ success: true, data: { secret, otpauthUri } })
  } catch (err) { next(err) }
})

portal.post('/mfa/enroll/verify', partnerAuthRateLimit, async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const parsed = z.object({ code: z.string().trim().min(1).max(40) }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A code is required')

    const user = await prisma.partnerPortalUser.findUnique({
      where: { id: ctx.partnerPortalUserId }, select: { mfaSecret: true, mfaEnabled: true },
    })
    if (!user?.mfaSecret) throw new ValidationError('Start enrollment first')
    if (user.mfaEnabled) throw new ValidationError('Two-factor authentication is already on')
    if (!verifyTotp(decryptSecret(user.mfaSecret), parsed.data.code)) throw new UnauthorizedError('Invalid code')

    const { plain, hashed } = await generateRecoveryCodes()
    await prisma.partnerPortalUser.update({
      where: { id: ctx.partnerPortalUserId },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date(), mfaRecoveryCodes: hashed },
    })
    await partnerAudit(ctx, 'UPDATE', 'PartnerPortalUser', ctx.partnerPortalUserId, 'Partner enabled two-factor authentication')
    res.json({
      success: true,
      data: { enabled: true, recoveryCodes: plain, note: 'Save these recovery codes now. They are not shown again.' },
    })
  } catch (err) { next(err) }
})

portal.post('/mfa/disable', partnerAuthRateLimit, async (req: PartnerRequest, res: Response, next: NextFunction) => {
  try {
    const ctx = getPartnerCtx(req)
    const parsed = z.object({ code: z.string().trim().min(1).max(40) }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A code is required')

    const user = await prisma.partnerPortalUser.findUnique({
      where: { id: ctx.partnerPortalUserId }, select: { mfaEnabled: true, mfaSecret: true, mfaRecoveryCodes: true },
    })
    if (!user?.mfaEnabled || !user.mfaSecret) throw new ValidationError('Two-factor authentication is not on')
    // Turning the second factor off is itself a second-factor action.
    const ok = verifyTotp(decryptSecret(user.mfaSecret), parsed.data.code) ||
      (await matchRecoveryCode(user.mfaRecoveryCodes, parsed.data.code)) >= 0
    if (!ok) throw new UnauthorizedError('Invalid code')

    await prisma.partnerPortalUser.update({
      where: { id: ctx.partnerPortalUserId },
      data: { mfaEnabled: false, mfaSecret: null, mfaRecoveryCodes: [], mfaEnrolledAt: null },
    })
    await partnerAudit(ctx, 'UPDATE', 'PartnerPortalUser', ctx.partnerPortalUserId, 'Partner disabled two-factor authentication')
    res.json({ success: true, data: { enabled: false } })
  } catch (err) { next(err) }
})

router.use('/', portal)
export default router
