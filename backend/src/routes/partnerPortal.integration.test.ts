// =============================================================
// §8.3 — Partner portal security and workflow.
//
// This suite is written adversarially. The matrix is:
//
//   Firm A: Partner A1 (Contract A1), Partner A2 (Contract A2)
//   Firm B: Partner B1 (Contract B1)
//
// and the point of it is to prove that knowing an id is worth nothing: access
// requires the prime tenant, the caller's own partner company, AND an explicit
// unrevoked grant, all re-derived server-side.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser, adminB: TestUser
let partnerA1: { id: string }, partnerA2: { id: string }, partnerB1: { id: string }
let contractA1: { id: string }, contractA2: { id: string }, contractB1: { id: string }
let poA1: { id: string }, poA2: { id: string }, poB1: { id: string }
let userA1 = { id: '', token: '' }
let userA2 = { id: '', token: '' }
let userB1 = { id: '', token: '' }

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const iso = (d: Date) => d.toISOString()

/** Recognisable sentinels — if any of these ever reach a partner, it is a leak. */
const SENTINELS = {
  margin: '91.2345',
  pricingNote: 'PRIME-SECRET',
  qualNote: 'INTERNAL-NO-SHARE',
  otherQuote: '9999999.99',
}

async function makePartnerUser(firm: TestFirm, admin: TestUser, partnerId: string, email: string) {
  const invited = await request(app).post('/api/partner-portal/admin/users').set(auth(admin.token))
    .send({ partnerId, email, firstName: 'Ext', lastName: 'User' })
  expect(invited.status).toBe(201)
  const accepted = await request(app).post('/api/partner-portal/auth/accept-invite')
    .send({ token: invited.body.data.inviteToken, password: 'a-very-strong-password-1' })
  expect(accepted.status).toBe(200)
  const login = await request(app).post('/api/partner-portal/auth/login')
    .send({ email, password: 'a-very-strong-password-1' })
  expect(login.status).toBe(200)
  return { id: invited.body.data.id, token: login.body.data.token }
}

async function makeContractAndPo(firm: TestFirm, admin: TestUser, partnerId: string, tag: string) {
  const contract = await prisma.contract.create({
    data: {
      consultingFirmId: firm.id, contractNumber: `PP-${tag}-${Date.now()}`, title: `Contract ${tag}`,
      status: 'ACTIVE', ceilingValue: '1000000.00',
    },
    select: { id: true },
  })
  const po = await request(app).post('/api/erp/purchase-orders').set(auth(admin.token)).send({
    contractId: contract.id, partnerId, vendorName: `Vendor ${tag}`,
    poNumber: `PP-PO-${tag}-${Date.now()}`, ceilingAmount: '50000.00', isSubcontract: true,
  })
  expect(po.status).toBe(201)
  await request(app).post(`/api/erp/purchase-orders/${po.body.data.id}/transition`).set(auth(admin.token)).send({ status: 'PENDING_APPROVAL' })
  await request(app).post(`/api/erp/purchase-orders/${po.body.data.id}/transition`).set(auth(admin.token)).send({ status: 'APPROVED' })
  return { contract, po: { id: po.body.data.id } }
}

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'PP Firm A' })
  firmB = await createTestFirm({ name: 'PP Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })

  partnerA1 = await prisma.partner.create({ data: { consultingFirmId: firmA.id, name: 'Partner A1' }, select: { id: true } })
  partnerA2 = await prisma.partner.create({ data: { consultingFirmId: firmA.id, name: 'Partner A2' }, select: { id: true } })
  partnerB1 = await prisma.partner.create({ data: { consultingFirmId: firmB.id, name: 'Partner B1' }, select: { id: true } })

  const a1 = await makeContractAndPo(firmA, adminA, partnerA1.id, 'A1')
  const a2 = await makeContractAndPo(firmA, adminA, partnerA2.id, 'A2')
  const b1 = await makeContractAndPo(firmB, adminB, partnerB1.id, 'B1')
  contractA1 = a1.contract; poA1 = a1.po
  contractA2 = a2.contract; poA2 = a2.po
  contractB1 = b1.contract; poB1 = b1.po

  userA1 = await makePartnerUser(firmA, adminA, partnerA1.id, `a1-${Date.now()}@ext.test`)
  userA2 = await makePartnerUser(firmA, adminA, partnerA2.id, `a2-${Date.now()}@ext.test`)
  userB1 = await makePartnerUser(firmB, adminB, partnerB1.id, `b1-${Date.now()}@ext.test`)

  // Only A1 is granted anything, and only its own contract + PO.
  for (const [scopeType, scopeId] of [['CONTRACT', contractA1.id], ['PURCHASE_ORDER', poA1.id]] as const) {
    const g = await request(app).post('/api/partner-portal/admin/access').set(auth(adminA.token))
      .send({ partnerPortalUserId: userA1.id, scopeType, scopeId })
    expect(g.status).toBe(201)
  }

  // Prime-internal records carrying sentinels the partner must never see.
  await prisma.contractCost.create({
    data: {
      consultingFirmId: firmA.id, contractId: contractA1.id, category: 'OTHER_DIRECT_COST',
      amount: SENTINELS.otherQuote, status: 'APPROVED', description: SENTINELS.pricingNote, incurredDate: new Date(),
    },
  })
  const budget = await request(app).post('/api/erp/budgets').set(auth(adminA.token))
    .send({ contractId: contractA1.id, title: SENTINELS.pricingNote, lines: [{ category: 'LABOR', plannedAmount: SENTINELS.otherQuote }] })
  await request(app).post(`/api/erp/budgets/${budget.body.data.id}/activate`).set(auth(adminA.token)).send({})
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('§8.3 partner identity is separate and default-deny', () => {
  it('creates no internal User for a partner', async () => {
    const asUser = await prisma.user.findFirst({ where: { email: { contains: '@ext.test' } } })
    expect(asUser).toBeNull()
  })

  it('never issues the CONSULTANT role to an external partner', async () => {
    const me = await request(app).get('/api/partner-portal/me').set(auth(userA1.token))
    expect(me.status).toBe(200)
    expect(JSON.stringify(me.body)).not.toContain('CONSULTANT')
  })

  it('burns the invite token after one use', async () => {
    const invited = await request(app).post('/api/partner-portal/admin/users').set(auth(adminA.token))
      .send({ partnerId: partnerA1.id, email: `once-${Date.now()}@ext.test`, firstName: 'One', lastName: 'Shot' })
    const token = invited.body.data.inviteToken
    expect((await request(app).post('/api/partner-portal/auth/accept-invite').send({ token, password: 'another-strong-password-1' })).status).toBe(200)
    const replay = await request(app).post('/api/partner-portal/auth/accept-invite').send({ token, password: 'another-strong-password-2' })
    expect(replay.status).toBe(401)
  })

  it('shows a granted user only its own engagements', async () => {
    const res = await request(app).get('/api/partner-portal/engagements').set(auth(userA1.token))
    expect(res.status).toBe(200)
    expect(res.body.data.contracts.map((c: { id: string }) => c.id)).toEqual([contractA1.id])
    expect(res.body.data.purchaseOrders.map((p: { id: string }) => p.id)).toEqual([poA1.id])
  })

  it('shows an ungranted user nothing, even though it belongs to a partner company', async () => {
    const res = await request(app).get('/api/partner-portal/engagements').set(auth(userA2.token))
    expect(res.status).toBe(200)
    expect(res.body.data.contracts).toHaveLength(0)
    expect(res.body.data.purchaseOrders).toHaveLength(0)
  })
})

describe('§8.3 three-dimension access matrix', () => {
  it('A1 cannot reach A2’s purchase order (same tenant, other partner)', async () => {
    const res = await request(app).get(`/api/partner-portal/purchase-orders/${poA2.id}`).set(auth(userA1.token))
    expect(res.status).toBe(403)
  })

  it('A2 cannot reach A1’s purchase order', async () => {
    const res = await request(app).get(`/api/partner-portal/purchase-orders/${poA1.id}`).set(auth(userA2.token))
    expect(res.status).toBe(403)
  })

  it('B1 cannot reach any Firm A record', async () => {
    for (const id of [poA1.id, poA2.id]) {
      expect((await request(app).get(`/api/partner-portal/purchase-orders/${id}`).set(auth(userB1.token))).status).toBe(403)
    }
  })

  it('A1 cannot reach Firm B records', async () => {
    expect((await request(app).get(`/api/partner-portal/purchase-orders/${poB1.id}`).set(auth(userA1.token))).status).toBe(403)
  })

  it('refuses a forged partnerId or scope in the request body', async () => {
    const res = await request(app).post('/api/partner-portal/documents').set(auth(userA1.token))
      .field('scopeType', 'CONTRACT').field('scopeId', contractA2.id)
      .field('category', 'capability').field('title', 'forged')
      .attach('file', Buffer.from('x'), { filename: 'a.pdf', contentType: 'application/pdf' })
    expect([403, 422]).toContain(res.status)
  })

  it('refuses a grant that does not belong to the portal user’s own partner', async () => {
    const res = await request(app).post('/api/partner-portal/admin/access').set(auth(adminA.token))
      .send({ partnerPortalUserId: userA1.id, scopeType: 'PURCHASE_ORDER', scopeId: poA2.id })
    expect(res.status).toBe(404)
  })
})

describe('§8.3 prime private data never leaves', () => {
  it('exposes no sentinel value on any partner endpoint', async () => {
    const paths = [
      '/api/partner-portal/me',
      '/api/partner-portal/engagements',
      `/api/partner-portal/purchase-orders/${poA1.id}`,
      '/api/partner-portal/invoices',
      '/api/partner-portal/documents',
      '/api/partner-portal/deliverables',
      `/api/partner-portal/purchase-orders/${poA1.id}/flow-downs`,
    ]
    for (const p of paths) {
      const res = await request(app).get(p).set(auth(userA1.token))
      const body = JSON.stringify(res.body)
      for (const [name, value] of Object.entries(SENTINELS)) {
        expect(body, `${p} leaked ${name}`).not.toContain(value)
      }
      // Field names that must never appear on an external payload.
      for (const field of ['probabilityScore', 'expectedValue', 'winProbability', 'budget', 'margin', 'qualification', 'bidDecision', 'cashFlow', 'receivables']) {
        expect(body.toLowerCase(), `${p} leaked field ${field}`).not.toContain(field.toLowerCase())
      }
    }
  })

  it('does not expose the prime’s ceiling or funding on a granted contract', async () => {
    const res = await request(app).get('/api/partner-portal/engagements').set(auth(userA1.token))
    const contract = res.body.data.contracts[0]
    expect(contract).not.toHaveProperty('ceilingValue')
    expect(contract).not.toHaveProperty('awardValue')
  })
})

describe('§8.3 token confusion', () => {
  it('a partner token cannot call internal APIs', async () => {
    for (const p of ['/api/agents/runs', `/api/erp/contracts/${contractA1.id}/financial-summary`, '/api/personnel', '/api/crm/contacts']) {
      const res = await request(app).get(p).set(auth(userA1.token))
      expect([401, 403], `${p} accepted a partner token`).toContain(res.status)
    }
  })

  it('an internal token cannot call partner-only endpoints', async () => {
    const res = await request(app).get('/api/partner-portal/engagements').set(auth(adminA.token))
    expect(res.status).toBe(401)
  })

  it('an internal token cannot impersonate a partner by supplying ids', async () => {
    const res = await request(app).post('/api/partner-portal/invoices').set(auth(adminA.token))
      .send({ purchaseOrderId: poA1.id, invoiceNumber: 'IMP-1', invoiceDate: iso(new Date()), amount: '1.00' })
    expect(res.status).toBe(401)
  })

  it('a client-portal token cannot call internal APIs either', async () => {
    // Same class of confusion as the partner token: signed with the same secret,
    // but not an internal session.
    const jwt = (await import('jsonwebtoken')).default
    const { config } = await import('../config/config')
    const clientToken = jwt.sign(
      { clientPortalUserId: 'x', clientCompanyId: 'y', consultingFirmId: firmA.id, role: 'CLIENT', email: 'c@x.test' },
      config.jwt.secret, { expiresIn: '1h', algorithm: 'HS256' },
    )
    const res = await request(app).get('/api/personnel').set(auth(clientToken))
    expect([401, 403]).toContain(res.status)
  })

  it('a client-portal token cannot call partner endpoints', async () => {
    const jwt = (await import('jsonwebtoken')).default
    const { config } = await import('../config/config')
    const clientToken = jwt.sign(
      { clientPortalUserId: 'x', clientCompanyId: 'y', role: 'CLIENT', email: 'c@x.test' },
      config.jwt.secret, { expiresIn: '1h', algorithm: 'HS256' },
    )
    expect((await request(app).get('/api/partner-portal/engagements').set(auth(clientToken))).status).toBe(401)
  })

  it('an unauthenticated caller gets nothing', async () => {
    expect((await request(app).get('/api/partner-portal/engagements')).status).toBe(401)
  })
})

describe('§8.3 subcontract invoice submission uses the existing ERP flow', () => {
  let invoiceId: string

  it('lets a partner submit against its own granted order', async () => {
    const res = await request(app).post('/api/partner-portal/invoices').set(auth(userA1.token))
      .send({ purchaseOrderId: poA1.id, invoiceNumber: 'PP-V-1', invoiceDate: iso(new Date()), amount: '1200.00' })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('RECEIVED')
    invoiceId = res.body.data.id

    const row = await prisma.subcontractInvoice.findUnique({ where: { id: invoiceId } })
    expect(row!.submittedByPortalUserId).toBe(userA1.id)
  })

  it('posts no cost until a prime human approves', async () => {
    const costs = await prisma.contractCost.count({
      where: { consultingFirmId: firmA.id, sourceType: 'SUBCONTRACT_INVOICE', sourceId: invoiceId },
    })
    expect(costs).toBe(0)
  })

  it('refuses a partner attempt to approve, reject or mark paid', async () => {
    for (const status of ['APPROVED', 'REJECTED', 'PAID']) {
      const res = await request(app).post(`/api/erp/subcontract-invoices/${invoiceId}/transition`)
        .set(auth(userA1.token)).send({ status })
      expect([401, 403]).toContain(res.status)
    }
    expect((await prisma.subcontractInvoice.findUnique({ where: { id: invoiceId } }))!.status).toBe('RECEIVED')
  })

  it('posts exactly one cost when the prime approves through the existing route', async () => {
    const res = await request(app).post(`/api/erp/subcontract-invoices/${invoiceId}/transition`)
      .set(auth(adminA.token)).send({ status: 'APPROVED' })
    expect(res.status).toBe(200)
    expect(res.body.data.posting.created).toBe(true)
    const costs = await prisma.contractCost.count({
      where: { consultingFirmId: firmA.id, sourceType: 'SUBCONTRACT_INVOICE', sourceId: invoiceId },
    })
    expect(costs).toBe(1)
  })

  it('shows the partner the updated status without prime internals', async () => {
    const res = await request(app).get('/api/partner-portal/invoices').set(auth(userA1.token))
    const row = res.body.data.find((r: { id: string }) => r.id === invoiceId)
    expect(row.status).toBe('APPROVED')
    expect(row).not.toHaveProperty('postedContractCostId')
  })

  it('refuses submission against another partner’s order', async () => {
    const res = await request(app).post('/api/partner-portal/invoices').set(auth(userA1.token))
      .send({ purchaseOrderId: poA2.id, invoiceNumber: 'PP-V-X', invoiceDate: iso(new Date()), amount: '1.00' })
    expect(res.status).toBe(403)
  })

  it('refuses a duplicate invoice number on the same order', async () => {
    const res = await request(app).post('/api/partner-portal/invoices').set(auth(userA1.token))
      .send({ purchaseOrderId: poA1.id, invoiceNumber: 'PP-V-1', invoiceDate: iso(new Date()), amount: '5.00' })
    expect(res.status).toBe(422)
  })

  it('refuses a zero or negative amount', async () => {
    for (const amount of ['0.00', '-5.00']) {
      const res = await request(app).post('/api/partner-portal/invoices').set(auth(userA1.token))
        .send({ purchaseOrderId: poA1.id, invoiceNumber: `PP-V-${amount}`, invoiceDate: iso(new Date()), amount })
      expect(res.status).toBe(422)
    }
  })
})

describe('§8.3 flow-down visibility and acknowledgment', () => {
  let sharedId: string
  let hiddenId: string

  beforeAll(async () => {
    const shared = await request(app).post('/api/erp/flow-downs').set(auth(adminA.token))
      .send({ purchaseOrderId: poA1.id, clauseNumber: 'FAR 52.219-8' })
    sharedId = shared.body.data.id
    await prisma.subcontractFlowDown.update({ where: { id: sharedId }, data: { partnerVisible: true } })

    const hidden = await request(app).post('/api/erp/flow-downs').set(auth(adminA.token))
      .send({ purchaseOrderId: poA1.id, clauseNumber: 'FAR 52.999-99' })
    hiddenId = hidden.body.data.id
  })

  it('shows only clauses the prime shared', async () => {
    const res = await request(app).get(`/api/partner-portal/purchase-orders/${poA1.id}/flow-downs`).set(auth(userA1.token))
    const ids = res.body.data.items.map((i: { id: string }) => i.id)
    expect(ids).toContain(sharedId)
    expect(ids).not.toContain(hiddenId)
    expect(res.body.data.disclaimer).toMatch(/not a legal determination/i)
  })

  it('records acknowledgment without changing the prime’s legal state', async () => {
    const before = await prisma.subcontractFlowDown.findUnique({ where: { id: sharedId } })
    const res = await request(app).post(`/api/partner-portal/flow-downs/${sharedId}/acknowledge`).set(auth(userA1.token)).send({})
    expect(res.status).toBe(200)
    const after = await prisma.subcontractFlowDown.findUnique({ where: { id: sharedId } })
    expect(after!.partnerAcknowledgedAt).toBeTruthy()
    expect(after!.partnerAcknowledgedByPortalUserId).toBe(userA1.id)
    // The legal field is untouched, and no reviewer was invented.
    expect(after!.state).toBe(before!.state)
    expect(after!.reviewedByUserId).toBeNull()
  })

  it('refuses acknowledgment of a clause the partner cannot see', async () => {
    const res = await request(app).post(`/api/partner-portal/flow-downs/${hiddenId}/acknowledge`).set(auth(userA1.token)).send({})
    expect(res.status).toBe(403)
  })
})

describe('§8.3 partner submissions land as evidence, not as truth', () => {
  let submissionId: string

  it('accepts a personnel contribution as PENDING_REVIEW', async () => {
    const res = await request(app).post('/api/partner-portal/personnel-contributions').set(auth(userA1.token))
      .send({
        scopeType: 'CONTRACT', scopeId: contractA1.id, fullName: 'Ext Candidate',
        proposedRole: 'Analyst', content: { summary: 'Five years of relevant work.' },
      })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('PENDING_REVIEW')
    submissionId = res.body.data.id
  })

  it('does not add anyone to the prime’s personnel library automatically', async () => {
    const found = await prisma.personnel.findFirst({ where: { consultingFirmId: firmA.id, firstName: 'Ext' } })
    expect(found).toBeNull()
  })

  it('promotes an accepted submission only as a DRAFT with partner provenance', async () => {
    const res = await request(app).post(`/api/partner-portal/admin/submissions/personnel/${submissionId}/review`)
      .set(auth(adminA.token)).send({ status: 'ACCEPTED', importIntoLibrary: true })
    expect(res.status).toBe(200)

    const person = await prisma.personnel.findFirst({
      where: { consultingFirmId: firmA.id, sourcePartnerId: partnerA1.id },
      include: { resumes: true },
    })
    expect(person!.source).toBe('PARTNER_SUBMITTED')
    expect(person!.resumes).toHaveLength(1)
    expect(person!.resumes[0].status).toBe('DRAFT')
    expect(person!.resumes[0].source).toBe('PARTNER_SUBMITTED')
  })

  it('refuses a contribution against an engagement the partner was not granted', async () => {
    const res = await request(app).post('/api/partner-portal/personnel-contributions').set(auth(userA2.token))
      .send({ scopeType: 'CONTRACT', scopeId: contractA1.id, fullName: 'Sneaky' })
    expect(res.status).toBe(403)
  })
})

describe('§8.3 revocation takes effect immediately', () => {
  it('cuts off every previously reachable endpoint', async () => {
    const email = `revoke-${Date.now()}@ext.test`
    const u = await makePartnerUser(firmA, adminA, partnerA1.id, email)
    await request(app).post('/api/partner-portal/admin/access').set(auth(adminA.token))
      .send({ partnerPortalUserId: u.id, scopeType: 'PURCHASE_ORDER', scopeId: poA1.id })

    expect((await request(app).get(`/api/partner-portal/purchase-orders/${poA1.id}`).set(auth(u.token))).status).toBe(200)

    const revoke = await request(app).post(`/api/partner-portal/admin/users/${u.id}/revoke`).set(auth(adminA.token)).send({})
    expect(revoke.status).toBe(200)

    // The token has not expired — the account check refuses it anyway.
    expect((await request(app).get(`/api/partner-portal/purchase-orders/${poA1.id}`).set(auth(u.token))).status).toBe(401)
    expect((await request(app).get('/api/partner-portal/documents').set(auth(u.token))).status).toBe(401)
  })

  it('revoking one engagement leaves the account working but the record unreachable', async () => {
    const email = `partial-${Date.now()}@ext.test`
    const u = await makePartnerUser(firmA, adminA, partnerA1.id, email)
    const grant = await request(app).post('/api/partner-portal/admin/access').set(auth(adminA.token))
      .send({ partnerPortalUserId: u.id, scopeType: 'PURCHASE_ORDER', scopeId: poA1.id })
    expect((await request(app).get(`/api/partner-portal/purchase-orders/${poA1.id}`).set(auth(u.token))).status).toBe(200)

    await request(app).post(`/api/partner-portal/admin/access/${grant.body.data.id}/revoke`).set(auth(adminA.token)).send({})
    expect((await request(app).get(`/api/partner-portal/purchase-orders/${poA1.id}`).set(auth(u.token))).status).toBe(403)
    expect((await request(app).get('/api/partner-portal/me').set(auth(u.token))).status).toBe(200)
  })
})

describe('§8.3 audit records an external actor honestly', () => {
  it('never attributes a partner action to an internal user', async () => {
    const rows = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firmA.id, actorKind: 'PARTNER_PORTAL_USER' },
      select: { actorUserId: true, externalActorId: true, entityType: true },
    })
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.actorUserId).toBeNull()
      expect(r.externalActorId).toBeTruthy()
    }
  })

  it('still attributes internal prime actions to the internal user', async () => {
    const row = await prisma.auditEvent.findFirst({
      where: { consultingFirmId: firmA.id, entityType: 'PartnerEngagementAccess', actorKind: 'INTERNAL_USER' },
      select: { actorUserId: true, externalActorId: true },
    })
    expect(row!.actorUserId).toBe(adminA.id)
    expect(row!.externalActorId).toBeNull()
  })
})
