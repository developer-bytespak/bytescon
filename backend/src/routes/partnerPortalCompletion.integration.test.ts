// =============================================================
// §8.4 — Partner portal completion: download, deliverable submission,
// password reset, second factor, and self-service profile.
//
// Same adversarial matrix as §8.3, because the answers must not change when
// new surfaces are added:
//
//   Firm A: Partner A1 (Contract A1), Partner A2 (Contract A2)
//   Firm B: Partner B1 (Contract B1)
//
// The download tests assert on the RETURNED BYTES, not only the status code: a
// 200 that streams the wrong tenant's file is the failure this suite exists to
// catch, and a status assertion alone would miss it.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import crypto from 'crypto'
import type { Express } from 'express'
import * as OTPAuth from 'otpauth'
import { prisma } from '../config/database'
import {
  buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser,
} from '../test-utils/testClient'

let app: Express
let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser, adminB: TestUser
let partnerA1: { id: string }, partnerA2: { id: string }, partnerB1: { id: string }
let contractA1: { id: string }, contractA2: { id: string }, contractB1: { id: string }
let userA1 = { id: '', token: '', email: '' }
let userA2 = { id: '', token: '', email: '' }
let userB1 = { id: '', token: '', email: '' }
let docA1 = '', docA2 = '', docB1 = ''
let deliverableA1 = '', deliverableA2 = '', deliverableUnassignedA = ''

const auth = (t: string) => ({ Authorization: `Bearer ${t}` })

/**
 * The actual response body as text.
 *
 * A download is served with its own content type, so supertest leaves the
 * payload as a Buffer rather than parsing it into `.text`. These tests assert
 * on bytes deliberately: a 200 that streams another tenant's file would pass a
 * status-only assertion.
 */
const bytes = (res: { body: unknown; text?: string }): string =>
  Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text ?? JSON.stringify(res.body)
const PASSWORD = 'a-very-strong-password-1'

/** Distinct bytes per document, so a mixed-up file is visible rather than plausible. */
const BODY = { A1: 'BYTES-FOR-A1-ONLY', A2: 'BYTES-FOR-A2-ONLY', B1: 'BYTES-FOR-B1-ONLY' }

async function makePartnerUser(admin: TestUser, partnerId: string, email: string) {
  const invited = await request(app).post('/api/partner-portal/admin/users').set(auth(admin.token))
    .send({ partnerId, email, firstName: 'Ext', lastName: 'User' })
  expect(invited.status).toBe(201)
  await request(app).post('/api/partner-portal/auth/accept-invite')
    .send({ token: invited.body.data.inviteToken, password: PASSWORD }).expect(200)
  const login = await request(app).post('/api/partner-portal/auth/login').send({ email, password: PASSWORD })
  expect(login.status).toBe(200)
  return { id: invited.body.data.id, token: login.body.data.token, email }
}

async function grant(admin: TestUser, portalUserId: string, scopeType: string, scopeId: string) {
  const res = await request(app).post('/api/partner-portal/admin/access').set(auth(admin.token))
    .send({ partnerPortalUserId: portalUserId, scopeType, scopeId })
  expect(res.status).toBe(201)
  return res.body.data.id as string
}

async function uploadDoc(token: string, contractId: string, body: string, title: string) {
  const res = await request(app).post('/api/partner-portal/documents').set(auth(token))
    .field('scopeType', 'CONTRACT').field('scopeId', contractId)
    .field('category', 'EVIDENCE').field('title', title)
    .attach('file', Buffer.from(body), { filename: `${title}.pdf`, contentType: 'application/pdf' })
  expect(res.status).toBe(201)
  return res.body.data.id as string
}

async function makeContract(firm: TestFirm, tag: string) {
  return prisma.contract.create({
    data: {
      consultingFirmId: firm.id, contractNumber: `PC-${tag}-${Date.now()}`, title: `Contract ${tag}`,
      status: 'ACTIVE', ceilingValue: '500000.00',
    },
    select: { id: true },
  })
}

async function makeDeliverable(firm: TestFirm, contractId: string, partnerId: string | null, name: string) {
  const row = await prisma.contractDeliverable.create({
    data: {
      consultingFirmId: firm.id, contractId, name, cdrlNumber: 'A001',
      dueDate: new Date(Date.now() + 7 * 86400000), partnerId,
    },
    select: { id: true },
  })
  return row.id
}

beforeAll(async () => {
  app = buildTestApp()
  firmA = await createTestFirm({ name: 'PC Firm A' })
  firmB = await createTestFirm({ name: 'PC Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })

  partnerA1 = await prisma.partner.create({ data: { consultingFirmId: firmA.id, name: 'PC Partner A1' }, select: { id: true } })
  partnerA2 = await prisma.partner.create({ data: { consultingFirmId: firmA.id, name: 'PC Partner A2' }, select: { id: true } })
  partnerB1 = await prisma.partner.create({ data: { consultingFirmId: firmB.id, name: 'PC Partner B1' }, select: { id: true } })

  contractA1 = await makeContract(firmA, 'A1')
  contractA2 = await makeContract(firmA, 'A2')
  contractB1 = await makeContract(firmB, 'B1')

  const stamp = Date.now()
  userA1 = await makePartnerUser(adminA, partnerA1.id, `pc-a1-${stamp}@ext.test`)
  userA2 = await makePartnerUser(adminA, partnerA2.id, `pc-a2-${stamp}@ext.test`)
  userB1 = await makePartnerUser(adminB, partnerB1.id, `pc-b1-${stamp}@ext.test`)

  await grant(adminA, userA1.id, 'CONTRACT', contractA1.id)
  await grant(adminA, userA2.id, 'CONTRACT', contractA2.id)
  await grant(adminB, userB1.id, 'CONTRACT', contractB1.id)

  docA1 = await uploadDoc(userA1.token, contractA1.id, BODY.A1, 'A1-DOC')
  docA2 = await uploadDoc(userA2.token, contractA2.id, BODY.A2, 'A2-DOC')
  docB1 = await uploadDoc(userB1.token, contractB1.id, BODY.B1, 'B1-DOC')

  deliverableA1 = await makeDeliverable(firmA, contractA1.id, partnerA1.id, 'A1 monthly report')
  deliverableA2 = await makeDeliverable(firmA, contractA2.id, partnerA2.id, 'A2 monthly report')
  deliverableUnassignedA = await makeDeliverable(firmA, contractA1.id, null, 'Prime-only report')
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

// -------------------------------------------------------------
// §4/§6 — secure document download
// -------------------------------------------------------------

describe('§8.4 partner document download', () => {
  it('returns A1 its own document, with the right bytes', async () => {
    const res = await request(app).get(`/api/partner-portal/documents/${docA1}/download`).set(auth(userA1.token))
    expect(res.status).toBe(200)
    expect(bytes(res)).toBe(BODY.A1)
    expect(res.headers['content-disposition']).toContain('A1-DOC.pdf')
    expect(res.headers['cache-control']).toContain('no-store')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('refuses A1 the other partner in the same firm', async () => {
    const res = await request(app).get(`/api/partner-portal/documents/${docA2}/download`).set(auth(userA1.token))
    expect(res.status).toBe(403)
    expect(bytes(res)).not.toContain(BODY.A2)
  })

  it('refuses A1 the other tenant entirely', async () => {
    const res = await request(app).get(`/api/partner-portal/documents/${docB1}/download`).set(auth(userA1.token))
    expect(res.status).toBe(403)
    expect(bytes(res)).not.toContain(BODY.B1)
  })

  it('refuses A2 the first partner document', async () => {
    const res = await request(app).get(`/api/partner-portal/documents/${docA1}/download`).set(auth(userA2.token))
    expect(res.status).toBe(403)
    expect(bytes(res)).not.toContain(BODY.A1)
  })

  it('refuses B1 a Firm A document', async () => {
    const res = await request(app).get(`/api/partner-portal/documents/${docA1}/download`).set(auth(userB1.token))
    expect(res.status).toBe(403)
    expect(bytes(res)).not.toContain(BODY.A1)
  })

  it('stops serving the moment the grant is revoked, to a previously working id', async () => {
    const tempUser = await makePartnerUser(adminA, partnerA1.id, `pc-rev-${Date.now()}@ext.test`)
    const accessId = await grant(adminA, tempUser.id, 'CONTRACT', contractA1.id)
    const docId = await uploadDoc(tempUser.token, contractA1.id, 'REVOKE-ME', 'REV-DOC')

    const before = await request(app).get(`/api/partner-portal/documents/${docId}/download`).set(auth(tempUser.token))
    expect(before.status).toBe(200)
    expect(bytes(before)).toBe('REVOKE-ME')

    await request(app).post(`/api/partner-portal/admin/access/${accessId}/revoke`).set(auth(adminA.token)).send({}).expect(200)

    // The very same URL and the very same still-unexpired token.
    const after = await request(app).get(`/api/partner-portal/documents/${docId}/download`).set(auth(tempUser.token))
    expect(after.status).toBe(403)
    expect(bytes(after)).not.toContain('REVOKE-ME')
  })

  it('locks out a revoked USER even where the grant survives', async () => {
    const tempUser = await makePartnerUser(adminA, partnerA1.id, `pc-usr-${Date.now()}@ext.test`)
    await grant(adminA, tempUser.id, 'CONTRACT', contractA1.id)
    const docId = await uploadDoc(tempUser.token, contractA1.id, 'USER-REVOKE', 'USR-DOC')
    await request(app).post(`/api/partner-portal/admin/users/${tempUser.id}/revoke`).set(auth(adminA.token)).send({}).expect(200)
    const after = await request(app).get(`/api/partner-portal/documents/${docId}/download`).set(auth(tempUser.token))
    expect(after.status).toBe(401)
    expect(bytes(after)).not.toContain('USER-REVOKE')
  })

  it('lets the prime read a partner upload, tenant-scoped', async () => {
    const mine = await request(app).get(`/api/partner-portal/admin/uploads/${docA1}/download`).set(auth(adminA.token))
    expect(mine.status).toBe(200)
    expect(bytes(mine)).toBe(BODY.A1)
    const theirs = await request(app).get(`/api/partner-portal/admin/uploads/${docA1}/download`).set(auth(adminB.token))
    expect(theirs.status).toBe(404)
    expect(bytes(theirs)).not.toContain(BODY.A1)
  })
})

// -------------------------------------------------------------
// §7/§8/§9 — deliverable submission
// -------------------------------------------------------------

describe('§8.4 partner deliverable submission', () => {
  let submissionA1 = ''

  it('opens an attributed deliverable to the assigned partner', async () => {
    const res = await request(app).get(`/api/partner-portal/deliverables/${deliverableA1}`).set(auth(userA1.token))
    expect(res.status).toBe(200)
    expect(res.body.data.name).toBe('A1 monthly report')
    expect(res.body.data.primeStatus).toBe('NOT_STARTED')
  })

  it('refuses a deliverable on a granted contract that is not attributed to the partner', async () => {
    const res = await request(app).get(`/api/partner-portal/deliverables/${deliverableUnassignedA}`).set(auth(userA1.token))
    expect(res.status).toBe(403)
  })

  it("refuses another partner's deliverable and another tenant's", async () => {
    expect((await request(app).get(`/api/partner-portal/deliverables/${deliverableA2}`).set(auth(userA1.token))).status).toBe(403)
    expect((await request(app).get(`/api/partner-portal/deliverables/${deliverableA1}`).set(auth(userB1.token))).status).toBe(403)
  })

  it('saves a draft, then submits it', async () => {
    const draft = await request(app).post(`/api/partner-portal/deliverables/${deliverableA1}/submissions`).set(auth(userA1.token))
      .field('note', 'First pass')
      .attach('file', Buffer.from('DELIVERABLE-EVIDENCE-A1'), { filename: 'report.pdf', contentType: 'application/pdf' })
    expect(draft.status).toBe(201)
    expect(draft.body.data.status).toBe('DRAFT')
    submissionA1 = draft.body.data.id

    const submitted = await request(app).post(`/api/partner-portal/deliverable-submissions/${submissionA1}/submit`).set(auth(userA1.token)).send({})
    expect(submitted.status).toBe(200)
    expect(submitted.body.data.status).toBe('SUBMITTED')
  })

  it('refuses a second submit of the same response', async () => {
    const again = await request(app).post(`/api/partner-portal/deliverable-submissions/${submissionA1}/submit`).set(auth(userA1.token)).send({})
    expect(again.status).toBe(422)
  })

  it('leaves the deliverable’s own status untouched by the partner', async () => {
    const row = await prisma.contractDeliverable.findUnique({
      where: { id: deliverableA1 }, select: { status: true, acceptanceStatus: true, acceptanceDate: true, submittedByUserId: true },
    })
    expect(row!.status).toBe('NOT_STARTED')
    expect(row!.acceptanceStatus).toBeNull()
    expect(row!.acceptanceDate).toBeNull()
    expect(row!.submittedByUserId).toBeNull()
  })

  it('gives the partner no route to accept its own response', async () => {
    for (const path of [
      `/api/partner-portal/deliverable-submissions/${submissionA1}/review`,
      `/api/partner-portal/admin/deliverable-submissions/${submissionA1}/review`,
    ]) {
      const res = await request(app).post(path).set(auth(userA1.token)).send({ status: 'ACCEPTED_BY_PRIME' })
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).not.toBe(200)
    }
    const row = await prisma.partnerDeliverableSubmission.findUnique({ where: { id: submissionA1 }, select: { status: true } })
    expect(row!.status).toBe('SUBMITTED')
  })

  it('lets a prime ADMIN request changes and the partner resubmit', async () => {
    const changes = await request(app).post(`/api/partner-portal/admin/deliverable-submissions/${submissionA1}/review`)
      .set(auth(adminA.token)).send({ status: 'CHANGES_REQUESTED', reviewNotes: 'Add the metrics table' })
    expect(changes.status).toBe(200)
    expect(changes.body.data.status).toBe('CHANGES_REQUESTED')

    const redraft = await request(app).post(`/api/partner-portal/deliverables/${deliverableA1}/submissions`).set(auth(userA1.token))
      .field('note', 'Metrics added')
    expect(redraft.status).toBe(200)
    expect(redraft.body.data.id).toBe(submissionA1)

    const resubmit = await request(app).post(`/api/partner-portal/deliverable-submissions/${submissionA1}/submit`).set(auth(userA1.token)).send({})
    expect(resubmit.status).toBe(200)
    expect(resubmit.body.data.status).toBe('SUBMITTED')
  })

  it('accepts on the prime side without recording government acceptance', async () => {
    const accepted = await request(app).post(`/api/partner-portal/admin/deliverable-submissions/${submissionA1}/review`)
      .set(auth(adminA.token)).send({ status: 'ACCEPTED_BY_PRIME' })
    expect(accepted.status).toBe(200)
    const row = await prisma.contractDeliverable.findUnique({
      where: { id: deliverableA1 }, select: { status: true, acceptanceStatus: true, acceptanceDate: true },
    })
    expect(row!.status).toBe('NOT_STARTED')
    expect(row!.acceptanceStatus).toBeNull()
    expect(row!.acceptanceDate).toBeNull()
  })

  it('serves the submitted evidence to its owner and to nobody else', async () => {
    const own = await request(app).get(`/api/partner-portal/deliverable-submissions/${submissionA1}/download`).set(auth(userA1.token))
    expect(own.status).toBe(200)
    expect(bytes(own)).toBe('DELIVERABLE-EVIDENCE-A1')

    for (const token of [userA2.token, userB1.token]) {
      const res = await request(app).get(`/api/partner-portal/deliverable-submissions/${submissionA1}/download`).set(auth(token))
      expect(res.status).toBe(403)
      expect(bytes(res)).not.toContain('DELIVERABLE-EVIDENCE-A1')
    }
  })

  it('refuses a non-admin prime user the review', async () => {
    const consultant = await createTestUser(firmA.id, { role: 'CONSULTANT' })
    const res = await request(app).post(`/api/partner-portal/admin/deliverable-submissions/${submissionA1}/review`)
      .set(auth(consultant.token)).send({ status: 'ACCEPTED_BY_PRIME' })
    expect(res.status).toBe(403)
  })
})

// -------------------------------------------------------------
// §10/§11 — password reset
// -------------------------------------------------------------

describe('§8.4 partner password reset', () => {
  async function requestReset(email: string) {
    return request(app).post('/api/partner-portal/auth/forgot-password').send({ email })
  }
  async function latestRawToken(portalUserId: string) {
    // The stored value is a hash, so the test mints its own raw token and
    // stores the hash — exactly what the endpoint does — to prove the reset
    // path never needs the plaintext back.
    const raw = crypto.randomBytes(32).toString('hex')
    const row = await prisma.partnerPortalPasswordReset.findFirst({
      where: { partnerPortalUserId: portalUserId, usedAt: null }, orderBy: { createdAt: 'desc' },
    })
    expect(row).not.toBeNull()
    await prisma.partnerPortalPasswordReset.update({
      where: { id: row!.id }, data: { tokenHash: crypto.createHash('sha256').update(raw).digest('hex') },
    })
    return raw
  }

  it('answers identically for a known address, an unknown one, and a malformed one', async () => {
    const known = await requestReset(userA1.email)
    const unknown = await requestReset(`nobody-${Date.now()}@ext.test`)
    const malformed = await requestReset('not-an-email')
    expect(known.status).toBe(200)
    expect(unknown.status).toBe(200)
    expect(malformed.status).toBe(200)
    expect(known.body).toEqual(unknown.body)
    expect(known.body).toEqual(malformed.body)
    expect(JSON.stringify(known.body)).not.toContain('PC Partner')
  })

  it('never stores the reset token in the clear', async () => {
    await requestReset(userA1.email)
    const rows = await prisma.partnerPortalPasswordReset.findMany({
      where: { partnerPortalUserId: userA1.id }, select: { tokenHash: true },
    })
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('resets the password, invalidates the old session, and burns the token', async () => {
    const target = await makePartnerUser(adminA, partnerA1.id, `pc-reset-${Date.now()}@ext.test`)
    await grant(adminA, target.id, 'CONTRACT', contractA1.id)
    await requestReset(target.email)
    const raw = await latestRawToken(target.id)

    const newPassword = 'a-different-strong-password-2'
    const reset = await request(app).post('/api/partner-portal/auth/reset-password').send({ token: raw, password: newPassword })
    expect(reset.status).toBe(200)

    // The old password no longer works; the new one does.
    expect((await request(app).post('/api/partner-portal/auth/login').send({ email: target.email, password: PASSWORD })).status).toBe(401)
    expect((await request(app).post('/api/partner-portal/auth/login').send({ email: target.email, password: newPassword })).status).toBe(200)

    // Replay of the same token is refused.
    expect((await request(app).post('/api/partner-portal/auth/reset-password').send({ token: raw, password: 'yet-another-password-3' })).status).toBe(401)
  })

  it('refuses an expired token', async () => {
    const target = await makePartnerUser(adminA, partnerA1.id, `pc-exp-${Date.now()}@ext.test`)
    await requestReset(target.email)
    const raw = await latestRawToken(target.id)
    await prisma.partnerPortalPasswordReset.updateMany({
      where: { partnerPortalUserId: target.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) },
    })
    expect((await request(app).post('/api/partner-portal/auth/reset-password').send({ token: raw, password: 'strong-enough-password-4' })).status).toBe(401)
  })

  it('refuses an unknown token and a short password', async () => {
    expect((await request(app).post('/api/partner-portal/auth/reset-password')
      .send({ token: crypto.randomBytes(32).toString('hex'), password: 'strong-enough-password-5' })).status).toBe(401)
    expect((await request(app).post('/api/partner-portal/auth/reset-password')
      .send({ token: crypto.randomBytes(32).toString('hex'), password: 'short' })).status).toBe(422)
  })

  it('issues nothing for a revoked account', async () => {
    const target = await makePartnerUser(adminA, partnerA1.id, `pc-rev2-${Date.now()}@ext.test`)
    await request(app).post(`/api/partner-portal/admin/users/${target.id}/revoke`).set(auth(adminA.token)).send({}).expect(200)
    const before = await prisma.partnerPortalPasswordReset.count({ where: { partnerPortalUserId: target.id } })
    const res = await requestReset(target.email)
    expect(res.status).toBe(200)
    expect(await prisma.partnerPortalPasswordReset.count({ where: { partnerPortalUserId: target.id } })).toBe(before)
  })

  it('spends an outstanding token when a new one is requested', async () => {
    const target = await makePartnerUser(adminA, partnerA1.id, `pc-two-${Date.now()}@ext.test`)
    await requestReset(target.email)
    const first = await latestRawToken(target.id)
    await requestReset(target.email)
    expect((await request(app).post('/api/partner-portal/auth/reset-password').send({ token: first, password: 'strong-enough-password-6' })).status).toBe(401)
  })
})

describe('§8.4 an address that belongs to two primes', () => {
  // Found during runtime QA: an email is unique per FIRM, not globally, so a
  // subcontractor employee working with two primes has two accounts. Matching
  // on the address alone resolved to whichever row came back first and locked
  // them out of the other.
  const shared = `pc-shared-${Date.now()}@ext.test`
  const PASSWORD_A = 'password-for-firm-a-01'
  const PASSWORD_B = 'password-for-firm-b-02'

  beforeAll(async () => {
    for (const [admin, partnerId, password] of [
      [adminA, partnerA1.id, PASSWORD_A], [adminB, partnerB1.id, PASSWORD_B],
    ] as const) {
      const invited = await request(app).post('/api/partner-portal/admin/users').set(auth(admin.token))
        .send({ partnerId, email: shared, firstName: 'Shared', lastName: 'Person' })
      expect(invited.status).toBe(201)
      await request(app).post('/api/partner-portal/auth/accept-invite')
        .send({ token: invited.body.data.inviteToken, password }).expect(200)
    }
  })

  it('signs each account in with its own password', async () => {
    const a = await request(app).post('/api/partner-portal/auth/login').send({ email: shared, password: PASSWORD_A })
    const b = await request(app).post('/api/partner-portal/auth/login').send({ email: shared, password: PASSWORD_B })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)

    const engagementsA = await request(app).get('/api/partner-portal/me').set(auth(a.body.data.token))
    const engagementsB = await request(app).get('/api/partner-portal/me').set(auth(b.body.data.token))
    expect(engagementsA.body.data.partner.id).toBe(partnerA1.id)
    expect(engagementsB.body.data.partner.id).toBe(partnerB1.id)
  })

  it('still refuses a wrong password for either', async () => {
    const res = await request(app).post('/api/partner-portal/auth/login').send({ email: shared, password: 'not-either-password' })
    expect(res.status).toBe(401)
  })

  it('issues a reset for each account rather than only the first', async () => {
    const before = await prisma.partnerPortalPasswordReset.count({
      where: { portalUser: { email: shared } },
    })
    await request(app).post('/api/partner-portal/auth/forgot-password').send({ email: shared }).expect(200)
    const after = await prisma.partnerPortalPasswordReset.count({
      where: { portalUser: { email: shared } },
    })
    expect(after - before).toBe(2)
  })
})

// -------------------------------------------------------------
// §12/§13 — second factor
// -------------------------------------------------------------

describe('§8.4 partner MFA', () => {
  const codeFor = (secret: string) =>
    new OTPAuth.TOTP({ issuer: 'Bytescon', label: 'Bytescon', algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate()

  it('enrolls, refuses a wrong code, enables on a correct one, and challenges at login', async () => {
    const email = `pc-mfa-${Date.now()}@ext.test`
    const user = await makePartnerUser(adminA, partnerA1.id, email)

    const enroll = await request(app).post('/api/partner-portal/mfa/enroll').set(auth(user.token)).send({})
    expect(enroll.status).toBe(200)
    const secret = enroll.body.data.secret as string
    expect(enroll.body.data.otpauthUri).toContain('otpauth://')

    expect((await request(app).post('/api/partner-portal/mfa/enroll/verify').set(auth(user.token)).send({ code: '000000' })).status).toBe(401)

    const verified = await request(app).post('/api/partner-portal/mfa/enroll/verify').set(auth(user.token)).send({ code: codeFor(secret) })
    expect(verified.status).toBe(200)
    expect(verified.body.data.recoveryCodes).toHaveLength(10)

    // Enrollment is the only response that carries the secret.
    const status = await request(app).get('/api/partner-portal/mfa/status').set(auth(user.token))
    expect(status.body.data.enabled).toBe(true)
    expect(JSON.stringify(status.body)).not.toContain(secret)
    const me = await request(app).get('/api/partner-portal/me').set(auth(user.token))
    expect(JSON.stringify(me.body)).not.toContain(secret)

    // A correct password alone no longer yields a session.
    const login = await request(app).post('/api/partner-portal/auth/login').send({ email, password: PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body.success).toBe(false)
    expect(login.body.code).toBe('MFA_REQUIRED')
    expect(login.body.token).toBeUndefined()
    const challenge = login.body.mfaChallengeToken as string

    // And the challenge token is not a session either.
    expect((await request(app).get('/api/partner-portal/engagements').set(auth(challenge))).status).toBe(401)

    expect((await request(app).post('/api/partner-portal/auth/mfa/verify').set(auth(challenge)).send({ code: '111111' })).status).toBe(401)

    const done = await request(app).post('/api/partner-portal/auth/mfa/verify').set(auth(challenge)).send({ code: codeFor(secret) })
    expect(done.status).toBe(200)
    expect(done.body.data.token).toBeTruthy()
    expect((await request(app).get('/api/partner-portal/engagements').set(auth(done.body.data.token))).status).toBe(200)

    // A full session cannot re-run the challenge.
    expect((await request(app).post('/api/partner-portal/auth/mfa/verify').set(auth(done.body.data.token)).send({ code: codeFor(secret) })).status).toBe(401)

    // A recovery code works once and only once.
    const recovery = verified.body.data.recoveryCodes[0] as string
    const relogin = await request(app).post('/api/partner-portal/auth/login').send({ email, password: PASSWORD })
    const used = await request(app).post('/api/partner-portal/auth/mfa/verify').set(auth(relogin.body.mfaChallengeToken)).send({ code: recovery })
    expect(used.status).toBe(200)
    const replayLogin = await request(app).post('/api/partner-portal/auth/login').send({ email, password: PASSWORD })
    expect((await request(app).post('/api/partner-portal/auth/mfa/verify').set(auth(replayLogin.body.mfaChallengeToken)).send({ code: recovery })).status).toBe(401)

    // Disabling requires a factor, and clears the stored secret.
    expect((await request(app).post('/api/partner-portal/mfa/disable').set(auth(used.body.data.token)).send({ code: '222222' })).status).toBe(401)
    expect((await request(app).post('/api/partner-portal/mfa/disable').set(auth(used.body.data.token)).send({ code: codeFor(secret) })).status).toBe(200)
    const after = await prisma.partnerPortalUser.findUnique({
      where: { id: user.id }, select: { mfaEnabled: true, mfaSecret: true, mfaRecoveryCodes: true },
    })
    expect(after!.mfaEnabled).toBe(false)
    expect(after!.mfaSecret).toBeNull()
    expect(after!.mfaRecoveryCodes).toEqual([])
  })

  it('refuses a challenge token belonging to a revoked account', async () => {
    const email = `pc-mfa2-${Date.now()}@ext.test`
    const user = await makePartnerUser(adminA, partnerA1.id, email)
    const enroll = await request(app).post('/api/partner-portal/mfa/enroll').set(auth(user.token)).send({})
    const secret = enroll.body.data.secret as string
    await request(app).post('/api/partner-portal/mfa/enroll/verify').set(auth(user.token)).send({ code: codeFor(secret) }).expect(200)
    const login = await request(app).post('/api/partner-portal/auth/login').send({ email, password: PASSWORD })
    await request(app).post(`/api/partner-portal/admin/users/${user.id}/revoke`).set(auth(adminA.token)).send({}).expect(200)
    const res = await request(app).post('/api/partner-portal/auth/mfa/verify').set(auth(login.body.mfaChallengeToken)).send({ code: codeFor(secret) })
    expect(res.status).toBe(401)
  })
})

// -------------------------------------------------------------
// §14 — self-service profile
// -------------------------------------------------------------

describe('§8.4 partner profile change review', () => {
  it('shows the partner its own record without the prime’s private view of it', async () => {
    await prisma.partner.update({
      where: { id: partnerA1.id },
      data: { notes: 'PRIME-PRIVATE-NOTE', pastRelationship: 'PRIME-PRIVATE-HISTORY' },
    })
    const res = await request(app).get('/api/partner-portal/profile').set(auth(userA1.token))
    expect(res.status).toBe(200)
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('PRIME-PRIVATE-NOTE')
    expect(body).not.toContain('PRIME-PRIVATE-HISTORY')
  })

  it('refuses a field outside the allowlist instead of dropping it', async () => {
    for (const proposed of [{ notes: 'try me' }, { name: 'Renamed Inc' }, { isActive: false }, { ownerUserId: adminA.id }]) {
      const res = await request(app).post('/api/partner-portal/profile/change-requests').set(auth(userA1.token)).send({ proposed })
      expect(res.status).toBe(422)
    }
    const row = await prisma.partner.findUnique({ where: { id: partnerA1.id }, select: { notes: true, name: true, isActive: true } })
    expect(row!.notes).toBe('PRIME-PRIVATE-NOTE')
    expect(row!.name).toBe('PC Partner A1')
    expect(row!.isActive).toBe(true)
  })

  it('stores a proposal without touching the partner record', async () => {
    const res = await request(app).post('/api/partner-portal/profile/change-requests').set(auth(userA1.token))
      .send({ proposed: { website: 'https://a1.example', contactPhone: '555-0100' }, submittedNote: 'New site' })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('PENDING_REVIEW')
    const row = await prisma.partner.findUnique({ where: { id: partnerA1.id }, select: { website: true, contactPhone: true } })
    expect(row!.website).toBeNull()
    expect(row!.contactPhone).toBeNull()
  })

  it('allows only one outstanding proposal at a time', async () => {
    const res = await request(app).post('/api/partner-portal/profile/change-requests').set(auth(userA1.token))
      .send({ proposed: { geography: 'CONUS' } })
    expect(res.status).toBe(422)
  })

  it('applies only the allowlisted fields when a prime ADMIN approves', async () => {
    const pending = await prisma.partnerProfileChangeRequest.findFirst({
      where: { partnerId: partnerA1.id, status: 'PENDING_REVIEW' }, select: { id: true },
    })
    // A forged field written straight into the stored JSON must still not apply.
    await prisma.partnerProfileChangeRequest.update({
      where: { id: pending!.id },
      data: { proposed: { website: 'https://a1.example', contactPhone: '555-0100', notes: 'FORGED', name: 'FORGED' } },
    })
    const res = await request(app).post(`/api/partner-portal/admin/profile-change-requests/${pending!.id}/review`)
      .set(auth(adminA.token)).send({ status: 'ACCEPTED' })
    expect(res.status).toBe(200)

    const row = await prisma.partner.findUnique({
      where: { id: partnerA1.id }, select: { website: true, contactPhone: true, notes: true, name: true },
    })
    expect(row!.website).toBe('https://a1.example')
    expect(row!.contactPhone).toBe('555-0100')
    expect(row!.notes).toBe('PRIME-PRIVATE-NOTE')
    expect(row!.name).toBe('PC Partner A1')
  })

  it('refuses the review to a non-admin and across tenants', async () => {
    const req2 = await request(app).post('/api/partner-portal/profile/change-requests').set(auth(userA1.token))
      .send({ proposed: { geography: 'OCONUS' } })
    expect(req2.status).toBe(201)
    const consultant = await createTestUser(firmA.id, { role: 'CONSULTANT' })
    expect((await request(app).post(`/api/partner-portal/admin/profile-change-requests/${req2.body.data.id}/review`)
      .set(auth(consultant.token)).send({ status: 'ACCEPTED' })).status).toBe(403)
    expect((await request(app).post(`/api/partner-portal/admin/profile-change-requests/${req2.body.data.id}/review`)
      .set(auth(adminB.token)).send({ status: 'ACCEPTED' })).status).toBe(404)
  })
})

// -------------------------------------------------------------
// §16 — partner personnel promotion carries its attachment
// -------------------------------------------------------------

describe('§8.4 partner personnel promotion with attachments', () => {
  it('promotes as a DRAFT carrying the file and its provenance, never as approved', async () => {
    const submitted = await request(app).post('/api/partner-portal/personnel-contributions').set(auth(userA1.token))
      .field('scopeType', 'CONTRACT').field('scopeId', contractA1.id)
      .field('fullName', 'Dana Okafor').field('proposedRole', 'Lead Analyst')
      .field('content', JSON.stringify({ summary: 'Ten years of analysis work.' }))
      .attach('file', Buffer.from('PARTNER-RESUME-BYTES'), { filename: 'dana.pdf', contentType: 'application/pdf' })
    expect(submitted.status).toBe(201)

    const review = await request(app).post(`/api/partner-portal/admin/submissions/personnel/${submitted.body.data.id}/review`)
      .set(auth(adminA.token)).send({ status: 'ACCEPTED', importIntoLibrary: true })
    expect(review.status).toBe(200)

    const personnelId = review.body.data.importedPersonnelId as string
    expect(personnelId).toBeTruthy()
    const resume = await prisma.personnelResume.findFirst({
      where: { personnelId },
      select: {
        status: true, source: true, fileName: true, storageKey: true,
        sourcePartnerId: true, sourcePartnerSubmissionId: true, sourcePartnerUploadId: true, approvedAt: true,
      },
    })
    expect(resume!.status).toBe('DRAFT')
    expect(resume!.approvedAt).toBeNull()
    expect(resume!.source).toBe('PARTNER_SUBMITTED')
    expect(resume!.fileName).toBe('dana.pdf')
    expect(resume!.storageKey).toBeTruthy()
    expect(resume!.sourcePartnerId).toBe(partnerA1.id)
    expect(resume!.sourcePartnerSubmissionId).toBe(submitted.body.data.id)
    expect(resume!.sourcePartnerUploadId).toBeTruthy()
  })
})

// §8.3 — the prime's decision on a document the partner uploaded.
//
// The tenant matrix matters as much as the happy path: a review is a write, so
// the same "wrong firm must not reach it" question the download tests ask is
// asked again here.
describe('§8.4 partner document review', () => {
  const review = (token: string, id: string, body: Record<string, unknown>) =>
    request(app).post(`/api/partner-portal/admin/submissions/uploads/${id}/review`).set(auth(token)).send(body)

  it('lists a partner upload to its own firm only', async () => {
    const resA = await request(app).get('/api/partner-portal/admin/submissions').set(auth(adminA.token)).expect(200)
    const idsA = (resA.body.data.uploads as Array<{ id: string }>).map((u) => u.id)
    expect(idsA).toContain(docA1)
    expect(idsA).not.toContain(docB1)
  })

  it('records an acceptance with the reviewer and the note', async () => {
    const res = await review(adminA.token, docA1, { status: 'ACCEPTED', reviewNotes: 'Received.' }).expect(200)
    expect(res.body.data.reviewStatus).toBe('ACCEPTED')
    expect(res.body.data.reviewNotes).toBe('Received.')

    const row = await prisma.partnerPortalUpload.findUnique({ where: { id: docA1 } })
    expect(row!.reviewedByUserId).toBe(adminA.id)
    expect(row!.reviewedAt).not.toBeNull()
  })

  it('shows the partner its own decision', async () => {
    const res = await request(app).get('/api/partner-portal/documents').set(auth(userA1.token)).expect(200)
    const row = (res.body.data as Array<{ id: string; reviewStatus: string; reviewNotes: string }>).find((d) => d.id === docA1)
    expect(row!.reviewStatus).toBe('ACCEPTED')
    expect(row!.reviewNotes).toBe('Received.')
  })

  it('refuses a second decision rather than silently overwriting the first', async () => {
    const res = await review(adminA.token, docA1, { status: 'REJECTED' }).expect(422)
    expect(res.body.code).toBe('VALIDATION_ERROR')
    const row = await prisma.partnerPortalUpload.findUnique({ where: { id: docA1 } })
    expect(row!.reviewStatus).toBe('ACCEPTED')
  })

  it('refuses another firm the upload entirely', async () => {
    await review(adminB.token, docA2, { status: 'ACCEPTED' }).expect(404)
    const row = await prisma.partnerPortalUpload.findUnique({ where: { id: docA2 } })
    expect(row!.reviewStatus).toBe('PENDING_REVIEW')
  })

  it('rejects a verdict that is neither acceptance nor rejection', async () => {
    await review(adminA.token, docA2, { status: 'MAYBE' }).expect(422)
  })

  it('is closed to the partner themselves', async () => {
    await request(app).post(`/api/partner-portal/admin/submissions/uploads/${docA2}/review`)
      .set(auth(userA1.token)).send({ status: 'ACCEPTED' }).expect(401)
  })

  it('records a rejection without touching the stored file', async () => {
    const before = await prisma.partnerPortalUpload.findUnique({ where: { id: docA2 } })
    await review(adminA.token, docA2, { status: 'REJECTED', reviewNotes: 'Wrong period.' }).expect(200)
    const after = await prisma.partnerPortalUpload.findUnique({ where: { id: docA2 } })
    expect(after!.reviewStatus).toBe('REJECTED')
    expect(after!.storageKey).toBe(before!.storageKey)
    expect(after!.fileName).toBe(before!.fileName)
  })
})

// §8.3 — re-inviting an address that was revoked.
//
// Revoking is a soft delete and `[consultingFirmId, email]` is unique, so
// treating a revoked row as a duplicate would lock that person out of the
// portal forever. Letting them back in must still destroy the old credential.
describe('§8.4 re-inviting a revoked partner portal user', () => {
  const OLD_PASSWORD = 'RevokedOldPass123!'
  const NEW_PASSWORD = 'RestoredNewPass456!'
  let email = ''
  let firstId = ''
  let accessId = ''
  let reInviteToken = ''

  const invite = (partnerId: string, addr: string) =>
    request(app).post('/api/partner-portal/admin/users').set(auth(adminA.token))
      .send({ partnerId, email: addr, firstName: 'Round', lastName: 'Trip' })

  it('refuses a second invite while the account is still live', async () => {
    email = `pc-revive-${Date.now()}@ext.test`
    const first = await invite(partnerA1.id, email).expect(201)
    firstId = first.body.data.id
    await request(app).post('/api/partner-portal/auth/accept-invite')
      .send({ token: first.body.data.inviteToken, password: OLD_PASSWORD }).expect(200)

    accessId = await grant(adminA, firstId, 'CONTRACT', contractA1.id)
    const dup = await invite(partnerA1.id, email).expect(422)
    expect(dup.body.code).toBe('VALIDATION_ERROR')
  })

  it('allows the invite once the account is revoked, reusing the same row', async () => {
    await request(app).post(`/api/partner-portal/admin/users/${firstId}/revoke`)
      .set(auth(adminA.token)).expect(200)

    const again = await invite(partnerA1.id, email).expect(201)
    expect(again.body.data.id).toBe(firstId)
    expect(again.body.data.inviteToken).toBeTruthy()
    reInviteToken = again.body.data.inviteToken

    const row = await prisma.partnerPortalUser.findUnique({ where: { id: firstId } })
    expect(row!.revokedAt).toBeNull()
    expect(row!.isActive).toBe(true)
  })

  it('destroys the old password so the revoked credential can never sign in again', async () => {
    const stale = await request(app).post('/api/partner-portal/auth/login')
      .send({ email, password: OLD_PASSWORD })
    expect(stale.status).not.toBe(200)

    const row = await prisma.partnerPortalUser.findUnique({ where: { id: firstId } })
    expect(row!.passwordHash).toBeNull()
    expect(row!.acceptedAt).toBeNull()
    expect(row!.mfaEnabled).toBe(false)
    expect(row!.mfaSecret).toBeNull()
  })

  it('leaves the old engagement grants revoked — letting them back in is not re-granting access', async () => {
    const access = await prisma.partnerEngagementAccess.findUnique({ where: { id: accessId } })
    expect(access!.revokedAt).not.toBeNull()
  })

  it('signs in again only after the new invite is accepted, and sees an empty portal', async () => {
    await request(app).post('/api/partner-portal/auth/accept-invite')
      .send({ token: reInviteToken, password: NEW_PASSWORD }).expect(200)

    const login = await request(app).post('/api/partner-portal/auth/login')
      .send({ email, password: NEW_PASSWORD }).expect(200)

    const engagements = await request(app).get('/api/partner-portal/engagements')
      .set(auth(login.body.data.token)).expect(200)
    expect(engagements.body.data.contracts).toHaveLength(0)
    expect(engagements.body.data.purchaseOrders).toHaveLength(0)
  })

  it('never lets a re-invite reach another tenant', async () => {
    await request(app).post('/api/partner-portal/admin/users').set(auth(adminB.token))
      .send({ partnerId: partnerA1.id, email, firstName: 'Round', lastName: 'Trip' }).expect(404)
  })
})
