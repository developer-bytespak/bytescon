// =============================================================
// GB-106 — onboarding logic + seed verification (pure, no DB).
//
// Covers the task's GB-106 verification targets:
//   - GSA MAS Year-1 threshold rule (SPEC CONFLICT: the stored "$25,000/yr"
//     figure is pre-2024; the module carries the current verified
//     $100k/5yr -> $125k/5yr rule and does NOT gate entry on the legacy
//     figure). We assert the current rule is present and the legacy figure
//     is only referenced as superseded.
//   - Unconfirmed-timing items (TMSS 2.0, Polaris) route to the verification
//     queue and are NOT presented as current/actionable.
//   - Bytes Platform (NAICS 488510) channel ranking surfaces TMSS 2.0 (CORE)
//     and GSA MAS appropriately.
// =============================================================

import { describe, it, expect } from 'vitest'
import { buildPlan } from './logic/onboarding.logic'
import { ONBOARDING_PROGRAMS, PROGRAM_BY_CODE } from './data/onboarding.seed'
import { FitClass, ProgressStatus, TenantOnboardingProfile, VerificationStatus } from './types/onboarding.types'

const demoTenant: TenantOnboardingProfile = {
  tenantId: 'bytescon-demo-tenant',
  businessDomain: 'freight_brokerage',
  naicsCodes: ['488510'],
  isSdvosb: true,
  yearsInBusiness: 4,
  completedProgramCodes: ['SAM_REG', 'UEI', 'CAGE'],
}

describe('GB-106 GSA MAS Year-1 threshold rule', () => {
  const mas = PROGRAM_BY_CODE['GSA_MAS']

  it('carries the current verified sales minimum, not the legacy $25k/yr figure', () => {
    expect(mas).toBeTruthy()
    expect(mas.notes).toContain('$100,000')
    expect(mas.notes).toContain('$125,000')
    // The legacy figure appears only as an explicitly superseded reference.
    expect(mas.notes?.toUpperCase()).toContain('SUPERSEDES')
    // It is never encoded as an active requirement.
    expect(mas.keyRequirements.some((r) => r.includes('$25,000'))).toBe(false)
  })

  it('treats MAS as actionable now for a SAM-registered tenant (continuous intake)', () => {
    const plan = buildPlan(demoTenant)
    const masScored = plan.programs.find((s) => s.program.code === 'GSA_MAS')
    expect(masScored?.gate.canStart).toBe(true)
    expect(masScored?.gate.prerequisitesMet).toBe(true)
  })
})

describe('GB-106 verification-queue routing (unconfirmed timing)', () => {
  const plan = buildPlan(demoTenant)

  it('flags TMSS 2.0 and Polaris as NEEDS_VERIFICATION in the seed', () => {
    expect(PROGRAM_BY_CODE['TMSS_2_0'].verificationStatus).toBe(VerificationStatus.NeedsVerification)
    expect(PROGRAM_BY_CODE['POLARIS_SDVOSB'].verificationStatus).toBe(VerificationStatus.NeedsVerification)
  })

  it('routes both to the plan verification queue, not "current"', () => {
    expect(plan.unverifiedProgramCodes).toContain('TMSS_2_0')
    expect(plan.unverifiedProgramCodes).toContain('POLARIS_SDVOSB')
  })

  it('does not present unconfirmed-timing items as actionable', () => {
    const tmss = plan.programs.find((s) => s.program.code === 'TMSS_2_0')
    const polaris = plan.programs.find((s) => s.program.code === 'POLARIS_SDVOSB')
    expect(tmss?.gate.canStart).toBe(false)
    expect(tmss?.gate.blockingReason).toBeTruthy()
    expect(polaris?.gate.canStart).toBe(false)
    expect(tmss?.requiresVerification).toBe(true)
    expect(polaris?.requiresVerification).toBe(true)
  })

  it('leaves null window dates rather than inventing them', () => {
    expect(PROGRAM_BY_CODE['TMSS_2_0'].nextWindowOpensAt).toBeNull()
    expect(PROGRAM_BY_CODE['TMSS_2_0'].nextWindowClosesAt).toBeNull()
  })
})

describe('GB-106 Bytes Platform (NAICS 488510) channel ranking', () => {
  const plan = buildPlan(demoTenant)
  const vehicles = plan.programs.filter((s) => s.program.tier === 2)

  it('surfaces TMSS 2.0 as the top, CORE-fit vehicle', () => {
    const top = vehicles.reduce((best, cur) => (cur.relevanceScore > best.relevanceScore ? cur : best))
    expect(top.program.code).toBe('TMSS_2_0')
    expect(top.fitClass).toBe(FitClass.Core)
    expect(top.relevanceScore).toBeGreaterThanOrEqual(80)
  })

  it('keeps GSA MAS as a relevant secondary vehicle, above out-of-domain Polaris', () => {
    const mas = vehicles.find((s) => s.program.code === 'GSA_MAS')!
    const polaris = vehicles.find((s) => s.program.code === 'POLARIS_SDVOSB')!
    expect(mas.relevanceScore).toBeGreaterThan(polaris.relevanceScore)
    expect(polaris.fitClass).toBe(FitClass.Peripheral)
  })

  it('recommends the next actionable prerequisite (SBA VetCert)', () => {
    expect(plan.recommendedNextCode).toBe('SBA_VETCERT')
  })

  it('reports completed foundational steps as COMPLETE', () => {
    const sam = plan.programs.find((s) => s.program.code === 'SAM_REG')
    expect(sam?.progressStatus).toBe(ProgressStatus.Complete)
  })
})

describe('GB-106 seed integrity', () => {
  it('every program carries at least one source URL and a verification status', () => {
    for (const p of ONBOARDING_PROGRAMS) {
      expect(p.sourceUrls.length).toBeGreaterThan(0)
      expect([VerificationStatus.Verified, VerificationStatus.NeedsVerification]).toContain(p.verificationStatus)
    }
  })
})
