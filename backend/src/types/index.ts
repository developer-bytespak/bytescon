// =============================================================
// Shared Types and Interfaces
// =============================================================
import { Request } from 'express';

// -------------------------------------------------------------
// Auth
// -------------------------------------------------------------
// §8.5 — ADMIN and CONSULTANT keep exactly the meaning they always had; the
// rest are the granular roles added alongside the permission model. Every one
// of these is an INTERNAL identity: 'CLIENT' and 'PARTNER' are separate
// identities and are refused by authenticateJWT.
export type UserRole =
  | 'ADMIN'
  | 'CONSULTANT'
  | 'BD_CAPTURE'
  | 'PROPOSAL'
  | 'CONTRACTS'
  | 'FINANCE'
  | 'VIEWER';

/**
 * Scoped tokens narrow access to a single completion endpoint. The full-access
 * scope is represented by an absent `scope` field. Adding a value here means
 * adding a guard in the corresponding route — see auth.ts complete-agreements
 * for the pattern.
 */
export type JwtScope = 'accept_agreements' | 'mfa_challenge';

export interface JwtPayload {
  userId: string;
  consultingFirmId: string;
  role: UserRole;
  email: string;
  scope?: JwtScope;
  iat?: number;
  exp?: number;
}

export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

// -------------------------------------------------------------
// Deadline Priority
// -------------------------------------------------------------
export type DeadlinePriority = 'RED' | 'YELLOW' | 'GREEN';

export interface DeadlineClassification {
  priority: DeadlinePriority;
  daysUntilDeadline: number;
  label: string;
}

// -------------------------------------------------------------
// Probability Engine — 9-factor model
// -------------------------------------------------------------
export interface ProbabilityFeatures {
  naicsOverlapScore: number;        // 0-1: NAICS domain match
  agencyAlignmentScore: number;     // 0-1: Agency SDVOSB/small-biz award rate
  awardSizeFitScore: number;        // 0-1: Contract size within client capacity
  competitionDensityScore: number;  // 0-1: Bidder count vs NAICS norm
  historicalDistribution: number;   // 0-1: USAspending base win rate
  incumbentWeaknessScore: number;   // 0-1: Inverse of incumbent dominance
  documentAlignmentScore: number;   // 0-1: SOW scope match from document intel
  agencyHistoryScore: number;       // 0-1: Agency historical set-aside affinity
  deadlineUrgencyScore: number;     // 0-1: Quality of proposal prep window
}

// -------------------------------------------------------------
// Compliance Gate — Layer 1: Hard eligibility filter
// -------------------------------------------------------------
export type ComplianceGate = 'ELIGIBLE' | 'CONDITIONAL' | 'INELIGIBLE'

export interface ComplianceGateOutput {
  gate: ComplianceGate
  blockers: string[]     // Hard ineligibility reasons
  conditions: string[]   // Soft warnings
  requiredActions: string[]
}

// -------------------------------------------------------------
// Fit Score — Layer 2: Client capability (0-100)
// -------------------------------------------------------------
export interface FitScoreOutput {
  total: number
  breakdown: {
    naicsDepth: number
    pastPerformance: number
    capacityFit: number
    geographicFit: number
    resourceReadiness: number
    financialStrength: number
  }
}

// -------------------------------------------------------------
// Market Score — Layer 3: Opportunity attractiveness (0-100)
// -------------------------------------------------------------
export interface MarketScoreOutput {
  total: number
  breakdown: {
    competitionDensity: number
    incumbentStrength: number
    contractValueFit: number
    agencyBuyingPatterns: number
    timingAdvantage: number
  }
}

/**
 * Discriminated result of a win-probability computation.
 *
 * P1-1 (failure integrity): a computation that cannot produce a meaningful
 * number returns `status: 'FAILED'` with a reason — NEVER a fabricated/plausible
 * constant. Consumers must narrow on `status` before reading any score, so the
 * type system makes "use a fake number on error" a compile error rather than a
 * silent runtime placeholder.
 */
export type ProbabilityResult =
  | {
      status: 'OK';
      features: ProbabilityFeatures;
      rawScore: number;
      probability: number;
      expectedValue: number;
      /** False when naicsOverlapScore === 0: primary domain signal is absent.
       *  Probability is a base-rate value — not a domain-matched score. */
      naicsSignal: boolean;
      /** Feature keys excluded from the score because no source data existed
       *  for them. Their weight was renormalized away rather than filled with a
       *  neutral constant, so the UI must render these as "not scored" rather
       *  than as a real sub-score. Empty when renormalization is disabled. */
      absentFeatures: string[];
    }
  | {
      status: 'FAILED';
      features: ProbabilityFeatures;
      /** Machine/operator-readable reason the score could not be computed. */
      failureReason: string;
    };

// -------------------------------------------------------------
// Matching v2 (GB-101/102) — relevance/fit score with dynamic
// renormalization over the dimensions actually present for a pair.
// Distinct from the win-probability model: this answers "how well does
// this firm match this opportunity", with absent dimensions excluded
// from both numerator and denominator (no denominator inflation).
// -------------------------------------------------------------
export interface MatchV2Weights {
  naics: number;
  psc: number;
  awardSize: number;
  geography: number;
  pastPerformance: number;
  setAsideAlignment: number;
}

export type MatchV2Dimension = keyof MatchV2Weights;

export interface MatchV2DimensionResult {
  raw: number;       // 0-1 sub-score (meaningful only when present)
  weight: number;    // configured weight for this dimension
  present: boolean;  // whether the dimension was comparable for this pair
}

export interface MatchScoreV2Output {
  total: number;     // 0-100, renormalized over present dimensions
  breakdown: Record<MatchV2Dimension, MatchV2DimensionResult>;
  dimensionsPresent: MatchV2Dimension[];
}

// -------------------------------------------------------------
// USASpending Enrichment
// -------------------------------------------------------------
export interface AwardRecord {
  recipientName: string;
  recipientUei?: string;
  awardAmount: number;
  awardDate: string;
  baseAndAllOptions?: number;
  awardType?: string;
  contractNumber?: string;
}

export interface EnrichmentResult {
  historicalWinner: string | null;
  historicalAvgAward: number;
  historicalAwardCount: number;
  competitionCount: number | null;    // null = no historical data found
  incumbentProbability: number | null; // null = no historical data found
  agencySmallBizRate: number;
  agencySdvosbRate: number;
  recompeteFlag: boolean;
  awards: AwardRecord[];
  offersReceived: number | null;      // FPDS: actual bidder count per solicitation
  extentCompeted: string | null;      // FPDS: competition extent
}

// -------------------------------------------------------------
// Document Analysis
// -------------------------------------------------------------
export interface DocumentAnalysisResult {
  scopeKeywords: string[];
  complexityScore: number;
  alignmentScore: number;
  incumbentSignals: string[];
  rawAnalysis: Record<string, unknown>;
}

// -------------------------------------------------------------
// Job System
// -------------------------------------------------------------
export type JobType = 'INGEST' | 'ENRICH' | 'ANALYZE_DOCUMENT';
export type JobStatus = 'PENDING' | 'RUNNING' | 'COMPLETE' | 'FAILED';

export interface JobResult {
  id: string;
  type: JobType;
  status: JobStatus;
  opportunitiesFound?: number;
  opportunitiesNew?: number;
  enrichedCount?: number;
  scoringJobsQueued?: number;
  errors?: number;
  errorDetail?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

// -------------------------------------------------------------
// SAM.gov API
// -------------------------------------------------------------
export interface SamOpportunity {
  noticeId: string;
  title: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  organizationHierarchy?: {
    agency?: string;
    subagency?: string;
    office?: string;
  };
  naicsCode?: string;
  naicsDescription?: string;
  classificationCode?: string;
  setAside?: string;
  typeOfSetAside?: string;
  estimatedValue?: {
    amount?: number;
    minAmount?: number;
    maxAmount?: number;
  };
  postedDate?: string;
  responseDeadLine?: string;
  archiveDate?: string;
  placeOfPerformance?: {
    city?: string;
    state?: string;
  };
  description?: string;
  uiLink?: string;
}

// -------------------------------------------------------------
// Opportunity Filters
// -------------------------------------------------------------
export interface OpportunityFilters {
  naicsCode?: string;
  agency?: string;
  marketCategory?: string;
  setAsideType?: string;
  estimatedValueMin?: number;
  estimatedValueMax?: number;
  daysUntilDeadline?: number;
  probabilityMin?: number;
  probabilityMax?: number;
  status?: string;
  sortBy?: 'deadline' | 'probability' | 'expectedValue' | 'createdAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

// -------------------------------------------------------------
// Performance Metrics
// -------------------------------------------------------------
export interface FirmMetrics {
  totalClients: number;
  totalSubmissions: number;
  aggregateCompletionRate: number;
  totalPenaltiesGenerated: number;
}

// -------------------------------------------------------------
// API Response Envelope
// -------------------------------------------------------------
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  /** Optional structured validation detail (e.g. ZodError.flatten()). */
  details?: unknown;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
  };
}
