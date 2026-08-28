// =============================================================
// Winners Intel — refresh orchestrator
//
// Slices the 24-month rolling window into 90-day chunks, calls
// pullPrimeAwardsWindow for each, persists rows to WinnersAwardStage
// keyed by usaspendingAwardId (idempotent across batches), and emits
// a single ComplianceLog row at completion (success or failure).
//
// Subaward pull + recompete heuristic + batch pruning are intentionally
// out of scope for Phase 2B.2 — they ship in 2B.2c and 2B.2d to keep
// each commit independently revertable.
// =============================================================

import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { pullPrimeAwardsWindow, RawWinnerAward } from './usaspendingPull'
import { distillFromBatch } from './distill'
import { writeSlices } from './sliceWriter'
import { enrichTopAwards } from './awardEnrichment'
import { pullSubawardsForPrime, RawWinnerSubaward } from './usaspendingSubawardPull'

const WINDOW_MONTHS = 24
const CHUNK_DAYS = 90
const PERSIST_BATCH_SIZE = 500
// 25 pages × 100 rows × 9 windows ≈ 22,500 rows max per refresh. Sized for
// representative coverage rather than maximal volume — the prior 100-page
// cap pulled megacontracts only and skewed every percentile up by 100×.
const MAX_PAGES_PER_WINDOW = 25

// NOTE 2026-05-26: Set-aside enrichment loop was REMOVED below.
// USAspending's `type_set_aside` filter on spending_by_award is being silently
// ignored — all four filtered passes returned the same mega-prime rows as an
// unfiltered pull (probe: scripts/probeSetAsideFilter.ts). Stamping the filter
// value onto every returned row produced contaminated data (e.g., Lockheed
// Martin stamped HZC, $48B contract). Per-award set-aside must come from
// awardEnrichment.ts hitting /awards/<id>/ instead.
// The SET_ASIDE_TYPES_TO_ENRICH constant and the loop that used it have been
// removed; restore from git history if USAspending fixes the filter.

export interface RefreshSummary {
  refreshBatchId: string
  startedAt: string
  completedAt: string
  durationMs: number
  windowsProcessed: number
  totalRowsFetched: number
  totalRowsUpserted: number
  partialFailureWindows: number
  /** Set after distillation runs. Null when distillation was skipped. */
  slicesWritten: number | null
  /** Set after per-award detail enrichment (Phase 2B.6). Null when skipped. */
  awardsEnriched: number | null
  /** Set after subaward pull (Agency Phase A). Null when skipped. */
  subawardRowsUpserted: number | null
  status: 'COMPLETED' | 'FAILED'
  error?: string
}

/**
 * Run a full Winners Intel refresh against USAspending.
 *
 * Idempotent at the row level: each award is upserted by usaspendingAwardId,
 * so re-runs of the same window just refresh the row in place. Batch IDs
 * give us a way to enumerate "what was pulled in this run" for diagnostics
 * without serving as the dedup key.
 *
 * Returns a summary so callers (worker / manual trigger) can log a structured
 * result. Throws only on truly unrecoverable conditions (DB unreachable);
 * USAspending failures degrade to partial rows + status=COMPLETED with
 * partialFailureWindows > 0.
 */
export async function runWinnersIntelRefresh(): Promise<RefreshSummary> {
  const refreshBatchId = randomUUID()
  const startedAt = new Date()
  const startMs = startedAt.getTime()

  logger.info('Winners intel refresh started', { refreshBatchId })

  const windows = buildWindows(WINDOW_MONTHS, CHUNK_DAYS)
  let totalRowsFetched = 0
  let totalRowsUpserted = 0
  let partialFailureWindows = 0

  try {
    for (let i = 0; i < windows.length; i++) {
      const win = windows[i]
      // Alternate sort direction per window so the refresh captures both
      // ends of the dollar distribution: even windows pull top-dollar
      // (the megavehicles a small business will see as primes/incumbents),
      // odd windows pull lowest-dollar (small-purchase patterns relevant
      // to typical small-business awards). Imperfect, but better than
      // 100% top-dollar bias from a single fixed direction.
      const sortOrder: 'asc' | 'desc' = i % 2 === 0 ? 'desc' : 'asc'
      const result = await pullPrimeAwardsWindow({
        startDate: win.start,
        endDate: win.end,
        maxPages: MAX_PAGES_PER_WINDOW,
        sortOrder,
      })

      totalRowsFetched += result.rowsReturned
      if (result.partialFailure) partialFailureWindows++

      const upserted = await persistAwards(result.awards, refreshBatchId)
      totalRowsUpserted += upserted

      logger.info('Winners intel window persisted', {
        refreshBatchId,
        window: `${win.start}..${win.end}`,
        pages: result.pagesFetched,
        rows: result.rowsReturned,
        upserted,
        truncatedAt: result.totalAvailable > result.rowsReturned ? result.totalAvailable : undefined,
      })
    }

    // Set-aside enrichment loop intentionally removed — see top-of-file note.
    // USAspending's type_set_aside filter is currently a no-op; running the
    // loop produced contaminated stamps. Per-award set-aside data must come
    // from /awards/<id>/ enrichment instead.

    // Subaward pull — PER-PRIME because USAspending removed the bulk
    // /search/spending_by_subaward/ endpoint (returned 404 as of 2026-05).
    // The replacement /api/v2/subawards/ accepts only a single award_id at
    // a time, so we iterate over the top-N primes by obligation. That
    // covers the agency-view's "Top Primes (≥$100M)" panel + every
    // realistic teamingSuggester query without burning hours per refresh.
    //
    // Top 1000 primes hits all $100M+ primes plus a buffer. With 5-wide
    // concurrency and ~200ms per call, ≈ 40s total for the subaward pass.
    let subawardRowsUpserted: number | null = null
    if (totalRowsUpserted > 0) {
      subawardRowsUpserted = 0
      const SUBAWARD_TOP_N = 1000
      // Lowered from 5 to 3 (2026-05-26): the prior 5-wide caused USAspending
      // to socket-hang-up on 56% of the top-1000 primes. 3-wide combined with
      // per-request retry/backoff in usaspendingSubawardPull.ts brings the
      // observed failure rate well under 15%.
      const SUBAWARD_PARALLELISM = 3

      const topPrimes = await prisma.winnersAwardStage.findMany({
        where: { refreshBatchId, usaspendingAwardId: { not: '' } },
        orderBy: { totalObligation: 'desc' },
        take: SUBAWARD_TOP_N,
        select: { usaspendingAwardId: true },
      })

      const queue = topPrimes.map((p) => p.usaspendingAwardId)
      let failedPrimes = 0
      let firstJoinCheckRun = false

      const workers: Promise<void>[] = []
      for (let i = 0; i < Math.min(SUBAWARD_PARALLELISM, queue.length); i++) {
        workers.push(
          (async function worker() {
            while (queue.length > 0) {
              const primeAwardId = queue.shift()
              if (!primeAwardId) break
              try {
                const result = await pullSubawardsForPrime({ primeAwardId, maxPages: 10 })
                if (result.partialFailure) failedPrimes++
                if (result.subawards.length > 0) {
                  const upserted = await persistSubawards(result.subawards, refreshBatchId)
                  if (subawardRowsUpserted !== null) subawardRowsUpserted += upserted

                  // Join-sanity check on the first successful prime only.
                  // If the persisted rows' primeAwardId doesn't match a
                  // WinnersAwardStage row, the JOIN to the right-panel
                  // and every sub-spend ratio will silently come back
                  // empty. Catching this here is cheaper than waiting for
                  // an operator to notice.
                  if (!firstJoinCheckRun) {
                    firstJoinCheckRun = true
                    const sample = result.subawards
                      .slice(0, 50)
                      .map((s) => s.primeAwardId)
                      .filter(Boolean)
                    if (sample.length > 0) {
                      const matched = await prisma.winnersAwardStage.count({
                        where: { usaspendingAwardId: { in: sample } },
                      })
                      if (matched === 0) {
                        logger.error('Winners intel: subaward → prime JOIN check FAILED. primeAwardId format does not match WinnersAwardStage.usaspendingAwardId.', {
                          refreshBatchId,
                          samplePreview: sample.slice(0, 3),
                        })
                      } else {
                        logger.info('Winners intel: subaward → prime JOIN check OK', {
                          refreshBatchId,
                          matched,
                          sampleSize: sample.length,
                        })
                      }
                    }
                  }
                }
              } catch (err) {
                failedPrimes++
                // Don't log per-prime errors — would flood the log for a
                // transient outage. The aggregate count is logged at end.
              }
            }
          })(),
        )
      }
      await Promise.all(workers)

      if (failedPrimes > 0) partialFailureWindows++

      logger.info('Winners intel subaward pull (per-prime) complete', {
        refreshBatchId,
        primesAttempted: topPrimes.length,
        primesFailed: failedPrimes,
        subawardRowsUpserted,
      })
    }

    // Per-award detail enrichment (Phase 2B.6). Top 500 rows by obligation
    // get a /awards/<id>/ fetch to populate recipient UEI + set-aside +
    // competition extent — the fields the bulk endpoint can't return.
    // Runs BEFORE distill so the slice top-recipients tables include the
    // newly-populated UEIs. ~2 minutes added to total refresh time.
    let awardsEnriched: number | null = null
    if (totalRowsUpserted > 0) {
      try {
        const enrichResult = await enrichTopAwards(refreshBatchId, 500)
        awardsEnriched = enrichResult.enriched
      } catch (err) {
        logger.warn('Winners intel enrichment pass failed (continuing to distill)', {
          refreshBatchId,
          error: (err as Error).message,
        })
      }
    }

    // Distillation: turn the staged rows into per-agency / per-NAICS slices
    // and write them to disk. Failure here doesn't fail the whole refresh —
    // the staging table still has the data, the operator can re-run
    // distillation alone if needed.
    let slicesWritten: number | null = null
    if (totalRowsUpserted > 0) {
      try {
        // Pass the pull window explicitly so the manifest reflects the
        // intended 24-month horizon, not the min/max awardDate observed
        // (which can include base-obligation dates from decades-old IDV
        // contracts that had recent modifications).
        const pullWindowStart = windows[0]?.start ?? ''
        const pullWindowEnd = windows[windows.length - 1]?.end ?? ''
        const distillation = await distillFromBatch(refreshBatchId, {
          windowStart: pullWindowStart,
          windowEnd: pullWindowEnd,
        })
        const writeResult = await writeSlices(distillation)
        slicesWritten = writeResult.slicesWritten
      } catch (err) {
        logger.error('Winners intel distillation failed (refresh data still usable)', {
          refreshBatchId,
          error: (err as Error).message,
        })
      }
    }

    const completedAt = new Date()
    const summary: RefreshSummary = {
      refreshBatchId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startMs,
      windowsProcessed: windows.length,
      totalRowsFetched,
      totalRowsUpserted,
      partialFailureWindows,
      slicesWritten,
      awardsEnriched,
      subawardRowsUpserted,
      status: 'COMPLETED',
    }
    await emitAuditRow(summary)
    return summary
  } catch (err) {
    const completedAt = new Date()
    const errorMessage = (err as Error).message
    logger.error('Winners intel refresh failed', { refreshBatchId, error: errorMessage })
    const summary: RefreshSummary = {
      refreshBatchId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: completedAt.getTime() - startMs,
      windowsProcessed: windows.length,
      totalRowsFetched,
      totalRowsUpserted,
      partialFailureWindows,
      slicesWritten: null,
      awardsEnriched: null,
      subawardRowsUpserted: null,
      status: 'FAILED',
      error: errorMessage,
    }
    await emitAuditRow(summary).catch(() => undefined)
    return summary
  }
}

/** Slice [today - months, today] into approximately CHUNK_DAYS-day windows. */
function buildWindows(months: number, chunkDays: number): Array<{ start: string; end: string }> {
  const today = new Date()
  const earliest = new Date(today)
  earliest.setUTCMonth(earliest.getUTCMonth() - months)

  const windows: Array<{ start: string; end: string }> = []
  let cursor = new Date(earliest)
  while (cursor < today) {
    const next = new Date(cursor)
    next.setUTCDate(next.getUTCDate() + chunkDays)
    const end = next > today ? today : next
    windows.push({
      start: cursor.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    })
    cursor = new Date(end)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return windows
}

/**
 * Upsert awards into WinnersAwardStage by usaspendingAwardId.
 *
 * Prisma's createMany has no upsert option, so when a re-run hits an existing
 * row we fall back to per-row upsert — slower, but correctness > throughput
 * for the staging table. Returns count of rows successfully written.
 */
async function persistAwards(awards: RawWinnerAward[], refreshBatchId: string): Promise<number> {
  if (awards.length === 0) return 0

  // Filter rows that have a usable primary key. USAspending occasionally
  // returns rows with empty internal IDs; without a stable key we cannot
  // upsert, so drop them rather than risk creating duplicate inserts.
  const valid = awards.filter((a) => a.usaspendingAwardId && a.usaspendingAwardId.length > 0)

  let upserted = 0
  for (let i = 0; i < valid.length; i += PERSIST_BATCH_SIZE) {
    const batch = valid.slice(i, i + PERSIST_BATCH_SIZE)

    // Try fast-path createMany with skipDuplicates first — covers the common
    // case where this batch is fresh data and no row collisions exist.
    const created = await prisma.winnersAwardStage.createMany({
      data: batch.map((a) => toCreateInput(a, refreshBatchId)),
      skipDuplicates: true,
    })
    upserted += created.count

    // Fall back to per-row upsert for the rows that were skipped (already exist).
    // This is the slow path but correct: existing rows get refreshed with the
    // latest field values from USAspending instead of being left stale.
    if (created.count < batch.length) {
      const skippedCount = batch.length - created.count
      let refreshed = 0
      for (const award of batch) {
        try {
          await prisma.winnersAwardStage.upsert({
            where: { usaspendingAwardId: award.usaspendingAwardId },
            create: toCreateInput(award, refreshBatchId),
            update: toUpdateInput(award, refreshBatchId),
          })
          refreshed++
        } catch (err) {
          logger.warn('Winners intel: row upsert failed', {
            usaspendingAwardId: award.usaspendingAwardId,
            error: (err as Error).message,
          })
        }
      }
      // Don't double-count: createMany already gave us `created.count` new rows.
      // Refreshed rows are existing rows, not new — but for the operator-facing
      // "rows touched" metric, count them all.
      upserted += Math.max(0, refreshed - (batch.length - skippedCount))
    }
  }

  return upserted
}

function toCreateInput(a: RawWinnerAward, refreshBatchId: string): Prisma.WinnersAwardStageCreateManyInput {
  return {
    usaspendingAwardId: a.usaspendingAwardId,
    pieceOfTheActionId: a.pieceOfTheActionId,
    recipientUei: a.recipientUei,
    recipientName: a.recipientName,
    recipientParentUei: a.recipientParentUei,
    agencyToptierCode: a.agencyToptierCode,
    agencyToptierName: a.agencyToptierName,
    agencySubtierCode: a.agencySubtierCode,
    awardingOfficeCode: a.awardingOfficeCode,
    fundingAgencyToptier: a.fundingAgencyToptier,
    naics: a.naics,
    pscCode: a.pscCode,
    setAsideType: a.setAsideType,
    contractType: a.contractType,
    competitionExtent: a.competitionExtent,
    numberOfOffersReceived: a.numberOfOffersReceived,
    totalObligation: a.totalObligation,
    baseExercisedOptions: a.baseExercisedOptions,
    baseAndAllOptions: a.baseAndAllOptions,
    periodOfPerformanceStart: a.periodOfPerformanceStart,
    periodOfPerformanceEnd: a.periodOfPerformanceEnd,
    awardDate: a.awardDate,
    fiscalYear: a.fiscalYear,
    placeOfPerformanceState: a.placeOfPerformanceState,
    placeOfPerformanceCountry: a.placeOfPerformanceCountry,
    recipientStateCode: a.recipientStateCode,
    recipientCountryCode: a.recipientCountryCode,
    refreshBatchId,
  }
}

function toUpdateInput(a: RawWinnerAward, refreshBatchId: string): Prisma.WinnersAwardStageUpdateInput {
  // Same field set as create. Updating in place lets re-runs refresh totals,
  // POP end dates, and other fields that change as the contract progresses.
  const { usaspendingAwardId: _ignored, ...rest } = toCreateInput(a, refreshBatchId)
  return rest
}

// ---------- Subaward persistence (Agency Phase A) ----------

/**
 * Upsert subaward rows into WinnersSubawardStage by usaspendingSubawardId.
 * Mirrors persistAwards() — same fast-path createMany / per-row upsert
 * fallback pattern, same failure tolerance, same return semantics.
 */
async function persistSubawards(subs: RawWinnerSubaward[], refreshBatchId: string): Promise<number> {
  if (subs.length === 0) return 0

  const valid = subs.filter((s) => s.usaspendingSubawardId && s.usaspendingSubawardId.length > 0)

  let upserted = 0
  for (let i = 0; i < valid.length; i += PERSIST_BATCH_SIZE) {
    const batch = valid.slice(i, i + PERSIST_BATCH_SIZE)

    const created = await prisma.winnersSubawardStage.createMany({
      data: batch.map((s) => toSubCreateInput(s, refreshBatchId)),
      skipDuplicates: true,
    })
    upserted += created.count

    if (created.count < batch.length) {
      const skippedCount = batch.length - created.count
      let refreshed = 0
      for (const sub of batch) {
        try {
          await prisma.winnersSubawardStage.upsert({
            where: { usaspendingSubawardId: sub.usaspendingSubawardId },
            create: toSubCreateInput(sub, refreshBatchId),
            update: toSubUpdateInput(sub, refreshBatchId),
          })
          refreshed++
        } catch (err) {
          logger.warn('Winners intel: subaward row upsert failed', {
            usaspendingSubawardId: sub.usaspendingSubawardId,
            error: (err as Error).message,
          })
        }
      }
      upserted += Math.max(0, refreshed - (batch.length - skippedCount))
    }
  }

  return upserted
}

function toSubCreateInput(s: RawWinnerSubaward, refreshBatchId: string): Prisma.WinnersSubawardStageCreateManyInput {
  return {
    usaspendingSubawardId: s.usaspendingSubawardId,
    primeAwardId: s.primeAwardId,
    subAmount: s.subAmount,
    subActionDate: s.subActionDate,
    subRecipientUei: s.subRecipientUei,
    subRecipientName: s.subRecipientName,
    subRecipientParentUei: s.subRecipientParentUei,
    subRecipientStateCode: s.subRecipientStateCode,
    subRecipientSize: s.subRecipientSize,
    // Prisma JSON column accepts plain objects; cast as InputJsonValue per
    // rules.md (spread typed object into the JSON field).
    subRecipientSetAsideFlags: { ...s.subRecipientSetAsideFlags } as Prisma.InputJsonValue,
    subDescription: s.subDescription,
    subNaics: s.subNaics,
    subPscCode: s.subPscCode,
    refreshBatchId,
  }
}

function toSubUpdateInput(s: RawWinnerSubaward, refreshBatchId: string): Prisma.WinnersSubawardStageUpdateInput {
  const { usaspendingSubawardId: _ignored, ...rest } = toSubCreateInput(s, refreshBatchId)
  return rest
}

/**
 * Write a single ComplianceLog row capturing the refresh outcome.
 *
 * Winners Intel data is platform-wide (not tenant-scoped), but ComplianceLog
 * requires consultingFirmId. We log against the platform owner firm so the
 * row is queryable; the entityType WINNERS_INTEL_REFRESH disambiguates it
 * from per-tenant audit traffic.
 */
async function emitAuditRow(summary: RefreshSummary): Promise<void> {
  // Fail safe: if the platform owner firm row is missing, skip the audit
  // write rather than crash the worker.
  const owner = await prisma.consultingFirm.findFirst({
    where: { name: { contains: 'Bytes Platform', mode: 'insensitive' } },
    select: { id: true },
  })
  if (!owner) {
    logger.warn('Winners intel refresh audit skipped: no platform owner firm found')
    return
  }

  await prisma.complianceLog
    .create({
      data: {
        consultingFirmId: owner.id,
        entityType: 'WINNERS_INTEL_REFRESH',
        entityId: summary.refreshBatchId,
        toStatus: summary.status,
        reason: `Pulled ${summary.totalRowsFetched} prime rows across ${summary.windowsProcessed} windows in ${summary.durationMs}ms${summary.subawardRowsUpserted !== null ? `, ${summary.subawardRowsUpserted} subaward rows` : ''}${summary.slicesWritten !== null ? `, wrote ${summary.slicesWritten} slices` : ''}${summary.partialFailureWindows ? ` (${summary.partialFailureWindows} window(s) had partial failures)` : ''}${summary.error ? `: ${summary.error}` : ''}`,
        triggeredBy: 'system:winners-intel-worker',
      },
    })
    .catch((err) => {
      logger.warn('Winners intel: failed to write refresh audit row', {
        refreshBatchId: summary.refreshBatchId,
        error: (err as Error).message,
      })
    })
}
