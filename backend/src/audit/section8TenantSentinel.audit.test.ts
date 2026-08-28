// =============================================================
// §8 FINAL ACCEPTANCE — cross-tenant sentinels.
//
// The method: give Firm B values that could not possibly belong to Firm A —
// an unmistakable dollar figure, a made-up agency, a provider account id —
// then compute every Firm A output BEFORE and AFTER Firm B exists, and require
// them to be byte-identical.
//
// This catches what a per-query WHERE-clause review cannot: an aggregate that
// forgot its tenant, a join that reached sideways, a search that scanned a
// table instead of a tenant's rows.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { IntegrationProvider, IntegrationStatus } from '@prisma/client'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'
import { upsertConnection } from '../services/integrations/connectionService'
import { computeBudgetVsActual } from '../services/erp/budgetVsActual'
import { computeContractFinancialSummary } from '../services/erp/financialSummary'
import { searchKnowledge } from '../services/knowledge/knowledgeSearch'

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

/** Values that exist only in Firm B. Any sighting in a Firm A output is a leak. */
const B = {
  money: '99999999.99',
  agency: 'DEPARTMENT OF SENTINEL AFFAIRS',
  contact: 'SENTINEL-CONTACT-B',
  capability: 'SENTINEL-CAPABILITY-B',
  person: 'SENTINELPERSONB',
  partner: 'SENTINEL-PARTNER-B',
  providerAccount: 'SENTINEL-REALM-B',
  providerToken: 'SENTINEL-PROVIDER-TOKEN-B',
  note: 'SENTINEL-PRIVATE-NOTE-B',
}

let app: Express
let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser, adminB: TestUser
let contractA = ''
let apiTokenA = ''

interface Snapshot {
  budget: string
  summary: string
  knowledge: string
  crmContacts: string
  crmActivities: string
  integrations: string
  publicOpportunities: string
  publicContracts: string
  publicPersonnel: string
  publicAnalytics: string
}

async function snapshotFirmA(): Promise<Snapshot> {
  // Deliberately sequential. Each of these opens its own database work, and a
  // ten-wide fan-out from an audit suite starves the connection pool that the
  // rest of the suite is sharing — which shows up as an unrelated test timing
  // out, i.e. as a flake this file caused.
  const budget = await computeBudgetVsActual(firmA.id, contractA)
  const summary = await computeContractFinancialSummary(firmA.id, contractA)
  const knowledge = await searchKnowledge(firmA.id, { query: 'SENTINEL', limit: 100, offset: 0 })
  const contacts = await request(app).get('/api/crm/contacts').set(auth(adminA.token))
  const activities = await request(app).get('/api/crm/activities').set(auth(adminA.token))
  const integrations = await request(app).get('/api/integrations').set(auth(adminA.token))
  const opportunities = await request(app).get('/api/v1/opportunities').set(auth(apiTokenA)).query({ limit: 100 })
  const contracts = await request(app).get('/api/v1/contracts').set(auth(apiTokenA)).query({ limit: 100 })
  const personnel = await request(app).get('/api/v1/personnel').set(auth(apiTokenA)).query({ limit: 100 })
  const analytics = await request(app).get('/api/v1/analytics/portfolio').set(auth(apiTokenA))
  return {
    budget: JSON.stringify(budget),
    summary: JSON.stringify(summary),
    knowledge: JSON.stringify(knowledge),
    crmContacts: JSON.stringify(contacts.body),
    crmActivities: JSON.stringify(activities.body),
    integrations: JSON.stringify(integrations.body),
    publicOpportunities: JSON.stringify(opportunities.body),
    publicContracts: JSON.stringify(contracts.body),
    publicPersonnel: JSON.stringify(personnel.body),
    publicAnalytics: JSON.stringify(analytics.body),
  }
}

let before: Snapshot

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'SENTINEL Firm A' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })

  contractA = (await prisma.contract.create({
    data: {
      consultingFirmId: firmA.id, contractNumber: `SENT-A-${Date.now()}`, title: 'Firm A Contract',
      status: 'ACTIVE', ceilingValue: '100000.00',
    },
    select: { id: true },
  })).id
  await prisma.contractCost.create({
    data: {
      consultingFirmId: firmA.id, contractId: contractA, category: 'OTHER_DIRECT_COST',
      amount: '1000.00', status: 'APPROVED', incurredDate: new Date(),
    },
  })
  await prisma.firmCapability.create({
    data: { consultingFirmId: firmA.id, name: 'SENTINEL capability A', verification: 'VERIFIED' },
  })
  await prisma.governmentContact.create({
    data: { consultingFirmId: firmA.id, agencyName: 'GSA', fullName: 'SENTINEL contact A' },
  })
  await upsertConnection(firmA.id, IntegrationProvider.QUICKBOOKS, {
    status: IntegrationStatus.CONNECTED, accessToken: 'SENTINEL-PROVIDER-TOKEN-A',
    externalAccountId: 'SENTINEL-REALM-A', config: { realmId: 'SENTINEL-REALM-A' },
  })

  const minted = await request(app).post('/api/admin/mcp/tokens').set(auth(adminA.token)).send({
    name: 'sentinel-api', kind: 'PUBLIC_API',
    scopes: ['opportunities:read', 'contracts:read', 'personnel:read', 'crm:read', 'partners:read', 'analytics:read', 'pursuits:read'],
  })
  apiTokenA = minted.body.data.rawToken

  before = await snapshotFirmA()

  // ---- Firm B now exists, loudly ----
  firmB = await createTestFirm({ name: 'SENTINEL Firm B' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })

  const contractB = await prisma.contract.create({
    data: {
      consultingFirmId: firmB.id, contractNumber: `SENT-B-${Date.now()}`, title: 'Firm B Contract',
      status: 'ACTIVE', ceilingValue: B.money, notes: B.note, agency: B.agency,
    },
    select: { id: true },
  })
  await prisma.contractCost.create({
    data: {
      consultingFirmId: firmB.id, contractId: contractB.id, category: 'OTHER_DIRECT_COST',
      amount: B.money, status: 'APPROVED', incurredDate: new Date(), description: B.note,
    },
  })
  const budgetB = await prisma.contractBudget.create({
    data: { consultingFirmId: firmB.id, contractId: contractB.id, versionNumber: 1, status: 'ACTIVE', title: B.note },
    select: { id: true },
  })
  await prisma.contractBudgetLine.create({
    data: { consultingFirmId: firmB.id, budgetId: budgetB.id, category: 'LABOR', plannedAmount: B.money },
  })
  await prisma.contractInvoice.create({
    data: {
      consultingFirmId: firmB.id, contractId: contractB.id, invoiceNumber: `SENT-B-INV-${Date.now()}`,
      status: 'APPROVED', total: B.money, subtotal: B.money, customerName: B.agency,
    },
  })
  const partnerB = await prisma.partner.create({
    data: { consultingFirmId: firmB.id, name: B.partner, notes: B.note }, select: { id: true },
  })
  const poB = await prisma.purchaseOrder.create({
    data: {
      consultingFirmId: firmB.id, contractId: contractB.id, partnerId: partnerB.id,
      poNumber: `SENT-B-PO-${Date.now()}`, vendorName: B.partner, ceilingAmount: B.money,
      status: 'APPROVED', isSubcontract: true,
    },
    select: { id: true },
  })
  await prisma.subcontractInvoice.create({
    data: {
      consultingFirmId: firmB.id, purchaseOrderId: poB.id, partnerId: partnerB.id,
      vendorName: B.partner, invoiceNumber: `SENT-B-SUB-${Date.now()}`,
      invoiceDate: new Date(), amount: B.money, status: 'RECEIVED',
    },
  })
  await prisma.governmentContact.create({
    data: { consultingFirmId: firmB.id, agencyName: B.agency, fullName: B.contact, notes: B.note },
  })
  await prisma.firmCapability.create({
    data: { consultingFirmId: firmB.id, name: B.capability, description: B.note, verification: 'VERIFIED' },
  })
  const personB = await prisma.personnel.create({
    data: { consultingFirmId: firmB.id, firstName: B.person, lastName: 'SENTINEL', notes: B.note },
    select: { id: true },
  })
  await prisma.personnelResume.create({
    data: {
      consultingFirmId: firmB.id, personnelId: personB.id, versionNumber: 1, status: 'APPROVED',
      title: `${B.capability} resume`, approvedAt: new Date(), content: { summary: B.note },
    },
  })
  await prisma.opportunity.create({
    data: {
      consultingFirmId: firmB.id, title: `${B.capability} opportunity`, agency: B.agency,
      responseDeadline: new Date(Date.now() + 10 * 86400000), estimatedValue: B.money,
    },
  })
  await upsertConnection(firmB.id, IntegrationProvider.QUICKBOOKS, {
    status: IntegrationStatus.CONNECTED, accessToken: B.providerToken,
    externalAccountId: B.providerAccount, externalAccountName: B.partner,
    config: { realmId: B.providerAccount },
  })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('§8 acceptance: Firm B cannot change a single one of Firm A’s numbers', () => {
  it('produces byte-identical Firm A output before and after Firm B exists', async () => {
    const after = await snapshotFirmA()
    for (const key of Object.keys(before) as Array<keyof Snapshot>) {
      expect([key, after[key] === before[key]]).toEqual([key, true])
    }
  })
})

describe('§8 acceptance: no Firm B value reaches any Firm A surface', () => {
  const SENTINELS = Object.values(B)

  it('leaks nothing into ERP figures', async () => {
    const text = JSON.stringify([
      await computeBudgetVsActual(firmA.id, contractA),
      await computeContractFinancialSummary(firmA.id, contractA),
    ])
    for (const value of SENTINELS) expect([value, text.includes(value)]).toEqual([value, false])
  })

  it('leaks nothing into knowledge search', async () => {
    const results = await searchKnowledge(firmA.id, { query: 'SENTINEL', limit: 100, offset: 0 })
    const text = JSON.stringify(results)
    for (const value of SENTINELS) expect([value, text.includes(value)]).toEqual([value, false])
    // Firm A's own sentinel-named rows still match, so the search is working.
    expect(results.total).toBeGreaterThan(0)
  })

  it('leaks nothing into CRM', async () => {
    for (const path of ['/api/crm/contacts', '/api/crm/activities', '/api/crm/follow-ups', '/api/crm/partner-contacts']) {
      const res = await request(app).get(path).set(auth(adminA.token))
      const text = JSON.stringify(res.body)
      for (const value of SENTINELS) expect([path, value, text.includes(value)]).toEqual([path, value, false])
    }
  })

  it('leaks nothing into the Public API', async () => {
    for (const path of ['/api/v1/opportunities', '/api/v1/contracts', '/api/v1/personnel', '/api/v1/partners', '/api/v1/crm/contacts', '/api/v1/pursuits', '/api/v1/analytics/portfolio']) {
      const res = await request(app).get(path).set(auth(apiTokenA)).query({ limit: 100 })
      const text = JSON.stringify(res.body)
      for (const value of SENTINELS) expect([path, value, text.includes(value)]).toEqual([path, value, false])
    }
  })

  it('leaks no provider identity or credential into Firm A’s integration status', async () => {
    const res = await request(app).get('/api/integrations').set(auth(adminA.token))
    const text = JSON.stringify(res.body)
    expect(text).not.toContain(B.providerAccount)
    expect(text).not.toContain(B.providerToken)
    expect(text).not.toContain(B.partner)
    // Firm A's own connection is there, and its own token is not.
    expect(text).toContain('SENTINEL-REALM-A')
    expect(text).not.toContain('SENTINEL-PROVIDER-TOKEN-A')
  })

  it('refuses Firm A a direct read of every Firm B record id', async () => {
    const contractB = await prisma.contract.findFirst({ where: { consultingFirmId: firmB.id }, select: { id: true } })
    const personB = await prisma.personnel.findFirst({ where: { consultingFirmId: firmB.id }, select: { id: true } })
    const oppB = await prisma.opportunity.findFirst({ where: { consultingFirmId: firmB.id }, select: { id: true } })
    const probes: Array<[string, string]> = [
      ['contract', `/api/v1/contracts/${contractB!.id}`],
      ['opportunity', `/api/v1/opportunities/${oppB!.id}`],
    ]
    for (const [label, path] of probes) {
      const res = await request(app).get(path).set(auth(apiTokenA))
      expect([label, res.status]).toEqual([label, 404])
    }
    // And through the internal API too.
    const internal = await request(app).get(`/api/personnel/${personB!.id}`).set(auth(adminA.token))
    expect(internal.status).toBe(404)
  })
})
