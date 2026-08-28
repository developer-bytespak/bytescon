// =============================================================
// Win-probability resolution — the SINGLE backend source of truth for the
// final, user-facing win probability and its calibration labelling (§5.1
// Stage 3). It takes the persisted RAW model probability and applies the active
// calibration curve EXACTLY ONCE, only when the curve is genuinely reliable,
// otherwise falls back to the raw score with an honest reason. It reuses the
// existing calibration infrastructure (calibrationCache / isotonic / platt) —
// it is not a second scoring engine.
//
// Activation rules (all must hold, else FALLBACK to raw):
//   1. Calibration enabled (ENABLE_PROBABILITY_CALIBRATION) — else RAW.
//   2. A fitted curve/params exist                          — else RAW.
//   3. Method version is compatible (v2-permutation).
//   4. Parameters are valid (finite, monotonic isotonic / finite platt).
//   5. Sample size ≥ CALIBRATION_MIN_SAMPLE.
//   6. Not stale (fitted within CALIBRATION_MAX_AGE_DAYS).
//   7. The curve improved Brier over baseline (post < pre).
//
// The final probability is clamped to [0,100] and the calc is deterministic.
// =============================================================
import { applyIsotonic, type IsotonicCurve } from './isotonicCalibration'
import { applyPlatt, type PlattParams } from './plattCalibration'
import { getActiveCalibration, type CalibrationMethod } from './calibrationCache'

export const COMPATIBLE_METHOD_VERSION = 'v2-permutation'
const DEFAULT_MIN_SAMPLE = 50
const DEFAULT_MAX_AGE_DAYS = 180

export type ScoreType = 'RAW' | 'CALIBRATED' | 'FALLBACK'
export type DataSufficiency = 'SUFFICIENT' | 'INSUFFICIENT' | 'NONE'

export interface WinProbabilityResult {
  rawScore: number // 0-100 integer
  finalScore: number // 0-100 integer (clamped)
  scoreType: ScoreType
  changed: boolean // finalScore differs from rawScore (calibration moved it)
  method: CalibrationMethod | null
  methodVersion: string | null
  sampleSize: number | null
  lastFittedAt: string | null
  reason: string | null // fallback reason, or why raw is used when a curve is disabled
  dataSufficiency: DataSufficiency
}

export interface CalibrationInput {
  enabled: boolean
  method: CalibrationMethod
  methodVersion: string | null
  curve: IsotonicCurve | null
  platt: PlattParams | null
  fittedAt: string | null
  minSample: number
  maxAgeDays: number
  now: Date
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const toPct = (p: number) => Math.round(clamp01(p) * 100)

function flagEnabled(): boolean {
  const raw = process.env.ENABLE_PROBABILITY_CALIBRATION
  return raw === '1' || (typeof raw === 'string' && raw.toLowerCase() === 'true')
}
function envInt(name: string, def: number): number {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : def
}

export function isValidIsotonicCurve(c: IsotonicCurve | null): boolean {
  if (!c || !Array.isArray(c.xs) || !Array.isArray(c.ys)) return false
  if (c.xs.length < 2 || c.xs.length !== c.ys.length) return false
  if (![...c.xs, ...c.ys].every((v) => typeof v === 'number' && Number.isFinite(v))) return false
  for (let i = 1; i < c.xs.length; i++) if (c.xs[i] < c.xs[i - 1] || c.ys[i] < c.ys[i - 1]) return false
  return true
}
export function isValidPlattParams(p: PlattParams | null): boolean {
  return !!p && Number.isFinite(p.A) && Number.isFinite(p.B)
}
function brierImproves(pre: number | null | undefined, post: number | null | undefined): boolean {
  return typeof pre === 'number' && Number.isFinite(pre) && typeof post === 'number' && Number.isFinite(post) && post < pre
}
function ageDays(fittedAt: string | null, now: Date): number | null {
  if (!fittedAt) return null
  const t = new Date(fittedAt).getTime()
  if (Number.isNaN(t)) return null
  return (now.getTime() - t) / 86_400_000
}

// Pure, deterministic. Applies calibration to `rawProb` (0-1) exactly once.
export function resolveWinProbability(rawProb: number, calib: CalibrationInput): WinProbabilityResult {
  const rawScore = toPct(rawProb)
  const usingIsotonic = calib.method !== 'platt'
  const params = usingIsotonic ? calib.curve : calib.platt
  const sampleSize = usingIsotonic ? calib.curve?.sampleSize ?? null : calib.platt?.sampleSize ?? null
  const pre = usingIsotonic ? calib.curve?.preBrier : calib.platt?.preBrier
  const post = usingIsotonic ? calib.curve?.postBrier : calib.platt?.postBrier

  const base = {
    rawScore, method: calib.method, methodVersion: calib.methodVersion,
    sampleSize, lastFittedAt: calib.fittedAt,
  }
  const sufficiency: DataSufficiency = params == null ? 'NONE' : (sampleSize ?? 0) >= calib.minSample ? 'SUFFICIENT' : 'INSUFFICIENT'
  const raw = (reason: string | null, scoreType: ScoreType = 'RAW'): WinProbabilityResult => ({
    ...base, finalScore: rawScore, scoreType, changed: false, reason, dataSufficiency: sufficiency,
  })

  // RAW: calibration off, or nothing fitted at all — no fallback (nothing to fall back from).
  if (!calib.enabled) return raw(params ? 'CALIBRATION_DISABLED' : 'NO_CALIBRATION')
  if (params == null) return raw('NO_CALIBRATION')

  // A curve exists and calibration is on → any guard failure is a FALLBACK.
  if (calib.methodVersion !== COMPATIBLE_METHOD_VERSION) return raw('INCOMPATIBLE_VERSION', 'FALLBACK')
  const valid = usingIsotonic ? isValidIsotonicCurve(calib.curve) : isValidPlattParams(calib.platt)
  if (!valid) return raw('INVALID_PARAMS', 'FALLBACK')
  if ((sampleSize ?? 0) < calib.minSample) return raw('INSUFFICIENT_SAMPLE', 'FALLBACK')
  const age = ageDays(calib.fittedAt, calib.now)
  if (age === null || age > calib.maxAgeDays) return raw('STALE', 'FALLBACK')
  if (!brierImproves(pre, post)) return raw('NO_BRIER_IMPROVEMENT', 'FALLBACK')

  // Apply exactly once, then clamp.
  const calibrated = usingIsotonic ? applyIsotonic(clamp01(rawProb), calib.curve!) : applyPlatt(clamp01(rawProb), calib.platt!)
  const finalScore = toPct(calibrated)
  return { ...base, finalScore, scoreType: 'CALIBRATED', changed: finalScore !== rawScore, reason: null, dataSufficiency: 'SUFFICIENT' }
}

// Assemble the active-calibration input from the in-process cache + env config.
// This is the boundary between the pure resolver and live state.
export function currentCalibrationInput(now: Date = new Date()): CalibrationInput {
  const active = getActiveCalibration()
  return {
    enabled: flagEnabled(),
    method: active.method,
    // The cache only loads v2-permutation COMPLETE runs, so a fitted curve is
    // compatible by construction; null when nothing is fitted.
    methodVersion: active.curve || active.platt ? COMPATIBLE_METHOD_VERSION : null,
    curve: active.curve,
    platt: active.platt,
    fittedAt: active.fittedAt,
    minSample: envInt('CALIBRATION_MIN_SAMPLE', DEFAULT_MIN_SAMPLE),
    maxAgeDays: envInt('CALIBRATION_MAX_AGE_DAYS', DEFAULT_MAX_AGE_DAYS),
    now,
  }
}

// The single source of truth for a stored raw probability (0-1). `rawProb` is
// the persisted Opportunity.probabilityScore — never a pre-calibrated value —
// so calibration is applied at exactly this one layer (no double calibration).
export function resolveStoredProbability(rawProb: number, now: Date = new Date()): WinProbabilityResult {
  return resolveWinProbability(rawProb, currentCalibrationInput(now))
}
