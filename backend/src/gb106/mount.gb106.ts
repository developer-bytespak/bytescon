/**
 * GB-106 mount helper. One call wires the entire module into the host app:
 * routes, service, and (optionally) the freshness job. No existing source files
 * are modified, the host adds a single import and a single mountGB106(...) call.
 *
 * Example (host server bootstrap):
 *
 *   import { mountGB106 } from './gb106/mount.gb106';
 *   mountGB106({
 *     app,
 *     prisma,
 *     basePath: '/api/onboarding',
 *     resolveTenant: (req) => req.tenant
 *       ? {
 *           tenantId: req.tenant.id,
 *           businessDomain: req.tenant.businessDomain ?? 'freight_brokerage',
 *           naicsCodes: req.tenant.naicsCodes ?? [],
 *           isSdvosb: !!req.tenant.isSdvosb,
 *           yearsInBusiness: req.tenant.yearsInBusiness ?? 0,
 *           completedProgramCodes: req.tenant.completedProgramCodes ?? [],
 *         }
 *       : null,
 *   });
 */

import type { Express } from 'express';
import { buildOnboardingRouter } from './routes/onboarding.routes';
import { OnboardingService, OnboardingPrisma, Logger } from './services/onboarding.service';
import type { TenantResolver } from './controllers/onboarding.controller';
import { registerFreshnessJob, QueueLike, WorkerFactory } from './jobs/onboarding.freshness.job';

export interface MountOptions {
  app: Express;
  resolveTenant: TenantResolver;
  prisma?: OnboardingPrisma | null;
  basePath?: string;
  logger?: Logger;
  /** Provide both to enable the daily freshness scan. Omit to skip the job. */
  freshness?: {
    queue: QueueLike;
    createWorker: WorkerFactory;
    maxAgeDays?: number;
    cron?: string;
  };
}

export interface MountResult {
  service: OnboardingService;
  basePath: string;
}

export function mountGB106(opts: MountOptions): MountResult {
  const basePath = opts.basePath ?? '/api/onboarding';
  const service = new OnboardingService(opts.prisma ?? null, opts.logger);

  opts.app.use(basePath, buildOnboardingRouter(service, opts.resolveTenant));

  if (opts.freshness) {
    // Fire and forget, errors are logged but never block server startup.
    void registerFreshnessJob({
      queue: opts.freshness.queue,
      createWorker: opts.freshness.createWorker,
      service,
      logger:
        opts.logger ?? {
          // eslint-disable-next-line no-console
          info: (m, meta) => console.log(`[gb106] ${m}`, meta ?? ''),
          // eslint-disable-next-line no-console
          warn: (m, meta) => console.warn(`[gb106] ${m}`, meta ?? ''),
          // eslint-disable-next-line no-console
          error: (m, meta) => console.error(`[gb106] ${m}`, meta ?? ''),
        },
      maxAgeDays: opts.freshness.maxAgeDays,
      cron: opts.freshness.cron,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[gb106] failed to register freshness job', err);
    });
  }

  return { service, basePath };
}
