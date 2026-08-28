// =============================================================
// §7.9 — Intelligence Agent against a real PostgreSQL database.
//
// The centre of this file is that intelligence is ADVISORY. At PROPOSE and at
// ACT_WITH_GUARDRAILS the agent writes exactly three things: its own segments,
// its own recommendations and its own artifact. It changes no decision, no
// pursuit, no weight, no price, no capability and no calibration.
//
// It also proves the honesty rules on live rows: a new tenant is told it has
// insufficient data rather than shown a 0% win rate, and one firm's private
// history has zero effect on another's analysis.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

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
import {
  intelligenceAgentHandler, INTELLIGENCE_PHASES, phasesForRun, CONCENTRATION_HHI_THRESHOLD,
} from './intelligenceAgentHandler'
import { MIN_WIN_LOSS_SAMPLE_SIZE } from './winLossAnalysis'
import { SUBMISSION_OUTCOME_RECORDED, CALIBRATION_UPDATED, CONTRACT_AWARDED } from './intelligenceEvents'

const AGENT = 'INTELLIGENCE' as const
const DAY = 86_400_000
const dec = (v: string | number) => new Prisma.Decimal(v)

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Intelligence Agent Firm A' })
  firmB = await createTestFirm({ name: 'Intelligence Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
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
    await prisma.agentArtifact.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.captureRecommendation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.winLossSegment.deleteMany({ where: { consultingFirmId: id } })
    await prisma.capabilityGapAssessment.deleteMany({ where: { consultingFirmId: id } })
    await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: id } })
    await prisma.submissionRecord.deleteMany({ where: { consultingFirmId: id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
    await prisma.clientCompany.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

const clientCache = new Map<string, string>()
async function clientFor(firmId: string): Promise<string> {
  const existing = await prisma.clientCompany.findFirst({ where: { consultingFirmId: firmId }, select: { id: true } })
  if (existing) return existing.id
  const created = await prisma.clientCompany.create({
    data: { consultingFirmId: firmId, name: `S7-INTEL-QA client ${firmId.slice(0, 6)}` },
  })
  clientCache.set(firmId, created.id)
  return created.id
}

async function makeOutcome(firmId: string, over: {
  outcome?: 'WON' | 'LOST' | 'NO_AWARD' | 'WITHDRAWN' | null
  agency?: string
  naicsCode?: string
  estimatedValue?: number
  opportunityId?: string
  recordedAt?: Date
} = {}) {
  const clientCompanyId = await clientFor(firmId)
  const opportunityId = over.opportunityId ?? (await prisma.opportunity.create({
    data: {
      consultingFirmId: firmId, samNoticeId: uniq('S7-INTEL-QA'),
      title: 'S7-INTEL-QA cyber support', agency: over.agency ?? 'Department of Defense',
      naicsCode: over.naicsCode ?? '541512', setAsideType: 'SDVOSB',
      estimatedValue: over.estimatedValue != null ? dec(over.estimatedValue) : dec(500_000),
      responseDeadline: new Date(Date.now() - 120 * DAY), status: 'ACTIVE', isDemo: false,
    },
  })).id

  return prisma.submissionRecord.create({
    data: {
      consultingFirmId: firmId, clientCompanyId, opportunityId,
      submittedAt: new Date(Date.now() - 100 * DAY),
      outcome: over.outcome === undefined ? 'WON' : over.outcome,
      outcomeRecordedAt: over.outcome === null ? null : (over.recordedAt ?? new Date(Date.now() - 30 * DAY)),
    },
  })
}

async function seedOutcomes(firmId: string, wins: number, losses: number, over: Record<string, unknown> = {}) {
  for (let i = 0; i < wins; i += 1) await makeOutcome(firmId, { outcome: 'WON', ...over })
  for (let i = 0; i < losses; i += 1) await makeOutcome(firmId, { outcome: 'LOST', ...over })
}

async function runAgent(firmId: string, over: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId, agentKey: AGENT, triggerType: 'MANUAL',
    idempotencyKey: uniq('intel-run'), ...over,
  })
  await dispatchAgentRun(run.id)
  return prisma.agentRun.findUnique({ where: { id: run.id } })
}

const readIntel = async (firmId: string) => {
  const artifact = await prisma.agentArtifact.findFirst({
    where: { consultingFirmId: firmId, agentKey: AGENT, artifactType: 'PORTFOLIO_INTELLIGENCE', supersededByArtifactId: null },
    orderBy: { createdAt: 'desc' },
  })
  return artifact ? (artifact.structuredData as Record<string, any>) : null
}

// =============================================================
// Registry — Section 7 is complete
// =============================================================

describe('agent registry', () => {
  it('reports INTELLIGENCE as implemented with a real handler', () => {
    const def = getAgentDefinition('INTELLIGENCE')!
    expect(def.implemented).toBe(true)
    expect(def.handler).toBe(intelligenceAgentHandler)
    expect(def.defaultEnabled).toBe(false)
    expect(def.defaultAutonomyLevel).toBe('PROPOSE')
  })

  it('declares no LLM need and a zero token budget', () => {
    const def = getAgentDefinition('INTELLIGENCE')!
    expect(def.requiresLlm).toBe(false)
    expect(def.defaultTokenBudget).toBe(0)
    expect(def.allowlistedActionKeys).toEqual([])
  })

  it('runs weekly', () => {
    expect(getAgentDefinition('INTELLIGENCE')!.defaultCronExpression).toBe('0 5 * * 1')
  })

  it('ALL NINE domain agents are now implemented', () => {
    const unimplemented = DOMAIN_AGENT_KEYS.filter((k) => !getAgentDefinition(k)!.implemented)
    expect(unimplemented).toEqual([])
    expect(DOMAIN_AGENT_KEYS).toHaveLength(9)
  })

  it('every domain agent has a real handler', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(getAgentDefinition(key)!.handler, key).not.toBeNull()
    }
  })

  it('exposes exactly ten implemented entries — nine domain agents plus the diagnostic', () => {
    expect(AGENT_REGISTRY.filter((d) => d.implemented).map((d) => d.key).sort()).toEqual([
      'COMPLIANCE', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE', 'INTERNAL_DIAGNOSTIC',
      'OPPORTUNITY', 'PRICING', 'PROPOSAL', 'QUALIFICATION', 'TEAMING',
    ])
  })

  it('subscribes to the three intelligence triggers', () => {
    const def = getAgentDefinition('INTELLIGENCE')!
    expect([...def.subscribedEventTypes].sort()).toEqual([CALIBRATION_UPDATED, CONTRACT_AWARDED, SUBMISSION_OUTCOME_RECORDED].sort())
  })

  it('shares CONTRACT_AWARDED with the Contract Administration agent rather than duplicating it', () => {
    const keys = agentsSubscribedTo(CONTRACT_AWARDED).map((d) => d.key)
    expect(keys).toContain('INTELLIGENCE')
    expect(keys).toContain('CONTRACT_ADMINISTRATION')
  })
})

// =============================================================
// Phases
// =============================================================

describe('phase selection', () => {
  it('runs every phase for a scheduled or manual run', () => {
    expect(phasesForRun(null)).toEqual([...INTELLIGENCE_PHASES])
  })

  it('skips the benchmark and roadmap for a calibration change', () => {
    const p = phasesForRun(CALIBRATION_UPDATED)
    expect(p).toContain('COMPUTE_TRENDS')
    expect(p).not.toContain('BUILD_PUBLIC_COMPARABLE_BENCHMARK')
    expect(p).not.toContain('BUILD_CAPABILITY_ROADMAP')
  })

  it('always ends with the artifact, notification, escalation and completion phases', () => {
    for (const evt of [null, CALIBRATION_UPDATED, CONTRACT_AWARDED]) {
      expect(phasesForRun(evt).slice(-4)).toEqual([
        'BUILD_PORTFOLIO_INTELLIGENCE', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE',
      ])
    }
  })
})

// =============================================================
// New-tenant honesty
// =============================================================

describe('new tenant honesty', () => {
  it('completes with no outcomes at all rather than failing', async () => {
    const run = await runAgent(firmA.id)
    expect(run!.status).toBe('COMPLETED')
  })

  it('reports INSUFFICIENT_DATA and no win rate for a fresh tenant', async () => {
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.dataSufficiency).toBe('INSUFFICIENT_DATA')
    expect(intel!.outcomeSummary.winRate).toBeNull()
    expect(intel!.outcomeSummary.rateBasis).toBe('INSUFFICIENT_DATA')
  })

  it('never shows 0% as a stand-in for no data', async () => {
    await seedOutcomes(firmA.id, 0, 2)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.confirmedLosses).toBe(2)
    expect(intel!.outcomeSummary.winRate).toBeNull()
    expect(intel!.outcomeSummary.winRate).not.toBe(0)
  })

  it('states the current sample, the minimum and how many more are needed', async () => {
    await seedOutcomes(firmA.id, 2, 1)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.confirmedSampleSize).toBe(3)
    expect(intel!.outcomeSummary.minimumSampleSize).toBe(MIN_WIN_LOSS_SAMPLE_SIZE)
    expect(intel!.outcomeSummary.additionalOutcomesNeeded).toBe(5)
  })

  it('puts the insufficient-data explanation first, not buried in logs', async () => {
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.dataLimitations[0]).toContain('cannot yet be reported')
    expect(intel!.dataLimitations[0]).toContain('more confirmed outcome(s) needed')
  })

  it('always includes a dataLimitations block', async () => {
    await seedOutcomes(firmA.id, 6, 4)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(Array.isArray(intel!.dataLimitations)).toBe(true)
  })

  it('never substitutes public award data for the firm’s own win rate', async () => {
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.winRate).toBeNull()
    expect(intel!.comparablePublicBenchmark.rateBasis).not.toBe('CONFIRMED_WIN_RATE')
  })
})

// =============================================================
// Confirmed outcomes
// =============================================================

describe('confirmed win rate', () => {
  it('reports a rate once the minimum is reached', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.confirmedSampleSize).toBe(8)
    expect(intel!.outcomeSummary.winRate).toBeCloseTo(0.75, 5)
    expect(intel!.outcomeSummary.rateBasis).toBe('CONFIRMED_WIN_RATE')
    expect(intel!.outcomeSummary.intervalLower).not.toBeNull()
    expect(intel!.outcomeSummary.intervalUpper).not.toBeNull()
  })

  it('excludes pending submissions from the denominator on live rows', async () => {
    await seedOutcomes(firmA.id, 5, 5)
    for (let i = 0; i < 10; i += 1) await makeOutcome(firmA.id, { outcome: null })
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.confirmedSampleSize).toBe(10)
    expect(intel!.outcomeSummary.pending).toBe(10)
    expect(intel!.outcomeSummary.winRate).toBeCloseTo(0.5, 5)
  })

  it('excludes NO_AWARD and WITHDRAWN from wins and losses', async () => {
    await seedOutcomes(firmA.id, 4, 4)
    await makeOutcome(firmA.id, { outcome: 'NO_AWARD' })
    await makeOutcome(firmA.id, { outcome: 'WITHDRAWN' })
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.confirmedSampleSize).toBe(8)
    expect(intel!.outcomeSummary.nonContestExcluded).toBe(2)
  })

  it('never treats a bid decision as an outcome', async () => {
    // A pursuit with a BID decision but no recorded outcome stays pending.
    const record = await makeOutcome(firmA.id, { outcome: null })
    await prisma.bidPursuit.create({
      data: { consultingFirmId: firmA.id, opportunityId: record.opportunityId, status: 'SUBMITTED', pipelineStage: 'PROPOSAL' },
    })
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.confirmedWins).toBe(0)
    expect(intel!.outcomeSummary.confirmedLosses).toBe(0)
    expect(intel!.outcomeSummary.pending).toBe(1)
  })

  it('counts one procurement once when several records reference it', async () => {
    const first = await makeOutcome(firmA.id, { outcome: 'WON' })
    const clientCompanyId = await clientFor(firmA.id)
    await prisma.submissionRecord.create({
      data: {
        consultingFirmId: firmA.id, clientCompanyId, opportunityId: first.opportunityId,
        submittedAt: new Date(Date.now() - 100 * DAY), outcome: 'WON', outcomeRecordedAt: new Date(Date.now() - 30 * DAY),
      },
    })
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.confirmedWins).toBe(1)
    expect(intel!.outcomeSummary.duplicatesCollapsed).toBe(1)
  })

  it('follows a corrected outcome from a win to a loss', async () => {
    const record = await makeOutcome(firmA.id, { outcome: 'WON' })
    await runAgent(firmA.id)
    expect((await readIntel(firmA.id))!.outcomeSummary.confirmedWins).toBe(1)

    await prisma.submissionRecord.update({
      where: { id: record.id }, data: { outcome: 'LOST', outcomeRecordedAt: new Date() },
    })
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeSummary.confirmedWins).toBe(0)
    expect(intel!.outcomeSummary.confirmedLosses).toBe(1)
  })

  it('persists segments with their source outcome ids', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const overall = await prisma.winLossSegment.findFirstOrThrow({
      where: { consultingFirmId: firmA.id, segmentType: 'OVERALL', supersededAt: null },
    })
    expect(overall.sampleSize).toBe(8)
    expect(overall.sourceOutcomeIds).toHaveLength(8)
    expect(overall.winRate!.toNumber()).toBeCloseTo(0.75, 4)
    expect(overall.agentRunId).not.toBeNull()
  })

  it('stores null rather than a fabricated zero below the minimum', async () => {
    await seedOutcomes(firmA.id, 1, 1)
    await runAgent(firmA.id)
    const overall = await prisma.winLossSegment.findFirstOrThrow({
      where: { consultingFirmId: firmA.id, segmentType: 'OVERALL', supersededAt: null },
    })
    expect(overall.winRate).toBeNull()
    expect(overall.intervalLower).toBeNull()
    expect(overall.dataSufficiency).toBe('PARTIAL')
  })
})

// =============================================================
// Advisory only
// =============================================================

describe('advisory only', () => {
  for (const autonomyLevel of ['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const) {
    describe(`at ${autonomyLevel}`, () => {
      it('changes no pursuit stage or priority', async () => {
        const record = await makeOutcome(firmA.id, { outcome: 'WON' })
        const pursuit = await prisma.bidPursuit.create({
          data: { consultingFirmId: firmA.id, opportunityId: record.opportunityId, status: 'SUBMITTED', pipelineStage: 'PROPOSAL', priority: 'LOW' },
        })
        await seedOutcomes(firmA.id, 6, 2)
        await runAgent(firmA.id, { autonomyLevel })

        const after = await prisma.bidPursuit.findUniqueOrThrow({ where: { id: pursuit.id } })
        expect(after.pipelineStage).toBe('PROPOSAL')
        expect(after.priority).toBe('LOW')
        expect(after.status).toBe('SUBMITTED')
      })

      it('changes no recorded outcome', async () => {
        const record = await makeOutcome(firmA.id, { outcome: 'LOST' })
        await runAgent(firmA.id, { autonomyLevel })
        const after = await prisma.submissionRecord.findUniqueOrThrow({ where: { id: record.id } })
        expect(after.outcome).toBe('LOST')
        expect(after.outcomeRecordedAt).toEqual(record.outcomeRecordedAt)
      })

      it('changes no capability assessment', async () => {
        const record = await makeOutcome(firmA.id, { outcome: 'WON' })
        const gap = await prisma.capabilityGapAssessment.create({
          data: {
            consultingFirmId: firmA.id, opportunityId: record.opportunityId,
            missingCapabilities: ['Cloud migration'],
          },
        })
        await runAgent(firmA.id, { autonomyLevel })
        const after = await prisma.capabilityGapAssessment.findUniqueOrThrow({ where: { id: gap.id } })
        expect(after.missingCapabilities).toEqual(['Cloud migration'])
      })

      it('reports explicit zero counters for every forbidden act', async () => {
        await seedOutcomes(firmA.id, 6, 2)
        const run = await runAgent(firmA.id, { autonomyLevel })
        expect(run!.status).toBe('COMPLETED')
        const intel = await readIntel(firmA.id)
        expect(intel!.advisoryOnly).toEqual({
          bidDecisionsChanged: 0, pursuitsReprioritised: 0, matchWeightsChanged: 0,
          qualificationThresholdsChanged: 0, pricingScenariosChanged: 0,
          capabilitiesChanged: 0, calibrationsChanged: 0, externalSubmissions: 0,
        })
      })

      it('writes only its own three record types', async () => {
        await seedOutcomes(firmA.id, 6, 2)
        const before = {
          pursuits: await prisma.bidPursuit.count({ where: { consultingFirmId: firmA.id } }),
          submissions: await prisma.submissionRecord.count({ where: { consultingFirmId: firmA.id } }),
          opportunities: await prisma.opportunity.count({ where: { consultingFirmId: firmA.id } }),
        }
        await runAgent(firmA.id, { autonomyLevel })
        expect(await prisma.bidPursuit.count({ where: { consultingFirmId: firmA.id } })).toBe(before.pursuits)
        expect(await prisma.submissionRecord.count({ where: { consultingFirmId: firmA.id } })).toBe(before.submissions)
        expect(await prisma.opportunity.count({ where: { consultingFirmId: firmA.id } })).toBe(before.opportunities)
      })
    })
  }
})

// =============================================================
// Recommendations and dismissal
// =============================================================

describe('capture recommendations', () => {
  it('creates recommendations with evidence and never an empty one', async () => {
    await seedOutcomes(firmA.id, 6, 2, { agency: 'Department of Defense' })
    await runAgent(firmA.id)
    const recs = await prisma.captureRecommendation.findMany({ where: { consultingFirmId: firmA.id } })
    expect(recs.length).toBeGreaterThan(0)
    for (const r of recs) {
      expect(Object.keys(r.evidence as object).length).toBeGreaterThan(0)
      expect(r.rationale.length).toBeGreaterThan(0)
      expect(r.status).toBe('ACTIVE')
    }
  })

  it('does not re-raise a dismissed recommendation on an unchanged re-run', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const first = await prisma.captureRecommendation.findFirstOrThrow({ where: { consultingFirmId: firmA.id, status: 'ACTIVE' } })

    await prisma.captureRecommendation.update({
      where: { id: first.id },
      data: { status: 'DISMISSED', dismissedByUserId: adminA.id, dismissedAt: new Date(), dismissReason: 'Not a focus this year.' },
    })

    await runAgent(firmA.id)
    const active = await prisma.captureRecommendation.findMany({ where: { consultingFirmId: firmA.id, status: 'ACTIVE' } })
    expect(active.some((r) => r.inputHash === first.inputHash)).toBe(false)
  })

  it('leaves a dismissal in place and never rewrites the measurement behind it', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const rec = await prisma.captureRecommendation.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    await prisma.captureRecommendation.update({
      where: { id: rec.id }, data: { status: 'DISMISSED', dismissedByUserId: adminA.id, dismissedAt: new Date(), dismissReason: 'x' },
    })
    const segmentBefore = await prisma.winLossSegment.findFirstOrThrow({
      where: { consultingFirmId: firmA.id, segmentType: 'OVERALL', supersededAt: null },
    })
    await runAgent(firmA.id)
    const segmentAfter = await prisma.winLossSegment.findFirstOrThrow({
      where: { consultingFirmId: firmA.id, segmentType: 'OVERALL', supersededAt: null },
    })
    expect(segmentAfter.wins).toBe(segmentBefore.wins)
    expect(segmentAfter.losses).toBe(segmentBefore.losses)
    expect((await prisma.captureRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe('DISMISSED')
  })

  it('surfaces a new version once the evidence materially changes', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const first = await prisma.captureRecommendation.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    await prisma.captureRecommendation.update({
      where: { id: first.id }, data: { status: 'DISMISSED', dismissedByUserId: adminA.id, dismissedAt: new Date(), dismissReason: 'x' },
    })

    // Four more losses change the measured rate, so the fingerprint changes.
    await seedOutcomes(firmA.id, 0, 4)
    await runAgent(firmA.id)
    const active = await prisma.captureRecommendation.findMany({ where: { consultingFirmId: firmA.id, status: 'ACTIVE' } })
    expect(active.length).toBeGreaterThan(0)
    expect(active.every((r) => r.inputHash !== first.inputHash)).toBe(true)
  })
})

// =============================================================
// Idempotency and history
// =============================================================

describe('idempotency', () => {
  it('produces a stable hash on an unchanged re-run', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const first = (await readIntel(firmA.id))!.inputHash
    await runAgent(firmA.id)
    expect((await readIntel(firmA.id))!.inputHash).toBe(first)
  })

  it('leaves exactly one live artifact', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'PORTFOLIO_INTELLIGENCE', supersededByArtifactId: null },
    })).toBe(1)
  })

  it('writes no duplicate segment generation when nothing changed', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const first = await prisma.winLossSegment.count({ where: { consultingFirmId: firmA.id } })
    await runAgent(firmA.id)
    expect(await prisma.winLossSegment.count({ where: { consultingFirmId: firmA.id } })).toBe(first)
  })

  it('preserves prior segments as superseded rather than deleting them', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    await seedOutcomes(firmA.id, 0, 3)
    await runAgent(firmA.id)

    const superseded = await prisma.winLossSegment.count({ where: { consultingFirmId: firmA.id, supersededAt: { not: null } } })
    const live = await prisma.winLossSegment.count({ where: { consultingFirmId: firmA.id, supersededAt: null } })
    expect(superseded).toBeGreaterThan(0)
    expect(live).toBeGreaterThan(0)
  })
})

// =============================================================
// Data quality and escalation
// =============================================================

describe('data quality and escalations', () => {
  it('reports a long-overdue submission as incomplete data, never as a loss', async () => {
    await makeOutcome(firmA.id, { outcome: null })
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.outcomeDataQuality.state).toBe('OUTCOME_DATA_INCOMPLETE')
    expect(intel!.outcomeDataQuality.detail).toContain('does not guess a loss')
    expect(intel!.outcomeSummary.confirmedLosses).toBe(0)
  })

  it('never escalates insufficient data as though it were a defect', async () => {
    await runAgent(firmA.id)
    const escalations = await prisma.agentEscalation.findMany({ where: { consultingFirmId: firmA.id } })
    expect(escalations.every((e) => !/insufficient/i.test(e.title))).toBe(true)
  })

  it('states the concentration threshold as monitoring policy, not a requirement', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.concentration.threshold).toBe(CONCENTRATION_HHI_THRESHOLD)
    expect(intel!.concentration.basis).toContain('portfolioValue hierarchy')
  })
})

// =============================================================
// Public benchmark
// =============================================================

describe('public benchmark', () => {
  it('always names its source as public federal award records', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.comparablePublicBenchmark.sourceDescription).toContain('Public federal award records')
    expect(intel!.comparablePublicBenchmark.sourceDescription).toContain('No other customer')
  })

  it('never calls an award share a win rate', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.comparablePublicBenchmark.rateBasis).not.toBe('CONFIRMED_WIN_RATE')
    expect(intel!.comparablePublicBenchmark.limitations.join(' ')).toContain('not a competitor win rate')
  })

  it('reports INSUFFICIENT_DATA below the minimum public cohort', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(intel!.comparablePublicBenchmark.cohortSize).toBeLessThan(intel!.comparablePublicBenchmark.minimumCohortSize)
    expect(intel!.comparablePublicBenchmark.statistics).toEqual({})
  })
})

// =============================================================
// No LLM
// =============================================================

describe('no LLM', () => {
  it('makes zero provider calls and spends zero tokens and cost', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    const record = await makeOutcome(firmA.id, { outcome: 'WON' })
    await prisma.capabilityGapAssessment.create({
      data: { consultingFirmId: firmA.id, opportunityId: record.opportunityId, missingCapabilities: ['Cloud'] },
    })
    const run = await runAgent(firmA.id)
    expect(run!.status).toBe('COMPLETED')
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(run!.tokenInput).toBe(0)
    expect(run!.tokenOutput).toBe(0)
    expect(Number(run!.estimatedCostUsd)).toBe(0)
  })

  it('logs no API usage for the run', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    const run = await runAgent(firmA.id)
    expect(await prisma.apiUsageLog.count({
      where: { consultingFirmId: firmA.id, createdAt: { gte: run!.createdAt } },
    })).toBe(0)
  })
})

// =============================================================
// Tenant isolation — private performance
// =============================================================

describe('tenant isolation', () => {
  it('keeps Firm A’s analysis identical while Firm B’s private history changes radically', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await seedOutcomes(firmB.id, 1, 1)
    await runAgent(firmA.id)
    const before = await readIntel(firmA.id)
    const segmentsBefore = await prisma.winLossSegment.findMany({
      where: { consultingFirmId: firmA.id, supersededAt: null }, orderBy: { segmentKey: 'asc' },
    })

    // Firm B goes to an extreme in both directions.
    await seedOutcomes(firmB.id, 60, 0)
    await runAgent(firmA.id)
    const afterWins = await readIntel(firmA.id)
    expect(afterWins!.inputHash).toBe(before!.inputHash)

    await prisma.submissionRecord.updateMany({ where: { consultingFirmId: firmB.id }, data: { outcome: 'LOST' } })
    await runAgent(firmA.id)
    const afterLosses = await readIntel(firmA.id)

    expect(afterLosses!.outcomeSummary.confirmedWins).toBe(before!.outcomeSummary.confirmedWins)
    expect(afterLosses!.outcomeSummary.confirmedLosses).toBe(before!.outcomeSummary.confirmedLosses)
    expect(afterLosses!.outcomeSummary.winRate).toBe(before!.outcomeSummary.winRate)
    expect(afterLosses!.outcomeSummary.intervalLower).toBe(before!.outcomeSummary.intervalLower)
    expect(afterLosses!.inputHash).toBe(before!.inputHash)

    const segmentsAfter = await prisma.winLossSegment.findMany({
      where: { consultingFirmId: firmA.id, supersededAt: null }, orderBy: { segmentKey: 'asc' },
    })
    expect(segmentsAfter.map((s) => s.inputHash)).toEqual(segmentsBefore.map((s) => s.inputHash))
  })

  it('keeps Firm A’s public benchmark identical when Firm B’s private data is deleted', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await seedOutcomes(firmB.id, 5, 5)
    await runAgent(firmA.id)
    const before = (await readIntel(firmA.id))!.comparablePublicBenchmark

    await prisma.winLossSegment.deleteMany({ where: { consultingFirmId: firmB.id } })
    await prisma.submissionRecord.deleteMany({ where: { consultingFirmId: firmB.id } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: firmB.id } })

    await runAgent(firmA.id)
    const after = (await readIntel(firmA.id))!.comparablePublicBenchmark
    expect(after.benchmarkHash).toBe(before.benchmarkHash)
    expect(after.cohortSize).toBe(before.cohortSize)
    expect(after.sourceIds).toEqual(before.sourceIds)
    expect(after.status).toBe(before.status)
  })

  it('never writes an artifact, segment or recommendation into the other firm', async () => {
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    expect(await prisma.winLossSegment.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.captureRecommendation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentArtifact.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('never counts another firm’s capability gaps in the roadmap', async () => {
    const recordB = await makeOutcome(firmB.id, { outcome: 'WON' })
    await prisma.capabilityGapAssessment.create({
      data: { consultingFirmId: firmB.id, opportunityId: recordB.opportunityId, missingCapabilities: ['Firm B secret capability'] },
    })
    await seedOutcomes(firmA.id, 6, 2)
    await runAgent(firmA.id)
    const intel = await readIntel(firmA.id)
    expect(JSON.stringify(intel!.capabilityRoadmap)).not.toContain('Firm B secret capability')
  })
})
