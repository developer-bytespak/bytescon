import { Worker, Queue, Job } from 'bullmq';
import path from 'path';
import fs from 'fs';
import { prisma } from '../config/database';
import { redis } from '../config/redis';
import { extractRequirementsFromPDF } from '../services/requirementExtractor';
import { writeFarApplicabilities } from '../services/far/farApplicabilityWriter';
import { logger } from '../utils/logger';

// BullMQ 4.x requires an IORedis instance, not { url }. Use the
// shared `redis` connection from config/redis (same pattern as
// scoringWorker / enrichmentWorker / recalibrationWorker).
const redisConnection = redis as any;

export const requirementExtractionQueue = new Queue('requirement-extraction', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: true,
    removeOnFail: false,
  }
});

/**
 * Queue a document for requirement extraction.
 * Triggers when a user uploads an RFP document.
 */
export async function queueRequirementExtraction(documentId: string): Promise<void> {
  try {
    await requirementExtractionQueue.add(
      'extract',
      { documentId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        // BullMQ 4.x removed the per-job `timeout` field. Long-running
        // PDF extraction is bounded by the worker process lifetime.
      }
    );
    logger.info('Requirement extraction queued', { documentId });
  } catch (err) {
    logger.error('Failed to queue requirement extraction', { documentId, error: String(err) });
    throw err;
  }
}

/**
 * Worker: Process requirement extraction jobs
 */
export function startRequirementExtractionWorker(): Worker {
  const worker = new Worker('requirement-extraction', async (job: Job) => {
    const { documentId } = job.data;

    logger.info('Processing requirement extraction', {
      jobId: job.id,
      documentId,
      attempt: job.attemptsMade + 1,
    });

    try {
      // 1. Fetch document record with opportunity and firm info
      const document = await prisma.opportunityDocument.findUnique({
        where: { id: documentId },
        include: {
          opportunity: {
            include: {
              consultingFirm: true,
            },
          },
        },
      });

      if (!document) {
        throw new Error(`Document not found: ${documentId}`);
      }

      // 2. Mark as extracting
      await prisma.opportunityDocument.update({
        where: { id: documentId },
        data: { extractionStatus: 'EXTRACTING' },
      });

      // 3. Read file from disk (uploads directory)
      const uploadsDir = path.join(process.cwd(), 'uploads');
      const filePath = path.join(uploadsDir, document.storageKey);

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found on disk: ${filePath}`);
      }

      const pdfBuffer = fs.readFileSync(filePath);
      logger.info('File read from disk', {
        documentId,
        filePath,
        size: pdfBuffer.length,
      });

      // 4. Extract requirements (FAR-grounded — opportunityId binds the
      // regulatory frame so every chunk inference inherits FAR context)
      const result = await extractRequirementsFromPDF(
        pdfBuffer,
        document.opportunity.consultingFirmId,
        document.opportunityId
      );

      logger.info('Requirements extracted', {
        documentId,
        requirementCount: result.requirements.length,
        confidence: result.extractionConfidence.toFixed(2),
      });

      // 5. Get or create ComplianceMatrix for this opportunity
      let matrix = await prisma.complianceMatrix.findUnique({
        where: { opportunityId: document.opportunityId },
      });

      if (!matrix) {
        matrix = await prisma.complianceMatrix.create({
          data: {
            opportunityId: document.opportunityId,
            consultingFirmId: document.opportunity.consultingFirmId,
          },
        });
        logger.info('ComplianceMatrix created', { matrixId: matrix.id, opportunityId: document.opportunityId });
      }

      // 6. Create MatrixRequirements with source document linking
      const createdReqs = await Promise.all(
        result.requirements.map(req =>
          prisma.matrixRequirement.create({
            data: {
              matrixId: matrix.id,
              section: req.section || `Section ${result.requirements.indexOf(req) + 1}`,
              sectionType: req.type === 'EVALUATION' ? 'EVALUATION' : 'INSTRUCTION',
              requirementText: req.statement,
              isMandatory: req.isMandatory,
              sourceDocumentId: documentId,
              sourcePageNumber: req.pageNumber,
              extractionMethod: 'AI',
              extractionConfidence: req.confidence,
            },
          })
        )
      );

      // 7. Update document with extraction status
      await prisma.opportunityDocument.update({
        where: { id: documentId },
        data: {
          extractionStatus: 'EXTRACTED',
          extractedRequirementCount: createdReqs.length,
          extractionConfidence: result.extractionConfidence,
          extractedAt: new Date(),
        },
      });

      // 8. Persist FarClauseApplicability rows so the opp's regulatory
      //    coverage is queryable from the FE without rebuilding the
      //    context. Non-fatal — a failure here doesn't invalidate
      //    the requirements that were just extracted.
      let farWriteCount = 0;
      try {
        const farResult = await writeFarApplicabilities(
          document.opportunityId,
          document.opportunity.consultingFirmId,
        );
        farWriteCount = farResult.written;
      } catch (farErr) {
        logger.warn('FAR applicability write failed (non-fatal)', {
          documentId,
          opportunityId: document.opportunityId,
          error: String(farErr),
        });
      }

      logger.info('Requirement extraction completed successfully', {
        jobId: job.id,
        documentId,
        requirementCount: createdReqs.length,
        confidence: result.extractionConfidence.toFixed(2),
        farApplicabilityRows: farWriteCount,
      });

      return {
        success: true,
        requirementCount: createdReqs.length,
        confidence: result.extractionConfidence,
        farApplicabilityRows: farWriteCount,
      };
    } catch (error) {
      logger.error('Requirement extraction failed', {
        jobId: job.id,
        documentId,
        attempt: job.attemptsMade + 1,
        error: String(error),
      });

      // Update document with error status
      try {
        await prisma.opportunityDocument.update({
          where: { id: documentId },
          data: {
            extractionStatus: 'FAILED',
            extractionError: String(error),
          },
        });
      } catch (updateErr) {
        logger.error('Failed to update document error status', { documentId, error: String(updateErr) });
      }

      throw error;  // Let BullMQ retry based on config
    }
  }, { connection: redisConnection });

  // Event handlers
  worker.on('completed', (job) => {
    logger.info('Extraction job completed', { jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    logger.error('Extraction job failed after retries', {
      jobId: job?.id,
      error: String(err),
    });
  });

  worker.on('error', (err) => {
    logger.error('Worker error', { error: String(err) });
  });

  logger.info('Requirement extraction worker started');
  return worker;
}
