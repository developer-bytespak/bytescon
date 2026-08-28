// =============================================================
// JWT Authentication Middleware
// =============================================================
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/config';
import { AuthenticatedRequest, JwtPayload, JwtScope, UserRole } from '../types';
import { UnauthorizedError, ForbiddenError } from '../utils/errors';
import { isTokenStale } from '../services/tokenRevocation';
import { isRole } from '../services/rbac/permissions';

// Name of the http-only session cookie set at login. The token lives in this
// cookie (not localStorage) so it is unreadable to page JS and immune to XSS
// exfiltration. The Authorization header remains supported for API/MCP clients
// and the test suite.
export const SESSION_COOKIE_NAME = 'bytescon_token';

// Parse the token out of the request without cookie-parser: a bare Bearer
// header wins, otherwise the session cookie. Header values of the literal
// strings 'null'/'undefined' (from a client that stringified a missing token)
// are treated as absent so the cookie can take over.
export function extractSessionToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const headerToken = authHeader.slice('Bearer '.length).trim();
    if (headerToken && headerToken !== 'null' && headerToken !== 'undefined') {
      return headerToken;
    }
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
  }
  return null;
}

// Cookie lifetime mirrors the JWT lifetime so the browser drops a dead cookie
// on its own. Falls back to 7 days if the configured value is non-numeric
// (e.g. a '7d' string) — the JWT's own exp still governs actual validity.
function sessionCookieMaxAgeMs(): number {
  const raw = config.jwt.expiresIn as unknown;
  const seconds = typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : 7 * 24 * 60 * 60 * 1000;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: sessionCookieMaxAgeMs(),
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Build a typed JwtPayload from a user-shaped record whose `role` is `string`
 * (Prisma exposes User.role as String, not an enum). Narrows role to the
 * UserRole union and rejects unknown values rather than letting `as any` paper
 * over a corrupt token shape. `scope` defaults to undefined (full-access token).
 */
export function buildJwtPayload(input: {
  userId: string;
  consultingFirmId: string;
  role: string;
  email: string;
  scope?: JwtScope;
}): JwtPayload {
  if (input.role !== 'ADMIN' && input.role !== 'CONSULTANT') {
    throw new UnauthorizedError(`Unrecognized user role: ${input.role}`);
  }
  const role: UserRole = input.role;
  const payload: JwtPayload = {
    userId: input.userId,
    consultingFirmId: input.consultingFirmId,
    role,
    email: input.email,
  };
  if (input.scope) payload.scope = input.scope;
  return payload;
}

export async function authenticateJWT(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const token = extractSessionToken(req);

  if (!token) {
    return next(new UnauthorizedError('No token provided'));
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] }) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return next(new UnauthorizedError('Token expired'));
    }
    return next(new UnauthorizedError('Invalid token'));
  }

  // §8.3 — an INTERNAL session must be an internal token. External portal
  // tokens (client and partner) are signed with the same secret, so verifying
  // the signature alone is not enough: without this check a portal token whose
  // body happens to carry a consultingFirmId would be accepted here as a firm
  // user. Internal roles are exactly ADMIN and CONSULTANT; anything else —
  // 'CLIENT', 'PARTNER', or a role added later — is refused.
  // §8.5 widened this from the two literals to the internal role set. The
  // security property is unchanged and is what matters: 'CLIENT' and 'PARTNER'
  // are not internal roles, so a portal token is still refused here.
  if (!isRole(payload.role)) {
    return next(new UnauthorizedError('Invalid token'));
  }
  if (!payload.userId || !payload.consultingFirmId) {
    return next(new UnauthorizedError('Invalid token'));
  }

  // Reject tokens minted before a revocation cutoff (password reset, etc.).
  if (await isTokenStale('user', payload.userId, payload.iat)) {
    return next(new UnauthorizedError('Session expired, please sign in again'));
  }

  req.user = payload;
  next();
}

/**
 * Role gate. Deliberately UNCHANGED by §8.5.
 *
 * Every route that predates granular permissions still names the roles it
 * accepts, so a role added later cannot widen access to a route nobody has
 * reviewed. `requireRole('ADMIN')` still means ADMIN and nothing else.
 * New granular routes use `requirePermission` instead.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, _res: Response, next: NextFunction): void => {
    if (!req.user) throw new UnauthorizedError();
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError('Insufficient permissions for this operation');
    }
    next();
  };
}

export function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    algorithm: 'HS256',
  } as jwt.SignOptions);
}
