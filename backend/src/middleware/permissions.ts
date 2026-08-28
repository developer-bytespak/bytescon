// =============================================================
// §8.5 — Permission middleware.
//
// The one place a permission is checked. Routes declare what they need
// (`requirePermission('FINANCE_APPROVE')`) instead of naming roles, so the
// answer to "who can approve an invoice?" lives in permissions.ts rather than
// scattered across forty routers.
//
// TENANT SCOPE IS SEPARATE. This middleware answers "may this person do this
// kind of thing?" and nothing else. `enforceTenantScope` still answers "whose
// data is this?", and every query still carries its own tenant clause. A
// permission is never a substitute for either.
// =============================================================
import { Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { UnauthorizedError, ForbiddenError } from '../utils/errors'
import { resolvePermissions, type Permission } from '../services/rbac/permissions'

interface PermissionRequest extends AuthenticatedRequest {
  /** Resolved once per request, so a route with two gates costs one query. */
  resolvedPermissions?: Set<Permission>
}

/**
 * The caller's effective permissions.
 *
 * Additive per-user grants are read from the database rather than the token, so
 * removing a grant takes effect on the next request instead of at token expiry.
 * A missing user row resolves to no permissions at all — fail closed.
 */
export async function loadPermissions(req: PermissionRequest): Promise<Set<Permission>> {
  if (req.resolvedPermissions) return req.resolvedPermissions
  if (!req.user) throw new UnauthorizedError()

  const row = await prisma.user.findUnique({
    where: { id: req.user.userId },
    select: { role: true, extraPermissions: true, isActive: true, consultingFirmId: true },
  })
  // A deactivated or deleted account holds nothing, whatever its token says.
  const resolved = !row || !row.isActive || row.consultingFirmId !== req.user.consultingFirmId
    ? new Set<Permission>()
    : resolvePermissions(row.role, row.extraPermissions)

  req.resolvedPermissions = resolved
  return resolved
}

/** Gate a route on one permission. */
export function requirePermission(permission: Permission) {
  return async (req: PermissionRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const held = await loadPermissions(req)
      if (!held.has(permission)) {
        // Deliberately names the permission: an operator reading a 403 should
        // learn what to grant, not have to guess.
        throw new ForbiddenError(`This action requires the ${permission} permission`)
      }
      next()
    } catch (err) { next(err) }
  }
}

/** Gate a route on holding at least one of several permissions. */
export function requireAnyPermission(...permissions: Permission[]) {
  return async (req: PermissionRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const held = await loadPermissions(req)
      if (!permissions.some((p) => held.has(p))) {
        throw new ForbiddenError(`This action requires one of: ${permissions.join(', ')}`)
      }
      next()
    } catch (err) { next(err) }
  }
}

/** For handlers that branch on a capability rather than refuse outright. */
export async function callerHasPermission(
  req: AuthenticatedRequest, permission: Permission,
): Promise<boolean> {
  return (await loadPermissions(req as PermissionRequest)).has(permission)
}
