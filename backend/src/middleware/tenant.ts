// =============================================================
// Tenant Isolation Middleware
// Ensures all queries are scoped to consultingFirmId
// =============================================================
import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../types';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';

// HTTP methods that only read state. Everything else mutates.
const READ_ONLY_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Validates that the authenticated user's consultingFirmId matches
 * the resource being accessed. Must be called AFTER authenticateJWT.
 *
 * Also enforces the read-only team-member policy: CONSULTANT accounts may
 * VIEW all of their firm's data but may not mutate it (admins manage the
 * firm).
 *
 * Scoped completion tokens are REJECTED here. The only JWT scope today is
 * 'accept_agreements' (minted by login gate-2). Its sole legitimate destination
 * is POST /api/auth/complete-agreements, which authenticates with authenticateJWT
 * only and never passes through this middleware — so rejecting scopes here locks
 * nobody out, while closing the hole where the login completion token was honored
 * as a full read/write session on every tenant-scoped router (and let read-only
 * CONSULTANTs mutate data via a pre-ToS token).
 *
 * Account maintenance under /api/auth (login, email verification, ToS/NDA
 * acceptance, password change) is likewise never blocked — those routes do not
 * use this middleware.
 */
export function enforceTenantScope(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): void {
  if (!req.user?.consultingFirmId) {
    throw new UnauthorizedError('Tenant context missing');
  }

  // Reject single-purpose scoped tokens on any tenant-scoped route. See the
  // doc-comment above: the only legitimate scoped-token endpoint does not use
  // this middleware, so this never blocks the login-completion flow.
  if (req.user.scope) {
    throw new ForbiddenError(
      'This endpoint requires a full session. Complete the agreements flow first.'
    );
  }

  if (
    req.user.role === 'CONSULTANT' &&
    !READ_ONLY_SAFE_METHODS.has(req.method)
  ) {
    throw new ForbiddenError(
      'Your team-member account has read-only access. Ask a firm admin to make this change.'
    );
  }

  next();
}

/**
 * Returns the consultingFirmId from the authenticated request.
 * Use this in every service/controller to scope database queries.
 */
export function getTenantId(req: AuthenticatedRequest): string {
  if (!req.user?.consultingFirmId) {
    throw new UnauthorizedError('Tenant context missing');
  }
  return req.user.consultingFirmId;
}
