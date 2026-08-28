// =============================================================
// GB-106 host adapter — resolves a TenantOnboardingProfile for the
// onboarding module from this app's auth model.
//
// The module ships a placeholder resolver keyed on `req.tenant` (a shape
// this app does not have). This adapter bridges to the real auth context:
// authenticateJWT + enforceTenantScope populate req.user / the firm id,
// and this middleware loads the firm-derived profile the module needs.
//
// Conservative + honest derivation (no fabricated data):
//   - tenantId            = consultingFirmId from the JWT
//   - isSdvosb            = firm.isVeteranOwned (closest stored proxy)
//   - naicsCodes          = union of the firm's clients' NAICS codes
//   - businessDomain      = inferred from NAICS (freight if 488510 / 484x /
//                           488x / 493x present), else 'general_federal'
//   - yearsInBusiness     = 0 (not tracked on ConsultingFirm)
//   - completedProgramCodes = the firm's COMPLETE onboarding_progress rows
// =============================================================

import { Response, NextFunction } from 'express'
import { prisma } from '../config/database'
import { AuthenticatedRequest } from '../types'
import { getTenantId } from './tenant'
import { logger } from '../utils/logger'
import type { TenantOnboardingProfile } from '../gb106/types/onboarding.types'

// Local request augmentation — avoids a global d.ts; read back in server.ts.
export interface OnboardingRequest extends AuthenticatedRequest {
  onboardingProfile?: TenantOnboardingProfile | null
}

function inferBusinessDomain(naicsCodes: string[]): string {
  const isFreight = naicsCodes.some(
    (c) => c === '488510' || c.startsWith('484') || c.startsWith('488') || c.startsWith('493'),
  )
  return isFreight ? 'freight_brokerage' : 'general_federal'
}

export async function resolveOnboardingTenant(
  req: OnboardingRequest,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const firmId = getTenantId(req)
    if (!firmId) {
      req.onboardingProfile = null
      return next()
    }

    const [firm, clients, completed] = await Promise.all([
      prisma.consultingFirm.findUnique({ where: { id: firmId }, select: { isVeteranOwned: true } }),
      prisma.clientCompany.findMany({ where: { consultingFirmId: firmId }, select: { naicsCodes: true } }),
      // onboarding_progress may be unseeded/empty — never let it block the request.
      prisma.onboardingProgress
        .findMany({ where: { tenantId: firmId, status: 'COMPLETE' }, select: { programCode: true } })
        .catch(() => [] as { programCode: string }[]),
    ])

    const naicsCodes = Array.from(new Set(clients.flatMap((c) => c.naicsCodes ?? [])))

    req.onboardingProfile = {
      tenantId: firmId,
      businessDomain: inferBusinessDomain(naicsCodes),
      naicsCodes,
      isSdvosb: !!firm?.isVeteranOwned,
      yearsInBusiness: 0,
      completedProgramCodes: completed.map((c) => c.programCode),
    }
    next()
  } catch (err) {
    logger.error('Failed to resolve onboarding tenant', { error: (err as Error).message })
    // Degrade safely: no profile -> controller returns 401, never a 500 cascade.
    req.onboardingProfile = null
    next()
  }
}
