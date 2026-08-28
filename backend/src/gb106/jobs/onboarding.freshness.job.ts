/**
 * GB-106 freshness scan. A scheduled BullMQ job that flags onboarding programs
 * whose verification has gone stale or was never confirmed, so dates are kept
 * current by review rather than hardcoded. The job does NOT scrape or auto-edit
 * federal data, it only surfaces what needs a human (or a future verified
 * connector) to confirm. This preserves the integrity rule: no fabricated dates.
 *
 * The Queue/Worker are created by the host (it owns the Redis connection). This
 * file exports a factory that registers the repeatable job and the processor.
 */

import { OnboardingService } from '../services/onboarding.service';
import type { Logger } from '../services/onboarding.service';

export const GB106_FRESHNESS_QUEUE = 'gb106-onboarding-freshness';
const DEFAULT_MAX_AGE_DAYS = 30;

/** Minimal structural types so this file does not hard-import bullmq. */
export interface QueueLike {
  add: (name: string, data: unknown, opts?: unknown) => Promise<unknown>;
}
export interface WorkerFactory {
  (queueName: string, processor: (job: { data: unknown }) => Promise<unknown>): unknown;
}

export interface FreshnessResult {
  scannedAt: string;
  maxAgeDays: number;
  staleProgramCodes: string[];
  staleCount: number;
}

/**
 * Register the repeatable freshness scan on an existing queue and create its worker.
 * Call once at startup from the mount helper.
 */
export async function registerFreshnessJob(opts: {
  queue: QueueLike;
  createWorker: WorkerFactory;
  service: OnboardingService;
  logger: Logger;
  maxAgeDays?: number;
  cron?: string; // default: daily at 06:00
}): Promise<void> {
  const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
  const cron = opts.cron ?? '0 6 * * *';

  // Repeatable schedule. jobId keeps re-registration idempotent across restarts.
  await opts.queue.add(
    'scan',
    { maxAgeDays },
    { repeat: { pattern: cron }, jobId: 'gb106-freshness-daily', removeOnComplete: true, removeOnFail: 50 }
  );

  opts.createWorker(GB106_FRESHNESS_QUEUE, async (job: { data: unknown }): Promise<FreshnessResult> => {
    const data = (job.data ?? {}) as { maxAgeDays?: number };
    const effectiveMaxAge = data.maxAgeDays ?? maxAgeDays;
    const now = new Date();
    const staleProgramCodes = await opts.service.getStaleProgramCodes(effectiveMaxAge, now);
    const result: FreshnessResult = {
      scannedAt: now.toISOString(),
      maxAgeDays: effectiveMaxAge,
      staleProgramCodes,
      staleCount: staleProgramCodes.length,
    };
    if (result.staleCount > 0) {
      opts.logger.warn('onboarding programs need re-verification', result);
    } else {
      opts.logger.info('onboarding freshness scan clean', result);
    }
    return result;
  });

  opts.logger.info('gb106 freshness job registered', { cron, maxAgeDays });
}
