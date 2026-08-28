/**
 * GB-106 service layer. Bridges the pure logic to Prisma and the host app.
 *
 * Dependency injection: the PrismaClient is passed in by the mount helper, so
 * this module never imports a singleton and never assumes the host's client
 * path. If the onboarding tables are unavailable, read paths fall back to the
 * static seed so the feature degrades to read-only rather than failing.
 */

import {
  OnboardingPlan,
  OnboardingProgram,
  ProgressStatus,
  TenantOnboardingProfile,
} from '../types/onboarding.types';
import { ONBOARDING_PROGRAMS } from '../data/onboarding.seed';
import { buildPlan, findStaleProgramCodes } from '../logic/onboarding.logic';

/** Minimal structural type for the Prisma client surface this module needs. */
export interface OnboardingPrisma {
  onboardingProgram: {
    findMany: (args?: unknown) => Promise<OnboardingProgram[]>;
    upsert: (args: unknown) => Promise<unknown>;
    count: () => Promise<number>;
  };
  onboardingProgress: {
    findMany: (args?: unknown) => Promise<Array<{ programCode: string; status: string }>>;
    upsert: (args: unknown) => Promise<unknown>;
  };
}

/** Structured logger surface. Defaults to console, host can inject pino/winston. */
export interface Logger {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

const defaultLogger: Logger = {
  // eslint-disable-next-line no-console
  info: (m, meta) => console.log(`[gb106] ${m}`, meta ?? ''),
  // eslint-disable-next-line no-console
  warn: (m, meta) => console.warn(`[gb106] ${m}`, meta ?? ''),
  // eslint-disable-next-line no-console
  error: (m, meta) => console.error(`[gb106] ${m}`, meta ?? ''),
};

export class OnboardingService {
  constructor(
    private readonly prisma: OnboardingPrisma | null,
    private readonly logger: Logger = defaultLogger
  ) {}

  /** Load programs from the database, falling back to the static seed on any failure. */
  async getPrograms(): Promise<OnboardingProgram[]> {
    if (!this.prisma) return ONBOARDING_PROGRAMS;
    try {
      const rows = await this.prisma.onboardingProgram.findMany({ orderBy: { tier: 'asc' } });
      if (!rows || rows.length === 0) {
        this.logger.warn('onboarding_programs empty, serving static seed');
        return ONBOARDING_PROGRAMS;
      }
      return rows;
    } catch (err) {
      this.logger.error('getPrograms failed, serving static seed', err);
      return ONBOARDING_PROGRAMS;
    }
  }

  /** Read this tenant's progress map (programCode -> status). */
  private async getProgressMap(tenantId: string): Promise<Record<string, ProgressStatus>> {
    if (!this.prisma) return {};
    try {
      const rows = await this.prisma.onboardingProgress.findMany({ where: { tenantId } });
      return rows.reduce<Record<string, ProgressStatus>>((acc, r) => {
        acc[r.programCode] = r.status as ProgressStatus;
        return acc;
      }, {});
    } catch (err) {
      this.logger.error('getProgressMap failed, treating all as NOT_STARTED', { tenantId, err });
      return {};
    }
  }

  /** Build the full, scored, gated onboarding plan for a tenant. */
  async getPlan(profile: TenantOnboardingProfile, now: Date = new Date()): Promise<OnboardingPlan> {
    const [programs, progress] = await Promise.all([this.getPrograms(), this.getProgressMap(profile.tenantId)]);
    return buildPlan(profile, progress, now, programs);
  }

  /** Record or update a tenant's progress against a program. */
  async setProgress(
    tenantId: string,
    programCode: string,
    status: ProgressStatus,
    notes?: string
  ): Promise<void> {
    if (!this.prisma) {
      this.logger.warn('setProgress called without a database, no-op', { tenantId, programCode });
      return;
    }
    const now = new Date();
    await this.prisma.onboardingProgress.upsert({
      where: { tenantId_programCode: { tenantId, programCode } },
      create: {
        tenantId,
        programCode,
        status,
        notes: notes ?? null,
        startedAt: status !== ProgressStatus.NotStarted ? now : null,
        completedAt: status === ProgressStatus.Complete ? now : null,
      },
      update: {
        status,
        notes: notes ?? null,
        completedAt: status === ProgressStatus.Complete ? now : null,
      },
    });
    this.logger.info('progress updated', { tenantId, programCode, status });
  }

  /** Seed or re-seed the reference table from the verified static dataset (idempotent upsert). */
  async seedPrograms(): Promise<number> {
    if (!this.prisma) {
      this.logger.warn('seedPrograms called without a database, no-op');
      return 0;
    }
    let count = 0;
    for (const p of ONBOARDING_PROGRAMS) {
      await this.prisma.onboardingProgram.upsert({
        where: { code: p.code },
        create: {
          ...p,
          nextWindowOpensAt: p.nextWindowOpensAt ? new Date(p.nextWindowOpensAt) : null,
          nextWindowClosesAt: p.nextWindowClosesAt ? new Date(p.nextWindowClosesAt) : null,
          lastVerifiedAt: p.lastVerifiedAt ? new Date(p.lastVerifiedAt) : null,
        },
        update: {
          name: p.name,
          shortName: p.shortName,
          tier: p.tier,
          category: p.category,
          administeringAgency: p.administeringAgency,
          description: p.description,
          officialUrl: p.officialUrl,
          prerequisites: p.prerequisites,
          keyRequirements: p.keyRequirements,
          relevanceTags: p.relevanceTags,
          coreFor: p.coreFor,
          registrationModel: p.registrationModel,
          nextWindowOpensAt: p.nextWindowOpensAt ? new Date(p.nextWindowOpensAt) : null,
          nextWindowClosesAt: p.nextWindowClosesAt ? new Date(p.nextWindowClosesAt) : null,
          verificationStatus: p.verificationStatus,
          lastVerifiedAt: p.lastVerifiedAt ? new Date(p.lastVerifiedAt) : null,
          sourceUrls: p.sourceUrls,
          notes: p.notes,
        },
      });
      count += 1;
    }
    this.logger.info(`seeded ${count} onboarding programs`);
    return count;
  }

  /** Return codes whose data should be re-verified (freshness job consumes this). */
  async getStaleProgramCodes(maxAgeDays: number, now: Date = new Date()): Promise<string[]> {
    const programs = await this.getPrograms();
    return findStaleProgramCodes(maxAgeDays, now, programs);
  }
}
