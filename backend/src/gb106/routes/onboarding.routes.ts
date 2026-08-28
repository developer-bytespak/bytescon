/**
 * GB-106 router. Builds an isolated Express Router for the onboarding endpoints.
 * No global side effects, the host mounts it under its chosen base path.
 */

import { Router } from 'express';
import { OnboardingController, TenantResolver } from '../controllers/onboarding.controller';
import { OnboardingService } from '../services/onboarding.service';

export function buildOnboardingRouter(service: OnboardingService, resolveTenant: TenantResolver): Router {
  const router = Router();
  const controller = new OnboardingController(service, resolveTenant);

  router.get('/plan', controller.getPlan);
  router.get('/programs', controller.listPrograms);
  router.put('/progress', controller.updateProgress);

  return router;
}
