// =============================================================
// §8.5 — Inbound provider webhooks.
//
// UNAUTHENTICATED BY NECESSITY, so every other control has to be real:
//
//  1. The provider's signature is verified before the body is parsed as
//     anything meaningful. An unsigned or badly signed request is refused.
//  2. The event id is claimed exactly once. A replayed delivery is
//     acknowledged and ignored.
//  3. The tenant comes from the STORED envelope mapping, never from the body.
//     A webhook that names a consultingFirmId is naming an
//     attacker-controlled string.
//  4. A terminal state never regresses, and an out-of-order event is recorded
//     without moving the canonical status.
//
// A 200 here means "received and will not be retried", which is what a
// provider needs; the outcome of processing is recorded on the event row.
// =============================================================
import { Router, Request, Response, NextFunction } from 'express'
import express from 'express'
import { IntegrationProvider, SignatureRequestStatus } from '@prisma/client'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { logAudit } from '../services/auditService'
import {
  applyProviderStatus, claimProviderEvent, mapDocusignStatus, resolveEnvelope, verifyDocusignSignature,
} from '../services/integrations/esign/esignService'

const router = Router()

/** The raw body is what the signature covers, so it must survive JSON parsing. */
router.use(express.raw({ type: '*/*', limit: '2mb' }))

interface DocusignEnvelopePayload {
  event?: string
  eventId?: string
  data?: {
    envelopeId?: string
    envelopeSummary?: {
      status?: string
      recipients?: { signers?: Array<{ email?: string; status?: string; signedDateTime?: string; declinedReason?: string }> }
      voidedReason?: string
    }
  }
}

router.post('/docusign', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '')
    const signature = req.header('x-docusign-signature-1') ?? undefined

    if (!verifyDocusignSignature(rawBody, signature)) {
      // No detail: a caller probing the endpoint learns nothing about why.
      logger.warn('Rejected a DocuSign webhook with an invalid signature')
      res.status(401).json({ success: false, error: 'Invalid signature', code: 'UNAUTHORIZED' })
      return
    }

    let payload: DocusignEnvelopePayload
    try { payload = JSON.parse(rawBody) as DocusignEnvelopePayload }
    catch {
      res.status(400).json({ success: false, error: 'Malformed payload', code: 'VALIDATION_ERROR' })
      return
    }

    const envelopeId = payload.data?.envelopeId
    const eventId = payload.eventId ?? (envelopeId ? `${envelopeId}:${payload.event ?? 'unknown'}` : null)
    if (!envelopeId || !eventId) {
      res.status(400).json({ success: false, error: 'Missing envelope or event id', code: 'VALIDATION_ERROR' })
      return
    }

    // The tenant is derived here, from what WE stored when the envelope was
    // sent. Nothing in the body is consulted for it.
    const envelope = await resolveEnvelope(IntegrationProvider.DOCUSIGN, envelopeId)
    if (!envelope) {
      // Acknowledged so the provider stops retrying an envelope we do not own.
      res.json({ success: true, data: { handled: false, reason: 'unknown envelope' } })
      return
    }

    const claim = await claimProviderEvent(
      envelope.consultingFirmId, IntegrationProvider.DOCUSIGN, eventId, payload.event ?? 'envelope-status',
      { envelopeId, status: payload.data?.envelopeSummary?.status ?? null },
    )
    if (!claim.fresh) {
      res.json({ success: true, data: { handled: false, reason: 'duplicate event' } })
      return
    }

    const providerStatus = payload.data?.envelopeSummary?.status ?? payload.event ?? 'unknown'
    const canonical = mapDocusignStatus(providerStatus)
    const result = await applyProviderStatus(envelope.id, canonical, providerStatus, {
      declineReason: payload.data?.envelopeSummary?.voidedReason ?? null,
    })

    for (const signer of payload.data?.envelopeSummary?.recipients?.signers ?? []) {
      if (!signer.email) continue
      await prisma.signatureSigner.updateMany({
        where: { signatureRequestId: envelope.id, email: signer.email.toLowerCase() },
        data: {
          status: signer.status ?? 'PENDING',
          ...(signer.status?.toLowerCase() === 'completed'
            ? { signedAt: signer.signedDateTime ? new Date(signer.signedDateTime) : new Date() } : {}),
          ...(signer.status?.toLowerCase() === 'declined' ? { declinedAt: new Date() } : {}),
        },
      })
    }

    await prisma.integrationEvent.update({
      where: { id: claim.eventRowId },
      data: { processedAt: new Date(), outcome: result.applied ? 'applied' : `ignored:${result.reason ?? 'unknown'}` },
    })

    if (result.applied) {
      // The actor is the provider, not a person. No internal actorUserId is
      // borrowed for it.
      await logAudit({
        consultingFirmId: envelope.consultingFirmId,
        actorUserId: null,
        actorKind: 'SYSTEM',
        externalActorId: `docusign:${envelopeId}`,
        action: result.to === SignatureRequestStatus.COMPLETED ? 'APPROVAL' : 'UPDATE',
        entityType: 'SignatureRequest',
        entityId: envelope.id,
        rationale: `DocuSign reported ${providerStatus}; status moved ${result.from} → ${result.to}`,
      })
    }

    res.json({ success: true, data: { handled: result.applied, from: result.from, to: result.to, reason: result.reason } })
  } catch (err) { next(err) }
})

export default router
