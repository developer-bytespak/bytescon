// =============================================================
// Calibration cache — loads the most-recent curve at boot and
// applies it to raw probabilities when ENABLE_PROBABILITY_CALIBRATION
// is enabled. Refresh on demand via POST /api/admin/backtest/calibration/refresh.
//
// Two methods are supported and stored per BacktestRun:
//   isotonic  — PAV step function (default, better for large samples)
//   platt     — parametric sigmoid σ(A·logit(p) + B) (better for small samples)
//
// Select via CALIBRATION_METHOD=isotonic|platt (default: isotonic).
//
// Why in-process (not per-request DB hit): the curve is small (~50 KB
// JSON) and applied on every probability computation; DB round-trips
// per scoring call would dominate latency.
//
// Eligibility: only v2-permutation runs with COMPLETE status.
// v1-synthetic curves are excluded — biased negative distributions
// would miscalibrate real production scores.
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { applyIsotonic, type IsotonicCurve } from './isotonicCalibration'
import { applyPlatt, type PlattParams } from './plattCalibration'

export type CalibrationMethod = 'isotonic' | 'platt'

interface CachedCalibration {
  runId: string | null
  fittedAt: string | null
  method: CalibrationMethod
  // Isotonic
  curve: IsotonicCurve | null
  // Platt
  platt: PlattParams | null
}

let cached: CachedCalibration = {
  runId: null,
  fittedAt: null,
  method: 'isotonic',
  curve: null,
  platt: null,
}

function flagEnabled(name: string, defaultValue = false): boolean {
  const raw = process.env[name]
  if (raw === undefined) return defaultValue
  return raw === '1' || raw.toLowerCase() === 'true'
}

function activeMethod(): CalibrationMethod {
  const raw = (process.env.CALIBRATION_METHOD ?? 'isotonic').toLowerCase()
  return raw === 'platt' ? 'platt' : 'isotonic'
}

/**
 * Re-read the most-recent v2-permutation COMPLETE run, replacing the
 * in-memory cache with both its isotonic curve and Platt params.
 * Idempotent — safe to call repeatedly.
 */
export async function refreshCalibrationCache(): Promise<CachedCalibration> {
  try {
    const run = await prisma.backtestRun.findFirst({
      where: {
        methodVersion: 'v2-permutation',
        status: 'COMPLETE',
        calibrationCurve: { not: null as any },
      },
      orderBy: { completedAt: 'desc' },
      select: {
        id: true,
        calibrationCurve: true,
        plattA: true,
        plattB: true,
        plattPreBrier: true,
        plattPostBrier: true,
        completedAt: true,
      },
    })

    if (!run || !run.calibrationCurve) {
      cached = { runId: null, fittedAt: null, method: activeMethod(), curve: null, platt: null }
      logger.info('Calibration cache refresh: no eligible curve found')
      return cached
    }

    const curve = run.calibrationCurve as unknown as IsotonicCurve

    // Reconstitute PlattParams from stored scalar fields (not JSON).
    const platt: PlattParams | null =
      run.plattA != null && run.plattB != null
        ? {
            A: run.plattA,
            B: run.plattB,
            preBrier: run.plattPreBrier ?? 0,
            postBrier: run.plattPostBrier ?? 0,
            fittedAt: curve.fittedAt ?? run.completedAt?.toISOString() ?? '',
            sampleSize: curve.sampleSize,
          }
        : null

    const method = activeMethod()
    cached = {
      runId: run.id,
      fittedAt: curve.fittedAt ?? run.completedAt?.toISOString() ?? null,
      method,
      curve,
      platt,
    }

    logger.info('Calibration cache refreshed', {
      runId: run.id,
      method,
      fittedAt: cached.fittedAt,
      isotonicSampleSize: curve.sampleSize,
      isotonicPreBrier: curve.preBrier?.toFixed(4),
      isotonicPostBrier: curve.postBrier?.toFixed(4),
      plattA: platt?.A.toFixed(4) ?? 'n/a',
      plattB: platt?.B.toFixed(4) ?? 'n/a',
      plattPostBrier: platt?.postBrier.toFixed(4) ?? 'n/a',
    })

    // Surface the safety-gate decision once at load (not on the hot path).
    const willApply =
      method === 'platt'
        ? curveImproves(platt?.preBrier, platt?.postBrier)
        : curveImproves(curve.preBrier, curve.postBrier)
    if (!willApply) {
      logger.warn('Calibration curve loaded but will NOT be applied — no Brier improvement over baseline; raw probabilities used', {
        runId: run.id,
        method,
      })
    }
    return cached
  } catch (err) {
    logger.error('Calibration cache refresh failed', { error: (err as Error).message })
    return cached
  }
}

/** Active curve summary — exposed by GET /api/admin/backtest/calibration/status. */
export function getActiveCalibration(): CachedCalibration {
  return cached
}

/**
 * A fitted curve is only trustworthy if it actually reduced calibration error
 * on its own backtest (post-fit Brier < pre-fit Brier). Applying a curve that
 * scored WORSE would systematically push production probabilities the wrong
 * way — exactly the "calibration drags scores down" failure mode. So we gate on
 * a real improvement and otherwise fall back to the raw (uncalibrated) value.
 * Unknown/non-finite briers → treat as not-improving (conservative).
 */
function curveImproves(preBrier: number | undefined | null, postBrier: number | undefined | null): boolean {
  return (
    typeof preBrier === 'number' && Number.isFinite(preBrier) &&
    typeof postBrier === 'number' && Number.isFinite(postBrier) &&
    postBrier < preBrier
  )
}

/**
 * Apply the active calibration to a raw probability. No-ops when:
 *   - ENABLE_PROBABILITY_CALIBRATION is off, OR
 *   - The selected method has no fitted data in cache, OR
 *   - The fitted curve did not improve Brier over baseline (safety gate).
 * Safe to call on the hot scoring path (only number comparisons here).
 */
export function calibrateProbability(rawProb: number): number {
  if (!flagEnabled('ENABLE_PROBABILITY_CALIBRATION', false)) return rawProb

  const method = activeMethod()

  if (method === 'platt') {
    if (!cached.platt) return rawProb
    if (!curveImproves(cached.platt.preBrier, cached.platt.postBrier)) return rawProb
    return applyPlatt(rawProb, cached.platt)
  }

  // Default: isotonic
  if (!cached.curve) return rawProb
  if (!curveImproves(cached.curve.preBrier, cached.curve.postBrier)) return rawProb
  return applyIsotonic(rawProb, cached.curve)
}
