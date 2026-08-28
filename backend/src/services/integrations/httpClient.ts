// =============================================================
// §8.5 — The HTTP client every provider adapter uses.
//
// One place that owns the things a provider integration gets wrong: timeouts,
// bounded retries with backoff, and turning a vendor's error body into a
// normalized failure without echoing it into our logs.
//
// NOTHING HERE LOGS A REQUEST BODY OR AN AUTHORIZATION HEADER. A provider
// error response frequently quotes the request that caused it, which is how a
// bearer token ends up in an error log.
// =============================================================
import axios, { AxiosRequestConfig, AxiosError } from 'axios'
import { ConnectorError } from './accounting/connector'
import { logger } from '../../utils/logger'

const DEFAULT_TIMEOUT_MS = 15_000
const MAX_ATTEMPTS = 3

function backoffMs(attempt: number): number {
  return Math.min(4_000, 250 * 2 ** (attempt - 1))
}

function classify(err: AxiosError): ConnectorError {
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    return new ConnectorError('The provider did not respond in time.', 'TIMEOUT', true)
  }
  const status = err.response?.status
  if (status === 401 || status === 403) {
    return new ConnectorError('The provider rejected the stored credential.', 'UNAUTHORIZED', false)
  }
  if (status === 429) {
    const retryAfter = Number(err.response?.headers?.['retry-after'])
    return new ConnectorError(
      'The provider rate-limited this request.', 'RATE_LIMITED', true,
      Number.isFinite(retryAfter) ? retryAfter : undefined,
    )
  }
  if (status && status >= 500) {
    return new ConnectorError(`The provider returned an error (${status}).`, 'PROVIDER_ERROR', true)
  }
  // A 4xx that is not auth or rate limiting is our request's fault; retrying
  // it would just repeat the mistake.
  return new ConnectorError(
    `The provider rejected the request${status ? ` (${status})` : ''}.`, 'PROVIDER_ERROR', false,
  )
}

/**
 * A request with a timeout and a bounded retry.
 *
 * Retries only what is worth retrying — a timeout, a 429, a 5xx — and never
 * more than MAX_ATTEMPTS times, so a provider outage cannot turn a worker into
 * an infinite loop. Callers pair this with an idempotency key, so a retried
 * write is still one write.
 */
export async function providerRequest<T>(
  label: string, config: AxiosRequestConfig,
): Promise<T> {
  let lastError: ConnectorError | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await axios.request<T>({ timeout: DEFAULT_TIMEOUT_MS, ...config })
      return res.data
    } catch (err) {
      const classified = classify(err as AxiosError)
      lastError = classified
      // The label and the classification only. No URL with a query string, no
      // headers, no body.
      logger.warn('Provider request failed', {
        label, attempt, kind: classified.kind, retryable: classified.retryable,
      })
      if (!classified.retryable || attempt === MAX_ATTEMPTS) throw classified
      await new Promise((resolve) => setTimeout(resolve, classified.retryAfterSeconds
        ? Math.min(10_000, classified.retryAfterSeconds * 1000)
        : backoffMs(attempt)))
    }
  }
  throw lastError ?? new ConnectorError('The provider request failed.', 'PROVIDER_ERROR', false)
}
