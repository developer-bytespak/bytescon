// The session cookie was renamed with the app (bytescon_token -> bytesgov_token).
// The old one still signs a person in, and the new one wins when both are sent.
import { describe, it, expect } from 'vitest'
import type { Request } from 'express'
import { extractSessionToken, SESSION_COOKIE_NAME, LEGACY_SESSION_COOKIE_NAME } from './auth'

const req = (cookie?: string, authorization?: string) => ({ headers: { cookie, authorization } }) as unknown as Request

describe('extractSessionToken', () => {
  it('reads the new cookie', () => {
    expect(SESSION_COOKIE_NAME).toBe('bytesgov_token')
    expect(extractSessionToken(req('bytesgov_token=new'))).toBe('new')
  })
  it('still reads the cookie from before the rename', () => {
    expect(LEGACY_SESSION_COOKIE_NAME).toBe('bytescon_token')
    expect(extractSessionToken(req('other=1; bytescon_token=old'))).toBe('old')
  })
  it('prefers the new cookie, and a Bearer header over both', () => {
    expect(extractSessionToken(req('bytescon_token=old; bytesgov_token=new'))).toBe('new')
    expect(extractSessionToken(req('bytescon_token=old', 'Bearer hdr'))).toBe('hdr')
    expect(extractSessionToken(req())).toBeNull()
  })
})
