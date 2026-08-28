// =============================================================
// alertService — unit tests (mocked channels). The alerting
// primitive must (1) fan out to whatever is configured, (2)
// suppress repeats of the same key, and (3) NEVER throw — it runs
// inside the failure paths it reports on.
// =============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./mailer', () => ({
  sendEmail: vi.fn(async () => ({ delivered: true })),
}))
vi.mock('./smsService', () => ({
  sendSms: vi.fn(async () => ({ success: true })),
  isTwilioConfigured: vi.fn(() => false),
}))
vi.mock('../config/redis', () => ({
  // status !== 'ready' → alertService falls back to its in-memory throttle
  redis: { status: 'end', set: vi.fn() },
}))
vi.mock('axios', () => ({
  default: { post: vi.fn(async () => ({ status: 200 })) },
}))

import axios from 'axios'
import { sendOpsAlert } from './alertService'
import { sendEmail } from './mailer'
import { sendSms, isTwilioConfigured } from './smsService'

const mockedSendEmail = vi.mocked(sendEmail)
const mockedSendSms = vi.mocked(sendSms)
const mockedTwilioConfigured = vi.mocked(isTwilioConfigured)
const mockedPost = vi.mocked(axios.post)

const ENV_KEYS = [
  'PLATFORM_ADMIN_EMAIL',
  'PLATFORM_ADMIN_EMAILS',
  'EMAIL_FROM',
  'ALERT_WEBHOOK_URL',
  'ALERT_SMS_TO',
  'ALERT_THROTTLE_HOURS',
] as const
const savedEnv: Record<string, string | undefined> = {}

let seq = 0
const uniqueKey = () => `test-alert-${Date.now()}-${++seq}`

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  vi.clearAllMocks()
  mockedSendEmail.mockResolvedValue({ delivered: true })
  mockedTwilioConfigured.mockReturnValue(false)
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

describe('sendOpsAlert', () => {
  it('emails the configured admin', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@test.local'
    const res = await sendOpsAlert({ key: uniqueKey(), title: 'Something died' })
    expect(res).toMatchObject({ sent: true, channels: ['email'] })
    expect(mockedSendEmail).toHaveBeenCalledTimes(1)
    expect(mockedSendEmail.mock.calls[0][0].to).toBe('ops@test.local')
    expect(mockedSendEmail.mock.calls[0][0].subject).toContain('WARNING')
  })

  it('falls back to the first PLATFORM_ADMIN_EMAILS entry', async () => {
    process.env.PLATFORM_ADMIN_EMAILS = 'first@test.local,second@test.local'
    const res = await sendOpsAlert({ key: uniqueKey(), title: 'x' })
    expect(res.sent).toBe(true)
    expect(mockedSendEmail.mock.calls[0][0].to).toBe('first@test.local')
  })

  it('throttles repeats of the same key', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@test.local'
    const key = uniqueKey()
    const first = await sendOpsAlert({ key, title: 'x' })
    const second = await sendOpsAlert({ key, title: 'x' })
    expect(first.sent).toBe(true)
    expect(second).toMatchObject({ sent: false, throttled: true })
    expect(mockedSendEmail).toHaveBeenCalledTimes(1)
  })

  it('does not throttle distinct keys', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@test.local'
    await sendOpsAlert({ key: uniqueKey(), title: 'x' })
    await sendOpsAlert({ key: uniqueKey(), title: 'y' })
    expect(mockedSendEmail).toHaveBeenCalledTimes(2)
  })

  it('posts to the webhook when configured', async () => {
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.test.local/ops'
    const res = await sendOpsAlert({ key: uniqueKey(), title: 'hook me' })
    expect(res.channels).toContain('webhook')
    expect(mockedPost).toHaveBeenCalledTimes(1)
    const [url, payload] = mockedPost.mock.calls[0]
    expect(url).toBe('https://hooks.test.local/ops')
    expect((payload as any).text).toContain('hook me')
    expect((payload as any).content).toContain('hook me')
  })

  it('sends SMS only for critical severity when Twilio + recipient configured', async () => {
    process.env.ALERT_SMS_TO = '+15555550100'
    mockedTwilioConfigured.mockReturnValue(true)

    await sendOpsAlert({ key: uniqueKey(), title: 'warn', severity: 'warning' })
    expect(mockedSendSms).not.toHaveBeenCalled()

    const res = await sendOpsAlert({ key: uniqueKey(), title: 'crit', severity: 'critical' })
    expect(res.channels).toContain('sms')
    expect(mockedSendSms).toHaveBeenCalledTimes(1)
  })

  it('reports sent:false without throwing when no channel delivers', async () => {
    mockedSendEmail.mockResolvedValue({ delivered: false, devFallback: true })
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@test.local'
    const res = await sendOpsAlert({ key: uniqueKey(), title: 'x' })
    expect(res).toMatchObject({ sent: false, channels: [] })
  })

  it('never throws even when every channel explodes', async () => {
    process.env.PLATFORM_ADMIN_EMAIL = 'ops@test.local'
    process.env.ALERT_WEBHOOK_URL = 'https://hooks.test.local/ops'
    mockedSendEmail.mockRejectedValue(new Error('resend down'))
    mockedPost.mockRejectedValue(new Error('webhook down'))
    const res = await sendOpsAlert({ key: uniqueKey(), title: 'x', severity: 'critical' })
    expect(res.sent).toBe(false)
  })
})
