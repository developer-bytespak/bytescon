// =============================================================
// Section 5 Module 9 — Contract Finance integration tests.
// Funding ledger (+recompute +idempotency +void), costs approve→expenditure,
// rate overlap, time draft→submit→approve(costed)→reject, burn summary, invoice
// collection (double-invoice prevention), approve/submit/void, payments
// (partial/full/overpayment/void), receivables, authz, cross-tenant.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let other: TestFirm
let otherAdmin: TestUser
let contractId: string

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
const F = '/api/contract-finance'
const CM = '/api/contract-management'

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Finance Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Finance Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
  contractId = (await request(app).post(CM).set(H(admin.token)).send({ contractNumber: 'FIN-0001', title: 'Finance Contract', ceilingValue: 500000, endDate: iso(365), startDate: iso(-30) })).body.data.id
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(other.id)
  await disconnectDb()
})

describe('Funding ledger', () => {
  it('401 + CONSULTANT read-only 403', async () => {
    await request(app).get(`${F}/${contractId}/funding`).expect(401)
    await request(app).post(`${F}/${contractId}/funding`).set(H(consultant.token)).send({ type: 'INITIAL_OBLIGATION', amount: 1 }).expect(403)
  })

  it('records funding, maintains Contract.fundedValue from the ledger', async () => {
    await request(app).post(`${F}/${contractId}/funding`).set(H(admin.token)).send({ type: 'INITIAL_OBLIGATION', amount: 100000 }).expect(201)
    const inc = await request(app).post(`${F}/${contractId}/funding`).set(H(admin.token)).send({ type: 'INCREMENTAL_FUNDING', amount: 50000 }).expect(201)
    expect(inc.body.data.fundedTotal).toBe('150000.00')
    // reduction is signed negative in the ledger
    await request(app).post(`${F}/${contractId}/funding`).set(H(admin.token)).send({ type: 'FUNDING_REDUCTION', amount: 20000 }).expect(201)
    const c = await prisma.contract.findUnique({ where: { id: contractId } })
    expect(Number(c!.fundedValue)).toBe(130000) // 100k + 50k - 20k, cache == ledger
  })

  it('modification funding is idempotent (unique modificationId)', async () => {
    const modId = crypto.randomUUID()
    await request(app).post(`${F}/${contractId}/funding`).set(H(admin.token)).send({ type: 'INCREMENTAL_FUNDING', amount: 10000, modificationId: modId }).expect(201)
    await request(app).post(`${F}/${contractId}/funding`).set(H(admin.token)).send({ type: 'INCREMENTAL_FUNDING', amount: 10000, modificationId: modId }).expect(409)
  })

  it('void recomputes the funded total', async () => {
    const txn = await prisma.fundingTransaction.findFirst({ where: { contractId, type: 'FUNDING_REDUCTION' } })
    await request(app).post(`${F}/funding/${txn!.id}/void`).set(H(admin.token)).send({ reason: 'entered in error' }).expect(200)
    const c = await prisma.contract.findUnique({ where: { id: contractId } })
    expect(Number(c!.fundedValue)).toBe(160000) // 100k + 50k + 10k (reduction voided)
  })

  it('cross-tenant funding read blocked (404)', async () => {
    await request(app).get(`${F}/${contractId}/funding`).set(H(otherAdmin.token)).expect(404)
  })
})

describe('Rates + Time + Expenditure', () => {
  it('rejects overlapping rate periods for the same category+type', async () => {
    await request(app).post(`${F}/${contractId}/rates`).set(H(admin.token)).send({ categoryName: 'Engineer', billingRate: 150, costRate: 90, effectiveStart: iso(-60), effectiveEnd: iso(60) }).expect(201)
    await request(app).post(`${F}/${contractId}/rates`).set(H(admin.token)).send({ categoryName: 'Engineer', billingRate: 160, effectiveStart: iso(0), effectiveEnd: iso(120) }).expect(409)
  })

  it('CONSULTANT cannot see cost rates (stripped)', async () => {
    const res = await request(app).get(`${F}/${contractId}/rates`).set(H(consultant.token)).expect(200)
    expect(res.body.data[0].billingRate).toBeDefined()
    expect(res.body.data[0].costRate).toBeUndefined()
  })

  it('time draft → submit → approve computes billing from the effective rate', async () => {
    const t = (await request(app).post(`${F}/${contractId}/time`).set(H(admin.token)).send({ laborCategory: 'Engineer', workDate: iso(-1), hours: 8 }).expect(201)).body.data
    await request(app).post(`${F}/time/${t.id}/submit`).set(H(admin.token)).expect(200)
    const approved = await request(app).post(`${F}/time/${t.id}/approve`).set(H(admin.token)).expect(200)
    expect(Number(approved.body.data.billingAmount)).toBe(1200) // 8 * 150
    expect(approved.body.meta.rateApplied).toBe(true)
  })

  it('rejects future-dated time and invalid hours', async () => {
    await request(app).post(`${F}/${contractId}/time`).set(H(admin.token)).send({ laborCategory: 'Engineer', workDate: iso(5), hours: 8 }).expect(422)
    await request(app).post(`${F}/${contractId}/time`).set(H(admin.token)).send({ laborCategory: 'Engineer', workDate: iso(-1), hours: 0 }).expect(422)
  })

  it('approved time appears in the burn summary as recognized expenditure', async () => {
    const s = await request(app).get(`${F}/${contractId}/summary`).set(H(admin.token)).expect(200)
    expect(Number(s.body.data.expended)).toBeGreaterThanOrEqual(1200)
    expect(Number(s.body.data.funded)).toBe(160000)
  })
})

describe('Costs → expenditure', () => {
  it('draft → submit → approve; approved cost adds to expenditure', async () => {
    const c = (await request(app).post(`${F}/${contractId}/costs`).set(H(admin.token)).send({ category: 'TRAVEL', amount: 500, incurredDate: iso(-2) }).expect(201)).body.data
    await request(app).post(`${F}/costs/${c.id}/submit`).set(H(admin.token)).expect(200)
    await request(app).post(`${F}/costs/${c.id}/approve`).set(H(admin.token)).expect(200)
    const s = await request(app).get(`${F}/${contractId}/summary`).set(H(admin.token)).expect(200)
    expect(Number(s.body.data.expended)).toBeGreaterThanOrEqual(1700) // 1200 labor + 500 travel
  })
})

describe('Invoices + double-invoice prevention + payments', () => {
  let invoiceId: string
  it('creates an invoice collecting approved uninvoiced time+costs, only once', async () => {
    const inv = (await request(app).post(`${F}/${contractId}/invoices`).set(H(admin.token)).send({ dueDate: iso(-1), feeAmount: 100 }).expect(201)).body.data
    invoiceId = inv.id
    expect(Number(inv.total)).toBe(1800) // 1200 + 500 + 100 fee
    expect(inv.lineItems.length).toBe(3)
    // A second invoice finds nothing new to bill (sources already invoiced).
    const inv2 = (await request(app).post(`${F}/${contractId}/invoices`).set(H(admin.token)).send({}).expect(201)).body.data
    expect(inv2.lineItems.length).toBe(0)
    expect(Number(inv2.total)).toBe(0)
  })

  it('approve → submit, then partial + final payment drive status + outstanding', async () => {
    await request(app).post(`${F}/invoices/${invoiceId}/approve`).set(H(admin.token)).expect(200)
    await request(app).post(`${F}/invoices/${invoiceId}/submit`).set(H(admin.token)).send({ reference: 'WAWF-manual' }).expect(200)
    // overpayment prevented
    await request(app).post(`${F}/invoices/${invoiceId}/payments`).set(H(admin.token)).send({ amount: 5000 }).expect(409)
    const p1 = await request(app).post(`${F}/invoices/${invoiceId}/payments`).set(H(admin.token)).send({ amount: 800 }).expect(201)
    expect(p1.body.data.invoice.status).toBe('PARTIALLY_PAID')
    expect(p1.body.data.outstanding).toBe('1000.00')
    const p2 = await request(app).post(`${F}/invoices/${invoiceId}/payments`).set(H(admin.token)).send({ amount: 1000 }).expect(201)
    expect(p2.body.data.invoice.status).toBe('PAID')
    expect(p2.body.data.outstanding).toBe('0.00')
  })

  it('a fully paid invoice cannot be voided; cross-tenant invoice access 404', async () => {
    await request(app).post(`${F}/invoices/${invoiceId}/void`).set(H(admin.token)).send({ reason: 'x' }).expect(409)
    await request(app).get(`${F}/invoices/${invoiceId}`).set(H(otherAdmin.token)).expect(404)
  })
})

describe('Receivables + alerts', () => {
  it('receivables ageing returns bucketed totals', async () => {
    const r = await request(app).get(`${F}/receivables`).set(H(admin.token)).expect(200)
    expect(r.body.data).toHaveProperty('totalOutstanding')
  })
  it('alerts endpoint returns tenant-scoped alerts array with links', async () => {
    const r = await request(app).get(`${F}/alerts`).set(H(admin.token)).expect(200)
    expect(Array.isArray(r.body.data)).toBe(true)
  })
})

// §8.2 — CLIN on the invoice line.
//
// The government bills by CLIN. What matters here is not that a CLIN can be
// stored, but that the CLIN on the bill is the one already on the record the
// line was built from — a re-picked CLIN is how an invoice and an incurred-cost
// submission disagree.
describe('Invoice lines carry the CLIN of the record behind them', () => {
  let clinA = ''
  let clinB = ''

  beforeAll(async () => {
    const a = await prisma.clin.create({
      data: { consultingFirmId: firm.id, contractId, clinNumber: 'INV-0001', title: 'Labour line' },
    })
    const b = await prisma.clin.create({
      data: { consultingFirmId: firm.id, contractId, clinNumber: 'INV-0002', title: 'Travel line' },
    })
    clinA = a.id
    clinB = b.id
  })

  it('bills approved time and cost under their own CLINs', async () => {
    const t = (await request(app).post(`${F}/${contractId}/time`).set(H(admin.token))
      .send({ laborCategory: 'Engineer', workDate: iso(-2), hours: 4, clinId: clinA }).expect(201)).body.data
    await request(app).post(`${F}/time/${t.id}/submit`).set(H(admin.token)).expect(200)
    await request(app).post(`${F}/time/${t.id}/approve`).set(H(admin.token)).expect(200)

    const c = (await request(app).post(`${F}/${contractId}/costs`).set(H(admin.token))
      .send({ category: 'TRAVEL', description: 'Site visit', amount: 300, incurredDate: iso(-2), clinId: clinB }).expect(201)).body.data
    await request(app).post(`${F}/costs/${c.id}/submit`).set(H(admin.token)).expect(200)
    await request(app).post(`${F}/costs/${c.id}/approve`).set(H(admin.token)).expect(200)

    const inv = (await request(app).post(`${F}/${contractId}/invoices`).set(H(admin.token))
      .send({ feeAmount: 50 }).expect(201)).body.data

    const labor = inv.lineItems.find((l: { kind: string }) => l.kind === 'LABOR')
    const odc = inv.lineItems.find((l: { kind: string }) => l.kind === 'ODC')
    const fee = inv.lineItems.find((l: { kind: string }) => l.kind === 'FEE')

    expect(labor.clinId).toBe(clinA)
    expect(odc.clinId).toBe(clinB)
    // A fee spans the invoice, so attributing it to a CLIN would be a guess.
    expect(fee.clinId).toBeNull()
  })

  it('returns the CLIN number with the line, which is what the invoice prints', async () => {
    const list = (await request(app).get(`${F}/${contractId}/invoices`).set(H(admin.token)).expect(200)).body.data
    const detail = (await request(app).get(`${F}/invoices/${list[0].id}`).set(H(admin.token)).expect(200)).body.data
    const numbers = detail.lineItems.map((l: { clin: { clinNumber: string } | null }) => l.clin?.clinNumber ?? null)
    expect(numbers).toContain('INV-0001')
    expect(numbers).toContain('INV-0002')
  })

  it('cross-tenant invoice detail stays blocked', async () => {
    const list = (await request(app).get(`${F}/${contractId}/invoices`).set(H(admin.token)).expect(200)).body.data
    await request(app).get(`${F}/invoices/${list[0].id}`).set(H(otherAdmin.token)).expect(404)
  })
})

// §8.2 — chasing an invoice, and exporting it.
//
// The assertion that carries the design: recording a chase must NOT improve
// the invoice's status. An ageing report that got better because somebody sent
// an email would hide money that is still outstanding.
describe('Invoice follow-up and export', () => {
  let invoiceId = ''
  let followUpId = ''

  beforeAll(async () => {
    const list = (await request(app).get(`${F}/${contractId}/invoices`).set(H(admin.token)).expect(200)).body.data
    invoiceId = list[0].id
  })

  it('records a chase against the invoice', async () => {
    const res = await request(app).post(`${F}/invoices/${invoiceId}/follow-ups`).set(H(admin.token))
      .send({ method: 'EMAIL', contactName: 'A. Payer', note: 'Chased payment status.', nextActionAt: iso(7) })
      .expect(201)
    followUpId = res.body.data.id
    expect(res.body.data.method).toBe('EMAIL')
    expect(res.body.data.resolvedAt).toBeNull()
  })

  it('leaves the invoice status exactly where it was', async () => {
    const before = await prisma.contractInvoice.findUnique({ where: { id: invoiceId } })
    await request(app).post(`${F}/invoices/${invoiceId}/follow-ups`).set(H(admin.token))
      .send({ method: 'PHONE', note: 'Left a voicemail.' }).expect(201)
    const after = await prisma.contractInvoice.findUnique({ where: { id: invoiceId } })
    expect(after!.status).toBe(before!.status)
    expect(after!.amountPaid.toFixed(2)).toBe(before!.amountPaid.toFixed(2))
  })

  it('lists the chases newest first', async () => {
    const res = await request(app).get(`${F}/invoices/${invoiceId}/follow-ups`).set(H(admin.token)).expect(200)
    expect(res.body.data.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects a chase with no note', async () => {
    await request(app).post(`${F}/invoices/${invoiceId}/follow-ups`).set(H(admin.token))
      .send({ method: 'EMAIL', note: '' }).expect(422)
  })

  it('rejects a method it does not recognise', async () => {
    await request(app).post(`${F}/invoices/${invoiceId}/follow-ups`).set(H(admin.token))
      .send({ method: 'CARRIER_PIGEON', note: 'x' }).expect(422)
  })

  it('closes a chase without touching the invoice', async () => {
    const res = await request(app).post(`${F}/follow-ups/${followUpId}/resolve`).set(H(admin.token)).expect(200)
    expect(res.body.data.resolvedAt).not.toBeNull()
    const inv = await prisma.contractInvoice.findUnique({ where: { id: invoiceId } })
    expect(inv!.paidAt).toBeNull()
  })

  it('blocks another tenant from chasing or reading', async () => {
    await request(app).get(`${F}/invoices/${invoiceId}/follow-ups`).set(H(otherAdmin.token)).expect(404)
    await request(app).post(`${F}/invoices/${invoiceId}/follow-ups`).set(H(otherAdmin.token))
      .send({ method: 'EMAIL', note: 'x' }).expect(404)
  })

  it('exports the invoice as CSV with a CLIN column', async () => {
    const res = await request(app).get(`${F}/invoices/${invoiceId}/export`).set(H(admin.token)).expect(200)
    const body = res.text ?? String(res.body)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toContain('.csv')
    expect(body).toContain('CLIN,Kind,Description')
    expect(body).toContain('Invoice number')
  })

  it('refuses the export to another tenant', async () => {
    await request(app).get(`${F}/invoices/${invoiceId}/export`).set(H(otherAdmin.token)).expect(404)
  })
})

// §8.2 — the incurred-cost evidence package.
//
// The point of these is the GAPS. A package that silently drops unapproved
// time and reports a clean total is the exact failure this feature exists to
// prevent, so the omission has to be visible in the payload.
describe('Audit readiness package', () => {
  const fiscalYear = new Date().getUTCFullYear()
  const pkg = (token: string, extra = '') =>
    request(app).get(`${F}/audit-package?fiscalYear=${fiscalYear}${extra}`).set(H(token))

  it('reports approved cost, and separates labour from what was billed', async () => {
    const res = await pkg(admin.token).expect(200)
    const d = res.body.data
    expect(d.fiscalYear).toBe(fiscalYear)
    expect(d.totals).toHaveProperty('directLabour')
    expect(d.totals).toHaveProperty('billed')
    expect(d.methodVersion).toBe('erp-audit-package-v1')
  })

  it('names unapproved time as a blocking gap rather than dropping it quietly', async () => {
    const t = (await request(app).post(`${F}/${contractId}/time`).set(H(admin.token))
      .send({ laborCategory: 'Engineer', workDate: iso(-1), hours: 3 }).expect(201)).body.data
    await request(app).post(`${F}/time/${t.id}/submit`).set(H(admin.token)).expect(200)

    const res = await pkg(admin.token).expect(200)
    const gap = res.body.data.gaps.find((g: { area: string }) => g.area === 'Timekeeping')
    expect(gap).toBeDefined()
    expect(gap.severity).toBe('BLOCKING')
    expect(gap.count).toBeGreaterThanOrEqual(1)
  })

  it('says so when no actual indirect rate exists for the year', async () => {
    const res = await pkg(admin.token).expect(200)
    const gap = res.body.data.gaps.find((g: { area: string }) => g.area === 'Indirect rates')
    expect(gap).toBeDefined()
    expect(gap.severity).toBe('BLOCKING')
  })

  it('states plainly that it is evidence, not a filed submission', async () => {
    const res = await pkg(admin.token).expect(200)
    expect(res.body.data.notes.join(' ')).toMatch(/not a filed submission/i)
  })

  it('scopes to one contract when asked', async () => {
    const res = await pkg(admin.token, `&contractId=${contractId}`).expect(200)
    expect(res.body.data.contracts).toHaveLength(1)
    expect(res.body.data.contracts[0].contractId).toBe(contractId)
  })

  it('refuses another tenant a contract it does not own', async () => {
    await pkg(otherAdmin.token, `&contractId=${contractId}`).expect(404)
  })

  it('keeps cost figures away from a consultant', async () => {
    await pkg(consultant.token).expect(403)
  })

  it('rejects a fiscal year that is not one', async () => {
    await request(app).get(`${F}/audit-package?fiscalYear=nope`).set(H(admin.token)).expect(422)
  })

  it('exports the schedules as CSV', async () => {
    const res = await request(app).get(`${F}/audit-package/export?fiscalYear=${fiscalYear}`).set(H(admin.token)).expect(200)
    const body = res.text ?? String(res.body)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(body).toContain('Schedule A — incurred cost by contract')
    expect(body).toContain('Schedule B — incurred cost by CLIN')
    expect(body).toContain('Schedule C — actual indirect rates')
    expect(body).toContain('Gaps — what is missing or unverified')
  })
})
