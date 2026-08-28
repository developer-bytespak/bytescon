// =============================================================
// §8.4 — Public API authentication.
//
// The credential substrate is the existing `api_tokens` table: the same
// SHA-256-hashed bearer, the same tenant column, the same revocation and
// expiry checks the MCP suite has always used. What is new is `kind`, and it
// is what keeps two delivery interfaces from becoming one:
//
//   - a PUBLIC_API token is refused by the MCP resolver
//   - an MCP token is refused here
//   - a browser session JWT is not an API token and never authenticates here
//   - a client-portal or partner-portal JWT is not an API token either
//
// The tenant comes from the verified token row and from nowhere else. A
// `consultingFirmId` in a query string or body is not read, not honoured, and
// not silently ignored — it is refused, so an integrator cannot believe they
// scoped a request when they did not.
// =============================================================
import crypto from 'node:crypto'
import { Request, Response, NextFunction } from 'express'
import { ApiTokenKind } from '@prisma/client'
import { prisma } from '../../config/database'
import { normalizeScopes, type PublicApiScope } from './scopes'
import { publicApiError } from './errors'

export interface PublicApiContext {
  tokenId: string
  /** First 16 hex chars of the token hash — the only token artifact ever stored or logged. */
  tokenFp: string
  consultingFirmId: string
  tokenName: string
  tier: string
  scopes: PublicApiScope[]
  /** Set by requireScope so usage logging records which scope admitted the call. */
  scopeUsed?: PublicApiScope
}

export interface PublicApiRequest extends Request {
  apiToken?: PublicApiContext
  /** The matched route pattern, for usage logging. Never the raw URL. */
  publicApiRoute?: string
}

export function hashApiToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
}

/** Body/query keys an external caller must not use to assert a tenant. */
const TENANT_ASSERTION_KEYS = ['consultingFirmId', 'consulting_firm_id', 'tenantId', 'firmId']

export async function authenticateApiToken(
  req: PublicApiRequest, res: Response, next: NextFunction,
): Promise<void> {
  try {
    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      return publicApiError(res, req, 401, 'UNAUTHORIZED', 'A bearer API token is required.')
    }
    const raw = header.slice('Bearer '.length).trim()
    // Too short to be one of ours; refused without a database round trip.
    if (raw.length < 16) {
      return publicApiError(res, req, 401, 'UNAUTHORIZED', 'That API token is not valid.')
    }

    const row = await prisma.apiToken.findUnique({ where: { tokenHash: hashApiToken(raw) } })
    // Unknown, wrong-kind, revoked and expired all fail identically: a caller
    // learns that the credential does not work, not why.
    if (!row || row.kind !== ApiTokenKind.PUBLIC_API || row.revokedAt || (row.expiresAt && row.expiresAt <= new Date())) {
      return publicApiError(res, req, 401, 'UNAUTHORIZED', 'That API token is not valid.')
    }

    for (const key of TENANT_ASSERTION_KEYS) {
      if (key in (req.query as Record<string, unknown>) || key in ((req.body ?? {}) as Record<string, unknown>)) {
        return publicApiError(
          res, req, 400, 'TENANT_NOT_ADDRESSABLE',
          'The tenant is determined by the API token. Remove the tenant identifier from the request.',
        )
      }
    }

    req.apiToken = {
      tokenId: row.id,
      tokenFp: row.tokenHash.slice(0, 16),
      consultingFirmId: row.consultingFirmId,
      tokenName: row.name,
      tier: row.tier,
      scopes: normalizeScopes(row.scopes),
    }
    // Best-effort, and never allowed to fail a request.
    prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined)
    next()
  } catch (err) {
    next(err)
  }
}

/** Gate one route on one scope. Role strings are deliberately not consulted. */
export function requireScope(scope: PublicApiScope) {
  return (req: PublicApiRequest, res: Response, next: NextFunction): void => {
    const ctx = req.apiToken
    if (!ctx) {
      publicApiError(res, req, 401, 'UNAUTHORIZED', 'A bearer API token is required.')
      return
    }
    if (!ctx.scopes.includes(scope)) {
      publicApiError(res, req, 403, 'INSUFFICIENT_SCOPE', `This endpoint requires the "${scope}" scope.`)
      return
    }
    ctx.scopeUsed = scope
    next()
  }
}

export function getApiContext(req: PublicApiRequest): PublicApiContext {
  if (!req.apiToken) throw new Error('Public API context accessed before authentication')
  return req.apiToken
}
