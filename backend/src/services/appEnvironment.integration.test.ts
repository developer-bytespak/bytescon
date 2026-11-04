// =============================================================
// Staging is internal-only (doc 20, C1–C3, C7).
//
//   - Only staff on STAGING_ALLOWED_EMAILS can sign in, however they try;
//     public sign-up is closed; removing someone ends their session.
//   - Email and SMS only reach the access lists.
//   - A staging that could charge real cards refuses to start.
//   - With APP_ENV unset, nothing changes.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'

const twilioCreate = vi.fn(async () => ({ sid: 'SM1', status: 'queued' }))
vi.mock('twilio', () => ({ default: () => ({ messages: { create: twilioCreate } }) }))

import request from 'supertest'
import type { Express } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../config/database'
import { buildJwtPayload } from '../middleware/auth'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'
import {
  assertSafeStagingSettings, getAppEnv, isStagingEmailAllowed, isStagingPhoneAllowed,
} from './appEnvironment'
import { generatePartnerChallengeToken, generatePartnerToken } from './partnerPortal/partnerAccess'
import { sendEmail } from './mailer'
import { sendSms } from './smsService'
import { readStagingSeedSettings, seedStagingData } from './stagingSeed'

const SAVED = { ...process.env }
const auth = (t: string) => ({ Authorization: `Bearer ${t}` })
const staging = (emails: string, phones = '') => {
  process.env.APP_ENV = 'staging'
  process.env.STAGING_ALLOWED_EMAILS = emails
  process.env.STAGING_ALLOWED_PHONES = phones
}

let app: Express
let firm: TestFirm
let admin: TestUser

beforeAll(async () => {
  app = buildTestApp()
  // Sign-in reads the current Terms, and a fresh CI database has none. Same
  // fixture row as auth.complete-agreements.test.ts, so the two can run together.
  await prisma.termsOfServiceVersion.upsert({
    where: { version: 'test-1.0' },
    create: { version: 'test-1.0', title: 'Test ToS', body: 'Test ToS body', contentHash: 'a'.repeat(64), effectiveAt: new Date(), isCurrent: true },
    update: { isCurrent: true },
  })
})

beforeEach(async () => {
  delete process.env.APP_ENV
  firm = await createTestFirm({ name: 'Staging Gate Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
})

afterEach(async () => {
  for (const key of ['APP_ENV', 'STAGING_ALLOWED_EMAILS', 'STAGING_ALLOWED_PHONES', 'SENDGRID_API_KEY', 'STRIPE_SECRET_KEY', 'STAGING_SEED_ADMIN_EMAIL', 'STAGING_SEED_ADMIN_PASSWORD']) {
    if (SAVED[key] === undefined) delete process.env[key]
    else process.env[key] = SAVED[key]
  }
  vi.unstubAllGlobals()
  await cleanupFirm(firm.id).catch(() => undefined)
})

afterAll(async () => {
  await disconnectDb()
})

describe('the environment setting', () => {
  it('means production unless it says staging', () => {
    expect(getAppEnv()).toBe('production')
    process.env.APP_ENV = 'production'
    expect(getAppEnv()).toBe('production')
    process.env.APP_ENV = ' Staging '
    expect(getAppEnv()).toBe('staging')
  })
})

describe('the access list', () => {
  it('matches exact addresses and whole domains, ignoring case', () => {
    staging('kamran@example.com, @BytesPlatform.com')
    expect(isStagingEmailAllowed('KAMRAN@example.com')).toBe(true)
    expect(isStagingEmailAllowed('anyone@bytesplatform.com')).toBe(true)
    expect(isStagingEmailAllowed('other@example.com')).toBe(false)
  })

  it('is not fooled by look-alike domains', () => {
    staging('@bytesplatform.com')
    expect(isStagingEmailAllowed('a@bytesplatform.com.evil.com')).toBe(false)
    expect(isStagingEmailAllowed('a@notbytesplatform.com')).toBe(false)
    expect(isStagingEmailAllowed('@bytesplatform.com')).toBe(false)
    expect(isStagingEmailAllowed(null)).toBe(false)
  })

  it('lets nobody in when it is empty', () => {
    staging('')
    expect(isStagingEmailAllowed('kamran@example.com')).toBe(false)
    expect(isStagingPhoneAllowed('+12025550100')).toBe(false)
  })

  it('allows everyone outside staging', () => {
    expect(isStagingEmailAllowed('customer@anywhere.com')).toBe(true)
    expect(isStagingPhoneAllowed('+12025550100')).toBe(true)
  })
})

describe('signing in on staging', () => {
  async function userWithPassword(email: string) {
    const password = 'Staging-Test-Pass-1!'
    const passwordHash = await bcrypt.hash(password, 4)
    await prisma.user.create({
      data: { email, passwordHash, firstName: 'S', lastName: 'T', role: 'ADMIN', consultingFirmId: firm.id, isEmailVerified: true, emailVerifiedAt: new Date() },
    })
    return { email, password }
  }

  it('refuses the right password for someone not on the list', async () => {
    const user = await userWithPassword(`outsider-${Date.now()}@example.com`)
    staging('@staff.example')
    const res = await request(app).post('/api/auth/login').send(user)
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).not.toMatch(/token/i)
  })

  it('lets a listed person past the gate', async () => {
    const user = await userWithPassword(`staff-${Date.now()}@staff.example`)
    staging('@staff.example')
    const res = await request(app).post('/api/auth/login').send(user)
    // 200, or the Terms step for a brand-new account. Not the staging refusal.
    expect([200, 403]).toContain(res.status)
    if (res.status === 403) expect(res.body.code).toBe('AGREEMENT_REQUIRED')
  })

  it('leaves sign-in alone outside staging', async () => {
    const user = await userWithPassword(`customer-${Date.now()}@example.com`)
    const res = await request(app).post('/api/auth/login').send(user)
    if (res.status === 403) expect(res.body.code).toBe('AGREEMENT_REQUIRED')
    else expect(res.status).toBe(200)
  })

  it('refuses to build any session, whichever route asks', () => {
    staging('@staff.example')
    const session = (email: string) => () => buildJwtPayload({ userId: 'u', consultingFirmId: 'f', role: 'ADMIN', email })
    expect(session('a@staff.example')).not.toThrow()
    expect(session('a@example.com')).toThrow(/access list/)
    const partner = { partnerPortalUserId: 'p', partnerId: 'x', consultingFirmId: 'f', role: 'PARTNER', email: 'a@example.com' }
    expect(() => generatePartnerToken(partner as never)).toThrow(/access list/)
    expect(() => generatePartnerChallengeToken(partner as never)).toThrow(/access list/)
  })

  it('refuses the client portal for someone not on the list', async () => {
    const company = await prisma.clientCompany.create({ data: { name: 'Portal Co', consultingFirmId: firm.id } })
    const password = 'Staging-Test-Pass-1!'
    const email = `client-${Date.now()}@example.com`
    await prisma.clientPortalUser.create({
      data: { clientCompanyId: company.id, email, passwordHash: await bcrypt.hash(password, 4), firstName: 'C', lastName: 'U', isActive: true },
    })
    staging('@staff.example')
    const res = await request(app).post('/api/client-portal/auth/login').send({ email, password })
    expect(res.status).toBe(403)
    expect(JSON.stringify(res.body)).toMatch(/access list/)
  })

  it('ends an open session when the person leaves the list', async () => {
    staging(admin.email)
    expect((await request(app).get('/api/rbac/me').set(auth(admin.token))).status).toBe(200)
    staging('@staff.example')
    expect((await request(app).get('/api/rbac/me').set(auth(admin.token))).status).toBe(401)
  })
})

describe('joining on staging', () => {
  it('closes public sign-up', async () => {
    staging('@staff.example')
    const res = await request(app).post('/api/auth/register-firm').send({ email: 'a@staff.example' })
    expect(res.status).toBe(403)
    expect(res.body.error ?? res.body.message).toMatch(/closed/i)
  })

  it.each(['invite-user', 'register-user'])('refuses to add an outsider via %s', async (route) => {
    staging(admin.email)
    const res = await request(app).post(`/api/auth/${route}`).set(auth(admin.token)).send({
      email: `outsider-${Date.now()}@example.com`, firstName: 'O', lastName: 'S', password: 'Staging-Test-Pass-1!',
    })
    expect(res.status).toBe(403)
    expect(await prisma.user.count({ where: { consultingFirmId: firm.id } })).toBe(1)
  })
})

describe('email on staging', () => {
  const message = (to: string) => ({ to, subject: 'Reset', textBody: 'secret link' })

  beforeEach(() => {
    process.env.SENDGRID_API_KEY = 'SG.test'
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 202 })))
  })

  it('drops mail to anyone off the list, without calling the provider', async () => {
    staging('@staff.example')
    const res = await sendEmail(message('client@example.com'))
    expect(res).toMatchObject({ delivered: false, stagingBlocked: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('delivers to staff', async () => {
    staging('@staff.example')
    expect((await sendEmail(message('a@staff.example'))).delivered).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('delivers to anyone outside staging', async () => {
    expect((await sendEmail(message('client@example.com'))).delivered).toBe(true)
  })
})

describe('SMS on staging', () => {
  beforeEach(() => {
    twilioCreate.mockClear()
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'ACtest')
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token')
    vi.stubEnv('TWILIO_FROM_NUMBER', '+12025550000')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('drops texts to anyone off the list', async () => {
    staging('@staff.example', '+1 202 555 0100')
    const res = await sendSms({ to: '+12025550199', body: 'hello' })
    expect(res.messageId).toBe('staging-not-sent')
    expect(twilioCreate).not.toHaveBeenCalled()
  })

  it('sends to a listed number', async () => {
    staging('@staff.example', '+1 202 555 0100')
    await sendSms({ to: '+12025550100', body: 'hello' })
    expect(twilioCreate).toHaveBeenCalledTimes(1)
  })
})

describe('starting up', () => {
  it('refuses a live Stripe key on staging', () => {
    staging('@staff.example')
    process.env.STRIPE_SECRET_KEY = 'sk_live_x'
    expect(assertSafeStagingSettings).toThrow(/live Stripe key/)
    process.env.STRIPE_SECRET_KEY = 'rk_live_x'
    expect(assertSafeStagingSettings).toThrow(/live Stripe key/)
  })

  it('accepts a test key', () => {
    staging('@staff.example')
    process.env.STRIPE_SECRET_KEY = 'sk_test_x'
    expect(assertSafeStagingSettings).not.toThrow()
  })

  it('refuses an empty access list on staging', () => {
    staging('')
    expect(assertSafeStagingSettings).toThrow(/STAGING_ALLOWED_EMAILS/)
  })

  it('checks nothing in production', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_x'
    expect(assertSafeStagingSettings).not.toThrow()
  })
})

describe('the staging seed', () => {
  const ADMIN = `seed-admin-${Date.now()}@staff.example`
  const settings = () => {
    staging('@staff.example')
    process.env.STAGING_SEED_ADMIN_EMAIL = ADMIN
    process.env.STAGING_SEED_ADMIN_PASSWORD = 'Staging-Seed-Pass-1!'
  }

  it('refuses to run outside staging', async () => {
    expect(readStagingSeedSettings).toThrow(/not staging/)
    await expect(seedStagingData(prisma)).rejects.toThrow(/not staging/)
  })

  it('refuses an admin who is off the list, or a weak password', () => {
    settings()
    process.env.STAGING_SEED_ADMIN_EMAIL = 'a@example.com'
    expect(readStagingSeedSettings).toThrow(/not on STAGING_ALLOWED_EMAILS/)
    settings()
    process.env.STAGING_SEED_ADMIN_PASSWORD = 'short'
    expect(readStagingSeedSettings).toThrow(/12 characters/)
  })

  it('creates the demo data once, and keeps a changed password', async () => {
    settings()
    const firmId = await seedStagingData(prisma)
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } })
      expect(user).toMatchObject({ role: 'ADMIN', consultingFirmId: firmId, isEmailVerified: true })
      expect(await bcrypt.compare('Staging-Seed-Pass-1!', user.passwordHash!)).toBe(true)

      process.env.STAGING_SEED_ADMIN_PASSWORD = 'A-Different-Pass-22!'
      expect(await seedStagingData(prisma)).toBe(firmId)

      const again = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } })
      expect(again.passwordHash).toBe(user.passwordHash)
      expect(await prisma.clientCompany.count({ where: { consultingFirmId: firmId } })).toBe(1)
      expect(await prisma.opportunity.count({ where: { consultingFirmId: firmId } })).toBe(3)
    } finally {
      await cleanupFirm(firmId)
    }
  })
})
