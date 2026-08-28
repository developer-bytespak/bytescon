// =============================================================
// §7.8 — Finance Agent panels.
//
// Pins the claims the UI is allowed and not allowed to make: readiness is never
// DCAA compliance or a predicted audit outcome, an unsupported rule reads as
// excluded rather than passing, a critical failure survives a high score, cash
// flow is NET FLOW rather than a cash position, pipeline value is visibly
// separated from contracted receipts, and no control moves money.
// =============================================================
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const readinessFn = vi.fn()
const cashFlowFn = vi.fn()
const statusFn = vi.fn()
vi.mock('../../services/financeAgentApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/financeAgentApi')>()
  return {
    ...actual,
    financeAgentApi: {
      readiness: () => readinessFn(),
      cashFlow: () => cashFlowFn(),
      status: () => statusFn(),
    },
  }
})

import { DcaaReadinessPanel, CashFlowPanel, RateVariancePanel } from './FinanceAgentPanels'
import { formatMoney } from '../../services/financeAgentApi'

const POLICY = {
  policyVersion: 'bytescon-readiness-v1',
  escalationOverdueDays: 90,
  varianceReviewPct: 5,
  varianceMaterialPct: 15,
  submissionTimelinessWorkingDays: 5,
  readinessLookbackDays: 45,
  criticalRuleKeys: ['NO_FUTURE_DATED_TIME', 'ADJUSTMENT_REASON_RECORDED'],
  cashFlowHorizonMonths: 6,
  minPaymentsForTiming: 6,
  minPaymentsForBands: 10,
  maxInvoicesPerRun: 10,
  receivableStatuses: ['SUBMITTED', 'PARTIALLY_PAID', 'OVERDUE'],
  nonReceivableStatuses: ['DRAFT', 'READY_FOR_REVIEW', 'APPROVED', 'PAID', 'VOIDED'],
  readinessDisclaimer: 'Bytescon readiness indicator. This is a product checklist over your own timekeeping records — it is not a DCAA audit, certification or approval, and it does not predict an audit outcome.',
  rateSemanticNote: 'The provisional side of this comparison is the firm’s pricing rate set, not a provisional billing rate negotiated with a contracting officer — the platform does not model one.',
  noOpeningBalanceNote: 'The platform records no opening cash balance, so this is a projection of NET CASH FLOW, not a cash position.',
  notes: ['Every invoice the agent creates is a DRAFT.'],
}

const check = (over: Record<string, unknown> = {}) => ({
  id: 'chk-1', ruleKey: 'NO_FUTURE_DATED_TIME', ruleVersion: 'bytescon-readiness-v1',
  verdict: 'PASS', severity: 'CRITICAL', dataSufficiency: 'SUFFICIENT',
  summary: 'None of the 5 entries are dated in the future.',
  evidence: [], sourceRecordIds: [], recordsChecked: 5, recordsFailing: 0, limitations: [],
  periodStart: '2026-07-01T00:00:00.000Z', periodEnd: '2026-08-12T00:00:00.000Z',
  checkedAt: '2026-08-12T08:00:00.000Z', agentRunId: 'run-abcd1234',
  ...over,
})

const readiness = (over: Record<string, unknown> = {}) => ({
  checkedAt: '2026-08-12T08:00:00.000Z',
  ruleVersion: 'bytescon-readiness-v1',
  disclaimer: POLICY.readinessDisclaimer,
  criticalRuleKeys: POLICY.criticalRuleKeys,
  checks: [check()],
  policy: POLICY,
  ...over,
})

const timekeeping = (over: Record<string, unknown> = {}) => ({
  readinessState: 'NO_GAPS_DETECTED', readinessScore: 100, rulesChecked: 7, scorableRules: 5,
  criticalFailures: 0, failing: 0, warnings: 0, unsupportedRules: 1, insufficientDataRules: 1,
  disclaimer: POLICY.readinessDisclaimer, rules: [],
  ...over,
})

const variance = (over: Record<string, unknown> = {}) => ({
  rateType: 'FRINGE', poolName: 'Fringe',
  period: { start: '2026-01-01T00:00:00.000Z', end: '2026-06-30T00:00:00.000Z', fiscalYear: 2026 },
  provisionalRate: '30.0000', actualRate: '36.0000', absoluteVariance: '6.0000', relativeVariancePct: 20,
  state: 'MATERIAL_VARIANCE', provisionalSource: 'PRICING_TEMPLATE', semanticMapping: 'PROPOSAL_PRICING_TO_ACTUAL',
  actualRateId: 'a1', actualIsHumanVerified: true, evidence: [], limitations: [],
  ...over,
})

const agentStatus = (over: Record<string, unknown> = {}) => ({
  agentKey: 'FINANCE',
  schedule: { isEnabled: true, cronExpression: '0 8 * * *', nextRunAt: null, lastRunAt: null, lastSuccessfulRunAt: null, lastFailureAt: null, lastFailureMessage: null, autonomyLevel: 'PROPOSE' },
  lastRun: null,
  status: {
    artifactId: 'art-1', generatedAt: '2026-08-12T08:00:00.000Z', methodVersion: 'finance-v1',
    scope: { contractsAssessed: 1, contractIds: ['c1'] },
    invoices: { draftsReadyForReview: 2, createdThisRun: 1, billingPeriods: [], warnings: [] },
    receivables: { totalOutstanding: '0.00', current: '0.00', days1to30: '0.00', days31to60: '0.00', days61to90: '0.00', days91to120: '0.00', days120Plus: '0.00', overdueInvoices: [], invoicesWithoutDueDate: 0 },
    timekeeping: timekeeping(),
    indirectRates: { periods: 1, variances: [variance()], reviewRequired: 1 },
    cashFlow: null,
    notifications: [], escalations: [], humanControl: {}, warnings: [], dataLimitations: [], inputHash: 'h',
  },
  escalations: [],
  policy: POLICY,
  ...over,
})

const projection = (over: Record<string, unknown> = {}) => ({
  id: 'p1', periodStart: '2026-08-12T00:00:00.000Z', periodEnd: '2027-02-12T00:00:00.000Z',
  horizonMonths: 6, methodVersion: 'finance-cashflow-v1',
  projectedReceipts: '125000.50', projectedDisbursements: '40000.25', netCashFlow: '85000.25',
  confidenceLower: null, confidenceUpper: null, confidenceState: 'DETERMINISTIC_ONLY',
  sourceBreakdown: {
    CONTRACTED_RECEIVABLE: { receipts: '100000.50', disbursements: '0.00', count: 3 },
    CONTRACTED_EXPECTED_BILLING: { receipts: '25000.00', disbursements: '0.00', count: 1 },
    KNOWN_COST: { receipts: '0.00', disbursements: '40000.25', count: 2 },
    PIPELINE_EXPECTED_VALUE: { receipts: '900000.00', disbursements: '0.00', count: 6 },
  },
  dataSufficiency: 'PARTIAL',
  limitations: ['Pipeline expected value of $900000.00 is shown separately and is EXCLUDED from projected receipts and net cash flow.'],
  computedAt: '2026-08-12T08:00:00.000Z',
  ...over,
})

const cashFlow = (over: Record<string, unknown> = {}) => ({
  methodVersion: 'finance-cashflow-v1',
  openingCashBalanceAvailable: false as const,
  noOpeningBalanceNote: POLICY.noOpeningBalanceNote,
  projections: [projection()],
  policy: POLICY,
  ...over,
})

beforeEach(() => {
  readinessFn.mockReset()
  cashFlowFn.mockReset()
  statusFn.mockReset()
})

// =============================================================
// Money formatting — the frontend formats, never calculates
// =============================================================

describe('formatMoney', () => {
  it('formats a Decimal string without float reconstruction', () => {
    expect(formatMoney('1234.56')).toBe('$1,234.56')
    expect(formatMoney('0.01')).toBe('$0.01')
    expect(formatMoney('99999999.99')).toBe('$99,999,999.99')
    expect(formatMoney('-5000.00')).toBe('-$5,000.00')
  })

  it('keeps a cent that float arithmetic would lose', () => {
    expect(formatMoney('100000000.01')).toBe('$100,000,000.01')
  })

  it('renders a missing value as a dash, never as zero', () => {
    expect(formatMoney(null)).toBe('—')
    expect(formatMoney(undefined)).toBe('—')
  })
})

// =============================================================
// Readiness panel
// =============================================================

describe('DcaaReadinessPanel', () => {
  it('shows the non-certification disclaimer', async () => {
    readinessFn.mockResolvedValue(readiness())
    statusFn.mockResolvedValue(agentStatus())
    render(<DcaaReadinessPanel />)
    const d = await screen.findByTestId('readiness-disclaimer')
    expect(d).toHaveTextContent('not a DCAA audit, certification or approval')
    expect(d).toHaveTextContent('does not predict an audit outcome')
  })

  it('never claims DCAA compliance, certification or a passed audit', async () => {
    readinessFn.mockResolvedValue(readiness())
    statusFn.mockResolvedValue(agentStatus())
    const { container } = render(<DcaaReadinessPanel />)
    await screen.findByTestId('readiness-state')
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/DCAA[- ](compliant|approved|certified)/i)
    expect(text).not.toMatch(/will pass (an )?audit|audit[- ]approved/i)
  })

  it('says the agent has not run rather than showing an empty checklist', async () => {
    readinessFn.mockResolvedValue(readiness({ checks: [], checkedAt: null }))
    statusFn.mockResolvedValue(agentStatus({ status: null }))
    render(<DcaaReadinessPanel />)
    expect(await screen.findByText(/has not run a readiness check yet/i)).toBeInTheDocument()
  })

  it('marks an unsupported rule as excluded, not as a pass', async () => {
    readinessFn.mockResolvedValue(readiness({
      checks: [check({ ruleKey: 'DIRECT_INDIRECT_SEGREGATION', verdict: 'UNSUPPORTED', severity: 'MEDIUM', summary: 'This check is not supported by the current data model.' })],
    }))
    statusFn.mockResolvedValue(agentStatus())
    render(<DcaaReadinessPanel />)
    const row = await screen.findByTestId('readiness-rule-DIRECT_INDIRECT_SEGREGATION')
    expect(within(row).getByText('EXCLUDED')).toBeInTheDocument()
    expect(within(row).queryByText('Pass')).toBeNull()
  })

  it('marks an insufficient-data rule as excluded too', async () => {
    readinessFn.mockResolvedValue(readiness({ checks: [check({ ruleKey: 'TIMELY_SUBMISSION', verdict: 'INSUFFICIENT_DATA', severity: 'MEDIUM' })] }))
    statusFn.mockResolvedValue(agentStatus())
    render(<DcaaReadinessPanel />)
    expect(within(await screen.findByTestId('readiness-rule-TIMELY_SUBMISSION')).getByText('EXCLUDED')).toBeInTheDocument()
  })

  it('states how many rules are excluded from the score', async () => {
    readinessFn.mockResolvedValue(readiness())
    statusFn.mockResolvedValue(agentStatus())
    render(<DcaaReadinessPanel />)
    expect(await screen.findByTestId('readiness-excluded')).toHaveTextContent('not counted as passing')
  })

  it('shows a critical failure even when the score is high', async () => {
    readinessFn.mockResolvedValue(readiness({
      checks: [check({ verdict: 'FAIL', summary: '1 time entry is dated in the future.', recordsFailing: 1, sourceRecordIds: ['e9'] })],
    }))
    statusFn.mockResolvedValue(agentStatus({
      status: { ...agentStatus().status, timekeeping: timekeeping({ readinessState: 'CRITICAL_GAP', readinessScore: 80, criticalFailures: 1, failing: 1 }) },
    }))
    render(<DcaaReadinessPanel />)
    expect(await screen.findByTestId('readiness-state')).toHaveTextContent('CRITICAL GAP')
    expect(screen.getByTestId('readiness-critical')).toHaveTextContent('a high score does not clear these')
    expect(screen.getByTestId('readiness-score')).toHaveTextContent('80%')
  })

  it('labels a critical rule as critical', async () => {
    readinessFn.mockResolvedValue(readiness())
    statusFn.mockResolvedValue(agentStatus())
    render(<DcaaReadinessPanel />)
    expect(within(await screen.findByTestId('readiness-rule-NO_FUTURE_DATED_TIME')).getByText('CRITICAL')).toBeInTheDocument()
  })

  it('reveals per-rule evidence and record ids on expand', async () => {
    readinessFn.mockResolvedValue(readiness({
      checks: [check({ verdict: 'FAIL', evidence: ['Entry e9 records 8 hours on 2026-09-01, which is after today.'], sourceRecordIds: ['e9'], recordsFailing: 1 })],
    }))
    statusFn.mockResolvedValue(agentStatus())
    render(<DcaaReadinessPanel />)
    fireEvent.click(within(await screen.findByTestId('readiness-rule-NO_FUTURE_DATED_TIME')).getByRole('button'))
    const ev = screen.getByTestId('readiness-evidence-NO_FUTURE_DATED_TIME')
    expect(ev).toHaveTextContent('which is after today')
    expect(ev).toHaveTextContent('e9')
  })

  it('shows the rule version, check time and originating run', async () => {
    readinessFn.mockResolvedValue(readiness())
    statusFn.mockResolvedValue(agentStatus())
    render(<DcaaReadinessPanel />)
    const meta = await screen.findByTestId('readiness-meta')
    expect(meta).toHaveTextContent('bytescon-readiness-v1')
    expect(meta).toHaveTextContent('run-abcd')
  })

  it('offers no control that edits or approves time', async () => {
    readinessFn.mockResolvedValue(readiness())
    statusFn.mockResolvedValue(agentStatus())
    render(<DcaaReadinessPanel />)
    await screen.findByTestId('readiness-state')
    for (const label of [/approve/i, /edit/i, /fix/i, /waive/i, /override/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })
})

// =============================================================
// Cash flow panel
// =============================================================

describe('CashFlowPanel', () => {
  it('always shows the no-opening-balance disclaimer', async () => {
    cashFlowFn.mockResolvedValue(cashFlow())
    render(<CashFlowPanel />)
    expect(await screen.findByTestId('cash-flow-disclaimer')).toHaveTextContent('not a cash position')
  })

  it('labels the headline as net cash flow, never a cash position', async () => {
    cashFlowFn.mockResolvedValue(cashFlow())
    const { container } = render(<CashFlowPanel />)
    await screen.findByTestId('cf-net')
    expect(screen.getByTestId('cf-net')).toHaveTextContent('Projected net cash flow')
    expect(screen.getByTestId('cf-net')).toHaveTextContent('Not a cash position')
    expect(container.textContent ?? '').not.toMatch(/(projected|is a|shows a)\s+negative cash position/i)
  })

  it('renders exact Decimal amounts', async () => {
    cashFlowFn.mockResolvedValue(cashFlow())
    render(<CashFlowPanel />)
    expect(await screen.findByTestId('cf-receipts')).toHaveTextContent('$125,000.50')
    expect(screen.getByTestId('cf-disbursements')).toHaveTextContent('$40,000.25')
    expect(screen.getByTestId('cf-net')).toHaveTextContent('$85,000.25')
  })

  it('separates pipeline expected value from contracted receipts', async () => {
    cashFlowFn.mockResolvedValue(cashFlow())
    render(<CashFlowPanel />)
    const pipeline = await screen.findByTestId('cf-source-PIPELINE_EXPECTED_VALUE')
    expect(pipeline).toHaveTextContent('not contracted, excluded from net')
    // The headline receipts exclude it.
    expect(screen.getByTestId('cf-receipts')).toHaveTextContent('$125,000.50')
    expect(screen.getByTestId('cf-receipts')).toHaveTextContent('Contracted only')
  })

  it('says there is no confidence range rather than showing an invented one', async () => {
    cashFlowFn.mockResolvedValue(cashFlow())
    render(<CashFlowPanel />)
    expect(await screen.findByTestId('cf-confidence')).toHaveTextContent('not enough settled-invoice history')
  })

  it('shows a range when the projection is banded', async () => {
    cashFlowFn.mockResolvedValue(cashFlow({
      projections: [projection({ confidenceState: 'BANDED', confidenceLower: '70000.00', confidenceUpper: '100000.50' })],
    }))
    render(<CashFlowPanel />)
    expect(await screen.findByTestId('cf-confidence')).toHaveTextContent('$70,000.00 to $100,000.50')
  })

  it('renders a negative net flow in a warning tone without calling it a position', async () => {
    cashFlowFn.mockResolvedValue(cashFlow({ projections: [projection({ netCashFlow: '-9000.00' })] }))
    render(<CashFlowPanel />)
    expect(await screen.findByTestId('cf-net')).toHaveTextContent('-$9,000.00')
  })

  it('says the agent has not run rather than showing zeros', async () => {
    cashFlowFn.mockResolvedValue(cashFlow({ projections: [] }))
    render(<CashFlowPanel />)
    expect(await screen.findByText(/has not produced a projection yet/i)).toBeInTheDocument()
  })

  it('surfaces the projection limitations', async () => {
    cashFlowFn.mockResolvedValue(cashFlow())
    render(<CashFlowPanel />)
    await screen.findByTestId('cf-breakdown')
    expect(screen.getByText(/EXCLUDED from projected receipts/i)).toBeInTheDocument()
  })
})

// =============================================================
// Rate variance panel
// =============================================================

describe('RateVariancePanel', () => {
  it('states the proposal-pricing-to-actual semantic caveat', async () => {
    statusFn.mockResolvedValue(agentStatus())
    render(<RateVariancePanel />)
    expect(await screen.findByTestId('rate-variance-disclaimer'))
      .toHaveTextContent('not a provisional billing rate negotiated with a contracting officer')
  })

  it('renders both rates, the difference and the monitoring state', async () => {
    statusFn.mockResolvedValue(agentStatus())
    render(<RateVariancePanel />)
    const row = await screen.findByTestId('rate-variance-FRINGE')
    expect(row).toHaveTextContent('30.0000')
    expect(row).toHaveTextContent('36.0000')
    expect(row).toHaveTextContent('6.0000')
    expect(row).toHaveTextContent('20')
    expect(row).toHaveTextContent('MATERIAL VARIANCE')
  })

  it('offers no control that applies a rate to invoices', async () => {
    statusFn.mockResolvedValue(agentStatus())
    render(<RateVariancePanel />)
    await screen.findByTestId('rate-variance-FRINGE')
    for (const label of [/apply/i, /update rate/i, /rebill/i, /adjust invoice/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('flags an unverified actual rate', async () => {
    statusFn.mockResolvedValue(agentStatus({
      status: { ...agentStatus().status, indirectRates: { periods: 1, reviewRequired: 1, variances: [variance({ actualIsHumanVerified: false })] } },
    }))
    render(<RateVariancePanel />)
    expect(await screen.findByTestId('rate-unverified-FRINGE')).toHaveTextContent('not been verified by a person')
  })

  it('says nothing can be compared rather than inventing a baseline', async () => {
    statusFn.mockResolvedValue(agentStatus({
      status: { ...agentStatus().status, indirectRates: { periods: 0, reviewRequired: 0, variances: [] } },
    }))
    render(<RateVariancePanel />)
    expect(await screen.findByText(/never derives an actual rate from a pricing assumption/i)).toBeInTheDocument()
  })

  it('names the thresholds as Bytescon monitoring policy, not a DCAA rule', async () => {
    statusFn.mockResolvedValue(agentStatus())
    render(<RateVariancePanel />)
    const policy = await screen.findByTestId('rate-variance-policy')
    expect(policy).toHaveTextContent('Bytescon monitoring thresholds')
    expect(policy).toHaveTextContent('not a DCAA or FAR threshold')
  })

  it('shows the backend error rather than a blank panel', async () => {
    statusFn.mockRejectedValue({ response: { data: { error: 'Finance data unavailable' } } })
    render(<RateVariancePanel />)
    expect(await screen.findByText('Finance data unavailable')).toBeInTheDocument()
  })
})
