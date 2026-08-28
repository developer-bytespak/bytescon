// =============================================================
// Section 5 Module 8 — Post-Award Contract Management integration tests.
// Contracts, CLINs, modifications (idempotent apply), option periods,
// deliverables (workflow, upcoming/overdue), authz, cross-tenant isolation,
// duplicate prevention, and audit logging. Dates use fixed offsets (controlled).
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
let opportunityId: string

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()
const BASE = '/api/contract-management'

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'PostAward Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'PostAward Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
  const opp = await prisma.opportunity.create({
    data: { consultingFirmId: firm.id, title: 'Awarded Opp', agency: 'GSA', naicsCode: '541512', responseDeadline: new Date(Date.now() + 86_400_000), status: 'AWARDED', solicitationNumber: 'SOL-777', estimatedValue: 500000 },
  })
  opportunityId = opp.id
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(other.id)
  await disconnectDb()
})

describe('Contracts — CRUD, authz, duplicate, cross-tenant', () => {
  let contractId: string

  it('401 unauthenticated, 403 for CONSULTANT create', async () => {
    await request(app).get(BASE).expect(401)
    await request(app).post(BASE).set(H(consultant.token)).send({ contractNumber: 'C1', title: 'x' }).expect(403)
  })

  it('422 on invalid financials (negative) and invalid date range', async () => {
    await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'C1', title: 'x', awardValue: -5 }).expect(422)
    await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'C1', title: 'x', startDate: iso(10), endDate: iso(1) }).expect(422)
  })

  it('ADMIN creates a contract (201) + audit written', async () => {
    const res = await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'FA8600-26-C-0001', title: 'Base Support', agency: 'USAF', awardValue: 1000000, ceilingValue: 2000000, fundedValue: 400000, startDate: iso(-10), endDate: iso(355) }).expect(201)
    contractId = res.body.data.id
    expect(res.body.data.contractNumber).toBe('FA8600-26-C-0001')
    const a = await prisma.auditEvent.findFirst({ where: { consultingFirmId: firm.id, entityType: 'Contract', entityId: contractId } })
    expect(a).toBeTruthy()
  })

  it('creates a contract from an awarded opportunity, prefilled, and prevents a duplicate', async () => {
    const res = await request(app).post(`${BASE}/from-opportunity/${opportunityId}`).set(H(admin.token)).send({}).expect(201)
    expect(res.body.data.opportunityId).toBe(opportunityId)
    expect(res.body.data.title).toBe('Awarded Opp')
    expect(Number(res.body.data.awardValue)).toBe(500000)
    // Duplicate attempt → 409
    await request(app).post(`${BASE}/from-opportunity/${opportunityId}`).set(H(admin.token)).send({}).expect(409)
    await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'DUP', title: 'dup', opportunityId }).expect(409)
  })

  it('reads, updates, filters, sorts, paginates, and archives', async () => {
    await request(app).put(`${BASE}/${contractId}`).set(H(admin.token)).send({ status: 'ACTIVE' }).expect(200)
    const list = await request(app).get(`${BASE}?status=ACTIVE&sortBy=value&sortOrder=desc&page=1&limit=10`).set(H(admin.token)).expect(200)
    expect(list.body.data.some((c: { id: string }) => c.id === contractId)).toBe(true)
    expect(list.body.meta.page).toBe(1)
    const detail = await request(app).get(`${BASE}/${contractId}`).set(H(admin.token)).expect(200)
    expect(detail.body.data.activity.length).toBeGreaterThanOrEqual(1)
    await request(app).post(`${BASE}/${contractId}/archive`).set(H(admin.token)).expect(200)
    const afterArchive = await request(app).get(`${BASE}`).set(H(admin.token)).expect(200)
    expect(afterArchive.body.data.some((c: { id: string }) => c.id === contractId)).toBe(false) // archived hidden by default
  })

  it('cross-tenant: another firm gets 404 on this contract', async () => {
    await request(app).get(`${BASE}/${contractId}`).set(H(otherAdmin.token)).expect(404)
    await request(app).put(`${BASE}/${contractId}`).set(H(otherAdmin.token)).send({ status: 'ACTIVE' }).expect(404)
  })
})

describe('CLINs — dup within contract, same number across contracts, totals', () => {
  let c1: string
  let c2: string
  beforeAll(async () => {
    c1 = (await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'CLIN-C1', title: 'c1' })).body.data.id
    c2 = (await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'CLIN-C2', title: 'c2' })).body.data.id
  })

  it('creates CLINs, rejects a duplicate number in the same contract (409), allows the same number on another contract', async () => {
    await request(app).post(`${BASE}/${c1}/clins`).set(H(admin.token)).send({ clinNumber: '0001', fundedAmount: 100, ceilingAmount: 200 }).expect(201)
    await request(app).post(`${BASE}/${c1}/clins`).set(H(admin.token)).send({ clinNumber: '0001' }).expect(409)
    await request(app).post(`${BASE}/${c2}/clins`).set(H(admin.token)).send({ clinNumber: '0001', fundedAmount: 50 }).expect(201)
  })

  it('derives funded/ceiling totals across CLINs', async () => {
    await request(app).post(`${BASE}/${c1}/clins`).set(H(admin.token)).send({ clinNumber: '0002', fundedAmount: 300, ceilingAmount: 400 }).expect(201)
    const res = await request(app).get(`${BASE}/${c1}/clins`).set(H(admin.token)).expect(200)
    expect(Number(res.body.meta.totalFunded)).toBe(400) // 100 + 300
    expect(Number(res.body.meta.totalCeiling)).toBe(600) // 200 + 400
  })

  it('cross-tenant CLIN access blocked (404)', async () => {
    const clin = await prisma.clin.findFirst({ where: { contractId: c1 } })
    await request(app).put(`${BASE}/clins/${clin!.id}`).set(H(otherAdmin.token)).send({ title: 'x' }).expect(404)
  })
})

describe('Modifications — apply transactional + idempotent', () => {
  let contractId: string
  beforeAll(async () => {
    contractId = (await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'MOD-1', title: 'mod', fundedValue: 100000, ceilingValue: 500000, endDate: iso(100) })).body.data.id
  })

  it('records a modification (dup number rejected), applies it to totals, and is idempotent on retry', async () => {
    const mod = (await request(app).post(`${BASE}/${contractId}/modifications`).set(H(admin.token)).send({ modNumber: 'P00001', fundingChange: 50000, ceilingChange: 100000, endDateChange: iso(200) }).expect(201)).body.data
    await request(app).post(`${BASE}/${contractId}/modifications`).set(H(admin.token)).send({ modNumber: 'P00001' }).expect(409)

    await request(app).post(`${BASE}/modifications/${mod.id}/apply`).set(H(admin.token)).expect(200)
    let contract = (await request(app).get(`${BASE}/${contractId}`).set(H(admin.token))).body.data
    expect(Number(contract.fundedValue)).toBe(150000) // 100k + 50k
    expect(Number(contract.ceilingValue)).toBe(600000) // 500k + 100k

    // Idempotent: a second apply must 409 and must NOT double-apply.
    await request(app).post(`${BASE}/modifications/${mod.id}/apply`).set(H(admin.token)).expect(409)
    contract = (await request(app).get(`${BASE}/${contractId}`).set(H(admin.token))).body.data
    expect(Number(contract.fundedValue)).toBe(150000) // unchanged
  })

  it('void works before apply; cross-tenant apply blocked (404)', async () => {
    const mod = (await request(app).post(`${BASE}/${contractId}/modifications`).set(H(admin.token)).send({ modNumber: 'P00002', fundingChange: 999 })).body.data
    await request(app).post(`${BASE}/modifications/${mod.id}/void`).set(H(admin.token)).expect(200)
    await request(app).post(`${BASE}/modifications/${mod.id}/apply`).set(H(admin.token)).expect(409) // voided cannot apply
    await request(app).post(`${BASE}/modifications/${mod.id}/apply`).set(H(otherAdmin.token)).expect(404)
  })
})

describe('Option periods', () => {
  let contractId: string
  beforeAll(async () => { contractId = (await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'OPT-1', title: 'opt' })).body.data.id })
  it('creates an option period, rejects an invalid date range, updates status', async () => {
    await request(app).post(`${BASE}/${contractId}/options`).set(H(admin.token)).send({ label: 'OY1', startDate: iso(365), endDate: iso(10) }).expect(422)
    const opt = (await request(app).post(`${BASE}/${contractId}/options`).set(H(admin.token)).send({ label: 'OY1', exerciseDeadline: iso(30) }).expect(201)).body.data
    await request(app).put(`${BASE}/options/${opt.id}`).set(H(admin.token)).send({ exerciseStatus: 'PENDING_DECISION' }).expect(200)
  })
})

describe('Deliverables — workflow, upcoming/overdue, authz, cross-tenant', () => {
  let contractId: string
  let overdueId: string
  let upcomingId: string
  beforeAll(async () => {
    contractId = (await request(app).post(BASE).set(H(admin.token)).send({ contractNumber: 'DEL-1', title: 'del' })).body.data.id
    overdueId = (await request(app).post(`${BASE}/${contractId}/deliverables`).set(H(admin.token)).send({ name: 'Monthly Status Report', dueDate: iso(-3) }).expect(201)).body.data.id
    upcomingId = (await request(app).post(`${BASE}/${contractId}/deliverables`).set(H(admin.token)).send({ name: 'Quarterly Review', dueDate: iso(5) }).expect(201)).body.data.id
  })

  it('derives OVERDUE and lists it in the overdue feed; upcoming feed lists the near-due one', async () => {
    const list = await request(app).get(`${BASE}/${contractId}/deliverables`).set(H(admin.token)).expect(200)
    const od = list.body.data.find((d: { id: string }) => d.id === overdueId)
    expect(od.derivedStatus).toBe('OVERDUE')
    const overdue = await request(app).get(`${BASE}/deliverables/overdue`).set(H(admin.token)).expect(200)
    expect(overdue.body.data.some((d: { id: string }) => d.id === overdueId)).toBe(true)
    const upcoming = await request(app).get(`${BASE}/deliverables/upcoming?windowDays=14`).set(H(admin.token)).expect(200)
    expect(upcoming.body.data.some((d: { id: string }) => d.id === upcomingId)).toBe(true)
  })

  it('CONSULTANT is read-only (403 on submit); ADMIN submits then accepts', async () => {
    // Platform authorization model: CONSULTANT team members are read-only on all
    // mutations (enforceTenantScope). Writes require ADMIN.
    await request(app).post(`${BASE}/deliverables/${upcomingId}/submit`).set(H(consultant.token)).send({ attachmentKey: 'uploads/report.pdf' }).expect(403)
    await request(app).post(`${BASE}/deliverables/${upcomingId}/submit`).set(H(admin.token)).send({ attachmentKey: 'uploads/report.pdf' }).expect(200)
    const afterSubmit = await prisma.contractDeliverable.findUnique({ where: { id: upcomingId } })
    expect(afterSubmit?.status).toBe('SUBMITTED')
    expect(afterSubmit?.acceptanceStatus).toBe('PENDING')
    await request(app).post(`${BASE}/deliverables/${upcomingId}/accept`).set(H(consultant.token)).expect(403)
    await request(app).post(`${BASE}/deliverables/${upcomingId}/accept`).set(H(admin.token)).expect(200)
    const accepted = await prisma.contractDeliverable.findUnique({ where: { id: upcomingId } })
    expect(accepted?.status).toBe('ACCEPTED')
  })

  it('rejects an invalid transition (409) and records a rejection with a reason', async () => {
    // overdue is NOT_STARTED → ACCEPTED is invalid
    await request(app).post(`${BASE}/deliverables/${overdueId}/transition`).set(H(admin.token)).send({ status: 'ACCEPTED' }).expect(409)
    // proper path: submit then reject
    await request(app).post(`${BASE}/deliverables/${overdueId}/submit`).set(H(admin.token)).expect(200)
    await request(app).post(`${BASE}/deliverables/${overdueId}/reject`).set(H(admin.token)).send({ reason: 'Missing section 3' }).expect(200)
    const rejected = await prisma.contractDeliverable.findUnique({ where: { id: overdueId } })
    expect(rejected?.status).toBe('REJECTED')
    expect(rejected?.rejectionReason).toBe('Missing section 3')
  })

  it('cross-tenant deliverable access blocked (404)', async () => {
    await request(app).post(`${BASE}/deliverables/${overdueId}/accept`).set(H(otherAdmin.token)).expect(404)
    await request(app).get(`${BASE}/${contractId}/deliverables`).set(H(otherAdmin.token)).expect(404)
  })
})

// §7.5 / §8.3 — deliverable→partner attribution.
//
// This is the only link that puts a deliverable in a subcontractor's portal and
// the only input partner performance counts, so it gets its own coverage: an
// unset value must stay unset, and a partner from another firm must never land
// on a row it does not belong to.
describe('Deliverables — partner attribution', () => {
  let contractId: string
  let deliverableId: string
  let partnerId: string
  let foreignPartnerId: string

  beforeAll(async () => {
    const contract = await prisma.contract.create({
      data: { consultingFirmId: firm.id, contractNumber: 'ATTR-1', title: 'Attribution contract' },
    })
    contractId = contract.id
    const partner = await prisma.partner.create({ data: { consultingFirmId: firm.id, name: 'Attributed Sub LLC' } })
    partnerId = partner.id
    const foreign = await prisma.partner.create({ data: { consultingFirmId: other.id, name: 'Other Firm Sub LLC' } })
    foreignPartnerId = foreign.id
  })

  it('creates unattributed by default', async () => {
    const res = await request(app).post(`${BASE}/${contractId}/deliverables`).set(H(admin.token))
      .send({ name: 'Monthly report', cdrlNumber: 'A100', dueDate: iso(10) }).expect(201)
    deliverableId = res.body.data.id
    expect(res.body.data.partnerId).toBeNull()
  })

  it('attributes a deliverable to a partner and returns the partner name', async () => {
    const res = await request(app).put(`${BASE}/deliverables/${deliverableId}`).set(H(admin.token))
      .send({ partnerId }).expect(200)
    expect(res.body.data.partnerId).toBe(partnerId)
    expect(res.body.data.partner.name).toBe('Attributed Sub LLC')
  })

  it('names the attribution change in the audit trail', async () => {
    const events = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firm.id, entityId: deliverableId, entityType: 'ContractDeliverable' },
      orderBy: { createdAt: 'desc' }, take: 5,
    })
    expect(events.some((e) => e.rationale?.includes('Attributed to partner Attributed Sub LLC'))).toBe(true)
  })

  it('refuses a partner belonging to another firm', async () => {
    await request(app).put(`${BASE}/deliverables/${deliverableId}`).set(H(admin.token))
      .send({ partnerId: foreignPartnerId }).expect(422)
    const row = await prisma.contractDeliverable.findUnique({ where: { id: deliverableId } })
    expect(row!.partnerId).toBe(partnerId)
  })

  it('clears attribution back to null', async () => {
    const res = await request(app).put(`${BASE}/deliverables/${deliverableId}`).set(H(admin.token))
      .send({ partnerId: null }).expect(200)
    expect(res.body.data.partnerId).toBeNull()
  })

  it('is ADMIN-only', async () => {
    await request(app).put(`${BASE}/deliverables/${deliverableId}`).set(H(consultant.token))
      .send({ partnerId }).expect(403)
  })

  it('lists the partner on the contract detail payload', async () => {
    await request(app).put(`${BASE}/deliverables/${deliverableId}`).set(H(admin.token)).send({ partnerId }).expect(200)
    const res = await request(app).get(`${BASE}/${contractId}`).set(H(admin.token)).expect(200)
    const row = res.body.data.deliverables.find((d: { id: string }) => d.id === deliverableId)
    expect(row.partner.name).toBe('Attributed Sub LLC')
  })
})

// §8.2 — the task-order tier.
//
// A task order is a CLIN with children rather than its own model, so these
// assert the tier is settable, that a parent must live on the same contract,
// and that a CLIN cannot be hung off itself.
describe('CLINs — task-order tier', () => {
  let contractId: string
  let otherContractId: string
  let taskOrderId: string

  beforeAll(async () => {
    const a = await prisma.contract.create({ data: { consultingFirmId: firm.id, contractNumber: 'TIER-1', title: 'Tiered contract' } })
    const b = await prisma.contract.create({ data: { consultingFirmId: firm.id, contractNumber: 'TIER-2', title: 'Other contract' } })
    contractId = a.id
    otherContractId = b.id
  })

  it('defaults a CLIN to the CLIN tier', async () => {
    const res = await request(app).post(`${BASE}/${contractId}/clins`).set(H(admin.token))
      .send({ clinNumber: '0001', title: 'Base', fundedAmount: 1000 }).expect(201)
    expect(res.body.data.clinLevel).toBe('CLIN')
  })

  it('creates a task order and a CLIN beneath it', async () => {
    const to = await request(app).post(`${BASE}/${contractId}/clins`).set(H(admin.token))
      .send({ clinNumber: 'TO-01', title: 'Task order one', clinLevel: 'TASK_ORDER' }).expect(201)
    taskOrderId = to.body.data.id
    expect(to.body.data.clinLevel).toBe('TASK_ORDER')

    const child = await request(app).post(`${BASE}/${contractId}/clins`).set(H(admin.token))
      .send({ clinNumber: 'TO-01AA', clinLevel: 'CLIN', parentClinId: taskOrderId }).expect(201)
    expect(child.body.data.parentClinId).toBe(taskOrderId)
  })

  it('refuses a parent from another contract', async () => {
    const foreign = await request(app).post(`${BASE}/${otherContractId}/clins`).set(H(admin.token))
      .send({ clinNumber: 'X-01' }).expect(201)
    await request(app).post(`${BASE}/${contractId}/clins`).set(H(admin.token))
      .send({ clinNumber: 'BAD-01', parentClinId: foreign.body.data.id }).expect(422)
  })

  it('refuses reparenting onto another contract on update', async () => {
    const foreign = await prisma.clin.findFirst({ where: { contractId: otherContractId }, select: { id: true } })
    await request(app).put(`${BASE}/clins/${taskOrderId}`).set(H(admin.token))
      .send({ parentClinId: foreign!.id }).expect(422)
  })

  it('refuses a CLIN as its own parent', async () => {
    await request(app).put(`${BASE}/clins/${taskOrderId}`).set(H(admin.token))
      .send({ parentClinId: taskOrderId }).expect(422)
  })

  it('rejects a tier that is not one of the three', async () => {
    await request(app).post(`${BASE}/${contractId}/clins`).set(H(admin.token))
      .send({ clinNumber: 'BAD-02', clinLevel: 'EPIC' }).expect(422)
  })
})
