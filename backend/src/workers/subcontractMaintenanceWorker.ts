// =============================================================
// Subcontract Maintenance Worker
// Nightly housekeeping for the subcontracting POC pipeline:
//   1. Capture sweep  — safety net so every opportunity with a POC is
//      mirrored into the perpetual subcontract_contacts directory before
//      the opportunity itself is purged. Live captures happen on sync /
//      manual create, but a swept run guarantees nothing slips through.
//   2. Purge expired  — hard-delete opportunities whose responseDeadline
//      is past the 7-day grace window (the POC is already captured, so the
//      opportunity row is disposable).
//   3. Prune contacts — drop junk + stale low-value rows from the directory.
//
// Cron: 30 3 * * *  (daily at 03:30 UTC)
//   - Just after the 03:00 UTC nightly DB backup.
//   - Low-traffic window, before US business hours.
// =============================================================

import { Queue, Worker } from 'bullmq'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { config } from '../config/config'
import { captureContact, pruneContacts } from '../services/scw/subcontractContacts'
import { graceCutoff } from '../services/scw/subcontractExpiry'

const QUEUE_NAME = 'subcontract-maintenance'

function parseRedisUrl(url: string) {
  try {
    const u = new URL(url)
    return {
      host: u.hostname || 'localhost',
      port: parseInt(u.port || '6379', 10),
      password: u.password || undefined,
    }
  } catch {
    return { host: 'localhost', port: 6379 }
  }
}
const connection = parseRedisUrl(config.redis.url)

const queue = new Queue(QUEUE_NAME, { connection })

// -------------------------------------------------------------
// Job: daily-maintenance
// Capture sweep -> purge expired opportunities -> prune contacts.
// -------------------------------------------------------------
async function runMaintenance() {
  logger.info('Subcontract maintenance started')
  const startMs = Date.now()

  try {
    // 1. CAPTURE SWEEP — mirror every opportunity carrying a POC into the
    //    perpetual directory (best-effort; captureContact swallows its own
    //    errors and returns null when there is nothing to capture).
    const opportunities = await prisma.subcontractOpportunity.findMany({
      where: {
        OR: [{ contactEmail: { not: null } }, { contactName: { not: null } }],
      },
      select: {
        consultingFirmId: true,
        primeContractor: true,
        primeContractorUei: true,
        contactName: true,
        contactEmail: true,
        agency: true,
        naicsCode: true,
        setAside: true,
        sourceUrl: true,
        id: true,
        title: true,
      },
    })

    let swept = 0
    for (const o of opportunities) {
      const res = await captureContact({
        consultingFirmId: o.consultingFirmId,
        primeContractor: o.primeContractor,
        primeContractorUei: o.primeContractorUei,
        contactName: o.contactName,
        contactEmail: o.contactEmail,
        agency: o.agency,
        naicsCode: o.naicsCode,
        setAside: o.setAside,
        sourceUrl: o.sourceUrl,
        opportunityId: o.id,
        opportunityTitle: o.title,
      })
      if (res) swept++
    }

    // 2. PURGE expired opportunities past the 7-day grace window. Only rows
    //    with a non-null deadline match { lt } — nulls are excluded.
    const cutoff = graceCutoff(new Date())
    const purged = await prisma.subcontractOpportunity.deleteMany({
      where: { responseDeadline: { lt: cutoff } },
    })

    // 3. PRUNE contacts across all firms (junk + stale low-value rows).
    const pruned = await pruneContacts()

    const elapsedMs = Date.now() - startMs
    logger.info('Subcontract maintenance complete', {
      swept,
      purged: purged.count,
      junkDeleted: pruned.junkDeleted,
      staleDeleted: pruned.staleDeleted,
      elapsedMs,
    })

    return { swept, purged: purged.count, pruned }
  } catch (err) {
    logger.error('Subcontract maintenance failed', {
      error: (err as Error).message,
    })
    return { error: (err as Error).message }
  }
}

// -------------------------------------------------------------
// Worker boot
// -------------------------------------------------------------
export function startSubcontractMaintenanceWorker() {
  const worker = new Worker(QUEUE_NAME, async (job) => {
    if (job.name === 'daily-maintenance') {
      return runMaintenance()
    }
    throw new Error(`Unknown job: ${job.name}`)
  }, { connection })

  // Daily at 03:30 UTC.
  queue.add(
    'daily-maintenance',
    {},
    {
      repeat: { pattern: '30 3 * * *' },
      removeOnComplete: 20,
      removeOnFail: 20,
    }
  ).then(() => {
    logger.info('Subcontract maintenance worker started (daily at 03:30 UTC)')
  }).catch(err => {
    logger.error('Failed to schedule subcontract maintenance', { error: err.message })
  })

  worker.on('completed', (job, result) => {
    logger.info('Subcontract maintenance job complete', { jobId: job.id, result })
  })
  worker.on('failed', (job, err) => {
    logger.error('Subcontract maintenance job failed', { jobId: job?.id, error: err.message })
  })

  return worker
}

// Manual trigger for ops / testing.
export async function triggerSubcontractMaintenance() {
  return runMaintenance()
}
