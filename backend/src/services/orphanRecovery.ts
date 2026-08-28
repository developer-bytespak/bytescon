// =============================================================
// Orphaned document-job recovery (P1-5 — failure integrity)
//
// A backend crash (SIGKILL / OOM / power loss) leaves OpportunityDocument rows
// stuck at analysisStatus=IN_PROGRESS or extractionStatus=EXTRACTING forever:
//   • a `finally` block cannot run on a killed process, so wrapping the worker
//     body in try/finally does NOT cover the crash case; and
//   • BullMQ's `failed` event only fires for in-process failures (which the
//     workers already handle), never for a process that died.
//
// This reaper — run once at startup, mirroring findOrClearStaleRunningJob for
// IngestionJob in routes/jobs.ts — transitions any document stuck in a running
// state longer than `thresholdMs` to a terminal FAILED state with an audit
// reason. It is a typed terminal transition, never a fabricated success.
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'

/** A document in a running state longer than this is treated as orphaned. */
export const ORPHAN_THRESHOLD_MS = 30 * 60 * 1000 // 30 minutes

export interface OrphanRecoveryResult {
  analysisRecovered: number
  extractionRecovered: number
}

/**
 * Fail document jobs orphaned in a running state past `thresholdMs`.
 *
 * @param thresholdMs  age past which a running document is considered orphaned
 * @param db           Prisma client (injectable for tests)
 * @param now          clock (injectable for deterministic tests)
 */
export async function recoverOrphanedDocuments(
  thresholdMs: number = ORPHAN_THRESHOLD_MS,
  db: typeof prisma = prisma,
  now: () => number = Date.now,
): Promise<OrphanRecoveryResult> {
  const cutoff = new Date(now() - thresholdMs)
  const minutes = Math.round(thresholdMs / 60000)

  // updatedAt is @updatedAt, so an updateMany bumps it to now() on every row
  // it touches. If the reapers filtered by `updatedAt < cutoff` directly, the
  // analysis update would bump a document orphaned in BOTH states out of the
  // extraction reaper's window, leaving it stuck at EXTRACTING forever.
  // Select both orphan id sets FIRST, then key each updateMany by id so the
  // first update cannot exclude rows from the second.

  // analysisStatus is the DocumentAnalysisStatus enum; IN_PROGRESS is its
  // non-terminal running state.
  const analysisOrphans = await db.opportunityDocument.findMany({
    where: { analysisStatus: 'IN_PROGRESS', updatedAt: { lt: cutoff } },
    select: { id: true },
  })

  // extractionStatus is a plain string column; EXTRACTING is its running state.
  const extractionOrphans = await db.opportunityDocument.findMany({
    where: { extractionStatus: 'EXTRACTING', updatedAt: { lt: cutoff } },
    select: { id: true },
  })

  const analysis = await db.opportunityDocument.updateMany({
    where: { id: { in: analysisOrphans.map((d) => d.id) } },
    data: {
      analysisStatus: 'FAILED',
      analysisError: `Auto-failed at startup: stuck IN_PROGRESS for > ${minutes} min (likely orphaned by a crash or restart).`,
    },
  })

  const extraction = await db.opportunityDocument.updateMany({
    where: { id: { in: extractionOrphans.map((d) => d.id) } },
    data: {
      extractionStatus: 'FAILED',
      extractionError: `Auto-failed at startup: stuck EXTRACTING for > ${minutes} min (likely orphaned by a crash or restart).`,
    },
  })

  if (analysis.count > 0 || extraction.count > 0) {
    logger.warn('Recovered orphaned document jobs at startup', {
      analysisRecovered: analysis.count,
      extractionRecovered: extraction.count,
      thresholdMs,
    })
  }

  return { analysisRecovered: analysis.count, extractionRecovered: extraction.count }
}
