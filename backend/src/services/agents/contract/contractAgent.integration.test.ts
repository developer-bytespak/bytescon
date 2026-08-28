// =============================================================
// §7.1 — Contract Administration Agent against a real PostgreSQL database.
//
// Covers the full handler through the §7.0 dispatcher: scoping, health states,
// deliverable reminders and their dedupe, burn, options, period of performance,
// modification impact, escalation dedupe, per-contract failure isolation,
// tenant isolation, the human-control guarantees, and the mandatory proof that
// the agent performs ZERO LLM calls.
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
import { CONTRACT_ENTITY_TYPE } from './contractAdministrationHandler'
import { __resetCalendarCache } from './optionWatch'

const AGENT = 'CONTRACT_ADMINISTRATION' as const
const DAY = 86_400_000

let firmA: TestFirm
let firmB: TestFirm
let ownerA: TestUser
let reviewerA: TestUser
let adminA: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'Contract Agent Firm A' })
  firmB = await createTestFirm({ name: 'Contract Agent Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  ownerA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
  reviewerA = await createTestUser(firmA.id, { role: 'CONSULTANT' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  __resetCalendarCache()
  for (const id of [firmA.id, firmB.id]) {
    await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentRun.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentEvent.deleteMany({ where: { consultingFirmId: id } })
    await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: id } })
    await prisma.userNotification.deleteMany({ where: { consultingFirmId: id } })
    await prisma.contract.deleteMany({ where: { consultingFirmId: id } })
  }
})

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

async function makeContract(firmId: string, over: Partial<Prisma.ContractUncheckedCreateInput> = {}) {
  return prisma.contract.create({
    data: {
      consultingFirmId: firmId,
      contractNumber: uniq('S7-CA-TEST'),
      title: 'Contract agent fixture',
      status: 'ACTIVE',
      startDate: new Date(Date.now() - 60 * DAY),
      endDate: new Date(Date.now() + 365 * DAY),
      fundedValue: new Prisma.Decimal(150000),
      ceilingValue: new Prisma.Decimal(600000),
      ownerUserId: over.ownerUserId !== undefined ? over.ownerUserId : adminA.id,
      ...over,
    },
  })
}

async function makeDeliverable(firmId: string, contractId: string, over: Partial<Prisma.ContractDeliverableUncheckedCreateInput> = {}) {
  return prisma.contractDeliverable.create({
    data: {
      consultingFirmId: firmId,
      contractId,
      name: 'Monthly status report',
      status: 'IN_PROGRESS',
      dueDate: new Date(Date.now() + 5 * DAY),
      ownerUserId: ownerA.id,
      reviewerUserId: reviewerA.id,
      ...over,
    },
  })
}

/** Funded + approved expenditure spanning >= 7 days so burn can project. */
async function makeFinancials(firmId: string, contractId: string, opts: { funded?: number; expended?: number; spanDays?: number } = {}) {
  const funded = opts.funded ?? 150000
  const expended = opts.expended ?? 1700
  const span = opts.spanDays ?? 30

  await prisma.fundingTransaction.create({
    data: { consultingFirmId: firmId, contractId, type: 'INITIAL_OBLIGATION', amount: new Prisma.Decimal(funded) },
  })
  if (expended > 0) {
    await prisma.contractCost.create({
      data: {
        consultingFirmId: firmId, contractId, category: 'ODC',
        description: 'fixture cost', amount: new Prisma.Decimal(expended),
        status: 'APPROVED', incurredDate: new Date(Date.now() - span * DAY),
        approvedAt: new Date(Date.now() - span * DAY),
      },
    })
  }
}

async function runAgent(firmId: string, opts: { contractId?: string; autonomy?: 'OBSERVE' | 'PROPOSE' | 'ACT_WITH_GUARDRAILS' } = {}) {
  const { run } = await createRun({
    consultingFirmId: firmId,
    agentKey: AGENT,
    triggerType: opts.contractId ? 'EVENT' : 'MANUAL',
    idempotencyKey: uniq('run'),
    triggerEntityType: opts.contractId ? CONTRACT_ENTITY_TYPE : null,
    triggerEntityId: opts.contractId ?? null,
    autonomyLevel: opts.autonomy ?? 'PROPOSE',
  })
  const outcome = await dispatchAgentRun(run.id)
  const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } })
  const artifacts = await prisma.agentArtifact.findMany({ where: { runId: run.id } })
  return { outcome, run: after, artifacts }
}

const health = (a: { structuredData: Prisma.JsonValue }) => a.structuredData as unknown as Record<string, any>

// -------------------------------------------------------------
// The mandatory no-LLM guarantee
// -------------------------------------------------------------

describe('no LLM is ever used', () => {
  it('completes a full assessment without touching the provider boundary', async () => {
    const c = await makeContract(firmA.id)
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() - 3 * DAY) })
    await makeFinancials(firmA.id, c.id)
    await prisma.contractOptionPeriod.create({
      data: { consultingFirmId: firmA.id, contractId: c.id, label: 'OY1', startDate: new Date(Date.now() + 100 * DAY) },
    })
    await prisma.contractModification.create({
      data: { consultingFirmId: firmA.id, contractId: c.id, modNumber: 'P00001', status: 'RECORDED', fundingChange: new Prisma.Decimal(1000) },
    })

    const { run, artifacts } = await runAgent(firmA.id, { contractId: c.id })

    expect(run.status).toBe('COMPLETED')
    expect(artifacts).toHaveLength(1)
    // The whole point of this test.
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(run.tokenInput).toBe(0)
    expect(run.tokenOutput).toBe(0)
    expect(Number(run.estimatedCostUsd)).toBe(0)
    // No provider is required, so no NO_LLM_KEY limitation should appear.
    expect(run.limitations.join(' ')).not.toMatch(/NO_LLM_KEY|no provider configured/i)
  })
})

// -------------------------------------------------------------
// Handler scoping and health
// -------------------------------------------------------------

describe('handler scoping', () => {
  it('assesses every monitored contract on a tenant-wide run', async () => {
    await makeContract(firmA.id)
    await makeContract(firmA.id)
    const { run, artifacts } = await runAgent(firmA.id)
    expect(run.status).toBe('COMPLETED')
    expect(artifacts).toHaveLength(2)
  })

  it('assesses only the targeted contract on an event run', async () => {
    const target = await makeContract(firmA.id)
    await makeContract(firmA.id)
    const { artifacts } = await runAgent(firmA.id, { contractId: target.id })
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].sourceEntityId).toBe(target.id)
  })

  it('ignores archived and out-of-lifecycle contracts', async () => {
    await makeContract(firmA.id, { status: 'COMPLETED' })
    await makeContract(firmA.id, { isArchived: true })
    const { run, artifacts } = await runAgent(firmA.id)
    expect(artifacts).toHaveLength(0)
    expect(run.status).toBe('SKIPPED')
    expect(run.outputSummary).toMatch(/No contracts are in a monitored state/)
  })

  it('reports a healthy contract as HEALTHY', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { expended: 100 })
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() + 200 * DAY) })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    expect(health(artifacts[0]).overallHealth).toBe('HEALTHY')
  })

  it('reports an overdue deliverable as CRITICAL', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { expended: 100 })
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() - 10 * DAY) })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const h = health(artifacts[0])
    expect(h.overallHealth).toBe('CRITICAL')
    expect(h.deliverables.overdue).toBe(1)
  })

  it('reports a due-soon deliverable as ATTENTION', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { expended: 100 })
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() + 5 * DAY) })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    expect(health(artifacts[0]).overallHealth).toBe('ATTENTION')
  })

  it('is deterministic across two runs of unchanged data', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id)
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() + 200 * DAY) })

    const first = await runAgent(firmA.id, { contractId: c.id })
    const second = await runAgent(firmA.id, { contractId: c.id })

    const a = health(first.artifacts[0])
    const b = health(second.artifacts[0])
    expect(a.overallHealth).toBe(b.overallHealth)
    expect(a.funding.fundedRemaining).toBe(b.funding.fundedRemaining)
    expect(a.funding.ceilingRemaining).toBe(b.funding.ceilingRemaining)
  })

  it('supersedes the previous health artifact instead of piling up', async () => {
    const c = await makeContract(firmA.id)
    await runAgent(firmA.id, { contractId: c.id })
    await runAgent(firmA.id, { contractId: c.id })

    const all = await prisma.agentArtifact.findMany({
      where: { consultingFirmId: firmA.id, artifactType: 'CONTRACT_HEALTH' },
      orderBy: { createdAt: 'asc' },
    })
    expect(all).toHaveLength(2)
    expect(all[0].supersededByArtifactId).toBe(all[1].id)
    // Exactly one current artifact per contract.
    expect(all.filter((a) => a.supersededByArtifactId === null)).toHaveLength(1)
  })
})

describe('per-contract failure isolation', () => {
  it('keeps assessing other contracts when one fails', async () => {
    const good = await makeContract(firmA.id)
    const bad = await makeContract(firmA.id)
    await makeFinancials(firmA.id, good.id)

    // A funding row pointing at a CLIN on a different contract is the kind of
    // inconsistency that should not take down the whole tenant run.
    const spy = vi.spyOn(prisma.contractDeliverable, 'findMany')
    spy.mockImplementation((async (args: { where?: { contractId?: string } }) => {
      if (args?.where?.contractId === bad.id) throw new Error('simulated corrupt deliverable data')
      return []
    }) as never)

    try {
      const { run, artifacts } = await runAgent(firmA.id)
      expect(run.status).toBe('COMPLETED')
      // The good contract still produced its artifact.
      expect(artifacts.map((a) => a.sourceEntityId)).toContain(good.id)
      expect(artifacts.map((a) => a.sourceEntityId)).not.toContain(bad.id)
      expect(run.warnings.join(' ')).toMatch(/could not be assessed/)
      const metrics = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id }, select: { warnings: true } })
      expect(metrics.warnings.length).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })
})

// -------------------------------------------------------------
// Deliverable reminders
// -------------------------------------------------------------

describe('deliverable reminders', () => {
  it('notifies the owner for a due-soon deliverable and records lastReminderAt', async () => {
    const c = await makeContract(firmA.id)
    const d = await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() + 2 * DAY) })

    await runAgent(firmA.id, { contractId: c.id })

    const notes = await prisma.userNotification.findMany({ where: { consultingFirmId: firmA.id, entityId: d.id } })
    expect(notes).toHaveLength(1)
    expect(notes[0].userId).toBe(ownerA.id)
    expect(notes[0].linkPath).toBe(`/contracts/${c.id}`)

    const after = await prisma.contractDeliverable.findUniqueOrThrow({ where: { id: d.id } })
    expect(after.lastReminderAt).not.toBeNull()
  })

  it('does NOT send a second reminder on the same day', async () => {
    const c = await makeContract(firmA.id)
    const d = await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() + 2 * DAY) })

    await runAgent(firmA.id, { contractId: c.id })
    await runAgent(firmA.id, { contractId: c.id })

    const notes = await prisma.userNotification.findMany({ where: { consultingFirmId: firmA.id, entityId: d.id } })
    expect(notes).toHaveLength(1)
  })

  it('escalates an overdue deliverable to owner, reviewer and admin', async () => {
    const c = await makeContract(firmA.id)
    const d = await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() - 3 * DAY) })

    await runAgent(firmA.id, { contractId: c.id })

    const notes = await prisma.userNotification.findMany({ where: { consultingFirmId: firmA.id, entityId: d.id } })
    const userIds = notes.map((n) => n.userId)
    expect(userIds).toEqual(expect.arrayContaining([ownerA.id, reviewerA.id, adminA.id]))

    const after = await prisma.contractDeliverable.findUniqueOrThrow({ where: { id: d.id } })
    expect(after.lastEscalationAt).not.toBeNull()
  })

  it('never treats an ACCEPTED deliverable as overdue', async () => {
    const c = await makeContract(firmA.id)
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() - 30 * DAY), status: 'ACCEPTED' })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const h = health(artifacts[0])
    expect(h.deliverables.overdue).toBe(0)
    expect(h.overallHealth).not.toBe('CRITICAL')
  })

  it.each([
    ['SUBMITTED', 0],
    ['WAIVED', 0],
    ['CANCELLED', 0],
    ['IN_PROGRESS', 1],
    ['REJECTED', 1],
  ])('treats a past-due %s deliverable as overdue=%i', async (status, expected) => {
    const c = await makeContract(firmA.id)
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() - 5 * DAY), status })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    expect(health(artifacts[0]).deliverables.overdue).toBe(expected)
  })

  it('counts an unowned due item and warns rather than silently skipping it', async () => {
    const c = await makeContract(firmA.id)
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() - 2 * DAY), ownerUserId: null, reviewerUserId: null })
    const { artifacts, run } = await runAgent(firmA.id, { contractId: c.id })
    expect(health(artifacts[0]).deliverables.unowned).toBe(1)
    expect(run.warnings.join(' ')).toMatch(/no owner or reviewer/)
  })

  it('sends no reminders at OBSERVE autonomy but still reports the assessment', async () => {
    const c = await makeContract(firmA.id)
    const d = await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() - 3 * DAY) })

    const { artifacts } = await runAgent(firmA.id, { contractId: c.id, autonomy: 'OBSERVE' })

    expect(health(artifacts[0]).deliverables.overdue).toBe(1)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmA.id, entityId: d.id } })).toBe(0)
    const after = await prisma.contractDeliverable.findUniqueOrThrow({ where: { id: d.id } })
    expect(after.lastReminderAt).toBeNull()
  })
})

// -------------------------------------------------------------
// Burn
// -------------------------------------------------------------

describe('burn assessment', () => {
  it('reports funded and ceiling remaining as distinct exact figures', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { funded: 150000, expended: 1700, spanDays: 30 })

    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const f = health(artifacts[0]).funding

    expect(f.funded).toBe('150000.00')
    expect(f.expended).toBe('1700.00')
    expect(f.fundedRemaining).toBe('148300.00')
    expect(f.ceilingRemaining).toBe('598300.00')
    expect(f.fundedRemaining).not.toBe(f.ceilingRemaining)
  })

  it('makes no projection with zero expenditure and says why', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { expended: 0 })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const f = health(artifacts[0]).funding
    expect(f.projectedFundingExhaustion).toBeNull()
    expect(f.insufficientData).toBe(true)
    expect(f.reasons.join(' ')).toMatch(/No recognized expenditure/)
  })

  it('makes no projection when the history is under 7 days', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { expended: 5000, spanDays: 3 })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const f = health(artifacts[0]).funding
    expect(f.projectedFundingExhaustion).toBeNull()
    expect(f.reasons.join(' ')).toMatch(/too short/)
  })

  it('excludes voided funding from the total', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { funded: 100000, expended: 0 })
    await prisma.fundingTransaction.create({
      data: { consultingFirmId: firmA.id, contractId: c.id, type: 'REVERSAL', amount: new Prisma.Decimal(50000), isVoided: true },
    })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    expect(health(artifacts[0]).funding.funded).toBe('100000.00')
  })

  it('applies a deobligation as a signed reduction', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { funded: 100000, expended: 0 })
    await prisma.fundingTransaction.create({
      data: { consultingFirmId: firmA.id, contractId: c.id, type: 'DEOBLIGATION', amount: new Prisma.Decimal(-25000) },
    })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    expect(health(artifacts[0]).funding.funded).toBe('75000.00')
  })

  it('escalates once when a funding threshold is breached, not once per run', async () => {
    const c = await makeContract(firmA.id, { ceilingValue: null })
    await makeFinancials(firmA.id, c.id, { funded: 10000, expended: 9900, spanDays: 30 })

    await runAgent(firmA.id, { contractId: c.id })
    await runAgent(firmA.id, { contractId: c.id })

    const escalations = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, title: { contains: 'Funding threshold' } },
    })
    expect(escalations).toHaveLength(1)
    expect(escalations[0].severity).toBe('CRITICAL')
  })

  it('does not escalate a healthy funding position', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id, { funded: 150000, expended: 100 })
    await runAgent(firmA.id, { contractId: c.id })
    const escalations = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, title: { contains: 'Funding threshold' } },
    })
    expect(escalations).toHaveLength(0)
  })
})

// -------------------------------------------------------------
// Options
// -------------------------------------------------------------

describe('option watch', () => {
  it('labels a derived decision date as an internal recommendation', async () => {
    const c = await makeContract(firmA.id)
    await prisma.contractOptionPeriod.create({
      data: { consultingFirmId: firmA.id, contractId: c.id, label: 'OY1', startDate: new Date(Date.now() + 100 * DAY) },
    })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const w = health(artifacts[0]).options.upcomingDecisionWindows[0]
    expect(w.dateBasis).toBe('INTERNAL_RECOMMENDATION')
    expect(w.isInternalRecommendation).toBe(true)
    expect(w.reasons.join(' ')).toMatch(/not a government or contractual deadline/)
  })

  it('prefers an explicit exercise deadline over the derived date', async () => {
    const c = await makeContract(firmA.id)
    const deadline = new Date(Date.now() + 10 * DAY)
    await prisma.contractOptionPeriod.create({
      data: {
        consultingFirmId: firmA.id, contractId: c.id, label: 'OY1',
        startDate: new Date(Date.now() + 100 * DAY), exerciseDeadline: deadline,
      },
    })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const w = health(artifacts[0]).options.upcomingDecisionWindows[0]
    expect(w.dateBasis).toBe('EXERCISE_DEADLINE')
    expect(w.isInternalRecommendation).toBe(false)
    expect(w.state).toBe('OPEN')
  })

  it('reports INSUFFICIENT_DATA when the option has no usable dates', async () => {
    const c = await makeContract(firmA.id)
    await prisma.contractOptionPeriod.create({
      data: { consultingFirmId: firmA.id, contractId: c.id, label: 'OY1' },
    })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const w = health(artifacts[0]).options.upcomingDecisionWindows[0]
    expect(w.state).toBe('INSUFFICIENT_DATA')
    expect(w.effectiveDecisionDate).toBeNull()
  })

  it('stops tracking an option that has already been decided', async () => {
    const c = await makeContract(firmA.id)
    await prisma.contractOptionPeriod.create({
      data: {
        consultingFirmId: firmA.id, contractId: c.id, label: 'OY1',
        exerciseStatus: 'EXERCISED', exerciseDeadline: new Date(Date.now() + 5 * DAY),
      },
    })
    const { artifacts } = await runAgent(firmA.id, { contractId: c.id })
    const o = health(artifacts[0]).options
    expect(o.openWindowCount).toBe(0)
    expect(o.upcomingDecisionWindows).toHaveLength(0)
  })

  it('escalates an open decision window with no contract owner', async () => {
    const c = await makeContract(firmA.id, { ownerUserId: null })
    await prisma.contractOptionPeriod.create({
      data: {
        consultingFirmId: firmA.id, contractId: c.id, label: 'OY1',
        exerciseDeadline: new Date(Date.now() + 5 * DAY),
      },
    })
    await runAgent(firmA.id, { contractId: c.id })
    const esc = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, title: { contains: 'no owner' } },
    })
    expect(esc).toHaveLength(1)
    expect(esc[0].severity).toBe('HIGH')
  })

  it('never changes an option period', async () => {
    const c = await makeContract(firmA.id)
    const o = await prisma.contractOptionPeriod.create({
      data: {
        consultingFirmId: firmA.id, contractId: c.id, label: 'OY1',
        exerciseDeadline: new Date(Date.now() + 2 * DAY), exerciseStatus: 'PLANNED',
      },
    })
    await runAgent(firmA.id, { contractId: c.id, autonomy: 'ACT_WITH_GUARDRAILS' })
    const after = await prisma.contractOptionPeriod.findUniqueOrThrow({ where: { id: o.id } })
    expect(after.exerciseStatus).toBe('PLANNED')
    expect(after.updatedAt.getTime()).toBe(o.updatedAt.getTime())
  })
})

// -------------------------------------------------------------
// Period of performance + modifications
// -------------------------------------------------------------

describe('period of performance and modifications', () => {
  it('escalates an expiring period with open deliverables', async () => {
    const c = await makeContract(firmA.id, { endDate: new Date(Date.now() + 20 * DAY) })
    await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() + 5 * DAY) })

    await runAgent(firmA.id, { contractId: c.id })

    const esc = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, title: { contains: 'Period of performance closing' } },
    })
    expect(esc).toHaveLength(1)
  })

  it('reports an unapplied modification impact WITHOUT applying it', async () => {
    const c = await makeContract(firmA.id)
    const mod = await prisma.contractModification.create({
      data: {
        consultingFirmId: firmA.id, contractId: c.id, modNumber: 'P00001',
        status: 'RECORDED', fundingChange: new Prisma.Decimal(25000),
      },
    })

    const { artifacts } = await runAgent(firmA.id, { contractId: c.id, autonomy: 'ACT_WITH_GUARDRAILS' })
    const m = health(artifacts[0]).modifications

    expect(m.unresolvedImpacts).toHaveLength(1)
    expect(m.recent[0].projectedFundedValue).toBe('175000.00')

    // The authoritative records are untouched.
    const contractAfter = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })
    expect(contractAfter.fundedValue?.toFixed(2)).toBe('150000.00')
    const modAfter = await prisma.contractModification.findUniqueOrThrow({ where: { id: mod.id } })
    expect(modAfter.status).toBe('RECORDED')
    expect(modAfter.appliedAt).toBeNull()
  })

  it('raises one deduped escalation for unapplied modifications', async () => {
    const c = await makeContract(firmA.id)
    await prisma.contractModification.create({
      data: { consultingFirmId: firmA.id, contractId: c.id, modNumber: 'P00001', status: 'RECORDED' },
    })
    await runAgent(firmA.id, { contractId: c.id })
    await runAgent(firmA.id, { contractId: c.id })
    const esc = await prisma.agentEscalation.findMany({
      where: { consultingFirmId: firmA.id, title: { contains: 'Unapplied modification' } },
    })
    expect(esc).toHaveLength(1)
  })
})

// -------------------------------------------------------------
// Human control — the hard guarantees
// -------------------------------------------------------------

describe('human control guarantees', () => {
  it('never accepts, rejects or otherwise transitions a deliverable — even at ACT_WITH_GUARDRAILS', async () => {
    const c = await makeContract(firmA.id)
    const d = await makeDeliverable(firmA.id, c.id, { dueDate: new Date(Date.now() - 30 * DAY), status: 'SUBMITTED' })

    await runAgent(firmA.id, { contractId: c.id, autonomy: 'ACT_WITH_GUARDRAILS' })

    const after = await prisma.contractDeliverable.findUniqueOrThrow({ where: { id: d.id } })
    expect(after.status).toBe('SUBMITTED')
    expect(after.acceptanceStatus).toBeNull()
    expect(after.acceptanceDate).toBeNull()
    expect(after.rejectionReason).toBeNull()
    expect(after.submissionDate).toBeNull()
  })

  it('never changes contract financial values or dates', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id)
    const before = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })

    await runAgent(firmA.id, { contractId: c.id, autonomy: 'ACT_WITH_GUARDRAILS' })

    const after = await prisma.contract.findUniqueOrThrow({ where: { id: c.id } })
    expect(after.fundedValue?.toFixed(2)).toBe(before.fundedValue?.toFixed(2))
    expect(after.ceilingValue?.toFixed(2)).toBe(before.ceilingValue?.toFixed(2))
    expect(after.startDate?.getTime()).toBe(before.startDate?.getTime())
    expect(after.endDate?.getTime()).toBe(before.endDate?.getTime())
    expect(after.status).toBe(before.status)
  })

  it('never creates a funding transaction', async () => {
    const c = await makeContract(firmA.id)
    await makeFinancials(firmA.id, c.id)
    const before = await prisma.fundingTransaction.count({ where: { contractId: c.id } })
    await runAgent(firmA.id, { contractId: c.id, autonomy: 'ACT_WITH_GUARDRAILS' })
    expect(await prisma.fundingTransaction.count({ where: { contractId: c.id } })).toBe(before)
  })

  it('exposes no allowlisted autonomous action at all', async () => {
    const { requireAgentDefinition } = await import('../registry')
    const { canApplyAction } = await import('../safeActions')
    expect(requireAgentDefinition(AGENT).allowlistedActionKeys).toEqual([])
    for (const key of ['deliverable.accept', 'modification.apply', 'option.exercise', 'funding.adjust']) {
      expect(canApplyAction(AGENT, 'ACT_WITH_GUARDRAILS', key), key).toBe(false)
    }
  })
})

// -------------------------------------------------------------
// Tenant isolation
// -------------------------------------------------------------

describe('tenant isolation', () => {
  it('refuses to assess another firm’s contract even when targeted directly', async () => {
    const foreign = await makeContract(firmB.id)
    const { run, artifacts } = await runAgent(firmA.id, { contractId: foreign.id })
    expect(artifacts).toHaveLength(0)
    expect(run.status).toBe('SKIPPED')
    expect(await prisma.agentArtifact.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('never includes another firm’s contracts in a tenant-wide run', async () => {
    await makeContract(firmA.id)
    await makeContract(firmB.id)
    const { artifacts } = await runAgent(firmA.id)
    expect(artifacts).toHaveLength(1)
    expect(artifacts[0].consultingFirmId).toBe(firmA.id)
  })

  it('never notifies another firm’s users', async () => {
    const c = await makeContract(firmB.id)
    await makeDeliverable(firmB.id, c.id, { dueDate: new Date(Date.now() - 3 * DAY), ownerUserId: null, reviewerUserId: null })
    await runAgent(firmA.id)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('never escalates into another firm', async () => {
    const c = await makeContract(firmB.id)
    await makeFinancials(firmB.id, c.id, { funded: 1000, expended: 999, spanDays: 30 })
    await runAgent(firmA.id)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })
})
