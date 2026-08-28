// =============================================================
// §7.1 — Contract Administration Agent handler.
//
// A plain async function on the §7.0 AgentContext/AgentResult contract. It owns
// no queue, no worker, no scheduler and no reaper — the shared runtime provides
// all of that.
//
// FULLY DETERMINISTIC. This handler performs ZERO LLM calls: it never touches
// `ctx.budget.generate` or `generateWithRouter`, so it runs correctly with no
// provider configured and consumes no tokens. A regression test asserts the
// provider boundary is never reached.
//
// Every mutation it performs is operational bookkeeping (reminder timestamps,
// notifications, artifacts, escalations). It never accepts or rejects a
// deliverable, applies a modification, exercises an option, or changes any
// financial value.
// =============================================================
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import { assessBurn, burnEscalationDedupeHint } from './burnMonitor'
import { assessDeliverables, deliverableEscalationDedupeHint } from './deliverableWatch'
import { assessOptions, optionEscalationDedupeHint } from './optionWatch'
import {
  assessModifications,
  assessPeriodOfPerformance,
  modificationEscalationDedupeHint,
  popEscalationDedupeHint,
} from './popWatch'
import {
  MONITORED_CONTRACT_STATUSES,
  thresholdSeverity,
  worstHealth,
  type ContractHealthState,
} from './policy'

/** Entity type the runtime uses to target a run at one contract. */
export const CONTRACT_ENTITY_TYPE = 'Contract'

const MAX_CONTRACTS_PER_RUN = 200

export interface ContractHealthSnapshot {
  contractId: string
  contractNumber: string
  title: string
  status: string
  generatedAt: string
  overallHealth: ContractHealthState
  deliverables: ReturnType<typeof summariseDeliverables>
  funding: Awaited<ReturnType<typeof assessBurn>>
  options: Awaited<ReturnType<typeof assessOptions>>
  periodOfPerformance: ReturnType<typeof assessPeriodOfPerformance>
  modifications: Awaited<ReturnType<typeof assessModifications>>
  clinCount: number
  warnings: string[]
  dataLimitations: string[]
}

function summariseDeliverables(a: Awaited<ReturnType<typeof assessDeliverables>>) {
  return {
    total: a.total,
    dueSoon: a.dueSoon,
    overdue: a.overdue,
    awaitingReview: a.awaitingReview,
    unowned: a.unowned,
    openItems: a.openItems,
    remindersSent: a.remindersSent,
    escalationsSent: a.escalationsSent,
  }
}

/**
 * The agent entry point.
 *
 * Scope resolution:
 *   - run targeted at a Contract  → that one contract (tenant-verified)
 *   - otherwise                    → every monitored contract for the tenant
 */
export async function contractAdministrationHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  // OBSERVE may compute and persist artifacts but must not notify or write
  // operational bookkeeping. PROPOSE and above may remind and escalate.
  const mayAct = ctx.autonomyLevel !== 'OBSERVE'

  const contracts = await resolveContracts(ctx)
  ctx.log('contract administration scope resolved', { contracts: contracts.length, mayAct })

  if (contracts.length === 0) {
    return {
      status: 'SKIPPED',
      summary: ctx.triggerEntityId
        ? 'The targeted contract is not monitored by this agent (archived, or outside the monitored lifecycle).'
        : 'No contracts are in a monitored state for this firm.',
      confidence: 'HIGH',
      dataSufficiency: 'SUFFICIENT',
      metrics: { contractsScanned: 0 },
      limitations: [`Only contracts with status ${MONITORED_CONTRACT_STATUSES.join(' or ')} are monitored.`],
      inputSnapshot: { scope: ctx.triggerEntityId ?? 'TENANT', contractCount: 0 },
      inputHash: `contract-admin:${ctx.consultingFirmId}:none:${now.toISOString().slice(0, 10)}`,
    }
  }

  // Resolved once per run rather than once per contract.
  const adminUserIds = (
    await prisma.user.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, role: 'ADMIN', isActive: true },
      select: { id: true },
      take: 10,
    })
  ).map((u) => u.id)

  const artifacts: ProposedArtifact[] = []
  const escalations: ProposedEscalation[] = []
  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []

  let processed = 0
  let failed = 0
  let remindersSent = 0
  let escalationsRaised = 0
  const healthTally: Record<ContractHealthState, number> = { HEALTHY: 0, ATTENTION: 0, CRITICAL: 0, INSUFFICIENT_DATA: 0 }

  for (const contract of contracts) {
    // Per-contract isolation: one corrupt record must never abort the batch.
    try {
      if (ctx.signal.aborted) {
        limitations.push('The run was cancelled before every contract was assessed.')
        break
      }

      const snapshot = await assessContract({
        ctx,
        contract,
        now,
        mayAct,
        adminUserIds,
      })

      healthTally[snapshot.overallHealth]++
      remindersSent += snapshot.deliverables.remindersSent
      warnings.push(...snapshot.warnings.map((w) => `[${contract.contractNumber}] ${w}`))
      limitations.push(...snapshot.dataLimitations.map((l) => `[${contract.contractNumber}] ${l}`))
      evidence.push(...collectEvidence(snapshot))

      artifacts.push({
        artifactType: 'CONTRACT_HEALTH',
        title: `Contract health — ${contract.contractNumber}`,
        summary: buildSummaryLine(snapshot),
        structuredData: snapshot as unknown as Record<string, unknown>,
        evidence: collectEvidence(snapshot),
        sourceEntityType: CONTRACT_ENTITY_TYPE,
        sourceEntityId: contract.id,
        confidenceState: snapshot.overallHealth === 'INSUFFICIENT_DATA' ? 'LOW' : 'HIGH',
        // One current artifact per contract; earlier ones are superseded, never
        // overwritten, so the history stays intact.
        supersedeKey: `contract-health:${contract.id}`,
      })

      const contractEscalations = buildEscalations(snapshot)
      escalationsRaised += contractEscalations.length
      escalations.push(...contractEscalations)

      processed++
      await ctx.heartbeat(Math.round((processed / contracts.length) * 100), `assessed ${processed}/${contracts.length}`)
    } catch (err) {
      failed++
      const message = (err as Error).message
      warnings.push(`[${contract.contractNumber}] could not be assessed: ${message}`)
      limitations.push(`[${contract.contractNumber}] was skipped because its data could not be read safely.`)
      logger.error('Contract administration failed for one contract (continuing)', {
        contractId: contract.id,
        runId: ctx.runId,
        error: message,
      })
      // A contract the agent cannot read is itself a condition worth surfacing.
      escalations.push({
        severity: 'MEDIUM',
        title: `Contract health could not be calculated: ${contract.contractNumber}`,
        reason: `The agent could not assess this contract safely: ${message}`,
        recommendedAction: 'Check the contract, its funding ledger and its deliverables for inconsistent data.',
        entityType: CONTRACT_ENTITY_TYPE,
        entityId: contract.id,
        dedupeHint: `contract-assessment-failed:${contract.id}`,
      })
    }
  }

  const anyCritical = healthTally.CRITICAL > 0
  const anyAttention = healthTally.ATTENTION > 0
  const allInsufficient = processed > 0 && healthTally.INSUFFICIENT_DATA === processed

  return {
    status: 'COMPLETED',
    summary:
      `Assessed ${processed} contract(s): ${healthTally.CRITICAL} critical, ${healthTally.ATTENTION} needing attention, ` +
      `${healthTally.HEALTHY} healthy, ${healthTally.INSUFFICIENT_DATA} with insufficient data.` +
      (failed ? ` ${failed} contract(s) could not be assessed.` : ''),
    confidence: allInsufficient ? 'LOW' : failed > 0 ? 'MEDIUM' : 'HIGH',
    dataSufficiency: allInsufficient ? 'INSUFFICIENT' : failed > 0 || limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
    evidence,
    artifacts,
    escalations,
    // Nothing this agent does is a judgement action, so there are no proposed
    // business actions — only operational work it already performed.
    metrics: {
      contractsScanned: contracts.length,
      contractsAssessed: processed,
      contractsFailed: failed,
      remindersSent,
      escalationsRaised,
      critical: healthTally.CRITICAL,
      attention: healthTally.ATTENTION,
      healthy: healthTally.HEALTHY,
      insufficientData: healthTally.INSUFFICIENT_DATA,
    },
    warnings,
    limitations,
    inputSnapshot: {
      scope: ctx.triggerEntityId ?? 'TENANT',
      contractIds: contracts.map((c) => c.id),
      autonomyLevel: ctx.autonomyLevel,
    },
    // Day-bucketed so an unchanged daily re-run is recognisably the same input.
    inputHash: `contract-admin:${ctx.consultingFirmId}:${ctx.triggerEntityId ?? 'TENANT'}:${contracts.length}:${now.toISOString().slice(0, 10)}`,
    ...(anyCritical || anyAttention ? {} : {}),
  }
}

/**
 * Resolves which contracts this run covers.
 *
 * A targeted run verifies BOTH the contract id and its tenant — never trusting
 * an id alone — so a cross-tenant event can never reach another firm's data.
 */
async function resolveContracts(ctx: AgentExecutionContext) {
  const select = {
    id: true, contractNumber: true, title: true, status: true, ownerUserId: true,
    fundedValue: true, ceilingValue: true, startDate: true, endDate: true,
  } as const

  if (ctx.triggerEntityType === CONTRACT_ENTITY_TYPE && ctx.triggerEntityId) {
    const one = await prisma.contract.findFirst({
      where: {
        id: ctx.triggerEntityId,
        consultingFirmId: ctx.consultingFirmId,
        isArchived: false,
        status: { in: [...MONITORED_CONTRACT_STATUSES] },
      },
      select,
    })
    return one ? [one] : []
  }

  return prisma.contract.findMany({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      isArchived: false,
      status: { in: [...MONITORED_CONTRACT_STATUSES] },
    },
    select,
    orderBy: { endDate: 'asc' },
    take: MAX_CONTRACTS_PER_RUN,
  })
}

type ContractRow = Awaited<ReturnType<typeof resolveContracts>>[number]

async function assessContract(args: {
  ctx: AgentExecutionContext
  contract: ContractRow
  now: Date
  mayAct: boolean
  adminUserIds: string[]
}): Promise<ContractHealthSnapshot> {
  const { ctx, contract, now } = args

  const [deliverables, funding, options, modifications, clinCount] = await Promise.all([
    assessDeliverables({
      consultingFirmId: ctx.consultingFirmId,
      contractId: contract.id,
      contractTitle: contract.title,
      now,
      sendReminders: args.mayAct,
      adminUserIds: args.adminUserIds,
    }),
    assessBurn(ctx.consultingFirmId, { id: contract.id, ceilingValue: contract.ceilingValue, endDate: contract.endDate }, now),
    assessOptions({
      consultingFirmId: ctx.consultingFirmId,
      contractId: contract.id,
      contractOwnerUserId: contract.ownerUserId,
      now,
    }),
    assessModifications({
      consultingFirmId: ctx.consultingFirmId,
      contractId: contract.id,
      fundedValue: contract.fundedValue,
      ceilingValue: contract.ceilingValue,
      startDate: contract.startDate,
      endDate: contract.endDate,
      now,
    }),
    prisma.clin.count({ where: { consultingFirmId: ctx.consultingFirmId, contractId: contract.id, isArchived: false } }),
  ])

  const openDeliverableCount = deliverables.overdue + deliverables.dueSoon
  const pop = assessPeriodOfPerformance({
    contractId: contract.id,
    startDate: contract.startDate,
    endDate: contract.endDate,
    now,
    hasOpenOptionWindow: options.openWindowCount > 0,
    openDeliverableCount,
  })

  const overallHealth = worstHealth([deliverables.health, funding.health, options.health, pop.health, modifications.health])

  const dataLimitations = [
    ...funding.reasons,
    ...(pop.state === 'INSUFFICIENT_DATA' ? pop.reasons : []),
    ...options.upcomingDecisionWindows
      .filter((w) => w.state === 'INSUFFICIENT_DATA')
      .map((w) => `Option "${w.label}" has no usable decision date.`),
  ]

  return {
    contractId: contract.id,
    contractNumber: contract.contractNumber,
    title: contract.title,
    status: contract.status,
    generatedAt: now.toISOString(),
    overallHealth,
    deliverables: summariseDeliverables(deliverables),
    funding,
    options,
    periodOfPerformance: pop,
    modifications,
    clinCount,
    warnings: [...deliverables.warnings, ...options.warnings, ...modifications.warnings],
    dataLimitations,
  }
}

function collectEvidence(s: ContractHealthSnapshot): EvidenceRef[] {
  return [...s.funding.evidence, ...s.options.evidence, ...s.periodOfPerformance.evidence, ...s.modifications.evidence]
}

function buildSummaryLine(s: ContractHealthSnapshot): string {
  const bits = [`${s.overallHealth}`]
  if (s.deliverables.overdue) bits.push(`${s.deliverables.overdue} overdue deliverable(s)`)
  if (s.deliverables.dueSoon) bits.push(`${s.deliverables.dueSoon} due soon`)
  if (s.funding.thresholdState !== 'OK' && s.funding.thresholdState !== 'INSUFFICIENT_DATA') {
    bits.push(s.funding.thresholdState.replace(/_/g, ' ').toLowerCase())
  }
  if (s.options.openWindowCount) bits.push(`${s.options.openWindowCount} option decision window(s) open`)
  if (s.periodOfPerformance.state === 'APPROACHING_END' || s.periodOfPerformance.state === 'EXPIRED') {
    bits.push(`period of performance ${s.periodOfPerformance.state.replace(/_/g, ' ').toLowerCase()}`)
  }
  return bits.join(' · ')
}

/**
 * Escalations for genuinely actionable conditions only. Healthy contracts never
 * escalate, and each dedupe hint is stable per (contract, condition) so an
 * unchanged problem does not produce a new item every day.
 */
function buildEscalations(s: ContractHealthSnapshot): ProposedEscalation[] {
  const out: ProposedEscalation[] = []

  for (const item of s.deliverables.openItems) {
    if (item.isOverdue && item.reminderLevel === 'ESCALATED') {
      out.push({
        severity: 'HIGH',
        title: `Deliverable overdue: ${item.name}`,
        reason: `${item.reminderReason ?? 'The deliverable is past its due date.'} Contract ${s.contractNumber}.`,
        recommendedAction: 'Confirm the delivery status with the owner, or record the submission if it has already been made.',
        entityType: 'ContractDeliverable',
        entityId: item.id,
        assignedToUserId: item.ownerUserId ?? item.reviewerUserId ?? null,
        dedupeHint: deliverableEscalationDedupeHint(item.id),
      })
    }
  }

  if (s.funding.thresholdState !== 'OK' && s.funding.thresholdState !== 'INSUFFICIENT_DATA') {
    out.push({
      severity: thresholdSeverity(s.funding.thresholdState),
      title: `Funding threshold reached: ${s.contractNumber}`,
      reason:
        `${s.funding.thresholdState.replace(/_/g, ' ')} — funded remaining ${s.funding.fundedRemaining}` +
        (s.funding.ceilingRemaining ? `, ceiling remaining ${s.funding.ceilingRemaining}` : '') +
        `. Expended ${s.funding.expended} of ${s.funding.funded} funded.`,
      recommendedAction: 'Review the funding position and consider requesting incremental funding.',
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: s.contractId,
      dedupeHint: burnEscalationDedupeHint(s.contractId, s.funding.thresholdState),
    })
  }

  for (const w of s.options.upcomingDecisionWindows) {
    if ((w.state === 'OPEN' || w.state === 'PAST') && !w.ownerUserId) {
      out.push({
        severity: 'HIGH',
        title: `Option decision has no owner: ${w.label}`,
        reason: `The option decision window for "${w.label}" on ${s.contractNumber} is ${w.state === 'PAST' ? 'past' : 'open'} but no contract owner is assigned.`,
        recommendedAction: 'Assign a contract owner so the option decision can be made.',
        entityType: 'ContractOptionPeriod',
        entityId: w.optionPeriodId,
        dedupeHint: optionEscalationDedupeHint(w.optionPeriodId, 'MISSING_OWNER'),
      })
    }
  }

  if (
    (s.periodOfPerformance.state === 'APPROACHING_END' ||
      s.periodOfPerformance.state === 'EXPIRED' ||
      s.periodOfPerformance.state === 'OPTION_WINDOW') &&
    s.deliverables.overdue + s.deliverables.dueSoon > 0
  ) {
    out.push({
      severity: s.periodOfPerformance.state === 'EXPIRED' ? 'CRITICAL' : 'HIGH',
      title: `Period of performance closing with open deliverables: ${s.contractNumber}`,
      reason: s.periodOfPerformance.reasons.join(' '),
      recommendedAction: 'Close out the open deliverables, or agree an extension through the modification workflow.',
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: s.contractId,
      dedupeHint: popEscalationDedupeHint(s.contractId),
    })
  }

  if (s.modifications.unresolvedImpacts.length > 0) {
    out.push({
      severity: 'MEDIUM',
      title: `Unapplied modification(s): ${s.contractNumber}`,
      reason: `${s.modifications.unresolvedImpacts.length} modification(s) are recorded but not applied, so contract totals do not yet reflect them.`,
      recommendedAction: 'Review each modification and apply it through the contract modification workflow. The agent never applies modifications.',
      entityType: CONTRACT_ENTITY_TYPE,
      entityId: s.contractId,
      dedupeHint: modificationEscalationDedupeHint(s.contractId),
    })
  }

  return out
}
