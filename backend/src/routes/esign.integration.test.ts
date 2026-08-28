// =============================================================
// §8.5 — E-signature: the human gate, and webhook security.
//
// The claims:
//   only a person with ESIGN_SEND may send, and no agent may
//   a bad signature is refused
//   a replayed webhook produces one state transition
//   an out-of-order webhook never regresses a terminal state
//   an envelope id from another tenant reaches nothing
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import type { Express } from 'express'
import { IntegrationProvider, IntegrationStatus, SignatureRequestStatus } from '@prisma/client'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'
import { upsertConnection } from '../services/integrations/connectionService'
import { __setEsignAdapter, type EsignAdapter } from '../services/integrations/esign/docusign'
import {
  applyProviderStatus, mapDocusignStatus, verifyDocusignSignature, isTerminal,
} from '../services/integrations/esign/esignService'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser, adminB: TestUser, contractsA: TestUser, financeA: TestUser, consultantA: TestUser
let partnerA = ''

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const CONNECT_SECRET = 'esign-connect-test-secret'

function sign(body: string): string {
  return crypto.createHmac('sha256', CONNECT_SECRET).update(body, 'utf8').digest('base64')
}

function envelopePayload(envelopeId: string, status: string, eventId: string) {
  return JSON.stringify({
    event: `envelope-${status}`,
    eventId,
    data: { envelopeId, envelopeSummary: { status, recipients: { signers: [] } } },
  })
}

const mockAdapter: EsignAdapter & { sent: number } = {
  provider: IntegrationProvider.DOCUSIGN,
  sent: 0,
  async testConnection() { return { ok: true, accountName: 'Mock DocuSign', detail: 'mock' } },
  async sendEnvelope() {
    mockAdapter.sent += 1
    return { externalEnvelopeId: `ENV-${mockAdapter.sent}`, providerStatus: 'sent' }
  },
  async voidEnvelope() { /* no-op */ },
}

async function draftRequest(token: string, title = 'Teaming Agreement') {
  return request(app).post('/api/esign').set(auth(token))
    .field('documentType', 'TEAMING_AGREEMENT')
    .field('title', title)
    .field('signers', JSON.stringify([{ name: 'Sam Signer', email: 'sam@partner.test' }]))
    .attach('file', Buffer.from('%PDF-1.4 agreement'), { filename: 'agreement.pdf', contentType: 'application/pdf' })
}

beforeAll(async () => {
  process.env.DOCUSIGN_CONNECT_SECRET = CONNECT_SECRET
  app = buildTestApp()
  __setEsignAdapter(IntegrationProvider.DOCUSIGN, mockAdapter)

  firmA = await createTestFirm({ name: 'SIGN Firm A' })
  firmB = await createTestFirm({ name: 'SIGN Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
  contractsA = await createTestUser(firmA.id, { role: 'CONTRACTS' })
  financeA = await createTestUser(firmA.id, { role: 'FINANCE' })
  consultantA = await createTestUser(firmA.id, { role: 'CONSULTANT' })

  partnerA = (await prisma.partner.create({
    data: { consultingFirmId: firmA.id, name: 'SIGN Partner' }, select: { id: true },
  })).id

  await upsertConnection(firmA.id, IntegrationProvider.DOCUSIGN, {
    status: IntegrationStatus.CONNECTED,
    accessToken: 'DOCUSIGN-TOKEN-SENTINEL',
    config: { baseUrl: 'https://demo.docusign.net', accountId: 'ACC-1' },
  })
})

afterAll(async () => {
  __setEsignAdapter(IntegrationProvider.DOCUSIGN, null)
  delete process.env.DOCUSIGN_CONNECT_SECRET
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('§8.5 sending is a human act', () => {
  it('lets a contracts user draft and send', async () => {
    const draft = await draftRequest(contractsA.token)
    expect(draft.status).toBe(201)
    expect(draft.body.data.status).toBe('DRAFT')
    expect(draft.body.data.note).toMatch(/a person must send it/i)

    const sent = await request(app).post(`/api/esign/${draft.body.data.id}/send`).set(auth(contractsA.token)).send({})
    expect(sent.status).toBe(200)
    expect(sent.body.data.status).toBe('SENT')
    expect(sent.body.data.sentByUserId).toBe(contractsA.id)
  })

  it('refuses the send to a user without ESIGN_SEND', async () => {
    const draft = await draftRequest(adminA.token)
    const finance = await request(app).post(`/api/esign/${draft.body.data.id}/send`).set(auth(financeA.token)).send({})
    expect(finance.status).toBe(403)
    expect(finance.body.error).toMatch(/ESIGN_SEND/)

    // A CONSULTANT is stopped even earlier, by the platform-wide read-only
    // guard that predates §8.5 — which is the compatibility contract holding.
    const consultant = await request(app).post(`/api/esign/${draft.body.data.id}/send`).set(auth(consultantA.token)).send({})
    expect(consultant.status).toBe(403)
    const row = await prisma.signatureRequest.findUnique({ where: { id: draft.body.data.id } })
    expect(row!.status).toBe('DRAFT')
    expect(row!.sentAt).toBeNull()
  })

  it('refuses a send with no signer and a send with no document', async () => {
    const noSigner = await request(app).post('/api/esign').set(auth(adminA.token))
      .field('documentType', 'NDA').field('title', 'NDA').field('signers', JSON.stringify([]))
    expect(noSigner.status).toBe(422)

    const noDoc = await prisma.signatureRequest.create({
      data: {
        consultingFirmId: firmA.id, documentType: 'NDA', title: 'Empty', status: 'DRAFT',
        signers: { create: [{ consultingFirmId: firmA.id, name: 'A', email: 'a@b.test' }] },
      },
      select: { id: true },
    })
    const res = await request(app).post(`/api/esign/${noDoc.id}/send`).set(auth(adminA.token)).send({})
    expect(res.status).toBe(422)
  })

  it('refuses to send the same request twice', async () => {
    const draft = await draftRequest(adminA.token)
    await request(app).post(`/api/esign/${draft.body.data.id}/send`).set(auth(adminA.token)).send({}).expect(200)
    const again = await request(app).post(`/api/esign/${draft.body.data.id}/send`).set(auth(adminA.token)).send({})
    expect(again.status).toBe(422)
  })

  it('refuses another tenant’s request entirely', async () => {
    const draft = await draftRequest(adminA.token)
    const res = await request(app).post(`/api/esign/${draft.body.data.id}/send`).set(auth(adminB.token)).send({})
    expect(res.status).toBe(404)
  })

  it('leaves no route by which an agent could send', async () => {
    const routes = await import('./esign')
    const layers = (routes.default as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack
    const sendRoutes = layers.filter((l) => l.route?.path?.includes('send'))
    expect(sendRoutes.length).toBe(1)
    // Every mutating route on this router sits behind an authenticated
    // internal session; an agent runtime has no session and no route.
    const res = await request(app).post('/api/esign').send({ title: 'x' })
    expect(res.status).toBe(401)
  })
})

describe('§8.5 status mapping', () => {
  it('maps the provider vocabulary onto the canonical one', () => {
    expect(mapDocusignStatus('sent')).toBe('SENT')
    expect(mapDocusignStatus('delivered')).toBe('VIEWED')
    expect(mapDocusignStatus('completed')).toBe('COMPLETED')
    expect(mapDocusignStatus('declined')).toBe('DECLINED')
    expect(mapDocusignStatus('voided')).toBe('VOIDED')
  })

  it('maps an unknown provider status to nothing rather than guessing', () => {
    expect(mapDocusignStatus('some-new-status')).toBeNull()
  })

  it('knows which states are terminal', () => {
    expect(isTerminal(SignatureRequestStatus.COMPLETED)).toBe(true)
    expect(isTerminal(SignatureRequestStatus.SENT)).toBe(false)
  })

  it('records an unrecognised status without moving the canonical one', async () => {
    const draft = await draftRequest(adminA.token)
    await request(app).post(`/api/esign/${draft.body.data.id}/send`).set(auth(adminA.token)).send({}).expect(200)
    const result = await applyProviderStatus(draft.body.data.id, null, 'unheard-of')
    expect(result.applied).toBe(false)
    const row = await prisma.signatureRequest.findUnique({ where: { id: draft.body.data.id } })
    expect(row!.status).toBe('SENT')
    expect(row!.providerStatus).toBe('unheard-of')
  })
})

describe('§8.5 webhook security', () => {
  let envelopeId = ''
  let requestId = ''

  beforeEach(async () => {
    const draft = await draftRequest(adminA.token)
    requestId = draft.body.data.id
    const sent = await request(app).post(`/api/esign/${requestId}/send`).set(auth(adminA.token)).send({})
    envelopeId = sent.body.data.externalEnvelopeId
  })

  it('verifies the HMAC and refuses a bad one', () => {
    expect(verifyDocusignSignature('body', sign('body'))).toBe(true)
    expect(verifyDocusignSignature('body', sign('other'))).toBe(false)
    expect(verifyDocusignSignature('body', undefined)).toBe(false)
  })

  it('refuses an unsigned webhook without touching the envelope', async () => {
    const body = envelopePayload(envelopeId, 'completed', `evt-${Date.now()}`)
    const res = await request(app).post('/api/webhooks/integrations/docusign')
      .set('Content-Type', 'application/json').send(body)
    expect(res.status).toBe(401)
    const row = await prisma.signatureRequest.findUnique({ where: { id: requestId } })
    expect(row!.status).toBe('SENT')
  })

  it('refuses a webhook whose signature does not match the body', async () => {
    const body = envelopePayload(envelopeId, 'completed', `evt-${Date.now()}`)
    const res = await request(app).post('/api/webhooks/integrations/docusign')
      .set('Content-Type', 'application/json')
      .set('x-docusign-signature-1', sign('a different body'))
      .send(body)
    expect(res.status).toBe(401)
    const row = await prisma.signatureRequest.findUnique({ where: { id: requestId } })
    expect(row!.status).toBe('SENT')
  })

  it('applies a valid webhook exactly once, however many times it is replayed', async () => {
    const eventId = `evt-once-${Date.now()}`
    const body = envelopePayload(envelopeId, 'completed', eventId)
    const post = () => request(app).post('/api/webhooks/integrations/docusign')
      .set('Content-Type', 'application/json').set('x-docusign-signature-1', sign(body)).send(body)

    const first = await post()
    expect(first.status).toBe(200)
    expect(first.body.data.handled).toBe(true)
    expect(first.body.data.to).toBe('COMPLETED')

    const replay = await post()
    expect(replay.status).toBe(200)
    expect(replay.body.data.handled).toBe(false)
    expect(replay.body.data.reason).toBe('duplicate event')

    expect(await prisma.integrationEvent.count({
      where: { provider: 'DOCUSIGN', externalEventId: eventId },
    })).toBe(1)
    const row = await prisma.signatureRequest.findUnique({ where: { id: requestId } })
    expect(row!.status).toBe('COMPLETED')
  })

  it('never regresses a terminal state on an out-of-order event', async () => {
    const completeBody = envelopePayload(envelopeId, 'completed', `evt-c-${Date.now()}`)
    await request(app).post('/api/webhooks/integrations/docusign')
      .set('Content-Type', 'application/json').set('x-docusign-signature-1', sign(completeBody)).send(completeBody).expect(200)

    const lateBody = envelopePayload(envelopeId, 'sent', `evt-late-${Date.now()}`)
    const late = await request(app).post('/api/webhooks/integrations/docusign')
      .set('Content-Type', 'application/json').set('x-docusign-signature-1', sign(lateBody)).send(lateBody)
    expect(late.status).toBe(200)
    expect(late.body.data.handled).toBe(false)
    expect(late.body.data.reason).toMatch(/terminal/i)

    const row = await prisma.signatureRequest.findUnique({ where: { id: requestId } })
    expect(row!.status).toBe('COMPLETED')
  })

  it('records a decline with its reason', async () => {
    const body = JSON.stringify({
      event: 'envelope-declined', eventId: `evt-d-${Date.now()}`,
      data: { envelopeId, envelopeSummary: { status: 'declined', voidedReason: 'terms not agreed' } },
    })
    const res = await request(app).post('/api/webhooks/integrations/docusign')
      .set('Content-Type', 'application/json').set('x-docusign-signature-1', sign(body)).send(body)
    expect(res.status).toBe(200)
    const row = await prisma.signatureRequest.findUnique({ where: { id: requestId } })
    expect(row!.status).toBe('DECLINED')
    expect(row!.declineReason).toBe('terms not agreed')
  })

  it('reaches nothing for an envelope id nobody here sent', async () => {
    const body = envelopePayload('ENV-FROM-NOWHERE', 'completed', `evt-x-${Date.now()}`)
    const res = await request(app).post('/api/webhooks/integrations/docusign')
      .set('Content-Type', 'application/json').set('x-docusign-signature-1', sign(body)).send(body)
    expect(res.status).toBe(200)
    expect(res.body.data.handled).toBe(false)
    expect(res.body.data.reason).toBe('unknown envelope')
  })

  it('takes the tenant from the stored envelope, never from the body', async () => {
    // The body claims Firm B. The stored mapping says Firm A, and that is what
    // the transition is written against.
    const body = JSON.stringify({
      event: 'envelope-completed', eventId: `evt-t-${Date.now()}`,
      consultingFirmId: firmB.id,
      data: { envelopeId, envelopeSummary: { status: 'completed' } },
    })
    await request(app).post('/api/webhooks/integrations/docusign')
      .set('Content-Type', 'application/json').set('x-docusign-signature-1', sign(body)).send(body).expect(200)

    const audit = await prisma.auditEvent.findFirst({
      where: { entityType: 'SignatureRequest', entityId: requestId, action: 'APPROVAL' },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit!.consultingFirmId).toBe(firmA.id)
    // The provider is the actor. No internal user is borrowed for it.
    expect(audit!.actorUserId).toBeNull()
    expect(audit!.actorKind).toBe('SYSTEM')
    expect(audit!.externalActorId).toContain('docusign:')
  })

  it('leaks no provider credential into the signature list', async () => {
    const res = await request(app).get('/api/esign').set(auth(adminA.token))
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('DOCUSIGN-TOKEN-SENTINEL')
  })
})
