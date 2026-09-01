// =============================================================
// Config - Centralized environment configuration
// =============================================================
import dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalNumber(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const raw = (process.env[key] || '').toLowerCase().trim();
  if (raw === '') return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

const env = optional('NODE_ENV', 'development');
const jwtSecret = optional('JWT_SECRET', 'dev-secret-change-in-production');

// A weak/default JWT secret means anyone can forge tokens. Hard-fail in
// production OR any environment that opts in via REQUIRE_STRONG_JWT_SECRET=1
// (staging / shared / internet-exposed). Always warn loudly otherwise so a
// networked dev/preview instance can't silently ship the guessable default.
const usingWeakJwtSecret =
  jwtSecret === 'dev-secret-change-in-production' || jwtSecret.length < 32;
const requireStrongJwtSecret =
  env === 'production' || process.env.REQUIRE_STRONG_JWT_SECRET === '1';

if (usingWeakJwtSecret) {
  if (requireStrongJwtSecret) {
    throw new Error(
      'JWT_SECRET must be set to a strong value (>=32 chars) in production or when REQUIRE_STRONG_JWT_SECRET=1'
    );
  }
  // logger imports config, so use console here to avoid a circular import.
  // eslint-disable-next-line no-console
  console.warn(
    '[security] JWT_SECRET is weak or the built-in dev default — set a strong JWT_SECRET (>=32 chars) before exposing this instance to a network.'
  );
}

export const config = {
  env,
  port: parseInt(optional('PORT', '3001'), 10),

  database: {
    url: required('DATABASE_URL'),
  },

  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
  },

  jwt: {
    secret: jwtSecret,
    expiresIn: optional('JWT_EXPIRES_IN', '8h'),
  },

  sam: {
    apiKey: optional('SAM_API_KEY', ''),
    baseUrl: optional('SAM_BASE_URL', 'https://api.sam.gov/opportunities/v2'),
    // Records per API request (SAM v2 max: 1000). Personal API keys get only
    // ~10 requests/day, so large pages are what make the quota usable at all:
    // 10 requests × 1000 records covers a full daily delta. Small pages are
    // only useful for tests/mocks.
    pageSize: optionalNumber('SAM_PAGE_SIZE', 1000),
  },

  usaSpending: {
    baseUrl: optional('USASPENDING_BASE_URL', 'https://api.usaspending.gov/api/v2'),
  },

  // api.data.gov key — one key works across all api.gsa.gov / api.data.gov–
  // managed GSA APIs (Per Diem, Regulations.gov, …). NOT valid for SAM.gov
  // (that uses SAM_API_KEY). Free signup at https://api.data.gov/signup.
  dataGov: {
    apiKey: optional('DATA_GOV_API_KEY', ''),
    gsaBaseUrl: optional('GSA_API_BASE_URL', 'https://api.gsa.gov'),
  },

  rateLimit: {
    windowMs: parseInt(optional('RATE_LIMIT_WINDOW_MS', '900000'), 10),
    max: parseInt(optional('RATE_LIMIT_MAX', '500'), 10),
  },

  uploads: {
    maxMb: parseInt(optional('MAX_UPLOAD_MB', '25'), 10),
  },

  gcp: {
    projectId: optional('GCP_PROJECT_ID', ''),
    bqDataset: optional('BQ_DATASET', 'bytescon_analytics'),
    // Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json for Docker/CI.
    // Leave unset to use Application Default Credentials (gcloud auth).
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  },

  // ───────────────────────────────────────────────────────────
  // Matching v2 (GB-101/102): corrected opportunity↔client scorer.
  // `v2Enabled` defaults ON in dev, OFF in production until validated —
  // rollback is a flag flip, not a revert. Dimension weights are fully
  // externalized so future tuning needs no code change. Weights need not
  // sum to 1: the scorer renormalizes over the dimensions actually present
  // for each pair (absent dimensions excluded from numerator AND denominator).
  // ───────────────────────────────────────────────────────────
  matching: {
    v2Enabled: optional('MATCHING_V2_ENABLED', env === 'production' ? '0' : '1') === '1',
    weights: {
      naics: optionalNumber('MATCHING_W_NAICS', 0.35),
      psc: optionalNumber('MATCHING_W_PSC', 0.25),
      awardSize: optionalNumber('MATCHING_W_AWARD_SIZE', 0.15),
      geography: optionalNumber('MATCHING_W_GEOGRAPHY', 0.1),
      pastPerformance: optionalNumber('MATCHING_W_PAST_PERFORMANCE', 0.1),
      setAsideAlignment: optionalNumber('MATCHING_W_SET_ASIDE', 0.05),
    },
  },

  notifications: {
    enabled: optionalBool('CLIENT_NOTIFICATIONS_ENABLED', false),
    defaultThreshold: optionalNumber('CLIENT_NOTIFICATIONS_DEFAULT_THRESHOLD', 70),
    canSpamAddress: optional('CAN_SPAM_POSTAL_ADDRESS', '1 Central Ave NW, Albuquerque, NM 87102'),
    appUrl: optional('APP_URL', 'https://bytescon.com'),
  },

  scw: {
    emailEnrichmentEnabled: optionalBool('SCW_EMAIL_ENRICHMENT_ENABLED', false),
    // Seed the federal published prime-SBLO directory (DLA Strategic
    // Subcontracting OEM POCs + the DoD/DoW Comprehensive Subcontracting
    // Plan directory) into a firm's contact pool on each subcontracting
    // sync. Defaults ON — unlike the other enrichment flags this is a baked
    // public-domain corpus with no network call, no vendor cost and no new
    // PII class, so there is nothing to validate per environment; the flag
    // exists so it can be switched off without a deploy.
    primeDirectorySeedEnabled: optionalBool('PRIME_DIRECTORY_SEED_ENABLED', true),
  },

  // ───────────────────────────────────────────────────────────
  // Scoring tunables. `relevantPastPerformanceEnabled` lets the fit-score
  // past-performance factor consume structured PastPerformanceRecord rows
  // (CPARS rating + NAICS/agency relevance to the specific opportunity)
  // on top of the aggregate win/loss signal. CALIBRATION-SENSITIVE and it
  // shifts a client-facing win-probability surface — defaults OFF in every
  // environment. Do NOT enable until a calibration backtest (routes/backtest)
  // confirms it improves Brier/ECE; flip on per-environment via env var.
  // PERF PREREQUISITE before enabling where the portfolio worker runs: hoist
  // the per-client PastPerformance fetch out of portfolioDecisionEngine's
  // opportunity loop (today each opp×client pair issues its own opp-independent
  // findMany → N×M redundant queries). Fetch once per firm/client and filter in
  // JS before turning this on at scale.
  // ───────────────────────────────────────────────────────────
  scoring: {
    relevantPastPerformanceEnabled: optionalBool('RELEVANT_PAST_PERFORMANCE_ENABLED', false),
    // FIXES.md FIX-1: show the raw 0-100 "Fit score" number to customers. OFF by
    // default because the probability is not yet calibrated on real WON/LOST
    // outcomes — the honest surface is the tiered signal (Strong/Moderate/Weak)
    // + factor breakdown. Flip on only after the calibration backtest passes.
    showNumericFitScore: optionalBool('SHOW_NUMERIC_FIT_SCORE', false),
    // FIXES.md FIX-1 flywheel incentive: proposal tokens granted the FIRST time a
    // submission's WON/LOST outcome is recorded. Default 0 (off). Real outcomes
    // are the label source calibration needs, so this rewards logging them.
    outcomeLoggingRewardTokens: optionalNumber('OUTCOME_LOGGING_REWARD_TOKENS', 0),
    // Who-Wins v1 (docs/WHO_WINS_MODEL.md): blend the public-label win prior —
    // shrunk E[1/K] segment base rate × bounded relative-strength adjustment,
    // trained on USAspending award outcomes — into probabilityScore in
    // log-odds space. Default OFF; enable only after a human reviews the
    // out-of-time eval report (same protocol as the calibration rollback).
    whoWinsPriorEnabled: optionalBool('WHO_WINS_PRIOR_ENABLED', false),
    // Blend weight on the prior's logit. The prior is the only CALIBRATED
    // component, so it sets the level. Re-fit by Platt-style stacking once
    // ≥100 real WON/LOST outcomes exist.
    whoWinsPriorWeight: optionalNumber('WHO_WINS_PRIOR_WEIGHT', 0.75),
    // Exclude features with no source data from the win-probability weighted
    // mean (renormalizing the surviving weights) instead of filling them with a
    // neutral 0.5. Without this, an unenriched SAM opportunity scored on seven
    // constants: measured on prod, ~25 of every 50 opportunities returned
    // EXACTLY 0.3092 and the rest 0.4081, the two differing only by whether the
    // client shared a 2-digit NAICS sector. Fixing it makes low-fit
    // opportunities score genuinely low, so it MOVES A CUSTOMER-FACING NUMBER
    // (the portal's Fit score / tier). Defaults ON in dev, OFF in production —
    // same rollout shape as MATCHING_V2_ENABLED. Before enabling in prod,
    // sample-test ~8 opportunities and then re-score the tenant, exactly as the
    // 2026-06-27 calibration rollback taught.
    renormalizeAbsentFeatures:
      optional('PROBABILITY_RENORMALIZE_ABSENT', env === 'production' ? '0' : '1') === '1',
  },

  isProduction: env === 'production',
  isDevelopment: env === 'development',
};
