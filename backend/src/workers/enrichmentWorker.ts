// =============================================================
// Enrichment Worker — BullMQ
// Tier 2: USAspending award history enrichment
// =============================================================
import { Worker, Queue, Job } from 'bullmq';
import { redis } from '../config/redis';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { roundTo } from '../utils/number';
import { usaSpendingService } from '../services/usaSpending';
import { scoreOpportunityForClient } from '../engines/probabilityEngine';

export const ENRICHMENT_QUEUE_NAME = 'opportunity-enrichment';

export interface EnrichmentJobData {
  opportunityId: string;
  consultingFirmId: string;
  jobRecordId: string;
}

export const enrichmentQueue = new Queue<EnrichmentJobData>(ENRICHMENT_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 8000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

export function startEnrichmentWorker(): Worker<EnrichmentJobData> {
  const worker = new Worker<EnrichmentJobData>(
    ENRICHMENT_QUEUE_NAME,
    async (job: Job<EnrichmentJobData>) => {
      const { opportunityId, consultingFirmId } = job.data;

      logger.info('Enrichment job started', { opportunityId, jobId: job.id });

      const opportunity = await prisma.opportunity.findFirst({
        where: { id: opportunityId, consultingFirmId },
        select: {
          id: true,
          naicsCode: true,
          setAsideType: true,
          estimatedValue: true,
          agency: true,
          title: true,
          description: true,
          isEnriched: true,
        },
      });

      if (!opportunity) {
        logger.warn('Opportunity not found for enrichment', { opportunityId });
        return;
      }

      if (opportunity.isEnriched) {
        logger.info('Opportunity already enriched - skipping', { opportunityId });
        return;
      }

      const enrichment = await usaSpendingService.enrichOpportunity({
        naicsCode: opportunity.naicsCode,
        agency: opportunity.agency,
      });

      const recompeteKeywords = ['recompete', 're-compete', 'option year', 'bridge', 're-solicitation', 'follow-on'];
      const titleLower = (opportunity.title + ' ' + (opportunity.description || '')).toLowerCase();
      const recompeteFlag = recompeteKeywords.some((kw) => titleLower.includes(kw));

      if (enrichment.awards.length > 0) {
        await prisma.awardHistory.createMany({
          data: enrichment.awards.slice(0, 50).map((award) => ({
            opportunityId,
            awardingAgency: opportunity.agency,
            recipientName: award.recipientName,
            recipientUei: award.recipientUei,
            awardAmount: award.awardAmount,
            awardDate: award.awardDate ? new Date(award.awardDate) : new Date(),
            baseAndAllOptions: award.baseAndAllOptions,
            naics: opportunity.naicsCode,
            awardType: award.awardType,
            contractNumber: award.contractNumber,
          })),
          skipDuplicates: true,
        });
      }

      // NOTE: isEnriched is intentionally NOT set here. It is flipped to true
      // only in the final update below, after scoring succeeds. If it were set
      // now, a throw during scoring (e.g. all-clients-failed) would, on retry,
      // hit the isEnriched guard above and skip — leaving the opportunity
      // permanently enriched-but-unscored. Re-running enrichment on retry is
      // idempotent (awardHistory uses skipDuplicates).
      await prisma.opportunity.update({
        where: { id: opportunityId },
        data: {
          historicalWinner: enrichment.historicalWinner,
          historicalAvgAward: enrichment.historicalAvgAward,
          historicalAwardCount: enrichment.historicalAwardCount,
          competitionCount: enrichment.competitionCount,
          offersReceived: enrichment.offersReceived,
          extentCompeted: enrichment.extentCompeted,
          incumbentProbability: enrichment.incumbentProbability,
          agencySmallBizRate: enrichment.agencySmallBizRate,
          agencySdvosbRate: enrichment.agencySdvosbRate,
          recompeteFlag,
          isScored: false,
        },
      });

      const clients = await prisma.clientCompany.findMany({
        where: { consultingFirmId, isActive: true },
        select: {
          id: true,
          naicsCodes: true,
          sdvosb: true,
          wosb: true,
          hubzone: true,
          smallBusiness: true,
        },
      });

      let bestProbability = 0;
      let bestExpectedValue = 0;
      let scoredCount = 0;
      let failedCount = 0;

      for (const client of clients) {
        const result = scoreOpportunityForClient({
          opportunityNaics: opportunity.naicsCode,
          opportunityEstimatedValue: opportunity.estimatedValue ? Number(opportunity.estimatedValue) : null,
          opportunityAgency: opportunity.agency,
          clientNaics: client.naicsCodes,
          clientProfile: {
            sdvosb: client.sdvosb,
            wosb: client.wosb,
            hubzone: client.hubzone,
            smallBusiness: client.smallBusiness,
          },
          incumbentProbability: enrichment.incumbentProbability,
          competitionCount: enrichment.competitionCount,
          offersReceived: enrichment.offersReceived,
          agencySdvosbRate: enrichment.agencySdvosbRate,
          historicalDistribution: enrichment.historicalAwardCount > 0
            ? Math.min(enrichment.historicalAwardCount / 1000, 0.8)
            : 0.3,
        });

        // P1-1: skip FAILED computes (no number); throw below if all fail so the
        // job retries instead of persisting a fabricated probabilityScore of 0.
        if (result.status !== 'OK') {
          failedCount++;
          logger.warn('Skipping client; probability compute failed', {
            opportunityId, reason: result.failureReason,
          });
          continue;
        }
        scoredCount++;
        if (result.probability > bestProbability) {
          bestProbability = result.probability;
          bestExpectedValue = result.expectedValue;
        }
      }

      if (scoredCount === 0 && failedCount > 0) {
        throw new Error(
          `Enrichment scoring failed for all ${failedCount} client(s) on opportunity ${opportunityId}; refusing to persist a fabricated score`
        );
      }

      await prisma.opportunity.update({
        where: { id: opportunityId },
        data: {
          isEnriched: true,
          probabilityScore: roundTo(bestProbability, 4),
          expectedValue: bestExpectedValue,
          isScored: true,
        },
      });

      logger.info('Enrichment job complete', {
        opportunityId,
        historicalWinner: enrichment.historicalWinner,
        competitionCount: enrichment.competitionCount,
        incumbentProbability: enrichment.incumbentProbability?.toFixed(3) ?? 'null',
        newProbability: bestProbability.toFixed(4),
      });
    },
    {
      connection: redis,
      concurrency: 3,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error('Enrichment job failed', { jobId: job?.id, error: err.message });
  });

  worker.on('error', (err) => {
    logger.error('Enrichment worker error', { error: err.message });
  });

  logger.info('Enrichment worker started');
  return worker;
}

export async function enqueueEnrichmentJobs(
  consultingFirmId: string,
  jobRecordId: string
): Promise<number> {
  const opportunities = await prisma.opportunity.findMany({
    where: { consultingFirmId, status: 'ACTIVE', isEnriched: false },
    select: { id: true },
    take: 500,
  });

  const jobs = opportunities.map((opp) => ({
    name: 'enrich-opportunity',
    data: { opportunityId: opp.id, consultingFirmId, jobRecordId },
  }));

  if (jobs.length > 0) {
    await enrichmentQueue.addBulk(jobs);
  }

  logger.info('Enrichment jobs enqueued', { consultingFirmId, count: opportunities.length });
  return opportunities.length;
}