// =============================================================
// Historical Backtest Service — calibration of the 9-factor
// probability engine against real federal contract winners.
//
// Two methodologies coexist:
//
//   v1-synthetic   — for each award, build 1 positive (winner profile vs.
//                    its own award) + K-1 negatives by deliberately
//                    mutating the winner profile (wrong NAICS, inverted
//                    set-aside, etc.). Tests the model's ability to
//                    distinguish good matches from broken ones; tends to
//                    overstate model quality and gets noisy when layered
//                    boosts (e.g. set-aside) interact with the mutations.
//                    Retained for back-compat of historical runs.
//
//   v2-permutation — for each award X, build 1 positive (winner_X profile
//                    vs. opportunity_X) + K-1 negatives by pairing
//                    winner_X's profile against K-1 RANDOMLY-SELECTED
//                    OTHER awards in the sample. The "negatives" use real
//                    firm profiles against real (different) opportunities
//                    — standard practice in IR/recsys evaluation. Mild
//                    false-negative noise (winner_X could in principle
//                    have won some Y) is the accepted tradeoff for
//                    realistic distribution of feature values.
//
// Both methods use the same scoring path — no historical enrichment
// passed in, to keep the evaluation leak-free.
// =============================================================
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { usaSpendingService } from '../usaSpending'
import { lookupEntityByUEI, lookupEntityByName } from '../samEntityApi'
import { scoreOpportunityForClient } from '../../engines/probabilityEngine'
import {
  logLoss,
  rocAuc,
  expectedCalibrationError,
  brierDecomposition,
  type LabeledPrediction,
} from './metrics'
import { fitIsotonic } from '../isotonicCalibration'
import { fitPlatt } from '../plattCalibration'

export type BacktestMethod = 'v1-synthetic' | 'v2-permutation'

export interface BacktestRunOpts {
  consultingFirmId: string
  triggeredBy?: string
  sampleSize?: number              // default 1000 (number of awards sampled)
  yearsBack?: number               // default 5
  predictionsPerAward?: number     // default 4 (1 positive + 3 negatives)
  methodVersion?: BacktestMethod   // default 'v2-permutation'
  /** Phase 1d: evaluate only awards on/after this date. Earlier awards
   *  are still sampled (and may be used as permutation partners), but
   *  none are scored as positives. Use to compare time windows or to
   *  reserve a clean holdout for calibration fitting. */
  cutoffDate?: Date | string | null
}

interface CalibrationBin {
  binMin: number
  binMax: number
  count: number
  meanPred: number
  observedRate: number
}

interface SyntheticProfile {
  naics: string[]
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBiz: boolean
}

/** Produces up to `count` deliberately-mismatched profiles for a given award. */
export function buildSyntheticNegatives(
  awardNaics: string,
  winner: SyntheticProfile,
  count: number,
): SyntheticProfile[] {
  if (count <= 0) return []

  const currentSector = (awardNaics || '00').slice(0, 2)
  // NAICS sectors deliberately distant from most winners — the
  // overlap factor scores 0 for cross-sector mismatches.
  const distantSectors = ['11', '21', '52', '71', '72', '92']
  const distantSector = distantSectors.find((s) => s !== currentSector) ?? '11'
  const wrongNaics = `${distantSector}9999`

  const variants: SyntheticProfile[] = [
    // Variant 1 — wrong NAICS sector entirely. Should score very low.
    {
      naics: [wrongNaics],
      sdvosb: winner.sdvosb,
      wosb: winner.wosb,
      hubzone: winner.hubzone,
      smallBiz: winner.smallBiz,
    },
    // Variant 2 — right NAICS, but wrong size class. Federal small-biz
    // set-asides exclude large business; this should score moderately
    // (NAICS match) but be excluded by award-size + agency factors.
    {
      naics: [awardNaics],
      sdvosb: false,
      wosb: false,
      hubzone: false,
      smallBiz: !winner.smallBiz,
    },
    // Variant 3 — right NAICS + size, wrong set-aside flags inverted.
    // Realistic close-but-no-cigar bidder — should score in mid-range.
    {
      naics: [awardNaics],
      sdvosb: !winner.sdvosb,
      wosb: !winner.wosb,
      hubzone: !winner.hubzone,
      smallBiz: winner.smallBiz,
    },
  ]

  return variants.slice(0, count)
}

export interface AwardSample {
  contractId: string
  naicsCode: string
  agency: string
  awardAmount: number
  awardDate: string
  recipientName: string
  recipientUei: string | null
  setAside: string | null
}

/** Row shape returned by the local-corpus sampling query. */
interface CorpusAwardRow {
  awardKey: string
  naicsCode: string
  agencyName: string | null
  setAsideCode: string | null
  recipientUei: string | null
  recipientName: string | null
  obligatedAmount: unknown // Prisma Decimal — convert via Number()
  actionDate: Date | string
}

/** Exported for testability. */
export function mapCorpusRowToAwardSample(row: CorpusAwardRow): AwardSample {
  return {
    contractId: row.awardKey,
    naicsCode: row.naicsCode,
    agency: row.agencyName || 'Unknown',
    awardAmount: Number(row.obligatedAmount) || 0,
    awardDate:
      row.actionDate instanceof Date
        ? row.actionDate.toISOString().slice(0, 10)
        : String(row.actionDate || ''),
    recipientName: row.recipientName || 'Unknown',
    recipientUei: row.recipientUei || null,
    setAside: row.setAsideCode || null,
  }
}

/**
 * Sample awards from the local who-wins training corpus
 * (public_award_training, ~2.5M competed awards) instead of the live
 * USAspending search API. The live API's unfiltered 5-year sort is heavy
 * enough that USAspending's own gateway 502s it at ~60s regardless of our
 * client timeout, and its Award-Amount-desc ordering samples only the
 * largest contracts anyway. Local sampling is uniform-random, immune to
 * throttling, and returns in seconds (top-N heapsort, ~2.7s at 2.3M rows).
 */
async function sampleAwardsFromLocalCorpus(
  yearsBack: number,
  sampleSize: number,
): Promise<AwardSample[]> {
  const startDate = new Date(Date.now() - yearsBack * 365 * 24 * 60 * 60 * 1000)
  const rows = await prisma.$queryRaw<CorpusAwardRow[]>`
    SELECT "awardKey", "naicsCode", "agencyName", "setAsideCode",
           "recipientUei", "recipientName", "obligatedAmount", "actionDate"
    FROM public_award_training
    WHERE "actionDate" >= ${startDate}
      AND "agencyName" IS NOT NULL
      AND "naicsCode" <> ''
    ORDER BY random()
    LIMIT ${sampleSize}
  `
  return rows.map(mapCorpusRowToAwardSample)
}

/**
 * Pick K-1 random partner indices distinct from `selfIdx` and from each other.
 * Falls back gracefully when sample is too small.
 *
 * Exported for testability.
 */
export function pickPermutationPartners(
  sampleSize: number,
  selfIdx: number,
  k: number,
  rng: () => number = Math.random,
): number[] {
  if (sampleSize <= 1 || k <= 0) return []
  const pool: number[] = []
  for (let i = 0; i < sampleSize; i++) if (i !== selfIdx) pool.push(i)
  // Fisher-Yates partial shuffle — pick k items from pool without replacement.
  const take = Math.min(k, pool.length)
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rng() * (pool.length - i))
    const tmp = pool[i]
    pool[i] = pool[j]
    pool[j] = tmp
  }
  return pool.slice(0, take)
}

/**
 * Run a backtest end-to-end. Synchronous (caller holds the connection
 * for ~5–15 minutes depending on sample size). Caller is the admin
 * route handler.
 */
export async function runBacktest(opts: BacktestRunOpts) {
  const sampleSize = opts.sampleSize ?? 1000
  const yearsBack = opts.yearsBack ?? 5
  const K = Math.max(1, Math.min(10, opts.predictionsPerAward ?? 4))
  const methodVersion: BacktestMethod = opts.methodVersion ?? 'v2-permutation'
  const cutoffDate = opts.cutoffDate ? new Date(opts.cutoffDate) : null

  const run = await prisma.backtestRun.create({
    data: {
      consultingFirmId: opts.consultingFirmId,
      triggeredBy: opts.triggeredBy,
      status: 'RUNNING',
      sampleSize,
      yearsBack,
      methodVersion,
      cutoffDate,
    },
  })

  logger.info('Backtest run started', { runId: run.id, sampleSize, yearsBack, K, methodVersion, cutoffDate })

  try {
    // 1. Sample awarded contracts — local who-wins corpus first; live
    //    USAspending search only as a fallback for deployments that never
    //    ran the corpus ingest.
    let awards: AwardSample[] = []
    try {
      awards = await sampleAwardsFromLocalCorpus(yearsBack, sampleSize)
      logger.info('Backtest awards sampled from local corpus', {
        runId: run.id,
        count: awards.length,
      })
    } catch (err) {
      logger.warn('Local corpus sampling failed — falling back to USAspending live search', {
        runId: run.id,
        error: (err as Error).message,
      })
    }
    if (awards.length < sampleSize) {
      logger.info('Local corpus could not fill the sample — trying USAspending live search', {
        runId: run.id,
        fromCorpus: awards.length,
        requested: sampleSize,
      })
      const live = await usaSpendingService.sampleAwardedContracts({
        yearsBack,
        sampleSize,
      })
      if (live.length > awards.length) awards = live
    }
    logger.info('Backtest awards sampled', { runId: run.id, count: awards.length })

    if (awards.length === 0) {
      throw new Error(
        'No awards available to sample — the local corpus is empty for this window and USAspending returned nothing (throttled or degraded). Retry in a few minutes.',
      )
    }

    // 2. Resolve winner profile for every sampled award up front. We need
    //    these for the positive AND (in v2) as candidate profiles paired
    //    against other awards' opportunities.
    const winnerProfiles: SyntheticProfile[] = await Promise.all(
      awards.map(async (award) => {
        let winner: SyntheticProfile = {
          naics: [award.naicsCode],
          sdvosb: false,
          wosb: false,
          hubzone: false,
          smallBiz: true,
        }
        try {
          const entity = award.recipientUei
            ? await lookupEntityByUEI(award.recipientUei)
            : await lookupEntityByName(award.recipientName)
          if (entity) {
            winner = {
              naics: entity.naicsCodes && entity.naicsCodes.length > 0
                ? entity.naicsCodes
                : [award.naicsCode],
              sdvosb: !!entity.sdvosb,
              wosb: !!entity.wosb,
              hubzone: !!entity.hubzone,
              smallBiz: !!entity.smallBusiness,
            }
          }
        } catch {
          // Lookup miss — fall back to NAICS-only profile.
        }
        return winner
      }),
    )

    // 3. Score every prediction. Each award contributes K predictions:
    //    1 positive + K-1 negatives, built per methodVersion.
    interface Prediction {
      probability: number
      features: any
      rawScore: number
      record: AwardSample
      synthetic: SyntheticProfile
      observedOutcome: number
      countedInMetrics: boolean // false for awards before cutoffDate
    }
    const predictions: Prediction[] = []

    for (let i = 0; i < awards.length; i++) {
      const award = awards[i]
      const winner = winnerProfiles[i]
      const awardDate = award.awardDate ? new Date(award.awardDate) : null
      const includedForMetrics =
        !cutoffDate || (awardDate != null && awardDate >= cutoffDate)

      // Build the K profiles to score for THIS opportunity.
      // Positive is always winner_i scored against opportunity_i.
      // Negatives differ by method:
      //   v1: mutated copies of winner_i (synthetic mismatches).
      //   v2: winner_j profiles from K-1 other sampled awards.
      let negatives: SyntheticProfile[]
      if (methodVersion === 'v1-synthetic') {
        negatives = buildSyntheticNegatives(award.naicsCode, winner, K - 1)
      } else {
        const partnerIdxs = pickPermutationPartners(awards.length, i, K - 1)
        negatives = partnerIdxs.map((j) => winnerProfiles[j])
      }

      const profiles: Array<{ profile: SyntheticProfile; observed: number }> = [
        { profile: winner, observed: 1 },
        ...negatives.map((n) => ({ profile: n, observed: 0 })),
      ]

      for (const { profile, observed } of profiles) {
        const result = scoreOpportunityForClient({
          opportunityNaics: award.naicsCode,
          opportunityEstimatedValue: award.awardAmount,
          opportunityAgency: award.agency,
          clientNaics: profile.naics,
          clientProfile: {
            sdvosb: profile.sdvosb,
            wosb: profile.wosb,
            hubzone: profile.hubzone,
            smallBusiness: profile.smallBiz,
          },
          // No historical-derived signals — those would create time leakage.
        })

        // P1-1: a FAILED compute carries no number — exclude it from the
        // backtest rather than feeding a fabricated score into calibration
        // metrics (which would corrupt ECE/Brier/AUC).
        if (result.status !== 'OK') continue

        predictions.push({
          probability: result.probability,
          features: result.features,
          rawScore: result.rawScore,
          record: award,
          synthetic: profile,
          observedOutcome: observed,
          countedInMetrics: includedForMetrics,
        })
      }

      if ((i + 1) % 50 === 0) {
        logger.info('Backtest progress', {
          runId: run.id,
          awardsScored: i + 1,
          totalAwards: awards.length,
          predictionsBuilt: predictions.length,
        })
      }
    }

    // 4. Persist predictions in batches (full set, including pre-cutoff).
    const BATCH = 200
    for (let i = 0; i < predictions.length; i += BATCH) {
      const slice = predictions.slice(i, i + BATCH)
      await prisma.backtestPrediction.createMany({
        data: slice.map((p) => ({
          runId: run.id,
          contractId: p.record.contractId,
          agency: p.record.agency,
          naicsCode: p.record.naicsCode,
          awardAmount: p.record.awardAmount,
          awardDate: new Date(p.record.awardDate || Date.now()),
          recipientName: p.record.recipientName,
          recipientUei: p.record.recipientUei,
          syntheticClientNaics: p.synthetic.naics,
          syntheticSdvosb: p.synthetic.sdvosb,
          syntheticWosb: p.synthetic.wosb,
          syntheticHubzone: p.synthetic.hubzone,
          syntheticSmallBiz: p.synthetic.smallBiz,
          predictedProbability: p.probability,
          rawScore: p.rawScore,
          features: p.features as any,
          observedOutcome: p.observedOutcome,
        })),
      })
    }

    // 5. Aggregate metrics — ONLY over predictions in scope of cutoff.
    const scopedPredictions = predictions.filter((p) => p.countedInMetrics)
    const labeled: LabeledPrediction[] = scopedPredictions.map((p) => ({
      predicted: p.probability,
      observed: p.observedOutcome,
    }))

    const meanProbability = labeled.length
      ? labeled.reduce((a, p) => a + p.predicted, 0) / labeled.length
      : 0
    const decomp = brierDecomposition(labeled)
    const ece = expectedCalibrationError(labeled)
    const ll = logLoss(labeled)
    const auc = rocAuc(labeled)

    // 6. Calibration bins — observed win rate per predicted-prob decile.
    //    Computed on the in-scope sample for consistency with aggregate metrics.
    const calibrationBins: CalibrationBin[] = []
    for (let b = 0; b < 10; b++) {
      const min = b * 0.1
      const max = (b + 1) * 0.1
      const inBin = scopedPredictions.filter(
        (p) => p.probability >= min && p.probability < max + (b === 9 ? 0.0001 : 0),
      )
      if (inBin.length === 0) {
        calibrationBins.push({ binMin: min, binMax: max, count: 0, meanPred: 0, observedRate: 0 })
        continue
      }
      const meanPred = inBin.reduce((a, p) => a + p.probability, 0) / inBin.length
      const observedRate =
        inBin.reduce((a, p) => a + p.observedOutcome, 0) / inBin.length
      calibrationBins.push({
        binMin: min,
        binMax: max,
        count: inBin.length,
        meanPred,
        observedRate,
      })
    }

    // 7. Per-feature mean across WINNERS in scope only (interpretable as
    //    "average factor profile of an actual winner"). Negatives diluted
    //    out by construction.
    const winnerPredictions = scopedPredictions.filter((p) => p.observedOutcome === 1)
    const factorMeans: Record<string, number> = {}
    if (winnerPredictions.length > 0) {
      const featureKeys = Object.keys(winnerPredictions[0].features)
      for (const key of featureKeys) {
        const sum = winnerPredictions.reduce((a, p) => a + (p.features[key] || 0), 0)
        factorMeans[key] = sum / winnerPredictions.length
      }
    }

    // 8. Fit calibration curves (only for v2-permutation runs — v1 synthetic
    //    distribution is biased; curves fitted on it would miscalibrate production).
    //    Both isotonic and Platt are computed so the operator can compare
    //    preBrier/postBrier and pick the winner via CALIBRATION_METHOD env var.
    const calibrationCurve =
      methodVersion === 'v2-permutation' ? fitIsotonic(labeled) : null
    const plattParams =
      methodVersion === 'v2-permutation' ? fitPlatt(labeled) : null

    // 9. Write run summary
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETE',
        completedAt: new Date(),
        predictionCount: scopedPredictions.length,
        brierScore: decomp.brier,
        meanProbability,
        calibrationBins: calibrationBins as any,
        factorMeans: factorMeans as any,
        logLoss: ll,
        rocAuc: auc,
        ece,
        brierReliability: decomp.reliability,
        brierResolution: decomp.resolution,
        brierUncertainty: decomp.uncertainty,
        calibrationCurve: calibrationCurve as any,
        plattA: plattParams?.A ?? null,
        plattB: plattParams?.B ?? null,
        plattPreBrier: plattParams?.preBrier ?? null,
        plattPostBrier: plattParams?.postBrier ?? null,
      },
    })

    logger.info('Backtest run complete', {
      runId: run.id,
      methodVersion,
      awards: awards.length,
      predictions: scopedPredictions.length,
      droppedByCutoff: predictions.length - scopedPredictions.length,
      positives: winnerPredictions.length,
      brier: decomp.brier.toFixed(4),
      reliability: decomp.reliability.toFixed(4),
      resolution: decomp.resolution.toFixed(4),
      uncertainty: decomp.uncertainty.toFixed(4),
      logLoss: ll.toFixed(4),
      auc: auc?.toFixed(4) ?? 'n/a',
      ece: ece.toFixed(4),
      meanProb: meanProbability.toFixed(3),
      isotonicFitted: calibrationCurve != null,
      isotonicBrierImprovement: calibrationCurve
        ? (calibrationCurve.preBrier - calibrationCurve.postBrier).toFixed(4)
        : 'n/a',
      plattFitted: plattParams != null,
      plattA: plattParams?.A.toFixed(4) ?? 'n/a',
      plattB: plattParams?.B.toFixed(4) ?? 'n/a',
      plattBrierImprovement: plattParams
        ? (plattParams.preBrier - plattParams.postBrier).toFixed(4)
        : 'n/a',
    })

    return run.id
  } catch (err) {
    const msg = (err as Error).message
    logger.error('Backtest run failed', { runId: run.id, error: msg })
    await prisma.backtestRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', completedAt: new Date(), errorMessage: msg },
    })
    throw err
  }
}
