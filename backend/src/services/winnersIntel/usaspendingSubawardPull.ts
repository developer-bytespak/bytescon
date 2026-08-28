// =============================================================
// USAspending Subaward Pull — Winners Intel (Agency feature)
//
// HISTORY: This module previously hit POST /search/spending_by_subaward/
// for bulk date-window filtered pulls. USAspending REMOVED that endpoint
// circa 2026-05; every request now returns 404 HTML. The replacement is
// POST /api/v2/subawards/ which is PER-PRIME-AWARD only (you pass one
// `award_id` and get its subawards back). So this module now iterates
// over the top-N primes in WinnersAwardStage rather than over date
// windows.
//
// DATA LOSS vs old endpoint — the new one only returns:
//   { id, subaward_number, description, action_date, amount, recipient_name }
// The old one ALSO returned sub-recipient UEI, set-aside flags
// (SDVOSB/WOSB/HUBZone/8a), small-biz flag, state code, NAICS, and PSC.
// Those fields are now NULL on persisted rows. Downstream impact:
//   - Sub "SB" badges in the agency view won't show (subRecipientSize=unknown)
//   - teamingSuggester's "prime favors my cert" sub-signal degrades
//     toward the agency prior (Bayesian shrinkage handles it gracefully
//     but the signal is weaker)
// Future enrichment: probe /api/v2/subaward/{id}/ or pivot to BigQuery's
// USAspending mirror dataset (gcp-public-data:usaspending) which still
// has the rich fields.
// =============================================================

import axios from 'axios'
import { logger } from '../../utils/logger'

const USA_SPENDING_BASE = process.env.USASPENDING_BASE_URL || 'https://api.usaspending.gov/api/v2'

// Per-request reliability tuning (2026-05-26): the prior 20s timeout + no
// retries produced a 56% socket-hang-up failure rate over the top-1000 primes
// when run 5-wide in parallel from refresh.ts. Bumped timeout, added bounded
// retry with exponential backoff. Refresh.ts also drops parallelism from 5→3.
const PER_REQUEST_TIMEOUT_MS = 30_000
const RETRY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1_000

/** Shape that matches WinnersSubawardStage on the persistence side. */
export interface RawWinnerSubaward {
  usaspendingSubawardId: string
  primeAwardId: string
  subAmount: number | null
  subActionDate: Date | null
  subRecipientUei: string | null
  subRecipientName: string | null
  subRecipientParentUei: string | null
  subRecipientStateCode: string | null
  /** small | large | unknown */
  subRecipientSize: string
  /** { sdvosb: bool, wosb: bool, hubzone: bool, eightA: bool } */
  subRecipientSetAsideFlags: {
    sdvosb: boolean
    wosb: boolean
    hubzone: boolean
    eightA: boolean
  }
  subDescription: string | null
  subNaics: string | null
  subPscCode: string | null
}

export interface SubawardsForPrimeOptions {
  /** The prime's usaspendingAwardId (e.g. "CONT_AWD_HT940216C0001_9700_-NONE-_-NONE-"). */
  primeAwardId: string
  /** Hard ceiling on pages fetched per prime. Default 10 (≈ 1000 subs); large
   *  primes like Humana ($51B) may have many more, but 1000 is plenty for
   *  agency-level aggregation. */
  maxPages?: number
}

export interface SubawardsForPrimeResult {
  primeAwardId: string
  pagesFetched: number
  rowsReturned: number
  subawards: RawWinnerSubaward[]
  /** Set when one or more page fetches failed; partial result still usable. */
  partialFailure?: { failedPages: number[]; lastError: string }
}

/**
 * Pull all subawards for a single prime award. Hits the new
 * POST /api/v2/subawards/ endpoint and paginates until hasNext=false.
 */
export async function pullSubawardsForPrime(opts: SubawardsForPrimeOptions): Promise<SubawardsForPrimeResult> {
  const { primeAwardId, maxPages = 10 } = opts

  const subawards: RawWinnerSubaward[] = []
  const failedPages: number[] = []
  let lastError = ''
  let page = 1
  let pagesFetched = 0

  while (page <= maxPages) {
    let resp: any = null
    let pageErr: unknown = null

    for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
      try {
        resp = await axios.post(
          `${USA_SPENDING_BASE}/subawards/`,
          {
            award_id: primeAwardId,
            page,
            // limit isn't documented for this endpoint; the default returns
            // ~10 per page. Try requesting 100 — server typically caps it
            // safely if too high.
            limit: 100,
          },
          { timeout: PER_REQUEST_TIMEOUT_MS },
        )
        pageErr = null
        break
      } catch (err) {
        pageErr = err
        if (!isRetryableError(err) || attempt === RETRY_ATTEMPTS) break
        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 500)
        await sleep(delay)
      }
    }

    if (pageErr || !resp) {
      const msg = (pageErr as Error)?.message ?? 'unknown'
      // Warn-once per prime — a flood for the same prime across pages
      // is noisy. Only log page 1 failures since later pages are usually
      // collateral damage.
      if (page === 1) {
        logger.warn('Winners intel: USAspending subaward fetch failed', {
          primeAwardId,
          page,
          error: msg,
        })
      }
      failedPages.push(page)
      lastError = msg
      // Break out — if page 1 failed after retries, later pages are likely
      // to fail too. No point burning quota.
      break
    }

    const results: Record<string, unknown>[] = resp.data?.results ?? []
    pagesFetched++

    for (const r of results) {
      const mapped = mapToWinnerSubaward(r, primeAwardId)
      if (mapped) subawards.push(mapped)
    }

    const hasNext = resp.data?.page_metadata?.hasNext
    // Stop when the API says there's no next page OR we got fewer rows
    // than the limit (covers the case where the server ignores limit and
    // returns 10 — hasNext would still be true for a 25-sub prime so we
    // need the page-count guard too).
    if (hasNext === false) break
    if (results.length === 0) break
    page++
  }

  const result: SubawardsForPrimeResult = {
    primeAwardId,
    pagesFetched,
    rowsReturned: subawards.length,
    subawards,
  }
  if (failedPages.length) {
    result.partialFailure = { failedPages, lastError }
  }
  return result
}

/**
 * Map one USAspending subaward row to our staging shape.
 *
 * The new endpoint returns a much leaner shape than the old one:
 *   { id, subaward_number, description, action_date, amount, recipient_name }
 * Everything else (UEI, set-aside flags, state, NAICS, PSC) is unavailable
 * here and gets NULL on the persisted row. Downstream code already
 * tolerates these as nullable.
 */
function mapToWinnerSubaward(r: Record<string, unknown>, primeAwardId: string): RawWinnerSubaward | null {
  // The `id` field is USAspending's internal sub-award integer — globally
  // unique, stable across re-runs. Best primary key. Fall back to
  // subaward_number only if id is somehow missing (defensive — never seen
  // it null in practice).
  const subawardIdRaw = r['id'] ?? r['subaward_number']
  if (subawardIdRaw === undefined || subawardIdRaw === null || subawardIdRaw === '') return null
  const usaspendingSubawardId = String(subawardIdRaw).trim()
  if (!usaspendingSubawardId) return null

  return {
    usaspendingSubawardId,
    primeAwardId,
    subAmount: asNumber(r['amount']),
    subActionDate: parseDate(asString(r['action_date'])),
    // Rich fields below are unavailable from the new endpoint — see file
    // header comment. All consumers (Prisma model, agency routes, teaming
    // suggester) already handle these as nullable.
    subRecipientUei: null,
    subRecipientName: asString(r['recipient_name']),
    subRecipientParentUei: null,
    subRecipientStateCode: null,
    subRecipientSize: 'unknown',
    subRecipientSetAsideFlags: {
      sdvosb: false, wosb: false, hubzone: false, eightA: false,
    },
    subDescription: asString(r['description']),
    subNaics: null,
    subPscCode: null,
  }
}

// ---------- helpers ----------

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseDate(v: string | null): Date | null {
  if (!v) return null
  const trimmed = v.slice(0, 10)
  const d = new Date(trimmed + 'T00:00:00.000Z')
  return Number.isNaN(d.getTime()) ? null : d
}

function isRetryableError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  const code = (err as { code?: string })?.code ?? ''
  return (
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED'
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
