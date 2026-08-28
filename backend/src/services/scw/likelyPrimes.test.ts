// =============================================================
// SCW-1 likelyPrimes integration tests
//
// Spec §6 Phase 2 exit criteria require coverage for:
//   - Happy path (opportunity with multiple historical primes)
//   - Empty path (NAICS with no historical awards)
//   - Tenant isolation (Tenant A request cannot return Tenant B's primes)
//   - SDVOSB exclusion (SDVOSB primes filtered out)
//
// We mock prisma at module scope so the service under test can be driven
// with deterministic SQL row fixtures.
// =============================================================

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../config/database', () => ({
  prisma: {
    opportunity: { findFirst: vi.fn() },
    recipientProfile: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { findLikelyPrimes } from './likelyPrimes'
import { prisma } from '../../config/database'

const TENANT_A = '34a4e6db-6422-4cd4-9c99-e9aaa4d3f067'
const TENANT_B = 'be68e12e-c855-49ba-9f65-5a25f1d9e69b'

function makeOpp(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'opp-1',
    naicsCode: '236220',
    agency: 'General Services Administration',
    subagency: null,
    setAsideType: 'SDVOSB',
    postedDate: new Date('2026-05-01'),
    responseDeadline: new Date('2026-06-10'),
    ...over,
  }
}

const HENSEL = {
  prime_name: 'HENSEL PHELPS CONSTRUCTION CO.',
  prime_uei: 'HENSEL00000UEI',
  past_awards_count: BigInt(3),
  total_past_value: '854897526.00',
  most_recent_award: new Date('2024-09-20'),
}
const BRASFIELD = {
  prime_name: 'BRASFIELD & GORRIE LLC',
  prime_uei: null,
  past_awards_count: BigInt(2),
  total_past_value: '475942562.23',
  most_recent_award: new Date('2024-12-13'),
}
const SDVOSB_PRIME = {
  prime_name: 'SDVOSB COMPETITOR LLC',
  prime_uei: 'SDVOSB000000001',
  past_awards_count: BigInt(2),
  total_past_value: '15000000',
  most_recent_award: new Date('2025-06-01'),
}

beforeEach(() => {
  vi.clearAllMocks()
})

// =============================================================
// Tenant isolation
// =============================================================

describe('tenant isolation', () => {
  it('throws NotFoundError when opportunity belongs to a different tenant', async () => {
    // The service queries with `where: { id, consultingFirmId }` — when the
    // opportunity exists under Tenant B but the request comes from Tenant A,
    // findFirst returns null, and we throw NotFound (never 403 — that would
    // leak existence of a cross-tenant row).
    ;(prisma.opportunity.findFirst as any).mockResolvedValue(null)

    // Check via statusCode + code rather than instance/name. AppError's
    // constructor does Object.setPrototypeOf(this, AppError.prototype) which
    // wipes the subclass identity, so instanceof and .name don't survive —
    // pre-existing platform quirk, not our bug to fix here. The wire-level
    // contract (404 + NOT_FOUND code) is what the error handler middleware
    // and the spec actually depend on.
    await expect(
      findLikelyPrimes({ opportunityId: 'opp-1', consultingFirmId: TENANT_A }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' })

    // And critically — no winners corpus query should run when the gate fails.
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
    expect(prisma.recipientProfile.findMany).not.toHaveBeenCalled()
  })

  it('passes consultingFirmId into the opportunity lookup', async () => {
    ;(prisma.opportunity.findFirst as any).mockResolvedValue(makeOpp())
    ;(prisma.$queryRaw as any).mockResolvedValue([])

    await findLikelyPrimes({ opportunityId: 'opp-1', consultingFirmId: TENANT_A })

    expect(prisma.opportunity.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'opp-1', consultingFirmId: TENANT_A }),
      }),
    )
  })
})

// =============================================================
// Empty path
// =============================================================

describe('empty path', () => {
  it('returns [] when the opportunity has no NAICS code', async () => {
    ;(prisma.opportunity.findFirst as any).mockResolvedValue(makeOpp({ naicsCode: '' }))

    const result = await findLikelyPrimes({ opportunityId: 'opp-1', consultingFirmId: TENANT_A })
    expect(result).toEqual([])
    // Should not even attempt the corpus query.
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('returns [] when winners_award_stage has no candidates in the window', async () => {
    ;(prisma.opportunity.findFirst as any).mockResolvedValue(makeOpp())
    ;(prisma.$queryRaw as any).mockResolvedValue([])

    const result = await findLikelyPrimes({ opportunityId: 'opp-1', consultingFirmId: TENANT_A })
    expect(result).toEqual([])
  })
})

// =============================================================
// Happy path
// =============================================================

describe('happy path', () => {
  it('returns ranked primes with full decomposition + warnings', async () => {
    ;(prisma.opportunity.findFirst as any).mockResolvedValue(makeOpp())
    // Pass 1: candidate aggregation
    ;(prisma.$queryRaw as any)
      .mockResolvedValueOnce([HENSEL, BRASFIELD]) // pass 1: candidates
      .mockResolvedValueOnce([])                  // pass 3: subaward stats (none)
    ;(prisma.recipientProfile.findMany as any).mockResolvedValue([])

    const result = await findLikelyPrimes({ opportunityId: 'opp-1', consultingFirmId: TENANT_A })

    expect(result).toHaveLength(2)
    // Hensel has more awards + higher $$ → higher composite.
    expect(result[0].primeName).toBe('HENSEL PHELPS CONSTRUCTION CO.')
    expect(result[0].confidence.composite).toBeGreaterThan(result[1].confidence.composite)

    // Every prime carries the full component breakdown.
    expect(result[0].confidence.components).toMatchObject({
      awardFrequency: expect.objectContaining({ raw: 1.0 }),
      awardRecency: expect.any(Object),
      dollarVolume: expect.objectContaining({ raw: 1.0 }), // top scorer
      subawardPropensity: expect.objectContaining({ confidence: 0 }),
      sdvosbGoalGap: expect.objectContaining({ confidence: 0 }),
    })

    // Citation must be set per spec §2.2 "cite the data source".
    expect(result[0].confidence.citation).toMatch(/USAspending V2 corpus/)
    expect(result[0].confidence.citation).toMatch(/NAICS 236220/)

    // No silent failures — at minimum, the unverified-SDVOSB and missing-
    // subaward-history warnings must appear.
    const warningsBlob = result[0].dataQuality.warnings.join(' | ')
    expect(warningsBlob).toMatch(/SDVOSB status unverified/)
    expect(warningsBlob).toMatch(/No subaward history/)
  })

  it('contact source is manual_research_required when no RecipientProfile', async () => {
    ;(prisma.opportunity.findFirst as any).mockResolvedValue(makeOpp())
    ;(prisma.$queryRaw as any)
      .mockResolvedValueOnce([HENSEL])
      .mockResolvedValueOnce([])
    ;(prisma.recipientProfile.findMany as any).mockResolvedValue([])

    const result = await findLikelyPrimes({ opportunityId: 'opp-1', consultingFirmId: TENANT_A })
    expect(result[0].contact.source).toBe('manual_research_required')
    expect(result[0].contact.name).toBeNull()
    expect(result[0].contact.email).toBeNull()
  })
})

// =============================================================
// SDVOSB exclusion
// =============================================================

describe('SDVOSB exclusion', () => {
  it('drops primes flagged sdvosb in RecipientProfile', async () => {
    ;(prisma.opportunity.findFirst as any).mockResolvedValue(makeOpp())
    ;(prisma.$queryRaw as any)
      .mockResolvedValueOnce([HENSEL, SDVOSB_PRIME])
      .mockResolvedValueOnce([])
    // Both Hensel and SDVOSB_PRIME have UEIs — profile lookup hits.
    ;(prisma.recipientProfile.findMany as any).mockResolvedValue([
      {
        uei: 'HENSEL00000UEI',
        legalName: 'Hensel Phelps',
        phone: null,
        contactsJson: null,
        contactsFetchedAt: null,
        sdvosb: false,
        wosb: false,
        hubzone: false,
        smallBusiness: false,
        vaOsdbuVerified: false,
        samFetchedAt: new Date(),
      },
      {
        uei: 'SDVOSB000000001',
        legalName: 'SDVOSB Competitor LLC',
        phone: null,
        contactsJson: null,
        contactsFetchedAt: null,
        sdvosb: true,
        wosb: false,
        hubzone: false,
        smallBusiness: true,
        vaOsdbuVerified: false,
        samFetchedAt: new Date(),
      },
    ])

    const result = await findLikelyPrimes({ opportunityId: 'opp-1', consultingFirmId: TENANT_A })
    expect(result.map((p) => p.primeName)).toEqual(['HENSEL PHELPS CONSTRUCTION CO.'])
  })

  it('includes primes without RecipientProfile but flags them as unverified', async () => {
    // Spec §2.5: no silent failures. A prime we can't classify is included
    // but the unverified state is surfaced.
    ;(prisma.opportunity.findFirst as any).mockResolvedValue(makeOpp())
    ;(prisma.$queryRaw as any)
      .mockResolvedValueOnce([HENSEL]) // UEI present but no profile row
      .mockResolvedValueOnce([])
    ;(prisma.recipientProfile.findMany as any).mockResolvedValue([])

    const result = await findLikelyPrimes({ opportunityId: 'opp-1', consultingFirmId: TENANT_A })
    expect(result).toHaveLength(1)
    expect(result[0].sdvosbCertified).toBe(false)
    expect(result[0].dataQuality.warnings.join(' | ')).toMatch(/SDVOSB status unverified/)
  })
})
