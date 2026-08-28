// =============================================================
// §7.8 — Finance Agent handler.
//
// A plain async handler on the shared §7.0 runtime. No new queue, worker,
// scheduler or reaper.
//
// FULLY DETERMINISTIC. This slice adds ZERO system prompts and makes ZERO LLM
// calls. Invoices, ageing, readiness verdicts, rate variance and cash flow are
// all computed from records — no model is asked to interpret a financial
// amount, and `finance.noLlm.test.ts` asserts this directory contains no prompt
// literal and no router import.
//
// MODULE 9 STAYS AUTHORITATIVE. ContractInvoice, InvoicePayment, TimeEntry and
// ContractCost are the only billing records. Eligibility and line arithmetic
// come from `invoiceBuilder`, which the human invoice route also calls, so
// there is exactly one implementation.
//
// WHAT IT MAY NEVER DO — at PROPOSE and ACT_WITH_GUARDRAILS alike
//   approve an invoice · submit an invoice · mark an invoice PAID · record a
//   payment · write off a receivable · alter a payment amount · alter a
//   submitted invoice · edit, approve, backdate or delete a time entry ·
//   alter a provisional or actual rate · initiate a payment · contact a
//   customer · submit to WAWF or IPP
//
// The only rows it creates are DRAFT invoices, readiness checks, cash-flow
// projections, notifications, escalations and its own artifact.
// =============================================================
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { notifyUser } from '../../notificationService'
import { D } from '../../contractFinance'
import { buildWorkingCalendar } from '../workingCalendar'
import { forecastRevenue } from '../../revenueForecaster'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import {
  AGENT_INVOICE_STATUS,
  assembleInvoice,
  billingPeriodKey,
  eligibleCostWhere,
  eligibleTimeWhere,
  lastClosedMonth,
  nextInvoiceNumber,
  periodAlreadyInvoiced,
  type BillingPeriod,
} from './invoiceBuilder'
import {
  ageReceivables,
  overdueEscalationReason,
  ESCALATION_OVERDUE_DAYS,
  type AgeingResult,
} from './receivablesAgeing'
import {
  computeRateVariances,
  provisionalRatesFromTemplate,
  varianceEscalationReason,
  VARIANCE_MATERIAL_PCT,
  type RateVarianceResult,
} from './rateVariance'
import {
  buildReadinessReport,
  criticalEscalationReason,
  READINESS_DISCLAIMER,
  READINESS_LOOKBACK_DAYS,
  type ReadinessReport,
} from './dcaaReadiness'
import {
  projectCashFlow,
  negativeNetFlowReason,
  DEFAULT_HORIZON_MONTHS,
  NEGATIVE_NET_FLOW_STATE,
  type CashFlowResult,
} from './cashFlowProjection'

export const FINANCE_AGENT_KEY = 'FINANCE' as const
export const FINANCE_METHOD_VERSION = 'finance-v1'
export const CONTRACT_ENTITY_TYPE = 'Contract'

const DAY_MS = 86_400_000

/** Contracts the agent will bill and monitor. A draft contract is not billable. */
export const BILLABLE_CONTRACT_STATUSES = ['ACTIVE', 'ON_HOLD', 'COMPLETED'] as const

/** Ceiling on one sweep, so a large portfolio cannot run past the deadline. */
export const MAX_CONTRACTS_PER_SWEEP = 50

/** Ceiling on drafts created in one run — a runaway would flood the reviewer. */
export const MAX_INVOICES_PER_RUN = 10

export const FINANCE_PHASES = [
  'LOAD_FINANCE_CONTEXT',
  'CHECK_TIMEKEEPING',
  'CHECK_ADJUSTMENT_TRAILS',
  'BUILD_DRAFT_INVOICES',
  'AGE_RECEIVABLES',
  'CHECK_PAYMENT_STATUS',
  'LOAD_PROVISIONAL_RATES',
  'LOAD_ACTUAL_RATES',
  'COMPUTE_RATE_VARIANCE',
  'PROJECT_CASH_FLOW',
  'BUILD_DCAA_READINESS',
  'BUILD_FINANCE_STATUS',
  'CREATE_NOTIFICATIONS',
  'CREATE_ESCALATIONS',
  'COMPLETE',
] as const

export type FinancePhase = (typeof FINANCE_PHASES)[number]

const ALWAYS: FinancePhase[] = ['LOAD_FINANCE_CONTEXT', 'BUILD_FINANCE_STATUS', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE']

/**
 * Only the phases a given trigger needs.
 *
 * A submitted time entry does not warrant re-running rate variance, and a
 * recorded payment does not warrant re-reading the whole timekeeping period.
 */
export function phasesForRun(triggerEntityType: string | null, triggerEventType: string | null): FinancePhase[] {
  if (triggerEventType === 'TIME_ENTRY_SUBMITTED') {
    return ['LOAD_FINANCE_CONTEXT', 'CHECK_TIMEKEEPING', 'CHECK_ADJUSTMENT_TRAILS', 'BUILD_DCAA_READINESS', ...ALWAYS.slice(1)]
  }
  if (triggerEventType === 'INVOICE_PAID') {
    return ['LOAD_FINANCE_CONTEXT', 'AGE_RECEIVABLES', 'CHECK_PAYMENT_STATUS', 'PROJECT_CASH_FLOW', ...ALWAYS.slice(1)]
  }
  if (triggerEventType === 'CONTRACT_COST_ADDED') {
    return ['LOAD_FINANCE_CONTEXT', 'BUILD_DRAFT_INVOICES', 'PROJECT_CASH_FLOW', ...ALWAYS.slice(1)]
  }
  void triggerEntityType
  return [...FINANCE_PHASES]
}

// -------------------------------------------------------------
// Artifact shape
// -------------------------------------------------------------

export interface FinanceStatusArtifact {
  generatedAt: string
  methodVersion: string
  scope: { contractsAssessed: number; contractIds: string[] }
  invoices: {
    draftsReadyForReview: number
    createdThisRun: number
    billingPeriods: Array<{ contractId: string; periodStart: string; periodEnd: string; state: string; invoiceId: string | null; total: string | null }>
    warnings: string[]
  }
  receivables: {
    totalOutstanding: string
    current: string
    days1to30: string
    days31to60: string
    days61to90: string
    days91to120: string
    days120Plus: string
    overdueInvoices: AgeingResult['receivables']
    invoicesWithoutDueDate: number
  }
  timekeeping: {
    readinessState: ReadinessReport['readinessState']
    readinessScore: number | null
    rulesChecked: number
    scorableRules: number
    criticalFailures: number
    failing: number
    warnings: number
    unsupportedRules: number
    insufficientDataRules: number
    disclaimer: string
    rules: ReadinessReport['rules']
  }
  indirectRates: {
    periods: number
    variances: RateVarianceResult[]
    reviewRequired: number
  }
  cashFlow: CashFlowResult | null
  notifications: string[]
  escalations: string[]
  /** Explicit zero counters — a regression shows up as a number, not a silence. */
  humanControl: {
    invoicesApproved: 0
    invoicesSubmitted: 0
    invoicesMarkedPaid: 0
    paymentsRecorded: 0
    receivablesWrittenOff: 0
    timeEntriesModified: 0
    ratesModified: 0
    externalSubmissions: 0
  }
  warnings: string[]
  dataLimitations: string[]
  inputHash: string
}

// -------------------------------------------------------------
// Scope
// -------------------------------------------------------------

interface ScopedContract {
  id: string
  contractNumber: string | null
  title: string
  agency: string | null
  status: string
}

async function resolveScope(ctx: AgentExecutionContext): Promise<ScopedContract[]> {
  const where: Prisma.ContractWhereInput = {
    consultingFirmId: ctx.consultingFirmId,
    status: { in: [...BILLABLE_CONTRACT_STATUSES] },
  }
  // An event names a contract, so the run targets it rather than the portfolio.
  if (ctx.triggerEntityType === CONTRACT_ENTITY_TYPE && ctx.triggerEntityId) {
    where.id = ctx.triggerEntityId
  }
  return prisma.contract.findMany({
    where,
    orderBy: { createdAt: 'asc' },
    take: MAX_CONTRACTS_PER_SWEEP,
    select: { id: true, contractNumber: true, title: true, agency: true, status: true },
  })
}

// -------------------------------------------------------------
// Draft invoices
// -------------------------------------------------------------

export interface BillingOutcome {
  contractId: string
  period: BillingPeriod
  state:
    | 'DRAFT_CREATED'
    | 'ALREADY_INVOICED'
    | 'NOTHING_ELIGIBLE'
    | 'EXISTING_DRAFT_COVERS_PERIOD'
    | 'NOT_PERMITTED_AT_THIS_AUTONOMY'
    | 'RUN_LIMIT_REACHED'
  invoiceId: string | null
  total: string | null
  timeEntryIds: string[]
  costIds: string[]
  warnings: string[]
}

/**
 * Build one contract's draft invoice for a billing period.
 *
 * Idempotency has two layers, and both matter:
 *   1. `periodAlreadyInvoiced` stops a second invoice for the same period.
 *   2. `invoicedInvoiceId` on each source record — set inside this transaction
 *      and re-filtered inside it — stops the same hour or cost being billed
 *      twice even if two runs race.
 *
 * The invoice is created DRAFT and is never advanced.
 */
export async function buildDraftInvoiceForPeriod(args: {
  ctx: AgentExecutionContext
  contract: ScopedContract
  period: BillingPeriod
  mayAct: boolean
  runLimitReached: boolean
}): Promise<BillingOutcome> {
  const { ctx, contract, period, mayAct, runLimitReached } = args
  const base = { contractId: contract.id, period, invoiceId: null, total: null, timeEntryIds: [], costIds: [], warnings: [] as string[] }

  const existing = await prisma.contractInvoice.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, contractId: contract.id },
    select: { id: true, status: true, periodStart: true, periodEnd: true },
  })
  if (periodAlreadyInvoiced(existing, period)) {
    const cover = existing.find((e) => e.status !== 'VOIDED' && e.periodStart?.getTime() === period.start.getTime())
    return { ...base, state: cover?.status === 'DRAFT' ? 'EXISTING_DRAFT_COVERS_PERIOD' : 'ALREADY_INVOICED', invoiceId: cover?.id ?? null }
  }

  const [times, costs] = await Promise.all([
    prisma.timeEntry.findMany({ where: eligibleTimeWhere(ctx.consultingFirmId, contract.id, period) }),
    prisma.contractCost.findMany({ where: eligibleCostWhere(ctx.consultingFirmId, contract.id, period) }),
  ])
  if (times.length === 0 && costs.length === 0) return { ...base, state: 'NOTHING_ELIGIBLE' }

  if (!mayAct) return { ...base, state: 'NOT_PERMITTED_AT_THIS_AUTONOMY' }
  if (runLimitReached) {
    return {
      ...base,
      state: 'RUN_LIMIT_REACHED',
      warnings: [`This run had already prepared ${MAX_INVOICES_PER_RUN} draft invoices, so ${contract.title} was left for the next run rather than flooding the reviewer.`],
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    // Re-read inside the transaction: a concurrent human invoice may have
    // claimed these records between the read above and this write.
    const [freshTimes, freshCosts] = await Promise.all([
      tx.timeEntry.findMany({ where: eligibleTimeWhere(ctx.consultingFirmId, contract.id, period) }),
      tx.contractCost.findMany({ where: eligibleCostWhere(ctx.consultingFirmId, contract.id, period) }),
    ])
    if (freshTimes.length === 0 && freshCosts.length === 0) return null

    const assembled = assembleInvoice({ consultingFirmId: ctx.consultingFirmId, times: freshTimes, costs: freshCosts })
    const count = await tx.contractInvoice.count({ where: { consultingFirmId: ctx.consultingFirmId } })

    const invoice = await tx.contractInvoice.create({
      data: {
        consultingFirmId: ctx.consultingFirmId,
        contractId: contract.id,
        invoiceNumber: nextInvoiceNumber(count),
        // DRAFT, always. The agent has no path to any other status.
        status: AGENT_INVOICE_STATUS,
        periodStart: period.start,
        periodEnd: period.end,
        invoiceDate: new Date(),
        dueDate: null,
        customerName: contract.agency,
        subtotal: assembled.subtotal,
        total: assembled.total,
        notes: `Prepared by the Finance Agent for ${period.start.toISOString().slice(0, 10)} to ${period.end.toISOString().slice(0, 10)}. DRAFT — requires human review, approval and submission.`,
        createdByUserId: null,
        lineItems: { createMany: { data: assembled.lines as unknown as Prisma.ContractInvoiceLineItemCreateManyInvoiceInput[] } },
      },
      include: { lineItems: true },
    })

    if (assembled.timeEntryIds.length) {
      await tx.timeEntry.updateMany({ where: { id: { in: assembled.timeEntryIds } }, data: { invoicedInvoiceId: invoice.id } })
    }
    if (assembled.costIds.length) {
      await tx.contractCost.updateMany({ where: { id: { in: assembled.costIds } }, data: { invoicedInvoiceId: invoice.id } })
    }
    return { invoice, assembled }
  })

  if (!created) return { ...base, state: 'NOTHING_ELIGIBLE' }

  await ctx.audit(
    'CREATE',
    'ContractInvoice',
    created.invoice.id,
    `DRAFT invoice ${created.invoice.invoiceNumber} prepared for ${billingPeriodKey(contract.id, period)}. It has not been approved or submitted.`,
  )

  return {
    contractId: contract.id,
    period,
    state: 'DRAFT_CREATED',
    invoiceId: created.invoice.id,
    total: D(created.invoice.total).toFixed(2),
    timeEntryIds: created.assembled.timeEntryIds,
    costIds: created.assembled.costIds,
    warnings: created.assembled.unbillable.map(
      (u) => `${u.recordType} ${u.recordId} contributed no billable amount: ${u.reason}`,
    ),
  }
}

// -------------------------------------------------------------
// Readiness persistence
// -------------------------------------------------------------

async function persistReadiness(ctx: AgentExecutionContext, report: ReadinessReport): Promise<number> {
  const checkedAt = new Date()
  await prisma.dcaaReadinessCheck.createMany({
    data: report.rules.map((r) => ({
      consultingFirmId: ctx.consultingFirmId,
      contractId: null,
      periodStart: new Date(report.periodStart),
      periodEnd: new Date(report.periodEnd),
      ruleKey: r.ruleKey,
      ruleVersion: r.ruleVersion,
      verdict: r.verdict,
      severity: r.severity,
      dataSufficiency: r.dataSufficiency,
      summary: r.summary,
      evidence: r.evidence,
      sourceRecordIds: r.sourceRecordIds,
      recordsChecked: r.recordsChecked,
      recordsFailing: r.recordsFailing,
      limitations: r.limitations,
      agentRunId: ctx.runId,
      checkedAt,
    })),
  })
  return report.rules.length
}

/** Digest of the readiness picture, so an unchanged sweep writes nothing new. */
function readinessFingerprint(report: ReadinessReport): string {
  return createHash('sha256')
    .update(JSON.stringify(report.rules.map((r) => `${r.ruleKey}:${r.verdict}:${r.recordsFailing}:${r.sourceRecordIds.sort().join(',')}`).sort()))
    .digest('hex')
}

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

export async function financeAgentHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  const mayAct = ctx.autonomyLevel !== 'OBSERVE'
  const triggerEventType = await resolveTriggerEventType(ctx)
  const phases = phasesForRun(ctx.triggerEntityType, triggerEventType)

  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []
  const notifications: string[] = []

  const contracts = await resolveScope(ctx)
  ctx.log('finance scope resolved', {
    contracts: contracts.length,
    triggerEntityType: ctx.triggerEntityType,
    triggerEventType,
    mayAct,
  })

  if (contracts.length === 0) {
    return {
      status: 'SKIPPED',
      summary: ctx.triggerEntityId
        ? 'The targeted contract is not billable in this firm.'
        : 'No billable contract exists for this firm.',
      confidence: 'HIGH',
      dataSufficiency: 'SUFFICIENT',
      metrics: { contractsScanned: 0, draftInvoicesCreated: 0 },
      limitations: [`Only contracts in status ${BILLABLE_CONTRACT_STATUSES.join(', ')} are assessed.`],
      inputSnapshot: { scope: ctx.triggerEntityId ?? 'TENANT', contractCount: 0 },
      inputHash: `finance:${ctx.consultingFirmId}:none:${now.toISOString().slice(0, 10)}`,
    }
  }

  const calendar = await buildWorkingCalendar(ctx.consultingFirmId, now)
  const contractIds = contracts.map((c) => c.id)

  // ---- BUILD_DRAFT_INVOICES ------------------------------------------------
  const billing: BillingOutcome[] = []
  let draftsCreated = 0
  let contractsFailed = 0

  if (phases.includes('BUILD_DRAFT_INVOICES')) {
    const period = lastClosedMonth(now)
    for (const contract of contracts) {
      if (ctx.signal.aborted) {
        limitations.push('The run was cancelled before every contract was billed.')
        break
      }
      try {
        const outcome = await buildDraftInvoiceForPeriod({
          ctx, contract, period, mayAct, runLimitReached: draftsCreated >= MAX_INVOICES_PER_RUN,
        })
        billing.push(outcome)
        if (outcome.state === 'DRAFT_CREATED') draftsCreated += 1
        warnings.push(...outcome.warnings.map((w) => `[${contract.title}] ${w}`))
      } catch (err) {
        // One malformed contract must not fail the tenant run.
        contractsFailed += 1
        const message = (err as Error).message
        warnings.push(`[${contract.title}] could not be billed: ${message}`)
        limitations.push(`[${contract.title}] was skipped because its billing records could not be read safely.`)
        logger.error('Finance billing failed for one contract (continuing)', {
          contractId: contract.id, runId: ctx.runId, error: message,
        })
      }
      await ctx.heartbeat(Math.round((billing.length / Math.max(1, contracts.length)) * 40), `billed ${billing.length}/${contracts.length}`).catch(() => undefined)
    }
  }

  // ---- AGE_RECEIVABLES / CHECK_PAYMENT_STATUS ------------------------------
  let ageing: AgeingResult = ageReceivables([], now)
  if (phases.includes('AGE_RECEIVABLES')) {
    const invoices = await prisma.contractInvoice.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, contractId: { in: contractIds } },
      select: {
        id: true, invoiceNumber: true, contractId: true, status: true,
        invoiceDate: true, dueDate: true, total: true, amountPaid: true, customerName: true,
      },
    })
    ageing = ageReceivables(invoices, now)
    limitations.push(...ageing.limitations)
    evidence.push({
      sourceType: 'ContractInvoice',
      sourceId: null,
      retrievedAt: now.toISOString(),
      note: `${ageing.receivables.length} outstanding receivable(s) totalling $${ageing.buckets.totalOutstanding}; ${ageing.excludedNonReceivable} invoice(s) excluded as not yet owed.`,
    })
  }
  await ctx.heartbeat(55, 'receivables aged').catch(() => undefined)

  // ---- BUILD_DCAA_READINESS -------------------------------------------------
  let readiness: ReadinessReport | null = null
  let readinessRowsWritten = 0
  if (phases.includes('BUILD_DCAA_READINESS')) {
    const periodStart = new Date(now.getTime() - READINESS_LOOKBACK_DAYS * DAY_MS)
    const entries = await prisma.timeEntry.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, contractId: { in: contractIds }, workDate: { gte: periodStart } },
      select: {
        id: true, userId: true, contractId: true, laborCategory: true, workDate: true,
        hours: true, status: true, submittedAt: true, approverUserId: true, createdAt: true, updatedAt: true,
      },
    })
    const auditEvents = entries.length
      ? await prisma.auditEvent.findMany({
          where: {
            consultingFirmId: ctx.consultingFirmId,
            entityType: 'TimeEntry',
            entityId: { in: entries.map((e) => e.id) },
          },
          select: { id: true, entityId: true, action: true, actorUserId: true, rationale: true, beforeJson: true, afterJson: true, createdAt: true },
        })
      : []

    readiness = buildReadinessReport({ entries, auditEvents, periodStart, periodEnd: now, now, calendar })
    limitations.push(...readiness.limitations)

    // Only persist when the picture actually changed.
    const fingerprint = readinessFingerprint(readiness)
    const previous = await prisma.dcaaReadinessCheck.findFirst({
      where: { consultingFirmId: ctx.consultingFirmId },
      orderBy: { checkedAt: 'desc' },
      select: { checkedAt: true },
    })
    const previousRules = previous
      ? await prisma.dcaaReadinessCheck.findMany({
          where: { consultingFirmId: ctx.consultingFirmId, checkedAt: previous.checkedAt },
          select: { ruleKey: true, verdict: true, recordsFailing: true, sourceRecordIds: true },
        })
      : []
    const previousFingerprint = previousRules.length
      ? createHash('sha256')
          .update(JSON.stringify(previousRules.map((r) => `${r.ruleKey}:${r.verdict}:${r.recordsFailing}:${[...r.sourceRecordIds].sort().join(',')}`).sort()))
          .digest('hex')
      : null

    if (previousFingerprint !== fingerprint) {
      readinessRowsWritten = await persistReadiness(ctx, readiness)
    }

    evidence.push({
      sourceType: 'TimeEntry',
      sourceId: null,
      retrievedAt: now.toISOString(),
      note: `${entries.length} time entr(ies) and ${auditEvents.length} audit event(s) checked against ${readiness.rulesChecked} readiness rule(s). ${READINESS_DISCLAIMER}`,
    })
  }
  await ctx.heartbeat(70, 'readiness checked').catch(() => undefined)

  // ---- rate variance --------------------------------------------------------
  let variances: RateVarianceResult[] = []
  if (phases.includes('COMPUTE_RATE_VARIANCE')) {
    const [template, actuals] = await Promise.all([
      prisma.pricingTemplate.findFirst({
        where: { consultingFirmId: ctx.consultingFirmId, isActive: true, isArchived: false },
        orderBy: [{ effectiveDate: 'desc' }, { version: 'desc' }],
        select: { id: true, name: true, indirectRatesJson: true, effectiveDate: true, version: true },
      }),
      prisma.actualIndirectRate.findMany({
        where: { consultingFirmId: ctx.consultingFirmId, status: { not: 'SUPERSEDED' } },
        orderBy: { periodStart: 'desc' },
        take: 50,
      }),
    ])
    const provisionals = provisionalRatesFromTemplate(template)
    if (actuals.length === 0) {
      limitations.push('No actual indirect rate has been recorded, so no rate variance can be computed. The agent does not derive an actual rate from a provisional one.')
    } else if (provisionals.length === 0) {
      limitations.push('No active pricing template with indirect rates exists, so there is no baseline to monitor actual rates against.')
    }
    variances = computeRateVariances({ provisionals, actuals })
    for (const v of variances) limitations.push(...v.limitations)
    if (variances.length > 0) {
      evidence.push({
        sourceType: 'ActualIndirectRate',
        sourceId: template?.id ?? null,
        retrievedAt: now.toISOString(),
        note: `${variances.length} actual rate period(s) compared against ${provisionals.length} pricing rate(s).`,
      })
    }
  }

  // ---- PROJECT_CASH_FLOW ----------------------------------------------------
  let cashFlow: CashFlowResult | null = null
  if (phases.includes('PROJECT_CASH_FLOW')) {
    cashFlow = await buildCashFlow(ctx, contractIds, now)
    limitations.push(...cashFlow.limitations)
    evidence.push({
      sourceType: 'CashFlowProjection',
      sourceId: null,
      retrievedAt: now.toISOString(),
      note: `${cashFlow.horizonMonths}-month projection: receipts $${cashFlow.projectedReceipts}, disbursements $${cashFlow.projectedDisbursements}, net $${cashFlow.netCashFlow} (${cashFlow.confidenceState}).`,
    })
    await persistCashFlow(ctx, cashFlow)
  }
  await ctx.heartbeat(85, 'cash flow projected').catch(() => undefined)

  // ---- CREATE_ESCALATIONS ---------------------------------------------------
  for (const r of ageing.severelyOverdue) {
    escalations.push({
      severity: 'HIGH',
      title: `Outstanding receivable is more than ${ESCALATION_OVERDUE_DAYS} days overdue — ${r.invoiceNumber}`,
      reason: overdueEscalationReason(r),
      recommendedAction: 'A person should follow up with the customer. The agent does not contact anyone.',
      entityType: 'ContractInvoice',
      entityId: r.invoiceId,
      dedupeHint: `receivable-overdue:${r.invoiceId}:${r.bucket}`,
    })
  }

  for (const v of variances.filter((x) => x.state === 'MATERIAL_VARIANCE')) {
    escalations.push({
      severity: 'MEDIUM',
      title: `Indirect rate variance beyond ${VARIANCE_MATERIAL_PCT}% — ${v.rateType}`,
      reason: varianceEscalationReason(v),
      recommendedAction: 'Review the actual rate and the pricing assumption. The agent changes neither.',
      entityType: 'ActualIndirectRate',
      entityId: v.actualRateId,
      dedupeHint: v.dedupeKey,
    })
  }

  for (const rule of readiness?.criticalFailures ?? []) {
    escalations.push({
      severity: 'HIGH',
      title: `Timekeeping readiness — critical gap: ${rule.title}`,
      reason: criticalEscalationReason(rule),
      recommendedAction: 'A person should correct the underlying time records. The agent does not edit time.',
      entityType: 'TimeEntry',
      entityId: rule.sourceRecordIds[0] ?? null,
      dedupeHint: `readiness-critical:${rule.ruleKey}:${rule.sourceRecordIds.slice(0, 5).sort().join(',')}`,
    })
  }

  if (cashFlow && cashFlow.netCashFlowLabel === NEGATIVE_NET_FLOW_STATE && cashFlow.dataSufficiency !== 'INSUFFICIENT_DATA') {
    escalations.push({
      severity: 'MEDIUM',
      // Deliberately NOT "negative cash position" — see cashFlowProjection.
      title: `Projected negative net cash flow over ${cashFlow.horizonMonths} months`,
      reason: negativeNetFlowReason(cashFlow),
      recommendedAction: 'Review billing timing and upcoming costs. This is a net-flow projection, not a statement about the firm’s cash balance.',
      entityType: 'CashFlowProjection',
      entityId: null,
      dedupeHint: `cashflow-negative:${cashFlow.inputHash}`,
    })
  }

  // ---- CREATE_NOTIFICATIONS -------------------------------------------------
  if (phases.includes('CREATE_NOTIFICATIONS') && mayAct) {
    const recipients = await prisma.user.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, role: 'ADMIN', isActive: true },
      select: { id: true },
      take: 10,
    })
    for (const { id: userId } of recipients) {
      if (draftsCreated > 0) {
        await notifyUser({
          consultingFirmId: ctx.consultingFirmId,
          userId,
          type: 'FINANCE_ALERT',
          title: `${draftsCreated} draft invoice(s) are ready for your review`,
          body: 'Prepared by the Finance Agent. Each is a DRAFT and must be reviewed, approved and submitted by a person.',
          linkPath: '/receivables',
          entityType: 'ContractInvoice',
          dedupeKey: `finance-drafts:${ctx.consultingFirmId}:${ctx.runId}`,
        })
        notifications.push(`${draftsCreated} draft invoice(s) ready for review`)
      }
      for (const r of ageing.receivables.filter((x) => x.bucket !== 'CURRENT')) {
        await notifyUser({
          consultingFirmId: ctx.consultingFirmId,
          userId,
          type: 'FINANCE_ALERT',
          title: `Invoice ${r.invoiceNumber} is now ${r.bucketLabel} overdue`,
          body: `$${r.outstanding} outstanding. Internal follow-up prompt only — the agent does not contact the customer.`,
          linkPath: '/receivables',
          entityType: 'ContractInvoice',
          entityId: r.invoiceId,
          // Bucket + outstanding: an unchanged balance never re-notifies, but a
          // partial payment is a new fact worth surfacing once.
          dedupeKey: `${r.dedupeKey}:${userId}`,
        })
        notifications.push(`Invoice ${r.invoiceNumber} entered ${r.bucketLabel}`)
      }
      for (const v of variances.filter((x) => x.state === 'MATERIAL_VARIANCE' || x.state === 'REVIEW_RECOMMENDED')) {
        await notifyUser({
          consultingFirmId: ctx.consultingFirmId,
          userId,
          type: 'FINANCE_ALERT',
          title: `Indirect rate variance — ${v.rateType} ${v.relativeVariancePct}%`,
          body: `Actual ${v.actualRate}% against pricing ${v.provisionalRate}%. Monitoring only; no rate was changed.`,
          linkPath: '/analytics',
          entityType: 'ActualIndirectRate',
          entityId: v.actualRateId ?? undefined,
          dedupeKey: `${v.dedupeKey}:${userId}`,
        })
        notifications.push(`Rate variance on ${v.rateType}`)
      }
      for (const rule of readiness?.criticalFailures ?? []) {
        await notifyUser({
          consultingFirmId: ctx.consultingFirmId,
          userId,
          type: 'FINANCE_ALERT',
          title: `Timekeeping readiness gap — ${rule.title}`,
          body: `${rule.summary} ${READINESS_DISCLAIMER}`,
          linkPath: '/timekeeping',
          entityType: 'TimeEntry',
          entityId: rule.sourceRecordIds[0] ?? undefined,
          dedupeKey: `readiness-critical:${ctx.consultingFirmId}:${rule.ruleKey}:${rule.sourceRecordIds.slice(0, 5).sort().join(',')}:${userId}`,
        })
        notifications.push(`Critical readiness gap: ${rule.ruleKey}`)
      }
    }
  }

  // ---- BUILD_FINANCE_STATUS -------------------------------------------------
  const draftsReadyForReview = await prisma.contractInvoice.count({
    where: { consultingFirmId: ctx.consultingFirmId, contractId: { in: contractIds }, status: 'DRAFT' },
  })

  const status: FinanceStatusArtifact = {
    generatedAt: now.toISOString(),
    methodVersion: FINANCE_METHOD_VERSION,
    scope: { contractsAssessed: contracts.length, contractIds },
    invoices: {
      draftsReadyForReview,
      createdThisRun: draftsCreated,
      billingPeriods: billing.map((b) => ({
        contractId: b.contractId,
        periodStart: b.period.start.toISOString(),
        periodEnd: b.period.end.toISOString(),
        state: b.state,
        invoiceId: b.invoiceId,
        total: b.total,
      })),
      warnings: billing.flatMap((b) => b.warnings),
    },
    receivables: {
      totalOutstanding: ageing.buckets.totalOutstanding,
      current: ageing.buckets.current,
      days1to30: ageing.buckets.days1to30,
      days31to60: ageing.buckets.days31to60,
      days61to90: ageing.buckets.days61to90,
      days91to120: ageing.buckets.days91to120,
      days120Plus: ageing.buckets.days120Plus,
      overdueInvoices: ageing.receivables.filter((r) => r.bucket !== 'CURRENT'),
      invoicesWithoutDueDate: ageing.invoicesWithoutDueDate,
    },
    timekeeping: {
      readinessState: readiness?.readinessState ?? 'INSUFFICIENT_DATA',
      readinessScore: readiness?.readinessScore ?? null,
      rulesChecked: readiness?.rulesChecked ?? 0,
      scorableRules: readiness?.scorableRules ?? 0,
      criticalFailures: readiness?.criticalFailures.length ?? 0,
      failing: readiness?.failing ?? 0,
      warnings: readiness?.warnings ?? 0,
      unsupportedRules: readiness?.unsupportedRules ?? 0,
      insufficientDataRules: readiness?.insufficientDataRules ?? 0,
      disclaimer: READINESS_DISCLAIMER,
      rules: readiness?.rules ?? [],
    },
    indirectRates: {
      periods: variances.length,
      variances,
      reviewRequired: variances.filter((v) => v.state === 'MATERIAL_VARIANCE' || v.state === 'REVIEW_RECOMMENDED').length,
    },
    cashFlow,
    notifications,
    escalations: escalations.map((e) => e.title),
    humanControl: {
      invoicesApproved: 0,
      invoicesSubmitted: 0,
      invoicesMarkedPaid: 0,
      paymentsRecorded: 0,
      receivablesWrittenOff: 0,
      timeEntriesModified: 0,
      ratesModified: 0,
      externalSubmissions: 0,
    },
    warnings,
    dataLimitations: limitations,
    inputHash: '',
  }
  status.inputHash = buildStatusHash(status)

  const artifact: ProposedArtifact = {
    artifactType: 'FINANCE_STATUS',
    title: `Finance status — ${contracts.length} contract(s)`,
    summary:
      `$${ageing.buckets.totalOutstanding} outstanding across ${ageing.receivables.length} receivable(s)` +
      (draftsCreated > 0 ? ` · ${draftsCreated} draft invoice(s) prepared` : '') +
      (readiness ? ` · readiness ${readiness.readinessState}` : ''),
    structuredData: status as unknown as Record<string, unknown>,
    evidence,
    sourceEntityType: 'ConsultingFirm',
    sourceEntityId: ctx.consultingFirmId,
    confidenceState: limitations.length > 3 ? 'MEDIUM' : 'HIGH',
    supersedeKey: `finance-status:${ctx.consultingFirmId}`,
  }

  const summaryParts = [
    `Assessed ${contracts.length} contract(s).`,
    `$${ageing.buckets.totalOutstanding} outstanding across ${ageing.receivables.length} receivable(s).`,
  ]
  if (draftsCreated > 0) summaryParts.push(`${draftsCreated} DRAFT invoice(s) prepared for human review.`)
  if (readiness) summaryParts.push(`Timekeeping readiness ${readiness.readinessState}${readiness.readinessScore !== null ? ` (${readiness.readinessScore}% of scorable rules)` : ''}.`)
  if (variances.length > 0) summaryParts.push(`${variances.length} indirect rate period(s) compared.`)
  if (contractsFailed > 0) summaryParts.push(`${contractsFailed} contract(s) could not be assessed.`)
  summaryParts.push('No invoice was approved, submitted or marked paid, and no time entry or rate was changed.')

  return {
    status: 'COMPLETED',
    summary: summaryParts.join(' '),
    confidence: contractsFailed > 0 ? 'MEDIUM' : 'HIGH',
    dataSufficiency: contractsFailed > 0 || limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
    evidence,
    artifacts: [artifact],
    escalations,
    metrics: {
      contractsScanned: contracts.length,
      contractsFailed,
      draftInvoicesCreated: draftsCreated,
      draftsAwaitingReview: draftsReadyForReview,
      outstandingReceivables: ageing.receivables.length,
      severelyOverdue: ageing.severelyOverdue.length,
      readinessRulesChecked: readiness?.rulesChecked ?? 0,
      readinessRowsWritten,
      criticalReadinessFailures: readiness?.criticalFailures.length ?? 0,
      rateVariances: variances.length,
      materialRateVariances: variances.filter((v) => v.state === 'MATERIAL_VARIANCE').length,
      notificationsSent: notifications.length,
      escalationsRaised: escalations.length,
      // Explicit zeros: the §4-equivalent human-control guarantees, as numbers.
      invoicesApproved: 0,
      invoicesSubmitted: 0,
      invoicesMarkedPaid: 0,
      paymentsRecorded: 0,
      timeEntriesModified: 0,
      ratesModified: 0,
      externalSubmissions: 0,
    },
    warnings,
    limitations,
    inputSnapshot: { scope: ctx.triggerEntityId ?? 'TENANT', contractCount: contracts.length },
    inputHash: status.inputHash,
  }
}

// -------------------------------------------------------------
// Cash flow assembly
// -------------------------------------------------------------

async function buildCashFlow(ctx: AgentExecutionContext, contractIds: string[], now: Date): Promise<CashFlowResult> {
  const [outstanding, settled, unbilledTime, unbilledCosts, knownCosts] = await Promise.all([
    prisma.contractInvoice.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, contractId: { in: contractIds }, status: { in: ['SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE'] } },
      select: { id: true, invoiceNumber: true, total: true, amountPaid: true, dueDate: true, invoiceDate: true, status: true },
    }),
    prisma.contractInvoice.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, status: 'PAID', paidAt: { not: null }, dueDate: { not: null } },
      select: { dueDate: true, paidAt: true },
      take: 200,
    }),
    prisma.timeEntry.groupBy({
      by: ['contractId'],
      where: { consultingFirmId: ctx.consultingFirmId, contractId: { in: contractIds }, status: 'APPROVED', invoicedInvoiceId: null },
      _sum: { billingAmount: true },
    }),
    prisma.contractCost.groupBy({
      by: ['contractId'],
      where: { consultingFirmId: ctx.consultingFirmId, contractId: { in: contractIds }, status: 'APPROVED', invoicedInvoiceId: null },
      _sum: { amount: true },
    }),
    prisma.contractCost.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, contractId: { in: contractIds }, status: 'APPROVED' },
      select: { id: true, amount: true, incurredDate: true, category: true },
      take: 500,
    }),
  ])

  // Observed lag between due date and payment. Real history, not an assumption.
  const historicalPaymentLagDays = settled
    .filter((s) => s.dueDate && s.paidAt)
    .map((s) => Math.round((s.paidAt!.getTime() - s.dueDate!.getTime()) / DAY_MS))

  const unbilledByContract = new Map<string, Prisma.Decimal>()
  for (const t of unbilledTime) {
    unbilledByContract.set(t.contractId, D(t._sum.billingAmount ?? 0))
  }
  for (const c of unbilledCosts) {
    unbilledByContract.set(c.contractId, (unbilledByContract.get(c.contractId) ?? D(0)).plus(D(c._sum.amount ?? 0)))
  }

  // Pipeline is fetched separately and stays separately labelled. It is
  // probability-weighted value from UNAWARDED opportunities and never enters
  // the contracted receipts total.
  let pipelineByMonth: Array<{ month: string; expectedValue: number }> = []
  try {
    const forecast = await forecastRevenue(ctx.consultingFirmId, DEFAULT_HORIZON_MONTHS)
    pipelineByMonth = forecast.map((f) => ({
      month: (f as unknown as { month: string }).month,
      expectedValue: Number((f as unknown as { expectedRevenue?: number; expected?: number }).expectedRevenue ?? (f as unknown as { expected?: number }).expected ?? 0),
    }))
  } catch (err) {
    logger.warn('Pipeline forecast unavailable for cash flow (continuing with contracted only)', {
      runId: ctx.runId, error: (err as Error).message,
    })
  }

  return projectCashFlow({
    outstandingInvoices: outstanding,
    unbilledApproved: [...unbilledByContract.entries()].map(([contractId, amount]) => ({ contractId, amount })),
    knownCosts,
    historicalPaymentLagDays,
    pipelineByMonth,
    now,
    horizonMonths: DEFAULT_HORIZON_MONTHS,
  })
}

/** Persist only when the normalised inputs actually changed. */
async function persistCashFlow(ctx: AgentExecutionContext, result: CashFlowResult): Promise<void> {
  const existing = await prisma.cashFlowProjection.findFirst({
    where: { consultingFirmId: ctx.consultingFirmId, inputHash: result.inputHash },
    select: { id: true },
  })
  if (existing) return

  const previous = await prisma.cashFlowProjection.findFirst({
    where: { consultingFirmId: ctx.consultingFirmId },
    orderBy: { computedAt: 'desc' },
    select: { id: true },
  })

  await prisma.cashFlowProjection.create({
    data: {
      consultingFirmId: ctx.consultingFirmId,
      periodStart: new Date(result.periodStart),
      periodEnd: new Date(result.periodEnd),
      horizonMonths: result.horizonMonths,
      methodVersion: result.methodVersion,
      inputHash: result.inputHash,
      projectedReceipts: new Prisma.Decimal(result.projectedReceipts),
      projectedDisbursements: new Prisma.Decimal(result.projectedDisbursements),
      netCashFlow: new Prisma.Decimal(result.netCashFlow),
      confidenceLower: result.confidenceLower ? new Prisma.Decimal(result.confidenceLower) : null,
      confidenceUpper: result.confidenceUpper ? new Prisma.Decimal(result.confidenceUpper) : null,
      confidenceState: result.confidenceState,
      sourceBreakdown: result.sourceBreakdown as unknown as Prisma.InputJsonObject,
      dataSufficiency: result.dataSufficiency,
      limitations: result.limitations,
      agentRunId: ctx.runId,
      supersedesId: previous?.id ?? null,
    },
  })
}

// -------------------------------------------------------------
// Trigger resolution
// -------------------------------------------------------------

/** Which event type produced this run, if any. Drives phase selection. */
async function resolveTriggerEventType(ctx: AgentExecutionContext): Promise<string | null> {
  if (!ctx.eventId) return null
  const event = await prisma.agentEvent.findFirst({
    where: { id: ctx.eventId, consultingFirmId: ctx.consultingFirmId },
    select: { eventType: true },
  })
  return event?.eventType ?? null
}

// -------------------------------------------------------------
// Idempotency
// -------------------------------------------------------------

function buildStatusHash(status: FinanceStatusArtifact): string {
  const material = {
    contracts: [...status.scope.contractIds].sort(),
    receivables: `${status.receivables.totalOutstanding}:${status.receivables.overdueInvoices.map((r) => `${r.invoiceId}:${r.bucket}:${r.outstanding}`).sort().join('|')}`,
    drafts: status.invoices.draftsReadyForReview,
    readiness: `${status.timekeeping.readinessState}:${status.timekeeping.readinessScore ?? 'null'}:${status.timekeeping.criticalFailures}`,
    rates: status.indirectRates.variances.map((v) => `${v.rateType}:${v.state}:${v.absoluteVariance ?? 'null'}`).sort(),
    cashFlow: status.cashFlow?.inputHash ?? 'none',
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export { READINESS_DISCLAIMER, NEGATIVE_NET_FLOW_STATE }
