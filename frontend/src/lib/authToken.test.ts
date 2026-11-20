// =============================================================
// Section 4 auth review — getStoredAuthToken reads the token from the same key
// the login flow writes ('bytesgov_auth'), replacing a dead 'auth_token' key that
// caused Bearer-null (unauthenticated) requests.
// =============================================================
import { describe, it, expect, beforeEach } from 'vitest'
import { getStoredAuthToken } from './authToken'

describe('getStoredAuthToken', () => {
  beforeEach(() => localStorage.clear())

  it('returns null when nothing is stored', () => {
    expect(getStoredAuthToken()).toBeNull()
  })

  it('returns the token from the bytesgov_auth session blob', () => {
    localStorage.setItem('bytesgov_auth', JSON.stringify({ token: 'jwt-123', user: { id: 'u1' } }))
    expect(getStoredAuthToken()).toBe('jwt-123')
  })

  it('returns null (does not throw) on corrupt storage', () => {
    localStorage.setItem('bytesgov_auth', '{not json')
    expect(getStoredAuthToken()).toBeNull()
  })

  it('does not read the dead legacy auth_token key', () => {
    localStorage.setItem('auth_token', 'legacy-should-be-ignored')
    expect(getStoredAuthToken()).toBeNull()
  })
})
