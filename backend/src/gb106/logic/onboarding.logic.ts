/**
 * GB-106 pure logic. No I/O, no Prisma, no Express. Deterministic and unit-testable.
 * Imports only the type contract and the seed. This is the core that gets
 * typechecked in isolation and exercised by the verification harness.
 */

import {
  ActionGate,
  FitClass,
  OnboardingPlan,
  OnboardingProgram,
  OnboardingTier,
  ProgressStatus,
  RegistrationModel,
  ScoredProgram,
  TenantOnboardingProfile,
  VerificationStatus,
} from '../types/onboarding.types';
import { ONBOARDING_PROGRAMS, PROGRAM_BY_CODE } from '../data/onboarding.seed';

/**
 * Weighted tag vocabulary. Higher weight means a stronger signal of relevance.
 * Kept explicit and small so scoring is auditable rather than opaque.
 */
const TAG_WEIGHTS: Record<string, number> = {
  freight: 1.0,
  logistics: 1.0,
  transportation: 0.9,
  broker: 1.0,
  tsp: 0.8,
  scac: 0.6,
  sdvosb: 0.8,
  set_aside: 0.6,
  veteran: 0.5,
  small_business: 0.4,
  professional_services: 0.5,
  services: 0.4,
  it: 0.6,
  emerging_tech: 0.5,
  software: 0.5,
  products: 0.4,
};

const FIT_BONUS: Record<FitClass, number> = {
  [FitClass.Core]: 25,
  [FitClass.Adjacent]: 10,
  [FitClass.Peripheral]: 0,
  [FitClass.Prerequisite]: 0,
};

/**
 * Relevance floor by fit class. A program purpose-built for the tenant's core
 * domain (e.g. TMSS 2.0 for a freight broker) is, by definition, the dominant
 * recommendation. The floor prevents incidental tag dilution (the program does
 * not carry SDVOSB/veteran tags, which legitimately apply to the tenant) from
 * pushing a core-fit channel below adjacent vehicles. This is a deliberate,
 * auditable business rule, not a fudge factor.
 */
const FIT_FLOOR: Record<FitClass, number> = {
  [FitClass.Core]: 85,
  [FitClass.Adjacent]: 0,
  [FitClass.Peripheral]: 0,
  [FitClass.Prerequisite]: 0,
};

/**
 * Build the effective interest-tag set for a tenant from its profile.
 * NAICS 488510 (freight transportation arrangement) implies freight/logistics tags.
 */
export function deriveProfileTags(profile: TenantOnboardingProfile): Set<string> {
  const tags = new Set<string>(profile.interestTags ?? []);
  if (profile.businessDomain === 'freight_brokerage' || profile.naicsCodes.includes('488510')) {
    tags.add('freight');
    tags.add('logistics');
    tags.add('transportation');
    tags.add('broker');
    tags.add('tsp');
    tags.add('scac');
  }
  if (profile.isSdvosb) {
    tags.add('sdvosb');
    tags.add('set_aside');
    tags.add('veteran');
  }
  tags.add('small_business');
  return tags;
}

/** Classify how well a program fits a tenant's core business. */
export function classifyFit(program: OnboardingProgram, profile: TenantOnboardingProfile): FitClass {
  if (program.tier === OnboardingTier.Foundational || program.tier === OnboardingTier.Certification) {
    return FitClass.Prerequisite;
  }
  if (program.coreFor.includes(profile.businessDomain)) {
    return FitClass.Core;
  }
  const profileTags = deriveProfileTags(profile);
  const domainOverlap = program.relevanceTags.some(
    (t) => ['freight', 'logistics', 'transportation', 'broker'].includes(t) && profileTags.has(t)
  );
  if (domainOverlap) return FitClass.Adjacent;
  // A program tagged for an out-of-domain specialty (e.g. IT) with no overlap is peripheral.
  return FitClass.Peripheral;
}

/**
 * Relevance score, 0..100. Transparent and bounded:
 *   tagScore (0..70 from weighted tag overlap) + fitBonus (0..25) capped at 100.
 * Prerequisite-tier programs are scored on the same scale but ranked separately
 * by sequence in plan assembly, since "relevance" is the wrong axis for them.
 */
export function scoreRelevance(program: OnboardingProgram, profile: TenantOnboardingProfile): number {
  const profileTags = deriveProfileTags(profile);
  let matched = 0;
  let denom = 0;
  for (const tag of profileTags) {
    const w = TAG_WEIGHTS[tag] ?? 0.3;
    denom += w;
    if (program.relevanceTags.includes(tag)) matched += w;
  }
  const tagScore = denom > 0 ? (matched / denom) * 70 : 0;
  const fit = classifyFit(program, profile);
  const raw = tagScore + FIT_BONUS[fit];
  return Math.min(100, Math.round(Math.max(raw, FIT_FLOOR[fit])));
}

/** Determine whether a tenant can act on a program right now. */
export function evaluateGate(
  program: OnboardingProgram,
  profile: TenantOnboardingProfile,
  now: Date
): ActionGate {
  const completed = new Set(profile.completedProgramCodes);
  const missing = program.prerequisites.filter((code) => !completed.has(code));
  const prerequisitesMet = missing.length === 0;

  let windowOpen: boolean;
  switch (program.registrationModel) {
    case RegistrationModel.Continuous:
    case RegistrationModel.Application:
      windowOpen = true;
      break;
    case RegistrationModel.Phased:
      windowOpen = false; // No open intake for new entrants unless re-verified.
      break;
    case RegistrationModel.Windowed: {
      if (!program.nextWindowOpensAt || !program.nextWindowClosesAt) {
        windowOpen = false; // Unknown window means not actionable until verified.
      } else {
        const opens = new Date(program.nextWindowOpensAt).getTime();
        const closes = new Date(program.nextWindowClosesAt).getTime();
        const t = now.getTime();
        windowOpen = t >= opens && t <= closes;
      }
      break;
    }
    default:
      windowOpen = false;
  }

  let blockingReason: string | null = null;
  if (!prerequisitesMet) {
    const names = missing.map((c) => PROGRAM_BY_CODE[c]?.shortName ?? c).join(', ');
    blockingReason = `Complete prerequisite(s) first: ${names}`;
  } else if (!windowOpen && program.registrationModel === RegistrationModel.Windowed) {
    blockingReason = 'Registration window not currently open or not yet confirmed';
  } else if (!windowOpen && program.registrationModel === RegistrationModel.Phased) {
    blockingReason = 'No confirmed open intake, awards are in a phased cycle';
  }

  return {
    canStart: prerequisitesMet && windowOpen,
    windowOpen,
    prerequisitesMet,
    missingPrerequisites: missing,
    blockingReason,
  };
}

/** Look up a tenant's progress status for a program, defaulting to NOT_STARTED. */
function progressFor(
  code: string,
  progressByCode: Record<string, ProgressStatus>,
  profile: TenantOnboardingProfile
): ProgressStatus {
  if (profile.completedProgramCodes.includes(code)) return ProgressStatus.Complete;
  return progressByCode[code] ?? ProgressStatus.NotStarted;
}

/**
 * Assemble the full onboarding plan for one tenant.
 * Ordering: by tier ascending (sequence first), then by relevance descending
 * within tier. The recommended next action is the lowest-tier incomplete program
 * the tenant can actually start, breaking ties by relevance.
 */
export function buildPlan(
  profile: TenantOnboardingProfile,
  progressByCode: Record<string, ProgressStatus> = {},
  now: Date = new Date(),
  programs: OnboardingProgram[] = ONBOARDING_PROGRAMS
): OnboardingPlan {
  const scored: ScoredProgram[] = programs.map((program) => {
    const relevanceScore = scoreRelevance(program, profile);
    const fitClass = classifyFit(program, profile);
    const gate = evaluateGate(program, profile, now);
    const progressStatus = progressFor(program.code, progressByCode, profile);
    return {
      program,
      relevanceScore,
      fitClass,
      gate,
      progressStatus,
      requiresVerification: program.verificationStatus === VerificationStatus.NeedsVerification,
    };
  });

  scored.sort((a, b) => {
    if (a.program.tier !== b.program.tier) return a.program.tier - b.program.tier;
    return b.relevanceScore - a.relevanceScore;
  });

  const incompleteActionable = scored
    .filter(
      (s) =>
        s.progressStatus !== ProgressStatus.Complete &&
        s.progressStatus !== ProgressStatus.NotApplicable &&
        s.gate.canStart
    )
    .sort((a, b) => {
      if (a.program.tier !== b.program.tier) return a.program.tier - b.program.tier;
      return b.relevanceScore - a.relevanceScore;
    });

  return {
    tenantId: profile.tenantId,
    generatedAt: now.toISOString(),
    programs: scored,
    unverifiedProgramCodes: scored.filter((s) => s.requiresVerification).map((s) => s.program.code),
    recommendedNextCode: incompleteActionable.length > 0 ? incompleteActionable[0].program.code : null,
  };
}

/** Codes whose seed data is stale relative to a max-age threshold, for the freshness job. */
export function findStaleProgramCodes(
  maxAgeDays: number,
  now: Date = new Date(),
  programs: OnboardingProgram[] = ONBOARDING_PROGRAMS
): string[] {
  const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
  return programs
    .filter((p) => {
      if (p.verificationStatus === VerificationStatus.NeedsVerification) return true;
      if (!p.lastVerifiedAt) return true;
      return new Date(p.lastVerifiedAt).getTime() < cutoff;
    })
    .map((p) => p.code);
}
