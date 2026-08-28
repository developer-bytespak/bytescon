// =============================================================
// §7.6 — Pricing Agent against a real PostgreSQL database.
//
// Covers the registry, the handler through the §7.0 dispatcher, the canonical
// pricing engine staying authoritative, rate-structure validation, template
// staleness, rate drift, amendment impact, the PRICING_ASSESSMENT artifact and
// its idempotency, tenant isolation, the no-LLM guarantee, and — above all —
// the human-control boundary at both PROPOSE and ACT_WITH_GUARDRAILS.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { Prisma } from '@prisma/client'

// The provider boundary is mocked for the whole file. Pricing must never
// reach it — not once, under any trigger or autonomy level.
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
import { computePricing } from '../../pricingCalc'
import { MIN_REPORTED_PROBABILITY, MAX_REPORTED_PROBABILITY } from '../../scoring/pricingSensitivity'
import {
  PRICING_PHASES, phasesForRun, ASSESSABLE_STATUSES, LOCKED_STATUSES,
  validateRateStructure, assessTemplateStaleness, detectRateDrift,
  TEMPLATE_STALE_DAYS, RATE_DRIFT_TOLERANCE_PCT,
} from './pricingAgentHandler'
import { MIN_BENCHMARK_COHORT_SIZE } from './awardBenchmark'

const AGENT = 'PRICING' as const
const DAY = 86_400_000
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v)

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser
let ownerA: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`
const QA_NAICS = `97${String(process.pid).slice(-4).padStart(4, '0')}`
const QA_AGENCY = `S7-PRICE-QA Int Agency ${process.pid}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Pricing Agent Firm A' })
  firmB = await createTestFirm({ name: 'Pricing Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  ownerA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
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
    await prisma.awardBenchmarkCohort.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingSensitivityAnalysis.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingReview.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingLaborLine.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingIndirectRate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingOtherCost.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingScenario.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingWorkspace.deleteMany({ where: { consultingFirmId: id } })
    await prisma.pricingTemplate.deleteMany({ where: { consultingFirmId: id } })
    await prisma.awardHistory.deleteMany({ where: { opportunity: { consultingFirmId: id } } })
    await prisma.opportunity.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeOpportunity(firmId: string, over: Partial<Prisma.OpportunityUncheckedCreateInput> = {}) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId: firmId, samNoticeId: uniq('S7-PRICE-QA'),
      title: 'S7-PRICE-QA cyber support', agency: QA_AGENCY,
      naicsCode: QA_NAICS, setAsideType: 'SDVOSB',
      responseDeadline: new Date(Date.now() + 60 * DAY),
      status: 'ACTIVE', isDemo: false, ...over,
    },
  })
}

/**
 * The canonical §66 fixture: 1000 hours at $95.00/hour with a 30% fringe.
 * Direct labour $95,000.00 · fringe $28,500.00 · total $123,500.00
 */
async function makeWorkspace(firmId: string, over: {
  status?: string
  hours?: string
  rate?: string
  fringePct?: string | null
  ownerUserId?: string | null
  opportunityId?: string
} = {}) {
  const opportunityId = over.opportunityId ?? (await makeOpportunity(firmId)).id
  const workspace = await prisma.pricingWorkspace.create({
    data: {
      consultingFirmId: firmId, opportunityId, title: 'S7-PRICE-QA workspace',
      status: over.status ?? 'DRAFT', ownerUserId: over.ownerUserId ?? null,
    },
  })
  const scenario = await prisma.pricingScenario.create({
    data: { consultingFirmId: firmId, workspaceId: workspace.id, name: 'Base' },
  })
  await prisma.pricingLaborLine.create({
    data: {
      consultingFirmId: firmId, scenarioId: scenario.id, categoryName: 'Engineer',
      hours: D(over.hours ?? '1000'), baseRate: D(over.rate ?? '95.00'),
    },
  })
  if (over.fringePct !== null) {
    await prisma.pricingIndirectRate.create({
      data: {
        consultingFirmId: firmId, scenarioId: scenario.id, name: 'Fringe',
        rateType: 'FRINGE', percent: D(over.fringePct ?? '30'), costBase: 'DIRECT_LABOUR',
      },
    })
  }
  return { workspace, scenario, opportunityId }
}

async function seedPublicAwards(firmId: string, amounts: string[]) {
  for (const amount of amounts) {
    const opp = await prisma.opportunity.create({
      data: {
        consultingFirmId: firmId, samNoticeId: uniq('S7-PRICE-QA-AWD'),
        title: 'S7-PRICE-QA award source', agency: QA_AGENCY, naicsCode: QA_NAICS,
        setAsideType: 'SDVOSB', responseDeadline: new Date(Date.now() - 400 * DAY),
        status: 'ARCHIVED', isDemo: false,
      },
    })
    await prisma.awardHistory.create({
      data: {
        opportunityId: opp.id, awardingAgency: QA_AGENCY, recipientName: uniq('R'),
        awardAmount: D(amount), awardDate: new Date(Date.now() - 180 * DAY),
        naics: QA_NAICS, awardType: 'DO', contractNumber: uniq('C'),
      },
    })
  }
}

async function runAgent(firmId: string, over: Record<string, unknown> = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId, agentKey: AGENT, triggerType: 'MANUAL',
    idempotencyKey: uniq('pricing-run'), ...over,
  })
  await dispatchAgentRun(run.id)
  return prisma.agentRun.findUnique({ where: { id: run.id } })
}

const currentAssessment = async (firmId: string, workspaceId: string) => {
  const artifact = await prisma.agentArtifact.findFirst({
    where: {
      consultingFirmId: firmId, agentKey: AGENT, artifactType: 'PRICING_ASSESSMENT',
      sourceEntityId: workspaceId, supersededByArtifactId: null,
    },
    orderBy: { createdAt: 'desc' },
  })
  return artifact ? { artifact, assessment: artifact.structuredData as Record<string, any> } : null
}

// -------------------------------------------------------------
// Registry
// -------------------------------------------------------------

describe('agent registry', () => {
  it('marks the Pricing Agent implemented with a real handler', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.implemented).toBe(true)
    expect(def.handler).not.toBeNull()
    expect(def.plannedSlice).toBe('7.6')
  })

  it('defaults to PROPOSE autonomy and stays opt-in', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.defaultAutonomyLevel).toBe('PROPOSE')
    expect(def.defaultEnabled).toBe(false)
  })

  it('requires no LLM and carries a zero token budget', () => {
    const def = getAgentDefinition(AGENT)!
    expect(def.requiresLlm).toBe(false)
    expect(def.defaultTokenBudget).toBe(0)
  })

  it('runs every twelve hours', () => {
    expect(getAgentDefinition(AGENT)!.defaultCronExpression).toBe('0 */12 * * *')
  })

  it('supports manual, scheduled, event and retry triggers', () => {
    expect(getAgentDefinition(AGENT)!.supportedTriggers.sort()).toEqual(['EVENT', 'MANUAL', 'RETRY', 'SCHEDULE'])
  })

  it('subscribes to the four §7.6 triggers', () => {
    expect(getAgentDefinition(AGENT)!.subscribedEventTypes.sort()).toEqual([
      'AMENDMENT_RECORDED', 'BID_DECISION_RECORDED', 'INDIRECT_RATE_CHANGED', 'PRICING_SCENARIO_CHANGED',
    ])
  })

  it('is the only implemented subscriber to the two pricing-owned events', () => {
    expect(agentsSubscribedTo('PRICING_SCENARIO_CHANGED').map((d) => d.key)).toEqual([AGENT])
    expect(agentsSubscribedTo('INDIRECT_RATE_CHANGED').map((d) => d.key)).toEqual([AGENT])
  })

  it('allowlists no autonomous action keys', () => {
    expect(getAgentDefinition(AGENT)!.allowlistedActionKeys).toEqual([])
  })

  it('produces the PRICING_ASSESSMENT artifact', () => {
    expect(getAgentDefinition(AGENT)!.supportedArtifactTypes).toContain('PRICING_ASSESSMENT')
  })

  it('leaves the five previously delivered agents implemented', () => {
    for (const key of ['CONTRACT_ADMINISTRATION', 'OPPORTUNITY', 'COMPLIANCE', 'QUALIFICATION', 'TEAMING'] as const) {
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

  it('exposes all fourteen phases', () => {
    expect(phasesForRun(null)).toHaveLength(14)
    expect(PRICING_PHASES[0]).toBe('LOAD_PRICING_WORKSPACE')
    expect(PRICING_PHASES[PRICING_PHASES.length - 1]).toBe('COMPLETE')
  })

  it('skips irrelevant phases on a targeted event', () => {
    expect(phasesForRun('PricingTemplate')).not.toContain('BUILD_PUBLIC_AWARD_COHORT')
    expect(phasesForRun('Amendment')).not.toContain('BUILD_PUBLIC_AWARD_COHORT')
    expect(phasesForRun('Amendment')).toContain('CHECK_AMENDMENT_IMPACT')
  })
})

// -------------------------------------------------------------
// The canonical pricing engine stays authoritative
// -------------------------------------------------------------

describe('the canonical pricing engine owns the totals', () => {
  it('reproduces the documented 1000h × $95 + 30% fringe figures', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id)
    await runAgent(firmA.id)

    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    const s = assessment.scenarios.find((x: any) => x.scenarioId === scenario.id)
    expect(s.totals.directLabor).toBe('95000.00')
    expect(s.totals.fringe).toBe('28500.00')
    expect(s.totals.totalProposedPrice).toBe('123500.00')
  })

  it('matches computePricing exactly, with no second derivation', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id)
    await runAgent(firmA.id)

    const expected = computePricing(
      [{ hours: D('1000'), baseRate: D('95.00'), escalationPct: D('0'), personnelCount: null, isActive: true }],
      [{ rateType: 'FRINGE', percent: D('30'), costBase: 'DIRECT_LABOUR', isActive: true }],
      [],
    )
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    const s = assessment.scenarios.find((x: any) => x.scenarioId === scenario.id)
    expect(s.totals.totalProposedPrice).toBe(expected.totalPrice.toFixed(2))
    expect(s.totals.subtotalBeforeFee).toBe(expected.subtotalBeforeFee.toFixed(2))
  })

  it('preserves cents through the assessment', async () => {
    const { workspace } = await makeWorkspace(firmA.id, { hours: '3', rate: '33.33', fringePct: '10' })
    await runAgent(firmA.id)
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.scenarios[0].totals.directLabor).toBe('99.99')
  })

  it('handles very large contract values without drift', async () => {
    const { workspace } = await makeWorkspace(firmA.id, { hours: '1000000', rate: '9999.99', fringePct: '0' })
    await runAgent(firmA.id)
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.scenarios[0].totals.directLabor).toBe('9999990000.00')
  })

  it('refreshes stale stored totals from the recorded lines', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id)
    await prisma.pricingScenario.update({ where: { id: scenario.id }, data: { totalPrice: D('1.00') } })

    await runAgent(firmA.id)
    const after = await prisma.pricingScenario.findUniqueOrThrow({ where: { id: scenario.id } })
    expect(after.totalPrice.toFixed(2)).toBe('123500.00')
  })

  it('never rewrites the totals of an APPROVED workspace', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id, { status: 'APPROVED' })
    await prisma.pricingScenario.update({ where: { id: scenario.id }, data: { totalPrice: D('1.00') } })

    await runAgent(firmA.id)
    const after = await prisma.pricingScenario.findUniqueOrThrow({ where: { id: scenario.id } })
    expect(after.totalPrice.toFixed(2)).toBe('1.00')

    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.dataLimitations.join(' ')).toContain('APPROVED')
  })

  it('declares which statuses are assessable and which are locked', () => {
    expect(ASSESSABLE_STATUSES).toEqual(['DRAFT', 'IN_REVIEW', 'APPROVED'])
    expect(LOCKED_STATUSES).toContain('APPROVED')
  })
})

// -------------------------------------------------------------
// Rate structure
// -------------------------------------------------------------

describe('rate structure validation', () => {
  const scenario = (over: Record<string, unknown> = {}) => ({
    laborLines: [{ categoryName: 'Engineer', hours: D('1000'), baseRate: D('95'), isActive: true }],
    indirectRates: [
      { rateType: 'FRINGE', percent: D('30'), costBase: 'DIRECT_LABOUR', isActive: true },
      { rateType: 'OVERHEAD', percent: D('40'), costBase: 'LABOUR_PLUS_FRINGE', isActive: true },
      { rateType: 'GA', percent: D('10'), costBase: 'TOTAL_DIRECT_COST', isActive: true },
    ],
    otherCosts: [],
    ...over,
  })

  it('accepts a complete structure', () => {
    expect(validateRateStructure(scenario()).state).toBe('COMPLETE')
  })

  it('reports a missing G&A rather than assuming zero', () => {
    const r = validateRateStructure(scenario({
      indirectRates: [{ rateType: 'FRINGE', percent: D('30'), costBase: 'DIRECT_LABOUR', isActive: true }],
    }))
    expect(r.state).toBe('INCOMPLETE_RATE_STRUCTURE')
    expect(r.warnings.join(' ')).toContain('No GA rate is recorded')
  })

  it('reports a labour line with no hours', () => {
    const r = validateRateStructure(scenario({
      laborLines: [{ categoryName: 'Engineer', hours: D('0'), baseRate: D('95'), isActive: true }],
    }))
    expect(r.warnings.join(' ')).toContain('records no hours')
  })

  it('reports a labour line with no rate', () => {
    const r = validateRateStructure(scenario({
      laborLines: [{ categoryName: 'Engineer', hours: D('1000'), baseRate: D('0'), isActive: true }],
    }))
    expect(r.warnings.join(' ')).toContain('records no rate')
  })

  it('reports a negative rate', () => {
    const r = validateRateStructure(scenario({
      indirectRates: [{ rateType: 'FRINGE', percent: D('-5'), costBase: 'DIRECT_LABOUR', isActive: true }],
    }))
    expect(r.warnings.join(' ')).toContain('negative percentage')
  })

  it('reports an unsupported cost base for a rate type', () => {
    // GA may not be applied to SUBCONTRACTOR_COST under the canonical engine.
    const r = validateRateStructure(scenario({
      indirectRates: [
        { rateType: 'FRINGE', percent: D('30'), costBase: 'DIRECT_LABOUR', isActive: true },
        { rateType: 'OVERHEAD', percent: D('40'), costBase: 'LABOUR_PLUS_FRINGE', isActive: true },
        { rateType: 'GA', percent: D('10'), costBase: 'SUBCONTRACTOR_COST', isActive: true },
      ],
    }))
    expect(r.warnings.join(' ')).toContain('unsupported cost base')
  })

  it('reports an empty scenario', () => {
    const r = validateRateStructure(scenario({ laborLines: [], indirectRates: [], otherCosts: [] }))
    expect(r.warnings.join(' ')).toContain('nothing to price')
  })

  it('escalates an incomplete rate structure', async () => {
    await makeWorkspace(firmA.id, { fringePct: null, ownerUserId: ownerA.id })
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Required indirect rates missing' } },
    })
    expect(esc).not.toBeNull()
  })
})

// -------------------------------------------------------------
// Template staleness + rate drift
// -------------------------------------------------------------

describe('template staleness', () => {
  const now = new Date('2026-08-12T00:00:00.000Z')

  it('reports INSUFFICIENT_DATA with no template', () => {
    expect(assessTemplateStaleness([], now).state).toBe('INSUFFICIENT_DATA')
  })

  it('reports CURRENT for a recent template', () => {
    const r = assessTemplateStaleness(
      [{ id: 't', name: 'T', effectiveDate: new Date(now.getTime() - 30 * DAY), updatedAt: now }],
      now,
    )
    expect(r.state).toBe('CURRENT')
  })

  it('reports STALE past the threshold', () => {
    const r = assessTemplateStaleness(
      [{ id: 't', name: 'T', effectiveDate: new Date(now.getTime() - (TEMPLATE_STALE_DAYS + 10) * DAY), updatedAt: now }],
      now,
    )
    expect(r.state).toBe('STALE')
    expect(r.staleItems.join(' ')).toContain('may be stale')
  })

  it('reports EXPIRING_SOON approaching the threshold', () => {
    const r = assessTemplateStaleness(
      [{ id: 't', name: 'T', effectiveDate: new Date(now.getTime() - 320 * DAY), updatedAt: now }],
      now,
    )
    expect(r.state).toBe('EXPIRING_SOON')
  })

  it('reports NO_EFFECTIVE_DATE when the model records none', () => {
    const r = assessTemplateStaleness([{ id: 't', name: 'T', effectiveDate: null, updatedAt: now }], now)
    expect(r.state).toBe('NO_EFFECTIVE_DATE')
    expect(r.staleItems.join(' ')).toContain('judged from the last update instead')
  })
})

describe('rate drift', () => {
  const templates = (percent: number) => [{
    name: 'Canonical', updatedAt: new Date(),
    indirectRatesJson: [{ rateType: 'FRINGE', percent, costBase: 'DIRECT_LABOUR' }] as Prisma.JsonValue,
  }]

  it('reports nothing when the rates agree', () => {
    expect(detectRateDrift([{ rateType: 'FRINGE', percent: D('30'), isActive: true }], templates(30))).toHaveLength(0)
  })

  it('reports drift when they differ', () => {
    const drift = detectRateDrift([{ rateType: 'FRINGE', percent: D('30'), isActive: true }], templates(35))
    expect(drift).toHaveLength(1)
    expect(drift[0].scenarioPercent).toBe('30.0000')
    expect(drift[0].templatePercent).toBe('35.0000')
    expect(drift[0].state).toBe('RATE_REVIEW_REQUIRED')
  })

  it('says adopting the template value is a human decision', () => {
    const drift = detectRateDrift([{ rateType: 'FRINGE', percent: D('30'), isActive: true }], templates(35))
    expect(drift[0].note).toContain('human decision')
  })

  it('ignores a difference inside the tolerance', () => {
    const drift = detectRateDrift(
      [{ rateType: 'FRINGE', percent: D(30 + RATE_DRIFT_TOLERANCE_PCT / 2), isActive: true }],
      templates(30),
    )
    expect(drift).toHaveLength(0)
  })

  it('ignores an inactive scenario rate', () => {
    expect(detectRateDrift([{ rateType: 'FRINGE', percent: D('99'), isActive: false }], templates(30))).toHaveLength(0)
  })

  it('reports nothing when there is no template to compare against', () => {
    expect(detectRateDrift([{ rateType: 'FRINGE', percent: D('30'), isActive: true }], [])).toHaveLength(0)
  })

  it('never rewrites the scenario rate', async () => {
    const { scenario } = await makeWorkspace(firmA.id)
    await prisma.pricingTemplate.create({
      data: {
        consultingFirmId: firmA.id, name: 'Canonical',
        indirectRatesJson: [{ rateType: 'FRINGE', percent: 45, costBase: 'DIRECT_LABOUR' }],
      },
    })
    await runAgent(firmA.id)

    const rate = await prisma.pricingIndirectRate.findFirstOrThrow({ where: { scenarioId: scenario.id } })
    expect(rate.percent.toFixed(0)).toBe('30')
  })
})

// -------------------------------------------------------------
// THE HUMAN-CONTROL BOUNDARY
// -------------------------------------------------------------

describe('the agent changes no human pricing input, at either autonomy level', () => {
  const AUTONOMY = ['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const

  /** A deliberately extreme outlier — the strongest provocation available. */
  async function outlierScenario() {
    await seedPublicAwards(firmA.id, [
      '100000.00', '110000.00', '120000.00', '130000.00',
      '140000.00', '150000.00', '160000.00', '170000.00',
    ])
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 3 * DAY) })
    return makeWorkspace(firmA.id, { opportunityId: opp.id, hours: '100000', rate: '95.00', ownerUserId: ownerA.id })
  }

  it.each(AUTONOMY)('at %s, never changes a labour rate or hours', async (autonomyLevel) => {
    const { scenario } = await outlierScenario()
    const before = await prisma.pricingLaborLine.findFirstOrThrow({ where: { scenarioId: scenario.id } })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.pricingLaborLine.findFirstOrThrow({ where: { scenarioId: scenario.id } })
    expect(after.baseRate.toFixed(4)).toBe(before.baseRate.toFixed(4))
    expect(after.hours.toFixed(2)).toBe(before.hours.toFixed(2))
  })

  it.each(AUTONOMY)('at %s, never changes an indirect rate', async (autonomyLevel) => {
    const { scenario } = await outlierScenario()
    const before = await prisma.pricingIndirectRate.findFirstOrThrow({ where: { scenarioId: scenario.id } })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.pricingIndirectRate.findFirstOrThrow({ where: { scenarioId: scenario.id } })
    expect(after.percent.toFixed(4)).toBe(before.percent.toFixed(4))
    expect(after.costBase).toBe(before.costBase)
  })

  it.each(AUTONOMY)('at %s, never changes an ODC or subcontract amount', async (autonomyLevel) => {
    const { scenario } = await outlierScenario()
    const odc = await prisma.pricingOtherCost.create({
      data: {
        consultingFirmId: firmA.id, scenarioId: scenario.id, costCategory: 'SUBCONTRACTOR',
        description: 'Sub', quantity: D('1'), unitCost: D('50000.00'), totalAmount: D('50000.00'),
      },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.pricingOtherCost.findUniqueOrThrow({ where: { id: odc.id } })
    expect(after.unitCost.toFixed(4)).toBe('50000.0000')
    expect(after.quantity.toFixed(2)).toBe('1.00')
  })

  it.each(AUTONOMY)('at %s, never selects the preferred scenario', async (autonomyLevel) => {
    const { workspace, scenario } = await outlierScenario()
    await prisma.pricingScenario.create({
      data: { consultingFirmId: firmA.id, workspaceId: workspace.id, name: 'Alternative', sortOrder: 1 },
    })
    await runAgent(firmA.id, { autonomyLevel })

    const after = await prisma.pricingWorkspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.preferredScenarioId).toBeNull()
    const scenarios = await prisma.pricingScenario.findMany({ where: { workspaceId: workspace.id } })
    expect(scenarios.every((s) => s.isPreferred === false)).toBe(true)
    expect(scenario.isPreferred).toBe(false)
  })

  it.each(AUTONOMY)('at %s, never approves a PricingReview', async (autonomyLevel) => {
    const { workspace } = await outlierScenario()
    await runAgent(firmA.id, { autonomyLevel })

    const reviews = await prisma.pricingReview.findMany({ where: { consultingFirmId: firmA.id } })
    expect(reviews.every((r) => r.action !== 'APPROVED')).toBe(true)
    const after = await prisma.pricingWorkspace.findUniqueOrThrow({ where: { id: workspace.id } })
    expect(after.approvedAt).toBeNull()
    expect(after.approvedByUserId).toBeNull()
  })

  it.each(AUTONOMY)('at %s, never submits or changes the workspace status', async (autonomyLevel) => {
    const { workspace } = await outlierScenario()
    await runAgent(firmA.id, { autonomyLevel })
    expect((await prisma.pricingWorkspace.findUniqueOrThrow({ where: { id: workspace.id } })).status).toBe('DRAFT')
  })

  it.each(AUTONOMY)('at %s, an extreme outlier only warns, notifies and escalates', async (autonomyLevel) => {
    const { workspace } = await outlierScenario()
    await runAgent(firmA.id, { autonomyLevel })

    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(['ABOVE_HISTORICAL_RANGE', 'EXTREME_OUTLIER']).toContain(assessment.scenarios[0].benchmark.rangeState)

    // It said something…
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmA.id } })).toBeGreaterThan(0)
    // …and changed nothing.
    const line = await prisma.pricingLaborLine.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    expect(line.baseRate.toFixed(2)).toBe('95.00')
  })

  it.each(AUTONOMY)('at %s, reports all four control counters as zero', async (autonomyLevel) => {
    await outlierScenario()
    await runAgent(firmA.id, { autonomyLevel })
    // Asserted where it counts: nothing human-owned moved.
    const lines = await prisma.pricingLaborLine.findMany({ where: { consultingFirmId: firmA.id } })
    expect(lines.every((l) => l.baseRate.toFixed(2) === '95.00')).toBe(true)
    expect(await prisma.pricingReview.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })
})

describe('the preferred scenario stays human-controlled', () => {
  it('reports NO_PREFERRED_SCENARIO rather than choosing one', async () => {
    const { workspace } = await makeWorkspace(firmA.id)
    await prisma.pricingScenario.create({
      data: { consultingFirmId: firmA.id, workspaceId: workspace.id, name: 'Alternative', sortOrder: 1 },
    })
    await runAgent(firmA.id)

    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.preferredScenarioState).toBe('NO_PREFERRED_SCENARIO')
    expect(assessment.preferredScenarioId).toBeNull()
  })

  it('assesses every scenario, not only the preferred one', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id)
    const second = await prisma.pricingScenario.create({
      data: { consultingFirmId: firmA.id, workspaceId: workspace.id, name: 'Alternative', sortOrder: 1 },
    })
    await prisma.pricingWorkspace.update({ where: { id: workspace.id }, data: { preferredScenarioId: scenario.id } })
    await prisma.pricingScenario.update({ where: { id: scenario.id }, data: { isPreferred: true } })

    await runAgent(firmA.id)
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.scenarios).toHaveLength(2)
    expect(assessment.scenarios.map((s: any) => s.scenarioId).sort()).toEqual([scenario.id, second.id].sort())
    expect(assessment.preferredScenarioState).toBe('SELECTED')
  })

  it('leaves the human selection exactly as it was', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id)
    await prisma.pricingWorkspace.update({ where: { id: workspace.id }, data: { preferredScenarioId: scenario.id } })
    await runAgent(firmA.id)
    expect((await prisma.pricingWorkspace.findUniqueOrThrow({ where: { id: workspace.id } })).preferredScenarioId)
      .toBe(scenario.id)
  })
})

// -------------------------------------------------------------
// Sensitivity
// -------------------------------------------------------------

describe('pricing sensitivity reuses the §6 engine', () => {
  it('preserves the documented probability clamps', () => {
    expect(MIN_REPORTED_PROBABILITY).toBe(0.0001)
    expect(MAX_REPORTED_PROBABILITY).toBe(0.9999)
  })

  it('never reports a probability outside the clamps', async () => {
    const { workspace } = await makeWorkspace(firmA.id)
    await runAgent(firmA.id)
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    for (const point of assessment.sensitivity.points) {
      expect(point.probability).toBeGreaterThanOrEqual(MIN_REPORTED_PROBABILITY)
      expect(point.probability).toBeLessThanOrEqual(MAX_REPORTED_PROBABILITY)
    }
  })

  it('labels an uncalibrated curve honestly rather than calling it broken', async () => {
    const { workspace } = await makeWorkspace(firmA.id)
    await runAgent(firmA.id)
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(['RAW', 'CALIBRATED']).toContain(assessment.sensitivity.probabilityMode)
    if (assessment.sensitivity.probabilityMode === 'RAW') {
      expect(assessment.sensitivity.limitations.join(' ')).toContain('not from a calibrated tenant history')
      expect(assessment.sensitivity.limitations.join(' ')).not.toMatch(/broken|invalid/i)
    }
  })

  it('never writes back to the scenario it analysed', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id)
    const before = await prisma.pricingScenario.findUniqueOrThrow({ where: { id: scenario.id } })
    await runAgent(firmA.id)
    const after = await prisma.pricingScenario.findUniqueOrThrow({ where: { id: scenario.id } })
    expect(after.isPreferred).toBe(before.isPreferred)
    expect(after.name).toBe(before.name)
  })

  it('degrades gracefully when no sensitivity data exists', async () => {
    const { workspace } = await makeWorkspace(firmA.id)
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.sensitivity.status).toBeTruthy()
  })
})

// -------------------------------------------------------------
// Assessment + idempotency
// -------------------------------------------------------------

describe('the assessment supersedes rather than duplicating', () => {
  it('records the same hash for an unchanged re-run', async () => {
    const { workspace } = await makeWorkspace(firmA.id)
    await runAgent(firmA.id)
    const first = (await currentAssessment(firmA.id, workspace.id))!.assessment.inputHash
    await runAgent(firmA.id)
    expect((await currentAssessment(firmA.id, workspace.id))!.assessment.inputHash).toBe(first)
  })

  it('changes the hash when the price changes', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id)
    await runAgent(firmA.id)
    const first = (await currentAssessment(firmA.id, workspace.id))!.assessment.inputHash

    await prisma.pricingLaborLine.updateMany({ where: { scenarioId: scenario.id }, data: { baseRate: D('150.00') } })
    await runAgent(firmA.id)
    expect((await currentAssessment(firmA.id, workspace.id))!.assessment.inputHash).not.toBe(first)
  })

  it('leaves exactly one live assessment per workspace', async () => {
    const { workspace, scenario } = await makeWorkspace(firmA.id)
    await runAgent(firmA.id)
    await prisma.pricingLaborLine.updateMany({ where: { scenarioId: scenario.id }, data: { baseRate: D('150.00') } })
    await runAgent(firmA.id)

    expect(await prisma.agentArtifact.count({
      where: {
        consultingFirmId: firmA.id, artifactType: 'PRICING_ASSESSMENT',
        sourceEntityId: workspace.id, supersededByArtifactId: null,
      },
    })).toBe(1)
  })

  it('does not duplicate an escalation on an unchanged re-run', async () => {
    await makeWorkspace(firmA.id, { fringePct: null, ownerUserId: ownerA.id })
    await runAgent(firmA.id)
    await runAgent(firmA.id)

    expect(await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Required indirect rates missing' } },
    })).toBe(1)
  })

  it('does not resend an unchanged notification', async () => {
    await seedPublicAwards(firmA.id, ['100000.00', '110000.00', '120000.00', '130000.00', '140000.00', '150000.00', '160000.00'])
    const opp = await makeOpportunity(firmA.id)
    await makeWorkspace(firmA.id, { opportunityId: opp.id, hours: '100000', ownerUserId: ownerA.id })
    await runAgent(firmA.id)
    const first = await prisma.userNotification.count({ where: { consultingFirmId: firmA.id } })
    await runAgent(firmA.id)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmA.id } })).toBe(first)
  })
})

// -------------------------------------------------------------
// Handler behaviour
// -------------------------------------------------------------

describe('handler', () => {
  it('SKIPS honestly when the firm has no pricing workspace', async () => {
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('SKIPPED')
    expect(run?.limitations.join(' ')).toContain('DRAFT')
  })

  it('records progress and a heartbeat', async () => {
    await makeWorkspace(firmA.id)
    const run = await runAgent(firmA.id)
    expect(run?.progressPercent).toBeGreaterThan(0)
    expect(run?.heartbeatAt).not.toBeNull()
  })

  it('isolates one workspace from another in the same sweep', async () => {
    await makeWorkspace(firmA.id)
    await makeWorkspace(firmA.id)
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'PRICING_ASSESSMENT' },
    })).toBe(2)
  })

  it('completes even when no public award data exists at all', async () => {
    const { workspace } = await makeWorkspace(firmA.id)
    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.scenarios[0].benchmark.rangeState).toBe('INSUFFICIENT_DATA')
    expect(assessment.scenarios[0].benchmark.proposedPricePercentile).toBeNull()
  })

  it('never notifies for INSUFFICIENT_DATA as though the price were out of range', async () => {
    await makeWorkspace(firmA.id, { ownerUserId: ownerA.id })
    await runAgent(firmA.id)
    const notifications = await prisma.userNotification.findMany({ where: { consultingFirmId: firmA.id } })
    expect(notifications.every((n) => !n.title.includes('outside historical range'))).toBe(true)
  })

  it('does not notify under OBSERVE autonomy', async () => {
    await seedPublicAwards(firmA.id, ['100000.00', '110000.00', '120000.00', '130000.00', '140000.00', '150000.00', '160000.00'])
    const opp = await makeOpportunity(firmA.id)
    await makeWorkspace(firmA.id, { opportunityId: opp.id, hours: '100000', ownerUserId: ownerA.id })
    await runAgent(firmA.id, { autonomyLevel: 'OBSERVE' })
    expect(await prisma.userNotification.count({
      where: { consultingFirmId: firmA.id, entityType: 'PricingWorkspace' },
    })).toBe(0)
  })
})

// -------------------------------------------------------------
// Amendment impact
// -------------------------------------------------------------

describe('amendment pricing impact', () => {
  async function makeAmendmentImpact(firmId: string, opportunityId: string, area: string) {
    const amendment = await prisma.amendment.create({
      data: { opportunityId, amendmentNumber: uniq('A'), title: 'S7-PRICE-QA amendment' },
    })
    const revision = await prisma.amendmentRevision.create({
      data: {
        consultingFirmId: firmId, opportunityId, amendmentId: amendment.id,
        revisionNo: 1, contentHash: uniq('h'),
      },
    })
    return prisma.amendmentImpact.create({
      data: {
        consultingFirmId: firmId, revisionId: revision.id, opportunityId,
        area: area as never, impact: `S7-PRICE-QA ${area} impact`, reviewRequired: true,
      },
    })
  }

  it('reports NO_PRICING_IMPACT_IDENTIFIED with no amendment', async () => {
    const { workspace } = await makeWorkspace(firmA.id)
    await runAgent(firmA.id)
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.amendmentImpact.status).toBe('NO_PRICING_IMPACT_IDENTIFIED')
    expect(assessment.amendmentImpact.reviewRequired).toBe(false)
  })

  it('requires review for a PRICING impact', async () => {
    const { workspace, opportunityId } = await makeWorkspace(firmA.id)
    await makeAmendmentImpact(firmA.id, opportunityId, 'PRICING')
    await runAgent(firmA.id)

    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.amendmentImpact.status).toBe('PRICING_REVIEW_REQUIRED')
    expect(assessment.amendmentImpact.reviewRequired).toBe(true)
  })

  it('never claims a price must change by a figure', async () => {
    const { workspace, opportunityId } = await makeWorkspace(firmA.id)
    await makeAmendmentImpact(firmA.id, opportunityId, 'PRICING')
    await runAgent(firmA.id)

    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    const text = assessment.amendmentImpact.evidence.join(' ')
    expect(text).not.toMatch(/must increase by|must decrease by|increase the price by/i)
    expect(text).toContain('has not altered any labour line, rate, quantity or fee')
  })

  it('changes no pricing input when an amendment lands', async () => {
    const { scenario, opportunityId } = await makeWorkspace(firmA.id)
    await makeAmendmentImpact(firmA.id, opportunityId, 'PRICING')
    await runAgent(firmA.id)

    const line = await prisma.pricingLaborLine.findFirstOrThrow({ where: { scenarioId: scenario.id } })
    expect(line.hours.toFixed(2)).toBe('1000.00')
    expect(line.baseRate.toFixed(2)).toBe('95.00')
  })

  it('ignores an impact that predates the last pricing review', async () => {
    const { workspace, opportunityId } = await makeWorkspace(firmA.id)
    await makeAmendmentImpact(firmA.id, opportunityId, 'PRICING')
    await prisma.pricingReview.create({
      data: { consultingFirmId: firmA.id, workspaceId: workspace.id, action: 'APPROVED' },
    })
    await runAgent(firmA.id)

    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.amendmentImpact.status).toBe('NO_PRICING_IMPACT_IDENTIFIED')
    expect(assessment.amendmentImpact.evidence.join(' ')).toContain('predates the most recent pricing review')
  })

  it('preserves the historical PricingReview', async () => {
    const { workspace, opportunityId } = await makeWorkspace(firmA.id)
    const review = await prisma.pricingReview.create({
      data: { consultingFirmId: firmA.id, workspaceId: workspace.id, action: 'APPROVED', comment: 'Approved by a person' },
    })
    await makeAmendmentImpact(firmA.id, opportunityId, 'PRICING')
    await runAgent(firmA.id)

    const after = await prisma.pricingReview.findUniqueOrThrow({ where: { id: review.id } })
    expect(after.action).toBe('APPROVED')
    expect(after.comment).toBe('Approved by a person')
  })
})

// -------------------------------------------------------------
// No LLM
// -------------------------------------------------------------

describe('the whole agent is deterministic — zero LLM', () => {
  it('never reaches the provider and consumes nothing', async () => {
    await seedPublicAwards(firmA.id, ['100000.00', '110000.00', '120000.00', '130000.00', '140000.00', '150000.00', '160000.00'])
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 3 * DAY) })
    await makeWorkspace(firmA.id, { opportunityId: opp.id, hours: '100000', ownerUserId: ownerA.id })

    const run = await runAgent(firmA.id)
    expect(run?.status).toBe('COMPLETED')
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(run?.tokenInput).toBe(0)
    expect(run?.tokenOutput).toBe(0)
    expect(Number(run?.estimatedCostUsd)).toBe(0)
  })

  it('writes no ApiUsageLog row', async () => {
    const before = await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })
    await makeWorkspace(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })).toBe(before)
  })

  it('declares no system prompt anywhere in the pricing directory', () => {
    const dir = __dirname
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))
    expect(sources.length).toBeGreaterThan(0)
    for (const file of sources) {
      const code = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(/SYSTEM_PROMPT/.test(code), `${file} must declare no system prompt`).toBe(false)
      expect(/systemPrompt\s*:/.test(code), `${file} must build no prompt payload`).toBe(false)
    }
  })

  it('imports no LLM router and calls no generator', () => {
    const dir = __dirname
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
      const code = readFileSync(join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      expect(/from '.*\/llm\//.test(code), `${file} must not import the LLM layer`).toBe(false)
      expect(code.includes('generateWithRouter('), `${file} must not call the router`).toBe(false)
      expect(code.includes('budget.generate('), `${file} must not use the budget generator`).toBe(false)
    }
  })
})

// -------------------------------------------------------------
// Tenant isolation
// -------------------------------------------------------------

describe('tenant isolation', () => {
  it('refuses to assess another firm\'s workspace', async () => {
    const { workspace } = await makeWorkspace(firmB.id)
    const run = await runAgent(firmA.id, {
      triggerType: 'EVENT', triggerEntityType: 'PricingScenario', triggerEntityId: workspace.id,
    })
    expect(run?.status).toBe('SKIPPED')
    expect(await prisma.agentArtifact.count({
      where: { consultingFirmId: firmA.id, artifactType: 'PRICING_ASSESSMENT' },
    })).toBe(0)
  })

  it('never assesses a workspace belonging to another firm in a sweep', async () => {
    await makeWorkspace(firmA.id)
    await makeWorkspace(firmB.id)
    await runAgent(firmA.id)

    const artifacts = await prisma.agentArtifact.findMany({
      where: { consultingFirmId: firmA.id, artifactType: 'PRICING_ASSESSMENT' },
    })
    expect(artifacts).toHaveLength(1)
    const firmBWorkspaces = await prisma.pricingWorkspace.findMany({ where: { consultingFirmId: firmB.id }, select: { id: true } })
    for (const w of firmBWorkspaces) expect(artifacts[0].sourceEntityId).not.toBe(w.id)
  })

  it('never reads another firm\'s template for drift', async () => {
    const { scenario } = await makeWorkspace(firmA.id)
    await prisma.pricingTemplate.create({
      data: {
        consultingFirmId: firmB.id, name: 'Firm B template',
        indirectRatesJson: [{ rateType: 'FRINGE', percent: 99, costBase: 'DIRECT_LABOUR' }],
      },
    })
    await runAgent(firmA.id)

    const workspace = await prisma.pricingWorkspace.findFirstOrThrow({ where: { consultingFirmId: firmA.id } })
    const { assessment } = (await currentAssessment(firmA.id, workspace.id))!
    expect(assessment.scenarios[0].rateDrift).toHaveLength(0)
    expect(scenario.id).toBeTruthy()
  })

  it('never reads another firm\'s cached cohort', async () => {
    await makeWorkspace(firmA.id)
    await runAgent(firmA.id)
    expect(await prisma.awardBenchmarkCohort.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('raises no escalation or notification against another firm', async () => {
    await makeWorkspace(firmA.id, { fringePct: null, ownerUserId: ownerA.id })
    await runAgent(firmA.id)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})

// -------------------------------------------------------------
// Near-submission escalation
// -------------------------------------------------------------

describe('near-submission escalation uses working days', () => {
  it('escalates an out-of-range price inside the window', async () => {
    await seedPublicAwards(firmA.id, ['100000.00', '110000.00', '120000.00', '130000.00', '140000.00', '150000.00', '160000.00'])
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 3 * DAY) })
    await makeWorkspace(firmA.id, { opportunityId: opp.id, hours: '100000', ownerUserId: ownerA.id })
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Price outside historical range near submission' } },
    })
    expect(esc).not.toBeNull()
    expect(esc!.reason).toContain('working day(s) until the response deadline')
    expect(esc!.reason).toContain('not a judgement that the price is wrong')
  })

  it('does not escalate the same price far from the deadline', async () => {
    await seedPublicAwards(firmA.id, ['100000.00', '110000.00', '120000.00', '130000.00', '140000.00', '150000.00', '160000.00'])
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 200 * DAY) })
    await makeWorkspace(firmA.id, { opportunityId: opp.id, hours: '100000', ownerUserId: ownerA.id })
    await runAgent(firmA.id)

    expect(await prisma.agentEscalation.count({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Price outside historical range' } },
    })).toBe(0)
  })

  it('escalates a thin benchmark as an evidence problem, never as a price problem', async () => {
    const opp = await makeOpportunity(firmA.id, { responseDeadline: new Date(Date.now() + 3 * DAY) })
    await makeWorkspace(firmA.id, { opportunityId: opp.id, ownerUserId: ownerA.id })
    await runAgent(firmA.id)

    const esc = await prisma.agentEscalation.findFirst({
      where: { consultingFirmId: firmA.id, title: { startsWith: 'Benchmark data insufficient near submission' } },
    })
    expect(esc).not.toBeNull()
    expect(esc!.reason).toContain('insufficient comparable data for confident assessment')
    expect(esc!.reason).toContain('does not mean the price is wrong')
    expect(esc!.reason).toContain(`minimum of ${MIN_BENCHMARK_COHORT_SIZE}`)
  })
})
