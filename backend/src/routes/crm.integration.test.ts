// =============================================================
// §8.1 — CRM integration tests against a real database.
//
// The security-relevant assertions here are the tenant-isolation and IDOR
// blocks: Firm A must not be able to read, write, link to, or even learn of
// the existence of Firm B's CRM records.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firmA: TestFirm
let firmB: TestFirm
let userA: TestUser
let userB: TestUser
let oppA: { id: string }
let oppB: { id: string }
let partnerA: { id: string }

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'CRM Firm A' })
  firmB = await createTestFirm({ name: 'CRM Firm B' })
  userA = await createTestUser(firmA.id, { role: 'ADMIN' })
  userB = await createTestUser(firmB.id, { role: 'ADMIN' })

  oppA = await prisma.opportunity.create({
    data: {
      consultingFirmId: firmA.id,
      samNoticeId: `crm-test-a-${Date.now()}`,
      title: 'CRM Test Opportunity A',
      agency: 'DEPT OF TEST',
      responseDeadline: new Date(Date.now() + 30 * 86400000),
    },
    select: { id: true },
  })
  oppB = await prisma.opportunity.create({
    data: {
      consultingFirmId: firmB.id,
      samNoticeId: `crm-test-b-${Date.now()}`,
      title: 'CRM Test Opportunity B',
      agency: 'DEPT OF TEST',
      responseDeadline: new Date(Date.now() + 30 * 86400000),
    },
    select: { id: true },
  })
  partnerA = await prisma.partner.create({
    data: { consultingFirmId: firmA.id, name: 'CRM Test Partner A' },
    select: { id: true },
  })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('§8.1 CRM — offices and contacts', () => {
  let officeId: string
  let contactId: string

  it('creates an office and rejects a duplicate for the same agency', async () => {
    const res = await request(app).post('/api/crm/offices').set(auth(userA.token))
      .send({ agencyName: 'DEPT OF TEST', officeName: 'Regional Office 1', officeSymbol: 'RO-1' })
    expect(res.status).toBe(201)
    officeId = res.body.data.id

    const dup = await request(app).post('/api/crm/offices').set(auth(userA.token))
      .send({ agencyName: 'DEPT OF TEST', officeName: 'Regional Office 1' })
    // ValidationError is 422 across this platform, not 400.
    expect(dup.status).toBe(422)
  })

  it('creates a contact linked to that office', async () => {
    const res = await request(app).post('/api/crm/contacts').set(auth(userA.token)).send({
      agencyName: 'DEPT OF TEST',
      agencyOfficeId: officeId,
      fullName: 'Dana Reyes',
      title: 'Contracting Officer',
      contactRole: 'CONTRACTING_OFFICER',
      email: 'dana.reyes@test.gov',
    })
    expect(res.status).toBe(201)
    expect(res.body.data.contactRole).toBe('CONTRACTING_OFFICER')
    contactId = res.body.data.id
  })

  it('supports every government contact role', async () => {
    const roles = ['CONTRACT_SPECIALIST', 'COR', 'PROGRAM_MANAGER', 'SMALL_BUSINESS_SPECIALIST', 'TECHNICAL_LEAD', 'OTHER']
    for (const role of roles) {
      const res = await request(app).post('/api/crm/contacts').set(auth(userA.token))
        .send({ agencyName: 'DEPT OF TEST', fullName: `Role ${role}`, contactRole: role })
      expect(res.status).toBe(201)
      expect(res.body.data.contactRole).toBe(role)
    }
  })

  it('groups agencies without creating an agency registry', async () => {
    const res = await request(app).get('/api/crm/agencies').set(auth(userA.token))
    expect(res.status).toBe(200)
    const row = res.body.data.items.find((i: { agencyName: string }) => i.agencyName === 'DEPT OF TEST')
    expect(row.officeCount).toBeGreaterThanOrEqual(1)
    expect(row.contactCount).toBeGreaterThanOrEqual(1)
    expect(res.body.data.note).toMatch(/no separate agency registry/i)
  })

  it('refuses an office id belonging to another firm (IDOR)', async () => {
    const res = await request(app).post('/api/crm/contacts').set(auth(userB.token))
      .send({ agencyName: 'DEPT OF TEST', fullName: 'Cross Tenant', agencyOfficeId: officeId })
    expect(res.status).toBe(404)
  })

  it('does not leak firm A contacts to firm B', async () => {
    const list = await request(app).get('/api/crm/contacts').set(auth(userB.token))
    expect(list.status).toBe(200)
    expect(list.body.data.map((c: { id: string }) => c.id)).not.toContain(contactId)

    const direct = await request(app).get(`/api/crm/contacts/${contactId}`).set(auth(userB.token))
    expect(direct.status).toBe(404)

    const write = await request(app).put(`/api/crm/contacts/${contactId}`).set(auth(userB.token)).send({ fullName: 'Hijacked' })
    expect(write.status).toBe(404)

    const fresh = await prisma.governmentContact.findUnique({ where: { id: contactId }, select: { fullName: true } })
    expect(fresh?.fullName).toBe('Dana Reyes')
  })
})

describe('§8.1 CRM — activities', () => {
  let contactId: string

  beforeAll(async () => {
    const c = await request(app).post('/api/crm/contacts').set(auth(userA.token))
      .send({ agencyName: 'DEPT OF TEST', fullName: 'Activity Contact', contactRole: 'COR' })
    contactId = c.body.data.id
  })

  it('records a call and a meeting as activity types, not separate tables', async () => {
    for (const activityType of ['CALL', 'MEETING']) {
      const res = await request(app).post('/api/crm/activities').set(auth(userA.token)).send({
        activityType,
        occurredAt: new Date().toISOString(),
        subject: `${activityType} with CO`,
        governmentContactId: contactId,
        durationMinutes: 30,
      })
      expect(res.status).toBe(201)
      expect(res.body.data.activityType).toBe(activityType)
    }
    const tables = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('crm_calls','crm_meetings')`,
    )
    expect(tables).toHaveLength(0)
  })

  it('links an activity to an opportunity', async () => {
    const res = await request(app).post('/api/crm/activities').set(auth(userA.token)).send({
      activityType: 'INDUSTRY_DAY',
      occurredAt: new Date().toISOString(),
      subject: 'Industry day attendance',
      governmentContactId: contactId,
      opportunityId: oppA.id,
      participants: ['Dana Reyes', 'Our capture lead'],
    })
    expect(res.status).toBe(201)
    expect(res.body.data.opportunityId).toBe(oppA.id)
    expect(res.body.data.participants).toHaveLength(2)
  })

  it('refuses an activity that is linked to nothing', async () => {
    const res = await request(app).post('/api/crm/activities').set(auth(userA.token))
      .send({ activityType: 'NOTE', occurredAt: new Date().toISOString(), subject: 'Floating note' })
    expect(res.status).toBe(422)
  })

  it('refuses to attach another firm’s opportunity (IDOR)', async () => {
    const res = await request(app).post('/api/crm/activities').set(auth(userA.token)).send({
      activityType: 'CALL',
      occurredAt: new Date().toISOString(),
      subject: 'Cross tenant attempt',
      governmentContactId: contactId,
      opportunityId: oppB.id,
    })
    expect(res.status).toBe(404)
  })

  it('does not leak activities across firms', async () => {
    const res = await request(app).get('/api/crm/activities').set(auth(userB.token))
    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(0)
  })
})

describe('§8.1 CRM — follow-up lifecycle', () => {
  let followUpId: string
  let contactId: string

  beforeAll(async () => {
    const c = await request(app).post('/api/crm/contacts').set(auth(userA.token))
      .send({ agencyName: 'DEPT OF TEST', fullName: 'Follow Up Contact' })
    contactId = c.body.data.id
  })

  it('creates a follow-up owned by the caller', async () => {
    const res = await request(app).post('/api/crm/follow-ups').set(auth(userA.token)).send({
      title: 'Call CO next Tuesday',
      dueAt: new Date(Date.now() + 5 * 86400000).toISOString(),
      priority: 'HIGH',
      governmentContactId: contactId,
      opportunityId: oppA.id,
    })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('OPEN')
    expect(res.body.data.ownerUserId).toBe(userA.id)
    followUpId = res.body.data.id
  })

  it('refuses an illegal transition and names the legal ones', async () => {
    const res = await request(app).post(`/api/crm/follow-ups/${followUpId}/transition`).set(auth(userA.token))
      .send({ status: 'OPEN' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_TRANSITION')
    expect(res.body.allowedNextStates).toEqual(expect.arrayContaining(['IN_PROGRESS', 'DONE', 'CANCELLED']))
  })

  it('completes through a legal path and stamps who closed it', async () => {
    const step = await request(app).post(`/api/crm/follow-ups/${followUpId}/transition`).set(auth(userA.token))
      .send({ status: 'IN_PROGRESS' })
    expect(step.status).toBe(200)

    const done = await request(app).post(`/api/crm/follow-ups/${followUpId}/transition`).set(auth(userA.token))
      .send({ status: 'DONE' })
    expect(done.status).toBe(200)
    expect(done.body.data.completedAt).toBeTruthy()
    expect(done.body.data.completedByUserId).toBe(userA.id)
  })

  it('treats DONE as terminal', async () => {
    const res = await request(app).post(`/api/crm/follow-ups/${followUpId}/transition`).set(auth(userA.token))
      .send({ status: 'OPEN' })
    expect(res.status).toBe(422)
    expect(res.body.allowedNextStates).toEqual([])
  })

  it('does not let another firm transition it (IDOR)', async () => {
    const other = await request(app).post('/api/crm/follow-ups').set(auth(userA.token))
      .send({ title: 'Firm A only', dueAt: new Date(Date.now() + 86400000).toISOString() })
    const res = await request(app).post(`/api/crm/follow-ups/${other.body.data.id}/transition`).set(auth(userB.token))
      .send({ status: 'DONE' })
    expect(res.status).toBe(404)
  })
})

describe('§8.1 CRM — reminder dedupe reuses the notification service', () => {
  it('sends one notification per follow-up per day however often the scan runs', async () => {
    const { notifyDueFollowUps } = await import('../services/crm/followUpReminders')
    const created = await request(app).post('/api/crm/follow-ups').set(auth(userA.token))
      .send({ title: 'Dedupe probe', dueAt: new Date(Date.now() + 3600_000).toISOString() })
    const id = created.body.data.id

    await notifyDueFollowUps()
    await notifyDueFollowUps()
    await notifyDueFollowUps()

    const notes = await prisma.userNotification.findMany({
      where: { consultingFirmId: firmA.id, type: 'CRM_FOLLOW_UP', dedupeKey: { contains: id } },
    })
    expect(notes).toHaveLength(1)
  })
})

describe('§8.1 CRM — relationship strength', () => {
  it('reports NO_DATA for a contact with no interactions', async () => {
    const c = await request(app).post('/api/crm/contacts').set(auth(userA.token))
      .send({ agencyName: 'DEPT OF TEST', fullName: 'Untouched Contact' })
    const res = await request(app).get(`/api/crm/relationship/contact/${c.body.data.id}`).set(auth(userA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.state).toBe('NO_DATA')
    expect(res.body.data.score).toBeNull()
  })

  it('moves off NO_DATA once real interactions exist, with evidence', async () => {
    const c = await request(app).post('/api/crm/contacts').set(auth(userA.token))
      .send({ agencyName: 'DEPT OF TEST', fullName: 'Engaged Contact' })
    const contactId = c.body.data.id
    for (const t of ['CALL', 'MEETING', 'CAPABILITY_BRIEFING']) {
      await request(app).post('/api/crm/activities').set(auth(userA.token))
        .send({ activityType: t, occurredAt: new Date().toISOString(), subject: t, governmentContactId: contactId })
    }
    const res = await request(app).get(`/api/crm/relationship/contact/${contactId}`).set(auth(userA.token))
    expect(res.body.data.state).not.toBe('NO_DATA')
    expect(res.body.data.evidence.length).toBeGreaterThan(0)
    expect(res.body.data.meaningfulInteractions).toBe(3)
  })

  it('refuses to score another firm’s contact (IDOR)', async () => {
    const c = await request(app).post('/api/crm/contacts').set(auth(userA.token))
      .send({ agencyName: 'DEPT OF TEST', fullName: 'Scored Contact' })
    const res = await request(app).get(`/api/crm/relationship/contact/${c.body.data.id}`).set(auth(userB.token))
    expect(res.status).toBe(404)
  })
})

describe('§8.1 CRM — partner CRM extends the existing Partner', () => {
  it('supports multiple contacts on one partner without a second company record', async () => {
    const before = await prisma.partner.count({ where: { consultingFirmId: firmA.id } })
    for (const name of ['Priya Nair', 'Tom Alvarez']) {
      const res = await request(app).post('/api/crm/partner-contacts').set(auth(userA.token))
        .send({ partnerId: partnerA.id, fullName: name, isPrimary: name === 'Priya Nair' })
      expect(res.status).toBe(201)
    }
    const after = await prisma.partner.count({ where: { consultingFirmId: firmA.id } })
    expect(after).toBe(before)

    const list = await request(app).get(`/api/crm/partner-contacts?partnerId=${partnerA.id}`).set(auth(userA.token))
    expect(list.body.data).toHaveLength(2)
    expect(list.body.data[0].isPrimary).toBe(true)
  })

  it('returns partner activity history and relationship strength together', async () => {
    await request(app).post('/api/crm/activities').set(auth(userA.token)).send({
      activityType: 'MEETING',
      occurredAt: new Date().toISOString(),
      subject: 'Teaming discussion',
      partnerId: partnerA.id,
      opportunityId: oppA.id,
    })
    const res = await request(app).get(`/api/crm/partners/${partnerA.id}`).set(auth(userA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.contacts).toHaveLength(2)
    expect(res.body.data.activities.length).toBeGreaterThanOrEqual(1)
    expect(res.body.data.relationship.state).toBeDefined()
    // Existing teaming structures are still exposed, untouched.
    expect(res.body.data).toHaveProperty('arrangements')
    expect(res.body.data).toHaveProperty('performanceRecords')
  })

  it('refuses another firm’s partner (IDOR)', async () => {
    const res = await request(app).get(`/api/crm/partners/${partnerA.id}`).set(auth(userB.token))
    expect(res.status).toBe(404)

    const write = await request(app).post('/api/crm/partner-contacts').set(auth(userB.token))
      .send({ partnerId: partnerA.id, fullName: 'Cross tenant contact' })
    expect(write.status).toBe(404)
  })
})

describe('§8.1 CRM — opportunity context composes, never duplicates', () => {
  it('returns agency, contacts, activities and next follow-up for an opportunity', async () => {
    const res = await request(app).get(`/api/crm/opportunity-context/${oppA.id}`).set(auth(userA.token))
    expect(res.status).toBe(200)
    expect(res.body.data.agencyName).toBe('DEPT OF TEST')
    expect(Array.isArray(res.body.data.contacts)).toBe(true)
    expect(Array.isArray(res.body.data.activities)).toBe(true)
    // Weighted value stays with the portfolio service.
    expect(res.body.data).not.toHaveProperty('weightedValue')
    expect(res.body.data.valueNote).toMatch(/portfolio service/i)
  })

  it('refuses another firm’s opportunity (IDOR)', async () => {
    const res = await request(app).get(`/api/crm/opportunity-context/${oppB.id}`).set(auth(userA.token))
    expect(res.status).toBe(404)
  })
})

describe('§8.1 — existing pipeline is not replaced', () => {
  it('logs an activity against a pursuit without changing its stage', async () => {
    const pursuit = await prisma.bidPursuit.create({
      data: { consultingFirmId: firmA.id, opportunityId: oppA.id, pipelineStage: 'CAPTURE', priority: 'HIGH' },
    })
    await request(app).post('/api/crm/activities').set(auth(userA.token)).send({
      activityType: 'CALL',
      occurredAt: new Date().toISOString(),
      subject: 'Capture call',
      bidPursuitId: pursuit.id,
    })
    const after = await prisma.bidPursuit.findUnique({ where: { id: pursuit.id } })
    expect(after?.pipelineStage).toBe('CAPTURE')
    expect(after?.priority).toBe('HIGH')
    // The existing activity clock is refreshed rather than shadowed by a new one.
    expect(after!.lastActivityAt.getTime()).toBeGreaterThanOrEqual(pursuit.lastActivityAt.getTime())
  })
})

// =============================================================
// §8.1 follow-up — the agency-name mismatch that hid a contact from its own
// opportunity, reported from the running panel.
// =============================================================
describe('§8.1 opportunity context reconciles SAM’s agency format', () => {
  const SAM_RAW = 'ENERGY, DEPARTMENT OF.ENERGY, DEPARTMENT OF.EM-PORTSMOUTH/PADUCAH PROJECT OFC'
  let samOppId = ''

  beforeAll(async () => {
    const opp = await prisma.opportunity.create({
      data: {
        consultingFirmId: firmA.id, title: 'DOE Cybersecurity Support', agency: SAM_RAW,
        responseDeadline: new Date(Date.now() + 30 * 86400000),
      },
      select: { id: true },
    })
    samOppId = opp.id

    // A user types the agency the way a person says it.
    await request(app).post('/api/crm/contacts').set(auth(userA.token))
      .send({ agencyName: 'Department of Energy', fullName: 'John Test', contactRole: 'CONTRACTING_OFFICER' })
      .expect(201)
    await request(app).post('/api/crm/offices').set(auth(userA.token))
      .send({ agencyName: 'Department of Energy', officeName: 'EM-Portsmouth' })
      .expect(201)
  })

  it('finds a contact typed as "Department of Energy" on a SAM-formatted opportunity', async () => {
    const res = await request(app).get(`/api/crm/opportunity-context/${samOppId}`).set(auth(userA.token))
    expect(res.status).toBe(200)
    expect((res.body.data.contacts as Array<{ fullName: string }>).map((c) => c.fullName)).toContain('John Test')
  })

  it('finds the office recorded under the readable agency name too', async () => {
    const res = await request(app).get(`/api/crm/opportunity-context/${samOppId}`).set(auth(userA.token))
    expect((res.body.data.offices as Array<{ officeName: string }>).map((o) => o.officeName)).toContain('EM-Portsmouth')
  })

  it('parses SAM’s dotted path into something a person can read', async () => {
    const res = await request(app).get(`/api/crm/opportunity-context/${samOppId}`).set(auth(userA.token))
    expect(res.body.data.agencyPath.department).toBe('Department of Energy')
    expect(res.body.data.agencyPath.office).toBe('EM-PORTSMOUTH/PADUCAH PROJECT OFC')
    // The raw value is still returned unchanged — nothing SAM ingested is rewritten.
    expect(res.body.data.agencyName).toBe(SAM_RAW)
  })

  it('does NOT pull in a contact from a different agency', async () => {
    await request(app).post('/api/crm/contacts').set(auth(userA.token))
      .send({ agencyName: 'Department of Defense', fullName: 'Wrong Agency Person' })
      .expect(201)
    const res = await request(app).get(`/api/crm/opportunity-context/${samOppId}`).set(auth(userA.token))
    expect((res.body.data.contacts as Array<{ fullName: string }>).map((c) => c.fullName))
      .not.toContain('Wrong Agency Person')
  })

  it('keeps another firm’s contact out, whatever the agency name says', async () => {
    await prisma.governmentContact.create({
      data: { consultingFirmId: firmB.id, agencyName: 'Department of Energy', fullName: 'Firm B Person' },
    })
    const res = await request(app).get(`/api/crm/opportunity-context/${samOppId}`).set(auth(userA.token))
    expect(JSON.stringify(res.body)).not.toContain('Firm B Person')
  })

  it('groups one agency into one card however it was spelled', async () => {
    await request(app).post('/api/crm/contacts').set(auth(userA.token))
      .send({ agencyName: 'DEPARTMENT OF ENERGY', fullName: 'Second Spelling' }).expect(201)
    const res = await request(app).get('/api/crm/agencies').set(auth(userA.token))
    const energyCards = (res.body.data.items as Array<{ agencyName: string; contactCount: number }>)
      .filter((a) => a.agencyName.toUpperCase().replace(/[^A-Z]/g, '').includes('DEPARTMENTOFENERGY'))
    expect(energyCards).toHaveLength(1)
    expect(energyCards[0].contactCount).toBeGreaterThanOrEqual(2)
  })
})
