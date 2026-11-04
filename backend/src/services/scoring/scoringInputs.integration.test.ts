// =============================================================
// One opportunity, one set of scoring inputs.
//
// The stored score and the live decision used to gather inputs separately, so
// the same opportunity could score differently depending on where you looked.
// Missing data must also stay visible to the engine as missing, not 0.5.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, type TestFirm } from '../../test-utils/testClient'
import { scoreOpportunityForClient } from '../../engines/probabilityEngine'
import { buildScoringInputs, type ScoringClient } from './scoringInputs'
import { evaluateBidDecision } from '../decisionEngine'

const client: ScoringClient = { naicsCodes: ['541512'], sdvosb: false, wosb: false, hubzone: false, smallBusiness: true }
const unknownAgency = `Agency with no profile ${Date.now()}`
const opportunity = { naicsCode: '999901', agency: unknownAgency, responseDeadline: new Date(Date.now() + 20 * 86_400_000) }

let firm: TestFirm
beforeAll(async () => { firm = await createTestFirm({ name: 'Scoring Inputs Firm' }) })
afterAll(async () => {
  await cleanupFirm(firm.id)
  await prisma.agencyAwardProfile.deleteMany({ where: { agencyName: { startsWith: 'Scoring inputs agency' } } })
  await prisma.naicsCompetitiveDensity.deleteMany({ where: { naicsCode: '999902' } })
  await disconnectDb()
})

describe('buildScoringInputs', () => {
  it('reports signals with no source data as missing', async () => {
    const inputs = await buildScoringInputs(opportunity, client)
    expect(inputs.agencyHistoryScore).toBeNull()
    expect(inputs.densityScore).toBeNull()
    expect(inputs.historicalDistribution).toBeNull()
  })

  it('always works out deadline urgency, because every opportunity has a deadline', async () => {
    expect((await buildScoringInputs(opportunity, client)).deadlineUrgencyScore).toBe(1)
  })

  it('reads the agency history and bidder density when they exist', async () => {
    const agency = `Scoring inputs agency ${Date.now()}`
    await prisma.agencyAwardProfile.create({
      data: { agencyName: agency, sdvosbRate: 0.1, womenOwnedRate: 0.1, hubzoneRate: 0.1, smallBizRate: 0.4 },
    })
    await prisma.naicsCompetitiveDensity.upsert({
      where: { naicsCode: '999902' },
      create: { naicsCode: '999902', avgBidders: 10, lastRefreshedAt: new Date() },
      update: { avgBidders: 10 },
    })
    const inputs = await buildScoringInputs({ ...opportunity, naicsCode: '999902', agency, offersReceived: 5 }, client)
    expect(inputs.agencyHistoryScore).toBeCloseTo(0.4)
    expect(inputs.densityScore).toBeCloseTo(0.75)
  })
})

describe('the live decision', () => {
  it('scores with the same inputs as the stored score', async () => {
    const agency = `Scoring inputs agency live ${Date.now()}`
    await prisma.agencyAwardProfile.create({
      data: { agencyName: agency, sdvosbRate: 0.1, womenOwnedRate: 0.1, hubzoneRate: 0.1, smallBizRate: 0.9 },
    })
    await prisma.naicsCompetitiveDensity.upsert({
      where: { naicsCode: '999902' },
      create: { naicsCode: '999902', avgBidders: 10, lastRefreshedAt: new Date() },
      update: { avgBidders: 10 },
    })
    const row = await prisma.clientCompany.create({
      data: { consultingFirmId: firm.id, name: 'Inputs Client', naicsCodes: ['999902'], smallBusiness: true },
    })
    const opp = await prisma.opportunity.create({
      data: {
        consultingFirmId: firm.id, samNoticeId: `inputs-${Date.now()}`, title: 'Inputs check', agency,
        naicsCode: '999902', offersReceived: 2, historicalAwardCount: 500,
        responseDeadline: new Date(Date.now() + 20 * 86_400_000), status: 'ACTIVE',
      },
    })
    const expected = scoreOpportunityForClient(await buildScoringInputs(opp, row))
    if (expected.status !== 'OK') throw new Error('expected an OK score')

    const decision = await evaluateBidDecision(opp.id, row.id)
    const live = (decision.explanationJson as { rawProbabilityScore: number }).rawProbabilityScore
    expect(live).toBeCloseTo(expected.rawScore, 6)

    // The inputs matter: scoring without the agency history and density differs.
    const without = scoreOpportunityForClient({ ...(await buildScoringInputs(opp, row)), agencyHistoryScore: null, densityScore: null })
    if (without.status !== 'OK') throw new Error('expected an OK score')
    expect(Math.abs(without.rawScore - live)).toBeGreaterThan(0.001)
  })
})
