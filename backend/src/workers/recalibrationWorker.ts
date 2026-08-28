// =============================================================
// Nightly Recalibration Worker
// BullMQ cron: runs at 02:00 UTC daily
// 1. Refreshes NAICS competitive density cache
// 2. Refreshes agency award profile cache
// 3. Re-scores all active opportunities across all firms
// =============================================================
import { Worker, Queue, Job } from 'bullmq';
import { redis } from '../config/redis';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { refreshNaicsDensity } from '../engines/competitiveDensity';
import { refreshAgencyProfile } from '../engines/agencyProfiler';
import { scoringQueue } from './scoringWorker';

export const RECALIBRATION_QUEUE_NAME = 'nightly-recalibration';

export const recalibrationQueue = new Queue(RECALIBRATION_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30000 },
    removeOnComplete: 5,
    removeOnFail: 10,
  },
});

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRecalibration(): Promise<void> {
  logger.info('Nightly recalibration started');

  // ── 1. NAICS density refresh ──────────────────────────────
  const naicsRows = await prisma.opportunity.findMany({
    where: { status: 'ACTIVE' },
    select: { naicsCode: true },
    distinct: ['naicsCode'],
  });
  const uniqueNaics = naicsRows.map((r) => r.naicsCode).filter(Boolean);
  logger.info('Refreshing NAICS density', { count: uniqueNaics.length });

  for (let i = 0; i < uniqueNaics.length; i += 5) {
    await Promise.all(uniqueNaics.slice(i, i + 5).map(refreshNaicsDensity));
    if (i + 5 < uniqueNaics.length) await sleep(1500);
  }

  // ── 2. Agency profile refresh ─────────────────────────────
  const agencyRows = await prisma.opportunity.findMany({
    where: { status: 'ACTIVE' },
    select: { agency: true },
    distinct: ['agency'],
  });
  const uniqueAgencies = agencyRows.map((r) => r.agency).filter(Boolean);
  logger.info('Refreshing agency profiles', { count: uniqueAgencies.length });

  for (let i = 0; i < uniqueAgencies.length; i += 5) {
    await Promise.all(uniqueAgencies.slice(i, i + 5).map(refreshAgencyProfile));
    if (i + 5 < uniqueAgencies.length) await sleep(1500);
  }

  // ── 3. Re-score all active opportunities ──────────────────
  const firms = await prisma.consultingFirm.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  let totalRequeued = 0;
  for (const firm of firms) {
    const opps = await prisma.opportunity.findMany({
      where: { consultingFirmId: firm.id, status: 'ACTIVE' },
      select: { id: true },
    });
    if (opps.length === 0) continue;

    // Mark all as unscored so scoring worker re-evaluates them
    await prisma.opportunity.updateMany({
      where: { consultingFirmId: firm.id, status: 'ACTIVE' },
      data: { isScored: false },
    });

    const jobs = opps.map((opp) => ({
      name: 'score-opportunity',
      data: { opportunityId: opp.id, consultingFirmId: firm.id },
    }));
    await scoringQueue.addBulk(jobs);
    totalRequeued += jobs.length;
  }

  logger.info('Nightly recalibration complete', {
    naicsRefreshed: uniqueNaics.length,
    agenciesRefreshed: uniqueAgencies.length,
    opportunitiesRequeued: totalRequeued,
  });
}

export function startRecalibrationWorker(): Worker {
  const worker = new Worker(
    RECALIBRATION_QUEUE_NAME,
    async (_job: Job) => runRecalibration(),
    { connection: redis, concurrency: 1 }
  );

  // Schedule nightly at 02:00 UTC
  recalibrationQueue.add('nightly-recalibrate', {}, {
    repeat: { pattern: '0 2 * * *' },
    removeOnComplete: 5,
  }).catch(() => { /* repeat job may already exist */ });

  worker.on('completed', (job) => {
    logger.info('Recalibration job completed', { jobId: job.id });
  });
  worker.on('failed', (job, err) => {
    logger.error('Recalibration job failed', { jobId: job?.id, error: err.message });
  });
  worker.on('error', (err) => {
    logger.error('Recalibration worker error', { error: err.message });
  });

  logger.info('Recalibration worker started (nightly at 02:00 UTC)');
  return worker;
}
