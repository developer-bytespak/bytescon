import { describe, it, expect, vi } from 'vitest'
import { enforceTenantScope } from './tenant'

// Pure middleware unit tests for the read-only team-member guard. No DB needed.
function mkReq(user: any, method = 'POST') {
  return { user, method } as any
}
const res = {} as any

describe('enforceTenantScope — read-only CONSULTANT guard', () => {
  it('blocks a CONSULTANT mutating (non-safe) request', () => {
    const next = vi.fn()
    expect(() =>
      enforceTenantScope(mkReq({ consultingFirmId: 'f1', role: 'CONSULTANT' }, 'POST'), res, next)
    ).toThrow(/read-only access/)
    expect(next).not.toHaveBeenCalled()
  })

  it('allows a CONSULTANT read (GET)', () => {
    const next = vi.fn()
    enforceTenantScope(mkReq({ consultingFirmId: 'f1', role: 'CONSULTANT' }, 'GET'), res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  // A scoped 'accept_agreements' completion token must be REJECTED on any
  // tenant-scoped route. Its only legitimate endpoint
  // (POST /api/auth/complete-agreements) authenticates with authenticateJWT
  // only and never reaches this middleware, so rejecting here is safe and
  // prevents the scoped token from acting as a full session everywhere.
  it('rejects a scoped-token request (no full session)', () => {
    const next = vi.fn()
    expect(() =>
      enforceTenantScope(
        mkReq({ consultingFirmId: 'f1', role: 'CONSULTANT', scope: 'accept_agreements' }, 'POST'),
        res,
        next
      )
    ).toThrow(/full session/)
    expect(next).not.toHaveBeenCalled()
  })

  it('rejects a scoped-token GET as well (scoped tokens are not sessions)', () => {
    const next = vi.fn()
    expect(() =>
      enforceTenantScope(
        mkReq({ consultingFirmId: 'f1', role: 'ADMIN', scope: 'accept_agreements' }, 'GET'),
        res,
        next
      )
    ).toThrow(/full session/)
    expect(next).not.toHaveBeenCalled()
  })

  it('allows an ADMIN mutating request', () => {
    const next = vi.fn()
    enforceTenantScope(mkReq({ consultingFirmId: 'f1', role: 'ADMIN' }, 'POST'), res, next)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('rejects when tenant context is missing', () => {
    const next = vi.fn()
    expect(() =>
      enforceTenantScope(mkReq({ role: 'CONSULTANT' }, 'GET'), res, next)
    ).toThrow(/Tenant context missing/)
    expect(next).not.toHaveBeenCalled()
  })
})
