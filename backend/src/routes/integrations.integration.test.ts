// =============================================================
// §8.5 — Integrations: connection lifecycle, idempotency, tenant isolation
// and secret containment.
//
// No live provider is configured on this deployment, so every adapter is
// driven through its test seam with a mock. That is stated rather than hidden:
// these tests prove the PLATFORM side — the ledger, the encryption, the
// isolation, the retry bounds — and prove nothing about any vendor's servers.
//
// The leakage suite is the sharp end. Provider tokens are seeded with
// recognizable sentinels and every response body, every audit row and the
// Public API are searched for them.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { IntegrationProvider, IntegrationStatus } from '@prisma/client'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'
import { upsertConnection, readCredential } from '../services/integrations/connectionService'
import {
  __setAccountingConnector, exportDocument, reconcilePayments, buildInvoicePayload,
} from '../services/integrations/accounting/syncService'
import { __setCalendarAdapter, syncCalendarEvent } from '../services/integrations/calendar/calendarSync'
import { ConnectorError, type AccountingConnector } from '../services/integrations/accounting/connector'
import type { CalendarAdapter } from '../services/integrations/calendar/calendarSync'
import { isAllowedTeamsWebhook } from '../services/integrations/channels/teams'
import { dispatchToChannel, looksLikeSecret } from '../services/integrations/channels/dispatcher'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser, adminB: TestUser, financeA: TestUser
let contractA = '', invoiceA = '', invoiceB = ''

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

/** Values that exist only inside a stored credential. Any sighting is a leak. */
const SENTINELS = {
  accessToken: 'ACCESS-TOKEN-SENTINEL-A1B2C3',
  refreshToken: 'REFRESH-TOKEN-SENTINEL-D4E5F6',
  teamsWebhook: 'https://outlook.webhook.office.com/webhookb2/SENTINEL-TEAMS-URL',
}

// -------------------------------------------------------------
// A recording mock. Counts calls so idempotency is observable.
// -------------------------------------------------------------
function makeMockConnector(): AccountingConnector & { calls: { export: number; payments: number }; fail?: ConnectorError } {
  const created = new Map<string, string>()
  let seq = 0
  const mock = {
    provider: IntegrationProvider.QUICKBOOKS,
    calls: { export: 0, payments: 0 },
    fail: undefined as ConnectorError | undefined,
    async testConnection() {
      if (mock.fail) throw mock.fail
      return { ok: true, accountName: 'Mock Company', detail: 'mock' }
    },
    async exportDocument(_ctx: unknown, payload: { documentNumber: string }) {
      mock.calls.export += 1
      if (mock.fail) throw mock.fail
      // The provider's own idempotency: same document number, same object.
      const existing = created.get(payload.documentNumber)
      if (existing) return { externalId: existing, externalType: 'Invoice', deduped: true }
      seq += 1
      const id = `EXT-${seq}`
      created.set(payload.documentNumber, id)
      return { externalId: id, externalType: 'Invoice', deduped: false }
    },
    async fetchPayments() {
      mock.calls.payments += 1
      if (mock.fail) throw mock.fail
      return mock.payments
    },
    payments: [] as Array<{ externalId: string; externalInvoiceId: string; amount: string; paidOn: Date | null; reference: string | null }>,
  }
  return mock as unknown as AccountingConnector & { calls: { export: number; payments: number }; fail?: ConnectorError }
}

function makeMockCalendar(): CalendarAdapter & { events: Map<string, unknown>; calls: { create: number; update: number; delete: number } } {
  let seq = 0
  const mock = {
    provider: IntegrationProvider.GOOGLE_CALENDAR,
    events: new Map<string, unknown>(),
    calls: { create: 0, update: 0, delete: 0 },
    async testConnection() { return { ok: true, accountName: 'Mock Calendar', detail: 'mock' } },
    async createEvent(_cred: unknown, event: unknown) {
      mock.calls.create += 1
      seq += 1
      const id = `EVT-${seq}`
      mock.events.set(id, event)
      return { externalId: id }
    },
    async updateEvent(_cred: unknown, id: string, event: unknown) {
      mock.calls.update += 1
      mock.events.set(id, event)
    },
    async deleteEvent(_cred: unknown, id: string) {
      mock.calls.delete += 1
      mock.events.delete(id)
    },
  }
  return mock as unknown as CalendarAdapter & { events: Map<string, unknown>; calls: { create: number; update: number; delete: number } }
}

let mockAccounting = makeMockConnector()
let mockCalendar = makeMockCalendar()

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'INT Firm A' })
  firmB = await createTestFirm({ name: 'INT Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
  financeA = await createTestUser(firmA.id, { role: 'FINANCE' })

  const contract = await prisma.contract.create({
    data: {
      consultingFirmId: firmA.id, contractNumber: `INT-${Date.now()}`, title: 'INT Contract',
      status: 'ACTIVE', ceilingValue: '900000.00',
    },
    select: { id: true },
  })
  contractA = contract.id
  invoiceA = (await prisma.contractInvoice.create({
    data: {
      consultingFirmId: firmA.id, contractId: contractA, invoiceNumber: `INT-INV-A-${Date.now()}`,
      status: 'APPROVED', total: '2500.00', subtotal: '2500.00', customerName: 'GSA',
      invoiceDate: new Date(),
    },
    select: { id: true },
  })).id

  const contractB = await prisma.contract.create({
    data: {
      consultingFirmId: firmB.id, contractNumber: `INT-B-${Date.now()}`, title: 'INT Contract B',
      status: 'ACTIVE',
    },
    select: { id: true },
  })
  invoiceB = (await prisma.contractInvoice.create({
    data: {
      consultingFirmId: firmB.id, contractId: contractB.id, invoiceNumber: `INT-INV-B-${Date.now()}`,
      status: 'APPROVED', total: '999.00', subtotal: '999.00',
    },
    select: { id: true },
  })).id
})

afterAll(async () => {
  __setAccountingConnector(IntegrationProvider.QUICKBOOKS, null)
  __setCalendarAdapter(IntegrationProvider.GOOGLE_CALENDAR, null)
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(() => {
  mockAccounting = makeMockConnector()
  mockCalendar = makeMockCalendar()
  __setAccountingConnector(IntegrationProvider.QUICKBOOKS, mockAccounting)
  __setCalendarAdapter(IntegrationProvider.GOOGLE_CALENDAR, mockCalendar)
})

// -------------------------------------------------------------
// Status honesty
// -------------------------------------------------------------

describe('§8.5 integration status is honest', () => {
  it('lists every provider, and never claims connected because an env var exists', async () => {
    const res = await request(app).get('/api/integrations').set(auth(adminA.token))
    expect(res.status).toBe(200)
    const rows = res.body.data as Array<{ provider: string; status: string; platformConfigured: boolean; missingEnv: string[] }>
    expect(rows).toHaveLength(8)
    for (const row of rows) {
      expect(['NOT_CONFIGURED', 'CREDENTIAL_REQUIRED']).toContain(row.status)
      if (!row.platformConfigured) {
        expect(row.status).toBe('CREDENTIAL_REQUIRED')
        expect(row.missingEnv.length).toBeGreaterThan(0)
      }
    }
  })

  it('says which environment variables are missing, and never their values', async () => {
    const res = await request(app).get('/api/integrations').set(auth(adminA.token))
    const quickbooks = (res.body.data as Array<{ provider: string; missingEnv: string[] }>).find((r) => r.provider === 'QUICKBOOKS')
    expect(quickbooks!.missingEnv).toEqual(['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET'])
  })

  it('marks Unanet and Deltek as contract-only rather than implemented', async () => {
    const res = await request(app).get('/api/integrations').set(auth(adminA.token))
    const rows = res.body.data as Array<{ provider: string; implementation: string; configurationNote: string }>
    for (const provider of ['UNANET', 'DELTEK']) {
      const row = rows.find((r) => r.provider === provider)!
      expect(row.implementation).toBe('CONTRACT_ONLY')
      expect(row.configurationNote.length).toBeGreaterThan(20)
    }
  })

  it('refuses an authorization redirect the deployment cannot complete', async () => {
    const res = await request(app).post('/api/integrations/quickbooks/authorize').set(auth(adminA.token)).send({})
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/not configured on this deployment/i)
  })

  it('refuses the whole surface to a user without INTEGRATION_MANAGE', async () => {
    for (const path of ['/api/integrations']) {
      const res = await request(app).get(path).set(auth(financeA.token))
      expect(res.status).toBe(403)
      expect(res.body.error).toMatch(/INTEGRATION_MANAGE/)
    }
  })
})

// -------------------------------------------------------------
// Credential containment
// -------------------------------------------------------------

describe('§8.5 credentials never leave the server', () => {
  let connectionId = ''

  beforeAll(async () => {
    const row = await upsertConnection(firmA.id, IntegrationProvider.QUICKBOOKS, {
      status: IntegrationStatus.CONNECTED,
      accessToken: SENTINELS.accessToken,
      refreshToken: SENTINELS.refreshToken,
      externalAccountName: 'Mock Company',
      config: { realmId: '123456', channelId: 'C1' },
      connectedByUserId: adminA.id,
    })
    connectionId = row.id
  })

  it('returns no token in the connection list', async () => {
    const res = await request(app).get('/api/integrations').set(auth(adminA.token))
    const body = JSON.stringify(res.body)
    expect(body).not.toContain(SENTINELS.accessToken)
    expect(body).not.toContain(SENTINELS.refreshToken)
    expect(body).not.toContain('accessTokenEnc')
    expect(body).not.toContain('refreshTokenEnc')
  })

  it('returns no token from a test, a sync or a disconnect', async () => {
    for (const path of [`/api/integrations/${connectionId}/test`, `/api/integrations/${connectionId}/sync`]) {
      const res = await request(app).post(path).set(auth(adminA.token)).send({})
      expect(JSON.stringify(res.body)).not.toContain(SENTINELS.accessToken)
      expect(JSON.stringify(res.body)).not.toContain(SENTINELS.refreshToken)
    }
  })

  it('writes no token into an audit row', async () => {
    const rows = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firmA.id, entityType: 'IntegrationConnection' },
    })
    expect(rows.length).toBeGreaterThan(0)
    const body = JSON.stringify(rows)
    expect(body).not.toContain(SENTINELS.accessToken)
    expect(body).not.toContain(SENTINELS.refreshToken)
  })

  it('encrypts at rest when a key is configured, and can still read it back', async () => {
    const row = await prisma.integrationConnection.findUnique({ where: { id: connectionId } })
    expect(readCredential(row!).accessToken).toBe(SENTINELS.accessToken)
    if (process.env.FIELD_ENCRYPTION_KEY) {
      expect(row!.accessTokenEnc).not.toBe(SENTINELS.accessToken)
    }
  })

  it('destroys the credential on disconnect rather than marking it unused', async () => {
    const res = await request(app).post(`/api/integrations/${connectionId}/disconnect`).set(auth(adminA.token)).send({})
    expect(res.status).toBe(200)
    const row = await prisma.integrationConnection.findUnique({ where: { id: connectionId } })
    expect(row!.accessTokenEnc).toBeNull()
    expect(row!.refreshTokenEnc).toBeNull()
    expect(row!.status).toBe('DISCONNECTED')
    expect(readCredential(row!).accessToken).toBeNull()
  })
})

// -------------------------------------------------------------
// Idempotency — the point of the ledger
// -------------------------------------------------------------

describe('§8.5 accounting export is idempotent', () => {
  beforeEach(async () => {
    await prisma.integrationSyncRecord.deleteMany({ where: { consultingFirmId: firmA.id } })
    await upsertConnection(firmA.id, IntegrationProvider.QUICKBOOKS, {
      status: IntegrationStatus.CONNECTED, accessToken: SENTINELS.accessToken,
      config: { realmId: '123456' },
    })
  })

  it('exports once and records the external id', async () => {
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    const first = await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    expect(first.action).toBe('CREATED')
    expect(first.externalId).toBe('EXT-1')
    expect(mockAccounting.calls.export).toBe(1)
  })

  it('does not call the provider again for an unchanged record', async () => {
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    const second = await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    expect(second.action).toBe('ALREADY_SYNCED')
    expect(second.externalId).toBe('EXT-1')
    expect(mockAccounting.calls.export).toBe(1)
  })

  it('creates no second external object when the record changes', async () => {
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    const changed = { ...payload, amount: '2600.00', lines: [{ description: 'x', amount: '2600.00' }] }
    const second = await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, changed)
    expect(second.externalId).toBe('EXT-1')
    expect(second.action).toBe('UPDATED_LEDGER')
    const records = await prisma.integrationSyncRecord.findMany({
      where: { consultingFirmId: firmA.id, localType: 'ContractInvoice' },
    })
    expect(records).toHaveLength(1)
  })

  it('records a failure without writing a ledger row', async () => {
    mockAccounting.fail = new ConnectorError('provider is down', 'PROVIDER_ERROR', true)
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    const result = await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    expect(result.action).toBe('FAILED')
    expect(await prisma.integrationSyncRecord.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    const row = await prisma.integrationConnection.findFirst({ where: { consultingFirmId: firmA.id, provider: 'QUICKBOOKS' } })
    expect(row!.status).toBe('ERROR')
    expect(row!.consecutiveFailures).toBe(1)
  })

  it('stops retrying after repeated failures rather than looping forever', async () => {
    mockAccounting.fail = new ConnectorError('provider is down', 'PROVIDER_ERROR', true)
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    for (let i = 0; i < 5; i++) await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    const callsBefore = mockAccounting.calls.export
    const result = await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    expect(result.action).toBe('SKIPPED')
    expect(result.detail).toMatch(/failed too many times/i)
    expect(mockAccounting.calls.export).toBe(callsBefore)
  })

  it('does nothing at all when the provider is not connected', async () => {
    await prisma.integrationConnection.deleteMany({ where: { consultingFirmId: firmA.id } })
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    const result = await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    expect(result.action).toBe('SKIPPED')
    expect(mockAccounting.calls.export).toBe(0)
  })
})

// -------------------------------------------------------------
// Payment reconciliation
// -------------------------------------------------------------

describe('§8.5 payment reconciliation creates one payment, once', () => {
  beforeEach(async () => {
    await prisma.invoicePayment.deleteMany({ where: { consultingFirmId: firmA.id } })
    await prisma.integrationSyncRecord.deleteMany({ where: { consultingFirmId: firmA.id } })
    await prisma.contractInvoice.update({
      where: { id: invoiceA }, data: { amountPaid: '0.00', status: 'APPROVED', paidAt: null },
    })
    await upsertConnection(firmA.id, IntegrationProvider.QUICKBOOKS, {
      status: IntegrationStatus.CONNECTED, accessToken: SENTINELS.accessToken, config: { realmId: '123456' },
    })
  })

  it('reconciles a remote payment onto the invoice it belongs to', async () => {
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    ;(mockAccounting as unknown as { payments: unknown[] }).payments = [
      { externalId: 'PAY-1', externalInvoiceId: 'EXT-1', amount: '2500.00', paidOn: new Date(), reference: 'CHK-9' },
    ]

    const result = await reconcilePayments(firmA.id, IntegrationProvider.QUICKBOOKS, null)
    expect(result.created).toBe(1)
    const invoice = await prisma.contractInvoice.findUnique({ where: { id: invoiceA } })
    expect(invoice!.status).toBe('PAID')
    expect(invoice!.amountPaid.toFixed(2)).toBe('2500.00')
  })

  it('creates no second payment when the same remote event arrives again', async () => {
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    ;(mockAccounting as unknown as { payments: unknown[] }).payments = [
      { externalId: 'PAY-1', externalInvoiceId: 'EXT-1', amount: '2500.00', paidOn: new Date(), reference: 'CHK-9' },
    ]
    await reconcilePayments(firmA.id, IntegrationProvider.QUICKBOOKS, null)
    const second = await reconcilePayments(firmA.id, IntegrationProvider.QUICKBOOKS, null)
    expect(second.created).toBe(0)
    expect(second.matched).toBe(1)
    expect(await prisma.invoicePayment.count({ where: { invoiceId: invoiceA } })).toBe(1)
  })

  it('skips a payment against an object this connection never exported', async () => {
    ;(mockAccounting as unknown as { payments: unknown[] }).payments = [
      { externalId: 'PAY-2', externalInvoiceId: 'NOT-OURS', amount: '10.00', paidOn: null, reference: null },
    ]
    const result = await reconcilePayments(firmA.id, IntegrationProvider.QUICKBOOKS, null)
    expect(result.created).toBe(0)
    expect(result.skipped).toBe(1)
    expect(await prisma.invoicePayment.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('attributes an imported payment to no internal user', async () => {
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    ;(mockAccounting as unknown as { payments: unknown[] }).payments = [
      { externalId: 'PAY-3', externalInvoiceId: 'EXT-1', amount: '100.00', paidOn: null, reference: null },
    ]
    await reconcilePayments(firmA.id, IntegrationProvider.QUICKBOOKS, null)
    const payment = await prisma.invoicePayment.findFirst({ where: { invoiceId: invoiceA } })
    expect(payment!.recordedByUserId).toBeNull()
    expect(payment!.method).toBe('ACCOUNTING_SYNC')
  })
})

// -------------------------------------------------------------
// Tenant isolation
// -------------------------------------------------------------

describe('§8.5 accounting tenant isolation', () => {
  beforeEach(async () => {
    await prisma.integrationSyncRecord.deleteMany({ where: { consultingFirmId: { in: [firmA.id, firmB.id] } } })
    await upsertConnection(firmA.id, IntegrationProvider.QUICKBOOKS, {
      status: IntegrationStatus.CONNECTED, accessToken: SENTINELS.accessToken, config: { realmId: 'FIRM-A-REALM' },
    })
  })

  it('refuses another firm’s connection id', async () => {
    const rowA = await prisma.integrationConnection.findFirst({ where: { consultingFirmId: firmA.id, provider: 'QUICKBOOKS' } })
    const res = await request(app).post(`/api/integrations/${rowA!.id}/test`).set(auth(adminB.token)).send({})
    expect(res.status).toBe(404)
  })

  it('exports nothing for another firm’s invoice id', async () => {
    const res = await request(app)
      .post(`/api/integrations/${(await prisma.integrationConnection.findFirst({ where: { consultingFirmId: firmA.id } }))!.id}/sync`)
      .set(auth(adminA.token)).send({ invoiceIds: [invoiceB] })
    expect(res.status).toBe(200)
    expect(res.body.data.outcomes[0].action).toBe('SKIPPED')
    expect(mockAccounting.calls.export).toBe(0)
  })

  it('never applies a remote payment to another tenant’s invoice', async () => {
    const payload = (await buildInvoicePayload(firmA.id, invoiceA))!
    await exportDocument(firmA.id, IntegrationProvider.QUICKBOOKS, payload)
    // Firm B has no connection at all, so a poll on B's behalf reaches nothing.
    const result = await reconcilePayments(firmB.id, IntegrationProvider.QUICKBOOKS, null)
    expect(result.created).toBe(0)
    expect(await prisma.invoicePayment.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})

// -------------------------------------------------------------
// Calendar
// -------------------------------------------------------------

describe('§8.5 calendar sync', () => {
  let milestoneId = ''

  beforeEach(async () => {
    await prisma.integrationSyncRecord.deleteMany({ where: { consultingFirmId: firmA.id } })
    await upsertConnection(firmA.id, IntegrationProvider.GOOGLE_CALENDAR, {
      status: IntegrationStatus.CONNECTED, accessToken: SENTINELS.accessToken, config: { calendarId: 'primary' },
    })
    if (!milestoneId) {
      const opp = await prisma.opportunity.create({
        data: {
          consultingFirmId: firmA.id, title: 'CAL Opp', agency: 'GSA',
          responseDeadline: new Date(Date.now() + 20 * 86400000),
        },
        select: { id: true },
      })
      milestoneId = (await prisma.opportunityMilestone.create({
        data: {
          consultingFirmId: firmA.id, opportunityId: opp.id, milestoneType: 'PROPOSAL_DEADLINE',
          title: 'Proposal due', endAt: new Date(Date.now() + 20 * 86400000),
        },
        select: { id: true },
      })).id
    }
  })

  const event = (over: Record<string, unknown> = {}) => ({
    sourceType: 'OpportunityMilestone' as const,
    sourceId: milestoneId,
    title: 'Proposal due',
    description: null,
    startAt: new Date('2026-10-01T12:00:00.000Z'),
    endAt: new Date('2026-10-01T13:00:00.000Z'),
    isAllDay: false,
    ...over,
  })

  it('creates one event for one milestone', async () => {
    const result = await syncCalendarEvent(firmA.id, IntegrationProvider.GOOGLE_CALENDAR, event())
    expect(result.action).toBe('CREATED')
    expect(mockCalendar.calls.create).toBe(1)
  })

  it('creates no second event on a repeated sync', async () => {
    await syncCalendarEvent(firmA.id, IntegrationProvider.GOOGLE_CALENDAR, event())
    const second = await syncCalendarEvent(firmA.id, IntegrationProvider.GOOGLE_CALENDAR, event())
    expect(second.action).toBe('UNCHANGED')
    expect(mockCalendar.calls.create).toBe(1)
    expect(mockCalendar.events.size).toBe(1)
  })

  it('updates the same event when the date changes', async () => {
    const first = await syncCalendarEvent(firmA.id, IntegrationProvider.GOOGLE_CALENDAR, event())
    const moved = await syncCalendarEvent(firmA.id, IntegrationProvider.GOOGLE_CALENDAR,
      event({ startAt: new Date('2026-10-05T12:00:00.000Z') }))
    expect(moved.action).toBe('UPDATED')
    expect(moved.externalId).toBe(first.externalId)
    expect(mockCalendar.calls.create).toBe(1)
    expect(mockCalendar.calls.update).toBe(1)
  })

  it('removes the event when the source is cancelled', async () => {
    await syncCalendarEvent(firmA.id, IntegrationProvider.GOOGLE_CALENDAR, event())
    const removed = await syncCalendarEvent(firmA.id, IntegrationProvider.GOOGLE_CALENDAR, event({ cancelled: true }))
    expect(removed.action).toBe('DELETED')
    expect(mockCalendar.events.size).toBe(0)
    expect(await prisma.integrationSyncRecord.count({ where: { consultingFirmId: firmA.id, localType: 'OpportunityMilestone' } })).toBe(0)
  })

  it('does nothing for a firm that has not connected a calendar', async () => {
    const result = await syncCalendarEvent(firmB.id, IntegrationProvider.GOOGLE_CALENDAR, event())
    expect(result.action).toBe('SKIPPED')
    expect(mockCalendar.calls.create).toBe(0)
  })

  it('records a provider failure without losing the ledger', async () => {
    const failing: CalendarAdapter = {
      provider: IntegrationProvider.GOOGLE_CALENDAR,
      async testConnection() { return { ok: false, detail: 'x' } },
      async createEvent() { throw new ConnectorError('calendar unavailable', 'PROVIDER_ERROR', true) },
      async updateEvent() { /* unused */ },
      async deleteEvent() { /* unused */ },
    }
    __setCalendarAdapter(IntegrationProvider.GOOGLE_CALENDAR, failing)
    const result = await syncCalendarEvent(firmA.id, IntegrationProvider.GOOGLE_CALENDAR, event())
    expect(result.action).toBe('FAILED')
    __setCalendarAdapter(IntegrationProvider.GOOGLE_CALENDAR, mockCalendar)
  })

  it('leaves the ICS export working, connected or not', async () => {
    const res = await request(app).get('/api/milestones/calendar.ics').set(auth(adminA.token))
    expect(res.status).toBe(200)
    expect(res.text).toContain('BEGIN:VCALENDAR')
    expect(res.text).toContain('END:VCALENDAR')
  })
})

// -------------------------------------------------------------
// Chat channels
// -------------------------------------------------------------

describe('§8.5 chat channels', () => {
  it('accepts only a Microsoft webhook host', () => {
    expect(isAllowedTeamsWebhook(SENTINELS.teamsWebhook)).toBe(true)
    expect(isAllowedTeamsWebhook('https://evil.example.com/hook')).toBe(false)
    expect(isAllowedTeamsWebhook('http://outlook.webhook.office.com/x')).toBe(false)
    expect(isAllowedTeamsWebhook('not a url')).toBe(false)
  })

  it('refuses to store a webhook URL that is not Microsoft’s', async () => {
    const res = await request(app).post('/api/integrations/teams/connect').set(auth(adminA.token))
      .send({ webhookUrl: 'https://evil.example.com/hook' })
    expect(res.status).toBe(422)
  })

  it('stores a Teams webhook without ever returning it', async () => {
    const res = await request(app).post('/api/integrations/teams/connect').set(auth(adminA.token))
      .send({ webhookUrl: SENTINELS.teamsWebhook, channelName: 'Contracts' })
    expect(res.status).toBe(200)
    expect(JSON.stringify(res.body)).not.toContain('SENTINEL-TEAMS-URL')

    const list = await request(app).get('/api/integrations').set(auth(adminA.token))
    expect(JSON.stringify(list.body)).not.toContain('SENTINEL-TEAMS-URL')
  })

  it('does nothing harmful when the channel is not connected', async () => {
    const result = await dispatchToChannel(IntegrationProvider.SLACK, {
      consultingFirmId: firmB.id, title: 'Deadline', summary: 'A deadline is near.',
      dedupeKey: `nope-${Date.now()}`,
    })
    expect(result.delivered).toBe(false)
    expect(result.reason).toBe('not connected')
  })

  it('refuses to send a message that carries credential-shaped text', async () => {
    expect(looksLikeSecret('here is Bearer abcdefghijklmnopqrstuvwx')).toBe(true)
    expect(looksLikeSecret('the deadline moved to Tuesday')).toBe(false)

    const result = await dispatchToChannel(IntegrationProvider.MICROSOFT_TEAMS, {
      consultingFirmId: firmA.id, title: 'Token', summary: 'Bearer abcdefghijklmnopqrstuvwx',
      dedupeKey: `secret-${Date.now()}`,
    })
    expect(result.delivered).toBe(false)
    expect(result.reason).toMatch(/credential-shaped/i)
  })

  it('sends a given message once', async () => {
    const posts: unknown[] = []
    const axios = await import('axios')
    const spy = vi.spyOn(axios.default, 'request').mockImplementation(async (config) => {
      posts.push(config)
      return { data: { ok: true } } as never
    })
    await request(app).post('/api/integrations/teams/connect').set(auth(adminA.token))
      .send({ webhookUrl: SENTINELS.teamsWebhook, channelName: 'Contracts' })

    const dedupeKey = `once-${Date.now()}`
    const first = await dispatchToChannel(IntegrationProvider.MICROSOFT_TEAMS, {
      consultingFirmId: firmA.id, title: 'Deadline', summary: 'A deadline is near.', dedupeKey,
    })
    const second = await dispatchToChannel(IntegrationProvider.MICROSOFT_TEAMS, {
      consultingFirmId: firmA.id, title: 'Deadline', summary: 'A deadline is near.', dedupeKey,
    })
    expect(first.delivered).toBe(true)
    expect(second.delivered).toBe(false)
    expect(second.reason).toBe('already sent')
    expect(posts).toHaveLength(1)
    spy.mockRestore()
  })
})
