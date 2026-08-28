// =============================================================
// §8 FINAL ACCEPTANCE — one contractor's life, end to end.
//
// The slices were each verified alone. This suite asks the different question:
// do the HANDOFFS work? A CRM contact becomes an opportunity becomes a pursuit
// becomes a proposal becomes a contract becomes a budget becomes a subcontract
// becomes a cost becomes a receivable becomes an accounting export — and at
// every seam the number, the tenant and the human gate must survive.
//
// Every human gate is stopped at explicitly and proven CLOSED before it is
// opened by a person. That is the property the whole platform sells.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { IntegrationProvider, IntegrationStatus, Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'
import { upsertConnection } from '../services/integrations/connectionService'
import {
  __setAccountingConnector, exportDocument, buildInvoicePayload,
} from '../services/integrations/accounting/syncService'
import { __setCalendarAdapter, syncCalendarEvent } from '../services/integrations/calendar/calendarSync'
import { computeBudgetVsActual } from '../services/erp/budgetVsActual'
import { computeContractFinancialSummary } from '../services/erp/financialSummary'
import { recognizedExpenditure } from '../services/contractFinance'

const QA = 'S8-FINAL-QA-'
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const PASSWORD = 'a-very-strong-password-1'

let app: Express
let firm: TestFirm
let admin: TestUser, finance: TestUser, contracts: TestUser, proposalUser: TestUser
let agencyOfficeId = '', contactId = '', opportunityId = '', pursuitId = ''
let partnerId = '', contractId = '', budgetId = '', poId = ''
let personnelId = '', resumeId = '', proposalId = ''
let partnerPortalUserId = '', partnerToken = ''
let subcontractInvoiceId = '', contractInvoiceId = ''

let exportCalls = 0
const mockAccounting = {
  provider: IntegrationProvider.QUICKBOOKS,
  async testConnection() { return { ok: true, accountName: 'mock', detail: 'mock' } },
  async exportDocument(_c: unknown, p: { documentNumber: string }) {
    exportCalls += 1
    return { externalId: `${QA}EXT-${p.documentNumber}`, externalType: 'Invoice', deduped: false }
  },
  async fetchPayments() { return [] },
}

let calendarCreates = 0
const mockCalendar = {
  provider: IntegrationProvider.GOOGLE_CALENDAR,
  async testConnection() { return { ok: true, detail: 'mock' } },
  async createEvent() { calendarCreates += 1; return { externalId: `${QA}EVT-${calendarCreates}` } },
  async updateEvent() { /* recorded by the ledger */ },
  async deleteEvent() { /* recorded by the ledger */ },
}

beforeAll(async () => {
  app = buildTestApp()
  __setAccountingConnector(IntegrationProvider.QUICKBOOKS, mockAccounting as never)
  __setCalendarAdapter(IntegrationProvider.GOOGLE_CALENDAR, mockCalendar as never)

  firm = await createTestFirm({ name: `${QA}Firm` })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  finance = await createTestUser(firm.id, { role: 'FINANCE' })
  contracts = await createTestUser(firm.id, { role: 'CONTRACTS' })
  proposalUser = await createTestUser(firm.id, { role: 'PROPOSAL' })
})

afterAll(async () => {
  __setAccountingConnector(IntegrationProvider.QUICKBOOKS, null)
  __setCalendarAdapter(IntegrationProvider.GOOGLE_CALENDAR, null)
  await cleanupFirm(firm.id)
  await disconnectDb()
})

// -------------------------------------------------------------
// 1 — CRM
// -------------------------------------------------------------

describe('§8 lifecycle 1: relationship', () => {
  it('records an agency office and a contact', async () => {
    const office = await request(app).post('/api/crm/offices').set(auth(admin.token))
      .send({ agencyName: 'GENERAL SERVICES ADMINISTRATION', officeName: `${QA}Region 4` })
    expect(office.status).toBe(201)
    agencyOfficeId = office.body.data.id

    const contact = await request(app).post('/api/crm/contacts').set(auth(admin.token))
      .send({ agencyName: 'GENERAL SERVICES ADMINISTRATION', agencyOfficeId, fullName: `${QA}Dana Buyer`, contactRole: 'CONTRACTING_OFFICER' })
    expect(contact.status).toBe(201)
    contactId = contact.body.data.id
  })

  it('logs a meeting as an activity, not as a separate system', async () => {
    const activity = await request(app).post('/api/crm/activities').set(auth(admin.token))
      .send({ governmentContactId: contactId, activityType: 'MEETING', subject: `${QA}Capability briefing`, occurredAt: new Date().toISOString() })
    expect(activity.status).toBe(201)
    expect(activity.body.data.activityType).toBe('MEETING')
  })

  it('reports relationship strength without inventing one from no data', async () => {
    const fresh = await request(app).post('/api/crm/contacts').set(auth(admin.token))
      .send({ agencyName: 'GENERAL SERVICES ADMINISTRATION', fullName: `${QA}Untouched Contact` })
    const res = await request(app).get(`/api/crm/contacts/${fresh.body.data.id}`).set(auth(admin.token))
    expect(res.status).toBe(200)
    // No interactions must never read as a WEAK relationship.
    expect(res.body.data.relationshipStrength?.band ?? 'NO_DATA').toBe('NO_DATA')
  })

  it('leaves the pursuit pipeline untouched by CRM activity', async () => {
    const opp = await prisma.opportunity.create({
      data: {
        consultingFirmId: firm.id, title: `${QA}Opportunity`, agency: 'GENERAL SERVICES ADMINISTRATION',
        responseDeadline: new Date(Date.now() + 30 * 86400000), naicsCode: '541512',
      },
      select: { id: true },
    })
    opportunityId = opp.id
    const pursuit = await prisma.bidPursuit.create({
      data: { consultingFirmId: firm.id, opportunityId, status: 'REVIEWING', pipelineStage: 'IDENTIFIED', priority: 'MEDIUM' },
      select: { id: true, pipelineStage: true, priority: true },
    })
    pursuitId = pursuit.id

    await request(app).post('/api/crm/activities').set(auth(admin.token))
      .send({ governmentContactId: contactId, opportunityId, activityType: 'CALL', subject: `${QA}Follow-up call`, occurredAt: new Date().toISOString() })

    const after = await prisma.bidPursuit.findUnique({ where: { id: pursuitId } })
    expect(after!.pipelineStage).toBe('IDENTIFIED')
    expect(after!.priority).toBe('MEDIUM')
  })
})

// -------------------------------------------------------------
// 2 — capture, personnel, proposal
// -------------------------------------------------------------

describe('§8 lifecycle 2: capture and proposal', () => {
  it('adds a teaming partner through the existing partner record', async () => {
    const partner = await prisma.partner.create({
      data: { consultingFirmId: firm.id, name: `${QA}Sub Co` }, select: { id: true },
    })
    partnerId = partner.id
    expect(await prisma.partner.count({ where: { consultingFirmId: firm.id } })).toBe(1)
  })

  it('records a person, and refuses to infer a qualification from their title', async () => {
    const person = await request(app).post('/api/personnel').set(auth(proposalUser.token))
      .send({ firstName: `${QA}Ada`, lastName: 'Byron', jobTitle: 'Senior Cyber Engineer', yearsExperience: 12 })
    expect(person.status).toBe(201)
    personnelId = person.body.data.id

    const qual = await request(app).post(`/api/personnel/${personnelId}/qualifications`).set(auth(proposalUser.token))
      .send({ laborCategory: 'Senior Cyber Engineer', yearsExperience: 9 })
    // Matching the job title exactly still starts unverified.
    expect(qual.body.data.verification).toBe('UNVERIFIED')
  })

  it('keeps an unverified qualification and an unapproved resume out of proposal evidence', async () => {
    const proposal = await prisma.proposal.create({
      data: { consultingFirmId: firm.id, opportunityId, title: `${QA}Proposal` }, select: { id: true },
    })
    proposalId = proposal.id

    const draft = await request(app).post(`/api/personnel/${personnelId}/resumes`).set(auth(proposalUser.token))
      .send({ title: 'v1', content: { summary: `${QA}APPROVED-SUMMARY`, certifications: ['CISSP'] } })
    resumeId = draft.body.data.id

    // Selecting a DRAFT resume is refused outright.
    const early = await request(app).post(`/api/personnel/proposals/${proposalId}/key-personnel`).set(auth(proposalUser.token))
      .send({ personnelId, resumeId })
    expect(early.status).toBe(422)
  })

  it('supplies evidence only after a human approves the resume and verifies the category', async () => {
    const quals = await prisma.personnelLaborQualification.findMany({ where: { personnelId } })
    await request(app).post(`/api/personnel/qualifications/${quals[0].id}/verify`).set(auth(proposalUser.token))
      .send({ verification: 'VERIFIED', evidence: 'Employment letter reviewed' }).expect(200)
    await request(app).post(`/api/personnel/resumes/${resumeId}/approve`).set(auth(proposalUser.token)).send({}).expect(200)
    await request(app).post(`/api/personnel/proposals/${proposalId}/key-personnel`).set(auth(proposalUser.token))
      .send({ personnelId, resumeId }).expect(201)

    const { buildKeyPersonnelEvidence } = await import('../services/agents/proposal/personnelEvidence')
    const evidence = await buildKeyPersonnelEvidence(firm.id, proposalId)
    expect(evidence).toHaveLength(1)
    expect(evidence[0].hasApprovedResume).toBe(true)
    expect(evidence[0].verifiedLaborQualifications).toHaveLength(1)
    expect(evidence[0].yearsExperienceStated).toBe(12)
  })

  it('withdraws the evidence the moment a human withdraws the approval', async () => {
    await prisma.personnelResume.update({
      where: { id: resumeId }, data: { status: 'SUPERSEDED', supersededAt: new Date() },
    })
    const { buildKeyPersonnelEvidence } = await import('../services/agents/proposal/personnelEvidence')
    const evidence = await buildKeyPersonnelEvidence(firm.id, proposalId)
    expect(evidence[0].hasApprovedResume).toBe(false)
    expect(JSON.stringify(evidence)).not.toContain('CISSP')
    expect(JSON.stringify(evidence)).not.toContain(`${QA}APPROVED-SUMMARY`)
    // Restore for the rest of the lifecycle.
    await prisma.personnelResume.update({
      where: { id: resumeId }, data: { status: 'APPROVED', supersededAt: null, approvedAt: new Date() },
    })
  })

  it('HUMAN GATE — no bid decision exists until a person makes one', async () => {
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firm.id } })).toBe(0)
    const pursuit = await prisma.bidPursuit.findUnique({ where: { id: pursuitId } })
    expect(pursuit!.decidedAt).toBeNull()
  })
})

// -------------------------------------------------------------
// 3 — award, contract, money
// -------------------------------------------------------------

describe('§8 lifecycle 3: contract and money', () => {
  it('creates the contract, funds it, and keeps ceiling and funded apart', async () => {
    const contract = await prisma.contract.create({
      data: {
        consultingFirmId: firm.id, opportunityId, contractNumber: `${QA}C-1`, title: `${QA}Contract`,
        status: 'ACTIVE', ceilingValue: '500000.00', agency: 'GENERAL SERVICES ADMINISTRATION',
      },
      select: { id: true },
    })
    contractId = contract.id

    const funding = await request(app).post(`/api/contract-finance/${contractId}/funding`).set(auth(finance.token))
      .send({ type: 'INITIAL_OBLIGATION', amount: 200000, effectiveDate: new Date().toISOString() })
    expect(funding.status).toBeLessThan(400)

    const summary = await computeContractFinancialSummary(firm.id, contractId)
    expect(summary.contractValue).toBe('500000.00')
    expect(summary.funded).toBe('200000.00')
    expect(summary.unfunded).toBe('300000.00')
  })

  it('HUMAN GATE — a budget does nothing until a person activates it', async () => {
    const budget = await request(app).post('/api/erp/budgets').set(auth(finance.token)).send({
      contractId, title: `${QA}Budget v1`,
      lines: [{ category: 'LABOR', plannedAmount: '100000.00' }, { category: 'SUBCONTRACT', plannedAmount: '50000.00' }],
    })
    expect(budget.status).toBe(201)
    expect(budget.body.data.status).toBe('DRAFT')
    budgetId = budget.body.data.id

    const before = await computeBudgetVsActual(firm.id, contractId)
    expect(before.hasBudget).toBe(false)
    expect(before.totals.budget).toBeNull()
    expect(before.dataNote).toMatch(/no plan to compare against/i)

    await request(app).post(`/api/erp/budgets/${budgetId}/activate`).set(auth(finance.token)).send({}).expect(200)
    const after = await computeBudgetVsActual(firm.id, contractId)
    expect(after.hasBudget).toBe(true)
    expect(after.totals.budget).toBe('150000.00')
  })

  it('refuses to edit an activated budget, and versions instead', async () => {
    const edit = await request(app).put(`/api/erp/budgets/${budgetId}`).set(auth(finance.token))
      .send({ title: 'rewritten' })
    expect(edit.status).toBeGreaterThanOrEqual(400)

    const v2 = await request(app).post('/api/erp/budgets').set(auth(finance.token)).send({
      contractId, title: `${QA}Budget v2`, lines: [{ category: 'LABOR', plannedAmount: '120000.00' }],
    })
    expect(v2.status).toBe(201)
    expect(v2.body.data.versionNumber).toBe(2)

    // The historical version is still there, unchanged.
    const original = await prisma.contractBudget.findUnique({ where: { id: budgetId } })
    expect(original!.title).toBe(`${QA}Budget v1`)
    expect(original!.status).toBe('ACTIVE')
    const active = await prisma.contractBudget.count({ where: { contractId, status: 'ACTIVE' } })
    expect(active).toBe(1)
  })

  it('says NO RESOURCE PLAN rather than implying the team is free', async () => {
    const { computeCapacity } = await import('../services/erp/capacityPlanning')
    const capacity = await computeCapacity(firm.id, new Date(), null)
    expect(capacity.state).toBe('INSUFFICIENT_DATA')
    expect(capacity.dataNote).toMatch(/not a statement that the team is available/i)
    expect(capacity.peopleWithPlans).toBe(0)
  })
})

// -------------------------------------------------------------
// 4 — subcontract, partner portal, and the double-counting invariant
// -------------------------------------------------------------

describe('§8 lifecycle 4: subcontract and the money invariant', () => {
  it('HUMAN GATE — a purchase order commits nothing until a person approves it', async () => {
    const po = await request(app).post('/api/erp/purchase-orders').set(auth(finance.token)).send({
      contractId, partnerId, vendorName: `${QA}Sub Co`, poNumber: `${QA}PO-1`,
      ceilingAmount: '40000.00', isSubcontract: true,
    })
    expect(po.status).toBe(201)
    expect(po.body.data.status).toBe('DRAFT')
    poId = po.body.data.id

    const draftState = await computeBudgetVsActual(firm.id, contractId)
    expect(draftState.totals.committed).toBe('0.00')

    await request(app).post(`/api/erp/purchase-orders/${poId}/transition`).set(auth(finance.token))
      .send({ status: 'PENDING_APPROVAL' }).expect(200)
    await request(app).post(`/api/erp/purchase-orders/${poId}/transition`).set(auth(finance.token))
      .send({ status: 'APPROVED' }).expect(200)

    const committed = await computeBudgetVsActual(firm.id, contractId)
    expect(committed.totals.committed).toBe('40000.00')
  })

  it('grants a partner portal user nothing until a person grants an engagement', async () => {
    const invited = await request(app).post('/api/partner-portal/admin/users').set(auth(contracts.token))
      .send({ partnerId, email: `${QA.toLowerCase()}sub@ext.test`, firstName: 'Sub', lastName: 'User' })
    expect(invited.status).toBe(201)
    partnerPortalUserId = invited.body.data.id
    await request(app).post('/api/partner-portal/auth/accept-invite')
      .send({ token: invited.body.data.inviteToken, password: PASSWORD }).expect(200)
    const login = await request(app).post('/api/partner-portal/auth/login')
      .send({ email: invited.body.data.email, password: PASSWORD })
    partnerToken = login.body.data.token

    // Membership of the partner company grants nothing at all.
    const before = await request(app).get('/api/partner-portal/engagements').set(auth(partnerToken))
    expect(before.body.data.contracts).toHaveLength(0)
    expect(before.body.data.purchaseOrders).toHaveLength(0)

    await request(app).post('/api/partner-portal/admin/access').set(auth(contracts.token))
      .send({ partnerPortalUserId, scopeType: 'PURCHASE_ORDER', scopeId: poId }).expect(201)

    const after = await request(app).get('/api/partner-portal/engagements').set(auth(partnerToken))
    expect(after.body.data.purchaseOrders.map((p: { id: string }) => p.id)).toEqual([poId])
  })

  it('HUMAN GATE — a partner invoice posts no cost until a prime approves it', async () => {
    const submitted = await request(app).post('/api/partner-portal/invoices').set(auth(partnerToken)).send({
      purchaseOrderId: poId, invoiceNumber: `${QA}SUBINV-1`,
      invoiceDate: new Date().toISOString(), amount: '10000.00',
    })
    expect(submitted.status).toBe(201)
    expect(submitted.body.data.status).toBe('RECEIVED')
    subcontractInvoiceId = submitted.body.data.id

    // Nothing has been posted.
    expect(await prisma.contractCost.count({ where: { contractId, category: 'SUBCONTRACTOR' } })).toBe(0)

    // And the partner cannot approve, post or pay its own invoice.
    for (const status of ['APPROVED', 'PAID']) {
      const attempt = await request(app).post(`/api/erp/subcontract-invoices/${subcontractInvoiceId}/transition`)
        .set(auth(partnerToken)).send({ status })
      expect([status, attempt.status]).toEqual([status, 401])
    }
    expect(await prisma.contractCost.count({ where: { contractId, category: 'SUBCONTRACTOR' } })).toBe(0)
  })

  it('moves the money from commitment to actual exactly once, however many times approval is retried', async () => {
    const before = await computeBudgetVsActual(firm.id, contractId)
    const actualBefore = new Prisma.Decimal(before.totals.actual)
    const committedBefore = new Prisma.Decimal(before.totals.committed)
    const remainingBefore = new Prisma.Decimal(before.totals.remaining!)

    await request(app).post(`/api/erp/subcontract-invoices/${subcontractInvoiceId}/transition`)
      .set(auth(finance.token)).send({ status: 'UNDER_REVIEW' }).expect(200)
    await request(app).post(`/api/erp/subcontract-invoices/${subcontractInvoiceId}/transition`)
      .set(auth(finance.token)).send({ status: 'APPROVED' }).expect(200)

    // Retried three more times. A restarted worker, a double click, a replay.
    for (let i = 0; i < 3; i++) {
      await request(app).post(`/api/erp/subcontract-invoices/${subcontractInvoiceId}/transition`)
        .set(auth(finance.token)).send({ status: 'APPROVED' })
    }

    const costs = await prisma.contractCost.findMany({ where: { contractId, category: 'SUBCONTRACTOR' } })
    expect(costs).toHaveLength(1)
    expect(costs[0].amount.toFixed(2)).toBe('10000.00')

    const after = await computeBudgetVsActual(firm.id, contractId)
    expect(new Prisma.Decimal(after.totals.actual).toFixed(2)).toBe(actualBefore.plus('10000.00').toFixed(2))
    expect(new Prisma.Decimal(after.totals.committed).toFixed(2)).toBe(committedBefore.minus('10000.00').toFixed(2))
    // The invoice must be counted once, not once as actual and again as commitment.
    expect(new Prisma.Decimal(after.totals.remaining!).toFixed(2)).toBe(remainingBefore.toFixed(2))
  })

  it('agrees with the one canonical actual-cost definition', async () => {
    const [approvedTime, approvedCosts] = await Promise.all([
      prisma.timeEntry.findMany({ where: { consultingFirmId: firm.id, contractId, status: 'APPROVED' }, select: { billingAmount: true } }),
      prisma.contractCost.findMany({ where: { consultingFirmId: firm.id, contractId, status: 'APPROVED' }, select: { amount: true } }),
    ])
    const canonical = recognizedExpenditure(approvedTime, approvedCosts)
    const budget = await computeBudgetVsActual(firm.id, contractId)
    const summary = await computeContractFinancialSummary(firm.id, contractId)
    expect(budget.totals.actual).toBe(canonical.toFixed(2))
    expect(summary.actual).toBe(canonical.toFixed(2))
  })
})

// -------------------------------------------------------------
// 5 — receivable, AP/AR separation, accounting export
// -------------------------------------------------------------

describe('§8 lifecycle 5: receivable, export and projection', () => {
  it('keeps the government receivable and the vendor payable apart', async () => {
    const invoice = await request(app).post(`/api/contract-finance/${contractId}/invoices`).set(auth(finance.token))
      .send({ invoiceNumber: `${QA}AR-1`, customerName: 'GSA' })
    expect(invoice.status).toBeLessThan(400)
    contractInvoiceId = invoice.body.data.id

    // A receivable is not a cost, and a payable is not revenue. Asserted on
    // WHERE each number comes from rather than on the values happening to
    // differ — two unrelated figures can coincide without being the same fact.
    const summary = await computeContractFinancialSummary(firm.id, contractId)
    const approvedCosts = await prisma.contractCost.aggregate({
      where: { consultingFirmId: firm.id, contractId, status: 'APPROVED' }, _sum: { amount: true },
    })
    // `actual` is the cost ledger. The receivable BILLS that cost onward to the
    // government, which is why the two figures agree here — and is exactly why
    // they must stay separate rows: the same money is a cost once and revenue
    // once, and merging them would count it twice.
    expect(summary.actual).toBe((approvedCosts._sum.amount ?? new Prisma.Decimal(0)).toFixed(2))
    expect(summary.subcontractCommitments.posted).toBe('10000.00')

    // The AP row and the AR row are different records in different tables with
    // different counterparties.
    const ar = await prisma.contractInvoice.findUnique({ where: { id: contractInvoiceId } })
    const ap = await prisma.subcontractInvoice.findUnique({ where: { id: subcontractInvoiceId } })
    expect(ar!.contractId).toBe(contractId)
    expect(ap!.partnerId).toBe(partnerId)
    expect(ar!.customerName).toBe('GSA')
    expect(ap!.vendorName).toBe(`${QA}Sub Co`)
    // An AP row is never counted as a receivable.
    expect(await prisma.contractInvoice.count({ where: { invoiceNumber: `${QA}SUBINV-1` } })).toBe(0)

    // And they are approved through different endpoints, so one approval can
    // never stand in for the other.
    const financeRoutes = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(__dirname, '../routes/contractFinance.ts'), 'utf8')
    const erpRoutes = (await import('node:fs')).readFileSync(
      (await import('node:path')).resolve(__dirname, '../routes/erp.ts'), 'utf8')
    expect(financeRoutes).toContain("/invoices/:id/:action(approve|submit|void)")
    expect(erpRoutes).toContain("/subcontract-invoices/:id/transition")
  })

  it('keeps backlog, receivables and pipeline as three different numbers', async () => {
    const summary = await computeContractFinancialSummary(firm.id, contractId)
    expect(summary.backlog).not.toBe(summary.receivables.outstanding)
    expect(summary.contractValue).not.toBe(summary.funded)
    expect(summary.backlogBasis).toMatch(/not pipeline, and it is not receivables/i)
  })

  it('exports the receivable to accounting exactly once', async () => {
    await upsertConnection(firm.id, IntegrationProvider.QUICKBOOKS, {
      status: IntegrationStatus.CONNECTED, accessToken: `${QA}TOKEN`, config: { realmId: `${QA}REALM` },
    })
    const payload = (await buildInvoicePayload(firm.id, contractInvoiceId))!
    const first = await exportDocument(firm.id, IntegrationProvider.QUICKBOOKS, payload)
    const second = await exportDocument(firm.id, IntegrationProvider.QUICKBOOKS, payload)
    expect(first.action).toBe('CREATED')
    expect(second.action).toBe('ALREADY_SYNCED')
    expect(exportCalls).toBe(1)
  })

  it('projects a deadline onto the calendar without inventing a second milestone store', async () => {
    const milestone = await prisma.opportunityMilestone.create({
      data: {
        consultingFirmId: firm.id, opportunityId, milestoneType: 'PROPOSAL_DEADLINE',
        title: `${QA}Proposal due`, endAt: new Date(Date.now() + 20 * 86400000),
      },
      select: { id: true, endAt: true },
    })
    await upsertConnection(firm.id, IntegrationProvider.GOOGLE_CALENDAR, {
      status: IntegrationStatus.CONNECTED, accessToken: `${QA}TOKEN`, config: { calendarId: 'primary' },
    })
    const event = {
      sourceType: 'OpportunityMilestone' as const, sourceId: milestone.id,
      title: `${QA}Proposal due`, description: null,
      startAt: milestone.endAt!, endAt: milestone.endAt, isAllDay: false,
    }
    expect((await syncCalendarEvent(firm.id, IntegrationProvider.GOOGLE_CALENDAR, event)).action).toBe('CREATED')
    expect((await syncCalendarEvent(firm.id, IntegrationProvider.GOOGLE_CALENDAR, event)).action).toBe('UNCHANGED')
    expect(calendarCreates).toBe(1)
  })

  it('serves the whole story to the Public API, read-only and without a private figure', async () => {
    const minted = await request(app).post('/api/admin/mcp/tokens').set(auth(admin.token))
      .send({ name: `${QA}api`, kind: 'PUBLIC_API', scopes: ['contracts:read', 'opportunities:read', 'personnel:read', 'crm:read'] })
    const token = minted.body.data.rawToken

    const contractsRes = await request(app).get('/api/v1/contracts').set(auth(token))
    expect(contractsRes.status).toBe(200)
    expect((contractsRes.body.data as Array<{ id: string }>).some((c) => c.id === contractId)).toBe(true)

    const body = JSON.stringify(contractsRes.body)
    for (const forbidden of ['consultingFirmId', 'notes', 'probabilityScore', 'scoreBreakdown']) {
      expect([forbidden, body.includes(forbidden)]).toEqual([forbidden, false])
    }

    // And the API can change nothing at all.
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verb](`/api/v1/contracts/${contractId}`)
        .set(auth(token)).send({})
      expect([verb, res.status]).toEqual([verb, 404])
    }
  })
})
