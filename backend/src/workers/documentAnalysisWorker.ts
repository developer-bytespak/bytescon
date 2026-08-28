// =============================================================
// Document Analysis Worker
// Replaces the setImmediate fire-and-forget in jobs.ts with a
// proper BullMQ job so provider errors get:
//   1. Retried with exponential backoff (transient 429 / 5xx)
//   2. Marked FAILED with the captured error (not silently 0.5)
//   3. Rate-limited to 2 concurrent requests (no self-inflicted 429)
// =============================================================
import { Worker, Queue, Job } from 'bullmq'
import fs from 'fs'
import path from 'path'
import { prisma } from '../config/database'
import { redis } from '../config/redis'
import { logger } from '../utils/logger'
import { scoringQueue } from './scoringWorker'

const redisConnection = redis as any

export const documentAnalysisQueue = new Queue('document-analysis', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
  },
})

export interface DocumentAnalysisJobData {
  documentId: string
  consultingFirmId: string
  ingestionJobId: string
}

export async function enqueueDocumentAnalysis(data: DocumentAnalysisJobData): Promise<void> {
  await documentAnalysisQueue.add('analyze', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
  })
  logger.info('Document analysis enqueued', { documentId: data.documentId })
}

/**
 * Convenience used by every UPLOAD path (manual contract, per-opportunity doc,
 * zip extraction). Creates the tracking IngestionJob, flips the document to
 * IN_PROGRESS for immediate UI feedback, and enqueues scope analysis — the
 * exact bookkeeping POST /api/jobs/analyze/:documentId does.
 *
 * Previously the upload routes created documents at analysisStatus='PENDING'
 * but never enqueued analysis, so manually uploaded contracts sat unanalyzed
 * forever (and their documentIntelScore stayed null → a flat 0.5 in scoring).
 *
 * Best-effort by design: a queue/DB hiccup here must NOT fail an otherwise
 * successful upload, so it logs and swallows. The document is still PENDING and
 * can be (re)analyzed manually via POST /api/jobs/analyze/:documentId.
 */
export async function queueAnalysisForUpload(
  documentId: string,
  consultingFirmId: string,
): Promise<void> {
  try {
    const job = await prisma.ingestionJob.create({
      data: {
        consultingFirmId,
        type: 'ANALYZE_DOCUMENT',
        status: 'RUNNING',
        startedAt: new Date(),
      },
    })
    await prisma.opportunityDocument.update({
      where: { id: documentId },
      data: { analysisStatus: 'IN_PROGRESS' },
    })
    await enqueueDocumentAnalysis({ documentId, consultingFirmId, ingestionJobId: job.id })
  } catch (err) {
    logger.error('Failed to queue document analysis for upload (non-fatal)', {
      documentId,
      error: (err as Error).message,
    })
  }
}

export function startDocumentAnalysisWorker(): Worker {
  const worker = new Worker<DocumentAnalysisJobData>(
    'document-analysis',
    async (job: Job<DocumentAnalysisJobData>) => {
      const { documentId, consultingFirmId, ingestionJobId } = job.data

      logger.info('Processing document analysis', {
        jobId: job.id,
        documentId,
        attempt: job.attemptsMade + 1,
      })

      // Mark IN_PROGRESS only on first attempt to avoid redundant writes
      if (job.attemptsMade === 0) {
        await prisma.opportunityDocument.update({
          where: { id: documentId },
          data: { analysisStatus: 'IN_PROGRESS' },
        })
      }

      const doc = await prisma.opportunityDocument.findUnique({
        where: { id: documentId },
        include: {
          opportunity: {
            select: {
              id: true,
              title: true,
              agency: true,
              naicsCode: true,
              consultingFirmId: true,
            },
          },
        },
      })

      if (!doc) throw new Error(`Document not found: ${documentId}`)
      if (!doc.storageKey || /[/\\]/.test(doc.storageKey) || doc.storageKey.includes('..')) {
        throw new Error('Invalid document storage key')
      }

      const documentPath = path.join(process.cwd(), 'uploads', doc.storageKey)
      if (!fs.existsSync(documentPath)) {
        throw new Error('Document file missing from storage')
      }

      const clients = await prisma.clientCompany.findMany({
        where: { consultingFirmId, isActive: true },
        select: { naicsCodes: true, sdvosb: true, wosb: true, hubzone: true, smallBusiness: true },
      })

      const clientCerts = clients.flatMap((c) =>
        [
          c.sdvosb ? 'SDVOSB' : null,
          c.wosb ? 'WOSB' : null,
          c.hubzone ? 'HUBZone' : null,
          c.smallBusiness ? 'Small Business' : null,
        ].filter((x): x is string => x !== null)
      )

      // Dynamic import avoids circular dep with the class instance
      const { documentAnalysisService } = await import('../services/documentAnalysis')
      const analysis = await documentAnalysisService.analyzeDocument(
        documentPath,
        {
          title: doc.opportunity.title,
          agency: doc.opportunity.agency ?? undefined,
          naicsCode: doc.opportunity.naicsCode ?? undefined,
          clientNaicsCodes: clients.flatMap((c) => c.naicsCodes),
          clientCertifications: [...new Set(clientCerts)],
        },
        consultingFirmId
      )

      // analysis only reaches here on success (errors rethrow to BullMQ retry)
      await prisma.opportunityDocument.update({
        where: { id: documentId },
        data: {
          analysisStatus: 'COMPLETE',
          scopeKeywords: analysis.scopeKeywords,
          complexityScore: analysis.complexityScore,
          alignmentScore: analysis.alignmentScore,
          incumbentSignals: analysis.incumbentSignals,
          rawAnalysis: analysis.rawAnalysis as any,
          analyzedAt: new Date(),
        },
      })

      await prisma.opportunity.update({
        where: { id: doc.opportunityId },
        data: {
          documentIntelScore: analysis.alignmentScore,
          scopeAlignmentScore: analysis.alignmentScore,
          technicalComplexScore: analysis.complexityScore,
          incumbentSignalDetected: analysis.incumbentSignals.length > 0,
          isScored: false,
        },
      })

      // Trigger re-score with new document signal
      await scoringQueue.add('score-opportunity', {
        opportunityId: doc.opportunityId,
        consultingFirmId,
      })

      await prisma.ingestionJob.update({
        where: { id: ingestionJobId },
        data: { status: 'COMPLETE', completedAt: new Date() },
      })

      logger.info('Document analysis completed', { jobId: job.id, documentId })
    },
    {
      connection: redisConnection,
      // Cap at 2 concurrent provider calls per worker process.
      // A bulk upload of 10 documents fires 10 jobs; without this cap
      // they all hit the provider simultaneously and self-inflict a 429.
      concurrency: 2,
    }
  )

  worker.on('failed', async (job, err) => {
    if (!job) return
    const { documentId, ingestionJobId } = job.data as DocumentAnalysisJobData
    const isNoKey = (err as Error).message === 'NO_LLM_KEY'
    const isRateLimit =
      (err as Error).message === 'RATE_LIMITED' ||
      (err as Error).message.includes('429')

    logger.error('Document analysis job failed', {
      jobId: job.id,
      documentId,
      attempt: job.attemptsMade,
      isRateLimit,
      error: (err as Error).message,
    })

    // Only write the terminal failure status after all retries are exhausted
    // (BullMQ fires 'failed' after the final attempt, not on each retry)
    await prisma.opportunityDocument
      .update({
        where: { id: documentId },
        data: {
          analysisStatus: isNoKey ? 'SKIPPED' : 'FAILED',
          analysisError: isRateLimit
            ? 'AI provider rate limit — analysis will be retried automatically.'
            : (err as Error).message,
        },
      })
      .catch((updateErr) =>
        logger.error('Failed to write document FAILED status', {
          documentId,
          error: (updateErr as Error).message,
        })
      )

    await prisma.ingestionJob
      .update({
        where: { id: ingestionJobId },
        data: {
          status: isNoKey ? 'COMPLETE' : 'FAILED',
          completedAt: new Date(),
          errorDetail: isNoKey ? null : (err as Error).message,
        },
      })
      .catch((updateErr) =>
        logger.error('Failed to update ingestion job on analysis failure', {
          error: (updateErr as Error).message,
        })
      )
  })

  worker.on('error', (err) => {
    logger.error('Document analysis worker error', { error: (err as Error).message })
  })

  logger.info('Document analysis worker started (concurrency: 2)')
  return worker
}
