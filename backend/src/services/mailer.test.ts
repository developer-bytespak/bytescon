import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { sendEmail, buildEmailVerificationUrl, buildPasswordResetUrl } from './mailer'

describe('mailer', () => {
  const origKey = process.env.SENDGRID_API_KEY
  const origAppUrl = process.env.PUBLIC_APP_URL

  beforeEach(() => {
    delete process.env.SENDGRID_API_KEY
  })

  afterEach(() => {
    if (origKey !== undefined) process.env.SENDGRID_API_KEY = origKey
    else delete process.env.SENDGRID_API_KEY
    if (origAppUrl !== undefined) process.env.PUBLIC_APP_URL = origAppUrl
    else delete process.env.PUBLIC_APP_URL
  })

  describe('dev fallback (SENDGRID_API_KEY unset)', () => {
    it('returns devFallback:true without sending', async () => {
      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Test',
        textBody: 'Hello',
      })
      expect(result.delivered).toBe(false)
      expect(result.devFallback).toBe(true)
    })

    it('does NOT include providerMessageId in dev fallback', async () => {
      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Test',
        textBody: 'Hello',
      })
      expect(result.providerMessageId).toBeUndefined()
    })

    it('does NOT include error in dev fallback', async () => {
      const result = await sendEmail({
        to: 'user@example.com',
        subject: 'Test',
        textBody: 'Hello',
      })
      expect(result.error).toBeUndefined()
    })
  })

  describe('SendGrid API path (key set, fetch mocked)', () => {
    beforeEach(() => {
      process.env.SENDGRID_API_KEY = 'SG.test_key_xxx'
    })

    it('calls SendGrid with correct body and returns delivered:true on 202', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          // SendGrid success: 202 with an EMPTY body; id in the header.
          new Response(null, {
            status: 202,
            headers: { 'x-message-id': 'msg-abc-123' },
          }),
        )

      const result = await sendEmail({
        to: 'recipient@example.com',
        subject: 'Verify',
        textBody: 'click link',
        category: 'EMAIL_VERIFICATION',
      })

      expect(result.delivered).toBe(true)
      expect(result.provider).toBe('sendgrid')
      expect(result.providerMessageId).toBe('msg-abc-123')
      expect(result.devFallback).toBeUndefined()

      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.sendgrid.com/v3/mail/send')
      const body = JSON.parse((init as RequestInit).body as string)
      expect(body.personalizations).toEqual([{ to: [{ email: 'recipient@example.com' }] }])
      expect(body.subject).toBe('Verify')
      // text/plain must precede text/html in SendGrid's content array.
      expect(body.content[0]).toEqual({ type: 'text/plain', value: 'click link' })
      expect(body.categories).toEqual(['EMAIL_VERIFICATION'])
      // Deliverability: a replyable address and a List-Unsubscribe header.
      expect(body.reply_to.email).toMatch(/@/)
      expect(body.headers['List-Unsubscribe']).toMatch(/^<mailto:.+@.+>$/)

      fetchMock.mockRestore()
    })

    it('returns delivered:false with error string on 4xx', async () => {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response('{"message":"Maximum credits exceeded"}', { status: 401 }),
        )

      const result = await sendEmail({
        to: 'recipient@example.com',
        subject: 'Test',
        textBody: 'x',
      })

      expect(result.delivered).toBe(false)
      expect(result.provider).toBe('sendgrid')
      expect(result.error).toMatch(/status=401/)
      expect(result.error).toMatch(/Maximum credits/)

      fetchMock.mockRestore()
    })
  })
})

describe('URL builders', () => {
  it('buildEmailVerificationUrl uses PUBLIC_APP_URL when set', () => {
    process.env.PUBLIC_APP_URL = 'https://example.test'
    expect(buildEmailVerificationUrl('abc123')).toBe(
      'https://example.test/verify-email?token=abc123',
    )
  })

  it('buildEmailVerificationUrl falls back to localhost when env unset', () => {
    delete process.env.PUBLIC_APP_URL
    expect(buildEmailVerificationUrl('abc123')).toBe(
      'http://localhost:5173/verify-email?token=abc123',
    )
  })

  it('encodes the token component', () => {
    process.env.PUBLIC_APP_URL = 'https://example.test'
    expect(buildEmailVerificationUrl('a/b c+d')).toBe(
      'https://example.test/verify-email?token=a%2Fb%20c%2Bd',
    )
  })

  it('buildPasswordResetUrl uses /reset-password path', () => {
    process.env.PUBLIC_APP_URL = 'https://example.test'
    expect(buildPasswordResetUrl('xyz')).toBe('https://example.test/reset-password?token=xyz')
  })
})
