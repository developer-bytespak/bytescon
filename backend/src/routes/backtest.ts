// =============================================================
// Backtest admin routes — model calibration against historical wins
// Admin-only. Backtest data is NOT tenant-scoped (industry-wide
// federal contract data), but the run is audit-attributed to the
// firm that triggered it.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { ValidationError, NotFoundError } from '../utils/errors'
import { runBacktest } from '../services/backtest/historicalBacktest'
import {
  refreshCalibrationCache,
  getActiveCalibration,
} from '../services/calibrationCache'
import { deriveCalibrationStatus } from '../services/calibrationStatus'
import { config } from '../config/config'
import { logger } from '../utils/logger'

const router = Router()
router.use(authenticateJWT, enforceTenantScope, requireRole('ADMIN'))

/**
 * POST /api/admin/backtest/run
 * Body: { sampleSize?: number, yearsBack?: number }
 * Synchronous — holds the connection while the backtest runs (~5–15 min
 * for 1k samples). For larger runs, switch to a BullMQ job in v2.
 */
router.post('/run', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const sampleSize = Math.min(2000, Math.max(50, parseInt(req.body?.sampleSize) || 1000))
    const yearsBack = Math.min(10, Math.max(1, parseInt(req.body?.yearsBack) || 5))
    const methodVersionRaw = String(req.body?.methodVersion ?? 'v2-permutation')
    const methodVersion =
      methodVersionRaw === 'v1-synthetic' || methodVersionRaw === 'v2-permutation'
        ? methodVersionRaw
        : 'v2-permutation'
    // Cutoff defaults to null (full sample). Accept ISO string or YYYY-MM-DD.
    let cutoffDate: Date | null = null
    if (req.body?.cutoffDate) {
      const parsed = new Date(req.body.cutoffDate)
      if (!isNaN(parsed.getTime())) cutoffDate = parsed
    }

    const consultingFirmId = getTenantId(req)
    const userId = req.user?.userId

    logger.info('Backtest run requested', {
      consultingFirmId, userId, sampleSize, yearsBack, methodVersion, cutoffDate,
    })

    // Run synchronously — caller waits. Long-running but acceptable for MVP.
    res.setTimeout?.(30 * 60 * 1000) // 30 min
    const runId = await runBacktest({
      consultingFirmId,
      triggeredBy: userId,
      sampleSize,
      yearsBack,
      methodVersion,
      cutoffDate,
    })

    res.json({ success: true, data: { runId } })
  } catch (err: any) {
    next(err)
  }
})

/**
 * GET /api/admin/backtest/runs
 * List recent backtest runs (most recent first).
 */
router.get('/runs', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const runs = await prisma.backtestRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: 25,
      select: {
        id: true,
        status: true,
        sampleSize: true,
        yearsBack: true,
        startedAt: true,
        completedAt: true,
        predictionCount: true,
        brierScore: true,
        meanProbability: true,
        errorMessage: true,
        methodVersion: true,
        cutoffDate: true,
        logLoss: true,
        rocAuc: true,
        ece: true,
        brierReliability: true,
        brierResolution: true,
        brierUncertainty: true,
      },
    })
    res.json({ success: true, data: runs })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/admin/backtest/runs/:id
 * Detail view: aggregate metrics + top mispredictions.
 */
router.get('/runs/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const run = await prisma.backtestRun.findUnique({
      where: { id: req.params.id },
    })
    if (!run) throw new NotFoundError('Backtest run not found')

    // Top mispredictions = winners we gave LOW probability to.
    // For winners-only sample, the most informative cases are the lowest
    // predicted probabilities — i.e. winners we'd have told a firm not to bid.
    const mispredictions = await prisma.backtestPrediction.findMany({
      where: { runId: run.id },
      orderBy: { predictedProbability: 'asc' },
      take: 20,
      select: {
        contractId: true,
        agency: true,
        naicsCode: true,
        awardAmount: true,
        awardDate: true,
        recipientName: true,
        predictedProbability: true,
        syntheticClientNaics: true,
        syntheticSdvosb: true,
        syntheticWosb: true,
        syntheticHubzone: true,
        syntheticSmallBiz: true,
      },
    })

    res.json({ success: true, data: { run, mispredictions } })
  } catch (err) {
    next(err)
  }
})

/**
 * POST /api/admin/backtest/calibration/refresh
 * Re-reads the most-recent v2-permutation curves into the in-process cache.
 * Use after running a fresh v2 backtest so the new curve takes effect
 * without a backend restart.
 */
router.post('/calibration/refresh', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const result = await refreshCalibrationCache()
    res.json({
      success: true,
      data: {
        active: result.curve != null || result.platt != null,
        activeMethod: result.method,
        runId: result.runId,
        fittedAt: result.fittedAt,
        isotonic: result.curve
          ? {
              sampleSize: result.curve.sampleSize,
              preBrier: result.curve.preBrier,
              postBrier: result.curve.postBrier,
            }
          : null,
        platt: result.platt
          ? {
              A: result.platt.A,
              B: result.platt.B,
              preBrier: result.platt.preBrier,
              postBrier: result.platt.postBrier,
            }
          : null,
      },
    })
  } catch (err) {
    next(err)
  }
})

/**
 * GET /api/admin/backtest/calibration/status
 * What curves are currently active (if any) and which method is selected.
 */
router.get('/calibration/status', async (_req: AuthenticatedRequest, res: Response) => {
  const result = getActiveCalibration()
  const flagOn =
    process.env.ENABLE_PROBABILITY_CALIBRATION === '1' ||
    process.env.ENABLE_PROBABILITY_CALIBRATION?.toLowerCase() === 'true'
  // Section 4 #6: distinguish a curve that is merely FITTED (computed and cached)
  // from one that is APPLIED (actually adjusting production win-probabilities).
  // A curve only affects scores when ENABLE_PROBABILITY_CALIBRATION is on, so
  // reporting "active" for a fitted-but-unapplied curve was misleading.
  const { fitted, applied } = deriveCalibrationStatus(result.curve != null, result.platt != null, flagOn)
  res.json({
    success: true,
    data: {
      // `active` retained for backward compatibility, now meaning "applied to
      // scores" (fitted AND flag on) rather than "a curve exists".
      active: applied,
      fitted,
      applied,
      activeMethod: result.method,
      flagEnabled: flagOn,
      runId: result.runId,
      fittedAt: result.fittedAt,
      isotonic: result.curve
        ? {
            sampleSize: result.curve.sampleSize,
            preBrier: result.curve.preBrier,
            postBrier: result.curve.postBrier,
          }
        : null,
      platt: result.platt
        ? {
            A: result.platt.A,
            B: result.platt.B,
            preBrier: result.platt.preBrier,
            postBrier: result.platt.postBrier,
          }
        : null,
    },
  })
})

/**
 * GET /api/admin/backtest/who-wins/status
 * Who-Wins public-label prior: active/candidate model, its OUT-OF-TIME eval
 * report (the review artifact gating WHO_WINS_PRIOR_ENABLED), training-corpus
 * size, and prior coverage. Read-only — the build runs via
 * prisma/scripts/buildWhoWins.ts on the droplet.
 */
router.get('/who-wins/status', async (_req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const [active, latest, trainingAwards, offersKnown] = await Promise.all([
      prisma.whoWinsModel.findFirst({ where: { status: 'ACTIVE' } }),
      prisma.whoWinsModel.findFirst({ orderBy: { trainedAt: 'desc' } }),
      prisma.publicAwardTraining.count(),
      prisma.publicAwardTraining.count({ where: { offersReceived: { not: null } } }),
    ])
    const priorSegments = active
      ? await prisma.publicWinPrior.count({ where: { modelVersion: active.version } })
      : 0

    const shape = (m: typeof active) => m && {
      version: m.version,
      status: m.status,
      trainedAt: m.trainedAt,
      trainingGroups: m.trainingGroups,
      coefficients: m.coefficients,
      evalReport: m.evalReport,
    }
    res.json({
      success: true,
      data: {
        enabled: config.scoring.whoWinsPriorEnabled,
        blendWeight: config.scoring.whoWinsPriorWeight,
        activeModel: shape(active),
        latestModel: latest && latest.version !== active?.version ? shape(latest) : null,
        corpus: { trainingAwards, offersKnown, priorSegments },
      },
    })
  } catch (err) {
    next(err)
  }
})

export default router
