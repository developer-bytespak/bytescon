// =============================================================
// API credential administration — MCP and Public API tokens + MCP audit log.
//
// One table, one admin surface. §8.4 added the public REST API, and rather
// than mint a second credential system it extended this one with `kind`:
// a token is either an MCP host credential or a Public API credential, and
// each interface accepts only its own. `kind` defaults to MCP, so every token
// created before §8.4 — and every caller of this endpoint that does not send
// the field — behaves exactly as it did.
//
// All routes: ADMIN-only, tenant-scoped via JWT.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import crypto from 'node:crypto'
import { prisma } from '../config/database'
import { authenticateJWT } from '../middleware/auth'
import { requirePermission } from '../middleware/permissions'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { ValidationError, NotFoundError } from '../utils/errors'
import { normalizeScopes, isPublicApiScope, PUBLIC_API_SCOPES } from '../services/publicApi/scopes'

const router = Router()
// §8.5 — API_TOKEN_MANAGE rather than the ADMIN role. ADMIN holds it, so
// nothing changes for an administrator; a granular role does not hold it, so
// minting a credential stays an administrative act.
router.use(authenticateJWT, enforceTenantScope, requirePermission('API_TOKEN_MANAGE'))
router.use(requireActiveBase, requireAddon('api_access'))

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
}

/**
 * GET /api/admin/mcp/tokens
 * List all API tokens for this tenant (never exposes raw token).
 */
router.get('/tokens', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const tokens = await prisma.apiToken.findMany({
      where: { consultingFirmId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        tier: true,
        kind: true,
        scopes: true,
        expiresAt: true,
        revokedAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
    })
    res.json({ success: true, data: tokens })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/admin/mcp/tokens
 * Mint a new API token. Returns the raw token ONCE — store it securely.
 * Body: { name: string, tier?: 'CORE'|'PRO'|'VAULT', expiresInDays?: number }
 */
router.post('/tokens', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const { name, tier = 'CORE', expiresInDays, kind = 'MCP', scopes } = req.body ?? {}

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('name is required')
    }
    if (name.length > 200) throw new ValidationError('name max length 200')
    const validTiers = ['CORE', 'PRO', 'VAULT']
    if (!validTiers.includes(tier)) throw new ValidationError('tier must be CORE, PRO, or VAULT')
    if (expiresInDays !== undefined && (typeof expiresInDays !== 'number' || expiresInDays <= 0)) {
      throw new ValidationError('expiresInDays must be a positive number')
    }
    if (kind !== 'MCP' && kind !== 'PUBLIC_API') {
      throw new ValidationError('kind must be MCP or PUBLIC_API')
    }

    // Scopes belong to the public REST API. An unknown scope is refused rather
    // than dropped, so an operator is never shown a token they believe grants
    // access it does not.
    let grantedScopes: string[] = []
    if (kind === 'PUBLIC_API') {
      if (!Array.isArray(scopes) || scopes.length === 0) {
        throw new ValidationError(`A PUBLIC_API token needs at least one scope. Available: ${PUBLIC_API_SCOPES.join(', ')}`)
      }
      const unknown = scopes.filter((s: unknown) => !isPublicApiScope(s))
      if (unknown.length > 0) throw new ValidationError(`Unknown scope: ${String(unknown[0])}`)
      grantedScopes = normalizeScopes(scopes)
    } else if (scopes !== undefined) {
      throw new ValidationError('Scopes apply to PUBLIC_API tokens only')
    }

    const rawToken = crypto.randomBytes(32).toString('base64url')
    const tokenHash = hashToken(rawToken)
    const tokenPrefix = rawToken.slice(0, 8)
    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null

    const row = await prisma.apiToken.create({
      data: {
        name: name.trim(),
        consultingFirmId,
        tokenHash,
        tokenPrefix,
        tier,
        kind,
        scopes: grantedScopes,
        expiresAt,
        createdBy: req.user?.userId ?? null,
      },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        tier: true,
        kind: true,
        scopes: true,
        expiresAt: true,
        createdAt: true,
      },
    })

    res.status(201).json({
      success: true,
      data: {
        ...row,
        rawToken,
        hint: 'Save this token now — the server stores only the hash and it cannot be recovered.',
      },
    })
  } catch (err) {
    next(err)
  }
})

/**
 * DELETE /api/admin/mcp/tokens/:id
 * Revoke a token (soft-delete via revokedAt). Idempotent.
 */
router.delete('/tokens/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const token = await prisma.apiToken.findFirst({
      where: { id: req.params.id, consultingFirmId },
    })
    if (!token) throw new NotFoundError('Token not found')
    if (token.revokedAt) {
      return res.json({ success: true, data: { alreadyRevoked: true } })
    }
    await prisma.apiToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    })
    res.json({ success: true, data: { revoked: true } })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/admin/mcp/audit-logs
 * Recent MCP tool invocations for this tenant.
 * Query: ?limit=50&tool=search_opportunities&outcome=ok
 */
router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'))))
    const toolFilter = req.query.tool ? String(req.query.tool) : undefined
    const outcomeFilter = req.query.outcome ? String(req.query.outcome) : undefined

    const logs = await prisma.mcpAuditLog.findMany({
      where: {
        tenantId: consultingFirmId,
        ...(toolFilter ? { toolName: toolFilter } : {}),
        ...(outcomeFilter ? { outcome: outcomeFilter } : {}),
      },
      orderBy: { ts: 'desc' },
      take: limit,
      select: {
        id: true,
        toolName: true,
        tokenFp: true,
        outcome: true,
        durationMs: true,
        outputBytes: true,
        correlationId: true,
        ts: true,
      },
    })

    // Aggregate stats
    const total = await prisma.mcpAuditLog.count({ where: { tenantId: consultingFirmId } })
    const errCount = await prisma.mcpAuditLog.count({
      where: { tenantId: consultingFirmId, outcome: 'tool_error' },
    })

    res.json({
      success: true,
      data: {
        logs,
        stats: { total, errors: errCount, errorRate: total > 0 ? errCount / total : 0 },
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
