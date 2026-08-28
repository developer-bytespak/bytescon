// =============================================================
// Winners Intel — per-award detail enrichment (Phase 2B.6)
//
// USAspending's spending_by_award endpoint (used by usaspendingPull.ts)
// returns rich aggregate fields but NOT recipient_uei, type_set_aside,
// extent_competed, or number_of_offers_received — those are filter-only.
// The /api/v2/awards/<id>/ endpoint returns them as response fields, one
// award at a time.
//
// Strategy: after the bulk pull persists ~22K rows, enrich the top N rows
// by total obligation (where N defaults to 500). That covers the awards
// most likely to appear in slice "Top Recipients" tables — which is where
// the empty UEI / set-aside columns are most visible.
//
// Cost: ~500 sequential-ish requests with 5-wide concurrency completes in
// ~2 minutes. USAspending tolerates this; we still add a per-request
// timeout + best-effort error handling so a flaky response doesn't fail
// the whole enrichment pass.
// =============================================================

import axios from 'axios'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'

const USA_SPENDING_BASE = process.env.USASPENDING_BASE_URL || 'https://api.usaspending.gov/api/v2'
const DEFAULT_TOP_N = 500
// Lowered from 5 to 2 (2026-05-26): the prior 5-wide hammering, stacked after
// the subaward pass's 1000-call burst, triggered USAspending throttling that
// produced 100% socket-hang-up failures in a 2026-05-26 refresh. 2-wide keeps
// the wall-clock cost reasonable (~5 min for top 500) while staying well below
// USAspending's tolerance threshold.
const PARALLELISM = 2
const PER_REQUEST_TIMEOUT_MS = 30_000
const RETRY_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 1_000

export interface EnrichmentResult {
  refreshBatchId: string
  attempted: number
  enriched: number
  failed: number
  durationMs: number
}

/**
 * Pull per-award detail for the top N awards in a refresh batch.
 * Concurrency-controlled and failure-tolerant — one bad award doesn't
 * fail the pass.
 */
export async function enrichTopAwards(
  refreshBatchId: string,
  topN: number = DEFAULT_TOP_N,
): Promise<EnrichmentResult> {
  const startMs = Date.now()
  logger.info('Winners intel enrichment started', { refreshBatchId, topN })

  // Select the awards we want to enrich. Bias toward big-dollar awards
  // (they dominate slice top-recipients). Skip rows that already have
  // both UEI AND setAsideType populated (e.g., from the set-aside-filtered
  // pull in Phase 2B.5 — those already know their setAside).
  const targets = await prisma.winnersAwardStage.findMany({
    where: {
      refreshBatchId,
      // Drop empty IDs early — the detail endpoint can't resolve them.
      usaspendingAwardId: { not: '' },
      OR: [
        { recipientUei: null },
        { setAsideType: null },
        { competitionExtent: null },
        { numberOfOffersReceived: null },
      ],
    },
    orderBy: { totalObligation: 'desc' },
    take: topN,
    select: { id: true, usaspendingAwardId: true },
  })

  if (targets.length === 0) {
    logger.info('Winners intel enrichment: no candidates to enrich', { refreshBatchId })
    return {
      refreshBatchId,
      attempted: 0,
      enriched: 0,
      failed: 0,
      durationMs: Date.now() - startMs,
    }
  }

  let enriched = 0
  let failed = 0

  // Manual concurrency window (no need for a lib — this stays small).
  // Each "slot" pulls the next id off the queue and processes it until
  // exhausted, so 5 slots ≈ 5-wide parallelism over the full target set.
  const queue = [...targets]
  const workers: Promise<void>[] = []
  for (let i = 0; i < Math.min(PARALLELISM, queue.length); i++) {
    workers.push(
      (async function worker() {
        while (queue.length > 0) {
          const t = queue.shift()
          if (!t) break
          const success = await enrichOne(t.id, t.usaspendingAwardId)
          if (success) enriched++
          else failed++
        }
      })(),
    )
  }
  await Promise.all(workers)

  const durationMs = Date.now() - startMs
  logger.info('Winners intel enrichment complete', {
    refreshBatchId,
    attempted: targets.length,
    enriched,
    failed,
    durationMs,
  })

  return { refreshBatchId, attempted: targets.length, enriched, failed, durationMs }
}

/**
 * Fetch one award's detail page and merge the new fields into the staging
 * row. Returns true on success, false on any failure (network, parse,
 * missing-id, prisma error). Failures are warn-logged but not thrown.
 *
 * Retries on transient network failures (socket hang up, ECONNRESET, timeout)
 * with exponential backoff. USAspending's /awards/<id>/ is generally healthy
 * but throws transient errors under sustained load — a single retry after a
 * brief delay typically succeeds.
 */
async function enrichOne(stageRowId: string, awardId: string): Promise<boolean> {
  const url = `${USA_SPENDING_BASE}/awards/${encodeURIComponent(awardId)}/`

  let lastErr: unknown = null
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const resp = await axios.get(url, { timeout: PER_REQUEST_TIMEOUT_MS })
      const detail = resp.data
      if (!detail || typeof detail !== 'object') return false

      const update = extractEnrichmentFields(detail)
      if (Object.keys(update).length === 0) return false

      await prisma.winnersAwardStage.update({
        where: { id: stageRowId },
        data: update,
      })
      return true
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === RETRY_ATTEMPTS) break
      // Exponential backoff with jitter: 1s, 2s, 4s + 0-500ms jitter.
      const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1) + Math.floor(Math.random() * 500)
      await sleep(delay)
    }
  }

  // Throttle log noise: only WARN on the first ~5 failures per pass.
  if (Math.random() < 0.01) {
    logger.warn('Winners intel enrichment: award detail fetch failed', {
      awardId,
      error: (lastErr as Error)?.message,
    })
  }
  return false
}

function isRetryable(err: unknown): boolean {
  const msg = (err as Error)?.message ?? ''
  const code = (err as { code?: string })?.code ?? ''
  // Socket hang up, ECONNRESET, ETIMEDOUT, axios "timeout exceeded" — all
  // transient network blips that retry-with-backoff typically clears.
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

/**
 * USAspending's /awards/<id>/ payload nests fields differently depending
 * on award type and how recent the source data is. Try multiple paths
 * for each target field; first non-empty wins. Returns only the fields
 * we successfully extracted so we don't accidentally clobber existing
 * values with nulls.
 */
function extractEnrichmentFields(detail: Record<string, unknown>): Prisma.WinnersAwardStageUpdateInput {
  const out: Prisma.WinnersAwardStageUpdateInput = {}

  // Recipient UEI — most common path, with fallbacks for older data shapes.
  const uei = firstString([
    deep(detail, 'recipient', 'recipient_uei'),
    deep(detail, 'recipient_uei'),
    deep(detail, 'recipient', 'uei'),
  ])
  if (uei) out.recipientUei = uei

  const parentUei = firstString([
    deep(detail, 'recipient', 'parent_recipient_uei'),
    deep(detail, 'parent_recipient_uei'),
    deep(detail, 'recipient', 'parent_uei'),
  ])
  if (parentUei) out.recipientParentUei = parentUei

  const recipientName = firstString([
    deep(detail, 'recipient', 'recipient_name'),
    deep(detail, 'recipient_name'),
  ])
  if (recipientName) out.recipientName = recipientName

  // Set-aside — typically under latest_transaction.contract_data.type_set_aside
  // for contract awards. Fall back to root or transaction_set_aside_type.
  const setAside = firstString([
    deep(detail, 'latest_transaction', 'contract_data', 'type_set_aside'),
    deep(detail, 'type_set_aside'),
    deep(detail, 'latest_transaction_contract_data', 'type_set_aside'),
  ])
  if (setAside) out.setAsideType = setAside

  // Competition extent + offers count — same pattern.
  const extent = firstString([
    deep(detail, 'latest_transaction', 'contract_data', 'extent_competed'),
    deep(detail, 'extent_competed'),
  ])
  if (extent) out.competitionExtent = extent

  const offers = firstNumber([
    deep(detail, 'latest_transaction', 'contract_data', 'number_of_offers_received'),
    deep(detail, 'number_of_offers_received'),
    deep(detail, 'latest_transaction_contract_data', 'number_of_offers_received'),
  ])
  if (offers !== null) out.numberOfOffersReceived = offers

  return out
}

// ---------- safe nested-key extractor ----------

function deep(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function firstString(candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (c === null || c === undefined) continue
    const s = String(c).trim()
    if (s.length > 0) return s
  }
  return null
}

function firstNumber(candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (c === null || c === undefined || c === '') continue
    const n = Number(c)
    if (Number.isFinite(n)) return n
  }
  return null
}
