// =============================================================
// §8.5 — Signature requests.
//
// THE HUMAN GATE lives on these routes. Creating a request needs ESIGN_READ
// plus a write permission for the thing being signed; SENDING needs
// ESIGN_SEND, which ADMIN and CONTRACTS hold and no agent has any route to.
//
// A signature request is never created or advanced by an agent, and no route
// here can be reached by an agent runtime: the Section 7 forbidden-write
// matrix names SignatureRequest and SignatureSigner for all nine agents.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import fs from 'fs'
import { z } from 'zod'
import { IntegrationProvider, IntegrationStatus, SignatureDocumentType, SignatureRequestStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { authenticateJWT } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { upload } from '../middleware/upload'
import { ValidationError, NotFoundError } from '../utils/errors'
import { logAudit } from '../services/auditService'
import { resolveStoredFilePath, sendAuthorizedFile } from '../services/partnerPortal/partnerFiles'
import { findConnection, readCredential } from '../services/integrations/connectionService'
import { esignAdapterFor } from '../services/integrations/esign/docusign'
import { assertSendable } from '../services/integrations/esign/esignService'
import { ConnectorError } from '../services/integrations/accounting/connector'

const router = Router()
router.use(authenticateJWT, enforceTenantScope, requireActiveBase)

const audit = (
  req: AuthenticatedRequest, consultingFirmId: string, action: 'CREATE' | 'UPDATE' | 'APPROVAL',
  entityId: string, rationale: string,
) => logAudit({
  consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role,
  actorKind: 'INTERNAL_USER', action, entityType: 'SignatureRequest', entityId, rationale,
})

const CreateSchema = z.object({
  documentType: z.nativeEnum(SignatureDocumentType),
  title: z.string().trim().min(1).max(300),
  teamingArrangementId: z.string().min(1).nullable().optional(),
  partnerId: z.string().min(1).nullable().optional(),
  purchaseOrderId: z.string().uuid().nullable().optional(),
  /** The existing agreement draft this request is for, when there is one. */
  sourceType: z.enum(['TeamingAgreementDraft', 'UPLOAD']).optional(),
  sourceId: z.string().min(1).nullable().optional(),
  signers: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(200),
    routingOrder: z.number().int().min(1).max(20).optional(),
    role: z.string().trim().max(100).nullable().optional(),
  })).min(1).max(20),
})

router.get('/', requirePermission('ESIGN_READ'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const rows = await prisma.signatureRequest.findMany({
      where: { consultingFirmId },
      select: {
        id: true, documentType: true, status: true, title: true, provider: true,
        providerStatus: true, sentAt: true, completedAt: true, declinedAt: true, voidedAt: true,
        declineReason: true, lastError: true, fileName: true, createdAt: true,
        signers: {
          select: { id: true, name: true, email: true, routingOrder: true, status: true, signedAt: true, declinedAt: true },
          orderBy: { routingOrder: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' }, take: 200,
    })
    res.json({ success: true, data: rows })
  } catch (err) { next(err) }
})

/**
 * Create a request. A DRAFT, and only a draft — creating one sends nothing.
 *
 * The document may be uploaded here, or the request may point at an existing
 * TeamingAgreementDraft, which is re-read from this tenant so a draft id from
 * another firm cannot be attached.
 */
router.post('/', requirePermission('ESIGN_SEND'), upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const raw = { ...(req.body ?? {}) } as Record<string, unknown>
    if (typeof raw.signers === 'string') {
      try { raw.signers = JSON.parse(raw.signers) } catch { throw new ValidationError('The signer list is not valid JSON') }
    }
    const parsed = CreateSchema.safeParse(raw)
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid signature request')
    const d = parsed.data

    if (d.sourceType === 'TeamingAgreementDraft' && d.sourceId) {
      const draft = await prisma.teamingAgreementDraft.findFirst({
        where: { id: d.sourceId, consultingFirmId }, select: { id: true },
      })
      if (!draft) throw new NotFoundError('Agreement draft not found')
    }
    if (d.teamingArrangementId) {
      const arrangement = await prisma.teamingArrangement.findFirst({
        where: { id: d.teamingArrangementId, consultingFirmId }, select: { id: true },
      })
      if (!arrangement) throw new NotFoundError('Teaming arrangement not found')
    }

    const file = (req as unknown as { file?: Express.Multer.File }).file
    const created = await prisma.signatureRequest.create({
      data: {
        consultingFirmId,
        documentType: d.documentType,
        status: SignatureRequestStatus.DRAFT,
        title: d.title,
        sourceType: d.sourceType ?? (file ? 'UPLOAD' : null),
        sourceId: d.sourceId ?? null,
        teamingArrangementId: d.teamingArrangementId ?? null,
        partnerId: d.partnerId ?? null,
        purchaseOrderId: d.purchaseOrderId ?? null,
        fileName: file?.originalname ?? null,
        fileType: file?.mimetype ?? null,
        storageKey: file ? (file.filename ?? file.path) : null,
        createdByUserId: req.user?.userId ?? null,
        signers: {
          create: d.signers.map((s, index) => ({
            consultingFirmId, name: s.name, email: s.email.toLowerCase(),
            routingOrder: s.routingOrder ?? index + 1, role: s.role ?? null,
          })),
        },
      },
      include: { signers: true },
    })
    await audit(req, consultingFirmId, 'CREATE', created.id, `Signature request drafted: ${created.title}`)
    res.status(201).json({
      success: true,
      data: {
        ...created,
        note: 'Drafted. Nothing has been sent — a person must send it, and only a person can.',
      },
    })
  } catch (err) { next(err) }
})

/**
 * Send.
 *
 * The only route in the platform that hands a document to a signature
 * provider, and it requires an authenticated internal session holding
 * ESIGN_SEND. `sentByUserId` records which person did it, because "the system
 * sent it" is not an answer anyone can act on later.
 */
router.post('/:id/send', requirePermission('ESIGN_SEND'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const request = await prisma.signatureRequest.findFirst({
      where: { id: req.params.id, consultingFirmId }, include: { signers: { orderBy: { routingOrder: 'asc' } } },
    })
    if (!request) throw new NotFoundError('Signature request not found')
    assertSendable(request)

    const connection = await findConnection(consultingFirmId, IntegrationProvider.DOCUSIGN)
    if (!connection || connection.status !== IntegrationStatus.CONNECTED) {
      throw new ValidationError('No signature provider is connected. Connect one in Settings → Integrations first.')
    }
    const adapter = esignAdapterFor(connection.provider)
    if (!adapter) throw new ValidationError('No adapter is available for the connected signature provider')

    let documentBase64: string
    if (request.storageKey) {
      documentBase64 = fs.readFileSync(resolveStoredFilePath(request.storageKey)).toString('base64')
    } else if (request.sourceType === 'TeamingAgreementDraft' && request.sourceId) {
      const draft = await prisma.teamingAgreementDraft.findFirst({
        where: { id: request.sourceId, consultingFirmId }, select: { content: true },
      })
      if (!draft) throw new NotFoundError('Agreement draft not found')
      documentBase64 = Buffer.from(draft.content, 'utf8').toString('base64')
    } else {
      throw new ValidationError('This request has no document to send')
    }

    try {
      const sent = await adapter.sendEnvelope(readCredential(connection), {
        subject: request.title,
        documentName: request.fileName ?? `${request.title}.pdf`,
        documentBase64,
        signers: request.signers.map((s) => ({ name: s.name, email: s.email, routingOrder: s.routingOrder })),
      })
      const updated = await prisma.signatureRequest.update({
        where: { id: request.id },
        data: {
          status: SignatureRequestStatus.SENT,
          provider: connection.provider,
          externalEnvelopeId: sent.externalEnvelopeId,
          providerStatus: sent.providerStatus,
          sentByUserId: req.user!.userId,
          sentAt: new Date(),
          lastError: null,
        },
        include: { signers: true },
      })
      await audit(req, consultingFirmId, 'APPROVAL', request.id, `Signature request sent by a human: ${request.title}`)
      res.json({ success: true, data: updated })
    } catch (err) {
      const message = err instanceof ConnectorError ? err.message : 'The signature provider rejected the request.'
      await prisma.signatureRequest.update({
        where: { id: request.id },
        data: { status: SignatureRequestStatus.ERROR, lastError: message.slice(0, 500) },
      })
      throw new ValidationError(message)
    }
  } catch (err) { next(err) }
})

router.post('/:id/void', requirePermission('ESIGN_SEND'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const parsed = z.object({ reason: z.string().trim().min(1).max(300) }).safeParse(req.body ?? {})
    if (!parsed.success) throw new ValidationError('A reason is required to void an agreement')
    const request = await prisma.signatureRequest.findFirst({ where: { id: req.params.id, consultingFirmId } })
    if (!request) throw new NotFoundError('Signature request not found')
    if (request.status === SignatureRequestStatus.COMPLETED) {
      throw new ValidationError('A completed agreement cannot be voided')
    }

    if (request.provider && request.externalEnvelopeId) {
      const connection = await findConnection(consultingFirmId, request.provider)
      const adapter = esignAdapterFor(request.provider)
      if (connection && adapter) {
        try { await adapter.voidEnvelope(readCredential(connection), request.externalEnvelopeId, parsed.data.reason) }
        catch { /* The local state is still voided; the provider is reconciled by webhook. */ }
      }
    }

    const updated = await prisma.signatureRequest.update({
      where: { id: request.id },
      data: { status: SignatureRequestStatus.VOIDED, voidedAt: new Date(), declineReason: parsed.data.reason },
    })
    await audit(req, consultingFirmId, 'UPDATE', request.id, `Signature request voided: ${parsed.data.reason}`)
    res.json({ success: true, data: updated })
  } catch (err) { next(err) }
})

router.get('/:id/document', requirePermission('ESIGN_READ'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const request = await prisma.signatureRequest.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { fileName: true, fileType: true, storageKey: true },
    })
    if (!request) throw new NotFoundError('Signature request not found')
    sendAuthorizedFile(res, request)
  } catch (err) { next(err) }
})

export default router
