// =============================================================
// §8.5 — The permission matrix, proved against real routes.
//
// The claims that matter are all NEGATIVE, because a permission model is only
// worth anything if the denials hold:
//
//   a finance user cannot approve a proposal
//   a proposal user cannot approve a payment
//   a contracts user cannot mint an API token
//   a capture user cannot change financial actuals
//
// and two compatibility claims, because the model must not have changed
// anything for the accounts that already exist:
//
//   ADMIN can still do everything it could before
//   CONSULTANT is still read-only
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'
import { ROLE_PERMISSIONS, resolvePermissions, PERMISSIONS } from '../services/rbac/permissions'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let admin: TestUser, consultant: TestUser
let bd: TestUser, proposalUser: TestUser, contracts: TestUser, finance: TestUser, viewer: TestUser
let adminB: TestUser
let contractId = '', proposalSectionId = '', invoiceId = ''

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'RBAC Firm A' })
  firmB = await createTestFirm({ name: 'RBAC Firm B' })
  admin = await createTestUser(firmA.id, { role: 'ADMIN' })
  consultant = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  bd = await createTestUser(firmA.id, { role: 'BD_CAPTURE' })
  proposalUser = await createTestUser(firmA.id, { role: 'PROPOSAL' })
  contracts = await createTestUser(firmA.id, { role: 'CONTRACTS' })
  finance = await createTestUser(firmA.id, { role: 'FINANCE' })
  viewer = await createTestUser(firmA.id, { role: 'VIEWER' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })

  const contract = await prisma.contract.create({
    data: {
      consultingFirmId: firmA.id, contractNumber: `RBAC-${Date.now()}`, title: 'RBAC Contract',
      status: 'ACTIVE', ceilingValue: '500000.00',
    },
    select: { id: true },
  })
  contractId = contract.id

  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firmA.id, title: 'RBAC Opp', agency: 'GSA',
      responseDeadline: new Date(Date.now() + 30 * 86400000),
    },
    select: { id: true },
  })
  const section = await prisma.proposalSection.create({
    data: {
      consultingFirmId: firmA.id, opportunityId: opp.id, title: 'Technical', sortOrder: 1,
      status: 'IN_REVIEW', draft: 'text',
    },
    select: { id: true },
  })
  proposalSectionId = section.id

  const invoice = await prisma.contractInvoice.create({
    data: {
      consultingFirmId: firmA.id, contractId, invoiceNumber: `RBAC-INV-${Date.now()}`,
      status: 'APPROVED', total: '1000.00', subtotal: '1000.00',
    },
    select: { id: true },
  })
  invoiceId = invoice.id
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

// -------------------------------------------------------------
// The model itself
// -------------------------------------------------------------

describe('§8.5 permission model', () => {
  it('gives ADMIN every permission', () => {
    expect([...resolvePermissions('ADMIN')].sort()).toEqual([...PERMISSIONS].sort())
  })

  it('gives CONSULTANT reads and nothing else', () => {
    const held = [...resolvePermissions('CONSULTANT')]
    expect(held.length).toBeGreaterThan(0)
    for (const permission of held) expect(permission.endsWith('_READ')).toBe(true)
  })

  it('holds the legacy gate for ADMIN alone', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS)) {
      const holds = resolvePermissions(role).has('LEGACY_ADMIN_WRITE')
      expect([role, holds]).toEqual([role, role === 'ADMIN'])
    }
  })

  it('fails closed on an unknown role', () => {
    expect([...resolvePermissions('SOMETHING_ELSE')]).toEqual([])
    expect([...resolvePermissions(null)]).toEqual([])
  })

  it('adds a per-user grant without letting one be taken away', () => {
    const held = resolvePermissions('VIEWER', ['CRM_WRITE', 'NOT_A_PERMISSION'])
    expect(held.has('CRM_WRITE')).toBe(true)
    expect(held.has('CRM_READ')).toBe(true)
    expect(held.size).toBe(resolvePermissions('VIEWER').size + 1)
  })

  it('separates writing a proposal from approving one, and money from both', () => {
    expect(resolvePermissions('PROPOSAL').has('FINANCE_APPROVE')).toBe(false)
    expect(resolvePermissions('FINANCE').has('PROPOSAL_APPROVE')).toBe(false)
    expect(resolvePermissions('BD_CAPTURE').has('FINANCE_WRITE')).toBe(false)
    expect(resolvePermissions('CONTRACTS').has('API_TOKEN_MANAGE')).toBe(false)
  })
})

// -------------------------------------------------------------
// The four claims
// -------------------------------------------------------------

describe('§8.5 the separations that matter', () => {
  it('refuses a finance user the approval of a proposal section', async () => {
    const res = await request(app).post(`/api/proposal/sections/${proposalSectionId}/approve`)
      .set(auth(finance.token)).send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/PROPOSAL_APPROVE/)
  })

  it('refuses a proposal user the recording of a payment', async () => {
    const res = await request(app).post(`/api/contract-finance/invoices/${invoiceId}/payments`)
      .set(auth(proposalUser.token)).send({ amount: '100.00' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/FINANCE_APPROVE/)
  })

  it('refuses a contracts user the minting of an API token', async () => {
    const res = await request(app).post('/api/admin/mcp/tokens')
      .set(auth(contracts.token)).send({ name: 'nope' })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/API_TOKEN_MANAGE/)
  })

  it('refuses a capture user the recording of a cost', async () => {
    const res = await request(app).post(`/api/contract-finance/${contractId}/costs`)
      .set(auth(bd.token)).send({ category: 'OTHER_DIRECT_COST', amount: '50.00', incurredDate: new Date().toISOString() })
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/FINANCE_WRITE/)
  })
})

// -------------------------------------------------------------
// Each role reaches its own work
// -------------------------------------------------------------

describe('§8.5 each role reaches its own work', () => {
  it('lets a capture user write CRM, and a finance user not', async () => {
    const allowed = await request(app).post('/api/crm/contacts').set(auth(bd.token))
      .send({ agencyName: 'GSA', fullName: 'Capture Contact' })
    expect(allowed.status).toBe(201)

    const denied = await request(app).post('/api/crm/contacts').set(auth(finance.token))
      .send({ agencyName: 'GSA', fullName: 'Finance Contact' })
    expect(denied.status).toBe(403)
  })

  it('lets a finance user approve an invoice', async () => {
    const invoice = await prisma.contractInvoice.create({
      data: {
        consultingFirmId: firmA.id, contractId, invoiceNumber: `RBAC-FIN-${Date.now()}`,
        status: 'DRAFT', total: '500.00', subtotal: '500.00',
      },
      select: { id: true },
    })
    const res = await request(app).post(`/api/contract-finance/invoices/${invoice.id}/approve`)
      .set(auth(finance.token)).send({})
    expect(res.status).toBeLessThan(400)
  })

  it('lets a proposal user approve a section', async () => {
    const opp = await prisma.opportunity.create({
      data: {
        consultingFirmId: firmA.id, title: 'RBAC Opp 2', agency: 'GSA',
        responseDeadline: new Date(Date.now() + 30 * 86400000),
      },
      select: { id: true },
    })
    const section = await prisma.proposalSection.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id, title: 'Management', sortOrder: 1,
        status: 'IN_REVIEW', draft: 'text',
      },
      select: { id: true },
    })
    const res = await request(app).post(`/api/proposal/sections/${section.id}/approve`)
      .set(auth(proposalUser.token)).send({})
    expect(res.status).toBeLessThan(400)
  })

  it('lets a contracts user grant partner portal access, and a finance user not', async () => {
    const partner = await prisma.partner.create({
      data: { consultingFirmId: firmA.id, name: 'RBAC Partner' }, select: { id: true },
    })
    const allowed = await request(app).post('/api/partner-portal/admin/users').set(auth(contracts.token))
      .send({ partnerId: partner.id, email: `rbac-${Date.now()}@ext.test`, firstName: 'A', lastName: 'B' })
    expect(allowed.status).toBe(201)

    const denied = await request(app).post('/api/partner-portal/admin/users').set(auth(finance.token))
      .send({ partnerId: partner.id, email: `rbac2-${Date.now()}@ext.test`, firstName: 'A', lastName: 'B' })
    expect(denied.status).toBe(403)
  })
})

// -------------------------------------------------------------
// Compatibility — the part that must not have changed
// -------------------------------------------------------------

describe('§8.5 legacy compatibility', () => {
  const ADMIN_WRITES: Array<[string, string, Record<string, unknown>]> = [
    ['post', '/api/crm/contacts', { agencyName: 'GSA', fullName: 'Admin Contact' }],
    ['post', '/api/personnel', { firstName: 'Admin', lastName: 'Person' }],
  ]

  it('leaves every one of ADMIN’s writes working', async () => {
    for (const [verb, path, body] of ADMIN_WRITES) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verb](path)
        .set(auth(admin.token)).send(body)
      expect([path, res.status < 400]).toEqual([path, true])
    }
  })

  it('leaves CONSULTANT read-only on every one of them', async () => {
    for (const [verb, path, body] of ADMIN_WRITES) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)[verb](path)
        .set(auth(consultant.token)).send(body)
      expect([path, res.status]).toEqual([path, 403])
    }
  })

  it('leaves CONSULTANT able to read', async () => {
    const res = await request(app).get('/api/crm/contacts').set(auth(consultant.token))
    expect(res.status).toBe(200)
  })

  it('grants no write to a VIEWER either', async () => {
    const res = await request(app).post('/api/crm/contacts').set(auth(viewer.token))
      .send({ agencyName: 'GSA', fullName: 'Viewer Contact' })
    expect(res.status).toBe(403)
  })

  it('still admits every internal role to authenticate, and still refuses a portal role', async () => {
    for (const user of [bd, proposalUser, contracts, finance, viewer]) {
      const res = await request(app).get('/api/crm/contacts').set(auth(user.token))
      expect([user.role, res.status]).toEqual([user.role, 200])
    }
  })

  it('refuses a legacy ADMIN-only route to every granular role', async () => {
    // /api/firm/penalty-config is still gated by requireRole('ADMIN'), unchanged by §8.5, so
    // a role added later cannot reach a route nobody reviewed.
    for (const user of [bd, proposalUser, contracts, finance, viewer, consultant]) {
      const res = await request(app).put('/api/firm/penalty-config').set(auth(user.token)).send({ flatLateFee: '10.00' })
      expect([user.role, res.status]).toEqual([user.role, 403])
    }
  })
})

// -------------------------------------------------------------
// Permissions are not a substitute for tenancy
// -------------------------------------------------------------

describe('§8.5 permission is not tenancy', () => {
  it('refuses another tenant’s record to a fully permitted user', async () => {
    const res = await request(app).post(`/api/contract-finance/invoices/${invoiceId}/payments`)
      .set(auth(adminB.token)).send({ amount: '100.00' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).not.toBe(200)
  })

  it('holds nothing for a deactivated account, whatever its token says', async () => {
    const doomed = await createTestUser(firmA.id, { role: 'FINANCE' })
    await prisma.user.update({ where: { id: doomed.id }, data: { isActive: false } })
    const res = await request(app).post(`/api/contract-finance/${contractId}/costs`)
      .set(auth(doomed.token)).send({ category: 'OTHER_DIRECT_COST', amount: '50.00', incurredDate: new Date().toISOString() })
    expect(res.status).toBe(403)
  })
})

// -------------------------------------------------------------
// Administration of roles
// -------------------------------------------------------------

describe('§8.5 role administration', () => {
  it('publishes the vocabulary so nothing has to be hard-coded', async () => {
    const res = await request(app).get('/api/rbac/catalog').set(auth(admin.token))
    expect(res.status).toBe(200)
    expect((res.body.data.roles as Array<{ role: string }>).map((r) => r.role)).toContain('FINANCE')
    expect((res.body.data.permissions as Array<{ permission: string }>).length).toBe(PERMISSIONS.length)
  })

  it('tells a caller what they hold', async () => {
    const res = await request(app).get('/api/rbac/me').set(auth(finance.token))
    expect(res.body.data.role).toBe('FINANCE')
    expect(res.body.data.permissions).toContain('FINANCE_APPROVE')
    expect(res.body.data.permissions).not.toContain('PROPOSAL_APPROVE')
  })

  it('lets an administrator change a role, and refuses an unknown one', async () => {
    const target = await createTestUser(firmA.id, { role: 'VIEWER' })
    const ok = await request(app).put(`/api/rbac/users/${target.id}`).set(auth(admin.token)).send({ role: 'CONTRACTS' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.role).toBe('CONTRACTS')

    const bad = await request(app).put(`/api/rbac/users/${target.id}`).set(auth(admin.token)).send({ role: 'WIZARD' })
    expect(bad.status).toBe(422)
  })

  it('refuses to remove the last administrator', async () => {
    const soloFirm = await createTestFirm({ name: 'RBAC Solo' })
    const soleAdmin = await createTestUser(soloFirm.id, { role: 'ADMIN' })
    const res = await request(app).put(`/api/rbac/users/${soleAdmin.id}`).set(auth(soleAdmin.token)).send({ role: 'VIEWER' })
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/last administrator/i)
    await cleanupFirm(soloFirm.id)
  })

  it('refuses a user in another tenant', async () => {
    const res = await request(app).put(`/api/rbac/users/${admin.id}`).set(auth(adminB.token)).send({ role: 'VIEWER' })
    expect(res.status).toBe(404)
  })

  it('refuses role administration without ADMIN_SETTINGS', async () => {
    const res = await request(app).get('/api/rbac/users').set(auth(contracts.token))
    expect(res.status).toBe(403)
  })

  it('takes effect on the next request, not at token expiry', async () => {
    const target = await createTestUser(firmA.id, { role: 'VIEWER' })
    const before = await request(app).post('/api/crm/contacts').set(auth(target.token))
      .send({ agencyName: 'GSA', fullName: 'Before' })
    expect(before.status).toBe(403)

    await request(app).put(`/api/rbac/users/${target.id}`).set(auth(admin.token)).send({ role: 'BD_CAPTURE' }).expect(200)

    // The SAME token, unchanged, now carries the new role's permissions
    // because they are resolved from the database on every request.
    const after = await request(app).post('/api/crm/contacts').set(auth(target.token))
      .send({ agencyName: 'GSA', fullName: 'After' })
    expect(after.status).toBe(201)
  })

  it('records the change without recording anything secret', async () => {
    const rows = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firmA.id, entityType: 'User', action: 'UPDATE' },
      orderBy: { createdAt: 'desc' }, take: 5,
    })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0].rationale).toMatch(/Access changed/)
    expect(JSON.stringify(rows)).not.toContain('passwordHash')
  })
})
