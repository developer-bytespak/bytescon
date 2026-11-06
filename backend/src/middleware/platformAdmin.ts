// =============================================================
// Platform Administrator gate.
//
// A small set of platform operators (Bytes Platform) who may moderate CROSS-TENANT
// content — today: approving shared templates before they become visible to
// every firm. This is deliberately NOT the per-firm ADMIN role: a firm admin
// approving their own firm's template is self-approval, which let one tenant's
// (weakly anonymized) client document reach all tenants with no independent
// review. See CODE_REVIEW_2026-06-27.md (C5).
//
// Membership is an env allowlist: PLATFORM_ADMIN_EMAILS="a@x.com,b@y.com".
// If unset, NOBODY is a platform admin — cross-tenant approval is effectively
// frozen, which is the safe default (better to leave templates pending than to
// auto-expose them).
// =============================================================
import { Response, NextFunction } from 'express'
import { AuthenticatedRequest } from '../types'
import { ForbiddenError } from '../utils/errors'

export function getPlatformAdminEmails(): Set<string> {
  return new Set(
    (process.env.PLATFORM_ADMIN_EMAILS || '')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function isPlatformAdmin(email?: string | null): boolean {
  if (!email) return false
  return getPlatformAdminEmails().has(email.toLowerCase())
}

/** The one demo login that may pull more from SAM.gov. Unset, nobody can. */
export function isPoolAdmin(email?: string | null): boolean {
  const poolAdmin = (process.env.DEMO_POOL_ADMIN_EMAIL || '').trim().toLowerCase()
  return Boolean(email && poolAdmin && email.toLowerCase() === poolAdmin)
}

/** Must run after authenticateJWT (needs req.user.email). */
export function requirePlatformAdmin(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  if (!isPlatformAdmin(req.user?.email)) {
    throw new ForbiddenError('Platform administrator access required.')
  }
  next()
}

/** Must run after authenticateJWT (needs req.user.email). */
export function requirePoolAdmin(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  if (!isPoolAdmin(req.user?.email)) {
    throw new ForbiddenError('Only the pool administrator can do this.')
  }
  next()
}
