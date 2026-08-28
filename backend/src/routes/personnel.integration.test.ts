// =============================================================
// §8.3 — Personnel & resume library integration tests.
//
// The assertions that matter: an approved resume is immutable, nothing about a
// person is inferred, only approved evidence may back a proposal, and Firm A
// cannot reach Firm B's people even with valid ids.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import type { Express } from 'express'
import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let userA: TestUser, userB: TestUser, consultantA: TestUser
let proposalA: { id: string }

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'KP Firm A' })
  firmB = await createTestFirm({ name: 'KP Firm B' })
  userA = await createTestUser(firmA.id, { role: 'ADMIN' })
  userB = await createTestUser(firmB.id, { role: 'ADMIN' })
  consultantA = await createTestUser(firmA.id, { role: 'CONSULTANT' })

  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firmA.id, samNoticeId: `kp-${Date.now()}`, title: 'KP Opp',
      agency: 'DEPT OF TEST', responseDeadline: new Date(Date.now() + 30 * 86400000),
    },
    select: { id: true },
  })
  proposalA = await prisma.proposal.create({
    data: { consultingFirmId: firmA.id, opportunityId: opp.id, title: 'KP Proposal' },
    select: { id: true },
  })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('§8.3 personnel — business identity separate from the account', () => {
  let personId: string

  it('creates personnel with no user account at all', async () => {
    const res = await request(app).post('/api/personnel').set(auth(userA.token))
      .send({ firstName: 'Jane', lastName: 'Doe', jobTitle: 'Senior Cyber Engineer', employmentType: 'CONSULTANT' })
    expect(res.status).toBe(201)
    expect(res.body.data.userId).toBeNull()
    personId = res.body.data.id
  })

  it('never infers years of experience from a job title', async () => {
    const p = await prisma.personnel.findUnique({ where: { id: personId } })
    expect(p!.yearsExperience).toBeNull()
  })

  it('imports from a user account only when explicitly asked, one at a time', async () => {
    const before = await prisma.personnel.count({ where: { consultingFirmId: firmA.id } })
    const res = await request(app).post(`/api/personnel/import-from-user/${consultantA.id}`).set(auth(userA.token)).send({})
    expect(res.status).toBe(201)
    expect(res.body.data.source).toBe('IMPORTED_FROM_USER')
    // One import created exactly one record — never one per User on boot.
    expect(await prisma.personnel.count({ where: { consultingFirmId: firmA.id } })).toBe(before + 1)

    const dup = await request(app).post(`/api/personnel/import-from-user/${consultantA.id}`).set(auth(userA.token)).send({})
    expect(dup.status).toBe(422)
  })

  it('survives its linked account being deactivated', async () => {
    const linked = await prisma.personnel.findFirst({ where: { consultingFirmId: firmA.id, userId: consultantA.id } })
    await prisma.user.update({ where: { id: consultantA.id }, data: { isActive: false } })
    const still = await prisma.personnel.findUnique({ where: { id: linked!.id } })
    expect(still).not.toBeNull()
    await prisma.user.update({ where: { id: consultantA.id }, data: { isActive: true } })
  })

  it('archives rather than deletes', async () => {
    const p = await request(app).post('/api/personnel').set(auth(userA.token))
      .send({ firstName: 'Archie', lastName: 'Veed' })
    const res = await request(app).post(`/api/personnel/${p.body.data.id}/archive`).set(auth(userA.token)).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.isArchived).toBe(true)
    expect(await prisma.personnel.findUnique({ where: { id: p.body.data.id } })).not.toBeNull()
  })

  it('refuses another firm’s personnel on read and write (IDOR)', async () => {
    expect((await request(app).get(`/api/personnel/${personId}`).set(auth(userB.token))).status).toBe(404)
    expect((await request(app).put(`/api/personnel/${personId}`).set(auth(userB.token)).send({ firstName: 'Hijack' })).status).toBe(404)
    const list = await request(app).get('/api/personnel').set(auth(userB.token))
    expect(list.body.data.map((r: { id: string }) => r.id)).not.toContain(personId)
    expect((await prisma.personnel.findUnique({ where: { id: personId } }))!.firstName).toBe('Jane')
  })
})

describe('§8.3 labour qualification is established, never inferred', () => {
  let personId: string
  let qualId: string

  beforeAll(async () => {
    const p = await request(app).post('/api/personnel').set(auth(userA.token))
      .send({ firstName: 'Qual', lastName: 'Person', jobTitle: 'Senior Cyber Analyst' })
    personId = p.body.data.id
  })

  it('records a category as UNVERIFIED even when the job title matches it', async () => {
    const res = await request(app).post(`/api/personnel/${personId}/qualifications`).set(auth(userA.token))
      .send({ laborCategory: 'Senior Cyber Analyst' })
    expect(res.status).toBe(201)
    expect(res.body.data.verification).toBe('UNVERIFIED')
    qualId = res.body.data.id
  })

  it('requires a human to verify, and records who did', async () => {
    const res = await request(app).post(`/api/personnel/qualifications/${qualId}/verify`).set(auth(userA.token))
      .send({ verification: 'VERIFIED', evidence: 'CISSP on file, 8 years on cyber task orders.' })
    expect(res.status).toBe(200)
    expect(res.body.data.verifiedByUserId).toBe(userA.id)
    expect(res.body.data.verifiedAt).toBeTruthy()
  })

  it('refuses a duplicate category for the same person', async () => {
    const res = await request(app).post(`/api/personnel/${personId}/qualifications`).set(auth(userA.token))
      .send({ laborCategory: 'Senior Cyber Analyst' })
    expect(res.status).toBe(422)
  })
})

describe('§8.3 resume versioning and approval', () => {
  let personId: string
  let v1: string
  let v2: string

  beforeAll(async () => {
    const p = await request(app).post('/api/personnel').set(auth(userA.token))
      .send({ firstName: 'Resume', lastName: 'Owner' })
    personId = p.body.data.id
  })

  it('starts every version as a DRAFT', async () => {
    const res = await request(app).post(`/api/personnel/${personId}/resumes`).set(auth(userA.token))
      .send({ title: 'v1', content: { summary: 'Ten years of federal cyber work.', skills: ['SIEM'] } })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('DRAFT')
    expect(res.body.data.versionNumber).toBe(1)
    v1 = res.body.data.id
  })

  it('allows editing a draft', async () => {
    const res = await request(app).put(`/api/personnel/resumes/${v1}`).set(auth(userA.token))
      .send({ content: { summary: 'Edited while still a draft.' } })
    expect(res.status).toBe(200)
  })

  it('approves it and records the approver', async () => {
    const res = await request(app).post(`/api/personnel/resumes/${v1}/approve`).set(auth(userA.token)).send({})
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('APPROVED')
    expect(res.body.data.approvedByUserId).toBe(userA.id)
  })

  it('refuses to edit an approved version in place', async () => {
    const res = await request(app).put(`/api/personnel/resumes/${v1}`).set(auth(userA.token))
      .send({ content: { summary: 'Rewriting history.' } })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('RESUME_IMMUTABLE')
    const unchanged = await prisma.personnelResume.findUnique({ where: { id: v1 } })
    expect((unchanged!.content as { summary: string }).summary).toBe('Edited while still a draft.')
  })

  it('refuses to approve twice', async () => {
    const res = await request(app).post(`/api/personnel/resumes/${v1}/approve`).set(auth(userA.token)).send({})
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_TRANSITION')
  })

  it('supersedes the previous version when a second is approved', async () => {
    const created = await request(app).post(`/api/personnel/${personId}/resumes`).set(auth(userA.token))
      .send({ title: 'v2', content: { summary: 'Updated.' } })
    v2 = created.body.data.id
    expect(created.body.data.versionNumber).toBe(2)

    await request(app).post(`/api/personnel/resumes/${v2}/approve`).set(auth(userA.token)).send({})
    const old = await prisma.personnelResume.findUnique({ where: { id: v1 } })
    expect(old!.status).toBe('SUPERSEDED')
    expect(old!.supersededAt).toBeTruthy()
    // The superseded content stays intact as evidence.
    expect((old!.content as { summary: string }).summary).toBe('Edited while still a draft.')

    const approvedCount = await prisma.personnelResume.count({ where: { personnelId: personId, status: 'APPROVED' } })
    expect(approvedCount).toBe(1)
  })

  it('reports no resume honestly for a person who has none', async () => {
    const p = await request(app).post('/api/personnel').set(auth(userA.token)).send({ firstName: 'No', lastName: 'Resume' })
    const res = await request(app).get(`/api/personnel/${p.body.data.id}`).set(auth(userA.token))
    expect(res.body.data.resumes).toHaveLength(0)
  })
})

describe('§8.3 proposal key personnel keeps provenance', () => {
  let personId: string
  let approvedResume: string
  let draftResume: string

  beforeAll(async () => {
    const p = await request(app).post('/api/personnel').set(auth(userA.token))
      .send({ firstName: 'Key', lastName: 'Person' })
    personId = p.body.data.id
    const a = await request(app).post(`/api/personnel/${personId}/resumes`).set(auth(userA.token))
      .send({ content: { summary: 'Approved evidence.' } })
    approvedResume = a.body.data.id
    await request(app).post(`/api/personnel/resumes/${approvedResume}/approve`).set(auth(userA.token)).send({})
    const d = await request(app).post(`/api/personnel/${personId}/resumes`).set(auth(userA.token))
      .send({ content: { summary: 'Still a draft.' } })
    draftResume = d.body.data.id
  })

  it('refuses to back a proposal with an unapproved resume', async () => {
    const res = await request(app).post(`/api/personnel/proposals/${proposalA.id}/key-personnel`).set(auth(userA.token))
      .send({ personnelId: personId, resumeId: draftResume })
    expect(res.status).toBe(422)
  })

  it('selects an approved resume and keeps a snapshot plus live provenance', async () => {
    const res = await request(app).post(`/api/personnel/proposals/${proposalA.id}/key-personnel`).set(auth(userA.token))
      .send({
        personnelId: personId, resumeId: approvedResume, proposalRole: 'Cyber Lead',
        snapshot: { adaptedSummary: 'Tailored to Section L.' },
      })
    expect(res.status).toBe(201)
    expect(res.body.data.resumeId).toBe(approvedResume)

    const list = await request(app).get(`/api/personnel/proposals/${proposalA.id}/key-personnel`).set(auth(userA.token))
    expect(list.body.data.items[0].resume.status).toBe('APPROVED')
    expect(list.body.data.provenanceNote).toMatch(/never silently diverge/i)
  })

  it('leaves the source resume immutable after proposal adaptation', async () => {
    const source = await prisma.personnelResume.findUnique({ where: { id: approvedResume } })
    expect((source!.content as { summary: string }).summary).toBe('Approved evidence.')
  })

  it('refuses the same person twice on one proposal', async () => {
    const res = await request(app).post(`/api/personnel/proposals/${proposalA.id}/key-personnel`).set(auth(userA.token))
      .send({ personnelId: personId, resumeId: approvedResume })
    expect(res.status).toBe(422)
  })

  it('refuses another firm’s proposal and personnel (IDOR)', async () => {
    expect((await request(app).get(`/api/personnel/proposals/${proposalA.id}/key-personnel`).set(auth(userB.token))).status).toBe(404)
    const res = await request(app).post(`/api/personnel/proposals/${proposalA.id}/key-personnel`).set(auth(userB.token))
      .send({ personnelId: personId })
    expect(res.status).toBe(404)
  })
})

describe('§8.3 resource allocation stays compatible', () => {
  it('keeps userId required and personnelId optional, so existing rows remain valid', async () => {
    const contract = await prisma.contract.create({
      data: { consultingFirmId: firmA.id, contractNumber: `KPC-${Date.now()}`, title: 'KP Contract', status: 'ACTIVE' },
      select: { id: true },
    })
    const legacy = await prisma.resourceAllocation.create({
      data: {
        consultingFirmId: firmA.id, userId: userA.id, contractId: contract.id,
        allocationPercent: '50.00', startDate: new Date(),
      },
    })
    expect(legacy.personnelId).toBeNull()

    const person = await prisma.personnel.create({
      data: { consultingFirmId: firmA.id, firstName: 'Alloc', lastName: 'Person' }, select: { id: true },
    })
    const bridged = await prisma.resourceAllocation.create({
      data: {
        consultingFirmId: firmA.id, userId: userA.id, personnelId: person.id, contractId: contract.id,
        allocationPercent: '25.00', startDate: new Date(),
      },
    })
    expect(bridged.personnelId).toBe(person.id)
  })
})

// =============================================================
// §8.4 — real resume file upload, bound to a version rather than a person.
// =============================================================

const bytes = (res: { body: unknown; text?: string }): string =>
  Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text ?? JSON.stringify(res.body)

describe('§8.4 resume document upload', () => {
  let personId = ''
  let draftId = ''

  it('attaches a document to a draft version', async () => {
    const person = await request(app).post('/api/personnel').set(auth(userA.token))
      .send({ firstName: 'File', lastName: 'Holder' })
    personId = person.body.data.id
    const draft = await request(app).post(`/api/personnel/${personId}/resumes`).set(auth(userA.token))
      .send({ title: 'v1', content: { summary: 'Written by a human.' } })
    expect(draft.status).toBe(201)
    draftId = draft.body.data.id

    const uploaded = await request(app).post(`/api/personnel/resumes/${draftId}/file`).set(auth(userA.token))
      .attach('file', Buffer.from('RESUME-V1-BYTES'), { filename: 'cv.pdf', contentType: 'application/pdf' })
    expect(uploaded.status).toBe(200)
    expect(uploaded.body.data.fileName).toBe('cv.pdf')
    expect(uploaded.body.data.fileType).toBe('application/pdf')
    expect(uploaded.body.data.fileSize).toBe(15)
  })

  it('records the MIME the middleware validated, never one derived from the name', async () => {
    const row = await prisma.personnelResume.findUnique({ where: { id: draftId }, select: { fileType: true, storageKey: true } })
    expect(row!.fileType).toBe('application/pdf')
    // Server-generated storage name, not the caller's.
    expect(row!.storageKey).not.toContain('cv.pdf')
  })

  it('rejects a file type outside the document allowlist', async () => {
    const res = await request(app).post(`/api/personnel/resumes/${draftId}/file`).set(auth(userA.token))
      .attach('file', Buffer.from('<svg/>'), { filename: 'cv.svg', contentType: 'image/svg+xml' })
    expect(res.status).toBe(422)
  })

  it('serves the document back to its own firm and to nobody else', async () => {
    const own = await request(app).get(`/api/personnel/resumes/${draftId}/file`).set(auth(userA.token))
    expect(own.status).toBe(200)
    expect(bytes(own)).toBe('RESUME-V1-BYTES')

    const other = await request(app).get(`/api/personnel/resumes/${draftId}/file`).set(auth(userB.token))
    expect(other.status).toBe(404)
    expect(bytes(other)).not.toContain('RESUME-V1-BYTES')
  })

  it('refuses to swap the document under an approved version', async () => {
    await request(app).post(`/api/personnel/resumes/${draftId}/approve`).set(auth(userA.token)).send({}).expect(200)
    const res = await request(app).post(`/api/personnel/resumes/${draftId}/file`).set(auth(userA.token))
      .attach('file', Buffer.from('SWAPPED-BYTES'), { filename: 'other.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('RESUME_IMMUTABLE')

    const still = await request(app).get(`/api/personnel/resumes/${draftId}/file`).set(auth(userA.token))
    expect(bytes(still)).toBe('RESUME-V1-BYTES')
  })

  it('accepts a replacement only on a new draft version, leaving the approved one intact', async () => {
    const v2 = await request(app).post(`/api/personnel/${personId}/resumes`).set(auth(userA.token)).send({ title: 'v2' })
    expect(v2.status).toBe(201)
    await request(app).post(`/api/personnel/resumes/${v2.body.data.id}/file`).set(auth(userA.token))
      .attach('file', Buffer.from('RESUME-V2-BYTES'), { filename: 'cv2.pdf', contentType: 'application/pdf' })
      .expect(200)
    expect(bytes(await request(app).get(`/api/personnel/resumes/${draftId}/file`).set(auth(userA.token)))).toBe('RESUME-V1-BYTES')
    expect(bytes(await request(app).get(`/api/personnel/resumes/${v2.body.data.id}/file`).set(auth(userA.token)))).toBe('RESUME-V2-BYTES')
  })

  it('ignores a caller-supplied storage key entirely', async () => {
    const v3 = await request(app).post(`/api/personnel/${personId}/resumes`).set(auth(userA.token))
      .send({ title: 'v3', storageKey: '../../etc/passwd', fileName: 'passwd' })
    expect(v3.status).toBe(201)
    const row = await prisma.personnelResume.findUnique({ where: { id: v3.body.data.id }, select: { storageKey: true, fileName: true } })
    expect(row!.storageKey).toBeNull()
    expect(row!.fileName).toBeNull()
  })

  it('refuses the upload to a non-admin', async () => {
    const v4 = await request(app).post(`/api/personnel/${personId}/resumes`).set(auth(userA.token)).send({ title: 'v4' })
    const res = await request(app).post(`/api/personnel/resumes/${v4.body.data.id}/file`).set(auth(consultantA.token))
      .attach('file', Buffer.from('x'), { filename: 'x.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(403)
  })
})
