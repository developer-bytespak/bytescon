// =============================================================
// Reject Scoped Token Middleware
//
// Tokens issued for a single-purpose flow (currently
// scope='accept_agreements' from the login agreements gate) must NOT
// be accepted as a general session JWT. This runs after
// authenticateJWT and rejects scoped tokens with 403.
//
// Mount it on every protected router EXCEPT the routers a scoped
// token is allowed to reach (today: /api/auth — login/profile must
// remain reachable so the user can complete the flow and pick up a
// full JWT).
// =============================================================
import { Response, NextFunction } from 'express'
import { AuthenticatedRequest } from '../types'

export function rejectScopedToken(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const scope = (req.user as any)?.scope
  if (scope) {
    res.status(403).json({
      success: false,
      error: 'This endpoint requires a full session. Complete the gating flow first.',
      code: 'SCOPED_TOKEN_REJECTED',
      requiredScope: scope,
    })
    return
  }
  next()
}
