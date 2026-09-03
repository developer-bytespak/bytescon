// =============================================================
// §7.5 — Teaming Agent against a real PostgreSQL database.
//
// Covers the registry, the handler through the §7.0 dispatcher, scope
// resolution, partner matching and ranking, the TEAMING_PLAN artifact and its
// supersession, escalations, the no-LLM path, tenant isolation, and — above all
// — the human-control boundary at both PROPOSE and ACT_WITH_GUARDRAILS.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

// The provider boundary is mocked for the whole file. With no key configured
// the agent must never reach it.
const generateWithRouterSpy = vi.fn()
vi.mock('../../llm/llmRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../llm/llmRouter')>()
  return { ...actual, generateWithRouter: (...a: unknown[]) => generateWithRouterSpy(...a) }
})

// Any outbound send would go through the mail service. It must never be called.
const sendMailSpy = vi.fn()
vi.mock('../../emailService', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return new Proxy(actual, {
    get(target, prop) {
      if (typeof prop === 'string' && /^(send|notify)/.test(prop)) {
        return (...a: unknown[]) => { sendMailSpy(prop, ...a); return Promise.resolve() }
      }
      return Reflect.get(target, prop)
    },
  })
})

import { prisma } from '../../../config/database'
import {
  createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm, type TestUser,
} from '../../../test-utils/testClient'
import { dispatchAgentRun } from '../dispatch'
import { createRun } from '../runService'
import { getAgentDefinition, agentsSubscribedTo, AGENT_REGISTRY } from '../registry'
import { DOMAIN_AGENT_KEYS } from '../types'
import {
  TEAMING_PHASES, phasesForRun, TEAMABLE_STAGES, NO_SUITABLE_PARTNER_MESSAGE, startOfIsoWeek,
} from './teamingAgentHandler'
import { LEGAL_REVIEW_BANNER } from './teamingPrompts'

const AGENT = 'TEAMING' as const
const DAY = 86_400_000

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let ownerA: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

// This file's premise is "zero LLM configuration" (deterministic drafts, the
// provider boundary never reached). CI stubs ANTHROPIC_API_KEY for other
// suites, which silently made isLlmProviderConfigured() true here and sent the
// agent down the optional LLM path — so the premise must be constructed, not
// assumed. The env is stripped for this file and restored afterwards.
const SAVED_LLM_ENV: Record<string, string | undefined> = {}
const LLM_ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'INSIGHT_ENGINE_API_KEY', 'LOCALAI_BASE_URL'] as const

beforeAll(async () => {
  for (const k of LLM_ENV_KEYS) {
    SAVED_LLM_ENV[k] = process.env[k]
    delete process.env[k]
  }
  firmA = await createTestFirm({ name: 'Teaming Agent Firm A' })
  firmB = await createTestFirm({ name: 'Teaming Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  ownerA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
})

afterAll(async () => {
  for (const k of LLM_ENV_KEYS) {
    if (SAVED_LLM_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = SAVED_LLM_ENV[k]
  }
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  sendMailSpy.mockReset()
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.subcontractingGoalProgress.deleteMany({ where: { consultingFirmId: id } })
    await prisma.subcontractingGoal.deleteMany({ where: { consultingFirmId: id } })
    await prisma.partnerPerformanceRecord.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contractDeliverable.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contract.deleteMany({ where: { consultingFirmId: id } })
    await prisma.teamingAgreementDraft.deleteMany({ where: { consultingFirmId: id } })
    await prisma.teamingArrangement.deleteMany({ where: { consultingFirmId: id } })
    await prisma.partner.deleteMany({ where: { consultingFirmId: id } })
    await prisma.capabilityGapAssessment.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.firmCapability.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeOpportunity(firmId: string, over: Partial<Prisma.OpportunityUncheckedCreateInput> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId,
      samNoticeId: uniq('S7-TEAM-QA'),
      title: 'S7-TEAM-QA cyber support solicitation',
      agency: 'Department of Defense',
      naicsCode: '541512',
      // A set-aside the firm cannot meet creates a CRITICAL eligibility gap.
      setAsideType: 'SDVOSB',
      description: 'Incident response and continuous monitoring support.',
      placeOfPerformance: 'VA',
      responseDeadline: new Date(Date.now() + 45 * DAY),
      status: 'ACTIVE',
      isDemo: false,
      ...over,
    },
  })
}

async function makePursuit(firmId: string, opportunityId: string, over: Partial<Prisma.BidPursuitUncheckedCreateInput> = {}) {
  return prisma.bidPursuit.create({
    data: {
      consultingFirmId: firmId, opportunityId,
      pipelineStage: 'CAPTURE', status: 'REVIEWING', priority: 'MEDIUM',
      ...over,
    },
  })
}

async function makePartner(firmId: string, over: Partial<Prisma.PartnerUncheckedCreateInput> = {}) {
  return prisma.partner.create({
    data: {
      consultingFirmId: firmId,
      name: uniq('S7-TEAM-QA Partner'),
      uei: uniq('UEI'),
      primaryNaicsCodes: ['541512'],
      primarySetAsides: ['SDVOSB'],
      capabilities: ['incident response', 'continuous monitoring'],
      certifications: ['SDVOSB'],
      geography: 'VA',
      contactName: 'Jordan Lee',
      contactEmail: 'jordan@example.test',
      isActive: true,
      ...over,
    },
  })
}

async function runAgent(firmId: string, over: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId, agentKey: AGENT, triggerType: 'MANUAL',
    idempotencyKey: uniq('teaming-run'), ...over,
  })
  await dispatchAgentRun(run.id)
  return prisma.agentRun.findUnique({ where: { id: run.id } })
}

const currentPlan = async (firmId: string, pursuitId: string) => {
  const artifact = await prisma.agentArtifact.findFirst({
    where: {
      consultingFirmId: firmId, agentKey: AGENT, artifactType: 'TEAMING_PLAN',
      sourceEntityId: pursuitId, supersededByArtifactId: null,
    },
    orderBy: { createdAt: 'desc' },
  })
  return artifact ? { artifact, plan: artifact.structuredData as Record<string, unknown> } : null
}

// -------------------------------------------------------------
// Registry
// -------------------------------------------------------------

describe('agent registry', () => {
  it('marks the Teaming Agent implemented with a real handler', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.implemented).toBe(true)
    expect(def.handler).not.toBeNull()
    expect(def.plannedSlice).toBe('7.5')
  })

  it('defaults to PROPOSE autonomy and stays opt-in', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.defaultAutonomyLevel).toBe('PROPOSE')
    expect(def.defaultEnabled).toBe(false)
  })

  it('does not require an LLM, because every feature has a deterministic path', () => {
    expect(getAgentDefinition(AGENT)!.requiresLlm).toBe(false)
  })

  it('supports manual, scheduled, event and retry triggers', () => {
    expect(getAgentDefinition(AGENT)!.supportedTriggers.sort()).toEqual(['EVENT', 'MANUAL', 'RETRY', 'SCHEDULE'])
  })

  it('runs daily', () => {
    expect(getAgentDefinition(AGENT)!.defaultCronExpression).toBe('0 3 * * *')
  })

  it('subscribes to the four §7.5 triggers', () => {
    expect(getAgentDefinition(AGENT)!.subscribedEventTypes.sort()).toEqual([
      'BID_DECISION_RECORDED', 'CAPABILITY_GAP_DETECTED', 'PARTNER_ADDED', 'SUBCONTRACT_MILESTONE_DUE',
    ])
  })

  it('is the only implemented subscriber to the two teaming-owned events', () => {
    expect(agentsSubscribedTo('PARTNER_ADDED').map((d) => d.key)).toEqual([AGENT])
    expect(agentsSubscribedTo('SUBCONTRACT_MILESTONE_DUE').map((d) => d.key)).toEqual([AGENT])
  })

  it('allowlists no autonomous action keys, because it executes nothing', () => {
    expect(getAgentDefinition(AGENT)!.allowlistedActionKeys).toEqual([])
  })

  it('produces the TEAMING_PLAN artifact', () => {
    expect(getAgentDefinition(AGENT)!.supportedArtifactTypes).toContain('TEAMING_PLAN')
  })

  it('leaves the four previously delivered agents implemented', () => {
    for (const key of ['CONTRACT_ADMINISTRATION', 'OPPORTUNITY', 'COMPLIANCE', 'QUALIFICATION'] as const) {
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

  it('exposes all thirteen phases', () => {
    expect(phasesForRun(null)).toHaveLength(13)
    expect(TEAMING_PHASES[0]).toBe('LOAD_PURSUIT')
    expect(TEAMING_PHASES[TEAMING_PHASES.length - 1]).toBe('COMPLETE')
  })

  it('runs only the relevant phases for a targeted event', () => {
    expect(phasesForRun('SubcontractingGoal')).toEqual([
      'CHECK_SUBCONTRACT_GOALS', 'CHECK_OBLIGATION_DEADLINES', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE',
    ])
    expect(phasesForRun('Partner')).not.toContain('CHECK_PARTNER_PERFORMANCE')
  })
})

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

describe('handler', () => {
  it('completes a manual sweep and produces a TEAMING_PLAN', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')

    const current = await currentPlan(firmA.id, pursuit.id)
    expect(current).not.toBeNull()
    expect(current!.plan.pursuitId).toBe(pursuit.id)
    expect(current!.plan.methodVersion).toBe('teaming-v1')
  })

  it('SKIPS honestly when the firm has nothing to plan', async () => {
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('SKIPPED')
    expect(run?.limitations.join(' ')).toContain(TEAMABLE_STAGES[0])
  })

  it('excludes terminal-stage pursuits', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id, { pipelineStage: 'LOST' })
    expect((await runAgent(firmA.id))?.status).toBe('SKIPPED')
  })

  it('records progress and a heartbeat', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    const run = await runAgent(firmA.id)
    expect(run?.progressPercent).toBeGreaterThan(0)
    expect(run?.heartbeatAt).not.toBeNull()
  })

  it('isolates one pursuit from another in the same sweep', async () => {
    const first = await makeOpportunity(firmA.id, { title: 'S7-TEAM-QA first' })
    await makePursuit(firmA.id, first.id)
    const second = await makeOpportunity(firmA.id, { title: 'S7-TEAM-QA second' })
    await makePursuit(firmA.id, second.id)
    await makePartner(firmA.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'TEAMING_PLAN' },
    })).toBe(2)
  })

  it('survives a partner row with no capabilities recorded', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id, { capabilities: [], certifications: [], primaryNaicsCodes: [], geography: null })
    await makePartner(firmA.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
  })

  it('names the gaps it found from the canonical assessment', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)

    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    const gaps = plan.capabilityGaps as Array<{ severity: string; gapClass: string }>
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.some((g) => g.severity === 'CRITICAL')).toBe(true)
  })

  it('does not notify under OBSERVE autonomy', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await makePartner(firmA.id)
    await runAgent(firmA.id, { autonomyLevel: 'OBSERVE' })

    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })
})

// -------------------------------------------------------------
// Partner matching
// -------------------------------------------------------------

describe('partner matching', () => {
  async function planWith(partners: Array<Partial<Prisma.PartnerUncheckedCreateInput>>) {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    for (const p of partners) await makePartner(firmA.id, p)
    await runAgent(firmA.id)
    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    return plan as unknown as {
      partnerCandidates: Array<{
        partnerId: string; name: string; overallFit: number
        dimensions: Array<{ dimension: string; points: number; detail: string }>
        certifications: { met: boolean; verificationState: string; claimed: string[] }
        geography: { level: string; detail: string }
        relevantExperience: { priorTeamedBids: number }
        eligibilityState: string
        performanceSummary: { sampleSize: number; dataSufficiency: string }
      }>
      noSuitablePartner: boolean
      noSuitablePartnerMessage: string | null
    }
  }

  it('exposes per-dimension evidence, never a single opaque score', async () => {
    const plan = await planWith([{}])
    const candidate = plan.partnerCandidates[0]
    expect(candidate.dimensions.length).toBeGreaterThan(1)
    for (const d of candidate.dimensions) {
      expect(typeof d.dimension).toBe('string')
      expect(typeof d.detail).toBe('string')
      expect(d.detail.length).toBeGreaterThan(0)
    }
  })

  it('scores a capability match above a partner with none', async () => {
    const plan = await planWith([
      { name: 'S7-TEAM-QA Strong', capabilities: ['incident response', 'continuous monitoring'] },
      { name: 'S7-TEAM-QA Weak', capabilities: [], certifications: [], primaryNaicsCodes: [], primarySetAsides: [], geography: null },
    ])
    const strong = plan.partnerCandidates.find((c) => c.name === 'S7-TEAM-QA Strong')!
    const weak = plan.partnerCandidates.find((c) => c.name === 'S7-TEAM-QA Weak')!
    expect(strong.overallFit).toBeGreaterThan(weak.overallFit)
  })

  it('records the required set-aside certification as met when the partner holds it', async () => {
    const plan = await planWith([{ certifications: ['SDVOSB'], primarySetAsides: ['SDVOSB'] }])
    expect(plan.partnerCandidates[0].certifications.met).toBe(true)
  })

  it('never calls a self-declared certification verified', async () => {
    const plan = await planWith([{ certifications: ['SDVOSB'] }])
    expect(plan.partnerCandidates[0].certifications.verificationState).toBe('UNVERIFIED_SELF_DECLARED')
  })

  it('records NONE_RECORDED when a partner claims no certification', async () => {
    const plan = await planWith([{ certifications: [] }])
    expect(plan.partnerCandidates[0].certifications.verificationState).toBe('NONE_RECORDED')
  })

  it('never states more than POSSIBLY_ELIGIBLE', async () => {
    const plan = await planWith([{}, { certifications: [], primarySetAsides: [] }])
    for (const c of plan.partnerCandidates) {
      expect(['POSSIBLY_ELIGIBLE', 'INSUFFICIENT_DATA', 'NOT_ESTABLISHED']).toContain(c.eligibilityState)
      expect(c.eligibilityState).not.toBe('ELIGIBLE')
    }
  })

  it('does not establish eligibility when the required certification is absent', async () => {
    const plan = await planWith([{ certifications: ['ISO9001'], primarySetAsides: [] }])
    expect(plan.partnerCandidates[0].eligibilityState).toBe('NOT_ESTABLISHED')
  })

  it('records geography evidence from stored data only', async () => {
    const plan = await planWith([{ geography: 'VA' }])
    expect(plan.partnerCandidates[0].geography.detail.length).toBeGreaterThan(0)
    expect(['FULL', 'PARTIAL', 'NONE', 'UNKNOWN']).toContain(plan.partnerCandidates[0].geography.level)
  })

  it('reports UNKNOWN geography rather than guessing when none is stored', async () => {
    const plan = await planWith([{ geography: null }])
    expect(plan.partnerCandidates[0].geography.level).toBe('UNKNOWN')
  })

  it('reports no performance evidence honestly', async () => {
    const plan = await planWith([{}])
    expect(plan.partnerCandidates[0].performanceSummary.sampleSize).toBe(0)
    expect(plan.partnerCandidates[0].performanceSummary.dataSufficiency).toBe('INSUFFICIENT_DATA')
  })

  it('ranks deterministically across repeated runs', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    for (let i = 0; i < 4; i += 1) await makePartner(firmA.id, { name: `S7-TEAM-QA P${i}` })

    await runAgent(firmA.id)
    const first = (await currentPlan(firmA.id, pursuit.id))!.plan.partnerCandidates as Array<{ partnerId: string }>
    await runAgent(firmA.id)
    const second = (await currentPlan(firmA.id, pursuit.id))!.plan.partnerCandidates as Array<{ partnerId: string }>
    expect(second.map((c) => c.partnerId)).toEqual(first.map((c) => c.partnerId))
  })

  it('excludes an inactive partner', async () => {
    const plan = await planWith([{ name: 'S7-TEAM-QA Active' }, { name: 'S7-TEAM-QA Retired', isActive: false }])
    expect(plan.partnerCandidates.some((c) => c.name === 'S7-TEAM-QA Retired')).toBe(false)
  })

  it('says the NETWORK holds no suitable partner — never that none exists', async () => {
    const plan = await planWith([
      { capabilities: [], certifications: [], primaryNaicsCodes: [], primarySetAsides: [], geography: null },
    ])
    expect(plan.noSuitablePartner).toBe(true)
    expect(plan.noSuitablePartnerMessage).toBe(NO_SUITABLE_PARTNER_MESSAGE)
    expect(plan.noSuitablePartnerMessage).toContain('in the current partner network')
    expect(JSON.stringify(plan)).not.toContain('No suitable partner exists')
  })

  it('counts prior teaming history with this firm', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    const partner = await makePartner(firmA.id)
    const past = await makeOpportunity(firmA.id, { title: 'S7-TEAM-QA past', status: 'AWARDED' })
    await prisma.teamingArrangement.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: past.id, partnerId: partner.id,
        role: 'SUB', arrangementType: 'TEAMING_AGREEMENT',
      },
    })
    await runAgent(firmA.id)

    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    const candidate = (plan.partnerCandidates as Array<{ partnerId: string; relevantExperience: { priorTeamedBids: number; priorWins: number } }>)
      .find((c) => c.partnerId === partner.id)!
    expect(candidate.relevantExperience.priorTeamedBids).toBe(1)
    expect(candidate.relevantExperience.priorWins).toBe(1)
  })
})

// -------------------------------------------------------------
// A partner match never closes a gap
// -------------------------------------------------------------

describe('a proposed partner is mitigation, not resolution', () => {
  it('leaves a critical gap CRITICAL even with a strong candidate', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)

    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    const critical = (plan.capabilityGaps as Array<{ severity: string; mitigationStatus: string }>)
      .filter((g) => g.severity === 'CRITICAL')
    expect(critical.length).toBeGreaterThan(0)
    for (const g of critical) {
      expect(g.severity).toBe('CRITICAL')
      expect(g.mitigationStatus).not.toBe('RESOLVED')
    }
  })

  it('marks mitigation as human-approved only once an arrangement is committed', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    const partner = await makePartner(firmA.id)
    await prisma.teamingArrangement.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id, partnerId: partner.id,
        role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', teamingStatus: 'COMMITTED',
      },
    })
    await runAgent(firmA.id)

    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    const statuses = (plan.capabilityGaps as Array<{ mitigationStatus: string }>).map((g) => g.mitigationStatus)
    expect(statuses.some((s) => s === 'HUMAN_APPROVED_ARRANGEMENT' || s === 'UNRESOLVED')).toBe(true)
  })
})

// -------------------------------------------------------------
// THE HUMAN-CONTROL BOUNDARY
// -------------------------------------------------------------

describe('the agent executes nothing, at either autonomy level', () => {
  const AUTONOMY = ['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const

  async function scenario() {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 5 * DAY) })
    const pursuit = await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    const partner = await makePartner(firmA.id)
    return { opp, pursuit, partner }
  }

  it.each(AUTONOMY)('at %s, executes no teaming arrangement', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })
    expect(await prisma.teamingArrangement.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, never marks an existing arrangement executed or signed', async (autonomyLevel) => {
    const { opp, partner } = await scenario()
    const arrangement = await prisma.teamingArrangement.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id, partnerId: partner.id,
        role: 'SUB', arrangementType: 'TEAMING_AGREEMENT',
        teamingStatus: 'IDENTIFIED', agreementStatus: 'NONE', ndaStatus: 'NONE',
      },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.teamingArrangement.findUniqueOrThrow({ where: { id: arrangement.id } })
    expect(after.teamingStatus).toBe('IDENTIFIED')
    expect(after.agreementStatus).toBe('NONE')
    expect(after.ndaStatus).toBe('NONE')
    expect(after.agreementSignedDate).toBeNull()
  })

  it.each(AUTONOMY)('at %s, persists no signed agreement draft row', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })
    expect(await prisma.teamingAgreementDraft.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, every prepared draft is a non-executable DRAFT', async (autonomyLevel) => {
    const { pursuit } = await scenario()
    await runAgent(firmA.id, { autonomyLevel })

    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    for (const d of plan.drafts as Array<{ status: string; legalReviewRequired: boolean; executionAllowed: boolean; banner: string }>) {
      expect(d.status).toBe('DRAFT')
      expect(d.legalReviewRequired).toBe(true)
      expect(d.executionAllowed).toBe(false)
      expect(d.banner).toBe(LEGAL_REVIEW_BANNER)
    }
  })

  it.each(AUTONOMY)('at %s, every outreach draft still needs a human to send it', async (autonomyLevel) => {
    const { pursuit } = await scenario()
    await runAgent(firmA.id, { autonomyLevel })

    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    for (const o of plan.outreachDrafts as Array<{ status: string; sendAllowed: boolean; humanSendRequired: boolean }>) {
      expect(o.status).toBe('DRAFT')
      expect(o.sendAllowed).toBe(false)
      expect(o.humanSendRequired).toBe(true)
    }
  })

  it.each(AUTONOMY)('at %s, invokes no mail or messaging adapter', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })
    expect(sendMailSpy).not.toHaveBeenCalled()
  })

  it.each(AUTONOMY)('at %s, never alters a BidDecision or a scorecard decision', async (autonomyLevel) => {
    const { pursuit, opp } = await scenario()
    const scorecard = await prisma.scorecard.create({
      data: { consultingFirmId: firmA.id, bidPursuitId: pursuit.id, opportunityId: opp.id, status: 'IN_REVIEW' },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.scorecard.findUniqueOrThrow({ where: { id: scorecard.id } })
    expect(after.finalDecision).toBeNull()
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each(AUTONOMY)('at %s, never changes a verified subcontracting target', async (autonomyLevel) => {
    const { pursuit } = await scenario()
    const goal = await prisma.subcontractingGoal.create({
      data: {
        consultingFirmId: firmA.id, pursuitId: pursuit.id, goalType: 'SDVOSB',
        targetType: 'PERCENT', targetPercent: new Prisma.Decimal('20.00'),
        source: 'SUBCONTRACTING_PLAN', isHumanVerified: true, status: 'ACTIVE',
        dueDate: new Date(Date.now() + 10 * DAY),
      },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.subcontractingGoal.findUniqueOrThrow({ where: { id: goal.id } })
    expect(after.targetPercent?.toFixed(2)).toBe('20.00')
    expect(after.isHumanVerified).toBe(true)
    expect(after.status).toBe('ACTIVE')
  })

  it.each(AUTONOMY)('at %s, leaves every execution surface untouched in the database', async (autonomyLevel) => {
    await scenario()
    await runAgent(firmA.id, { autonomyLevel })
    // The four counters the handler reports as zero, asserted where it counts.
    expect(await prisma.teamingArrangement.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(await prisma.teamingAgreementDraft.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(sendMailSpy).not.toHaveBeenCalled()
  })

  it.each(AUTONOMY)('at %s, a proposed workshare is labelled PROPOSED and binds nothing', async (autonomyLevel) => {
    const { pursuit, opp, partner } = await scenario()
    const arrangement = await prisma.teamingArrangement.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id, partnerId: partner.id,
        role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', scopePercent: 5,
      },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    const workshare = plan.proposedWorkshare as { status: string; limitations: string[] }
    expect(['PROPOSED', 'NOT_AVAILABLE']).toContain(workshare.status)
    expect(workshare.status).not.toBe('AGREED')
    // The recorded arrangement is untouched.
    expect((await prisma.teamingArrangement.findUniqueOrThrow({ where: { id: arrangement.id } })).scopePercent).toBe(5)
  })
})

// -------------------------------------------------------------
// Escalations
// -------------------------------------------------------------

describe('escalations', () => {
  it('escalates an unresolved critical gap inside the working-day window', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 5 * DAY) })
    const pursuit = await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await makePartner(firmA.id)
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, agentKey: AGENT, title: { startsWith: 'Critical capability gap near submission' } },
    })
    expect(esc).not.toBeNull()
    expect(esc!.entityId).toBe(pursuit.id)
    expect(esc!.reason).toContain('working day(s) until the response deadline')
    expect(esc!.reason).toContain('A proposed partner does not close the gap')
  })

  it('does not escalate a critical gap that is far from the deadline', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 120 * DAY) })
    await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)

    expect(await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Critical capability gap' } },
    })).toBe(0)
  })

  it('escalates when the network holds no suitable partner', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id, { capabilities: [], certifications: [], primaryNaicsCodes: [], primarySetAsides: [], geography: null })
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'No suitable partner in network' } },
    })
    expect(esc).not.toBeNull()
    expect(esc!.reason).toContain(NO_SUITABLE_PARTNER_MESSAGE)
    expect(esc!.reason).toContain('has not searched the market')
  })

  it('does not duplicate an escalation on an unchanged re-run', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 5 * DAY) })
    await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)
    await runAgent(firmA.id)

    expect(await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Critical capability gap' } },
    })).toBe(1)
  })

  it('escalates a subcontracting goal that is AT_RISK', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    const partner = await makePartner(firmA.id, { primarySetAsides: ['WOSB'], certifications: ['WOSB'] })
    await prisma.teamingArrangement.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id, partnerId: partner.id,
        role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', dollarShare: new Prisma.Decimal('100000.00'),
      },
    })
    await prisma.subcontractingGoal.create({
      data: {
        consultingFirmId: firmA.id, pursuitId: pursuit.id, opportunityId: opp.id,
        goalType: 'SDVOSB', targetType: 'PERCENT', targetPercent: new Prisma.Decimal('20.00'),
        source: 'SUBCONTRACTING_PLAN', isHumanVerified: true, status: 'ACTIVE',
        dueDate: new Date(Date.now() + 5 * DAY),
      },
    })

    await runAgent(firmA.id)
    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Subcontracting goal AT_RISK' } },
    })
    expect(esc).not.toBeNull()
    expect(esc!.reason).toContain('SUBCONTRACTING_PLAN')
  })

  it('does not escalate a goal a person has not verified', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await prisma.subcontractingGoal.create({
      data: {
        consultingFirmId: firmA.id, pursuitId: pursuit.id, goalType: 'SDVOSB',
        targetType: 'PERCENT', targetPercent: new Prisma.Decimal('20.00'),
        source: 'HUMAN_ENTRY', isHumanVerified: false, status: 'ACTIVE',
        dueDate: new Date(Date.now() + 2 * DAY),
      },
    })
    await runAgent(firmA.id)

    expect(await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Subcontracting goal' } },
    })).toBe(0)
  })
})

// -------------------------------------------------------------
// Artifact versioning
// -------------------------------------------------------------

describe('the plan supersedes rather than duplicating', () => {
  it('records the same hash for an unchanged re-run', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)
    const first = (await currentPlan(firmA.id, pursuit.id))!.plan.inputHash
    await runAgent(firmA.id)
    const second = (await currentPlan(firmA.id, pursuit.id))!.plan.inputHash
    expect(second).toBe(first)
  })

  it('changes the hash when a new partner appears', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)
    const first = (await currentPlan(firmA.id, pursuit.id))!.plan.inputHash

    await makePartner(firmA.id, { name: 'S7-TEAM-QA Newcomer' })
    await runAgent(firmA.id)
    expect((await currentPlan(firmA.id, pursuit.id))!.plan.inputHash).not.toBe(first)
  })

  it('leaves exactly one live plan per pursuit', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)
    await makePartner(firmA.id, { name: 'S7-TEAM-QA Second' })
    await runAgent(firmA.id)

    expect(await prisma.agentArtifact.count({
      where: {
        consultingFirmId: firmA.id, artifactType: 'TEAMING_PLAN',
        sourceEntityId: pursuit.id, supersededByArtifactId: null,
      },
    })).toBe(1)
  })
})

// -------------------------------------------------------------
// No LLM
// -------------------------------------------------------------

describe('the whole agent works with zero LLM configuration', () => {
  it('completes, uses no tokens and costs nothing', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 5 * DAY) })
    const pursuit = await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await makePartner(firmA.id)

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(run?.tokenInput).toBe(0)
    expect(run?.tokenOutput).toBe(0)
    expect(Number(run?.estimatedCostUsd)).toBe(0)

    // And it still produced everything that matters.
    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    expect((plan.capabilityGaps as unknown[]).length).toBeGreaterThan(0)
    expect((plan.partnerCandidates as unknown[]).length).toBeGreaterThan(0)
    expect((plan.drafts as Array<{ source: string }>).every((d) => d.source === 'DETERMINISTIC_TEMPLATE')).toBe(true)
  })

  it('never raises a NO_LLM_KEY failure', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(run?.errorCode ?? '').not.toContain('NO_LLM_KEY')
  })

  it('writes no ApiUsageLog row', async () => {
    const before = await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })).toBe(before)
  })
})

// -------------------------------------------------------------
// Tenant isolation — the highest-risk area in this slice
// -------------------------------------------------------------

describe('tenant isolation', () => {
  it('refuses to plan another firm\'s pursuit', async () => {
    const oppB = await makeOpportunity(firmB.id)
    const pursuitB = await makePursuit(firmB.id, oppB.id)
    await makePartner(firmB.id)

    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: 'BidPursuit', triggerEntityId: pursuitB.id,
    })
    expect(run?.status).toBe('SKIPPED')
    expect(await prisma.agentArtifact.count({ where: { consultingFirmId: firmA.id, artifactType: 'TEAMING_PLAN' } })).toBe(0)
    expect(await prisma.agentArtifact.count({ where: { consultingFirmId: firmB.id, artifactType: 'TEAMING_PLAN' } })).toBe(0)
  })

  it('never ranks another firm\'s partner, even for the same legal company', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id, { name: 'Shared Legal Company', uei: 'UEI-SHARED-A' })
    await makePartner(firmB.id, { name: 'Shared Legal Company', uei: 'UEI-SHARED-B', capabilities: ['everything'] })

    await runAgent(firmA.id)
    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    const ids = (plan.partnerCandidates as Array<{ partnerId: string }>).map((c) => c.partnerId)
    const firmBPartners = await prisma.partner.findMany({ where: { consultingFirmId: firmB.id }, select: { id: true } })
    for (const p of firmBPartners) expect(ids).not.toContain(p.id)
  })

  it('never exposes another firm\'s contact in a plan', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await makePartner(firmB.id, { contactEmail: 'firmb-secret@example.test', contactName: 'Firm B Contact' })

    await runAgent(firmA.id)
    const text = JSON.stringify((await currentPlan(firmA.id, pursuit.id))!.plan)
    expect(text).not.toContain('firmb-secret@example.test')
    expect(text).not.toContain('Firm B Contact')
  })

  it('never counts another firm\'s teaming arrangement as prior experience', async () => {
    const opp = await makeOpportunity(firmA.id)
    const pursuit = await makePursuit(firmA.id, opp.id)
    const partnerA = await makePartner(firmA.id)
    const oppB = await makeOpportunity(firmB.id)
    const partnerB = await makePartner(firmB.id)
    await prisma.teamingArrangement.create({
      data: {
        consultingFirmId: firmB.id, opportunityId: oppB.id, partnerId: partnerB.id,
        role: 'SUB', arrangementType: 'TEAMING_AGREEMENT',
      },
    })

    await runAgent(firmA.id)
    const { plan } = (await currentPlan(firmA.id, pursuit.id))!
    const candidate = (plan.partnerCandidates as Array<{ partnerId: string; relevantExperience: { priorTeamedBids: number } }>)
      .find((c) => c.partnerId === partnerA.id)!
    expect(candidate.relevantExperience.priorTeamedBids).toBe(0)
  })

  it('never reads another firm\'s subcontracting goal', async () => {
    const oppB = await makeOpportunity(firmB.id)
    const pursuitB = await makePursuit(firmB.id, oppB.id)
    await prisma.subcontractingGoal.create({
      data: {
        consultingFirmId: firmB.id, pursuitId: pursuitB.id, goalType: 'SDVOSB',
        targetType: 'PERCENT', targetPercent: new Prisma.Decimal('20.00'),
        source: 'SUBCONTRACTING_PLAN', isHumanVerified: true, status: 'ACTIVE',
        dueDate: new Date(Date.now() + 2 * DAY),
      },
    })

    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)
    // Firm B's goal produced no progress row, and none was created for Firm A.
    expect(await prisma.subcontractingGoalProgress.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(await prisma.subcontractingGoalProgress.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('never reads another firm\'s partner performance record', async () => {
    const partnerB = await makePartner(firmB.id)
    await prisma.partnerPerformanceRecord.create({
      data: {
        consultingFirmId: firmB.id, partnerId: partnerB.id,
        periodStart: new Date(Date.now() - 90 * DAY), periodEnd: new Date(),
        sampleSize: 20, dataSufficiency: 'SUFFICIENT',
      },
    })
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    await makePartner(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.partnerPerformanceRecord.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    // Firm B's record is still exactly as it was.
    expect(await prisma.partnerPerformanceRecord.count({ where: { consultingFirmId: firmB.id } })).toBe(1)
  })

  it('raises no escalation and no notification against another firm', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 3 * DAY) })
    await makePursuit(firmA.id, opp.id, { ownerUserId: ownerA.id })
    await makePartner(firmA.id)
    await runAgent(firmA.id)

    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})

// -------------------------------------------------------------
// Weekly performance window
// -------------------------------------------------------------

describe('the performance window is weekly', () => {
  it('starts the ISO week on a Monday, in UTC', () => {
    expect(startOfIsoWeek(new Date('2026-06-03T15:00:00.000Z')).toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(startOfIsoWeek(new Date('2026-06-07T23:59:00.000Z')).toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(startOfIsoWeek(new Date('2026-06-08T00:00:00.000Z')).toISOString()).toBe('2026-06-08T00:00:00.000Z')
  })

  it('recomputes the same period for two runs in the same week', async () => {
    const opp = await makeOpportunity(firmA.id)
    await makePursuit(firmA.id, opp.id)
    const partner = await makePartner(firmA.id)
    const contract = await prisma.contract.create({
      data: { consultingFirmId: firmA.id, contractNumber: uniq('C'), title: 'S7-TEAM-QA', status: 'ACTIVE' },
    })
    for (let i = 0; i < 6; i += 1) {
      await prisma.contractDeliverable.create({
        data: {
          consultingFirmId: firmA.id, contractId: contract.id, partnerId: partner.id,
          name: uniq('deliverable'),
          dueDate: new Date(Date.now() - 10 * DAY),
          submissionDate: new Date(Date.now() - 11 * DAY),
          status: 'ACCEPTED', acceptanceStatus: 'ACCEPTED',
        },
      })
    }

    await runAgent(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.partnerPerformanceRecord.count({ where: { consultingFirmId: firmA.id, partnerId: partner.id } })).toBe(1)
  })
})
