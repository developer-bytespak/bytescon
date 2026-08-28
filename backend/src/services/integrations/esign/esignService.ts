// =============================================================
// §8.5 — Electronic signature.
//
// A PROVIDER LAYER over agreements that already exist. The document text still
// comes from TeamingAgreementDraft or an uploaded file; this module only
// records what a provider did with it. There is no second agreement engine.
//
// THE HUMAN GATE, which is the point of the module:
//
//   An agent may draft. Only a person may send. Nobody signs on anyone's
//   behalf, and no webhook may declare an agreement executed that the provider
//   did not actually report as complete.
//
// Sending requires the ESIGN_SEND permission on an authenticated internal
// session. No agent holds route access, and the Section 7 forbidden-write
// matrix names SignatureRequest and SignatureSigner for every agent — so the
// gate is enforced twice, in two different mechanisms.
//
// STATE MACHINE. Provider states are mapped to canonical ones and the raw
// provider string is preserved beside them. Terminal states never regress: an
// out-of-order webhook arriving after COMPLETED is recorded and ignored,
// because a completed agreement that silently reverts to "sent" is a
// contract-integrity failure.
// =============================================================
import crypto from 'crypto'
import { IntegrationProvider, SignatureRequestStatus } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { ValidationError, NotFoundError } from '../../../utils/errors'

/** Canonical states that may never be left once entered. */
const TERMINAL: SignatureRequestStatus[] = [
  SignatureRequestStatus.COMPLETED,
  SignatureRequestStatus.DECLINED,
  SignatureRequestStatus.VOIDED,
]

export function isTerminal(status: SignatureRequestStatus): boolean {
  return TERMINAL.includes(status)
}

/** Rank for out-of-order detection. Higher never regresses to lower. */
const RANK: Record<SignatureRequestStatus, number> = {
  DRAFT: 0, READY_TO_SEND: 1, SENT: 2, VIEWED: 3, PARTIALLY_SIGNED: 4,
  COMPLETED: 5, DECLINED: 5, VOIDED: 5, ERROR: 1,
}

/**
 * DocuSign envelope status → canonical status.
 *
 * An unrecognised provider status maps to null and is recorded verbatim in
 * `providerStatus` without moving the canonical one — guessing at an unknown
 * state is how an envelope becomes "completed" because a vendor added a word.
 */
export function mapDocusignStatus(raw: string): SignatureRequestStatus | null {
  switch (raw.toLowerCase()) {
    case 'created':
    case 'draft': return SignatureRequestStatus.DRAFT
    case 'sent': return SignatureRequestStatus.SENT
    case 'delivered': return SignatureRequestStatus.VIEWED
    case 'signed': return SignatureRequestStatus.PARTIALLY_SIGNED
    case 'completed': return SignatureRequestStatus.COMPLETED
    case 'declined': return SignatureRequestStatus.DECLINED
    case 'voided': return SignatureRequestStatus.VOIDED
    default: return null
  }
}

export interface ApplyStatusResult {
  applied: boolean
  from: SignatureRequestStatus
  to: SignatureRequestStatus
  reason?: string
}

/**
 * Move a signature request to a new canonical state, honestly.
 *
 * Refuses to regress a terminal state, refuses to move backwards, and records
 * the provider's own string either way so an operator can see what actually
 * arrived.
 */
export async function applyProviderStatus(
  requestId: string,
  canonical: SignatureRequestStatus | null,
  providerStatus: string,
  extras: { declineReason?: string | null } = {},
): Promise<ApplyStatusResult> {
  const row = await prisma.signatureRequest.findUnique({
    where: { id: requestId }, select: { id: true, status: true },
  })
  if (!row) throw new NotFoundError('Signature request not found')

  if (!canonical) {
    await prisma.signatureRequest.update({ where: { id: row.id }, data: { providerStatus } })
    return { applied: false, from: row.status, to: row.status, reason: 'unrecognised provider status' }
  }
  if (isTerminal(row.status)) {
    await prisma.signatureRequest.update({ where: { id: row.id }, data: { providerStatus } })
    return { applied: false, from: row.status, to: row.status, reason: 'already in a terminal state' }
  }
  if (RANK[canonical] < RANK[row.status]) {
    await prisma.signatureRequest.update({ where: { id: row.id }, data: { providerStatus } })
    return { applied: false, from: row.status, to: row.status, reason: 'out-of-order event' }
  }

  const now = new Date()
  await prisma.signatureRequest.update({
    where: { id: row.id },
    data: {
      status: canonical,
      providerStatus,
      ...(canonical === SignatureRequestStatus.COMPLETED ? { completedAt: now } : {}),
      ...(canonical === SignatureRequestStatus.DECLINED
        ? { declinedAt: now, declineReason: extras.declineReason ?? null } : {}),
      ...(canonical === SignatureRequestStatus.VOIDED ? { voidedAt: now } : {}),
    },
  })
  return { applied: true, from: row.status, to: canonical }
}

/**
 * Verify a DocuSign Connect HMAC signature.
 *
 * Constant-time comparison, and a missing secret refuses rather than accepts:
 * an unverified webhook that can execute an agreement is the worst possible
 * default.
 */
export function verifyDocusignSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const secret = process.env.DOCUSIGN_CONNECT_SECRET
  if (!secret || !signatureHeader) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64')
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export interface WebhookClaim {
  /** False when this exact event id has already been handled. */
  fresh: boolean
  eventRowId: string
}

/**
 * Claim an inbound provider event exactly once.
 *
 * The unique (provider, externalEventId) constraint does the work: a replayed
 * webhook loses the insert and is reported as already handled, so one delivery
 * produces one state transition however many times the provider retries.
 */
export async function claimProviderEvent(
  consultingFirmId: string, provider: IntegrationProvider,
  externalEventId: string, eventType: string, payload: Record<string, unknown>,
): Promise<WebhookClaim> {
  try {
    const row = await prisma.integrationEvent.create({
      data: { consultingFirmId, provider, externalEventId, eventType, payload: payload as never },
      select: { id: true },
    })
    return { fresh: true, eventRowId: row.id }
  } catch {
    const existing = await prisma.integrationEvent.findUnique({
      where: { provider_externalEventId: { provider, externalEventId } }, select: { id: true },
    })
    return { fresh: false, eventRowId: existing?.id ?? '' }
  }
}

/**
 * Resolve the envelope a webhook refers to.
 *
 * The tenant comes from the STORED mapping, never from the webhook body. A
 * body that names a consultingFirmId is an attacker-controlled string, and
 * trusting it would let anyone who can reach the endpoint write into any
 * tenant.
 */
export async function resolveEnvelope(provider: IntegrationProvider, externalEnvelopeId: string) {
  const row = await prisma.signatureRequest.findFirst({
    where: { provider, externalEnvelopeId },
    select: { id: true, consultingFirmId: true, status: true, title: true, documentType: true },
  })
  if (!row) {
    logger.warn('Signature webhook referenced an unknown envelope', { provider })
    return null
  }
  return row
}

export interface SendableRequest {
  id: string
  consultingFirmId: string
  status: SignatureRequestStatus
  title: string
  signers: Array<{ id: string; name: string; email: string; routingOrder: number }>
}

/**
 * The checks a send must pass, independent of any provider.
 *
 * Kept here rather than in the route so the same rules apply however the send
 * is reached, and so a test can assert them without HTTP.
 */
export function assertSendable(request: {
  status: SignatureRequestStatus
  storageKey: string | null
  sourceId: string | null
  signers: Array<unknown>
}): void {
  if (request.status !== SignatureRequestStatus.DRAFT && request.status !== SignatureRequestStatus.READY_TO_SEND) {
    throw new ValidationError(`A ${request.status} agreement cannot be sent again`)
  }
  if (request.signers.length === 0) {
    throw new ValidationError('Select at least one signer before sending')
  }
  if (!request.storageKey && !request.sourceId) {
    throw new ValidationError('Attach a document, or select the agreement draft to send')
  }
}
