// =============================================================
// GB-107 mount — single additive entry point, GB-106 pattern.
//
// The host (server.ts) adds one import and one mountGb107() call in
// its worker-startup block, and one close() in the shutdown handler.
// No existing ingestion, scoring, or MCP route handler is modified.
// =============================================================
import type { Worker } from 'bullmq'
import { logger } from '../utils/logger'
import { getGb107Config } from './config.gb107'
import { startGb107Worker, gb107Queue } from './worker.gb107'

export interface Gb107Handle {
  worker: Worker
  close(): Promise<void>
}

export function mountGb107(): Gb107Handle {
  const cfg = getGb107Config()
  logger.info('GB-107 description enrichment mounted', {
    keyConfigured: cfg.samGovApiKey.length > 0,
    ratePerDay: cfg.ratePerDay,
    batchSize: cfg.batchSize,
    priorityWindowDays: cfg.priorityWindowDays,
  })

  const worker = startGb107Worker()

  return {
    worker,
    async close() {
      await worker.close()
      await gb107Queue.close()
    },
  }
}
