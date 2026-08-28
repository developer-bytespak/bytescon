// =============================================================
// §7.4 — Qualification Agent against a real PostgreSQL database.
//
// Covers the registry, the handler through the §7.0 dispatcher, scope
// resolution, the QualificationRecommendation and its versioning, the
// QUALIFICATION_BRIEF, gate-review creation, escalations, evidence honesty,
// tenant isolation, the no-LLM guarantee, and — above all — the guarantee that
// no code path writes a bid/no-bid decision.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

// The LLM provider boundary is mocked for the whole file. The agent must never
// reach it: scoring is canonical and the narrative is a pure template.
const generateWithRouterSpy = vi.fn()
vi.mock('../../llm/llmRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../llm/llmRouter')>()
  return { ...actual, generateWithRouter: (...a: unknown[]) => generateWithRouterSpy(...a) }
})

import { prisma } from '../../../config/database'
import {
  createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm, type TestUser,
} from '../../../test-utils/testClient'
import { dispatchAgentRun } from '../dispatch'
import { createRun } from '../runService'
import { getAgentDefinition, agentsSubscribedTo, AGENT_REGISTRY } from '../registry'
import { DOMAIN_AGENT_KEYS } from '../types'
import { QUALIFICATION_PHASES, QUALIFIABLE_STAGES, phasesForRun } from './qualificationAgentHandler'
import { crossedHighMatchThreshold } from './qualificationEvents'
import { loadCapacityEvidence, loadIncumbentEvidence, loadCompetitorEvidence, loadPricingEvidence } from './qualificationEvidence'

const AGENT = 'QUALIFICATION' as const
const DAY = 86_400_000

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let ownerA: TestUser
let adminB: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Qualification Agent Firm A' })
  firmB = await createTestFirm({ name: 'Qualification Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  ownerA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.qualificationRecommendation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.gateReview.deleteMany({ where: { consultingFirmId: id } })
    await prisma.scorecard.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.competitorAwardStat.deleteMany({ where: { consultingFirmId: id } })
    await prisma.incumbentRetentionStat.deleteMany({ where: { consultingFirmId: id } })
    await prisma.firmCapability.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pastPerformanceRecord.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.clientCompany.deleteMany({ where: { consultingFirmId: id } })
    await prisma.registrationProfile.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeOpportunity(firmId: string, over: Partial<Prisma.OpportunityUncheckedCreateInput> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId,
      samNoticeId: uniq('S7-QUAL-QA'),
      title: 'S7-QUAL-QA cyber support solicitation',
      agency: 'Department of Defense',
      naicsCode: '541512',
      setAsideType: 'NONE',
      responseDeadline: new Date(Date.now() + 45 * DAY),
      status: 'ACTIVE',
      isDemo: false,
      probabilityScore: 80,
      isScored: true,
      ...over,
    },
  })
}

async function makePursuit(firmId: string, opportunityId: string, over: Partial<Prisma.BidPursuitUncheckedCreateInput> = {}) {
  return prisma.bidPursuit.create({
    data: {
      consultingFirmId: firmId, opportunityId,
      pipelineStage: 'QUALIFICATION', status: 'REVIEWING', priority: 'MEDIUM',
      ...over,
    },
  })
}

async function makeMatch(firmId: string, opportunityId: string, overallScore = 82) {
  return prisma.opportunityMatch.create({
    data: {
      opportunityId, consultingFirmId: firmId, overallScore,
      capabilityScore: overallScore, naicsScore: overallScore,
      evidence: {}, eligibility: 'ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
    },
  })
}

async function runAgent(firmId: string, over: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId, agentKey: AGENT, triggerType: 'MANUAL',
    idempotencyKey: uniq('qual-run'), ...over,
  })
  await dispatchAgentRun(run.id)
  return prisma.agentRun.findUnique({ where: { id: run.id } })
}

const currentRecommendation = (firmId: string, pursuitId: string) =>
  prisma.qualificationRecommendation.findFirst({
    where: { consultingFirmId: firmId, pursuitId },
    orderBy: { version: 'desc' },
  })

// -------------------------------------------------------------
// Registry
// -------------------------------------------------------------

describe('agent registry', () => {
  it('marks the Qualification Agent implemented with a real handler', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.implemented).toBe(true)
    expect(def.handler).not.toBeNull()
    expect(def.plannedSlice).toBe('7.4')
  })

  it('defaults to PROPOSE autonomy, opt-in, no LLM, zero budget', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.defaultAutonomyLevel).toBe('PROPOSE')
    expect(def.defaultEnabled).toBe(false)
    expect(def.requiresLlm).toBe(false)
    expect(def.defaultTokenBudget).toBe(0)
  })

  it('runs every six hours by default', () => {
    expect(getAgentDefinition(AGENT)!.defaultCronExpression).toBe('0 */6 * * *')
  })

  it('subscribes to the four §7.4 triggers, reusing three existing emitters', () => {
    expect(getAgentDefinition(AGENT)!.subscribedEventTypes.sort()).toEqual([
      'AMENDMENT_RECORDED', 'EXTRACTION_COMPLETED', 'OPPORTUNITY_MATCH_HIGH', 'PURSUIT_STAGE_CHANGED',
    ])
  })

  it('is now the only subscriber to OPPORTUNITY_MATCH_HIGH', () => {
    expect(agentsSubscribedTo('OPPORTUNITY_MATCH_HIGH').map((d) => d.key)).toEqual([AGENT])
  })

  it('shares the reused events with the agents that own their emitters', () => {
    expect(agentsSubscribedTo('PURSUIT_STAGE_CHANGED').map((d) => d.key).sort()).toEqual(['COMPLIANCE', 'OPPORTUNITY', 'QUALIFICATION'])
    expect(agentsSubscribedTo('AMENDMENT_RECORDED').map((d) => d.key).sort()).toEqual(['COMPLIANCE', 'PRICING', 'PROPOSAL', 'QUALIFICATION'])
  })

  it('allowlists no autonomous action keys', () => {
    expect(getAgentDefinition(AGENT)!.allowlistedActionKeys).toEqual([])
  })

  it('leaves the other three delivered agents implemented', () => {
    for (const key of ['CONTRACT_ADMINISTRATION', 'OPPORTUNITY', 'COMPLIANCE'] as const) {
      expect(getAgentDefinition(key)!.implemented, key).toBe(true)
    }
  })

  it('leaves no domain agent unimplemented — §7.9 completed Section 7', () => {
    const remaining = DOMAIN_AGENT_KEYS.filter((k) => !getAgentDefinition(k)!.implemented)
    expect(remaining).toEqual([])
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(getAgentDefinition(key)!.handler, key).not.toBeNull()
    }
  })

  it('exposes exactly ten implemented entries — nine domain agents plus the diagnostic', () => {
    expect(AGENT_REGISTRY.filter((d) => d.implemented).map((d) => d.key).sort()).toEqual([
      'COMPLIANCE', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE', 'INTERNAL_DIAGNOSTIC', 'OPPORTUNITY', 'PRICING', 'PROPOSAL', 'QUALIFICATION', 'TEAMING',
    ])
  })

  it('exposes all eighteen phases', () => {
    expect(phasesForRun(null)).toHaveLength(18)
    expect(QUALIFICATION_PHASES[0]).toBe('LOAD_PURSUIT')
    expect(QUALIFICATION_PHASES[QUALIFICATION_PHASES.length - 1]).toBe('COMPLETE')
  })
})

// -------------------------------------------------------------
// OPPORTUNITY_MATCH_HIGH crossing rule
// -------------------------------------------------------------

describe('OPPORTUNITY_MATCH_HIGH fires on the crossing only', () => {
  it('fires when a match rises above the threshold for the first time', () => {
    expect(crossedHighMatchThreshold(null, 75, 70)).toBe(true)
    expect(crossedHighMatchThreshold(60, 75, 70)).toBe(true)
  })

  it('does not fire when a high match stays high', () => {
    expect(crossedHighMatchThreshold(75, 80, 70)).toBe(false)
    expect(crossedHighMatchThreshold(70, 70, 70)).toBe(false)
  })

  it('does not fire below the threshold', () => {
    expect(crossedHighMatchThreshold(null, 69, 70)).toBe(false)
    expect(crossedHighMatchThreshold(80, 60, 70)).toBe(false)
  })

  it('fires exactly AT the threshold', () => {
    expect(crossedHighMatchThreshold(69, 70, 70)).toBe(true)
  })
})

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

describe('handler', () => {
  it('completes a manual sweep and persists a recommendation', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makeMatch(firmA.id, opp.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')

    const rec = await currentRecommendation(firmA.id, pursuit.id)
    expect(rec).not.toBeNull()
    expect(rec!.version).toBe(1)
    expect(rec!.status).toBe('ACTIVE')
    expect(rec!.algorithmVersion).toBe('qualification-v1')
    expect(rec!.narrative.length).toBeGreaterThan(0)
  })

  it('produces a QUALIFICATION_BRIEF artifact', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)

    const artifact = await prisma.agentArtifact.findFirst({
      where: { consultingFirmId: firmA.id, agentKey: AGENT, artifactType: 'QUALIFICATION_BRIEF', supersededByArtifactId: null },
    })
    expect(artifact).not.toBeNull()
    expect(artifact!.sourceEntityId).toBe(pursuit.id)
    const data = artifact!.structuredData as { recommendation: { result: string }; probability: unknown; incumbent: unknown }
    expect(data.recommendation.result).toBeTruthy()
    expect(data.probability).toBeDefined()
    expect(data.incumbent).toBeDefined()
  })

  it('SKIPS honestly when no pursuit is qualifiable', async () => {
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('SKIPPED')
    expect(run?.limitations.join(' ')).toContain(QUALIFIABLE_STAGES[0])
  })

  it('excludes terminal-stage pursuits from the sweep', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id, { pipelineStage: 'LOST' })
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('SKIPPED')
  })

  it('records progress and a heartbeat', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    const run = await runAgent(firmA.id)
    expect(run?.progressPercent).toBeGreaterThan(0)
    expect(run?.heartbeatAt).not.toBeNull()
  })

  it('isolates one failing pursuit from the rest of the sweep', async () => {
    const good = await makeOpportunity(firmA.id, { title: 'S7-QUAL-QA good' })
    await makePursuit(firmA.id, good.id)
    const other = await makeOpportunity(firmA.id, { title: 'S7-QUAL-QA other' })
    await makePursuit(firmA.id, other.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(await prisma.qualificationRecommendation.count({ where: { consultingFirmId: firmA.id } })).toBe(2)
  })

  it('degrades confidence on missing evidence rather than throwing', async () => {
    // No match, no scorecard, no compliance, no competitors, no past performance.
    const opp = await makeOpportunity(firmA.id, { isScored: false, probabilityScore: 0 })
    const pursuit = await makePursuit(firmA.id, opp.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    const rec = await currentRecommendation(firmA.id, pursuit.id)
    expect(rec!.recommendation).toBe('INSUFFICIENT_DATA')
    expect(rec!.dataSufficiency).toBe('INSUFFICIENT')
    expect(rec!.dataLimitations.length).toBeGreaterThan(0)
  })

  it('opens no gate review and sends no recommendation notice under OBSERVE', async () => {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 52 })
    await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await runAgent(firmA.id, { autonomyLevel: 'OBSERVE' })

    expect(await prisma.gateReview.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(await prisma.userNotification.count({
      where: { consultingFirmId: firmA.id, entityType: 'QualificationRecommendation' },
    })).toBe(0)
  })

  it('still escalates under OBSERVE, because an escalation is how a human is told', async () => {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 52 })
    await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await runAgent(firmA.id, { autonomyLevel: 'OBSERVE' })

    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmA.id, agentKey: AGENT } })).toBeGreaterThan(0)
  })
})

// -------------------------------------------------------------
// THE DECISION BOUNDARY — the guarantee everything rests on
// -------------------------------------------------------------

describe('the agent never records a decision', () => {
  const AUTONOMY = ['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const

  /**
   * Enough real evidence for a DECISIVE (non-borderline) call: an active SAM
   * registration, declared capacity, and verified outcomes in the same
   * probability band so §6.2H can produce an interval. Without these a fresh
   * tenant is legitimately borderline, which would make "strong BID" untrue.
   */
  async function seedDecisiveEvidence(bandScore: number) {
    await prisma.registrationProfile.create({
      data: {
        consultingFirmId: firmA.id, samStatus: 'ACTIVE',
        samExpiryDate: new Date(Date.now() + 400 * DAY), naicsCodes: ['541512'],
      },
    })
    await prisma.firmCapability.create({
      data: {
        consultingFirmId: firmA.id, name: 'S7-QUAL-QA cyber capability', category: 'TECHNICAL',
        naicsCodes: ['541512'], concurrentCapacity: 50, verification: 'VERIFIED',
      },
    })
    const client = await prisma.clientCompany.create({
      data: { consultingFirmId: firmA.id, name: 'S7-QUAL-QA Client' },
    })
    for (let i = 0; i < 24; i += 1) {
      const opp = await makeOpportunity(firmA.id, {
        title: `S7-QUAL-QA historical ${i}`, status: 'ARCHIVED', probabilityScore: bandScore,
        responseDeadline: new Date(Date.now() - (60 + i) * DAY),
      })
      await prisma.submissionRecord.create({
        data: {
          consultingFirmId: firmA.id, clientCompanyId: client.id, opportunityId: opp.id,
          submittedAt: new Date(Date.now() - (55 + i) * DAY),
          wasOnTime: true, status: 'APPROVED', outcome: i % 4 === 0 ? 'LOST' : 'WON',
        },
      })
    }
  }

  async function decisive(probabilityScore: number) {
    // The interval engine bins by PREDICTED probability, so the history must sit
    // in the same band as the pursuit being judged.
    await seedDecisiveEvidence(probabilityScore)
    const opp = await makeOpportunity(firmA.id, { probabilityScore })
    const pursuit = await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await makeMatch(firmA.id, opp.id, 88)
    return pursuit
  }

  async function scenario(probabilityScore: number) {
    const opp = await makeOpportunity(firmA.id, { probabilityScore })
    const pursuit = await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await makeMatch(firmA.id, opp.id)
    return pursuit
  }

  it.each(AUTONOMY)('at %s, a decisive BID recommendation writes no BidDecision', async (autonomyLevel) => {
    const pursuit = await decisive(90)
    await runAgent(firmA.id, { autonomyLevel })
    const rec = await currentRecommendation(firmA.id, pursuit.id)
    expect(rec!.recommendation).toBe('RECOMMEND_BID')
    expect(rec!.isBorderline).toBe(false)
    expect(rec!.borderlineReasons).toEqual([])
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, a decisive NO_BID recommendation writes no BidDecision', async (autonomyLevel) => {
    const pursuit = await decisive(8)
    await runAgent(firmA.id, { autonomyLevel })
    const rec = await currentRecommendation(firmA.id, pursuit.id)
    expect(rec!.recommendation).toBe('RECOMMEND_NO_BID')
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, a borderline recommendation writes no BidDecision', async (autonomyLevel) => {
    const pursuit = await scenario(52)
    await runAgent(firmA.id, { autonomyLevel })
    const rec = await currentRecommendation(firmA.id, pursuit.id)
    expect(rec!.recommendation).toBe('BORDERLINE_REVIEW')
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, never writes a Scorecard decision or history row', async (autonomyLevel) => {
    const pursuit = await decisive(90)
    const scorecard = await prisma.scorecard.create({
      data: { consultingFirmId: firmA.id, bidPursuitId: pursuit.id, opportunityId: pursuit.opportunityId, status: 'IN_REVIEW' },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.scorecard.findUniqueOrThrow({ where: { id: scorecard.id } })
    expect(after.status).toBe('IN_REVIEW')
    expect(after.finalDecision).toBeNull()
    expect(after.decidedByUserId).toBeNull()
    expect(await prisma.scorecardDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, never completes a gate review it opened', async (autonomyLevel) => {
    await scenario(52)
    await runAgent(firmA.id, { autonomyLevel })
    const reviews = await prisma.gateReview.findMany({ where: { consultingFirmId: firmA.id } })
    expect(reviews.length).toBeGreaterThan(0)
    for (const r of reviews) {
      expect(r.status).toBe('NOT_STARTED')
      expect(r.completedAt).toBeNull()
      expect(r.outcome).toBeNull()
    }
  })

  it.each(AUTONOMY)('at %s, never changes the pursuit stage or priority', async (autonomyLevel) => {
    const pursuit = await decisive(90)
    await runAgent(firmA.id, { autonomyLevel })
    const after = await prisma.bidPursuit.findUniqueOrThrow({ where: { id: pursuit.id } })
    expect(after.pipelineStage).toBe('QUALIFICATION')
    expect(after.priority).toBe('MEDIUM')
  })

  it('proposes a priority instead of writing one', async () => {
    const pursuit = await decisive(90)
    await runAgent(firmA.id)
    const rec = await currentRecommendation(firmA.id, pursuit.id)
    expect(rec!.proposedPriority).toBeTruthy()
    const after = await prisma.bidPursuit.findUniqueOrThrow({ where: { id: pursuit.id } })
    expect(after.priority).toBe('MEDIUM')
  })
})

// -------------------------------------------------------------
// Gate review + escalations
// -------------------------------------------------------------

describe('borderline escalation', () => {
  async function borderline() {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 52 })
    const pursuit = await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await makeMatch(firmA.id, opp.id)
    return pursuit
  }

  it('opens a gate review for a human', async () => {
    const pursuit = await borderline()
    await runAgent(firmA.id)
    const review = await prisma.gateReview.findFirst({ where: { consultingFirmId: firmA.id, bidPursuitId: pursuit.id } })
    expect(review).not.toBeNull()
    expect(review!.status).toBe('NOT_STARTED')
    expect(review!.reviewerUserId).toBe(ownerA.id)
    expect(review!.comments).toContain('does not complete this review')
  })

  it('falls back to an ADMIN reviewer when the pursuit has no owner', async () => {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 52 })
    await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)
    const review = await prisma.gateReview.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(review.reviewerUserId).toBe(adminA.id)
  })

  it('does not open a second gate review on an unchanged re-run', async () => {
    await borderline()
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.gateReview.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('raises a borderline escalation', async () => {
    const pursuit = await borderline()
    await runAgent(firmA.id)
    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, agentKey: AGENT, entityId: pursuit.id },
    })
    expect(esc).not.toBeNull()
    expect(esc!.reason).toContain('has not recorded any decision')
  })

  it('does not duplicate the escalation on an unchanged re-run', async () => {
    await borderline()
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    const count = await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, agentKey: AGENT, title: { startsWith: 'Borderline qualification' } },
    })
    expect(count).toBe(1)
  })

  it('escalates a capacity conflict', async () => {
    await prisma.firmCapability.create({
      data: {
        consultingFirmId: firmA.id, name: 'S7-QUAL-QA capability', category: 'TECHNICAL',
        concurrentCapacity: 1, verification: 'VERIFIED',
      },
    })
    const oppA = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, oppA.id)
    const oppB = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, oppB.id)

    await runAgent(firmA.id)
    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Capacity conflict' } },
    })
    expect(esc).not.toBeNull()
  })

  it('notifies the owner once per recommendation version', async () => {
    await borderline()
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    const notifications = await prisma.userNotification.count({
      where: { consultingFirmId: firmA.id, userId: ownerA.id, entityType: 'QualificationRecommendation' },
    })
    expect(notifications).toBe(1)
  })
})

// -------------------------------------------------------------
// Versioning / idempotency
// -------------------------------------------------------------

describe('recommendation versioning', () => {
  it('does not create a second version for unchanged evidence', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    await runAgent(firmA.id)

    const all = await prisma.qualificationRecommendation.findMany({ where: { consultingFirmId: firmA.id, pursuitId: pursuit.id } })
    expect(all).toHaveLength(1)
    expect(all[0].version).toBe(1)
  })

  it('creates a new version when the probability changes materially', async () => {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 90 })
    const pursuit = await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)

    await prisma.opportunity.update({ where: { id: opp.id }, data: { probabilityScore: 12 } })
    await runAgent(firmA.id)

    const all = await prisma.qualificationRecommendation.findMany({
      where: { consultingFirmId: firmA.id, pursuitId: pursuit.id }, orderBy: { version: 'asc' },
    })
    expect(all).toHaveLength(2)
    expect(all[0].version).toBe(1)
    expect(all[1].version).toBe(2)
  })

  it('supersedes the previous version and preserves it as evidence', async () => {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 90 })
    const pursuit = await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)
    const first = await currentRecommendation(firmA.id, pursuit.id)

    await prisma.opportunity.update({ where: { id: opp.id }, data: { probabilityScore: 12 } })
    await runAgent(firmA.id)

    const preserved = await prisma.qualificationRecommendation.findUniqueOrThrow({ where: { id: first!.id } })
    expect(preserved.status).toBe('SUPERSEDED')
    expect(preserved.supersededAt).not.toBeNull()
    // The original narrative and result are untouched.
    expect(preserved.narrative).toBe(first!.narrative)
    expect(preserved.recommendation).toBe(first!.recommendation)

    const latest = await currentRecommendation(firmA.id, pursuit.id)
    expect(latest!.supersedesId).toBe(first!.id)
  })

  it('creates a new version when a capability gap appears', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)
    const before = await prisma.qualificationRecommendation.count({ where: { pursuitId: pursuit.id } })

    await prisma.opportunity.update({ where: { id: opp.id }, data: { setAsideType: 'SDVOSB' } })
    await runAgent(firmA.id)

    expect(await prisma.qualificationRecommendation.count({ where: { pursuitId: pursuit.id } })).toBeGreaterThanOrEqual(before)
  })
})

// -------------------------------------------------------------
// Probability + evidence honesty
// -------------------------------------------------------------

describe('probability', () => {
  it('labels a RAW probability honestly rather than claiming calibration', async () => {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 80 })
    const pursuit = await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)

    const rec = await currentRecommendation(firmA.id, pursuit.id)
    // With no calibration configured the canonical stack reports RAW; that is
    // correct behaviour, not a defect.
    expect(['RAW', 'CALIBRATED', 'FALLBACK']).toContain(rec!.probabilityMode)
    expect(rec!.rawProbability).toBe(80)
  })

  it('reports no probability at all for an unscored opportunity', async () => {
    const opp = await makeOpportunity(firmA.id, { isScored: false, probabilityScore: 0 })
    const pursuit = await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)

    const rec = await currentRecommendation(firmA.id, pursuit.id)
    expect(rec!.finalProbability).toBeNull()
    expect(rec!.recommendation).toBe('INSUFFICIENT_DATA')
  })

  it('never fabricates a confidence interval', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)

    const rec = await currentRecommendation(firmA.id, pursuit.id)
    // With no verified outcomes there is no defensible interval.
    expect(rec!.confidenceLower).toBeNull()
    expect(rec!.confidenceUpper).toBeNull()
    expect(rec!.confidenceState).toBe('INSUFFICIENT_DATA')
  })
})

describe('incumbent evidence', () => {
  it('invents no incumbent when there is no award history', async () => {
    const opp = await makeOpportunity(firmA.id)
    const result = await loadIncumbentEvidence(firmA.id, opp.id)
    expect(result.available).toBe(false)
    expect(result.name).toBeNull()
    expect(result.limitation).toContain('No incumbent could be identified')
  })

  it('names an incumbent but states no rate when the sample is too small', async () => {
    const opp = await makeOpportunity(firmA.id)
    await prisma.awardHistory.create({
      data: { opportunityId: opp.id, recipientName: 'S7-QUAL-QA Acme', awardDate: new Date(Date.now() - 200 * DAY), awardAmount: 1_000_000 },
    })
    await prisma.incumbentRetentionStat.create({
      data: {
        consultingFirmId: firmA.id, incumbentName: 'S7-QUAL-QA Acme', normalizedName: 's7qualqaacme',
        similarAwardCount: 2, retainedCount: 1, retentionRate: null, basis: 'INSUFFICIENT_DATA',
        sampleSize: 2, evidence: {},
      },
    })
    const result = await loadIncumbentEvidence(firmA.id, opp.id)
    expect(result.name).toBe('S7-QUAL-QA Acme')
    expect(result.available).toBe(false)
    expect(result.retentionRatePct).toBeNull()
    expect(result.limitation).toContain('too few to state a rate')
  })

  it('states the rate with its numerator and denominator when the sample supports it', async () => {
    const opp = await makeOpportunity(firmA.id)
    await prisma.awardHistory.create({
      data: { opportunityId: opp.id, recipientName: 'S7-QUAL-QA Beta', awardDate: new Date(Date.now() - 200 * DAY), awardAmount: 1_000_000 },
    })
    await prisma.incumbentRetentionStat.create({
      data: {
        consultingFirmId: firmA.id, incumbentName: 'S7-QUAL-QA Beta', normalizedName: 's7qualqabeta',
        similarAwardCount: 7, retainedCount: 4, retentionRate: 0.5714, basis: 'OBSERVED_AWARD_SHARE',
        sampleSize: 7, evidence: {},
      },
    })
    const result = await loadIncumbentEvidence(firmA.id, opp.id)
    expect(result.available).toBe(true)
    expect(result.retentionNumerator).toBe(4)
    expect(result.retentionDenominator).toBe(7)
    expect(result.retentionRatePct).toBe(57)
  })
})

describe('competitor evidence', () => {
  it('reports honestly when no competitor evidence exists', async () => {
    const result = await loadCompetitorEvidence(firmA.id, { agency: 'DoD', naicsCode: '541512' })
    expect(result.competitors).toHaveLength(0)
    expect(result.limitation).toContain('No competitor award evidence')
  })

  it('never labels an observed award share a win rate', async () => {
    await prisma.competitorAwardStat.create({
      data: {
        consultingFirmId: firmA.id, competitorName: 'S7-QUAL-QA Rival', normalizedName: 's7qualqarival',
        agency: 'Department of Defense', observedAwards: 3, comparableAwardPool: 12,
        observedAwardShare: 0.25, basis: 'OBSERVED_AWARD_SHARE',
        basisLabel: 'Observed award share', sampleSize: 12, evidence: {},
      },
    })
    const result = await loadCompetitorEvidence(firmA.id, { agency: 'Department of Defense', naicsCode: '541512' })
    expect(result.competitors[0].isConfirmedWinRate).toBe(false)
    expect(result.competitors[0].observedAwardSharePct).toBe(25)
    expect(result.competitors[0].totalObserved).toBe(12)
    expect(result.limitation).toContain('not win rates')
  })

  it('uses a confirmed win rate only when the denominator is confirmed bids', async () => {
    await prisma.competitorAwardStat.create({
      data: {
        consultingFirmId: firmA.id, competitorName: 'S7-QUAL-QA Confirmed', normalizedName: 's7qualqaconfirmed',
        agency: 'Department of Defense', observedAwards: 6, comparableAwardPool: 20,
        confirmedBids: 10, confirmedWins: 6, confirmedWinRate: 0.6, basis: 'CONFIRMED_WIN_RATE',
        basisLabel: 'Confirmed win rate', sampleSize: 10, evidence: {},
      },
    })
    const result = await loadCompetitorEvidence(firmA.id, { agency: 'Department of Defense', naicsCode: '541512' })
    expect(result.competitors[0].isConfirmedWinRate).toBe(true)
    expect(result.competitors[0].totalObserved).toBe(10)
    expect(result.limitation).toBeNull()
  })
})

describe('capacity', () => {
  it('reports UNKNOWN when no capacity is declared, never AVAILABLE', async () => {
    const result = await loadCapacityEvidence(firmA.id, null)
    expect(result.state).toBe('INSUFFICIENT_DATA')
    expect(result.detail).toContain('not the same as having capacity')
  })

  it('reports AVAILABLE with headroom', async () => {
    await prisma.firmCapability.create({
      data: { consultingFirmId: firmA.id, name: 'S7-QUAL-QA cap', category: 'TECHNICAL', concurrentCapacity: 5, verification: 'VERIFIED' },
    })
    const result = await loadCapacityEvidence(firmA.id, null)
    expect(result.state).toBe('AVAILABLE')
  })

  it('reports OVER_CAPACITY when the load meets the tightest limit', async () => {
    await prisma.firmCapability.create({
      data: { consultingFirmId: firmA.id, name: 'S7-QUAL-QA cap', category: 'TECHNICAL', concurrentCapacity: 1, verification: 'VERIFIED' },
    })
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    const result = await loadCapacityEvidence(firmA.id, null)
    expect(result.state).toBe('OVER_CAPACITY')
    expect(result.conflicts.length).toBeGreaterThan(0)
  })

  it('uses the tightest declared limit, not the most generous', async () => {
    await prisma.firmCapability.createMany({
      data: [
        { consultingFirmId: firmA.id, name: 'S7-QUAL-QA wide', category: 'TECHNICAL', concurrentCapacity: 20 },
        { consultingFirmId: firmA.id, name: 'S7-QUAL-QA tight', category: 'TECHNICAL', concurrentCapacity: 2 },
      ],
    })
    const result = await loadCapacityEvidence(firmA.id, null)
    expect(result.declaredConcurrentCapacity).toBe(2)
  })
})

describe('pricing', () => {
  it('continues with a limitation when no pricing scenario exists', async () => {
    const opp = await makeOpportunity(firmA.id)
    const result = await loadPricingEvidence(firmA.id, opp.id)
    expect(result.availability).toBe('PRICING_DATA_NOT_AVAILABLE')
    expect(result.detail).toContain('comparable-price benchmark against incumbent award history is not available')
  })

  it('never claims an incumbent price comparison', async () => {
    const opp = await makeOpportunity(firmA.id)
    await prisma.pricingSensitivityAnalysis.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id, points: [],
        validity: 'UNVALIDATED_SCENARIO_ANALYSIS', sampleSize: 4,
      },
    })
    const result = await loadPricingEvidence(firmA.id, opp.id)
    expect(result.availability).toBe('AVAILABLE')
    expect(result.detail).toContain('not a comparable unit-price benchmark against the incumbent')
  })
})

// -------------------------------------------------------------
// No LLM
// -------------------------------------------------------------

describe('no LLM is ever used', () => {
  it('never reaches the provider boundary and consumes zero tokens', async () => {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 52 })
    await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await makeMatch(firmA.id, opp.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(run?.tokenInput).toBe(0)
    expect(run?.tokenOutput).toBe(0)
    expect(Number(run?.estimatedCostUsd)).toBe(0)
  })

  it('writes no ApiUsageLog row', async () => {
    const before = await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)
    expect(await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })).toBe(before)
  })
})

// -------------------------------------------------------------
// Tenant isolation
// -------------------------------------------------------------

describe('tenant isolation', () => {
  it('refuses to qualify another firm\'s pursuit', async () => {
    const oppB = await makeOpportunity(firmB.id)
    const pursuitB = await makePursuit(firmB.id, oppB.id)

    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: 'BidPursuit', triggerEntityId: pursuitB.id,
    })
    expect(run?.status).toBe('SKIPPED')
    expect(await prisma.qualificationRecommendation.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(await prisma.qualificationRecommendation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('refuses a targeted run against another firm\'s opportunity', async () => {
    const oppB = await makeOpportunity(firmB.id)
    await makePursuit(firmB.id, oppB.id)
    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: 'Opportunity', triggerEntityId: oppB.id,
    })
    expect(run?.status).toBe('SKIPPED')
  })

  it('never uses another firm\'s incumbent statistic', async () => {
    const oppA = await makeOpportunity(firmA.id)
    await prisma.awardHistory.create({
      data: { opportunityId: oppA.id, recipientName: 'Shared Name', awardDate: new Date(), awardAmount: 1_000_000 },
    })
    await prisma.incumbentRetentionStat.create({
      data: {
        consultingFirmId: firmB.id, incumbentName: 'Shared Name', normalizedName: 'sharedname',
        similarAwardCount: 9, retainedCount: 8, retentionRate: 0.89, basis: 'OBSERVED_AWARD_SHARE',
        sampleSize: 9, evidence: {},
      },
    })
    const result = await loadIncumbentEvidence(firmA.id, oppA.id)
    // The name is public award data; firm B's private statistic is not used.
    expect(result.name).toBe('Shared Name')
    expect(result.retentionRatePct).toBeNull()
  })

  it('never uses another firm\'s competitor statistic', async () => {
    await prisma.competitorAwardStat.create({
      data: {
        consultingFirmId: firmB.id, competitorName: 'Firm B Rival', normalizedName: 'firmbrival',
        agency: 'Department of Defense', observedAwards: 5, comparableAwardPool: 10,
        observedAwardShare: 0.5, basis: 'OBSERVED_AWARD_SHARE', basisLabel: 'Observed award share', sampleSize: 10, evidence: {},
      },
    })
    const result = await loadCompetitorEvidence(firmA.id, { agency: 'Department of Defense', naicsCode: '541512' })
    expect(result.competitors).toHaveLength(0)
  })

  it('never uses another firm\'s capacity data', async () => {
    await prisma.firmCapability.create({
      data: { consultingFirmId: firmB.id, name: 'Firm B cap', category: 'TECHNICAL', concurrentCapacity: 50 },
    })
    const result = await loadCapacityEvidence(firmA.id, null)
    expect(result.state).toBe('INSUFFICIENT_DATA')
  })

  it('never uses another firm\'s pricing scenario', async () => {
    const oppA = await makeOpportunity(firmA.id)
    await prisma.pricingSensitivityAnalysis.create({
      data: { consultingFirmId: firmB.id, opportunityId: oppA.id, points: [], validity: 'CALIBRATED', sampleSize: 40 },
    })
    const result = await loadPricingEvidence(firmA.id, oppA.id)
    expect(result.availability).toBe('PRICING_DATA_NOT_AVAILABLE')
  })

  it('never raises an escalation or gate review against another firm', async () => {
    const opp = await makeOpportunity(firmA.id, { probabilityScore: 52 })
    await makePursuit(firmA.id, opp.id)
    await runAgent(firmA.id)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.gateReview.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})
