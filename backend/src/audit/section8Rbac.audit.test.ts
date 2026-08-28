// =============================================================
// §8 FINAL ACCEPTANCE — RBAC coverage.
//
// Two halves.
//
// STATIC: every mutating route in a Section 8 router must declare a
// permission. A route added later with no guard, or guarded only by a role
// name, fails this suite the moment it is written — which is the only way a
// permission model stays true after the slice that created it.
//
// BEHAVIOURAL: the money gate that this audit found broken. Approving a
// ContractCost is what makes it count toward actual cost, so a general write
// permission must not be able to do it.
// =============================================================
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'

const ROOT = path.resolve(__dirname, '../..')

/** The routers Section 8 owns or migrated. */
const SECTION8_ROUTERS = [
  'crm.ts', 'erp.ts', 'personnel.ts', 'knowledge.ts', 'partnerPortal.ts',
  'integrations.ts', 'esign.ts', 'sso.ts', 'rbac.ts', 'mcp.ts', 'contractFinance.ts',
]

/**
 * Mutating routes that legitimately carry no permission, each for a stated
 * reason. Anything not on this list must declare one.
 */
const UNGUARDED_BY_DESIGN: Record<string, string> = {
  "partnerPortal.ts POST /auth/accept-invite": 'external, pre-session: the invite token is the credential',
  "partnerPortal.ts POST /auth/login": 'external, pre-session',
  "partnerPortal.ts POST /auth/forgot-password": 'external, pre-session, deliberately incurious',
  "partnerPortal.ts POST /auth/reset-password": 'external, pre-session: the reset token is the credential',
  "partnerPortal.ts POST /auth/mfa/verify": 'external, gated by the scoped challenge token',
  "partnerPortal.ts POST /flow-downs/:id/acknowledge": 'external partner acting on its own grant',
  "partnerPortal.ts POST /invoices": 'external partner submitting its own invoice',
  "partnerPortal.ts POST /documents": 'external partner uploading against its own grant',
  "partnerPortal.ts POST /personnel-contributions": 'external partner offering its own staff',
  "partnerPortal.ts POST /deliverables/:id/submissions": 'external partner responding to its own deliverable',
  "partnerPortal.ts POST /deliverable-submissions/:id/submit": 'external partner submitting its own response',
  "partnerPortal.ts POST /profile/change-requests": 'external partner proposing a change to its own record',
  "partnerPortal.ts POST /mfa/enroll": 'external partner securing its own account',
  "partnerPortal.ts POST /mfa/enroll/verify": 'external partner securing its own account',
  "partnerPortal.ts POST /mfa/disable": 'external partner securing its own account',
}

interface RouteDecl { file: string; method: string; routePath: string; line: string }

function mutatingRoutes(file: string): RouteDecl[] {
  const source = readFileSync(path.join(ROOT, 'src/routes', file), 'utf8')
  const out: RouteDecl[] = []
  for (const match of source.matchAll(/^\s*(?:router|adminRouter|admin|portal|callbackRouter)\.(post|put|patch|delete)\(\s*'([^']+)'([^\n]*)/gm)) {
    out.push({ file, method: match[1].toUpperCase(), routePath: match[2], line: match[0] })
  }
  return out
}

describe('§8 acceptance: every Section 8 mutation declares a permission', () => {
  it('leaves no internal mutating route guarded by nothing', () => {
    const gaps: string[] = []
    for (const file of SECTION8_ROUTERS) {
      const source = readFileSync(path.join(ROOT, 'src/routes', file), 'utf8')
      // A router-level gate covers every route in the file.
      const routerLevelGuard = /router\.use\([^)]*requirePermission\(/.test(source)
      if (routerLevelGuard) continue

      for (const route of mutatingRoutes(file)) {
        const key = `${file} ${route.method} ${route.routePath}`
        if (key in UNGUARDED_BY_DESIGN) continue
        if (/requirePermission\(|requireAnyPermission\(/.test(route.line)) continue
        gaps.push(key)
      }
    }
    expect(gaps).toEqual([])
  })

  it('never guards a Section 8 mutation on a role name alone', () => {
    const roleOnly: string[] = []
    for (const file of SECTION8_ROUTERS) {
      for (const route of mutatingRoutes(file)) {
        if (/requireRole\(/.test(route.line)) roleOnly.push(`${file} ${route.method} ${route.routePath}`)
      }
    }
    expect(roleOnly).toEqual([])
  })

  it('separates approving money from writing it, on every money route', () => {
    const finance = readFileSync(path.join(ROOT, 'src/routes/contractFinance.ts'), 'utf8')
    const erp = readFileSync(path.join(ROOT, 'src/routes/erp.ts'), 'utf8')

    // Each of these ENDS a money decision and must require FINANCE_APPROVE.
    for (const [source, marker] of [
      [finance, "/invoices/:id/:action(approve|submit|void)"],
      [finance, "/invoices/:id/payments"],
      [finance, "/payments/:id/void"],
      [finance, "/time/:id/approve"],
      [finance, "/:contractId/funding"],
      [erp, "/budgets/:id/activate"],
      [erp, "/purchase-orders/:id/transition"],
      [erp, "/subcontract-invoices/:id/transition"],
    ] as Array<[string, string]>) {
      // The mutating declaration specifically — several of these paths also
      // have a GET, which needs no approval permission.
      const line = source.split('\n').find((l) => l.includes(marker) && /\.(post|put|patch|delete)\(/.test(l))
      expect([marker, line?.includes('FINANCE_APPROVE')]).toEqual([marker, true])
    }
  })
})

// -------------------------------------------------------------
// The defect this audit found
// -------------------------------------------------------------

let app: Express
let firm: TestFirm
let admin: TestUser, writer: TestUser, approver: TestUser
let contractId = ''

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'RBACAUDIT Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  // A user who may record money but not approve it. VIEWER plus one additive
  // grant is the sharpest possible probe of the separation.
  writer = await createTestUser(firm.id, { role: 'VIEWER', extraPermissions: ['FINANCE_WRITE'] })
  approver = await createTestUser(firm.id, { role: 'FINANCE' })

  contractId = (await prisma.contract.create({
    data: {
      consultingFirmId: firm.id, contractNumber: `RBACAUDIT-${Date.now()}`, title: 'Audit Contract',
      status: 'ACTIVE', ceilingValue: '100000.00',
    },
    select: { id: true },
  })).id
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

async function makeCost(status = 'DRAFT') {
  return prisma.contractCost.create({
    data: {
      consultingFirmId: firm.id, contractId, category: 'OTHER_DIRECT_COST',
      amount: '250.00', status, incurredDate: new Date(),
    },
    select: { id: true },
  })
}

describe('§8 acceptance: approving a cost is a money gate, not a write', () => {
  it('lets a finance writer submit a cost', async () => {
    const cost = await makeCost('DRAFT')
    const res = await request(app).post(`/api/contract-finance/costs/${cost.id}/submit`).set(auth(writer.token)).send({})
    expect(res.status).toBeLessThan(400)
  })

  it('refuses that same writer the approval', async () => {
    const cost = await makeCost('SUBMITTED')
    const res = await request(app).post(`/api/contract-finance/costs/${cost.id}/approve`).set(auth(writer.token)).send({})
    expect(res.status).toBe(403)
    expect(res.body.error).toMatch(/FINANCE_APPROVE/)

    // And the cost did NOT become an actual.
    const row = await prisma.contractCost.findUnique({ where: { id: cost.id } })
    expect(row!.status).toBe('SUBMITTED')
    expect(row!.approvedAt).toBeNull()
  })

  it('refuses that writer the rejection and the void as well', async () => {
    for (const action of ['reject', 'void']) {
      const cost = await makeCost('SUBMITTED')
      const res = await request(app).post(`/api/contract-finance/costs/${cost.id}/${action}`)
        .set(auth(writer.token)).send({ reason: 'no' })
      expect([action, res.status]).toEqual([action, 403])
    }
  })

  it('lets a finance approver approve it', async () => {
    const cost = await makeCost('SUBMITTED')
    const res = await request(app).post(`/api/contract-finance/costs/${cost.id}/approve`).set(auth(approver.token)).send({})
    expect(res.status).toBeLessThan(400)
    const row = await prisma.contractCost.findUnique({ where: { id: cost.id } })
    expect(row!.status).toBe('APPROVED')
    expect(row!.approvedByUserId).toBe(approver.id)
  })

  it('leaves ADMIN able to do both, exactly as before', async () => {
    const cost = await makeCost('DRAFT')
    expect((await request(app).post(`/api/contract-finance/costs/${cost.id}/submit`).set(auth(admin.token)).send({})).status).toBeLessThan(400)
    expect((await request(app).post(`/api/contract-finance/costs/${cost.id}/approve`).set(auth(admin.token)).send({})).status).toBeLessThan(400)
  })

  it('refuses a user with neither permission at every step', async () => {
    const viewer = await createTestUser(firm.id, { role: 'VIEWER' })
    const cost = await makeCost('SUBMITTED')
    for (const action of ['submit', 'approve', 'reject', 'void']) {
      const res = await request(app).post(`/api/contract-finance/costs/${cost.id}/${action}`)
        .set(auth(viewer.token)).send({ reason: 'no' })
      expect([action, res.status]).toEqual([action, 403])
    }
  })
})
