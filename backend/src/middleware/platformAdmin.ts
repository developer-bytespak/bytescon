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

/** Must run after authenticateJWT (needs req.user.email). */
export function requirePlatformAdmin(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  if (!isPlatformAdmin(req.user?.email)) {
    throw new ForbiddenError('Platform administrator access required.')
  }
  next()
}
