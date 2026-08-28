// =============================================================
// Observability — Sentry error capture + Prometheus metrics.
//
// Sentry: enabled when SENTRY_DSN env var is set; disabled
// otherwise (no-op, no traffic). Captures unhandled exceptions
// + traced spans on Express routes. Free tier: 5K events/mo.
//
// Prometheus: a single Registry instrumented for default Node
// metrics (event loop lag, GC, memory) + per-request histogram
// + counter. Exposed at GET /metrics (root, optionally guarded
// by METRICS_SECRET query parameter).
//
// Both surfaces fail closed — if observability breaks, the
// request path is unaffected.
// =============================================================
import * as Sentry from '@sentry/node'
import { Registry, collectDefaultMetrics, Histogram, Counter } from 'prom-client'
import type { Request, Response, NextFunction } from 'express'
import { logger } from '../utils/logger'

let sentryEnabled = false

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim()
  if (!dsn) {
    logger.info('Sentry disabled — SENTRY_DSN not set')
    return
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.npm_package_version || '1.0.0',
    // Sample rates — keep modest for free-tier budget
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_RATE || '0.1'),
  })
  sentryEnabled = true
  logger.info('Sentry initialized', { environment: process.env.NODE_ENV })
}

export function isSentryEnabled(): boolean {
  return sentryEnabled
}

// -------------------------------------------------------------
// Prometheus
// -------------------------------------------------------------
export const registry = new Registry()

collectDefaultMetrics({ register: registry, prefix: 'bytescon_' })

const httpRequestDuration = new Histogram({
  name: 'bytescon_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
})

const httpRequestsTotal = new Counter({
  name: 'bytescon_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
})

/**
 * Express middleware — record per-request latency + count.
 * Mount EARLY so all routes are observed; uses res.on('finish').
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9
    // Use route.path when available so we don't blow cardinality on
    // /api/foo/:id with id-per-bucket.
    const route = (req as any).route?.path || req.baseUrl + (req.route?.path ?? '') || req.path
    const labels = {
      method: req.method,
      route: typeof route === 'string' ? route.slice(0, 80) : 'unknown',
      status_code: String(res.statusCode),
    }
    httpRequestDuration.observe(labels, elapsedSec)
    httpRequestsTotal.inc(labels)
  })
  next()
}

/**
 * Express handler — Prometheus exposition format.
 * Optionally guarded by METRICS_SECRET (?token=... or Authorization).
 */
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  const expected = process.env.METRICS_SECRET?.trim()
  if (expected) {
    const provided =
      (req.query.token as string | undefined) ||
      req.get('authorization')?.replace(/^Bearer\s+/i, '')
    if (provided !== expected) {
      res.status(401).type('text').send('unauthorized')
      return
    }
  }
  try {
    res.set('Content-Type', registry.contentType)
    res.end(await registry.metrics())
  } catch (err) {
    logger.error('Failed to emit prometheus metrics', { error: (err as Error).message })
    res.status(500).end()
  }
}

export { Sentry }
