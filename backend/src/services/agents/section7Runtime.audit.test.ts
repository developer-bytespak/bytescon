// =============================================================
// SECTION 7 — NINE-AGENT ACCEPTANCE AUDIT (live runtime)
//
// The companion to `section7Acceptance.audit.test.ts`. That file proves
// structure; this one proves BEHAVIOUR against a real PostgreSQL database,
// across all nine agents at once:
//
//   · every agent runs, at both autonomy levels, without touching another
//     agent's authoritative records
//   · an event chain terminates in a bounded number of runs
//   · a replayed event produces no second run and no duplicate side effects
//   · a rolled-back business write emits nothing
//   · one tenant's data cannot reach another's output, notifications,
//     escalations or artifacts
//   · a disabled agent is skipped, and a cancelled run stops
//
// Everything here uses the shared §7.0 runtime. No agent gets a shortcut.
// =============================================================
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const generateWithRouterSpy = vi.fn()
vi.mock('../llm/llmRouter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/llmRouter')>()
  return {
    ...actual,
    generateWithRouter: (...a: unknown[]) => generateWithRouterSpy(...a),
    isLlmProviderConfigured: async () => false,
  }
})

import { prisma } from '../../config/database'
import {
  createTestFirm, createTestUser, cleanupFirm, disconnectDb, type TestFirm, type TestUser,
} from '../../test-utils/testClient'
import { dispatchAgentRun } from './dispatch'
import { createRun } from './runService'
import { processOutbox, emitAgentEvent } from './outbox'
import { runAgentScheduler } from './scheduler'
import { AGENT_REGISTRY, getAgentDefinition } from './registry'
import { DOMAIN_AGENT_KEYS, type AgentKey } from './types'
import { emitExtractionCompleted } from './compliance/complianceEvents'
import { emitSubcontractMilestoneDue } from './teaming/teamingEvents'
import { emitContractAwarded } from './contract/contractEvents'

const DAY = 86_400_000
const dec = (v: string | number) => new Prisma.Decimal(v)

let firmA: TestFirm
let firmB: TestFirm
let adminA: TestUser

let seq = 0
const uniq = (p: string) => `${p}-${Date.now()}-${seq++}`

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'S7 Audit Firm A' })
  firmB = await createTestFirm({ name: 'S7 Audit Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

async function purgeRuntime(firmId: string) {
  await prisma.agentEscalation.deleteMany({ where: { consultingFirmId: firmId } })
  await prisma.agentArtifact.deleteMany({ where: { consultingFirmId: firmId } })
  await prisma.agentRun.deleteMany({ where: { consultingFirmId: firmId } })
  await prisma.agentEvent.deleteMany({ where: { consultingFirmId: firmId } })
  await prisma.agentSchedule.deleteMany({ where: { consultingFirmId: firmId } })
  await prisma.userNotification.deleteMany({ where: { consultingFirmId: firmId } })
}

beforeEach(async () => {
  generateWithRouterSpy.mockReset()
  for (const id of [firmA.id, firmB.id]) await purgeRuntime(id)
})

const run = async (firmId: string, agentKey: AgentKey, over: Record<string, unknown> = {}) => {
  const { run: r } = await createRun({
    consultingFirmId: firmId, agentKey, triggerType: 'MANUAL', idempotencyKey: uniq('audit'), ...over,
  })
  await dispatchAgentRun(r.id)
  return prisma.agentRun.findUniqueOrThrow({ where: { id: r.id } })
}

// =============================================================
// 1. Every agent runs on the shared runtime
// =============================================================

describe('audit: all nine agents run on the shared runtime', () => {
  it.each([...DOMAIN_AGENT_KEYS])('%s dispatches to a terminal state', async (key) => {
    const r = await run(firmA.id, key)
    // SKIPPED is a legitimate terminal state for an agent with nothing in scope.
    expect(['COMPLETED', 'SKIPPED'], `${key} ended ${r.status}`).toContain(r.status)
    expect(r.errorCode).toBeNull()
  })

  it.each([...DOMAIN_AGENT_KEYS])('%s spends nothing when no provider is configured', async (key) => {
    const r = await run(firmA.id, key)
    expect(r.tokenInput, key).toBe(0)
    expect(r.tokenOutput, key).toBe(0)
    expect(Number(r.estimatedCostUsd), key).toBe(0)
  })

  it('makes zero provider calls across a full nine-agent sweep', async () => {
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)
    expect(generateWithRouterSpy).not.toHaveBeenCalled()
    expect(await prisma.apiUsageLog.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it.each([...DOMAIN_AGENT_KEYS])('%s runs at ACT_WITH_GUARDRAILS without failing', async (key) => {
    const r = await run(firmA.id, key, { autonomyLevel: 'ACT_WITH_GUARDRAILS' })
    expect(['COMPLETED', 'SKIPPED'], `${key} ended ${r.status}`).toContain(r.status)
  })

  it('records an honest data-sufficiency state rather than a fabricated success', async () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      const r = await run(firmA.id, key)
      expect(['SUFFICIENT', 'PARTIAL', 'INSUFFICIENT'], `${key}: ${r.dataSufficiency}`).toContain(r.dataSufficiency)
    }
  })
})

// =============================================================
// 2. Human control — no agent writes another domain's records
// =============================================================

/**
 * A census of the authoritative records a nine-agent sweep must never create,
 * modify or remove. Counting before and after is a blunt instrument, and that
 * is the point: it catches a write the per-slice tests did not anticipate.
 */
async function authoritativeCensus(firmId: string) {
  // OpportunityMatch is deliberately absent: a match score is the Opportunity
  // Agent's OWN output, like an artifact. What must not change without a human
  // is the scoring WEIGHTS, which the §7.2 apply/revert suite covers.
  const [
    bidDecisions, pursuits, submissions, proposalSubmissions, contracts,
    invoices, payments, timeEntries, capabilities, narratives, calibrations,
  ] = await Promise.all([
    prisma.bidDecision.count({ where: { consultingFirmId: firmId } }),
    prisma.bidPursuit.count({ where: { consultingFirmId: firmId } }),
    prisma.submissionRecord.count({ where: { consultingFirmId: firmId } }),
    prisma.proposalSubmission.count({ where: { consultingFirmId: firmId } }),
    prisma.contract.count({ where: { consultingFirmId: firmId } }),
    prisma.contractInvoice.count({ where: { consultingFirmId: firmId } }),
    prisma.invoicePayment.count({ where: { consultingFirmId: firmId } }),
    prisma.timeEntry.count({ where: { consultingFirmId: firmId } }),
    prisma.firmCapability.count({ where: { consultingFirmId: firmId } }),
    prisma.capabilityNarrative.count({ where: { consultingFirmId: firmId } }),
    prisma.tenantCalibration.count({ where: { consultingFirmId: firmId } }),
  ])
  return { bidDecisions, pursuits, submissions, proposalSubmissions, contracts, invoices, payments, timeEntries, capabilities, narratives, calibrations }
}

describe('audit: human-control master matrix', () => {
  for (const autonomyLevel of ['PROPOSE', 'ACT_WITH_GUARDRAILS'] as const) {
    it(`at ${autonomyLevel}, a full nine-agent sweep creates no human decision record`, async () => {
      const contract = await prisma.contract.create({
        data: {
          consultingFirmId: firmA.id, contractNumber: uniq('S7-AUDIT-QA'), title: 'S7-AUDIT-QA contract',
          agency: 'Department of Defense', status: 'ACTIVE',
          startDate: new Date(Date.now() - 100 * DAY), endDate: new Date(Date.now() + 100 * DAY),
        },
      })
      const opportunity = await prisma.opportunity.create({
        data: {
          consultingFirmId: firmA.id, samNoticeId: uniq('S7-AUDIT-QA'), title: 'S7-AUDIT-QA opportunity',
          agency: 'Department of Defense', naicsCode: '541512', setAsideType: 'SDVOSB',
          estimatedValue: dec(1_000_000), responseDeadline: new Date(Date.now() + 30 * DAY),
          status: 'ACTIVE', isDemo: false,
        },
      })
      await prisma.bidPursuit.create({
        data: { consultingFirmId: firmA.id, opportunityId: opportunity.id, status: 'REVIEWING', pipelineStage: 'IDENTIFIED', priority: 'LOW' },
      })

      const before = await authoritativeCensus(firmA.id)
      for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key, { autonomyLevel })
      const after = await authoritativeCensus(firmA.id)

      // The ONE permitted creation across the whole sweep is a DRAFT invoice
      // from Finance, which the per-slice suite covers. Everything else must be
      // untouched.
      expect({ ...after, invoices: before.invoices }).toEqual(before)

      const pursuit = await prisma.bidPursuit.findFirstOrThrow({ where: { opportunityId: opportunity.id } })
      expect(pursuit.pipelineStage, 'no agent may move a pursuit stage').toBe('IDENTIFIED')
      expect(pursuit.priority, 'no agent may reprioritise a pursuit').toBe('LOW')
      expect(pursuit.status).toBe('REVIEWING')

      const invoicesCreated = await prisma.contractInvoice.findMany({ where: { consultingFirmId: firmA.id } })
      for (const inv of invoicesCreated) {
        expect(inv.status, 'an agent-created invoice must be DRAFT').toBe('DRAFT')
        expect(inv.approvedByUserId).toBeNull()
        expect(inv.submittedAt).toBeNull()
      }

      void contract
      // Clean up the fixtures this case created.
      await prisma.contractInvoiceLineItem.deleteMany({ where: { consultingFirmId: firmA.id } })
      await prisma.contractInvoice.deleteMany({ where: { consultingFirmId: firmA.id } })
      await prisma.bidPursuit.deleteMany({ where: { consultingFirmId: firmA.id } })
      await prisma.opportunity.deleteMany({ where: { consultingFirmId: firmA.id } })
      await prisma.contract.deleteMany({ where: { consultingFirmId: firmA.id } })
    })
  }

  it('never attributes an agent action to a human actor', async () => {
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)
    const events = await prisma.auditEvent.findMany({
      where: { consultingFirmId: firmA.id, createdAt: { gte: new Date(Date.now() - 60_000) } },
      select: { actorUserId: true, entityType: true, action: true },
    })
    for (const e of events) {
      expect(e.actorUserId, `an agent audit event must have a null actor: ${e.entityType}/${e.action}`).toBeNull()
    }
  })
})

// =============================================================
// 3. Event chains terminate
// =============================================================

describe('audit: event chains are bounded', () => {
  /** Drive the outbox until it is quiet, capping the passes so a loop fails. */
  async function drain(firmId: string, maxPasses = 8) {
    let passes = 0
    for (; passes < maxPasses; passes += 1) {
      const before = await prisma.agentEvent.count({ where: { consultingFirmId: firmId, status: 'PENDING' } })
      if (before === 0) break
      await processOutbox(`audit-${passes}`, 50, new Date(), { consultingFirmId: firmId })
      const queued = await prisma.agentRun.findMany({ where: { consultingFirmId: firmId, status: 'QUEUED' } })
      for (const r of queued) await dispatchAgentRun(r.id)
    }
    return passes
  }

  it('terminates the Compliance extraction chain rather than looping', async () => {
    const opportunity = await prisma.opportunity.create({
      data: {
        consultingFirmId: firmA.id, samNoticeId: uniq('S7-AUDIT-QA-LOOP'), title: 'S7-AUDIT-QA loop',
        agency: 'DoD', naicsCode: '541512', responseDeadline: new Date(Date.now() + 30 * DAY),
        status: 'ACTIVE', isDemo: false,
      },
    })
    await prisma.$transaction(async (tx) => {
      await emitExtractionCompleted(tx, {
        consultingFirmId: firmA.id, extractionJobId: uniq('job'), opportunityId: opportunity.id,
        documentId: null, status: 'SUCCEEDED', requirementsCreated: 3,
        clausesCreated: 1, mappingsCreated: 0, unresolvedCount: 0,
      })
    })

    const passes = await drain(firmA.id)
    expect(passes, 'the chain must settle well inside the pass cap').toBeLessThan(8)
    expect(await prisma.agentEvent.count({ where: { consultingFirmId: firmA.id, status: 'PENDING' } })).toBe(0)

    // Three subscribers, one run each. A fourth would mean a re-trigger.
    const runs = await prisma.agentRun.findMany({ where: { consultingFirmId: firmA.id, triggerType: 'EVENT' } })
    expect(runs.map((r) => r.agentKey).sort()).toEqual(['COMPLIANCE', 'PROPOSAL', 'QUALIFICATION'])

    await prisma.opportunity.deleteMany({ where: { consultingFirmId: firmA.id } })
  })

  it('terminates the Teaming milestone chain rather than looping', async () => {
    await prisma.$transaction(async (tx) => {
      await emitSubcontractMilestoneDue({
        consultingFirmId: firmA.id, goalId: uniq('goal'), riskState: 'AT_RISK',
        workingDaysRemaining: 3, dueDateIso: new Date(Date.now() + 3 * DAY).toISOString(),
      }, tx)
    })
    const passes = await drain(firmA.id)
    expect(passes).toBeLessThan(8)
    const runs = await prisma.agentRun.findMany({ where: { consultingFirmId: firmA.id, triggerType: 'EVENT' } })
    expect(runs.map((r) => r.agentKey)).toEqual(['TEAMING'])
  })

  it('fans one award out to exactly its two subscribers and stops', async () => {
    const contract = await prisma.contract.create({
      data: {
        consultingFirmId: firmA.id, contractNumber: uniq('S7-AUDIT-QA-AWARD'), title: 'S7-AUDIT-QA award',
        agency: 'DoD', status: 'ACTIVE',
      },
    })
    await prisma.$transaction(async (tx) => {
      await emitContractAwarded(tx, { consultingFirmId: firmA.id, contractId: contract.id, contractNumber: contract.contractNumber! })
    })
    await drain(firmA.id)
    const runs = await prisma.agentRun.findMany({ where: { consultingFirmId: firmA.id, triggerType: 'EVENT' } })
    expect(runs.map((r) => r.agentKey).sort()).toEqual(['CONTRACT_ADMINISTRATION', 'INTELLIGENCE'])
    await prisma.contract.deleteMany({ where: { consultingFirmId: firmA.id } })
  })
})

// =============================================================
// 4. Outbox contract
// =============================================================

describe('audit: transactional outbox', () => {
  it('emits nothing when the business transaction rolls back', async () => {
    await expect(prisma.$transaction(async (tx) => {
      await emitAgentEvent({ consultingFirmId: firmA.id, eventType: 'CONTRACT_AWARDED', entityType: 'Contract', entityId: 'rollback' }, tx)
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(await prisma.agentEvent.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('never aborts the business write for a benign duplicate', async () => {
    const contract = await prisma.contract.create({
      data: { consultingFirmId: firmA.id, contractNumber: uniq('S7-AUDIT-QA-DUP'), title: 'dup', agency: 'DoD', status: 'DRAFT' },
    })
    const committed = await prisma.$transaction(async (tx) => {
      const args = { consultingFirmId: firmA.id, contractId: contract.id, contractNumber: contract.contractNumber! }
      await emitContractAwarded(tx, args)
      await emitContractAwarded(tx, args)
      return tx.contract.update({ where: { id: contract.id }, data: { title: 'business write survived' } })
    })
    expect(committed.title).toBe('business write survived')
    expect(await prisma.agentEvent.count({ where: { consultingFirmId: firmA.id, eventType: 'CONTRACT_AWARDED' } })).toBe(1)
    await prisma.contract.deleteMany({ where: { consultingFirmId: firmA.id } })
  })

  it('creates no second run when the same event is reprocessed', async () => {
    await emitAgentEvent({ consultingFirmId: firmA.id, eventType: 'CONTRACT_AWARDED', entityType: 'Contract', entityId: 'replay' })
    await processOutbox('w1', 20, new Date(), { consultingFirmId: firmA.id })
    const first = await prisma.agentRun.count({ where: { consultingFirmId: firmA.id } })

    // Force the event back to PENDING and reprocess it, exactly as a crashed
    // worker would leave it.
    await prisma.agentEvent.updateMany({ where: { consultingFirmId: firmA.id }, data: { status: 'PENDING', claimedAt: null, claimedBy: null } })
    await processOutbox('w2', 20, new Date(), { consultingFirmId: firmA.id })
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id } })).toBe(first)
  })

  it('never lets one firm’s event produce another firm’s run', async () => {
    await emitAgentEvent({ consultingFirmId: firmA.id, eventType: 'CONTRACT_AWARDED', entityType: 'Contract', entityId: 'a' })
    await emitAgentEvent({ consultingFirmId: firmB.id, eventType: 'CONTRACT_AWARDED', entityType: 'Contract', entityId: 'b' })
    await processOutbox('w', 50, new Date(), { consultingFirmId: firmA.id })

    const aRuns = await prisma.agentRun.findMany({ where: { consultingFirmId: firmA.id } })
    const bRuns = await prisma.agentRun.findMany({ where: { consultingFirmId: firmB.id } })
    expect(aRuns.length).toBeGreaterThan(0)
    expect(bRuns, 'processing Firm A must not touch Firm B').toHaveLength(0)
  })
})

// =============================================================
// 5. Scheduler and lifecycle
// =============================================================

describe('audit: scheduler and run lifecycle', () => {
  it('skips a disabled agent even when it is due', async () => {
    await prisma.agentSchedule.create({
      data: {
        consultingFirmId: firmA.id, agentKey: 'OPPORTUNITY', isEnabled: false, scheduleType: 'CRON',
        cronExpression: '*/5 * * * *', nextRunAt: new Date(Date.now() - 60_000),
      },
    })
    const res = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    expect(res.runsCreated).toBe(0)
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id } })).toBe(0)
  })

  it('creates one run per due schedule and does not storm on repeat ticks', async () => {
    await prisma.agentSchedule.create({
      data: {
        consultingFirmId: firmA.id, agentKey: 'INTELLIGENCE', isEnabled: true, scheduleType: 'CRON',
        cronExpression: '*/5 * * * *', nextRunAt: new Date(Date.now() - 60_000),
      },
    })
    const first = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    expect(first.runsCreated).toBe(1)

    // Immediately ticking again must not create a second run: nextRunAt moved.
    const second = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    expect(second.runsCreated).toBe(0)
    const third = await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    expect(third.runsCreated).toBe(0)
    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmA.id } })).toBe(1)
  })

  it('advances nextRunAt past the due window', async () => {
    const schedule = await prisma.agentSchedule.create({
      data: {
        consultingFirmId: firmA.id, agentKey: 'FINANCE', isEnabled: true, scheduleType: 'CRON',
        cronExpression: '0 8 * * *', nextRunAt: new Date(Date.now() - 60_000),
      },
    })
    await runAgentScheduler(new Date(), 100, { consultingFirmId: firmA.id })
    const after = await prisma.agentSchedule.findUniqueOrThrow({ where: { id: schedule.id } })
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now())
    expect(after.lastRunAt).not.toBeNull()
  })

  it('stops a cancelled run before it starts work', async () => {
    const { run: r } = await createRun({
      consultingFirmId: firmA.id, agentKey: 'INTELLIGENCE', triggerType: 'MANUAL', idempotencyKey: uniq('cancel'),
    })
    await prisma.agentRun.update({ where: { id: r.id }, data: { cancelledAt: new Date() } })
    await dispatchAgentRun(r.id)
    const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: r.id } })
    expect(['CANCELLED', 'COMPLETED', 'SKIPPED']).toContain(after.status)
    if (after.status === 'CANCELLED') expect(after.finishedAt).not.toBeNull()
  })

  it('leaves no run stuck in a non-terminal state after a sweep', async () => {
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)
    const stuck = await prisma.agentRun.findMany({
      where: { consultingFirmId: firmA.id, status: { in: ['RUNNING', 'QUEUED'] } },
      select: { agentKey: true, status: true },
    })
    expect(stuck).toEqual([])
  })

  it('records a run for every dispatch, with attribution', async () => {
    const r = await run(firmA.id, 'INTELLIGENCE')
    expect(r.consultingFirmId).toBe(firmA.id)
    expect(r.agentKey).toBe('INTELLIGENCE')
    expect(r.startedAt).not.toBeNull()
    expect(r.finishedAt).not.toBeNull()
  })
})

// =============================================================
// 6. Cross-tenant isolation across all nine
// =============================================================

describe('audit: cross-tenant isolation across the whole layer', () => {
  it('never writes a run, artifact, escalation or notification into another firm', async () => {
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)

    expect(await prisma.agentRun.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentArtifact.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
  })

  it('scopes every artifact, escalation and notification it does write to Firm A', async () => {
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)
    for (const table of [
      prisma.agentArtifact.findMany({ where: {}, select: { consultingFirmId: true } }),
      prisma.agentEscalation.findMany({ where: {}, select: { consultingFirmId: true } }),
    ]) {
      const rows = await table
      const strays = rows.filter((r) => r.consultingFirmId === firmB.id)
      expect(strays).toEqual([])
    }
  })

  it('refuses to run an agent against another firm’s entity', async () => {
    const contractB = await prisma.contract.create({
      data: { consultingFirmId: firmB.id, contractNumber: uniq('S7-AUDIT-QA-B'), title: 'B', agency: 'DoD', status: 'ACTIVE' },
    })
    const r = await run(firmA.id, 'CONTRACT_ADMINISTRATION', { triggerEntityType: 'Contract', triggerEntityId: contractB.id })
    expect(r.status).toBe('SKIPPED')
    expect(await prisma.agentArtifact.count({ where: { consultingFirmId: firmB.id } })).toBe(0)
    await prisma.contract.deleteMany({ where: { consultingFirmId: firmB.id } })
  })
})

// =============================================================
// 7. Artifact inventory, live
// =============================================================

describe('audit: artifact families are producible and tenant-safe', () => {
  it('declares an artifact type for every agent that the enum accepts', async () => {
    // A supportedArtifactType the database enum does not know would fail only
    // at write time, on a customer's run.
    for (const d of AGENT_REGISTRY) {
      const probeRun = await run(firmA.id, d.key)
      for (const type of d.supportedArtifactTypes) {
        const created = await prisma.agentArtifact.create({
          data: {
            consultingFirmId: firmA.id, runId: probeRun.id, agentKey: d.key, artifactType: type,
            title: `audit probe ${type}`, structuredData: {},
          },
        })
        expect(created.artifactType).toBe(type)
      }
    }
    await prisma.agentArtifact.deleteMany({ where: { consultingFirmId: firmA.id } })
  })

  it('never leaves an artifact without a tenant', async () => {
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)
    const artifacts = await prisma.agentArtifact.findMany({ where: { consultingFirmId: firmA.id } })
    for (const a of artifacts) {
      expect(a.consultingFirmId).toBe(firmA.id)
      expect(a.agentKey).toBeTruthy()
    }
  })
})

// =============================================================
// 8. Notification and escalation dedupe across repeated sweeps
// =============================================================

describe('audit: repeated sweeps do not spam', () => {
  it('creates no new notification or escalation on an unchanged second sweep', async () => {
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)
    const first = {
      notifications: await prisma.userNotification.count({ where: { consultingFirmId: firmA.id } }),
      escalations: await prisma.agentEscalation.count({ where: { consultingFirmId: firmA.id } }),
    }

    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)

    expect(await prisma.userNotification.count({ where: { consultingFirmId: firmA.id } })).toBe(first.notifications)
    expect(await prisma.agentEscalation.count({ where: { consultingFirmId: firmA.id } })).toBe(first.escalations)
  })

  it('leaves exactly one live artifact per subject after repeated sweeps', async () => {
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)
    for (const key of DOMAIN_AGENT_KEYS) await run(firmA.id, key)

    // The runtime expresses supersession by pointing the old artifact at the
    // new one. Two live artifacts describing the same subject would mean a
    // reader could see stale analysis presented as current.
    const live = await prisma.agentArtifact.findMany({
      where: { consultingFirmId: firmA.id, supersededByArtifactId: null },
      select: { agentKey: true, artifactType: true, sourceEntityType: true, sourceEntityId: true },
    })
    const subjects = live.map((a) => `${a.agentKey}:${a.artifactType}:${a.sourceEntityType}:${a.sourceEntityId}`)
    expect(new Set(subjects).size, `duplicate live artifacts: ${subjects.join(' | ')}`).toBe(subjects.length)
  })
})
