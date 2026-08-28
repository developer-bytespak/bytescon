// =============================================================
// MFA (TOTP) — enroll, mfa_challenge verify, recovery codes, scope security,
// break-glass reset. Exercises the new endpoints via minted tokens (the /login
// gate for MFA-enabled users depends on global ToS fixtures and is covered by
// review + the existing non-MFA login integration tests, which stay green).
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import * as OTPAuth from 'otpauth'
import { Express } from 'express'
import { prisma } from '../config/database'
import { config } from '../config/config'
import {
  buildTestApp,
  createTestFirm,
  createTestUser,
  cleanupFirm,
  disconnectDb,
  TestFirm,
  TestUser,
} from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let user: TestUser
const ORIGINAL_PA = process.env.PLATFORM_ADMIN_EMAILS

function totpCode(base32: string): string {
  return new OTPAuth.TOTP({
    issuer: 'Bytescon',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(base32),
  }).generate()
}

function mfaChallengeToken(): string {
  return jwt.sign(
    { userId: user.id, consultingFirmId: firm.id, role: user.role, email: user.email, scope: 'mfa_challenge' },
    config.jwt.secret,
    { expiresIn: '10m' },
  )
}

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'MFA Firm' })
  user = await createTestUser(firm.id, { role: 'ADMIN' }) // returns a full-session token
})

afterAll(async () => {
  await cleanupFirm(firm.id)
  if (ORIGINAL_PA === undefined) delete process.env.PLATFORM_ADMIN_EMAILS
  else process.env.PLATFORM_ADMIN_EMAILS = ORIGINAL_PA
  await disconnectDb()
})

describe('MFA (TOTP)', () => {
  let secret: string
  let recoveryCodes: string[]

  it('enroll returns a secret + otpauth URI', async () => {
    const res = await request(app).post('/api/auth/mfa/enroll').set('Authorization', `Bearer ${user.token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.secret).toBeTruthy()
    expect(res.body.data.otpauthUri).toContain('otpauth://totp/')
    secret = res.body.data.secret
  })

  it('enroll/verify rejects a bad code', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/enroll/verify')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ code: '000000' })
    expect(res.status).toBe(401)
  })

  it('enroll/verify with a valid code enables MFA + returns 10 recovery codes', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/enroll/verify')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ code: totpCode(secret) })
    expect(res.status).toBe(200)
    expect(res.body.data.recoveryCodes).toHaveLength(10)
    recoveryCodes = res.body.data.recoveryCodes

    const status = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${user.token}`)
    expect(status.body.data.enabled).toBe(true)
  })

  it('mfa/verify with a full (non-challenge) token is rejected (WRONG_SCOPE)', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/verify')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ code: totpCode(secret) })
    expect(res.status).toBe(403)
    expect(res.body.code).toBe('WRONG_SCOPE')
  })

  it('mfa/verify with a challenge token + valid TOTP issues a full session', async () => {
    const res = await request(app)
      .post('/api/auth/mfa/verify')
      .set('Authorization', `Bearer ${mfaChallengeToken()}`)
      .send({ code: totpCode(secret) })
    expect(res.status).toBe(200)
    expect(res.body.data.token).toBeTruthy()
    expect(res.body.data.user.id).toBe(user.id)
  })

  it('a challenge token cannot reach a full-session endpoint (enroll → 403)', async () => {
    const res = await request(app).post('/api/auth/mfa/enroll').set('Authorization', `Bearer ${mfaChallengeToken()}`)
    expect(res.status).toBe(403)
  })

  it('a challenge token is confined — rejected on /profile and /change-password', async () => {
    const profile = await request(app).get('/api/auth/profile').set('Authorization', `Bearer ${mfaChallengeToken()}`)
    expect(profile.status).toBe(403)
    const pw = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${mfaChallengeToken()}`)
      .send({ currentPassword: 'x', newPassword: 'yyyyyyyy' })
    expect(pw.status).toBe(403)
  })

  it('a recovery code works once, then is consumed', async () => {
    const rc = recoveryCodes[0]
    const first = await request(app)
      .post('/api/auth/mfa/verify')
      .set('Authorization', `Bearer ${mfaChallengeToken()}`)
      .send({ code: rc })
    expect(first.status).toBe(200)

    const reuse = await request(app)
      .post('/api/auth/mfa/verify')
      .set('Authorization', `Bearer ${mfaChallengeToken()}`)
      .send({ code: rc })
    expect(reuse.status).toBe(401)
  })

  it('break-glass: a platform admin resets a user’s MFA', async () => {
    process.env.PLATFORM_ADMIN_EMAILS = user.email
    const res = await request(app)
      .post('/api/auth/mfa/reset')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ userId: user.id })
    expect(res.status).toBe(200)

    const status = await request(app).get('/api/auth/mfa/status').set('Authorization', `Bearer ${user.token}`)
    expect(status.body.data.enabled).toBe(false)
  })
})
