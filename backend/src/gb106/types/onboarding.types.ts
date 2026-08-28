/**
 * GB-106 Platform and Vehicle Onboarding, type contract.
 *
 * This file is dependency-free on purpose. The pure logic, the seed dataset,
 * and the verification harness all import from here and nothing else, so the
 * core can be typechecked in isolation (see tsconfig.core.json).
 */

/** Sequencing tier. Federal entry is dependent, not parallel. */
export enum OnboardingTier {
  Foundational = 0, // SAM.gov, UEI, CAGE. Required before anything else.
  Certification = 1, // SBA VetCert SDVOSB. Unlocks set-aside advantages.
  Vehicle = 2, // GSA MAS, OASIS+, Polaris, TMSS 2.0.
}

export enum ProgramCategory {
  Foundational = 'FOUNDATIONAL',
  Certification = 'CERTIFICATION',
  Vehicle = 'VEHICLE',
}

/**
 * How a program accepts entrants. Drives the "can the client act now" gate
 * and the freshness scan. Dates are never hardcoded into logic; they live in
 * the seed as nullable fields and are re-verified by the freshness job.
 */
export enum RegistrationModel {
  Continuous = 'CONTINUOUS', // Open-ended rolling intake (e.g. OASIS+ Phase II, MAS).
  Windowed = 'WINDOWED', // Opens in defined periods (e.g. TMSS 2.0 broker registration).
  Application = 'APPLICATION', // Apply any time, processed in a queue (e.g. SAM.gov, VetCert).
  Phased = 'PHASED', // Awards from a closed solicitation, no current open intake (e.g. Polaris SDVOSB pool).
}

/**
 * Verification state of a seed record. NEEDS_VERIFICATION is the honest
 * default for anything whose date or status could not be confirmed against a
 * primary source. The freshness job and the UI both surface this. The system
 * must never present NEEDS_VERIFICATION data as confirmed.
 */
export enum VerificationStatus {
  Verified = 'VERIFIED',
  NeedsVerification = 'NEEDS_VERIFICATION',
}

/** Relevance classification of a program to a given business profile. */
export enum FitClass {
  Core = 'CORE', // Purpose-built for this business (e.g. TMSS 2.0 for a freight broker).
  Adjacent = 'ADJACENT', // Real fit through a relevant category (e.g. MAS logistics category).
  Peripheral = 'PERIPHERAL', // Out-of-domain (e.g. an IT-only GWAC for a freight broker).
  Prerequisite = 'PREREQUISITE', // Foundational/certification step, ranked by sequence, not fit.
}

/** A federal platform, vehicle, or registration the module tracks. */
export interface OnboardingProgram {
  /** Stable machine code, also the seed primary key. */
  code: string;
  name: string;
  shortName: string;
  tier: OnboardingTier;
  category: ProgramCategory;
  administeringAgency: string;
  description: string;
  officialUrl: string;
  /** Codes of programs that must be COMPLETE before this one can begin. */
  prerequisites: string[];
  keyRequirements: string[];
  /** Free-form domain tags used by the relevance scorer. */
  relevanceTags: string[];
  /** Business domains for which this program is a CORE fit. */
  coreFor: string[];
  registrationModel: RegistrationModel;
  /** Nullable, dynamic. Re-verified by the freshness job, never hardcoded in logic. */
  nextWindowOpensAt: string | null; // ISO date or null
  nextWindowClosesAt: string | null; // ISO date or null
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null; // ISO date
  sourceUrls: string[];
  notes: string | null;
}

/** Snapshot of a tenant used for relevance and gating. Passed in, not queried, */
/** so the module stays drop-in and never assumes the host tenant schema. */
export interface TenantOnboardingProfile {
  tenantId: string;
  businessDomain: string; // e.g. "freight_brokerage"
  naicsCodes: string[]; // e.g. ["488510"]
  isSdvosb: boolean;
  yearsInBusiness: number;
  /** Program codes the tenant has already completed (or that are otherwise true). */
  completedProgramCodes: string[];
  /** Optional interest tags to weight relevance beyond NAICS inference. */
  interestTags?: string[];
}

export enum ProgressStatus {
  NotStarted = 'NOT_STARTED',
  InProgress = 'IN_PROGRESS',
  Submitted = 'SUBMITTED',
  Complete = 'COMPLETE',
  NotApplicable = 'NOT_APPLICABLE',
}

/** Per-tenant progress against a single program. */
export interface OnboardingProgressRecord {
  tenantId: string;
  programCode: string;
  status: ProgressStatus;
  startedAt: string | null;
  completedAt: string | null;
  notes: string | null;
}

/** Whether a tenant can act on a program right now, and why or why not. */
export interface ActionGate {
  canStart: boolean;
  windowOpen: boolean;
  prerequisitesMet: boolean;
  missingPrerequisites: string[];
  blockingReason: string | null;
}

/** A scored, gated program ready for presentation. */
export interface ScoredProgram {
  program: OnboardingProgram;
  relevanceScore: number; // 0..100
  fitClass: FitClass;
  gate: ActionGate;
  progressStatus: ProgressStatus;
  /** True when the seed record needs human re-verification before relying on it. */
  requiresVerification: boolean;
}

/** The full payload returned to the client for one tenant. */
export interface OnboardingPlan {
  tenantId: string;
  generatedAt: string;
  programs: ScoredProgram[];
  /** Codes flagged NEEDS_VERIFICATION, surfaced so the UI can warn explicitly. */
  unverifiedProgramCodes: string[];
  /** The single recommended next action by sequence and relevance. */
  recommendedNextCode: string | null;
}
