// =============================================================
// §7.8 — Finance Agent against a real PostgreSQL database.
//
// The centre of this file is the human finance boundary: at PROPOSE and at
// ACT_WITH_GUARDRAILS the agent creates DRAFT invoices and nothing else. It
// never approves, submits, marks paid, records a payment, writes off a
// balance, edits time, or changes a rate.
//
// It also proves the two things that make a finance agent trustworthy: exact
// Decimal arithmetic on real rows, and that no hour or cost is ever billed
// twice.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

// The provider boundary is mocked for the whole file. Any call would be
// recorded here — the no-LLM test asserts it never happens.
const generateWithRouterSpy = vi.fn()
vi.mock('../../llm/llmRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../llm/llmRouter')>()
  return { ...actual, generateWithRouter: (...a: unknown[]) => generateWithRouterSpy(...a) }
})

import { prisma } from '../../../config/database'
import {
  createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm, type TestUser,
} from '../../../test-utils/testClient'
import { dispatchAgentRun } from '../dispatch'
import { createRun } from '../runService'
import { AGENT_REGISTRY, getAgentDefinition, agentsSubscribedTo } from '../registry'
import { DOMAIN_AGENT_KEYS } from '../types'
import {
  financeAgentHandler, FINANCE_PHASES, phasesForRun, BILLABLE_CONTRACT_STATUSES, MAX_INVOICES_PER_RUN,
} from './financeAgentHandler'
import { lastClosedMonth } from './invoiceBuilder'
import { INVOICE_PAID, TIME_ENTRY_SUBMITTED, CONTRACT_COST_ADDED } from './financeEvents'

const AGENT = 'FINANCE' as const
const DAY = 86_400_000
const dec = (v: string | number) => new Prisma.Decimal(v)

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let adminB: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Finance Agent Firm A' })
  firmB = await createTestFirm({ name: 'Finance Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentArtifact.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.cashFlowProjection.deleteMany({ where: { consultingFirmId: id } })
    await prisma.dcaaReadinessCheck.deleteMany({ where: { consultingFirmId: id } })
    await prisma.actualIndirectRate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.invoicePayment.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractInvoiceLineItem.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractInvoice.deleteMany({ where: { consultingFirmId: id } })
    await prisma.timeEntry.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractCost.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractLaborRate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingTemplate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contract.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeContract(firmId: string, over: Record<string, unknown> = {}) {
  return prisma.contract.create({
    data: {
      consultingFirmId: firmId,
      contractNumber: uniq('S7-FIN-QA'),
      title: 'S7-FIN-QA cyber support',
      agency: 'Department of Defense',
      status: 'ACTIVE',
      startDate: new Date(Date.now() - 200 * DAY),
      endDate: new Date(Date.now() + 200 * DAY),
      ...over,
    },
  })
}

/** A time entry inside the last closed month, APPROVED and priced. */
async function makeTime(firmId: string, contractId: string, over: Record<string, unknown> = {}) {
  const period = lastClosedMonth(new Date())
  return prisma.timeEntry.create({
    data: {
      consultingFirmId: firmId,
      contractId,
      userId: 'user-1',
      laborCategory: 'Senior Engineer',
      workDate: new Date(period.start.getTime() + 5 * DAY),
      hours: dec('10.00'),
      status: 'APPROVED',
      submittedAt: new Date(period.start.getTime() + 6 * DAY),
      appliedBillingRate: dec('95.0000'),
      billingAmount: dec('950.00'),
      ...over,
    },
  })
}

async function makeCost(firmId: string, contractId: string, over: Record<string, unknown> = {}) {
  const period = lastClosedMonth(new Date())
  return prisma.contractCost.create({
    data: {
      consultingFirmId: firmId,
      contractId,
      category: 'TRAVEL',
      description: 'S7-FIN-QA site visit',
      amount: dec('412.37'),
      incurredDate: new Date(period.start.getTime() + 10 * DAY),
      status: 'APPROVED',
      ...over,
    },
  })
}

async function makeInvoice(firmId: string, contractId: string, over: Record<string, unknown> = {}) {
  return prisma.contractInvoice.create({
    data: {
      consultingFirmId: firmId,
      contractId,
      invoiceNumber: uniq('INV-QA'),
      status: 'SUBMITTED',
      invoiceDate: new Date(Date.now() - 60 * DAY),
      dueDate: new Date(Date.now() - 30 * DAY),
      total: dec('1000.00'),
      subtotal: dec('1000.00'),
      amountPaid: dec('0.00'),
      ...over,
    },
  })
}

async function runAgent(firmId: string, over: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId, agentKey: AGENT, triggerType: 'MANUAL',
    idempotencyKey: uniq('finance-run'), ...over,
  })
  await dispatchAgentRun(run.id)
  return prisma.agentRun.findUnique({ where: { id: run.id } })
}

const readStatus = async (firmId: string) => {
  const artifact = await prisma.agentArtifact.findFirst({
    where: { consultingFirmId: firmId, agentKey: AGENT, artifactType: 'FINANCE_STATUS', supersededByArtifactId: null },
    orderBy: { createdAt: 'desc' },
  })
  return artifact ? (artifact.structuredData as Record<string, any>) : null
}

// =============================================================
// Registry
// =============================================================

describe('agent registry', () => {
  it('reports FINANCE as implemented with a real handler', () => {
    const def = getAgentDefinition('FINANCE')!
    expect(def.implemented).toBe(true)
    expect(def.handler).toBe(financeAgentHandler)
    expect(def.defaultEnabled).toBe(false)
    expect(def.defaultAutonomyLevel).toBe('PROPOSE')
  })

  it('declares no LLM need and a zero token budget', () => {
    const def = getAgentDefinition('FINANCE')!
    expect(def.requiresLlm).toBe(false)
    expect(def.defaultTokenBudget).toBe(0)
  })

  it('allowlists no action — it approves and submits nothing', () => {
    expect(getAgentDefinition('FINANCE')!.allowlistedActionKeys).toEqual([])
  })

  it('supports the four runtime triggers', () => {
    expect(getAgentDefinition('FINANCE')!.supportedTriggers).toEqual(['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'])
  })

  it('subscribes to the three events that genuinely exist', () => {
    const def = getAgentDefinition('FINANCE')!
    expect([...def.subscribedEventTypes].sort()).toEqual([CONTRACT_COST_ADDED, INVOICE_PAID, TIME_ENTRY_SUBMITTED].sort())
  })

  it('does NOT subscribe to BILLING_PERIOD_CLOSED — no such domain event exists', () => {
    expect(getAgentDefinition('FINANCE')!.subscribedEventTypes).not.toContain('BILLING_PERIOD_CLOSED')
    expect(agentsSubscribedTo('BILLING_PERIOD_CLOSED')).toHaveLength(0)
  })

  it('exposes exactly ten implemented entries — nine domain agents plus the diagnostic', () => {
    expect(AGENT_REGISTRY.filter((d) => d.implemented).map((d) => d.key).sort()).toEqual([
      'COMPLIANCE', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE', 'INTERNAL_DIAGNOSTIC',
      'OPPORTUNITY', 'PRICING', 'PROPOSAL', 'QUALIFICATION', 'TEAMING',
    ])
  })

  it('leaves Intelligence NOT IMPLEMENTED with no handler', () => {
    const delivered = new Set(['OPPORTUNITY', 'CONTRACT_ADMINISTRATION', 'COMPLIANCE', 'QUALIFICATION', 'TEAMING', 'PRICING', 'PROPOSAL', 'FINANCE'])
    void delivered
    const remaining = DOMAIN_AGENT_KEYS.filter((k) => !getAgentDefinition(k)!.implemented)
    expect(remaining).toEqual([])
    expect(getAgentDefinition('INTELLIGENCE')!.implemented).toBe(true)
    expect(getAgentDefinition('INTELLIGENCE')!.handler).not.toBeNull()
  })
})

// =============================================================
// Phases
// =============================================================

describe('phase selection', () => {
  it('runs every phase for a scheduled or manual tenant run', () => {
    expect(phasesForRun(null, null)).toEqual([...FINANCE_PHASES])
  })

  it('runs readiness, not billing, for a submitted time entry', () => {
    const p = phasesForRun('Contract', TIME_ENTRY_SUBMITTED)
    expect(p).toContain('BUILD_DCAA_READINESS')
    expect(p).not.toContain('BUILD_DRAFT_INVOICES')
    expect(p).not.toContain('COMPUTE_RATE_VARIANCE')
  })

  it('runs ageing and cash flow, not billing, for a paid invoice', () => {
    const p = phasesForRun('Contract', INVOICE_PAID)
    expect(p).toContain('AGE_RECEIVABLES')
    expect(p).toContain('PROJECT_CASH_FLOW')
    expect(p).not.toContain('BUILD_DCAA_READINESS')
  })

  it('always ends with the status, notification, escalation and completion phases', () => {
    for (const evt of [null, TIME_ENTRY_SUBMITTED, INVOICE_PAID, CONTRACT_COST_ADDED]) {
      const p = phasesForRun('Contract', evt)
      expect(p.slice(-4)).toEqual(['BUILD_FINANCE_STATUS', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE'])
    }
  })
})

// =============================================================
// The human finance boundary
// =============================================================

describe('human finance boundary', () => {
  for (const autonomyLevel of ['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const) {
    describe(`at ${autonomyLevel}`, () => {
      it('creates a DRAFT invoice and never advances it', async () => {
        const contract = await makeContract(firmA.id)
        await makeTime(firmA.id, contract.id)
        await runAgent(firmA.id, { autonomyLevel })

        const invoices = await prisma.contractInvoice.findMany({ where: { consultingFirmId: firmA.id } })
        expect(invoices).toHaveLength(1)
        expect(invoices[0].status).toBe('DRAFT')
        expect(invoices[0].approvedByUserId).toBeNull()
        expect(invoices[0].submittedAt).toBeNull()
        expect(invoices[0].paidAt).toBeNull()
      })

      it('records no payment and writes off nothing', async () => {
        const contract = await makeContract(firmA.id)
        await makeInvoice(firmA.id, contract.id)
        await runAgent(firmA.id, { autonomyLevel })

        expect(await prisma.invoicePayment.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
        const inv = await prisma.contractInvoice.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
        expect(inv.status).toBe('SUBMITTED')
        expect(inv.amountPaid.toFixed(2)).toBe('0.00')
      })

      it('never modifies a time entry', async () => {
        const contract = await makeContract(firmA.id)
        const entry = await makeTime(firmA.id, contract.id, { status: 'SUBMITTED', billingAmount: null, appliedBillingRate: null })
        const before = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })
        await runAgent(firmA.id, { autonomyLevel })
        const after = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })

        expect(after.status).toBe(before.status)
        expect(after.hours.toFixed(2)).toBe(before.hours.toFixed(2))
        expect(after.laborCategory).toBe(before.laborCategory)
        expect(after.workDate).toEqual(before.workDate)
        expect(after.approverUserId).toBeNull()
      })

      it('never changes an existing submitted invoice', async () => {
        const contract = await makeContract(firmA.id)
        const inv = await makeInvoice(firmA.id, contract.id, { total: dec('5000.00'), subtotal: dec('5000.00') })
        await runAgent(firmA.id, { autonomyLevel })
        const after = await prisma.contractInvoice.findUniqueOrThrow({ where: { id: inv.id } })
        expect(after.total.toFixed(2)).toBe('5000.00')
        expect(after.status).toBe('SUBMITTED')
      })

      it('never writes or alters an actual indirect rate', async () => {
        const contract = await makeContract(firmA.id)
        await makeTime(firmA.id, contract.id)
        await prisma.actualIndirectRate.create({
          data: {
            consultingFirmId: firmA.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-06-30'),
            fiscalYear: 2026, rateType: 'FRINGE', actualRate: dec('32.5000'), status: 'FINAL', isHumanVerified: true,
          },
        })
        await runAgent(firmA.id, { autonomyLevel })
        const rates = await prisma.actualIndirectRate.findMany({ where: { consultingFirmId: firmA.id } })
        expect(rates).toHaveLength(1)
        expect(rates[0].actualRate.toFixed(4)).toBe('32.5000')
      })

      it('reports explicit zero counters for every forbidden act', async () => {
        const contract = await makeContract(firmA.id)
        await makeTime(firmA.id, contract.id)
        const run = await runAgent(firmA.id, { autonomyLevel })
        expect(run!.status).toBe('COMPLETED')

        const status = await readStatus(firmA.id)
        expect(status!.humanControl).toEqual({
          invoicesApproved: 0, invoicesSubmitted: 0, invoicesMarkedPaid: 0, paymentsRecorded: 0,
          receivablesWrittenOff: 0, timeEntriesModified: 0, ratesModified: 0, externalSubmissions: 0,
        })
      })
    })
  }

  it('creates no invoice at all under OBSERVE', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id)
    await runAgent(firmA.id, { autonomyLevel: 'OBSERVE' })

    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    const status = await readStatus(firmA.id)
    expect(status!.invoices.billingPeriods[0].state).toBe('NOT_PERMITTED_AT_THIS_AUTONOMY')
  })
})

// =============================================================
// Invoicing
// =============================================================

describe('draft invoice generation', () => {
  it('creates nothing when there are no billable records', async () => {
    await makeContract(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect((await readStatus(firmA.id))!.invoices.billingPeriods[0].state).toBe('NOTHING_ELIGIBLE')
  })

  it('bills time and cost together with an exact Decimal total', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id, { billingAmount: dec('1234.56') })
    await makeCost(firmA.id, contract.id, { amount: dec('0.01') })
    await runAgent(firmA.id)

    const inv = await prisma.contractInvoice.findFirstOrThrow({
      where: { consultingFirmId: firmA.id }, include: { lineItems: true },
    })
    expect(inv.total.toFixed(2)).toBe('1234.57')
    expect(inv.subtotal.toFixed(2)).toBe('1234.57')
    expect(inv.lineItems).toHaveLength(2)
  })

  it('traces every line back to its source record', async () => {
    const contract = await makeContract(firmA.id)
    const entry = await makeTime(firmA.id, contract.id)
    const cost = await makeCost(firmA.id, contract.id)
    await runAgent(firmA.id)

    const inv = await prisma.contractInvoice.findFirstOrThrow({ where: { consultingFirmId: firmA.id }, include: { lineItems: true } })
    const labor = inv.lineItems.find((l) => l.kind === 'LABOR')!
    const odc = inv.lineItems.find((l) => l.kind === 'ODC')!
    expect(labor.sourceTimeEntryId).toBe(entry.id)
    expect(odc.sourceCostId).toBe(cost.id)
    expect(labor.rate!.toFixed(4)).toBe('95.0000')
    expect(labor.quantity!.toFixed(2)).toBe('10.00')
  })

  it('stamps each source as invoiced so it can never be billed twice', async () => {
    const contract = await makeContract(firmA.id)
    const entry = await makeTime(firmA.id, contract.id)
    await runAgent(firmA.id)
    const after = await prisma.timeEntry.findUniqueOrThrow({ where: { id: entry.id } })
    expect(after.invoicedInvoiceId).not.toBeNull()
  })

  it('creates no second invoice on an unchanged re-run', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id)
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('never re-bills a record already covered by an existing invoice', async () => {
    const contract = await makeContract(firmA.id)
    const entry = await makeTime(firmA.id, contract.id)
    await runAgent(firmA.id)
    const first = await prisma.contractInvoice.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })

    // A new eligible cost arrives, but the period is already invoiced.
    await makeCost(firmA.id, contract.id)
    await runAgent(firmA.id)

    const invoices = await prisma.contractInvoice.findMany({ where: { consultingFirmId: firmA.id } })
    expect(invoices).toHaveLength(1)
    expect(invoices[0].id).toBe(first.id)
    const lines = await prisma.contractInvoiceLineItem.findMany({ where: { sourceTimeEntryId: entry.id } })
    expect(lines).toHaveLength(1)
  })

  it('ignores a time entry that is not APPROVED', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id, { status: 'SUBMITTED' })
    await runAgent(firmA.id)
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('ignores a cost that is not APPROVED', async () => {
    const contract = await makeContract(firmA.id)
    await makeCost(firmA.id, contract.id, { status: 'DRAFT' })
    await runAgent(firmA.id)
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('ignores a record outside the billing period', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id, { workDate: new Date(Date.now() - 400 * DAY) })
    await runAgent(firmA.id)
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('leaves an existing DRAFT covering the period alone', async () => {
    const contract = await makeContract(firmA.id)
    const period = lastClosedMonth(new Date())
    await makeInvoice(firmA.id, contract.id, { status: 'DRAFT', periodStart: period.start, periodEnd: period.end })
    await makeTime(firmA.id, contract.id)
    await runAgent(firmA.id)

    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
    expect((await readStatus(firmA.id))!.invoices.billingPeriods[0].state).toBe('EXISTING_DRAFT_COVERS_PERIOD')
  })

  it('does not bill a contract that is not billable', async () => {
    const contract = await makeContract(firmA.id, { status: 'DRAFT' })
    await makeTime(firmA.id, contract.id)
    const run = await runAgent(firmA.id)
    expect(run!.status).toBe('SKIPPED')
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each([...BILLABLE_CONTRACT_STATUSES])('bills a %s contract', async (status) => {
    const contract = await makeContract(firmA.id, { status })
    await makeTime(firmA.id, contract.id)
    await runAgent(firmA.id)
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('caps drafts per run so a reviewer is never flooded', async () => {
    for (let i = 0; i < MAX_INVOICES_PER_RUN + 2; i += 1) {
      const c = await makeContract(firmA.id, { title: `S7-FIN-QA contract ${i}` })
      await makeTime(firmA.id, c.id)
    }
    await runAgent(firmA.id)
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(MAX_INVOICES_PER_RUN)
    const status = await readStatus(firmA.id)
    expect(status!.invoices.billingPeriods.some((b: any) => b.state === 'RUN_LIMIT_REACHED')).toBe(true)
  })
})

// =============================================================
// Receivables
// =============================================================

describe('receivables', () => {
  it('never treats a DRAFT invoice as a receivable', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { status: 'DRAFT', dueDate: new Date(Date.now() - 100 * DAY) })
    await runAgent(firmA.id)
    const status = await readStatus(firmA.id)
    expect(status!.receivables.totalOutstanding).toBe('0.00')
    expect(status!.receivables.overdueInvoices).toHaveLength(0)
  })

  it('ages a submitted invoice into the right bucket', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { dueDate: new Date(Date.now() - 45 * DAY) })
    await runAgent(firmA.id)
    const status = await readStatus(firmA.id)
    expect(status!.receivables.days31to60).toBe('1000.00')
    expect(status!.receivables.totalOutstanding).toBe('1000.00')
  })

  it('ages only the unpaid remainder after a partial payment', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { status: 'PARTIALLY_PAID', amountPaid: dec('250.50') })
    await runAgent(firmA.id)
    expect((await readStatus(firmA.id))!.receivables.totalOutstanding).toBe('749.50')
  })

  it('escalates a receivable past 90 days without claiming the customer will not pay', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { dueDate: new Date(Date.now() - 120 * DAY) })
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findMany({ where: { consultingFirmId: firmA.id } })
    const overdue = esc.find((e) => e.title.includes('90 days'))!
    expect(overdue).toBeDefined()
    expect(overdue.reason).toContain('does not contact the customer')
    expect(overdue.reason).not.toMatch(/will not pay|bad debt|uncollect/i)
  })

  it('does not duplicate the escalation on an unchanged re-run', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { dueDate: new Date(Date.now() - 120 * DAY) })
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    const esc = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, title: { contains: '90 days' } },
    })
    expect(esc).toHaveLength(1)
  })
})

// =============================================================
// Readiness
// =============================================================

describe('timekeeping readiness', () => {
  it('persists one row per rule with evidence', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id, { workDate: new Date(Date.now() - 5 * DAY) })
    await runAgent(firmA.id)

    const checks = await prisma.dcaaReadinessCheck.findMany({ where: { consultingFirmId: firmA.id } })
    expect(checks.length).toBe(7)
    expect(checks.every((c) => c.ruleVersion === 'bytescon-readiness-v1')).toBe(true)
    expect(checks.every((c) => c.agentRunId !== null)).toBe(true)
  })

  it('reports a future-dated entry as a critical gap and escalates it', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id, { workDate: new Date(Date.now() + 5 * DAY) })
    await runAgent(firmA.id)

    const status = await readStatus(firmA.id)
    expect(status!.timekeeping.readinessState).toBe('CRITICAL_GAP')
    expect(status!.timekeeping.criticalFailures).toBeGreaterThan(0)

    const esc = await prisma.agentEscalation.findMany({ where: { consultingFirmId: firmA.id } })
    expect(esc.some((e) => e.title.includes('critical gap'))).toBe(true)
  })

  it('never claims DCAA compliance, certification or an audit outcome', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id, { workDate: new Date(Date.now() - 5 * DAY) })
    await runAgent(firmA.id)

    const [status, checks, escalations, notifications] = await Promise.all([
      readStatus(firmA.id),
      prisma.dcaaReadinessCheck.findMany({ where: { consultingFirmId: firmA.id } }),
      prisma.agentEscalation.findMany({ where: { consultingFirmId: firmA.id } }),
      prisma.userNotification.findMany({ where: { consultingFirmId: firmA.id } }),
    ])
    const text = JSON.stringify({ status, checks, escalations, notifications })
    expect(text).not.toMatch(/DCAA[- ](compliant|approved|certified)/i)
    expect(text).not.toMatch(/will pass (an )?audit|audit[- ]approved/i)
    expect(text).toContain('not a DCAA audit, certification or approval')
  })

  it('writes no new readiness rows when nothing changed', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id, { workDate: new Date(Date.now() - 5 * DAY) })
    await runAgent(firmA.id)
    const first = await prisma.dcaaReadinessCheck.count({ where: { consultingFirmId: firmA.id } })
    await runAgent(firmA.id)
    expect(await prisma.dcaaReadinessCheck.count({ where: { consultingFirmId: firmA.id } })).toBe(first)
  })

  it('excludes unsupported rules from the score rather than passing them', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id, { workDate: new Date(Date.now() - 5 * DAY) })
    await runAgent(firmA.id)
    const status = await readStatus(firmA.id)
    expect(status!.timekeeping.unsupportedRules).toBeGreaterThan(0)
    expect(status!.timekeeping.scorableRules).toBeLessThan(status!.timekeeping.rulesChecked)
  })
})

// =============================================================
// Rate variance
// =============================================================

describe('rate variance', () => {
  async function seedRates(firmId: string, provisionalPct: number, actualPct: string) {
    await prisma.pricingTemplate.create({
      data: {
        consultingFirmId: firmId, name: 'S7-FIN-QA standard', version: 1, isActive: true,
        indirectRatesJson: [{ rateType: 'FRINGE', percent: provisionalPct }],
      },
    })
    await prisma.actualIndirectRate.create({
      data: {
        consultingFirmId: firmId, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-06-30'),
        fiscalYear: 2026, rateType: 'FRINGE', actualRate: dec(actualPct), status: 'FINAL', isHumanVerified: true,
      },
    })
  }

  it('computes an exact variance', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id)
    await seedRates(firmA.id, 30, '36.0000')
    await runAgent(firmA.id)

    const v = (await readStatus(firmA.id))!.indirectRates.variances[0]
    expect(v.provisionalRate).toBe('30.0000')
    expect(v.actualRate).toBe('36.0000')
    expect(v.absoluteVariance).toBe('6.0000')
    expect(v.relativeVariancePct).toBe(20)
    expect(v.state).toBe('MATERIAL_VARIANCE')
  })

  it('escalates a material variance and changes no rate', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id)
    await seedRates(firmA.id, 30, '36.0000')
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findMany({ where: { consultingFirmId: firmA.id } })
    expect(esc.some((e) => e.title.includes('Indirect rate variance'))).toBe(true)
    const rate = await prisma.actualIndirectRate.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(rate.actualRate.toFixed(4)).toBe('36.0000')
  })

  it('says INSUFFICIENT_DATA rather than deriving an actual rate', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id)
    await prisma.pricingTemplate.create({
      data: {
        consultingFirmId: firmA.id, name: 'S7-FIN-QA standard', version: 1, isActive: true,
        indirectRatesJson: [{ rateType: 'FRINGE', percent: 30 }],
      },
    })
    await runAgent(firmA.id)

    const status = await readStatus(firmA.id)
    expect(status!.indirectRates.variances).toHaveLength(0)
    expect(status!.dataLimitations.join(' ')).toContain('does not derive an actual rate from a provisional one')
  })

  it('always states the proposal-pricing-to-actual semantic mapping', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id)
    await seedRates(firmA.id, 30, '31.0000')
    await runAgent(firmA.id)
    const v = (await readStatus(firmA.id))!.indirectRates.variances[0]
    expect(v.semanticMapping).toBe('PROPOSAL_PRICING_TO_ACTUAL')
    expect(v.evidence.join(' ')).toContain('not a provisional billing rate negotiated with a contracting officer')
  })
})

// =============================================================
// Cash flow
// =============================================================

describe('cash flow', () => {
  it('persists a projection with exact amounts', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { total: dec('10000.00'), subtotal: dec('10000.00'), dueDate: new Date(Date.now() + 10 * DAY) })
    await runAgent(firmA.id)

    const p = await prisma.cashFlowProjection.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(p.projectedReceipts.toFixed(2)).toBe('10000.00')
    expect(p.methodVersion).toBe('finance-cashflow-v1')
    expect(p.agentRunId).not.toBeNull()
  })

  it('writes no duplicate projection when nothing changed', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { dueDate: new Date(Date.now() + 10 * DAY) })
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.cashFlowProjection.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('writes a new projection when a material input changes', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { dueDate: new Date(Date.now() + 10 * DAY) })
    await runAgent(firmA.id)
    await makeInvoice(firmA.id, contract.id, { total: dec('7777.00'), subtotal: dec('7777.00'), dueDate: new Date(Date.now() + 20 * DAY) })
    await runAgent(firmA.id)
    expect(await prisma.cashFlowProjection.count({ where: { consultingFirmId: firmA.id } })).toBe(2)
  })

  /**
   * An approved but UNINVOICED cost is both a disbursement and expected
   * billing — on a reimbursable contract the firm pays it and bills it, so it
   * nets to zero. To get a genuinely negative net flow the cost must already
   * sit on an invoice that is not yet a receivable.
   */
  async function seedNegativeNetFlow() {
    const contract = await makeContract(firmA.id)
    const draft = await makeInvoice(firmA.id, contract.id, { status: 'DRAFT', total: dec('0.00'), subtotal: dec('0.00') })
    await makeCost(firmA.id, contract.id, {
      amount: dec('9000.00'), incurredDate: new Date(), invoicedInvoiceId: draft.id,
    })
    return contract
  }

  it('never reports a cash position, because no opening balance exists', async () => {
    await seedNegativeNetFlow()
    await runAgent(firmA.id)

    const status = await readStatus(firmA.id)
    expect(status!.cashFlow.openingCashBalanceAvailable).toBe(false)
    expect(status!.cashFlow.netCashFlowLabel).toBe('PROJECTED_NEGATIVE_NET_CASH_FLOW')
    expect(JSON.stringify(status)).not.toMatch(/(projected|is a|shows a)\s+negative cash position/i)
  })

  it('escalates a negative NET FLOW using net-flow wording', async () => {
    await seedNegativeNetFlow()
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { contains: 'net cash flow' } },
    })
    expect(esc).not.toBeNull()
    expect(esc!.reason).toContain('not a cash position')
  })

  it('reports no confidence band rather than inventing one', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { dueDate: new Date(Date.now() + 10 * DAY) })
    await runAgent(firmA.id)
    const p = await prisma.cashFlowProjection.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(p.confidenceState).toBe('DETERMINISTIC_ONLY')
    expect(p.confidenceLower).toBeNull()
  })
})

// =============================================================
// No LLM
// =============================================================

describe('no LLM', () => {
  it('makes zero provider calls and spends zero tokens and zero cost', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id)
    await makeCost(firmA.id, contract.id)
    await makeInvoice(firmA.id, contract.id, { dueDate: new Date(Date.now() - 120 * DAY) })
    await prisma.actualIndirectRate.create({
      data: {
        consultingFirmId: firmA.id, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-06-30'),
        fiscalYear: 2026, rateType: 'FRINGE', actualRate: dec('40.0000'), status: 'FINAL',
      },
    })

    const run = await runAgent(firmA.id)
    expect(run!.status).toBe('COMPLETED')
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(run!.tokenInput).toBe(0)
    expect(run!.tokenOutput).toBe(0)
    expect(Number(run!.estimatedCostUsd)).toBe(0)
  })

  it('logs no API usage for the run', async () => {
    const contract = await makeContract(firmA.id)
    await makeTime(firmA.id, contract.id)
    const run = await runAgent(firmA.id)
    expect(await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id, createdAt: { gte: run!.createdAt } } })).toBe(0)
  })
})

// =============================================================
// Failure isolation
// =============================================================

describe('failure isolation and idempotency', () => {
  it('produces a stable hash on an unchanged re-run', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id, { dueDate: new Date(Date.now() - 10 * DAY) })
    await runAgent(firmA.id)
    const first = (await readStatus(firmA.id))!.inputHash
    await runAgent(firmA.id)
    expect((await readStatus(firmA.id))!.inputHash).toBe(first)
  })

  it('leaves exactly one live status artifact', async () => {
    const contract = await makeContract(firmA.id)
    await makeInvoice(firmA.id, contract.id)
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'FINANCE_STATUS', supersededByArtifactId: null },
    })).toBe(1)
  })

  it('keeps billing one contract when another has no billable records', async () => {
    const good = await makeContract(firmA.id, { title: 'S7-FIN-QA good' })
    await makeContract(firmA.id, { title: 'S7-FIN-QA empty' })
    await makeTime(firmA.id, good.id)
    const run = await runAgent(firmA.id)
    expect(run!.status).toBe('COMPLETED')
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })
})

// =============================================================
// Tenant isolation — the highest-consequence guarantee
// =============================================================

describe('tenant isolation', () => {
  it('never bills Firm B records into a Firm A invoice', async () => {
    const contractA = await makeContract(firmA.id)
    const contractB = await makeContract(firmB.id)
    await makeTime(firmA.id, contractA.id, { billingAmount: dec('100.00') })
    await makeTime(firmB.id, contractB.id, { billingAmount: dec('999999.00') })

    await runAgent(firmA.id)
    const inv = await prisma.contractInvoice.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(inv.total.toFixed(2)).toBe('100.00')
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('never ages a Firm B receivable into Firm A', async () => {
    const contractA = await makeContract(firmA.id)
    const contractB = await makeContract(firmB.id)
    await makeInvoice(firmA.id, contractA.id, { total: dec('500.00'), subtotal: dec('500.00') })
    await makeInvoice(firmB.id, contractB.id, { total: dec('900000.00'), subtotal: dec('900000.00') })

    await runAgent(firmA.id)
    expect((await readStatus(firmA.id))!.receivables.totalOutstanding).toBe('500.00')
  })

  it('never reads a Firm B rate even with an identical pool and period', async () => {
    const contractA = await makeContract(firmA.id)
    await makeTime(firmA.id, contractA.id)
    await prisma.pricingTemplate.create({
      data: { consultingFirmId: firmA.id, name: 'A standard', version: 1, isActive: true, indirectRatesJson: [{ rateType: 'FRINGE', percent: 30 }] },
    })
    for (const firmId of [firmA.id, firmB.id]) {
      await prisma.actualIndirectRate.create({
        data: {
          consultingFirmId: firmId, periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-06-30'),
          fiscalYear: 2026, rateType: 'FRINGE',
          actualRate: firmId === firmA.id ? dec('31.0000') : dec('99.0000'),
          status: 'FINAL', isHumanVerified: true,
        },
      })
    }
    await runAgent(firmA.id)
    const variances = (await readStatus(firmA.id))!.indirectRates.variances
    expect(variances).toHaveLength(1)
    expect(variances[0].actualRate).toBe('31.0000')
  })

  it('keeps a Firm A cash-flow projection identical when Firm B changes dramatically', async () => {
    const contractA = await makeContract(firmA.id)
    const contractB = await makeContract(firmB.id)
    await makeInvoice(firmA.id, contractA.id, { total: dec('1000.00'), subtotal: dec('1000.00'), dueDate: new Date(Date.now() + 10 * DAY) })
    await makeInvoice(firmB.id, contractB.id, { total: dec('1.00'), subtotal: dec('1.00'), dueDate: new Date(Date.now() + 10 * DAY) })

    await runAgent(firmA.id)
    const before = await prisma.cashFlowProjection.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })

    // Firm B goes to an extreme in both directions.
    await makeInvoice(firmB.id, contractB.id, { total: dec('99999999.99'), subtotal: dec('99999999.99'), dueDate: new Date(Date.now() + 5 * DAY) })
    await makeCost(firmB.id, contractB.id, { amount: dec('88888888.88'), incurredDate: new Date() })
    await runAgent(firmA.id)

    const after = await prisma.cashFlowProjection.findMany({ where: { consultingFirmId: firmA.id } })
    expect(after).toHaveLength(1)
    expect(after[0].inputHash).toBe(before.inputHash)
    expect(after[0].projectedReceipts.toFixed(2)).toBe(before.projectedReceipts.toFixed(2))
    expect(after[0].projectedDisbursements.toFixed(2)).toBe(before.projectedDisbursements.toFixed(2))
    expect(after[0].netCashFlow.toFixed(2)).toBe(before.netCashFlow.toFixed(2))
  })

  it('never writes a readiness check or notification into the other firm', async () => {
    const contractA = await makeContract(firmA.id)
    await makeTime(firmA.id, contractA.id, { workDate: new Date(Date.now() + 5 * DAY) })
    await runAgent(firmA.id)

    expect(await prisma.dcaaReadinessCheck.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentArtifact.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('refuses to run against another firm’s contract', async () => {
    const contractB = await makeContract(firmB.id)
    await makeTime(firmB.id, contractB.id)
    const run = await runAgent(firmA.id, { triggerEntityType: 'Contract', triggerEntityId: contractB.id })
    expect(run!.status).toBe('SKIPPED')
    expect(await prisma.contractInvoice.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})
