// =============================================================
// §7.8 — Finance Agent API client.
//
// Every figure here is COMPUTED BY THE BACKEND with Decimal arithmetic and
// arrives as a string. The frontend formats; it never calculates. A money value
// is never passed through `Number()` before display, because that is exactly
// how a cent goes missing from an invoice.
//
// There is deliberately no approve, submit, pay, write-off or transmit method:
// the agent has no such endpoint, and neither does this client.
// =============================================================
import { api } from './api'

export type ReadinessVerdict = 'PASS' | 'FAIL' | 'WARNING' | 'MANUAL_REVIEW' | 'INSUFFICIENT_DATA' | 'UNSUPPORTED'
export type ReadinessSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'
export type ReadinessState = 'CRITICAL_GAP' | 'GAPS_PRESENT' | 'REVIEW_REQUIRED' | 'NO_GAPS_DETECTED' | 'INSUFFICIENT_DATA'
export type AgingBucket = 'CURRENT' | 'D1_30' | 'D31_60' | 'D61_90' | 'D91_120' | 'D120_PLUS'
export type VarianceState = 'WITHIN_MONITORING_RANGE' | 'REVIEW_RECOMMENDED' | 'MATERIAL_VARIANCE' | 'INSUFFICIENT_DATA'
export type CashFlowConfidence = 'BANDED' | 'DETERMINISTIC_ONLY' | 'INSUFFICIENT_DATA'
export type CashFlowSourceClass =
  | 'CONTRACTED_RECEIVABLE' | 'CONTRACTED_EXPECTED_BILLING' | 'KNOWN_COST' | 'PIPELINE_EXPECTED_VALUE'

export interface AgedReceivable {
  invoiceId: string
  invoiceNumber: string
  contractId: string
  status: string
  customerName: string | null
  dueDate: string | null
  overdueDays: number
  bucket: AgingBucket
  bucketLabel: string
  total: string
  amountPaid: string
  outstanding: string
  dueDateUnknown: boolean
  dedupeKey: string
}

export interface ReadinessRule {
  ruleKey: string
  ruleVersion: string
  title: string
  verdict: ReadinessVerdict
  severity: ReadinessSeverity
  dataSufficiency: string
  summary: string
  evidence: string[]
  sourceRecordIds: string[]
  recordsChecked: number
  recordsFailing: number
  limitations: string[]
}

export interface RateVariance {
  rateType: string
  poolName: string | null
  period: { start: string; end: string; fiscalYear: number }
  provisionalRate: string | null
  actualRate: string | null
  absoluteVariance: string | null
  relativeVariancePct: number | null
  state: VarianceState
  provisionalSource: string
  /** Says the provisional side is a pricing rate, not a negotiated billing rate. */
  semanticMapping: 'PROPOSAL_PRICING_TO_ACTUAL' | 'UNMAPPED'
  actualRateId: string | null
  actualIsHumanVerified: boolean
  evidence: string[]
  limitations: string[]
}

export interface CashFlow {
  methodVersion: string
  periodStart: string
  periodEnd: string
  horizonMonths: number
  projectedReceipts: string
  projectedDisbursements: string
  netCashFlow: string
  /** PROJECTED_NEGATIVE_NET_CASH_FLOW — never a "cash position". */
  netCashFlowLabel: string
  confidenceLower: string | null
  confidenceUpper: string | null
  confidenceState: CashFlowConfidence
  sourceBreakdown: Record<CashFlowSourceClass, { receipts: string; disbursements: string; count: number }>
  lines: Array<{
    sourceClass: CashFlowSourceClass
    direction: 'RECEIPT' | 'DISBURSEMENT'
    amount: string
    expectedDate: string
    reference: string
    sourceId: string | null
    dateIsRecorded: boolean
  }>
  paymentTiming: { sampleSize: number; medianLagDays: number | null; modelled: boolean; detail: string }
  openingCashBalanceAvailable: false
  dataSufficiency: string
  inputHash: string
  limitations: string[]
}

export interface FinanceStatus {
  artifactId: string
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
    overdueInvoices: AgedReceivable[]
    invoicesWithoutDueDate: number
  }
  timekeeping: {
    readinessState: ReadinessState
    readinessScore: number | null
    rulesChecked: number
    scorableRules: number
    criticalFailures: number
    failing: number
    warnings: number
    unsupportedRules: number
    insufficientDataRules: number
    disclaimer: string
    rules: ReadinessRule[]
  }
  indirectRates: { periods: number; variances: RateVariance[]; reviewRequired: number }
  cashFlow: CashFlow | null
  notifications: string[]
  escalations: string[]
  humanControl: Record<string, number>
  warnings: string[]
  dataLimitations: string[]
  inputHash: string
}

export interface FinancePolicy {
  policyVersion: string
  escalationOverdueDays: number
  varianceReviewPct: number
  varianceMaterialPct: number
  submissionTimelinessWorkingDays: number
  readinessLookbackDays: number
  criticalRuleKeys: string[]
  cashFlowHorizonMonths: number
  minPaymentsForTiming: number
  minPaymentsForBands: number
  maxInvoicesPerRun: number
  receivableStatuses: string[]
  nonReceivableStatuses: string[]
  readinessDisclaimer: string
  rateSemanticNote: string
  noOpeningBalanceNote: string
  notes: string[]
}

export interface FinanceAgentView {
  agentKey: 'FINANCE'
  schedule: {
    isEnabled: boolean
    cronExpression: string | null
    nextRunAt: string | null
    lastRunAt: string | null
    lastSuccessfulRunAt: string | null
    lastFailureAt: string | null
    lastFailureMessage: string | null
    autonomyLevel: string
  } | null
  lastRun: {
    id: string
    status: string
    triggerType: string
    createdAt: string
    finishedAt: string | null
    outputSummary: string | null
    warnings: string[]
    limitations: string[]
    tokenInput: number
    tokenOutput: number
    estimatedCostUsd: string
  } | null
  /** null = the agent has not assessed this firm yet. */
  status: FinanceStatus | null
  escalations: Array<{
    id: string
    severity: string
    status: string
    title: string
    reason: string
    recommendedAction: string | null
    entityType: string | null
    entityId: string | null
    createdAt: string
  }>
  policy: FinancePolicy
}

export interface ReadinessCheckRow {
  id: string
  ruleKey: string
  ruleVersion: string
  verdict: ReadinessVerdict
  severity: ReadinessSeverity
  dataSufficiency: string
  summary: string
  evidence: string[]
  sourceRecordIds: string[]
  recordsChecked: number
  recordsFailing: number
  limitations: string[]
  periodStart: string | null
  periodEnd: string | null
  checkedAt: string
  agentRunId: string | null
}

export interface CashFlowProjectionRow {
  id: string
  periodStart: string
  periodEnd: string
  horizonMonths: number
  methodVersion: string
  projectedReceipts: string
  projectedDisbursements: string
  netCashFlow: string
  confidenceLower: string | null
  confidenceUpper: string | null
  confidenceState: CashFlowConfidence
  sourceBreakdown: Record<string, { receipts: string; disbursements: string; count: number }>
  dataSufficiency: string
  limitations: string[]
  computedAt: string
}

export interface ActualRateRow {
  id: string
  periodStart: string
  periodEnd: string
  fiscalYear: number
  rateType: string
  poolName: string | null
  actualRate: string
  source: string
  sourceReference: string | null
  status: string
  isHumanVerified: boolean
  verifiedByUserId: string | null
  verifiedAt: string | null
  notes: string | null
}

async function get<T>(url: string): Promise<T> {
  const res = await api.get(url)
  return res.data.data as T
}

export const financeAgentApi = {
  status: () => get<FinanceAgentView>('/agents/finance/status'),
  readiness: () =>
    get<{ checkedAt: string | null; ruleVersion: string; disclaimer: string; criticalRuleKeys: string[]; checks: ReadinessCheckRow[]; policy: FinancePolicy }>(
      '/agents/finance/readiness',
    ),
  cashFlow: () =>
    get<{ methodVersion: string; openingCashBalanceAvailable: false; noOpeningBalanceNote: string; projections: CashFlowProjectionRow[]; policy: FinancePolicy }>(
      '/agents/finance/cash-flow',
    ),
  actualRates: () => get<{ rates: ActualRateRow[]; policy: FinancePolicy }>('/agents/finance/actual-rates'),
  /** ADMIN. Recording source data a person is responsible for. */
  recordActualRate: async (body: Record<string, unknown>) => {
    const res = await api.post('/agents/finance/actual-rates', body)
    return res.data.data as { rate: ActualRateRow }
  },
  verifyActualRate: async (id: string) => {
    const res = await api.post(`/agents/finance/actual-rates/${id}/verify`, {})
    return res.data.data as { rate: ActualRateRow }
  },
}

/**
 * Format a backend Decimal string for display.
 *
 * Deliberately string-first: the value arrives correct to the cent and is
 * grouped for readability without ever being reconstructed by float maths.
 */
export function formatMoney(value: string | null | undefined): string {
  if (value == null) return '—'
  const negative = value.trim().startsWith('-')
  const [whole, fraction = '00'] = value.replace('-', '').split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${grouped}.${fraction.padEnd(2, '0').slice(0, 2)}`
}
