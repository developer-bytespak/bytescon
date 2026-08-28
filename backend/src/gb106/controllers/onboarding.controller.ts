/**
 * GB-106 Express controller. Thin HTTP layer over OnboardingService.
 * Validates input, maps the tenant context to a profile, and returns JSON.
 * Auth and tenant resolution are the host app's responsibility, see mount.gb106.ts.
 */

import type { Request, Response } from 'express';
import { OnboardingService } from '../services/onboarding.service';
import { ProgressStatus, TenantOnboardingProfile } from '../types/onboarding.types';

/**
 * Resolve a TenantOnboardingProfile from the request. The host injects
 * req.tenant (id, naics, sdvosb flag, etc.) via its own auth middleware.
 * This adapter keeps the module decoupled from the host's exact shape.
 */
export type TenantResolver = (req: Request) => TenantOnboardingProfile | null;

const isProgressStatus = (v: unknown): v is ProgressStatus =>
  typeof v === 'string' && (Object.values(ProgressStatus) as string[]).includes(v);

export class OnboardingController {
  constructor(
    private readonly service: OnboardingService,
    private readonly resolveTenant: TenantResolver
  ) {}

  /** GET /api/onboarding/plan, the scored, gated plan for the current tenant. */
  getPlan = async (req: Request, res: Response): Promise<void> => {
    const profile = this.resolveTenant(req);
    if (!profile) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }
    try {
      const plan = await this.service.getPlan(profile);
      res.status(200).json(plan);
    } catch (err) {
      res.status(500).json({ error: 'Failed to build onboarding plan' });
      // eslint-disable-next-line no-console
      console.error('[gb106] getPlan error', err);
    }
  };

  /** GET /api/onboarding/programs, the raw reference catalog. */
  listPrograms = async (_req: Request, res: Response): Promise<void> => {
    try {
      const programs = await this.service.getPrograms();
      res.status(200).json({ programs });
    } catch (err) {
      res.status(500).json({ error: 'Failed to load programs' });
      // eslint-disable-next-line no-console
      console.error('[gb106] listPrograms error', err);
    }
  };

  /** PUT /api/onboarding/progress, record progress on a program for the tenant. */
  updateProgress = async (req: Request, res: Response): Promise<void> => {
    const profile = this.resolveTenant(req);
    if (!profile) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }
    const { programCode, status, notes } = (req.body ?? {}) as {
      programCode?: unknown;
      status?: unknown;
      notes?: unknown;
    };
    if (typeof programCode !== 'string' || !isProgressStatus(status)) {
      res.status(400).json({ error: 'programCode (string) and a valid status are required' });
      return;
    }
    try {
      await this.service.setProgress(
        profile.tenantId,
        programCode,
        status,
        typeof notes === 'string' ? notes : undefined
      );
      const plan = await this.service.getPlan(profile);
      res.status(200).json(plan);
    } catch (err) {
      res.status(500).json({ error: 'Failed to update progress' });
      // eslint-disable-next-line no-console
      console.error('[gb106] updateProgress error', err);
    }
  };
}
