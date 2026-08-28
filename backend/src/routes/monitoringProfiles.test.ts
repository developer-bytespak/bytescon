// =============================================================
// §5.1 Saved Monitoring Profiles integration tests — CRUD, duplicate, apply
// (count reuses the live filter builder), activate/deactivate, archive/restore,
// invalid filters, alert preference, name uniqueness, authz + cross-tenant.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'
import { createTestOpportunity } from '../test-utils/factories'

let app: Express
let firm: TestFirm
let admin: TestUser
let consultant: TestUser
let other: TestFirm
let otherAdmin: TestUser

const H = (t: string) => ({ Authorization: `Bearer ${t}` })
const BASE = '/api/monitoring-profiles'

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Profiles Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
  consultant = await createTestUser(firm.id, { role: 'CONSULTANT' })
  other = await createTestFirm({ name: 'Profiles Other' })
  otherAdmin = await createTestUser(other.id, { role: 'ADMIN' })
  // Two live opportunities for firm: one Navy 541512, one Army 541330.
  await createTestOpportunity(firm.id, { title: 'Navy Radar', agency: 'Department of the Navy', naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * 86_400_000) })
  await createTestOpportunity(firm.id, { title: 'Army Logistics', agency: 'Department of the Army', naicsCode: '541330', responseDeadline: new Date(Date.now() + 30 * 86_400_000) })
})
afterAll(async () => { await cleanupFirm(firm.id); await cleanupFirm(other.id); await disconnectDb() })

describe('create + validation + authz', () => {
  it('creates a profile (ADMIN) with a validated filter set', async () => {
    const res = await request(app).post(BASE).set(H(admin.token)).send({ name: 'Navy IT', description: 'Navy 5415xx', filters: { naicsCode: '5415', agency: 'Navy' }, alertFrequency: 'DAILY' }).expect(201)
    expect(res.body.data.name).toBe('Navy IT')
    expect(res.body.data.alertFrequency).toBe('DAILY')
    expect(res.body.data.isActive).toBe(true)
  })
  it('rejects malformed filters (unknown key, bad NAICS, inverted value range)', async () => {
    await request(app).post(BASE).set(H(admin.token)).send({ name: 'Bad1', filters: { bogus: 'x' } }).expect(422)
    await request(app).post(BASE).set(H(admin.token)).send({ name: 'Bad2', filters: { naicsCode: 'ABC' } }).expect(422)
    await request(app).post(BASE).set(H(admin.token)).send({ name: 'Bad3', filters: { estimatedValueMin: 9000, estimatedValueMax: 100 } }).expect(422)
  })
  it('rejects a duplicate name (409) and a missing name (400)', async () => {
    await request(app).post(BASE).set(H(admin.token)).send({ name: 'Navy IT', filters: {} }).expect(409)
    await request(app).post(BASE).set(H(admin.token)).send({ filters: {} }).expect(422)
  })
  it('forbids a CONSULTANT from creating (read-only)', async () => {
    await request(app).post(BASE).set(H(consultant.token)).send({ name: 'X', filters: {} }).expect(403)
  })
})

describe('list + read', () => {
  it('lists the firm profiles (read allowed for any role)', async () => {
    const res = await request(app).get(BASE).set(H(consultant.token)).expect(200)
    expect(res.body.data.some((p: { name: string }) => p.name === 'Navy IT')).toBe(true)
  })
})

describe('apply (count) reuses the live search filters', () => {
  it('counts opportunities matching the profile filters', async () => {
    const create = await request(app).post(BASE).set(H(admin.token)).send({ name: 'Navy only', filters: { naicsCode: '5415' } }).expect(201)
    const res = await request(app).get(`${BASE}/${create.body.data.id}/count`).set(H(admin.token)).expect(200)
    expect(res.body.data.count).toBe(1) // only the Navy 541512 opp
    // cached on the profile
    const reload = await request(app).get(`${BASE}/${create.body.data.id}`).set(H(admin.token)).expect(200)
    expect(reload.body.data.lastResultCount).toBe(1)
  })
})

describe('update / duplicate / activate / archive', () => {
  let id: string
  it('updates name, filters and alert frequency', async () => {
    const c = await request(app).post(BASE).set(H(admin.token)).send({ name: 'Editable', filters: { agency: 'Navy' }, alertFrequency: 'WEEKLY' }).expect(201)
    id = c.body.data.id
    const res = await request(app).put(`${BASE}/${id}`).set(H(admin.token)).send({ name: 'Edited', alertFrequency: 'INSTANT', filters: { agency: 'Army' } }).expect(200)
    expect(res.body.data.name).toBe('Edited')
    expect(res.body.data.alertFrequency).toBe('INSTANT')
    expect((res.body.data.filters as { agency: string }).agency).toBe('Army')
  })
  it('rejects an empty update payload (400)', async () => {
    await request(app).put(`${BASE}/${id}`).set(H(admin.token)).send({}).expect(422)
  })
  it('duplicates a profile with a unique "(copy)" name', async () => {
    const res = await request(app).post(`${BASE}/${id}/duplicate`).set(H(admin.token)).expect(201)
    expect(res.body.data.name).toMatch(/\(copy\)/)
    expect(res.body.data.id).not.toBe(id)
  })
  it('activates / deactivates', async () => {
    const off = await request(app).patch(`${BASE}/${id}/active`).set(H(admin.token)).send({ isActive: false }).expect(200)
    expect(off.body.data.isActive).toBe(false)
    await request(app).patch(`${BASE}/${id}/active`).set(H(admin.token)).send({ isActive: 'nope' }).expect(422)
  })
  it('archives (hidden by default) and restores', async () => {
    await request(app).post(`${BASE}/${id}/archive`).set(H(admin.token)).expect(200)
    const list = await request(app).get(BASE).set(H(admin.token)).expect(200)
    expect(list.body.data.some((p: { id: string }) => p.id === id)).toBe(false)
    const withArchived = await request(app).get(`${BASE}?includeArchived=true`).set(H(admin.token)).expect(200)
    expect(withArchived.body.data.some((p: { id: string }) => p.id === id)).toBe(true)
    await request(app).post(`${BASE}/${id}/restore`).set(H(admin.token)).expect(200)
    const relist = await request(app).get(BASE).set(H(admin.token)).expect(200)
    expect(relist.body.data.some((p: { id: string }) => p.id === id)).toBe(true)
  })
  it('forbids CONSULTANT writes on update/archive', async () => {
    await request(app).put(`${BASE}/${id}`).set(H(consultant.token)).send({ name: 'Nope' }).expect(403)
    await request(app).post(`${BASE}/${id}/archive`).set(H(consultant.token)).expect(403)
  })
})

describe('tenant isolation', () => {
  it('returns 404 for another firm profile and never lists it', async () => {
    const mine = await request(app).post(BASE).set(H(admin.token)).send({ name: 'Isolated', filters: {} }).expect(201)
    await request(app).get(`${BASE}/${mine.body.data.id}`).set(H(otherAdmin.token)).expect(404)
    await request(app).put(`${BASE}/${mine.body.data.id}`).set(H(otherAdmin.token)).send({ name: 'hax' }).expect(404)
    await request(app).get(`${BASE}/${mine.body.data.id}/count`).set(H(otherAdmin.token)).expect(404)
    const otherList = await request(app).get(BASE).set(H(otherAdmin.token)).expect(200)
    expect(otherList.body.data.some((p: { id: string }) => p.id === mine.body.data.id)).toBe(false)
  })
})
