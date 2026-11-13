// =============================================================
// A notice without a NAICS code is benchmarked on its PSC instead: the same
// public awards, matched by Product/Service Code (exact, then category).
// Existing NAICS cohorts keep their identity (hash) unchanged.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, TestFirm } from '../../../test-utils/testClient'
import { buildAwardBenchmark, buildCohortHash } from './awardBenchmark'

const NOW = new Date()
const DAY = 86_400_000
const AGENCY = 'PSC Fallback Test Agency'
let firm: TestFirm

beforeAll(async () => {
  firm = await createTestFirm({ name: 'PSC Fallback Firm' })
  const amounts = [500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000, 1_100_000, 1_200_000]
  for (const [i, amount] of amounts.entries()) {
    const opp = await prisma.opportunity.create({ data: { consultingFirmId: firm.id, title: 'Past PSC award', agency: AGENCY, naicsCode: '', responseDeadline: new Date(NOW.getTime() - 400 * DAY), status: 'ARCHIVED' } })
    await prisma.awardHistory.create({ data: { opportunityId: opp.id, awardingAgency: AGENCY, recipientName: `R${i}`, awardAmount: new Prisma.Decimal(amount), awardDate: new Date(NOW.getTime() - 120 * DAY), naics: null, psc: i < 6 ? 'Z9QX' : 'Z9QY', awardType: 'DO', contractNumber: `PSC-${i}-${Math.random().toString(36).slice(2, 7)}` } })
  }
})
afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})

describe('PSC fallback for the award benchmark', () => {
  const req = (over: Record<string, unknown> = {}) => ({ consultingFirmId: firm.id, opportunityId: null, pricingWorkspaceId: null, pricingScenarioId: null, naics: null, agency: AGENCY, setAside: null, referencePrice: null, now: NOW, ...over })

  it('finds comparable awards by PSC when the notice has no NAICS, widening to the PSC category', async () => {
    const b = await buildAwardBenchmark(req({ psc: 'Z9QX' }))
    // Six exact PSC matches are below the minimum of 7, so it widens to the
    // category (Z…), which takes in all eight.
    expect(b.cohortSize).toBe(8)
    expect(b.distribution.median).not.toBeNull()
  })

  it('leaves the NAICS path and existing cohort hashes as they were', async () => {
    const args = { naics: '236220', agency: 'GSA', setAside: null, valueBandLow: null, valueBandHigh: null, periodStart: NOW, periodEnd: NOW, filterLevel: 'LEVEL_3_NAICS_BAND' as const, sourceIds: ['a', 'b'] }
    expect(buildCohortHash({ ...args, psc: null })).toBe(buildCohortHash(args))
    expect(buildCohortHash({ ...args, naics: null, psc: 'Z9QX' })).not.toBe(buildCohortHash({ ...args, naics: null }))
  })
})
