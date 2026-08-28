// =============================================================
// Win Probability Engine — 9-Factor Decision Model
// Tier 1-3 signals + Competitive Density + Agency History + Deadline Urgency
// =============================================================
import { ProbabilityFeatures, ProbabilityResult } from '../types';
import { logger } from '../utils/logger';
import { calibrateProbability } from '../services/calibrationCache';
import { config } from '../config/config';

// -------------------------------------------------------------
// Feature Weights (must sum to 1.0)
// Added: agencyHistoryScore (agency set-aside affinity) + deadlineUrgencyScore
// competitionDensityScore upgraded: now uses NAICS-normalized density ratio
// -------------------------------------------------------------
const WEIGHTS: Record<keyof ProbabilityFeatures, number> = {
  naicsOverlapScore:       0.24,  // Domain match — strongest predictor
  incumbentWeaknessScore:  0.19,  // Incumbent dominance inversion (text + USAspending)
  documentAlignmentScore:  0.16,  // SOW scope match from uploaded documents
  agencyAlignmentScore:    0.12,  // Agency SDVOSB/SB award rate for client type
  awardSizeFitScore:       0.09,  // Capacity fit
  competitionDensityScore: 0.08,  // Bidder count vs NAICS norm
  agencyHistoryScore:      0.07,  // Agency historical set-aside affinity (new)
  historicalDistribution:  0.03,  // USAspending base rate
  deadlineUrgencyScore:    0.02,  // Quality of proposal prep window (new)
};

// Verify weights sum to 1.0
const weightSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(weightSum - 1.0) > 0.001) {
  throw new Error(`Probability weights do not sum to 1.0: ${weightSum}`);
}

// Human-readable labels for each factor, used to explain a score in the UI/export.
export const FACTOR_LABELS: Record<keyof ProbabilityFeatures, string> = {
  naicsOverlapScore:       'NAICS / domain match',
  incumbentWeaknessScore:  'Incumbent weakness',
  documentAlignmentScore:  'Document / scope alignment',
  agencyAlignmentScore:    'Agency set-aside alignment',
  awardSizeFitScore:       'Award size fit',
  competitionDensityScore: 'Competition density',
  agencyHistoryScore:      'Agency history affinity',
  historicalDistribution:  'Historical base rate',
  deadlineUrgencyScore:    'Deadline / prep window',
};

// Canonical per-factor contribution row consumed by the ScoreBreakdown UI and
// CSV export. `factor` is the feature KEY (frontend maps it to a label).
export interface ScoreFactor {
  factor: string;       // feature key, e.g. 'naicsOverlapScore'
  label: string;        // human-readable label (also handy for CSV export)
  score: number;        // the 0-1 sub-score
  weight: number;       // model weight
  contribution: number; // weight * score — its share of the raw z-score
  pct: number;          // score as a 0-100 integer (for bar width)
}

/**
 * Decompose a feature vector into labeled, weighted factors sorted by
 * contribution. Lets the UI/export answer "why did this score what it did"
 * (e.g. surface that NAICS match contributed 0 → the score is base-rate only).
 * Shape matches the ScoreBreakdown component's FactorContribution.
 */
export function explainFeatures(features: ProbabilityFeatures): ScoreFactor[] {
  return (Object.keys(WEIGHTS) as (keyof ProbabilityFeatures)[])
    .map((k) => ({
      factor: k,
      label: FACTOR_LABELS[k],
      score: Number(features[k].toFixed(4)),
      weight: WEIGHTS[k],
      contribution: Number((WEIGHTS[k] * features[k]).toFixed(4)),
      pct: Math.round(features[k] * 100),
    }))
    .sort((a, b) => b.contribution - a.contribution);
}

export type FeatureKey = keyof ProbabilityFeatures;

/**
 * Weighted mean of the features that actually have data behind them.
 *
 * Features named in `absent` are excluded from BOTH the numerator and the
 * denominator, so the remaining weights renormalize to 1 — the same technique
 * matchingV2 uses for missing dimensions. Without this, a feature with no
 * source data had to be given some number, and the engine used a neutral 0.5.
 * That is not neutral: with `naicsOverlapScore` at 0 for most client/opportunity
 * pairs, seven defaulted features pinned z near 0.37 and every opportunity
 * scored ~0.31 regardless of fit.
 *
 * Passing an empty/omitted `absent` set reproduces the previous arithmetic
 * exactly (the denominator is 1.0 because WEIGHTS sums to 1.0).
 *
 * When EVERY feature is absent there is no evidence at all, and z falls back to
 * 0 — the model's own prior, ~0.047 after the logistic. That is the correct
 * no-information estimate for a competitive federal bid, and it is deliberately
 * NOT a typed failure: missing source data is a permanent property of the
 * record, while scoringWorker retries FAILED results through BullMQ, so failing
 * here would retry an unscoreable opportunity forever.
 */
function computeZScore(
  features: ProbabilityFeatures,
  absent?: ReadonlySet<FeatureKey>
): number {
  let weighted = 0;
  let totalWeight = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    if (absent?.has(key as FeatureKey)) continue;
    weighted += weight * features[key as FeatureKey];
    totalWeight += weight;
  }
  if (totalWeight <= 0) return 0;
  return weighted / totalWeight;
}

/**
 * Logistic (sigmoid) transformation.
 * Bias of -3.0 reflects competitive federal market baseline.
 * Scale of 6.0 provides adequate spread across feature ranges.
 */
function logisticTransform(z: number): number {
  const SCALE = 6.0;
  const BIAS = -3.0;
  return 1 / (1 + Math.exp(-(SCALE * z + BIAS)));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// -------------------------------------------------------------
// Feature Computation Functions
// -------------------------------------------------------------

/**
 * Reduce a NAICS code to its bare digits. SAM/USAspending and hand-entered
 * client codes can arrive with stray formatting ("541512 ", "54-1512",
 * "541512.0"); without normalization a genuine match silently scores 0 on the
 * highest-weighted factor (0.24) — a real cause of opportunities "scoring low".
 */
export function normalizeNaics(code: string | null | undefined): string {
  return (code ?? '').replace(/\D/g, '');
}

/**
 * True when a NAICS string carries actual domain information.
 *
 * Rejects blanks and the all-zeros placeholder. `services/samApi.ts` used to
 * write the literal "000000" whenever SAM omitted the code, and those rows are
 * still in the database, so this must keep screening the placeholder out even
 * though new ingests store an empty string.
 */
export function hasUsableNaics(code: string | null | undefined): boolean {
  const digits = normalizeNaics(code);
  return digits.length >= 2 && !/^0+$/.test(digits);
}

export function computeNaicsOverlap(
  clientNaics: string[],
  opportunityNaics: string
): number {
  const opp = normalizeNaics(opportunityNaics);
  const clients = clientNaics.map(normalizeNaics).filter((n) => n.length >= 2);
  // No usable codes on either side → no domain signal (unchanged semantics).
  if (opp.length < 2 || clients.length === 0) return 0;

  if (clients.includes(opp)) return 1.0;

  const oppSector = opp.substring(0, 4);
  if (oppSector.length === 4 && clients.some((n) => n.substring(0, 4) === oppSector)) return 0.6;

  const oppSubsector = opp.substring(0, 2);
  if (clients.some((n) => n.substring(0, 2) === oppSubsector)) return 0.3;

  return 0;
}

export function computeAwardSizeFit(
  estimatedValue: number | null,
  clientPastAwardMin = 100000,
  clientPastAwardMax = 10000000
): number {
  if (!estimatedValue) return 0.5;
  if (estimatedValue >= clientPastAwardMin && estimatedValue <= clientPastAwardMax) return 1.0;
  if (estimatedValue < clientPastAwardMin) return clamp((estimatedValue / clientPastAwardMin) * 0.8);
  return clamp((clientPastAwardMax / estimatedValue) * 0.7);
}

/**
 * Incumbent weakness score.
 * High incumbentProbability (dominant winner) = low score for new entrant.
 * Low incumbentProbability (fragmented market) = high score for new entrant.
 * No data = neutral 0.5
 */
export function computeIncumbentWeaknessScore(
  incumbentProbability: number | null,
  competitionCount: number | null
): number {
  if (incumbentProbability === null) return 0.5;

  // Invert: a dominant incumbent is bad for new entrants
  const dominanceScore = 1 - incumbentProbability;

  // Bonus for fragmented competition (more bidders = more chaos = more opportunity)
  let competitionBonus = 0;
  if (competitionCount !== null) {
    if (competitionCount >= 5) competitionBonus = 0.1;
    else if (competitionCount >= 3) competitionBonus = 0.05;
    else if (competitionCount <= 1) competitionBonus = -0.1; // Sole source risk
  }

  return clamp(dominanceScore + competitionBonus);
}

// -------------------------------------------------------------
// Core Probability Computation
// -------------------------------------------------------------

export function computeProbability(
  features: ProbabilityFeatures,
  estimatedValue: number | null,
  absent?: ReadonlySet<FeatureKey>
): ProbabilityResult {
  try {
    // Per-call weight-sum check. The module-load check at line 27 catches
    // hand-edits, but in-process WEIGHTS mutation or a HMR-style reload
    // could leave us drifting silently. 0.001 tolerance covers floating-
    // point drift from summing 9 floats.
    const liveWeightSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    if (Math.abs(liveWeightSum - 1.0) > 0.001) {
      throw new Error(`Probability weights drifted from 1.0: ${liveWeightSum}`);
    }

    for (const [key, val] of Object.entries(features)) {
      if (val < 0 || val > 1) {
        logger.warn('Feature out of range, clamping', { feature: key, value: val });
        features[key as keyof ProbabilityFeatures] = clamp(val);
      }
    }

    const rawScore = computeZScore(features, absent);
    const rawProbability = logisticTransform(rawScore);

    // NaN guard. If a feature was NaN/Infinity and slipped past the
    // clamp, the logistic transform can return NaN — propagating that
    // into downstream Bayesian calibration silently corrupts decisions.
    if (!Number.isFinite(rawProbability)) {
      logger.error('Probability went non-finite', { rawScore, features });
      // P1-1: surface a typed failure — do NOT fabricate a plausible constant.
      return {
        status: 'FAILED',
        features,
        failureReason: `Probability computation produced a non-finite value (rawScore=${rawScore})`,
      };
    }

    // Apply isotonic calibration when an active curve is loaded and the
    // env flag is on. No-ops otherwise (returns rawProbability unchanged).
    const probability = calibrateProbability(rawProbability);

    const expectedValue = estimatedValue ? probability * estimatedValue : 0;
    const naicsSignal = features.naicsOverlapScore > 0;

    if (!naicsSignal) {
      logger.warn('Probability computed with no NAICS overlap — base-rate only', {
        probability,
        awardSizeFitScore: features.awardSizeFitScore,
      });
    }

    return {
      status: 'OK',
      features,
      rawScore,
      probability,
      expectedValue,
      naicsSignal,
      absentFeatures: absent ? [...absent] : [],
    };
  } catch (err) {
    logger.error('Probability computation failed', { error: err });
    // P1-1: a crashed computation is a typed failure, not a score of 0.
    return {
      status: 'FAILED',
      features,
      failureReason: err instanceof Error ? err.message : String(err),
    };
  }
}

// -------------------------------------------------------------
// Full Opportunity-Client Scoring Entry Point
// -------------------------------------------------------------

/**
 * Deadline urgency: 0-1 representing quality of the proposal prep window.
 * Sweet spot is 2-6 weeks out. Too tight or too far = lower score.
 */
export function computeDeadlineUrgency(responseDeadline: Date): number {
  const daysUntil = Math.ceil((responseDeadline.getTime() - Date.now()) / 86400000);
  if (daysUntil < 0)   return 0.0;  // expired
  if (daysUntil < 5)   return 0.1;  // too tight — rushed proposal
  if (daysUntil < 14)  return 0.5;  // urgent but possible
  if (daysUntil < 42)  return 1.0;  // sweet spot: 2-6 weeks
  if (daysUntil < 90)  return 0.7;  // good lead time
  if (daysUntil < 180) return 0.5;  // neutral
  return 0.3;                        // very far — requirements may change
}

export function scoreOpportunityForClient(params: {
  opportunityNaics: string;
  opportunityEstimatedValue: number | null;
  opportunityAgency: string;
  clientNaics: string[];
  clientProfile: { sdvosb: boolean; wosb: boolean; hubzone: boolean; smallBusiness: boolean };
  // Tier 2: USAspending enrichment
  incumbentProbability?: number | null;
  competitionCount?: number | null;
  offersReceived?: number | null;
  agencyAlignmentScore?: number | null;
  historicalDistribution?: number | null;
  agencySdvosbRate?: number | null;
  // Tier 3: Document intelligence
  documentAlignmentScore?: number | null;
  // Tier 4: Advanced signals (from new engines)
  agencyHistoryScore?: number | null;
  deadlineUrgencyScore?: number | null;
  densityScore?: number | null;
}): ProbabilityResult {

  // Agency alignment: if SDVOSB and we know agency SDVOSB rate, use it
  let agencyScore = params.agencyAlignmentScore ?? 0.5;
  if (params.clientProfile.sdvosb && params.agencySdvosbRate != null) {
    agencyScore = clamp(0.3 + params.agencySdvosbRate * 2);
  }

  // Use offersReceived (actual bidders) over competitionCount when available
  const competitorCount = params.offersReceived ?? params.competitionCount ?? null;

  // Density score: use the NAICS-normalized value if available, else simple formula
  const densityScore = params.densityScore != null
    ? params.densityScore
    : competitorCount
      ? clamp(1 - (competitorCount / 20))
      : 0.5;

  const features: ProbabilityFeatures = {
    naicsOverlapScore:       computeNaicsOverlap(params.clientNaics, params.opportunityNaics),
    incumbentWeaknessScore:  computeIncumbentWeaknessScore(
                               params.incumbentProbability ?? null,
                               competitorCount
                             ),
    documentAlignmentScore:  params.documentAlignmentScore ?? 0.5,
    agencyAlignmentScore:    agencyScore,
    awardSizeFitScore:       computeAwardSizeFit(params.opportunityEstimatedValue),
    competitionDensityScore: densityScore,
    historicalDistribution:  params.historicalDistribution ?? 0.3,
    agencyHistoryScore:      params.agencyHistoryScore ?? 0.5,
    deadlineUrgencyScore:    params.deadlineUrgencyScore ?? 0.5,
  };

  // Which features had no source data. The values above stay as-is so behavior
  // is unchanged when renormalization is off; when it is on, these are excluded
  // from the weighted mean instead of contributing a made-up constant.
  //
  // The distinction that matters: a feature is ABSENT when the input needed to
  // compute it does not exist, versus genuinely ZERO when the input exists and
  // the answer is "bad fit". naicsOverlapScore is the sharp case — 0 because two
  // real NAICS codes don't match is strong negative evidence and must be kept,
  // but 0 because the opportunity carries no NAICS at all is no evidence.
  const absent = new Set<FeatureKey>();
  if (!hasUsableNaics(params.opportunityNaics) || params.clientNaics.filter((c) => hasUsableNaics(c)).length === 0) {
    absent.add('naicsOverlapScore');
  }
  if (params.incumbentProbability == null) absent.add('incumbentWeaknessScore');
  if (params.documentAlignmentScore == null) absent.add('documentAlignmentScore');
  if (params.agencyAlignmentScore == null && !(params.clientProfile.sdvosb && params.agencySdvosbRate != null)) {
    absent.add('agencyAlignmentScore');
  }
  if (!params.opportunityEstimatedValue) absent.add('awardSizeFitScore');
  if (params.densityScore == null && competitorCount == null) absent.add('competitionDensityScore');
  if (params.historicalDistribution == null) absent.add('historicalDistribution');
  if (params.agencyHistoryScore == null) absent.add('agencyHistoryScore');
  if (params.deadlineUrgencyScore == null) absent.add('deadlineUrgencyScore');

  return computeProbability(
    features,
    params.opportunityEstimatedValue,
    config.scoring.renormalizeAbsentFeatures ? absent : undefined
  );
}