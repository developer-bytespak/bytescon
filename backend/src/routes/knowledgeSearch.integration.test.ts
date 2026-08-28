// =============================================================
// §8.4 — Knowledge search.
//
// Two firms hold assets with the SAME distinctive search term, so every
// assertion doubles as a tenant-isolation assertion: a query that reaches
// across firms would return twice what it should, in a way a single-firm
// fixture would never reveal.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser, adminB: TestUser
let draftResumeId = ''

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const TERM = 'Zephyrite'
const search = (token: string, q: string, params: Record<string, string> = {}) =>
  request(app).get('/api/knowledge/search').set(auth(token)).query({ q, ...params })

async function seedFirm(firm: TestFirm, suffix: string) {
  await prisma.firmCapability.create({
    data: { consultingFirmId: firm.id, name: `${TERM} cyber defence ${suffix}`, description: 'Managed detection.', verification: 'VERIFIED' },
  })
  await prisma.capabilityNarrative.create({
    data: { consultingFirmId: firm.id, title: `${TERM} narrative ${suffix}`, tags: [TERM] },
  })
  await prisma.pastPerformanceRecord.create({
    data: {
      consultingFirmId: firm.id, contractNumber: `PP-${suffix}-1`, customerName: `${TERM} Agency ${suffix}`,
      contractTitle: `${TERM} support ${suffix}`, scopeSummary: 'Round-the-clock operations.', cparsRating: 'VERY_GOOD',
    },
  })
  const person = await prisma.personnel.create({
    data: { consultingFirmId: firm.id, firstName: TERM, lastName: `Analyst${suffix}`, jobTitle: 'Senior Analyst' },
    select: { id: true },
  })
  await prisma.personnelLaborQualification.create({
    data: { consultingFirmId: firm.id, personnelId: person.id, laborCategory: `${TERM} Engineer`, verification: 'VERIFIED' },
  })
  const approved = await prisma.personnelResume.create({
    data: {
      consultingFirmId: firm.id, personnelId: person.id, versionNumber: 1,
      status: 'APPROVED', title: `${TERM} resume ${suffix}`, approvedAt: new Date(),
    },
    select: { id: true },
  })
  const draft = await prisma.personnelResume.create({
    data: {
      consultingFirmId: firm.id, personnelId: person.id, versionNumber: 2,
      status: 'DRAFT', title: `${TERM} draft resume ${suffix}`,
    },
    select: { id: true },
  })
  await prisma.documentTemplate.create({
    data: {
      consultingFirmId: firm.id, title: `${TERM} teaming agreement ${suffix}`, category: 'TEAMING',
      fileName: 't.docx', fileType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileSize: 10, storageKey: `k-${suffix}`,
    },
  })
  await prisma.standingDocument.create({
    data: { consultingFirmId: firm.id, category: 'CERTIFICATION', name: `${TERM} SDVOSB letter ${suffix}`, approvedForReuse: true },
  })
  await prisma.firmCapability.create({
    data: { consultingFirmId: firm.id, name: `${TERM} archived capability ${suffix}`, isArchived: true },
  })
  return { approvedResumeId: approved.id, draftResumeId: draft.id }
}

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'KS Firm A' })
  firmB = await createTestFirm({ name: 'KS Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
  const a = await seedFirm(firmA, 'A')
  await seedFirm(firmB, 'B')
  draftResumeId = a.draftResumeId
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('§8.4 knowledge search finds each asset type', () => {
  it('returns a hit in every domain, and only this firm’s', async () => {
    const res = await search(adminA.token, TERM, { limit: '100' })
    expect(res.status).toBe(200)
    const types = res.body.data.totalByType as Record<string, number>
    for (const t of ['CAPABILITY', 'CAPABILITY_NARRATIVE', 'PAST_PERFORMANCE', 'PERSONNEL', 'PERSONNEL_RESUME', 'TEMPLATE', 'STANDING_DOCUMENT']) {
      expect(types[t]).toBe(1)
    }
    // Every fixture title ends with its firm's suffix, so a leak would show up
    // as a title ending in B.
    for (const r of res.body.data.results as Array<{ title: string }>) {
      expect(r.title.endsWith('A')).toBe(true)
    }
  })

  it('normalizes every result into the same shape', async () => {
    const res = await search(adminA.token, TERM, { limit: '100' })
    for (const r of res.body.data.results as Array<Record<string, unknown>>) {
      expect(typeof r.type).toBe('string')
      expect(typeof r.id).toBe('string')
      expect(typeof r.title).toBe('string')
      expect(typeof r.sourceRoute).toBe('string')
      expect(typeof r.evidenceState).toBe('string')
      expect(typeof r.updatedAt).toBe('string')
    }
  })

  it('states plainly that it is a text search, not an AI one', async () => {
    const res = await search(adminA.token, TERM)
    expect(res.body.data.method).toMatch(/database text search/i)
    expect(res.body.data.method).toMatch(/not a semantic or AI search/i)
  })
})

describe('§8.4 knowledge search isolation and honesty', () => {
  it('returns nothing across tenants for a term only the other firm’s assets carry', async () => {
    const res = await search(adminB.token, 'AnalystA')
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(0)
  })

  it('hides a draft resume, and shows it only when archived records are asked for', async () => {
    const normal = await search(adminA.token, 'draft resume')
    expect((normal.body.data.results as Array<{ id: string }>).some((r) => r.id === draftResumeId)).toBe(false)
    const all = await search(adminA.token, 'draft resume', { includeArchived: 'true' })
    expect((all.body.data.results as Array<{ id: string }>).some((r) => r.id === draftResumeId)).toBe(true)
  })

  it('hides an archived capability by default', async () => {
    const normal = await search(adminA.token, 'archived capability')
    expect(normal.body.data.total).toBe(0)
    const all = await search(adminA.token, 'archived capability', { includeArchived: 'true' })
    expect(all.body.data.total).toBe(1)
  })

  it('reports approval state rather than implying it', async () => {
    const res = await search(adminA.token, TERM, { types: 'PERSONNEL' })
    const person = res.body.data.results[0] as { evidenceState: string }
    expect(person.evidenceState).toContain('APPROVED_RESUME')
    expect(person.evidenceState).toContain('1 verified qualification')
  })
})

describe('§8.4 knowledge search filtering and paging', () => {
  it('filters by result type', async () => {
    const res = await search(adminA.token, TERM, { types: 'TEMPLATE,STANDING_DOCUMENT' })
    const types = new Set((res.body.data.results as Array<{ type: string }>).map((r) => r.type))
    expect([...types].sort()).toEqual(['STANDING_DOCUMENT', 'TEMPLATE'])
  })

  it('refuses an unknown type instead of quietly dropping it', async () => {
    const res = await search(adminA.token, TERM, { types: 'TEMPLATE,NONSENSE' })
    expect(res.status).toBe(422)
  })

  it('pages deterministically without repeating a row', async () => {
    const first = await search(adminA.token, TERM, { limit: '3', offset: '0' })
    const second = await search(adminA.token, TERM, { limit: '3', offset: '3' })
    expect(first.body.data.results).toHaveLength(3)
    expect(first.body.data.total).toBe(7)
    const ids = new Set([...first.body.data.results, ...second.body.data.results].map((r: { id: string }) => r.id))
    expect(ids.size).toBe(first.body.data.results.length + second.body.data.results.length)
  })

  it('returns an empty result set for a term nobody uses', async () => {
    const res = await search(adminA.token, 'qqzzxx-nothing-matches')
    expect(res.status).toBe(200)
    expect(res.body.data.total).toBe(0)
    expect(res.body.data.results).toEqual([])
  })

  it('matches a partial word', async () => {
    const res = await search(adminA.token, 'Zephyr', { limit: '100' })
    expect(res.body.data.total).toBe(7)
  })

  it('requires a search term', async () => {
    const res = await request(app).get('/api/knowledge/search').set(auth(adminA.token))
    expect(res.status).toBe(422)
  })

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get('/api/knowledge/search').query({ q: TERM })
    expect(res.status).toBe(401)
  })
})
