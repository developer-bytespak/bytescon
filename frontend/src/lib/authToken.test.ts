// =============================================================
// Section 4 auth review — getStoredAuthToken reads the token from the same key
// the login flow writes ('bytescon_auth'), replacing a dead 'auth_token' key that
// caused Bearer-null (unauthenticated) requests.
// =============================================================
import { describe, it, expect, beforeEach } from 'vitest'
import { getStoredAuthToken } from './authToken'

describe('getStoredAuthToken', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when nothing is stored', () => {
    expect(getStoredAuthToken()).toBeNull()
  })

  it('returns the token from the bytescon_auth session blob', () => {
    localStorage.setItem('bytescon_auth', JSON.stringify({ token: 'jwt-123', user: { id: 'u1' } }))
    expect(getStoredAuthToken()).toBe('jwt-123')
  })

  it('returns null (does not throw) on corrupt storage', () => {
    localStorage.setItem('bytescon_auth', '{not json')
    expect(getStoredAuthToken()).toBeNull()
  })

  it('does not read the dead legacy auth_token key', () => {
    localStorage.setItem('auth_token', 'legacy-should-be-ignored')
    expect(getStoredAuthToken()).toBeNull()
  })
})
