// =============================================================
// §8.4 — The public API error envelope.
//
// One shape, always. It carries a stable machine-readable code, a message
// written for the integrator, and the request id when the platform has one.
//
// It carries nothing else. No stack, no SQL, no Prisma error code, no file
// path, no internal entity name — an error is the one place where a system
// most readily describes its own internals to a stranger.
// =============================================================
import { Response } from 'express'
import { Request } from 'express'
import { logger } from '../../utils/logger'

export type PublicApiErrorCode =
  | 'UNAUTHORIZED'
  | 'INSUFFICIENT_SCOPE'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'TENANT_NOT_ADDRESSABLE'
  | 'RATE_LIMITED'
  | 'METHOD_NOT_ALLOWED'
  | 'INTERNAL_ERROR'

export function requestId(req: Request): string | null {
  const header = req.headers['x-request-id']
  if (typeof header === 'string' && header.length > 0 && header.length <= 200) return header
  const existing = (req as { id?: unknown }).id
  return typeof existing === 'string' ? existing : null
}

export function publicApiError(
  res: Response, req: Request, status: number, code: PublicApiErrorCode, message: string,
  extra?: Record<string, unknown>,
): void {
  res.status(status).json({
    error: { code, message, requestId: requestId(req), ...(extra ?? {}) },
  })
}

/**
 * Last-resort handler for the v1 router.
 *
 * The real cause is logged for operators and replaced with a generic message
 * for the caller, so an unexpected failure cannot become a disclosure.
 */
export function publicApiErrorHandler(
  err: unknown, req: Request, res: Response, _next: (e?: unknown) => void,
): void {
  if (res.headersSent) return
  const status = typeof (err as { statusCode?: number })?.statusCode === 'number'
    ? (err as { statusCode: number }).statusCode
    : 500
  if (status >= 500) {
    logger.error('Public API request failed', {
      path: req.path, method: req.method, error: (err as Error)?.message,
    })
    publicApiError(res, req, 500, 'INTERNAL_ERROR', 'The request could not be completed.')
    return
  }
  publicApiError(res, req, status, 'INVALID_REQUEST', 'The request could not be completed.')
}
