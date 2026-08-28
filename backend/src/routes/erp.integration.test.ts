// =============================================================
// §8.2 — ERP integration tests against a real database.
//
// The assertions that matter most:
//   - an approved subcontractor invoice posts exactly ONE actual cost, however
//     many times approval is retried
//   - committed money is deducted from remaining budget, so a dollar is never
//     available to spend twice
//   - no allocation data means INSUFFICIENT_DATA, never "available"
//   - Firm A's finance figures are byte-identical regardless of Firm B's data
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let userA: TestUser, userB: TestUser
let contractA: { id: string }, contractB: { id: string }
let clinA: { id: string }
let partnerA: { id: string }

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const iso = (d: Date) => d.toISOString()
const future = (days: number) => new Date(Date.now() + days * 86400000)

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'ERP Firm A' })
  firmB = await createTestFirm({ name: 'ERP Firm B' })
  userA = await createTestUser(firmA.id, { role: 'ADMIN' })
  userB = await createTestUser(firmB.id, { role: 'ADMIN' })

  contractA = await prisma.contract.create({
    data: {
      consultingFirmId: firmA.id, contractNumber: `ERPA-${Date.now()}`, title: 'ERP Contract A',
      status: 'ACTIVE', ceilingValue: '1000000.00', awardValue: '900000.00',
    },
    select: { id: true },
  })
  contractB = await prisma.contract.create({
    data: {
      consultingFirmId: firmB.id, contractNumber: `ERPB-${Date.now()}`, title: 'ERP Contract B',
      status: 'ACTIVE', ceilingValue: '99999999.99',
    },
    select: { id: true },
  })
  clinA = await prisma.clin.create({
    data: { consultingFirmId: firmA.id, contractId: contractA.id, clinNumber: '0001', title: 'Base' },
    select: { id: true },
  })
  partnerA = await prisma.partner.create({
    data: { consultingFirmId: firmA.id, name: 'ERP Vendor A' },
    select: { id: true },
  })
  await prisma.fundingTransaction.create({
    data: { consultingFirmId: firmA.id, contractId: contractA.id, type: 'INITIAL_OBLIGATION', amount: '400000.00' },
  })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('§8.2 — task-order tier without a new model', () => {
  it('represents a task order as a CLIN level, defaulting existing rows to CLIN', async () => {
    expect((await prisma.clin.findUnique({ where: { id: clinA.id } }))!.clinLevel).toBe('CLIN')
    const to = await prisma.clin.create({
      data: {
        consultingFirmId: firmA.id, contractId: contractA.id, clinNumber: 'TO-001',
        title: 'Task Order 1', clinLevel: 'TASK_ORDER',
      },
    })
    const sub = await prisma.clin.create({
      data: {
        consultingFirmId: firmA.id, contractId: contractA.id, clinNumber: 'TO-001-AA',
        clinLevel: 'SUB_CLIN', parentClinId: to.id,
      },
    })
    expect(sub.parentClinId).toBe(to.id)
    // No TaskOrder table was introduced.
    const t = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('task_orders','contract_task_orders')`,
    )
    expect(t).toHaveLength(0)
  })
})

describe('§8.2 — budget lifecycle', () => {
  let draftId: string

  it('reports no budget honestly rather than as zero', async () => {
    const res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.hasBudget).toBe(false)
    expect(res.body.data.totals.budget).toBeNull()
    expect(res.body.data.totals.remaining).toBeNull()
    expect(res.body.data.dataNote).toMatch(/no plan to compare against/i)
  })

  it('creates a DRAFT with multiple categories and CLIN lines', async () => {
    const res = await request(app).post('/api/erp/budgets').set(auth(userA.token)).send({
      contractId: contractA.id,
      title: 'Baseline',
      lines: [
        { category: 'LABOR', plannedAmount: '200000.00', clinId: clinA.id },
        { category: 'SUBCONTRACT', plannedAmount: '100000.00' },
        { category: 'TRAVEL', plannedAmount: '10.33' },
        { category: 'ODC', plannedAmount: '0.10' },
      ],
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.versionNumber).toBe(1)
    draftId = res.body.data.id
  })

  it('refuses a negative planned amount', async () => {
    const res = await request(app).post('/api/erp/budgets').set(auth(userA.token))
      .send({ contractId: contractA.id, lines: [{ category: 'LABOR', plannedAmount: '-1.00' }] })
    expect(res.status).toBe(422)
  })

  it('does not count a DRAFT as the plan', async () => {
    const res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    expect(res.body.data.hasBudget).toBe(false)
  })

  it('activates it through a human endpoint', async () => {
    const res = await request(app).post(`/api/erp/budgets/${draftId}/activate`).set(auth(userA.token)).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ACTIVE')
    expect(res.body.data.approvedByUserId).toBe(userA.id)
  })

  it('holds exact cents across the total', async () => {
    const res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    // 200000.00 + 100000.00 + 10.33 + 0.10
    expect(res.body.data.totals.budget).toBe('300010.43')
  })

  it('refuses to edit an ACTIVE version in place', async () => {
    const res = await request(app).put(`/api/erp/budgets/${draftId}`).set(auth(userA.token))
      .send({ lines: [{ category: 'LABOR', plannedAmount: '1.00' }] })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('BUDGET_IMMUTABLE')
  })

  it('supersedes the old version when a revision is activated', async () => {
    const rev = await request(app).post('/api/erp/budgets').set(auth(userA.token))
      .send({ contractId: contractA.id, lines: [{ category: 'LABOR', plannedAmount: '250000.00' }] })
    expect(rev.body.data.versionNumber).toBe(2)
    await request(app).post(`/api/erp/budgets/${rev.body.data.id}/activate`).set(auth(userA.token)).send({})

    const old = await prisma.contractBudget.findUnique({ where: { id: draftId } })
    expect(old!.status).toBe('SUPERSEDED')
    expect(old!.supersededAt).toBeTruthy()

    const active = await prisma.contractBudget.count({
      where: { contractId: contractA.id, status: 'ACTIVE' },
    })
    expect(active).toBe(1)

    // Restore the richer v1 shape for the remaining tests.
    await prisma.contractBudget.update({ where: { id: rev.body.data.id }, data: { status: 'SUPERSEDED' } })
    await prisma.contractBudget.update({ where: { id: draftId }, data: { status: 'ACTIVE' } })
  })
})

describe('§8.2 — actual, committed and remaining', () => {
  let poId: string

  it('counts approved time and approved cost as actual', async () => {
    await prisma.timeEntry.create({
      data: {
        consultingFirmId: firmA.id, contractId: contractA.id, clinId: clinA.id, userId: userA.id,
        laborCategory: 'Engineer', workDate: new Date(), hours: '10.00',
        status: 'APPROVED', billingAmount: '1000.00',
      },
    })
    await prisma.contractCost.create({
      data: {
        consultingFirmId: firmA.id, contractId: contractA.id, category: 'TRAVEL',
        amount: '250.50', status: 'APPROVED', incurredDate: new Date(),
      },
    })
    const res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    expect(res.body.data.totals.actual).toBe('1250.50')
    expect(res.body.data.actualBreakdown.labor).toBe('1000.00')
    expect(res.body.data.actualBreakdown.nonLabor).toBe('250.50')
  })

  it('ignores unapproved time and cost', async () => {
    await prisma.timeEntry.create({
      data: {
        consultingFirmId: firmA.id, contractId: contractA.id, userId: userA.id, laborCategory: 'Engineer',
        workDate: new Date(), hours: '99.00', status: 'DRAFT', billingAmount: '99999.00',
      },
    })
    const res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    expect(res.body.data.totals.actual).toBe('1250.50')
  })

  it('an APPROVED purchase order becomes committed, not actual', async () => {
    const po = await request(app).post('/api/erp/purchase-orders').set(auth(userA.token)).send({
      contractId: contractA.id, clinId: clinA.id, partnerId: partnerA.id,
      vendorName: 'ERP Vendor A', poNumber: `PO-${Date.now()}`, ceilingAmount: '20000.00',
      isSubcontract: true,
      lines: [{ description: 'Engineering support', amount: '20000.00', category: 'SUBCONTRACT' }],
    })
    expect(po.status).toBe(201)
    expect(po.body.data.status).toBe('DRAFT')
    poId = po.body.data.id

    // A DRAFT order commits nothing.
    let res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    expect(res.body.data.totals.committed).toBe('0.00')

    await request(app).post(`/api/erp/purchase-orders/${poId}/transition`).set(auth(userA.token)).send({ status: 'PENDING_APPROVAL' })
    await request(app).post(`/api/erp/purchase-orders/${poId}/transition`).set(auth(userA.token)).send({ status: 'APPROVED' })

    res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    expect(res.body.data.totals.committed).toBe('20000.00')
    expect(res.body.data.totals.actual).toBe('1250.50')
    // 300010.43 − 1250.50 − 20000.00
    expect(res.body.data.totals.remaining).toBe('278759.93')
  })

  it('refuses an illegal purchase-order transition and names the legal ones', async () => {
    const res = await request(app).post(`/api/erp/purchase-orders/${poId}/transition`).set(auth(userA.token))
      .send({ status: 'DRAFT' })
    expect(res.status).toBe(422)
    expect(res.body.allowedNextStates).toEqual(expect.arrayContaining(['PARTIALLY_RECEIVED', 'COMPLETE', 'CANCELLED']))
  })

  it('flags a threshold using actual PLUS committed', async () => {
    const res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    // ~7% consumed — below every band, so no threshold.
    expect(res.body.data.threshold).toBeNull()
  })
})

describe('§8.2 — subcontractor invoice posts actual cost exactly once', () => {
  let poId: string
  let invoiceId: string

  beforeAll(async () => {
    const po = await request(app).post('/api/erp/purchase-orders').set(auth(userA.token)).send({
      contractId: contractA.id, partnerId: partnerA.id, vendorName: 'ERP Vendor A',
      poNumber: `PO-INV-${Date.now()}`, ceilingAmount: '5000.00', isSubcontract: true,
    })
    poId = po.body.data.id
    await request(app).post(`/api/erp/purchase-orders/${poId}/transition`).set(auth(userA.token)).send({ status: 'PENDING_APPROVAL' })
    await request(app).post(`/api/erp/purchase-orders/${poId}/transition`).set(auth(userA.token)).send({ status: 'APPROVED' })
  })

  it('records a vendor invoice separately from customer invoices', async () => {
    const res = await request(app).post('/api/erp/subcontract-invoices').set(auth(userA.token)).send({
      purchaseOrderId: poId, invoiceNumber: 'V-1001', invoiceDate: iso(new Date()), amount: '1200.00',
      lines: [{ description: 'February support', amount: '1200.00' }],
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('RECEIVED')
    invoiceId = res.body.data.id

    // Accounts payable must not appear as a customer receivable.
    const ar = await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id, contractId: contractA.id } })
    expect(ar).toBe(0)
  })

  it('does not post cost before a human approves', async () => {
    const costs = await prisma.contractCost.count({
      where: { consultingFirmId: firmA.id, sourceType: 'SUBCONTRACT_INVOICE', sourceId: invoiceId },
    })
    expect(costs).toBe(0)
  })

  it('posts exactly one cost on approval', async () => {
    const res = await request(app).post(`/api/erp/subcontract-invoices/${invoiceId}/transition`).set(auth(userA.token))
      .send({ status: 'APPROVED' })
    expect(res.status).toBe(200)
    expect(res.body.data.posting.created).toBe(true)

    const costs = await prisma.contractCost.findMany({
      where: { consultingFirmId: firmA.id, sourceType: 'SUBCONTRACT_INVOICE', sourceId: invoiceId },
    })
    expect(costs).toHaveLength(1)
    expect(costs[0].category).toBe('SUBCONTRACTOR')
    expect(costs[0].status).toBe('APPROVED')
    expect(costs[0].amount.toFixed(2)).toBe('1200.00')
  })

  it('is idempotent — repeated posting never creates a second cost', async () => {
    const { postSubcontractInvoiceCost } = await import('../services/erp/subcontractPosting')
    for (let i = 0; i < 3; i++) {
      const r = await postSubcontractInvoiceCost(firmA.id, invoiceId, userA.id)
      expect(r.created).toBe(false)
    }
    const costs = await prisma.contractCost.count({
      where: { consultingFirmId: firmA.id, sourceType: 'SUBCONTRACT_INVOICE', sourceId: invoiceId },
    })
    expect(costs).toBe(1)
  })

  it('moves the posted amount from committed into actual, never counting it twice', async () => {
    const res = await request(app).get(`/api/erp/contracts/${contractA.id}/budget-vs-actual`).set(auth(userA.token))
    // actual 1250.50 + 1200.00 posted
    expect(res.body.data.totals.actual).toBe('2450.50')
    // committed 20000 (other PO) + (5000 ceiling − 1200 posted) = 23800
    expect(res.body.data.totals.committed).toBe('23800.00')
  })

  it('records payment as a human reference and still posts only one cost', async () => {
    const res = await request(app).post(`/api/erp/subcontract-invoices/${invoiceId}/transition`).set(auth(userA.token))
      .send({ status: 'PAID', paymentReference: 'ACH-REF-9' })
    expect(res.status).toBe(200)
    expect(res.body.data.paymentReference).toBe('ACH-REF-9')
    expect(res.body.data.paymentNote).toMatch(/does not move money/i)
    const costs = await prisma.contractCost.count({
      where: { consultingFirmId: firmA.id, sourceType: 'SUBCONTRACT_INVOICE', sourceId: invoiceId },
    })
    expect(costs).toBe(1)
  })

  it('reports an over-ceiling invoice rather than blocking it', async () => {
    const res = await request(app).post('/api/erp/subcontract-invoices').set(auth(userA.token)).send({
      purchaseOrderId: poId, invoiceNumber: 'V-1002', invoiceDate: iso(new Date()), amount: '9000.00',
    })
    expect(res.status).toBe(201)
    expect(res.body.data.balance.overInvoiced).toBe(true)
    expect(res.body.data.overCeilingWarning).toMatch(/exceed/i)
  })

  it('refuses a duplicate invoice number on the same order', async () => {
    const res = await request(app).post('/api/erp/subcontract-invoices').set(auth(userA.token))
      .send({ purchaseOrderId: poId, invoiceNumber: 'V-1001', invoiceDate: iso(new Date()), amount: '1.00' })
    expect(res.status).toBe(422)
  })
})

describe('§8.2 — resource allocation and capacity', () => {
  it('reports INSUFFICIENT_DATA with no plan — never available', async () => {
    const res = await request(app).get('/api/erp/capacity').set(auth(userB.token))
    expect(res.status).toBe(200)
    expect(res.body.data.state).toBe('INSUFFICIENT_DATA')
    expect(res.body.data.dataNote).toMatch(/not a statement that the team is available/i)
    expect(res.body.data.people).toHaveLength(0)
  })

  it('creates an allocation and reports remaining capacity', async () => {
    const res = await request(app).post('/api/erp/resource-allocations').set(auth(userA.token)).send({
      userId: userA.id, contractId: contractA.id, allocationPercent: 60,
      laborCategory: 'Engineer', startDate: iso(new Date()), endDate: iso(future(90)),
    })
    expect(res.status).toBe(201)
    expect(res.body.data.conflict).toBeNull()

    const cap = await request(app).get('/api/erp/capacity').set(auth(userA.token))
    expect(cap.body.data.people[0].allocatedPercent).toBe(60)
    expect(cap.body.data.people[0].remainingPercent).toBe(40)
    expect(cap.body.data.state).toBe('AVAILABLE')
  })

  it('surfaces an over-allocation as a conflict rather than refusing it', async () => {
    const res = await request(app).post('/api/erp/resource-allocations').set(auth(userA.token)).send({
      userId: userA.id, contractId: contractA.id, allocationPercent: 70,
      startDate: iso(new Date()), endDate: iso(future(60)),
    })
    expect(res.status).toBe(201)
    expect(res.body.data.conflict.state).toBe('CAPACITY_CONFLICT')
    expect(res.body.data.conflict.allocatedPercent).toBe(130)

    const cap = await request(app).get('/api/erp/capacity').set(auth(userA.token))
    expect(cap.body.data.state).toBe('OVER_ALLOCATED')
    expect(cap.body.data.conflicts).toHaveLength(1)
  })

  it('refuses impossible allocation values', async () => {
    for (const pct of [0, -10, 101]) {
      const res = await request(app).post('/api/erp/resource-allocations').set(auth(userA.token))
        .send({ userId: userA.id, contractId: contractA.id, allocationPercent: pct, startDate: iso(new Date()) })
      expect(res.status).toBe(422)
    }
  })

  it('refuses an end date before the start', async () => {
    const res = await request(app).post('/api/erp/resource-allocations').set(auth(userA.token))
      .send({ userId: userA.id, contractId: contractA.id, allocationPercent: 10, startDate: iso(future(10)), endDate: iso(new Date()) })
    expect(res.status).toBe(422)
  })

  it('excludes an allocation that has already ended', async () => {
    const cap = await request(app).get('/api/erp/capacity')
      .query({ start: iso(future(365)) }).set(auth(userA.token))
    expect(cap.body.data.state).toBe('INSUFFICIENT_DATA')
  })

  it('exposes an advisory pursuit-window read that decides nothing', async () => {
    const before = await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })
    const res = await request(app).get('/api/erp/capacity/pursuit-window')
      .query({ start: iso(new Date()), end: iso(future(30)) }).set(auth(userA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.note).toMatch(/never changes a qualification or bid decision/i)
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(before)
  })
})

describe('§8.2 — flow-down tracking makes no legal conclusion', () => {
  let poId: string

  beforeAll(async () => {
    const po = await request(app).post('/api/erp/purchase-orders').set(auth(userA.token))
      .send({ contractId: contractA.id, vendorName: 'Flow Vendor', poNumber: `PO-FD-${Date.now()}`, ceilingAmount: '1000.00' })
    poId = po.body.data.id
  })

  it('starts a tracked clause at INSUFFICIENT_DATA and carries the disclaimer', async () => {
    const res = await request(app).post('/api/erp/flow-downs').set(auth(userA.token))
      .send({ purchaseOrderId: poId, clauseNumber: 'FAR 52.219-8' })
    expect(res.status).toBe(201)
    expect(res.body.data.state).toBe('INSUFFICIENT_DATA')

    const list = await request(app).get(`/api/erp/purchase-orders/${poId}/flow-downs`).set(auth(userA.token))
    expect(list.body.data.disclaimer).toMatch(/not legal determinations/i)
    expect(list.body.data.disclaimer).toMatch(/legal review is never cleared automatically/i)
  })

  it('records the human reviewer whenever a state is set', async () => {
    const created = await request(app).post('/api/erp/flow-downs').set(auth(userA.token))
      .send({ purchaseOrderId: poId, clauseNumber: 'FAR 52.222-50' })
    const res = await request(app).post(`/api/erp/flow-downs/${created.body.data.id}/review`).set(auth(userA.token))
      .send({ state: 'INCLUDED', evidence: 'Included at clause 12 of the executed subcontract.' })
    expect(res.status).toBe(200)
    expect(res.body.data.reviewedByUserId).toBe(userA.id)
    expect(res.body.data.reviewedAt).toBeTruthy()
  })

  it('seeds only REVIEW_REQUIRED rows, never an applicability conclusion', async () => {
    const res = await request(app).post(`/api/erp/purchase-orders/${poId}/flow-downs/seed`).set(auth(userA.token)).send({})
    expect(res.status).toBe(200)
    const rows = await prisma.subcontractFlowDown.findMany({ where: { purchaseOrderId: poId } })
    expect(rows.every((r) => r.state !== 'APPLICABLE_CONFIRMED' || r.reviewedByUserId !== null)).toBe(true)
  })
})

describe('§8.2 — financial summary', () => {
  it('separates funded, unfunded, backlog and receivables', async () => {
    const res = await request(app).get(`/api/erp/contracts/${contractA.id}/financial-summary`).set(auth(userA.token))
    expect(res.status).toBe(200)
    const d = res.body.data
    expect(d.contractValue).toBe('1000000.00')
    expect(d.contractValueSource).toBe('CEILING')
    expect(d.funded).toBe('400000.00')
    expect(d.unfunded).toBe('600000.00')
    expect(d.backlog).toBe((1000000 - Number(d.actual)).toFixed(2))
    expect(d.backlogBasis).toMatch(/not pipeline/i)
    // Receivables are the customer side and stay zero here.
    expect(d.receivables.outstanding).toBe('0.00')
    // Vendor commitments are the payable side and are reported separately.
    expect(Number(d.subcontractCommitments.posted)).toBeGreaterThan(0)
  })

  it('reports missing contract value as null with a stated limitation', async () => {
    const bare = await prisma.contract.create({
      data: { consultingFirmId: firmA.id, contractNumber: `BARE-${Date.now()}`, title: 'No value', status: 'ACTIVE' },
      select: { id: true },
    })
    const res = await request(app).get(`/api/erp/contracts/${bare.id}/financial-summary`).set(auth(userA.token))
    expect(res.body.data.contractValue).toBeNull()
    expect(res.body.data.unfunded).toBeNull()
    expect(res.body.data.backlog).toBeNull()
    expect(res.body.data.limitations.join(' ')).toMatch(/backlog cannot be computed/i)
  })
})

describe('§8.2 — tenant isolation and IDOR', () => {
  it('hides every ERP record from the other firm', async () => {
    for (const path of ['/api/erp/purchase-orders', '/api/erp/subcontract-invoices', '/api/erp/resource-allocations']) {
      const res = await request(app).get(path).set(auth(userB.token))
      expect(res.status).toBe(200)
      expect(res.body.data).toHaveLength(0)
    }
  })

  it('refuses another firm’s contract on every ERP read', async () => {
    for (const p of ['budget-vs-actual', 'financial-summary', 'budgets']) {
      const res = await request(app).get(`/api/erp/contracts/${contractA.id}/${p}`).set(auth(userB.token))
      expect(res.status).toBe(404)
    }
  })

  it('refuses to attach another firm’s contract, CLIN or partner', async () => {
    const po = await request(app).post('/api/erp/purchase-orders').set(auth(userB.token))
      .send({ contractId: contractA.id, vendorName: 'X', poNumber: `X-${Date.now()}`, ceilingAmount: '1.00' })
    expect(po.status).toBe(404)

    const budget = await request(app).post('/api/erp/budgets').set(auth(userB.token))
      .send({ contractId: contractB.id, lines: [{ category: 'LABOR', plannedAmount: '1.00', clinId: clinA.id }] })
    expect(budget.status).toBe(404)

    const alloc = await request(app).post('/api/erp/resource-allocations').set(auth(userB.token))
      .send({ userId: userA.id, contractId: contractB.id, allocationPercent: 10, startDate: iso(new Date()) })
    expect(alloc.status).toBe(404)
  })

  it('refuses to transition another firm’s purchase order or invoice', async () => {
    const po = await prisma.purchaseOrder.findFirst({ where: { consultingFirmId: firmA.id }, select: { id: true } })
    const res = await request(app).post(`/api/erp/purchase-orders/${po!.id}/transition`).set(auth(userB.token)).send({ status: 'CANCELLED' })
    expect(res.status).toBe(404)

    const inv = await prisma.subcontractInvoice.findFirst({ where: { consultingFirmId: firmA.id }, select: { id: true } })
    const res2 = await request(app).post(`/api/erp/subcontract-invoices/${inv!.id}/transition`).set(auth(userB.token)).send({ status: 'APPROVED' })
    expect(res2.status).toBe(404)
  })
})

describe('§8.2 — cross-tenant finance isolation', () => {
  it('leaves Firm A byte-identical when Firm B books extreme values', async () => {
    const before = await request(app).get(`/api/erp/contracts/${contractA.id}/financial-summary`).set(auth(userA.token))

    const budgetB = await request(app).post('/api/erp/budgets').set(auth(userB.token))
      .send({ contractId: contractB.id, lines: [{ category: 'LABOR', plannedAmount: '99999999.99' }] })
    await request(app).post(`/api/erp/budgets/${budgetB.body.data.id}/activate`).set(auth(userB.token)).send({})
    await prisma.contractCost.create({
      data: {
        consultingFirmId: firmB.id, contractId: contractB.id, category: 'MATERIAL',
        amount: '99999999.99', status: 'APPROVED', incurredDate: new Date(),
      },
    })
    await prisma.fundingTransaction.create({
      data: { consultingFirmId: firmB.id, contractId: contractB.id, type: 'INITIAL_OBLIGATION', amount: '99999999.99' },
    })

    const after = await request(app).get(`/api/erp/contracts/${contractA.id}/financial-summary`).set(auth(userA.token))
    expect(after.body.data).toEqual(before.body.data)
  })
})
