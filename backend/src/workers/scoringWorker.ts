// =============================================================
// Scoring Worker — BullMQ
// Tier 1: Win probability scoring for all opportunities
// =============================================================
import { Worker, Queue, Job } from 'bullmq';
import { redis } from '../config/redis';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { roundTo } from '../utils/number';
import { scoreOpportunityForClient, computeDeadlineUrgency, explainFeatures } from '../engines/probabilityEngine';
import { detectIncumbent } from '../engines/incumbentDetector';
import { getDensityScore } from '../engines/competitiveDensity';
import { getAgencyHistoryScore } from '../engines/agencyProfiler';
import { getPublicWinPrior, blendWithPrior } from '../services/whoWins/publicWinPrior';
import { config } from '../config/config';

export const SCORING_QUEUE_NAME = 'opportunity-scoring';

export interface ScoringJobData {
  opportunityId: string;
  consultingFirmId: string;
}

export const scoringQueue = new Queue<ScoringJobData>(SCORING_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 200,
    removeOnFail: 50,
  },
});

export function startScoringWorker(): Worker<ScoringJobData> {
  const worker = new Worker<ScoringJobData>(
    SCORING_QUEUE_NAME,
    async (job: Job<ScoringJobData>) => {
      const { opportunityId, consultingFirmId } = job.data;

      const opportunity = await prisma.opportunity.findFirst({
        where: { id: opportunityId, consultingFirmId },
        select: {
          id: true,
          naicsCode: true,
          estimatedValue: true,
          agency: true,
          incumbentProbability: true,
          incumbentSignalDetected: true,
          competitionCount: true,
          offersReceived: true,
          agencySdvosbRate: true,
          historicalAwardCount: true,
          documentIntelScore: true,
          responseDeadline: true,
          title: true,
          description: true,
          setAsideType: true,
          isScored: true,
        },
      });

      if (!opportunity) {
        logger.warn('Opportunity not found for scoring', { opportunityId });
        return;
      }

      const clients = await prisma.clientCompany.findMany({
        where: { consultingFirmId, isActive: true },
        select: {
          id: true,
          naicsCodes: true,
          sdvosb: true,
          wosb: true,
          hubzone: true,
          smallBusiness: true,
          uei: true,
        },
      });

      if (clients.length === 0) {
        logger.warn('No active clients for scoring', { consultingFirmId });
        return;
      }

      // ── Incumbent detection from text (when USAspending data absent) ──
      let incumbentProb = opportunity.incumbentProbability;
      let incumbentDetected = opportunity.incumbentSignalDetected;
      if (incumbentProb === null) {
        const textForDetection = `${opportunity.title} ${opportunity.description ?? ''}`;
        const incResult = detectIncumbent(textForDetection);
        if (incResult.detected) {
          incumbentProb = incResult.inferredProbability;
          incumbentDetected = true;
        }
      }

      // ── Competitive density (NAICS-normalized bidder count) ──────────
      const densityResult = await getDensityScore(
        opportunity.naicsCode,
        opportunity.offersReceived ?? opportunity.competitionCount ?? null
      );

      // ── Deadline urgency ──────────────────────────────────────────────
      const deadlineUrgency = computeDeadlineUrgency(opportunity.responseDeadline);

      let bestProbability = 0;
      let bestExpectedValue = 0;
      let scoredCount = 0;
      let failedCount = 0;
      // Breakdown for the winning client — persisted so the UI/export can
      // explain WHY an opportunity scored what it did (top factors, NAICS signal).
      let bestBreakdown: Record<string, unknown> | null = null;

      for (const client of clients) {
        // ── Agency history score per client type ────────────────────────
        const agencyHistScore = await getAgencyHistoryScore(opportunity.agency, {
          sdvosb: client.sdvosb,
          wosb: client.wosb,
          hubzone: client.hubzone,
          smallBusiness: client.smallBusiness,
        });

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
          incumbentProbability: incumbentProb,
          competitionCount: opportunity.competitionCount,
          offersReceived: opportunity.offersReceived,
          agencySdvosbRate: opportunity.agencySdvosbRate,
          // null, not a 0.3 stand-in: substituting a constant here hid the
          // absence from the engine, which then scored it as if it were a real
          // measurement. Passing null lets the absent-feature renormalization
          // drop the factor's weight instead.
          historicalDistribution: opportunity.historicalAwardCount
            ? Math.min(opportunity.historicalAwardCount / 1000, 0.8)
            : null,
          documentAlignmentScore: opportunity.documentIntelScore,
          agencyHistoryScore: agencyHistScore,
          deadlineUrgencyScore: deadlineUrgency,
          densityScore: densityResult.score,
        });

        // P1-1: a FAILED compute carries no number — skip it. If every client
        // fails we throw (below) so BullMQ retries, rather than persisting a
        // fabricated probabilityScore of 0.
        if (result.status !== 'OK') {
          failedCount++;
          logger.warn('Skipping client; probability compute failed', {
            opportunityId, reason: result.failureReason,
          });
          continue;
        }
        scoredCount++;

        // ── Who-Wins public-label win prior (docs/WHO_WINS_MODEL.md) ─────
        // Flag-gated blend in log-odds space: the prior (calibrated on public
        // award outcomes) sets the LEVEL; the heuristic perturbs within it.
        // Prior unavailable (no ACTIVE model / no segment) ⇒ untouched score.
        let finalProbability = result.probability;
        let priorBreakdown: Record<string, unknown> | null = null;
        if (config.scoring.whoWinsPriorEnabled) {
          const prior = await getPublicWinPrior({
            opportunityNaics: opportunity.naicsCode,
            opportunitySetAside: opportunity.setAsideType,
            opportunityAgencyName: opportunity.agency,
            opportunityEstimatedValue: opportunity.estimatedValue ? Number(opportunity.estimatedValue) : null,
            clientUei: client.uei,
          });
          if (prior) {
            finalProbability = blendWithPrior(
              result.probability, prior.pWin, config.scoring.whoWinsPriorWeight,
            );
            priorBreakdown = {
              pWin: roundTo(prior.pWin, 4),
              pBase: roundTo(prior.pBase, 4),
              adjustmentOdds: roundTo(prior.adjustmentOdds, 3),
              expectedOffers: prior.expectedOffers !== null ? roundTo(prior.expectedOffers, 1) : null,
              segmentLevel: prior.segmentLevel,
              segmentAwardCount: prior.segmentAwardCount,
              modelVersion: prior.modelVersion,
              heuristicProbability: roundTo(result.probability, 4),
              weight: config.scoring.whoWinsPriorWeight,
            };
          }
        }

        if (finalProbability > bestProbability) {
          bestProbability = finalProbability;
          bestExpectedValue = opportunity.estimatedValue
            ? finalProbability * Number(opportunity.estimatedValue)
            : 0;
          bestBreakdown = {
            factorContributions: explainFeatures(result.features),
            formula: { equation: 'P(win) = 1 / (1 + e^-(6Z - 3))', rawZ: roundTo(result.rawScore, 4) },
            rawScore: roundTo(result.rawScore, 4),
            probability: roundTo(finalProbability, 4),
            naicsSignal: result.naicsSignal,
            matchedClientId: client.id,
            generatedAt: new Date().toISOString(),
            ...(priorBreakdown ? { marketBasePrior: priorBreakdown } : {}),
          };
        }
      }

      if (scoredCount === 0 && failedCount > 0) {
        throw new Error(
          `Scoring failed for all ${failedCount} client(s) on opportunity ${opportunityId}; refusing to persist a fabricated score`
        );
      }

      await prisma.opportunity.update({
        where: { id: opportunityId },
        data: {
          probabilityScore: roundTo(bestProbability, 4),
          expectedValue: bestExpectedValue,
          isScored: true,
          deadlineUrgencyScore: deadlineUrgency,
          densityRatio: densityResult.densityRatio,
          ...(bestBreakdown ? { scoreBreakdown: bestBreakdown as any } : {}),
          ...(incumbentProb !== opportunity.incumbentProbability ? {
            incumbentProbability: incumbentProb,
            incumbentSignalDetected: incumbentDetected,
          } : {}),
        },
      });

      logger.debug('Opportunity scored', {
        opportunityId,
        probability: bestProbability.toFixed(4),
      });
    },
    {
      connection: redis,
      concurrency: 10,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error('Scoring job failed', { jobId: job?.id, error: err.message });
  });

  worker.on('error', (err) => {
    logger.error('Scoring worker error', { error: err.message });
  });

  logger.info('Scoring worker started');
  return worker;
}

/**
 * Enqueue all unscored opportunities for a firm.
 * Called after ingest and after enrichment completes.
 * Skips silently if no active clients exist — scoring requires client profiles.
 */
export async function enqueueAllOpportunitiesForScoring(
  consultingFirmId: string
): Promise<number> {
  // Check for clients first — no point queuing thousands of jobs that will each
  // hit the "No active clients" early-exit path and flood the logs.
  const clientCount = await prisma.clientCompany.count({
    where: { consultingFirmId, isActive: true },
  });

  if (clientCount === 0) {
    logger.info('Scoring skipped — no active clients yet', { consultingFirmId });
    return 0;
  }

  const opportunities = await prisma.opportunity.findMany({
    where: { consultingFirmId, status: 'ACTIVE', isScored: false },
    select: { id: true },
    take: 500,
  });

  const jobs = opportunities.map((opp) => ({
    name: 'score-opportunity',
    data: { opportunityId: opp.id, consultingFirmId },
  }));

  if (jobs.length > 0) {
    await scoringQueue.addBulk(jobs);
  }

  logger.info('Scoring jobs enqueued', { consultingFirmId, count: opportunities.length });
  return opportunities.length;
}