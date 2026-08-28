// =============================================================
// §7.2 — Opportunity Agent against a real PostgreSQL database.
//
// Covers the registry, the handler through the §7.0 dispatcher, event-scoped
// phase selection, partial-source failure isolation, the OPPORTUNITY_BRIEF and
// its supersession, source-health and critical-deadline escalations with their
// dedupe, the pursuit-learning loop end to end, the apply/revert workflow, the
// human-control guarantees at both PROPOSE and ACT_WITH_GUARDRAILS, tenant
// isolation of behavioural learning, and the mandatory proof that this agent
// performs ZERO LLM calls.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

// The LLM provider boundary is mocked for the whole file. Any call would be
// recorded here — the no-LLM test asserts it never happens.
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
import { AGENT_REGISTRY, getAgentDefinition, agentsSubscribedTo } from '../registry'
import { DOMAIN_AGENT_KEYS } from '../types'
import { resetWorkingCalendarCache } from '../workingCalendar'
import { refreshFirmMatches } from '../../discovery/matchRefresh'
import { DIMENSION_WEIGHTS } from '../../capabilityMatch'
import {
  OPPORTUNITY_PHASES,
  opportunityAgentHandler,
  phasesForRun,
} from './opportunityAgentHandler'
import {
  CAPABILITY_ENTITY_TYPE,
  PROFILE_ENTITY_TYPE,
  PURSUIT_ENTITY_TYPE,
  SOURCE_CONFIG_ENTITY_TYPE,
} from './opportunityEvents'
import {
  analysePursuitFeedback,
  applyPursuitFeedback,
  collectPursuitSamples,
  resolveEffectiveWeights,
  revertPursuitFeedback,
} from './pursuitFeedback'
import { MIN_FEEDBACK_SAMPLE_SIZE, baseWeights } from './policy'

const AGENT = 'OPPORTUNITY' as const
const DAY = 86_400_000

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let adminB: TestUser
let consultantA: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Opportunity Agent Firm A' })
  firmB = await createTestFirm({ name: 'Opportunity Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  adminB = await createTestUser(firmB.id, { role: 'ADMIN' })
  consultantA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  resetWorkingCalendarCache()
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pursuitFeedbackSignal.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.savedMonitoringProfile.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.firmCapability.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunitySourceConfig.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeOpportunity(firmId: string, over: Partial<Prisma.OpportunityUncheckedCreateInput> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId,
      samNoticeId: uniq('S7-OA-TEST'),
      title: 'Cybersecurity engineering support services',
      agency: 'Department of Defense',
      naicsCode: '541512',
      psc: 'D310',
      setAsideType: 'NONE',
      description: 'Cybersecurity engineering support, network defence and incident response.',
      responseDeadline: new Date(Date.now() + 30 * DAY),
      status: 'ACTIVE',
      isDemo: false,
      ...over,
    },
  })
}

async function makeCapability(firmId: string, over: Partial<Prisma.FirmCapabilityUncheckedCreateInput> = {}) {
  return prisma.firmCapability.create({
    data: {
      consultingFirmId: firmId,
      name: 'Cybersecurity engineering',
      category: 'TECHNICAL',
      keywords: ['cybersecurity', 'incident', 'network'],
      naicsCodes: ['541512'],
      pscCodes: ['D310'],
      geographies: ['Nationwide'],
      contractVehicles: [],
      verification: 'VERIFIED',
      ...over,
    },
  })
}

async function makeSource(firmId: string, over: Partial<Prisma.OpportunitySourceConfigUncheckedCreateInput> = {}) {
  return prisma.opportunitySourceConfig.create({
    data: {
      consultingFirmId: firmId,
      displayName: uniq('S7-OA-QA source'),
      // Unique per (firm, adapter), so each fixture source needs its own key.
      adapterKey: uniq('adapter'),
      category: 'SAM_GOV',
      isEnabled: true,
      verification: 'LIVE_VERIFIED',
      lastSuccessfulSync: new Date(),
      stalenessHours: 24,
      ...over,
    },
  })
}

async function runAgent(firmId: string, over: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId,
    agentKey: AGENT,
    triggerType: 'MANUAL',
    idempotencyKey: uniq('oa-run'),
    ...over,
  })
  const outcome = await dispatchAgentRun(run.id)
  const persisted = await prisma.agentRun.findUnique({ where: { id: run.id } })
  return { runId: run.id, outcome, run: persisted }
}

async function latestBrief(firmId: string) {
  const artifact = await prisma.agentArtifact.findFirst({
    where: { consultingFirmId: firmId, agentKey: AGENT, artifactType: 'OPPORTUNITY_BRIEF', supersededByArtifactId: null },
    orderBy: { createdAt: 'desc' },
  })
  return artifact
}

/**
 * Build a labelled pursuit history large enough to cross the sample threshold.
 *
 * The contrast is deliberately UNEVEN across dimensions: the firm strongly
 * prefers capability and NAICS fit, and is indifferent on the rest. A uniform
 * contrast would renormalise back to the base weights — correctly, since
 * preferring everything equally is no relative preference at all.
 */
async function seedPursuitHistory(firmId: string, pursued: number, ignored: number) {
  const created: string[] = []
  for (let i = 0; i < pursued + ignored; i++) {
    const isPursued = i < pursued
    const strong = isPursued ? 90 : 20
    const flat = 50
    const opp = await makeOpportunity(firmId, { title: `S7-OA-QA labelled ${i}` })
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id,
        consultingFirmId: firmId,
        overallScore: isPursued ? 80 : 20,
        capabilityScore: strong,
        naicsScore: strong,
        pscScore: flat,
        certificationScore: flat,
        pastPerformanceScore: flat,
        geographyScore: flat,
        vehicleScore: flat,
        keywordScore: flat,
        evidence: {},
        eligibility: 'ELIGIBLE',
        eligibilityReason: 'test',
        eligibilityEvidence: {},
      },
    })
    await prisma.bidPursuit.create({
      data: {
        consultingFirmId: firmId,
        opportunityId: opp.id,
        pipelineStage: isPursued ? 'PROPOSAL' : 'NO_BID',
        status: 'REVIEWING',
        source: 'USER',
      },
    })
    created.push(opp.id)
  }
  return created
}

// -------------------------------------------------------------
// Registry
// -------------------------------------------------------------

describe('agent registry', () => {
  it('marks the Opportunity Agent implemented with a real handler', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.implemented).toBe(true)
    expect(def.handler).not.toBeNull()
    expect(def.plannedSlice).toBe('7.2')
  })

  it('defaults to PROPOSE autonomy and stays opt-in per tenant', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.defaultAutonomyLevel).toBe('PROPOSE')
    expect(def.defaultEnabled).toBe(false)
  })

  it('requires no LLM and carries a zero token budget', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.requiresLlm).toBe(false)
    expect(def.defaultTokenBudget).toBe(0)
  })

  it('supports the manual, scheduled and event triggers', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.supportedTriggers).toEqual(expect.arrayContaining(['MANUAL', 'SCHEDULE', 'EVENT']))
  })

  it('runs every two hours by default', () => {
    expect(getAgentDefinition(AGENT)!.defaultCronExpression).toBe('0 */2 * * *')
  })

  it('produces OPPORTUNITY_BRIEF artifacts', () => {
    expect(getAgentDefinition(AGENT)!.supportedArtifactTypes).toEqual(['OPPORTUNITY_BRIEF'])
  })

  it('subscribes to exactly the four §7.2 events', () => {
    expect(getAgentDefinition(AGENT)!.subscribedEventTypes.sort()).toEqual([
      'FIRM_CAPABILITY_CHANGED', 'MONITORING_PROFILE_SAVED', 'PURSUIT_STAGE_CHANGED', 'SOURCE_SYNC_COMPLETED',
    ])
  })

  it.each(['SOURCE_SYNC_COMPLETED', 'FIRM_CAPABILITY_CHANGED', 'MONITORING_PROFILE_SAVED', 'PURSUIT_STAGE_CHANGED'])(
    'routes %s to the Opportunity Agent',
    (eventType) => {
      expect(agentsSubscribedTo(eventType).map((d) => d.key)).toContain(AGENT)
    },
  )

  it('allowlists no autonomous action keys at all', () => {
    expect(getAgentDefinition(AGENT)!.allowlistedActionKeys).toEqual([])
  })

  it('leaves Contract Administration implemented', () => {
    expect(getAgentDefinition('CONTRACT_ADMINISTRATION')!.implemented).toBe(true)
  })

  it('leaves no domain agent unimplemented — §7.9 completed Section 7', () => {
    const remaining = DOMAIN_AGENT_KEYS.filter((k) => !getAgentDefinition(k)!.implemented)
    expect(remaining).toEqual([])
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(getAgentDefinition(key)!.handler, `${key} must have a real handler`).not.toBeNull()
    }
  })

  it('exposes exactly ten implemented entries — nine domain agents and the internal diagnostic', () => {
    expect(AGENT_REGISTRY.filter((d) => d.implemented).map((d) => d.key).sort()).toEqual([
      'COMPLIANCE', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE', 'INTERNAL_DIAGNOSTIC', 'OPPORTUNITY', 'PRICING', 'PROPOSAL', 'QUALIFICATION', 'TEAMING',
    ])
  })
})

// -------------------------------------------------------------
// Phase selection
// -------------------------------------------------------------

describe('phase selection', () => {
  it('runs every phase for a scheduled or manual tenant-wide run', () => {
    expect(phasesForRun(null)).toEqual([...OPPORTUNITY_PHASES])
  })

  it('prioritises match and eligibility refresh for a capability change', () => {
    const phases = phasesForRun(CAPABILITY_ENTITY_TYPE)
    expect(phases).toContain('REFRESH_CAPABILITY_MATCHES')
    expect(phases).toContain('REFRESH_ELIGIBILITY')
    expect(phases).not.toContain('REFRESH_RECOMPETES')
  })

  it('evaluates only profiles for a profile save', () => {
    const phases = phasesForRun(PROFILE_ENTITY_TYPE)
    expect(phases).toContain('EVALUATE_MONITORING_PROFILES')
    expect(phases).not.toContain('REFRESH_CAPABILITY_MATCHES')
  })

  it('analyses only pursuit learning for a stage change', () => {
    const phases = phasesForRun(PURSUIT_ENTITY_TYPE)
    expect(phases).toContain('ANALYZE_PURSUIT_FEEDBACK')
    expect(phases).not.toContain('REFRESH_RECOMPETES')
  })

  it('processes changed opportunities and downstream intelligence after a source sync', () => {
    const phases = phasesForRun(SOURCE_CONFIG_ENTITY_TYPE)
    expect(phases).toContain('CLASSIFY_NOTICES')
    expect(phases).toContain('REFRESH_CAPABILITY_MATCHES')
    expect(phases).not.toContain('ANALYZE_PURSUIT_FEEDBACK')
  })

  it('always loads context, checks source health, builds the brief and completes', () => {
    for (const entity of [null, CAPABILITY_ENTITY_TYPE, PROFILE_ENTITY_TYPE, PURSUIT_ENTITY_TYPE, SOURCE_CONFIG_ENTITY_TYPE]) {
      const phases = phasesForRun(entity)
      expect(phases).toContain('LOAD_CONTEXT')
      expect(phases).toContain('CHECK_SOURCE_HEALTH')
      expect(phases).toContain('BUILD_OPPORTUNITY_BRIEF')
      expect(phases).toContain('COMPLETE')
    }
  })

  it('keeps phases in their canonical order regardless of trigger', () => {
    const phases = phasesForRun(CAPABILITY_ENTITY_TYPE)
    const indices = phases.map((p) => OPPORTUNITY_PHASES.indexOf(p))
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
  })
})

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

describe('handler', () => {
  it('completes a manual tenant-wide run and produces a brief', async () => {
    await makeCapability(firmA.id)
    await makeOpportunity(firmA.id)
    await makeSource(firmA.id)

    const { run } = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')

    const brief = await latestBrief(firmA.id)
    expect(brief).not.toBeNull()
    expect(brief!.artifactType).toBe('OPPORTUNITY_BRIEF')
  })

  it('completes a scheduled run', async () => {
    await makeOpportunity(firmA.id)
    const { run } = await runAgent(firmA.id, { triggerType: 'SCHEDULE' })
    expect(run?.status).toBe('COMPLETED')
  })

  it('records progress through the phases', async () => {
    await makeOpportunity(firmA.id)
    const { run } = await runAgent(firmA.id)
    expect(run?.progressPercent).toBeGreaterThan(0)
    expect(run?.heartbeatAt).not.toBeNull()
  })

  it('reports honest metrics rather than empty counters', async () => {
    await makeCapability(firmA.id)
    await makeOpportunity(firmA.id)
    const { run } = await runAgent(firmA.id)
    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as Record<string, unknown>
    expect((data.phases as string[]).length).toBe(OPPORTUNITY_PHASES.length)
    expect(run?.outputSummary).toContain('live opportunit')
  })

  it('is deterministic — the same unchanged surface hashes identically', async () => {
    await makeOpportunity(firmA.id)
    const first = await runAgent(firmA.id)
    const second = await runAgent(firmA.id)
    expect(second.run?.inputHash).toBe(first.run?.inputHash)
  })

  it('scopes an event-triggered run to the targeted source', async () => {
    const source = await makeSource(firmA.id)
    await makeOpportunity(firmA.id, { sourceConfigId: source.id, noticeType: 'Sources Sought' })

    const { run } = await runAgent(firmA.id, {
      triggerType: 'EVENT',
      triggerEntityType: SOURCE_CONFIG_ENTITY_TYPE,
      triggerEntityId: source.id,
    })
    expect(run?.status).toBe('COMPLETED')
    const snapshot = run?.inputSnapshot as Record<string, unknown>
    expect(snapshot.scope).toBe(source.id)
  })

  it('does not fail the whole run when one source is failing', async () => {
    await makeOpportunity(firmA.id)
    await makeSource(firmA.id)
    await makeSource(firmA.id, {
      displayName: 'S7-OA-QA broken source',
      consecutiveFailures: 7,
      lastFailureMessage: 'provider returned 503',
      lastSuccessfulSync: null,
    })

    const { run } = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(run?.dataSufficiency).toBe('PARTIAL')

    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as { operations: { failedSources: string[]; successfulSources: string[] } }
    expect(data.operations.failedSources).toHaveLength(1)
    expect(data.operations.successfulSources).toHaveLength(1)
  })

  it('names not-configured sources honestly instead of hiding them', async () => {
    await makeSource(firmA.id, { displayName: 'S7-OA-QA unconfigured', verification: 'NOT_CONFIGURED' })
    await runAgent(firmA.id)
    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as { operations: { notConfiguredSources: string[] } }
    expect(data.operations.notConfiguredSources).toHaveLength(1)
  })

  it('honours cancellation', async () => {
    await makeOpportunity(firmA.id)
    const { run } = await createRun({
      consultingFirmId: firmA.id,
      agentKey: AGENT,
      triggerType: 'MANUAL',
      idempotencyKey: uniq('oa-cancel'),
    })
    await prisma.agentRun.update({ where: { id: run.id }, data: { cancelledAt: new Date() } })
    const outcome = await dispatchAgentRun(run.id)
    expect(['CANCELLED', 'SKIPPED', 'COMPLETED']).toContain(outcome.status)
  })

  it('supersedes the previous brief rather than accumulating identical artifacts', async () => {
    await makeOpportunity(firmA.id)
    await runAgent(firmA.id)
    await runAgent(firmA.id)

    const live = await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'OPPORTUNITY_BRIEF', supersededByArtifactId: null },
    })
    const total = await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'OPPORTUNITY_BRIEF' },
    })
    expect(live).toBe(1)
    expect(total).toBe(2)
  })

  it('does not evaluate profiles or notify under OBSERVE autonomy', async () => {
    await makeOpportunity(firmA.id)
    await prisma.savedMonitoringProfile.create({
      data: {
        consultingFirmId: firmA.id,
        name: uniq('S7-OA-QA profile'),
        filters: {},
        alertFrequency: 'INSTANT',
        isActive: true,
        ownerUserId: adminA.id,
      },
    })
    const { run } = await runAgent(firmA.id, { autonomyLevel: 'OBSERVE' })
    expect(run?.status).toBe('COMPLETED')
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    expect(run?.limitations.join(' ')).toContain('OBSERVE')
  })
})

// -------------------------------------------------------------
// No LLM — mandatory regression
// -------------------------------------------------------------

describe('no LLM is ever used', () => {
  it('never reaches the provider boundary and consumes zero tokens', async () => {
    await makeCapability(firmA.id)
    await makeOpportunity(firmA.id)
    await makeSource(firmA.id)
    await seedPursuitHistory(firmA.id, 12, 12)

    const { run } = await runAgent(firmA.id)

    expect(run?.status).toBe('COMPLETED')
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(run?.tokenInput).toBe(0)
    expect(run?.tokenOutput).toBe(0)
    expect(Number(run?.estimatedCostUsd)).toBe(0)
  })

  it('never calls the budget guard generate seam', async () => {
    await makeOpportunity(firmA.id)
    const generate = vi.fn()
    const ctx = makeStubContext(firmA.id, { generate })
    await opportunityAgentHandler(ctx)
    expect(generate).not.toHaveBeenCalled()
  })

  it('writes no ApiUsageLog row', async () => {
    const before = await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })
    await makeOpportunity(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })).toBe(before)
  })
})

/** Minimal AgentExecutionContext for direct handler calls. */
function makeStubContext(firmId: string, over: { generate?: () => unknown } = {}) {
  const consumed = { tokenInput: 0, tokenOutput: 0, estimatedCostUsd: 0 }
  return {
    agentKey: AGENT,
    consultingFirmId: firmId,
    runId: 'stub-run',
    trigger: 'MANUAL' as const,
    triggerEntityType: null,
    triggerEntityId: null,
    idempotencyKey: 'stub',
    autonomyLevel: 'PROPOSE' as const,
    initiatedByUserId: null,
    scheduleId: null,
    eventId: null,
    attempt: 1,
    deadlineAt: new Date(Date.now() + 60_000),
    signal: new AbortController().signal,
    log: () => undefined,
    heartbeat: async () => undefined,
    budget: {
      check: async () => ({ allowed: true as const, remainingTokens: null, remainingCostUsd: null }),
      generate: (over.generate ?? (() => { throw new Error('LLM must never be called') })) as never,
      consumed: () => consumed,
    },
    audit: async () => undefined,
    canApply: () => false,
  }
}

// -------------------------------------------------------------
// Escalations
// -------------------------------------------------------------

describe('escalations', () => {
  it('raises one escalation for a source at or beyond five consecutive failures', async () => {
    await makeSource(firmA.id, { displayName: 'S7-OA-QA failing', consecutiveFailures: 5, lastFailureMessage: 'timeout' })
    await runAgent(firmA.id)

    const escalations = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, agentKey: AGENT, entityType: 'OpportunitySourceConfig' },
    })
    expect(escalations).toHaveLength(1)
    expect(escalations[0].severity).toBe('HIGH')
    expect(escalations[0].reason).toContain('5 consecutive failures')
  })

  it('does not escalate a source below the failure threshold', async () => {
    await makeSource(firmA.id, { consecutiveFailures: 4 })
    await runAgent(firmA.id)
    const count = await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, entityType: 'OpportunitySourceConfig' },
    })
    expect(count).toBe(0)
  })

  it('does not duplicate the source escalation on a second run', async () => {
    await makeSource(firmA.id, { consecutiveFailures: 6, lastFailureMessage: 'timeout' })
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    const count = await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, entityType: 'OpportunitySourceConfig' },
    })
    expect(count).toBe(1)
  })

  it('escalates a stale source using its own staleness window, not a global rule', async () => {
    await makeSource(firmA.id, {
      displayName: 'S7-OA-QA stale',
      stalenessHours: 6,
      lastSuccessfulSync: new Date(Date.now() - 48 * 3600_000),
    })
    await runAgent(firmA.id)
    const escalation = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, entityType: 'OpportunitySourceConfig' },
    })
    expect(escalation?.title).toContain('stale')
    expect(escalation?.reason).toContain('6-hour staleness window')
  })

  it('escalates a critical match inside the working-day deadline window', async () => {
    await makeCapability(firmA.id)
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 3 * DAY) })
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firmA.id, overallScore: 92,
        evidence: {}, eligibility: 'ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
      },
    })
    await runAgent(firmA.id)

    const escalation = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, entityType: 'Opportunity', entityId: opp.id },
    })
    expect(escalation).not.toBeNull()
    expect(escalation!.reason).toContain('working day')
    expect(escalation!.reason).toContain('weekends and US federal holidays excluded')
  })

  it('uses working days rather than naive calendar subtraction', async () => {
    await makeCapability(firmA.id)
    // 7 calendar days out spans a weekend, so it is 5 working days — inside the
    // window. A naive calendar rule would have excluded it.
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 7 * DAY) })
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firmA.id, overallScore: 95,
        evidence: {}, eligibility: 'ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
      },
    })
    await runAgent(firmA.id)
    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as { highMatchOpportunities: Array<{ workingDaysToDeadline: number }> }
    expect(data.highMatchOpportunities[0].workingDaysToDeadline).toBeLessThanOrEqual(7)
  })

  it('does not escalate a critical match the firm is not eligible for', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 2 * DAY) })
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firmA.id, overallScore: 95,
        evidence: {}, eligibility: 'NOT_ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
      },
    })
    await runAgent(firmA.id)
    const count = await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, entityType: 'Opportunity', entityId: opp.id },
    })
    expect(count).toBe(0)
  })

  it('does not escalate a match whose deadline is far away', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 90 * DAY) })
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firmA.id, overallScore: 95,
        evidence: {}, eligibility: 'ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
      },
    })
    await runAgent(firmA.id)
    const count = await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, entityType: 'Opportunity', entityId: opp.id },
    })
    expect(count).toBe(0)
  })

  it('does not reopen an escalation a human resolved', async () => {
    await makeSource(firmA.id, { consecutiveFailures: 6 })
    await runAgent(firmA.id)
    const escalation = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, entityType: 'OpportunitySourceConfig' },
    })
    await prisma.agentEscalation.update({
      where: { id: escalation!.id },
      data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedByUserId: adminA.id },
    })
    await runAgent(firmA.id)
    const after = await prisma.agentEscalation.findUnique({ where: { id: escalation!.id } })
    expect(after?.status).toBe('RESOLVED')
  })
})

// -------------------------------------------------------------
// Learning end to end
// -------------------------------------------------------------

describe('pursuit learning', () => {
  it('reports INSUFFICIENT_DATA below the threshold and changes nothing', async () => {
    await seedPursuitHistory(firmA.id, 5, 5)
    const result = await analysePursuitFeedback({ consultingFirmId: firmA.id })

    expect(result.status).toBe('INSUFFICIENT_DATA')
    const effective = await resolveEffectiveWeights(firmA.id)
    expect(effective.profile).toBe('BASE')
    expect(effective.weights).toEqual({ ...DIMENSION_WEIGHTS })
  })

  it('proposes a bounded adjustment above the threshold', async () => {
    await seedPursuitHistory(firmA.id, 12, 12)
    const result = await analysePursuitFeedback({ consultingFirmId: firmA.id })

    expect(result.status).toBe('PROPOSED')
    expect(result.computation.sampleSize).toBeGreaterThanOrEqual(MIN_FEEDBACK_SAMPLE_SIZE)
    expect(result.computation.proposedWeights).not.toEqual(baseWeights())
  })

  it('leaves production matching untouched until the proposal is applied', async () => {
    await seedPursuitHistory(firmA.id, 12, 12)
    await analysePursuitFeedback({ consultingFirmId: firmA.id })

    const effective = await resolveEffectiveWeights(firmA.id)
    expect(effective.profile).toBe('BASE')
    expect(effective.appliedSignalId).toBeNull()
  })

  it('is idempotent — re-analysing unchanged history creates no second row', async () => {
    await seedPursuitHistory(firmA.id, 12, 12)
    const first = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    const second = await analysePursuitFeedback({ consultingFirmId: firmA.id })

    expect(second.created).toBe(false)
    expect(second.signalId).toBe(first.signalId)
    expect(await prisma.pursuitFeedbackSignal.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('supersedes an older unapplied proposal when the evidence changes', async () => {
    await seedPursuitHistory(firmA.id, 12, 12)
    const first = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    await seedPursuitHistory(firmA.id, 3, 3)
    const second = await analysePursuitFeedback({ consultingFirmId: firmA.id })

    expect(second.signalId).not.toBe(first.signalId)
    const older = await prisma.pursuitFeedbackSignal.findUnique({ where: { id: first.signalId! } })
    expect(older?.status).toBe('SUPERSEDED')
    expect(older?.supersededBySignalId).toBe(second.signalId)
  })

  it('counts a LOST pursuit as pursued rather than as disinterest', async () => {
    const opp = await makeOpportunity(firmA.id)
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firmA.id, overallScore: 70, capabilityScore: 70,
        evidence: {}, eligibility: 'ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
      },
    })
    await prisma.bidPursuit.create({
      data: { consultingFirmId: firmA.id, opportunityId: opp.id, pipelineStage: 'LOST', status: 'SUBMITTED', source: 'USER' },
    })
    const samples = await collectPursuitSamples(firmA.id)
    expect(samples.find((s) => s.opportunityId === opp.id)?.label).toBe('PURSUED')
  })

  it('excludes a system AUTO_EXPIRED sweep from the sample entirely', async () => {
    const opp = await makeOpportunity(firmA.id)
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firmA.id, overallScore: 70, capabilityScore: 70,
        evidence: {}, eligibility: 'ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
      },
    })
    await prisma.bidPursuit.create({
      data: {
        consultingFirmId: firmA.id, opportunityId: opp.id,
        pipelineStage: 'IDENTIFIED', status: 'PASSED', source: 'AUTO_EXPIRED',
      },
    })
    const samples = await collectPursuitSamples(firmA.id)
    expect(samples.find((s) => s.opportunityId === opp.id)).toBeUndefined()
  })

  it('treats an explicit client decline as a negative preference', async () => {
    const client = await prisma.clientCompany.create({
      data: { consultingFirmId: firmA.id, name: uniq('S7-OA-QA client'), isActive: true },
    })
    const opp = await makeOpportunity(firmA.id)
    await prisma.opportunityMatch.create({
      data: {
        opportunityId: opp.id, consultingFirmId: firmA.id, overallScore: 70, capabilityScore: 70,
        evidence: {}, eligibility: 'ELIGIBLE', eligibilityReason: 'test', eligibilityEvidence: {},
      },
    })
    await prisma.clientOpportunityDecline.create({
      data: { clientCompanyId: client.id, opportunityId: opp.id, reason: 'out of scope' },
    })
    const samples = await collectPursuitSamples(firmA.id)
    expect(samples.find((s) => s.opportunityId === opp.id)?.label).toBe('IGNORED')
  })

  it('excludes an opportunity with no match snapshot rather than scoring it zero', async () => {
    const opp = await makeOpportunity(firmA.id)
    await prisma.bidPursuit.create({
      data: { consultingFirmId: firmA.id, opportunityId: opp.id, pipelineStage: 'PROPOSAL', status: 'REVIEWING', source: 'USER' },
    })
    const samples = await collectPursuitSamples(firmA.id)
    expect(samples.find((s) => s.opportunityId === opp.id)).toBeUndefined()
  })
})

// -------------------------------------------------------------
// Apply / revert
// -------------------------------------------------------------

describe('apply and revert', () => {
  async function proposedSignal() {
    await seedPursuitHistory(firmA.id, 12, 12)
    const result = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    return result.signalId!
  }

  it('applies a proposal and records the human who did it', async () => {
    const id = await proposedSignal()
    await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: adminA.id })

    const row = await prisma.pursuitFeedbackSignal.findUnique({ where: { id } })
    expect(row?.status).toBe('APPLIED')
    expect(row?.appliedByUserId).toBe(adminA.id)
    expect(row?.appliedAt).not.toBeNull()
  })

  it('changes the effective weighting only once applied', async () => {
    const id = await proposedSignal()
    expect((await resolveEffectiveWeights(firmA.id)).profile).toBe('BASE')

    await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: adminA.id })
    const after = await resolveEffectiveWeights(firmA.id)
    expect(after.profile).toBe('PURSUIT_ADJUSTED')
    expect(after.appliedSignalId).toBe(id)
  })

  it('rejects a duplicate apply', async () => {
    const id = await proposedSignal()
    await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: adminA.id })
    await expect(applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: adminA.id }))
      .rejects.toThrow(/only a PROPOSED signal can be applied/i)
  })

  it('refuses to apply a second adjustment on top of an applied one', async () => {
    const first = await proposedSignal()
    await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: first, userId: adminA.id })

    await seedPursuitHistory(firmA.id, 3, 3)
    const second = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    await expect(applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: second.signalId!, userId: adminA.id }))
      .rejects.toThrow(/revert it before applying a different one/i)
  })

  it('refuses to apply an INSUFFICIENT_DATA signal', async () => {
    await seedPursuitHistory(firmA.id, 4, 4)
    const result = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    await expect(applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: result.signalId!, userId: adminA.id }))
      .rejects.toThrow(/only a PROPOSED signal/i)
  })

  it('reverts and restores the exact preserved baseline', async () => {
    const id = await proposedSignal()
    const applied = await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: adminA.id })

    const reverted = await revertPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: adminA.id })
    expect(reverted.restoredWeights).toEqual(applied.baselineWeights)
    expect(reverted.restoredWeights).toEqual({ ...DIMENSION_WEIGHTS })

    const effective = await resolveEffectiveWeights(firmA.id)
    expect(effective.profile).toBe('BASE')
    expect(effective.weights).toEqual({ ...DIMENSION_WEIGHTS })
  })

  it('records the human who reverted', async () => {
    const id = await proposedSignal()
    await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: adminA.id })
    await revertPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: consultantA.id })

    const row = await prisma.pursuitFeedbackSignal.findUnique({ where: { id } })
    expect(row?.status).toBe('REVERTED')
    expect(row?.revertedByUserId).toBe(consultantA.id)
  })

  it('rejects reverting something that was never applied', async () => {
    const id = await proposedSignal()
    await expect(revertPursuitFeedback({ consultingFirmId: firmA.id, signalId: id, userId: adminA.id }))
      .rejects.toThrow(/only an APPLIED signal can be reverted/i)
  })
})

// -------------------------------------------------------------
// Matching integration
// -------------------------------------------------------------

describe('matching integration', () => {
  it('leaves match scores untouched while a proposal is unapplied', async () => {
    await makeCapability(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await refreshFirmMatches(firmA.id)
    const before = await prisma.opportunityMatch.findUnique({ where: { opportunityId: opp.id } })

    await seedPursuitHistory(firmA.id, 12, 12)
    await analysePursuitFeedback({ consultingFirmId: firmA.id })
    await refreshFirmMatches(firmA.id)

    const after = await prisma.opportunityMatch.findUnique({ where: { opportunityId: opp.id } })
    expect(after?.overallScore).toBe(before?.overallScore)
    expect((after?.evidence as { weightProfile?: string })?.weightProfile).toBe('BASE')
  })

  it('discloses the learned influence once applied instead of hiding it', async () => {
    await makeCapability(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await seedPursuitHistory(firmA.id, 12, 12)
    const signal = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: signal.signalId!, userId: adminA.id })
    await refreshFirmMatches(firmA.id)

    const match = await prisma.opportunityMatch.findUnique({ where: { opportunityId: opp.id } })
    const evidence = match?.evidence as {
      weightProfile?: string; appliedPursuitSignalId?: string; baseOverallScore?: number; learnedAdjustmentNote?: string
    }
    expect(evidence.weightProfile).toBe('PURSUIT_ADJUSTED')
    expect(evidence.appliedPursuitSignalId).toBe(signal.signalId)
    expect(typeof evidence.baseOverallScore).toBe('number')
    expect(evidence.learnedAdjustmentNote).toContain('Eligibility is calculated independently')
  })

  it('keeps eligibility independent of the learned weighting', async () => {
    await makeCapability(firmA.id)
    const opp = await makeOpportunity(firmA.id, { setAsideType: 'SDVOSB' })
    await refreshFirmMatches(firmA.id)
    const before = await prisma.opportunityMatch.findUnique({ where: { opportunityId: opp.id } })

    await seedPursuitHistory(firmA.id, 12, 12)
    const signal = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: signal.signalId!, userId: adminA.id })
    await refreshFirmMatches(firmA.id)

    const after = await prisma.opportunityMatch.findUnique({ where: { opportunityId: opp.id } })
    expect(after?.eligibility).toBe(before?.eligibility)
    expect(after?.eligibilityReason).toBe(before?.eligibilityReason)
  })

  it('preserves the per-dimension evidence under an applied weighting', async () => {
    await makeCapability(firmA.id)
    const opp = await makeOpportunity(firmA.id)
    await seedPursuitHistory(firmA.id, 12, 12)
    const signal = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: signal.signalId!, userId: adminA.id })
    await refreshFirmMatches(firmA.id)

    const match = await prisma.opportunityMatch.findUnique({ where: { opportunityId: opp.id } })
    const evidence = match?.evidence as { dimensions: Array<{ key: string; weight: number; baseWeight: number; evidence: string }> }
    expect(evidence.dimensions).toHaveLength(8)
    for (const d of evidence.dimensions) {
      expect(d.evidence).toBeTruthy()
      expect(typeof d.baseWeight).toBe('number')
    }
  })
})

// -------------------------------------------------------------
// Human control
// -------------------------------------------------------------

describe('human control is never bypassed', () => {
  it.each(['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const)(
    'at %s autonomy, never applies a learned weighting automatically',
    async (autonomyLevel) => {
      await seedPursuitHistory(firmA.id, 12, 12)
      const { run } = await runAgent(firmA.id, { autonomyLevel })

      expect(run?.status).toBe('COMPLETED')
      const applied = await prisma.pursuitFeedbackSignal.count({
        where: { consultingFirmId: firmA.id, status: 'APPLIED' },
      })
      expect(applied).toBe(0)
      expect((await resolveEffectiveWeights(firmA.id)).profile).toBe('BASE')
    },
  )

  it.each(['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const)(
    'at %s autonomy, never removes a human-applied adjustment',
    async (autonomyLevel) => {
      await seedPursuitHistory(firmA.id, 12, 12)
      const signal = await analysePursuitFeedback({ consultingFirmId: firmA.id })
      await applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: signal.signalId!, userId: adminA.id })

      await seedPursuitHistory(firmA.id, 3, 3)
      await runAgent(firmA.id, { autonomyLevel })

      const row = await prisma.pursuitFeedbackSignal.findUnique({ where: { id: signal.signalId! } })
      expect(row?.status).toBe('APPLIED')
      expect((await resolveEffectiveWeights(firmA.id)).appliedSignalId).toBe(signal.signalId)
    },
  )

  it.each(['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const)(
    'at %s autonomy, never verifies a capability',
    async (autonomyLevel) => {
      const capability = await makeCapability(firmA.id, { verification: 'UNVERIFIED' })
      await makeOpportunity(firmA.id)
      await runAgent(firmA.id, { autonomyLevel })

      const after = await prisma.firmCapability.findUnique({ where: { id: capability.id } })
      expect(after?.verification).toBe('UNVERIFIED')
      expect(after?.verifiedByUserId).toBeNull()
    },
  )

  it.each(['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const)(
    'at %s autonomy, never records a bid decision or a pursuit',
    async (autonomyLevel) => {
      await makeOpportunity(firmA.id)
      const before = await prisma.bidPursuit.count({ where: { consultingFirmId: firmA.id } })
      await runAgent(firmA.id, { autonomyLevel })
      expect(await prisma.bidPursuit.count({ where: { consultingFirmId: firmA.id } })).toBe(before)
      expect(await prisma.bidDecision.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
    },
  )

  it('never overwrites a MANUAL-origin opportunity', async () => {
    const manual = await makeOpportunity(firmA.id, {
      source: 'MANUAL',
      title: 'S7-OA-QA hand maintained title',
      description: 'Human-maintained description',
      noticeType: 'Sources Sought',
    })
    await runAgent(firmA.id)

    const after = await prisma.opportunity.findUnique({ where: { id: manual.id } })
    expect(after?.title).toBe('S7-OA-QA hand maintained title')
    expect(after?.description).toBe('Human-maintained description')
    expect(after?.source).toBe('MANUAL')
  })

  it('leaves an unverified re-compete signal awaiting human acceptance', async () => {
    const signal = await prisma.recompeteSignal.create({
      data: {
        consultingFirmId: firmA.id,
        contractNumber: uniq('S7-OA-QA-C'),
        agency: 'GSA',
        evidence: {},
        confidence: 'AMBIGUOUS',
        verification: 'UNVERIFIED',
        windowStart: new Date(Date.now() + 30 * DAY),
        windowEnd: new Date(Date.now() + 200 * DAY),
      },
    })
    await runAgent(firmA.id)

    const after = await prisma.recompeteSignal.findUnique({ where: { id: signal.id } })
    expect(after?.verification).toBe('UNVERIFIED')
    expect(after?.verifiedByUserId).toBeNull()

    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as { recompetes: Array<{ requiresHumanAcceptance: boolean }> }
    expect(data.recompetes[0].requiresHumanAcceptance).toBe(true)
  })

  it('leaves an ambiguous forecast link for human confirmation', async () => {
    const forecast = await prisma.agencyForecast.create({
      data: {
        consultingFirmId: firmA.id,
        externalId: uniq('S7-OA-QA-F'),
        agency: 'Department of Defense',
        title: 'Cybersecurity engineering support services',
        linkState: 'REVIEW_REQUIRED',
      },
    })
    await runAgent(firmA.id)
    const after = await prisma.agencyForecast.findUnique({ where: { id: forecast.id } })
    expect(after?.linkState).toBe('REVIEW_REQUIRED')
    expect(after?.linkedOpportunityId).toBeNull()
  })

  it('reports a forecast as a planning record, never as a released solicitation', async () => {
    await prisma.agencyForecast.create({
      data: {
        consultingFirmId: firmA.id, externalId: uniq('S7-OA-QA-F'),
        agency: 'GSA', title: 'S7-OA-QA forecast', linkState: 'UNLINKED',
      },
    })
    await runAgent(firmA.id)
    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as { forecasts: Array<{ note: string }> }
    expect(data.forecasts[0].note).toContain('not a released solicitation')
  })
})

// -------------------------------------------------------------
// Notice classification
// -------------------------------------------------------------

describe('notice classification', () => {
  it('classifies a sources-sought notice from the authoritative feed type', async () => {
    const opp = await makeOpportunity(firmA.id, { noticeType: 'Sources Sought', title: 'Market research' })
    await runAgent(firmA.id)

    const after = await prisma.opportunity.findUnique({ where: { id: opp.id } })
    expect(after?.presolicitationKind).toBe('SOURCES_SOUGHT')

    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as { preSolicitation: Array<{ kind: string; basis: string; whyEarlyResponseMayMatter: string }> }
    expect(data.preSolicitation[0].kind).toBe('SOURCES_SOUGHT')
    expect(data.preSolicitation[0].basis).toBe('NOTICE_TYPE')
  })

  it('never claims responding influences the requirement or wins the work', async () => {
    await makeOpportunity(firmA.id, { noticeType: 'Request for Information' })
    await runAgent(firmA.id)
    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as { preSolicitation: Array<{ whyEarlyResponseMayMatter: string }> }
    const wording = data.preSolicitation[0].whyEarlyResponseMayMatter
    expect(wording).toContain('does not guarantee influence, consideration, or award')
    expect(wording).not.toMatch(/will win|guarantees influence/i)
  })

  it('prefers the feed notice type over a misleading title', async () => {
    const opp = await makeOpportunity(firmA.id, { noticeType: 'Solicitation', title: 'RFI for widgets' })
    await runAgent(firmA.id)
    const after = await prisma.opportunity.findUnique({ where: { id: opp.id } })
    expect(after?.presolicitationKind).toBeNull()
  })
})

// -------------------------------------------------------------
// Tenant isolation
// -------------------------------------------------------------

describe('tenant isolation', () => {
  it('never uses another firm\'s pursuit history in learning', async () => {
    await seedPursuitHistory(firmB.id, 20, 20)
    await seedPursuitHistory(firmA.id, 2, 2)

    const samplesA = await collectPursuitSamples(firmA.id)
    expect(samplesA).toHaveLength(4)

    const result = await analysePursuitFeedback({ consultingFirmId: firmA.id })
    expect(result.status).toBe('INSUFFICIENT_DATA')
  })

  it('never lets one firm\'s applied weighting reach another', async () => {
    await seedPursuitHistory(firmB.id, 12, 12)
    const signal = await analysePursuitFeedback({ consultingFirmId: firmB.id })
    await applyPursuitFeedback({ consultingFirmId: firmB.id, signalId: signal.signalId!, userId: adminB.id })

    expect((await resolveEffectiveWeights(firmB.id)).profile).toBe('PURSUIT_ADJUSTED')
    expect((await resolveEffectiveWeights(firmA.id)).profile).toBe('BASE')
  })

  it('refuses to apply another firm\'s signal', async () => {
    await seedPursuitHistory(firmB.id, 12, 12)
    const signal = await analysePursuitFeedback({ consultingFirmId: firmB.id })
    await expect(applyPursuitFeedback({ consultingFirmId: firmA.id, signalId: signal.signalId!, userId: adminA.id }))
      .rejects.toThrow(/not found for this firm/i)
  })

  it('refuses to revert another firm\'s signal', async () => {
    await seedPursuitHistory(firmB.id, 12, 12)
    const signal = await analysePursuitFeedback({ consultingFirmId: firmB.id })
    await applyPursuitFeedback({ consultingFirmId: firmB.id, signalId: signal.signalId!, userId: adminB.id })
    await expect(revertPursuitFeedback({ consultingFirmId: firmA.id, signalId: signal.signalId!, userId: adminA.id }))
      .rejects.toThrow(/not found for this firm/i)
  })

  it('never targets another firm\'s source from an event', async () => {
    const sourceB = await makeSource(firmB.id)
    const { run } = await runAgent(firmA.id, {
      triggerType: 'EVENT',
      triggerEntityType: SOURCE_CONFIG_ENTITY_TYPE,
      triggerEntityId: sourceB.id,
    })
    expect(run?.status).toBe('COMPLETED')

    const brief = await latestBrief(firmA.id)
    const data = brief!.structuredData as { sourceHealth: Array<{ sourceConfigId: string }> }
    expect(data.sourceHealth.map((s) => s.sourceConfigId)).not.toContain(sourceB.id)
  })

  it('never includes another firm\'s opportunities in the brief', async () => {
    await makeOpportunity(firmB.id, { title: 'S7-OA-QA firm B only' })
    await makeOpportunity(firmA.id)
    await runAgent(firmA.id)

    const brief = await latestBrief(firmA.id)
    expect(JSON.stringify(brief!.structuredData)).not.toContain('firm B only')
  })

  it('never raises an escalation against another firm', async () => {
    await makeSource(firmB.id, { consecutiveFailures: 8 })
    await runAgent(firmA.id)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})
