// =============================================================
// §8.4 — Public API usage accounting.
//
// One row per request in `public_api_request_logs`.
//
// WHY NOT `ApiUsageLog`: despite the name, that table is the LLM ledger —
// provider, model, task, input/output tokens, estimated cost. It has no HTTP
// request to record and every one of its required columns would have to be
// filled with a lie. WHY NOT `McpAuditLog`: it is keyed to an MCP server name,
// version and tool invocation, and writing REST requests into it would corrupt
// the MCP audit view and its error-rate figures.
//
// What is recorded is deliberately thin: the token fingerprint rather than the
// token, the matched route pattern rather than the URL (so record ids stay out
// of the log), and no header, body or query string at all.
// =============================================================
import { Response } from 'express'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import type { PublicApiRequest } from './apiTokenAuth'

/**
 * Record every completed request, including the failures.
 *
 * Attached on `finish` so the status code is the one actually sent. A logging
 * failure never affects the response — it has already gone out — but it is
 * logged, because a silent gap in an audit trail is worse than a noisy one.
 */
export function recordPublicApiUsage(req: PublicApiRequest, res: Response): void {
  const startedAt = Date.now()
  res.on('finish', () => {
    const ctx = req.apiToken
    // An unauthenticated request has no tenant to attribute, and inventing one
    // would attribute a stranger's traffic to a customer.
    if (!ctx) return
    void prisma.publicApiRequestLog.create({
      data: {
        consultingFirmId: ctx.consultingFirmId,
        apiTokenId: ctx.tokenId,
        tokenFp: ctx.tokenFp,
        method: req.method,
        route: req.publicApiRoute ?? req.route?.path ?? req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        scopeUsed: ctx.scopeUsed ?? null,
        outcome: res.statusCode < 400 ? 'ok' : res.statusCode < 500 ? 'client_error' : 'server_error',
      },
    }).catch((err: unknown) => {
      logger.error('Public API usage log write failed', {
        apiTokenId: ctx.tokenId, error: (err as Error).message,
      })
    })
  })
}
