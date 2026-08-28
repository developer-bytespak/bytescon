// =============================================================
// GB-107 SAM.gov noticedesc client.
//
// GET https://api.sam.gov/prod/opportunities/v1/noticedesc
//   ?noticeid=<samNoticeId>&api_key=<SAM_GOV_API_KEY>
//
// Responses observed in the wild: raw HTML, or JSON of the form
// {"description":"<html>…"} — both are handled. Error taxonomy per
// GB-107 spec: 404 terminal NOT_FOUND, 429/403 halts the day,
// 5xx retried 3x with exponential backoff, 30s timeout retried once.
// =============================================================
import axios, { AxiosError } from 'axios'
import type { Gb107Config } from './config.gb107'

const TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000]

export type FetchDescriptionResult =
  | { ok: true; html: string }
  | { ok: false; kind: 'NOT_FOUND' | 'RATE_LIMITED' | 'FAILED'; message: string; status?: number }

function unwrapBody(data: unknown): string {
  if (typeof data === 'string') {
    const trimmed = data.trim()
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as { description?: unknown }
        if (typeof parsed.description === 'string') return parsed.description
      } catch {
        // fall through — treat as HTML
      }
    }
    return data
  }
  if (data && typeof data === 'object' && typeof (data as { description?: unknown }).description === 'string') {
    return (data as { description: string }).description
  }
  return ''
}

export async function fetchNoticeDescription(
  samNoticeId: string,
  cfg: Gb107Config,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<FetchDescriptionResult> {
  let timeoutRetried = false

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await axios.get(cfg.noticeDescUrl, {
        params: { noticeid: samNoticeId, api_key: cfg.samGovApiKey },
        timeout: TIMEOUT_MS,
        maxContentLength: MAX_RESPONSE_BYTES,
        // Keep the raw body — SAM may return text/html or JSON.
        transformResponse: [(d: unknown) => d],
        responseType: 'text',
        validateStatus: () => true,
      })

      if (res.status === 200) {
        const html = unwrapBody(res.data)
        if (!html || html.trim().length === 0) {
          return { ok: false, kind: 'FAILED', message: 'Empty description body', status: 200 }
        }
        return { ok: true, html }
      }
      if (res.status === 404) {
        return { ok: false, kind: 'NOT_FOUND', message: 'Notice not found on SAM.gov (may be archived)', status: 404 }
      }
      if (res.status === 429 || res.status === 403) {
        return {
          ok: false,
          kind: 'RATE_LIMITED',
          message: `SAM.gov returned ${res.status} — quota exhausted or key rejected`,
          status: res.status,
        }
      }
      if (res.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      return { ok: false, kind: 'FAILED', message: `SAM.gov returned HTTP ${res.status}`, status: res.status }
    } catch (err) {
      const axiosErr = err as AxiosError
      const isTimeout = axiosErr.code === 'ECONNABORTED' || /timeout/i.test(axiosErr.message ?? '')
      if (isTimeout && !timeoutRetried) {
        timeoutRetried = true
        continue
      }
      if (!isTimeout && attempt < RETRY_DELAYS_MS.length) {
        await sleep(RETRY_DELAYS_MS[attempt])
        continue
      }
      return { ok: false, kind: 'FAILED', message: `Network error: ${axiosErr.message}` }
    }
  }
}

export interface NoticeLinksResult {
  pointOfContact: unknown[] | null
  resourceLinks: unknown[] | null
}

/**
 * Optional second call (gated by ENRICHMENT_FETCH_LINKS): pull the v2
 * search record for this notice to capture pointOfContact and
 * resourceLinks. Costs one API call from the same daily budget.
 */
export async function fetchNoticeLinks(
  samNoticeId: string,
  cfg: Gb107Config,
): Promise<NoticeLinksResult | null> {
  try {
    const res = await axios.get(cfg.searchUrl, {
      params: { noticeid: samNoticeId, limit: 1, api_key: cfg.samGovApiKey },
      timeout: TIMEOUT_MS,
    })
    const record = res.data?.opportunitiesData?.[0]
    if (!record) return null
    return {
      pointOfContact: Array.isArray(record.pointOfContact) ? record.pointOfContact : null,
      resourceLinks: Array.isArray(record.resourceLinks) ? record.resourceLinks : null,
    }
  } catch {
    return null
  }
}
