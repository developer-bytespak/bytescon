// =============================================================
// Jobs Routes
// POST /api/jobs/ingest
// POST /api/jobs/enrich
// POST /api/jobs/analyze/:documentId
// GET  /api/jobs
// GET  /api/jobs/:id
// =============================================================
import { Router, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { authenticateJWT } from '../middleware/auth';
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant';
import { AuthenticatedRequest } from '../types';
import { scoringQueue, enqueueAllOpportunitiesForScoring } from '../workers/scoringWorker';
// enrichmentQueue is read ONLY as a stall-detection guard (is this firm's
// work still queued?) — job completion itself stays per-firm.
import { enqueueEnrichmentJobs, enrichmentQueue } from '../workers/enrichmentWorker';
import { enqueueDocumentAnalysis } from '../workers/documentAnalysisWorker';
import { enqueueClientMatchNotifications } from '../workers/clientMatchNotificationWorker';
import { samApiService } from '../services/samApi';
import { logger } from '../utils/logger';
import { z } from 'zod';

const router = Router();
router.use(authenticateJWT, enforceTenantScope);
router.use(requireActiveBase);

const IngestParamsSchema = z.object({
  naicsCode: z.string().optional(),
  agency: z.string().optional(),
  setAsideType: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(25),
});

// If a backend restart or crash leaves an IngestionJob orphaned at RUNNING, the
// guard below would block every future job of that type forever. Auto-fail any
// RUNNING row older than `staleAfterMs` and return null so the caller proceeds
// with a fresh job. Bug history: a single orphaned row sat RUNNING for 17 days
// on prod (2026-05-06 → 2026-05-24) and broke Sync Contracts for that firm.
async function findOrClearStaleRunningJob(
  consultingFirmId: string,
  type: 'INGEST' | 'ENRICH',
  staleAfterMs: number,
) {
  const running = await prisma.ingestionJob.findFirst({
    where: { consultingFirmId, type, status: 'RUNNING' },
  });
  if (!running) return null;

  // Null startedAt on a RUNNING row is itself a corrupted state — treat as stale.
  const age = running.startedAt ? Date.now() - running.startedAt.getTime() : Infinity;
  if (age > staleAfterMs) {
    await prisma.ingestionJob.update({
      where: { id: running.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorDetail: `Auto-failed: RUNNING for ${Math.round(age / 60000)} min (> ${Math.round(staleAfterMs / 60000)} min threshold). Likely orphaned by backend restart.`,
      },
    });
    logger.warn('Auto-failed stale ingestion job', { jobId: running.id, type, ageMs: age });
    return null;
  }
  return running;
}

// -------------------------------------------------------------
// POST /api/jobs/ingest
// -------------------------------------------------------------
router.post('/ingest', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const params = IngestParamsSchema.parse(req.body);

    // Ingest typically completes in seconds. Anything RUNNING > 15 min is dead.
    const recentJob = await findOrClearStaleRunningJob(consultingFirmId, 'INGEST', 15 * 60 * 1000);
    if (recentJob) {
      return res.status(409).json({
        success: false,
        error: 'An ingest job is already running. Wait for it to complete before starting another.',
        data: { jobId: recentJob.id, status: 'RUNNING' },
      });
    }

    const job = await prisma.ingestionJob.create({
      data: {
        consultingFirmId,
        type: 'INGEST',
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    logger.info('Ingest job created', { jobId: job.id, consultingFirmId });

    // Return immediately — ingest runs in background
    res.json({ success: true, data: { jobId: job.id, status: 'RUNNING' } });

    setImmediate(async () => {
      try {
        const stats = await samApiService.searchAndIngest(params, consultingFirmId) as any;
        const scoringCount = await enqueueAllOpportunitiesForScoring(consultingFirmId);

        // GB-103 — notify clients of fresh high-match opportunities. No-op
        // unless CLIENT_NOTIFICATIONS_ENABLED. The worker re-scores against
        // client profiles, so it does not depend on scoring having drained.
        enqueueClientMatchNotifications(consultingFirmId).catch((err: Error) => {
          logger.warn('enqueueClientMatchNotifications failed after ingest', { consultingFirmId, error: err.message });
        });

        await prisma.ingestionJob.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETE',
            completedAt: new Date(),
            opportunitiesFound: stats.found || 0,
            opportunitiesNew: stats.ingested || 0,
            scoringJobsQueued: scoringCount,
            errors: stats.errors || 0,
          },
        });

        logger.info('Ingest job complete', { jobId: job.id });
      } catch (err) {
        const errorMsg = (err as Error).message;
        logger.error('Ingest job failed', { jobId: job.id, error: errorMsg });
        await prisma.ingestionJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', completedAt: new Date(), errorDetail: errorMsg },
        });
      }
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// POST /api/jobs/enrich
// -------------------------------------------------------------
router.post('/enrich', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);

    // Enrich has its own 30-min internal timeout (see poll loop below). Allow
    // 45 min before treating a RUNNING row as stale — 15 min buffer past the
    // internal timeout for slow DB writes.
    const running = await findOrClearStaleRunningJob(consultingFirmId, 'ENRICH', 45 * 60 * 1000);

    if (running) {
      return res.json({
        success: true,
        data: { jobId: running.id, status: 'RUNNING', message: 'Enrichment already in progress' },
      });
    }

    const unenrichedCount = await prisma.opportunity.count({
      where: { consultingFirmId, status: 'ACTIVE', isEnriched: false },
    });

    if (unenrichedCount === 0) {
      return res.json({
        success: true,
        data: { jobId: null, status: 'COMPLETE', message: 'All opportunities already enriched' },
      });
    }

    const job = await prisma.ingestionJob.create({
      data: {
        consultingFirmId,
        type: 'ENRICH',
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    res.json({
      success: true,
      data: { jobId: job.id, status: 'RUNNING', opportunitiesToEnrich: unenrichedCount },
    });

    setImmediate(async () => {
      try {
        const enqueuedCount = await enqueueEnrichmentJobs(consultingFirmId, job.id);
        // Per-firm completion target: this batch enqueues up to 500 of THIS
        // firm's opportunities, so the batch is done when this firm's remaining
        // unenriched count drops by that many. (Previously we polled the GLOBAL
        // BullMQ queue depth, which coupled this firm's job status to every
        // other tenant's workload.)
        const targetRemaining = Math.max(0, unenrichedCount - enqueuedCount);

        // Poll until the enrichment worker drains this firm's batch
        const maxWait = 30 * 60 * 1000;
        const pollInterval = 15000;
        const startTime = Date.now();
        let lastUnenriched = -1;
        let stablePolls = 0;
        const STALL_POLLS = 6; // 6 × 15s = 90s of no net progress ⇒ batch drained

        const poll = async () => {
          if (Date.now() - startTime > maxWait) {
            // Mark complete with however many were enriched — don't fail just because
            // the queue drained via timeout (batch may be legitimately done)
            const enrichedCount = await prisma.opportunity.count({
              where: { consultingFirmId, isEnriched: true },
            });
            await prisma.ingestionJob.update({
              where: { id: job.id },
              data: { status: 'COMPLETE', completedAt: new Date(), enrichedCount },
            });
            logger.info('Enrich job timed out — marking complete with current count', { jobId: job.id, enrichedCount });
            return;
          }

          // Per-firm completion: count only THIS firm's still-unenriched active
          // opportunities against the batch target. Isolates the job from other
          // tenants' queue workload while correctly handling >500-at-a-time
          // batching (target = initial unenriched − this batch's enqueued count).
          const currentUnenriched = await prisma.opportunity.count({
            where: { consultingFirmId, status: 'ACTIVE', isEnriched: false },
          });

          // Stall detection: a permanently-failed enrichment (retries exhausted /
          // all-clients-failed) never flips isEnriched, so the count can sit above
          // targetRemaining forever. If it stops moving for STALL_POLLS consecutive
          // polls the batch has drained (the remainder are failures) — complete
          // rather than wait out the 30-min timeout. Still fully per-firm.
          stablePolls = currentUnenriched === lastUnenriched ? stablePolls + 1 : 0;
          lastUnenriched = currentUnenriched;

          // Guard the stall heuristic against FIFO queuing behind other tenants:
          // "no per-firm progress for 90s" can simply mean this firm's jobs are
          // still WAITING while another firm's batch occupies the shared workers.
          // Only treat a stall as "drained" when none of THIS firm's jobs remain
          // queued or running (the 30-min maxWait stays the hard backstop).
          if (stablePolls >= STALL_POLLS) {
            try {
              const pending = await enrichmentQueue.getJobs(['waiting', 'active', 'delayed', 'prioritized']);
              const firmStillQueued = pending.some(
                (j) => (j?.data as { consultingFirmId?: string } | undefined)?.consultingFirmId === consultingFirmId,
              );
              if (firmStillQueued) stablePolls = 0;
            } catch (queueErr) {
              logger.warn('Stall-guard queue check failed — deferring stall completion', {
                jobId: job.id,
                error: (queueErr as Error).message,
              });
              stablePolls = 0;
            }
          }

          if (currentUnenriched <= targetRemaining || stablePolls >= STALL_POLLS) {
            const enrichedCount = await prisma.opportunity.count({
              where: { consultingFirmId, isEnriched: true },
            });
            await prisma.ingestionJob.update({
              where: { id: job.id },
              data: { status: 'COMPLETE', completedAt: new Date(), enrichedCount },
            });
            logger.info('Enrich job complete', {
              jobId: job.id,
              enrichedCount,
              drainedByStall: currentUnenriched > targetRemaining,
            });
          } else {
            setTimeout(poll, pollInterval);
          }
        };

        setTimeout(poll, pollInterval);
      } catch (err) {
        const errorMsg = (err as Error).message;
        await prisma.ingestionJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', completedAt: new Date(), errorDetail: errorMsg },
        });
      }
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// POST /api/jobs/analyze/:documentId
// -------------------------------------------------------------
router.post('/analyze/:documentId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const { documentId } = req.params;

    const doc = await prisma.opportunityDocument.findFirst({
      where: { id: documentId },
      include: { opportunity: true },
    });

    if (!doc || doc.opportunity.consultingFirmId !== consultingFirmId) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    const job = await prisma.ingestionJob.create({
      data: {
        consultingFirmId,
        type: 'ANALYZE_DOCUMENT',
        status: 'RUNNING',
        startedAt: new Date(),
      },
    });

    // Mark IN_PROGRESS immediately so the UI shows activity before the worker picks it up
    await prisma.opportunityDocument.update({
      where: { id: documentId },
      data: { analysisStatus: 'IN_PROGRESS' },
    });

    await enqueueDocumentAnalysis({
      documentId,
      consultingFirmId,
      ingestionJobId: job.id,
    });

    res.json({ success: true, data: { jobId: job.id, status: 'RUNNING' } });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// GET /api/jobs
// -------------------------------------------------------------
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const jobs = await prisma.ingestionJob.findMany({
      where: { consultingFirmId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json({ success: true, data: jobs });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// GET /api/jobs/:id
// -------------------------------------------------------------
router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const { id } = req.params;

    const job = await prisma.ingestionJob.findFirst({
      where: { id, consultingFirmId },
    });

    if (!job) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({ success: true, data: job });
  } catch (err) {
    next(err);
  }
});

export default router;
