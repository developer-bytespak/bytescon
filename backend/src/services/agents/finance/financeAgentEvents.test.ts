// =============================================================
// §7.8 — Finance events, the HTTP surface, and the no-prompt proof.
//
// The three events are proven through their REAL write paths: a committed
// business write emits exactly one event, a rolled-back write emits none, a
// benign duplicate never rolls the business write back, and no event crosses a
// tenant boundary.
//
// BILLING_PERIOD_CLOSED is proven ABSENT rather than faked — the codebase has
// no contract billing-period close, so the monthly cycle is tested through
// schedule-driven idempotency instead, which is what actually exists.
//
// The HTTP surface is proven to contain no endpoint that approves, submits,
// pays, writes off, or transmits anything to an external system.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb,
  type TestFirm, type TestUser,
} from '../../../test-utils/testClient'
import { claimEvents } from '../outbox'
import {
  INVOICE_PAID, TIME_ENTRY_SUBMITTED, CONTRACT_COST_ADDED,
  FINANCE_EVENT_TYPES, isInvoiceNowPaid, emitInvoicePaid,
} from './financeEvents'
import { agentsSubscribedTo } from '../registry'

const BASE = '/api/agents/finance'
const FINANCE_BASE = '/api/contract-finance'
const DAY = 86_400_000
const dec = (v: string | number) => new Prisma.Decimal(v)

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let consultantA: TestUser
let adminB: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'Finance Event Firm A' })
  firmB = await createTestFirm({ name: 'Finance Event Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  consultantA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.actualIndirectRate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.cashFlowProjection.deleteMany({ where: { consultingFirmId: id } })
    await prisma.dcaaReadinessCheck.deleteMany({ where: { consultingFirmId: id } })
    await prisma.invoicePayment.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractInvoiceLineItem.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractInvoice.deleteMany({ where: { consultingFirmId: id } })
    await prisma.timeEntry.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractCost.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contract.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeContract(firm: TestFirm) {
  return prisma.contract.create({
    data: {
      consultingFirmId: firm.id, contractNumber: uniq('S7-FIN-EV'),
      title: 'S7-FIN-EV support', agency: 'Department of Defense', status: 'ACTIVE',
    },
  })
}

async function makeTime(firmId: string, contractId: string, over: Record<string, unknown> = {}) {
  return prisma.timeEntry.create({
    data: {
      consultingFirmId: firmId, contractId, userId: 'user-1', laborCategory: 'Engineer',
      workDate: new Date(Date.now() - 3 * DAY), hours: dec('8.00'), status: 'DRAFT', ...over,
    },
  })
}

async function makeInvoice(firmId: string, contractId: string, over: Record<string, unknown> = {}) {
  return prisma.contractInvoice.create({
    data: {
      consultingFirmId: firmId, contractId, invoiceNumber: uniq('INV-EV'), status: 'SUBMITTED',
      invoiceDate: new Date(), dueDate: new Date(Date.now() + 30 * DAY),
      total: dec('1000.00'), subtotal: dec('1000.00'), amountPaid: dec('0.00'), ...over,
    },
  })
}

const eventsOfType = (firmId: string, eventType: string) =>
  prisma.agentEvent.findMany({ where: { consultingFirmId: firmId, eventType } })

// =============================================================
// The pure rule
// =============================================================

describe('isInvoiceNowPaid', () => {
  it('is true only on a genuine transition into PAID', () => {
    expect(isInvoiceNowPaid('SUBMITTED', 'PAID')).toBe(true)
    expect(isInvoiceNowPaid('PARTIALLY_PAID', 'PAID')).toBe(true)
  })

  it('is false when the invoice was already paid', () => {
    expect(isInvoiceNowPaid('PAID', 'PAID')).toBe(false)
  })

  it('is false for a partial payment', () => {
    expect(isInvoiceNowPaid('SUBMITTED', 'PARTIALLY_PAID')).toBe(false)
  })
})

// =============================================================
// CONTRACT_COST_ADDED
// =============================================================

describe('CONTRACT_COST_ADDED', () => {
  it('emits exactly one event when a cost is created', async () => {
    const contract = await makeContract(firmA)
    const res = await request(app)
      .post(`${FINANCE_BASE}/${contract.id}/costs`)
      .set(H(adminA.token))
      .send({ category: 'TRAVEL', description: 'Site visit', amount: 412.37 })
    expect(res.status).toBe(201)

    const events = await eventsOfType(firmA.id, CONTRACT_COST_ADDED)
    expect(events).toHaveLength(1)
    expect(events[0].entityId).toBe(contract.id)
    expect((events[0].payload as { category: string }).category).toBe('TRAVEL')
  })

  it('emits nothing when a cost merely changes status', async () => {
    const contract = await makeContract(firmA)
    const created = await request(app)
      .post(`${FINANCE_BASE}/${contract.id}/costs`)
      .set(H(adminA.token))
      .send({ category: 'TRAVEL', amount: 100 })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmA.id } })

    const res = await request(app).post(`${FINANCE_BASE}/costs/${created.body.data.id}/submit`).set(H(adminA.token)).send({})
    expect(res.status).toBe(200)
    expect(await eventsOfType(firmA.id, CONTRACT_COST_ADDED)).toHaveLength(0)
  })

  it('emits nothing when validation rejects the cost', async () => {
    const contract = await makeContract(firmA)
    const res = await request(app)
      .post(`${FINANCE_BASE}/${contract.id}/costs`)
      .set(H(adminA.token))
      .send({ category: 'TRAVEL' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await eventsOfType(firmA.id, CONTRACT_COST_ADDED)).toHaveLength(0)
    expect(await prisma.contractCost.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })
})

// =============================================================
// TIME_ENTRY_SUBMITTED
// =============================================================

describe('TIME_ENTRY_SUBMITTED', () => {
  it('emits exactly one event when a person submits time', async () => {
    const contract = await makeContract(firmA)
    const entry = await makeTime(firmA.id, contract.id)

    const res = await request(app).post(`${FINANCE_BASE}/time/${entry.id}/submit`).set(H(adminA.token)).send({})
    expect(res.status).toBe(200)

    const events = await eventsOfType(firmA.id, TIME_ENTRY_SUBMITTED)
    expect(events).toHaveLength(1)
    expect((events[0].payload as { timeEntryId: string }).timeEntryId).toBe(entry.id)
  })

  it('emits nothing when the status guard rejects the submission', async () => {
    const contract = await makeContract(firmA)
    const entry = await makeTime(firmA.id, contract.id, { status: 'APPROVED' })

    const res = await request(app).post(`${FINANCE_BASE}/time/${entry.id}/submit`).set(H(adminA.token)).send({})
    expect(res.status).toBe(409)
    expect(await eventsOfType(firmA.id, TIME_ENTRY_SUBMITTED)).toHaveLength(0)
    expect((await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('APPROVED')
  })

  it('emits nothing when a time entry is merely approved', async () => {
    const contract = await makeContract(firmA)
    const entry = await makeTime(firmA.id, contract.id, { status: 'SUBMITTED', submittedAt: new Date() })

    const res = await request(app).post(`${FINANCE_BASE}/time/${entry.id}/approve`).set(H(adminA.token)).send({})
    expect(res.status).toBe(200)
    expect(await eventsOfType(firmA.id, TIME_ENTRY_SUBMITTED)).toHaveLength(0)
  })
})

// =============================================================
// INVOICE_PAID
// =============================================================

describe('INVOICE_PAID', () => {
  it('emits exactly one event when a payment settles the invoice', async () => {
    const contract = await makeContract(firmA)
    const inv = await makeInvoice(firmA.id, contract.id)

    const res = await request(app)
      .post(`${FINANCE_BASE}/invoices/${inv.id}/payments`)
      .set(H(adminA.token))
      .send({ amount: 1000 })
    expect(res.status).toBe(201)

    const events = await eventsOfType(firmA.id, INVOICE_PAID)
    expect(events).toHaveLength(1)
    expect((events[0].payload as { invoiceId: string }).invoiceId).toBe(inv.id)
  })

  it('emits nothing for a partial payment', async () => {
    const contract = await makeContract(firmA)
    const inv = await makeInvoice(firmA.id, contract.id)

    const res = await request(app)
      .post(`${FINANCE_BASE}/invoices/${inv.id}/payments`)
      .set(H(adminA.token))
      .send({ amount: 400 })
    expect(res.status).toBe(201)
    expect((await prisma.contractInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PARTIALLY_PAID')
    expect(await eventsOfType(firmA.id, INVOICE_PAID)).toHaveLength(0)
  })

  it('emits one event on the payment that finally settles it', async () => {
    const contract = await makeContract(firmA)
    const inv = await makeInvoice(firmA.id, contract.id)
    await request(app).post(`${FINANCE_BASE}/invoices/${inv.id}/payments`).set(H(adminA.token)).send({ amount: 400 })
    await request(app).post(`${FINANCE_BASE}/invoices/${inv.id}/payments`).set(H(adminA.token)).send({ amount: 600 })
    expect(await eventsOfType(firmA.id, INVOICE_PAID)).toHaveLength(1)
  })

  it('emits nothing when the payment is rejected as an overpayment', async () => {
    const contract = await makeContract(firmA)
    const inv = await makeInvoice(firmA.id, contract.id)

    const res = await request(app)
      .post(`${FINANCE_BASE}/invoices/${inv.id}/payments`)
      .set(H(adminA.token))
      .send({ amount: 5000 })
    expect(res.status).toBe(409)
    expect(await eventsOfType(firmA.id, INVOICE_PAID)).toHaveLength(0)
    expect(await prisma.invoicePayment.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('emits nothing when the surrounding transaction rolls back', async () => {
    const contract = await makeContract(firmA)
    const inv = await makeInvoice(firmA.id, contract.id)

    await expect(prisma.$transaction(async (tx) => {
      await tx.contractInvoice.update({ where: { id: inv.id }, data: { status: 'PAID' } })
      await emitInvoicePaid(tx, {
        consultingFirmId: firmA.id, contractId: contract.id,
        invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, paymentId: 'p1',
      })
      throw new Error('rollback')
    })).rejects.toThrow('rollback')

    expect(await eventsOfType(firmA.id, INVOICE_PAID)).toHaveLength(0)
    expect((await prisma.contractInvoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('SUBMITTED')
  })

  it('treats a benign duplicate as harmless and never rolls the write back', async () => {
    const contract = await makeContract(firmA)
    const inv = await makeInvoice(firmA.id, contract.id)

    const committed = await prisma.$transaction(async (tx) => {
      const args = {
        consultingFirmId: firmA.id, contractId: contract.id,
        invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, paymentId: 'p1',
      }
      await emitInvoicePaid(tx, args)
      await emitInvoicePaid(tx, args)
      return tx.contractInvoice.update({ where: { id: inv.id }, data: { notes: 'business write survived' } })
    })

    expect(committed.notes).toBe('business write survived')
    expect(await eventsOfType(firmA.id, INVOICE_PAID)).toHaveLength(1)
  })
})

// =============================================================
// Cross-tenant and subscription
// =============================================================

describe('event isolation and subscription', () => {
  it('never leaks a finance event across a tenant boundary', async () => {
    const contract = await makeContract(firmA)
    const inv = await makeInvoice(firmA.id, contract.id)
    await request(app).post(`${FINANCE_BASE}/invoices/${inv.id}/payments`).set(H(adminA.token)).send({ amount: 1000 })

    expect(await eventsOfType(firmB.id, INVOICE_PAID)).toHaveLength(0)
    const claimed = await claimEvents('finance-event-test', 50, new Date(), { consultingFirmId: firmB.id })
    expect(claimed.some((e) => (FINANCE_EVENT_TYPES as readonly string[]).includes(e.eventType))).toBe(false)
  })

  it('routes all three events to the Finance Agent', () => {
    for (const type of FINANCE_EVENT_TYPES) {
      expect(agentsSubscribedTo(type).map((d) => d.key), type).toContain('FINANCE')
    }
  })

  it('has no subscriber for BILLING_PERIOD_CLOSED, because it does not exist', () => {
    expect(agentsSubscribedTo('BILLING_PERIOD_CLOSED')).toHaveLength(0)
  })
})

// =============================================================
// BILLING_PERIOD_CLOSED — proving the absence is real
// =============================================================

describe('billing period determination', () => {
  it('no contract billing-period close concept exists in the schema', async () => {
    // If a billing-period model or a contract billing-frequency field is ever
    // added, this test fails and the honest thing becomes emitting a real
    // event rather than deriving the period.
    const models = Object.keys(prisma).filter((k) => !k.startsWith('$') && !k.startsWith('_'))
    expect(models.filter((m) => /billingperiod/i.test(m))).toHaveLength(0)

    const contract = await makeContract(firmA)
    expect(contract).not.toHaveProperty('billingFrequency')
    expect(contract).not.toHaveProperty('billingCycle')
    expect(contract).not.toHaveProperty('billingPeriodEnd')
  })
})

// =============================================================
// The HTTP surface
// =============================================================

describe('finance agent HTTP surface', () => {
  it('exposes no endpoint that approves, submits, pays or writes anything off', async () => {
    const forbidden = [
      '/invoices/any-id/approve',
      '/invoices/any-id/submit',
      '/invoices/any-id/pay',
      '/invoices/any-id/payments',
      '/invoices/any-id/write-off',
      '/receivables/any-id/write-off',
      '/time/any-id/approve',
      '/rates/any-id/apply',
      '/wawf/submit',
      '/ipp/submit',
      '/submit',
      '/send',
    ]
    for (const path of forbidden) {
      const res = await request(app).post(`${BASE}${path}`).set(H(adminA.token)).send({})
      expect(res.status, `POST ${BASE}${path} must not exist`).toBe(404)
    }
  })

  it('returns a null status before the agent has run', async () => {
    const res = await request(app).get(`${BASE}/status`).set(H(adminA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBeNull()
    expect(res.body.data.policy.notes.length).toBeGreaterThan(0)
  })

  it('states the policy a reader can check', async () => {
    const res = await request(app).get(`${BASE}/status`).set(H(adminA.token))
    const notes = res.body.data.policy.notes.join(' ')
    expect(notes).toContain('Every invoice the agent creates is a DRAFT')
    expect(notes).toContain('A DRAFT invoice is not a receivable')
    expect(notes).toContain('not a DCAA audit, certification or approval')
    expect(notes).toContain('never derives one from a provisional rate')
    expect(notes).toContain('no opening cash balance')
  })

  it('rejects an unauthenticated request', async () => {
    expect((await request(app).get(`${BASE}/status`)).status).toBe(401)
  })
})

// =============================================================
// Actual rates — human source data
// =============================================================

describe('actual indirect rates', () => {
  const payload = {
    periodStart: '2026-01-01', periodEnd: '2026-06-30', fiscalYear: 2026,
    rateType: 'FRINGE', actualRate: '32.5000',
  }

  it('records a rate as unverified DRAFT by default', async () => {
    const res = await request(app).post(`${BASE}/actual-rates`).set(H(adminA.token)).send(payload)
    expect(res.status).toBe(201)
    expect(res.body.data.rate.status).toBe('DRAFT')
    expect(res.body.data.rate.isHumanVerified).toBe(false)
    expect(res.body.data.rate.actualRate).toBe('32.5')
  })

  it('lets an ADMIN verify it, which is a separate human act', async () => {
    const created = await request(app).post(`${BASE}/actual-rates`).set(H(adminA.token)).send(payload)
    const res = await request(app).post(`${BASE}/actual-rates/${created.body.data.rate.id}/verify`).set(H(adminA.token)).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.rate.isHumanVerified).toBe(true)
    expect(res.body.data.rate.status).toBe('FINAL')
    expect(res.body.data.rate.verifiedByUserId).toBe(adminA.id)
  })

  it('refuses a non-admin', async () => {
    expect((await request(app).post(`${BASE}/actual-rates`).set(H(consultantA.token)).send(payload)).status).toBe(403)
  })

  it('rejects a period that ends before it starts', async () => {
    const res = await request(app).post(`${BASE}/actual-rates`).set(H(adminA.token))
      .send({ ...payload, periodEnd: '2025-01-01' })
    expect(res.status).toBe(422)
  })

  it('rejects a duplicate pool and period', async () => {
    await request(app).post(`${BASE}/actual-rates`).set(H(adminA.token)).send(payload)
    expect((await request(app).post(`${BASE}/actual-rates`).set(H(adminA.token)).send(payload)).status).toBe(422)
  })

  it('never lists another firm’s rates', async () => {
    await request(app).post(`${BASE}/actual-rates`).set(H(adminA.token)).send(payload)
    const listB = await request(app).get(`${BASE}/actual-rates`).set(H(adminB.token))
    expect(listB.body.data.rates).toHaveLength(0)
  })

  it('404s when verifying another firm’s rate', async () => {
    const created = await request(app).post(`${BASE}/actual-rates`).set(H(adminA.token)).send(payload)
    const res = await request(app).post(`${BASE}/actual-rates/${created.body.data.rate.id}/verify`).set(H(adminB.token)).send({})
    expect(res.status).toBe(404)
    expect((await prisma.actualIndirectRate.findUniqueOrThrow({ where: { id: created.body.data.rate.id } })).isHumanVerified).toBe(false)
  })

  it('never returns another firm’s readiness or projections', async () => {
    const resB = await Promise.all([
      request(app).get(`${BASE}/readiness`).set(H(adminB.token)),
      request(app).get(`${BASE}/cash-flow`).set(H(adminB.token)),
    ])
    expect(resB[0].body.data.checks).toHaveLength(0)
    expect(resB[1].body.data.projections).toHaveLength(0)
  })
})

// =============================================================
// Structural: no prompts, no provider, no external submission
// =============================================================

describe('finance is deterministic by construction', () => {
  const dir = __dirname
  const sourceFiles = () => readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
  const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('imports no LLM router anywhere in the finance directory', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      expect(/from '.*llm\/llmRouter'/.test(code), file).toBe(false)
      expect(/generateWithRouter/.test(code), file).toBe(false)
    }
  })

  it('defines no system prompt constant anywhere in the finance directory', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      expect(/SYSTEM_PROMPT|systemPrompt|PROMPT_VERSION/.test(code), file).toBe(false)
    }
  })

  it('calls no external submission service', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      // Word-bounded: "skipped" contains "ipp" and is not an integration.
      expect(/\b(wawf|ipp|quickbooks|unanet|deltek)\b/i.test(code), `${file} must not reference an external finance system`).toBe(false)
      expect(/axios|fetch\(|node-fetch/.test(code), `${file} must make no network call`).toBe(false)
    }
  })

  it('never writes a payment, an approval or a submitted status', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      expect(/invoicePayment\.(create|update|delete)/.test(code), `${file} must not write a payment`).toBe(false)
      // Never MUTATES an invoice at all, and the only one it creates is DRAFT.
      expect(/contractInvoice\.(update|updateMany|delete|deleteMany|upsert)/.test(code), `${file} must not mutate an invoice`).toBe(false)
      const creates = code.match(/contractInvoice\.create\(\{[\s\S]{0,400}?status:[^,\n]+/g) ?? []
      for (const c of creates) {
        expect(c.includes('AGENT_INVOICE_STATUS'), `${file}: an agent invoice must be created with AGENT_INVOICE_STATUS`).toBe(true)
      }
    }
  })

  it('never updates a time entry', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      // The only permitted timeEntry write is stamping invoicedInvoiceId, which
      // is the canonical double-invoicing guard and touches nothing a person
      // recorded.
      const writes = code.match(/timeEntry\.update\w*\([\s\S]{0,200}?\)/g) ?? []
      for (const w of writes) {
        expect(w.includes('invoicedInvoiceId'), `${file}: ${w}`).toBe(true)
        expect(/hours|status|laborCategory|workDate|approverUserId/.test(w), `${file}: ${w}`).toBe(false)
      }
    }
  })

  it('never writes an actual indirect rate', () => {
    for (const file of sourceFiles()) {
      const code = strip(readFileSync(join(dir, file), 'utf8'))
      expect(/actualIndirectRate\.(create|update|upsert|delete)/.test(code), `${file} must not write an actual rate`).toBe(false)
    }
  })
})
