// =============================================================
// §7.1 — Contract health surfaces.
//
// Pins the honesty rules: an unassessed contract is never rendered as healthy,
// funded remaining and ceiling remaining are always shown as separate figures,
// a suppressed burn projection explains itself, and a derived option date is
// always labelled as an internal recommendation.
// =============================================================
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getPortfolio = vi.fn()
const getContract = vi.fn()
vi.mock('../../services/contractHealthApi', () => ({
  contractHealthApi: {
    getPortfolio: () => getPortfolio(),
    getContract: (...a: unknown[]) => getContract(...a),
  },
}))

import { ContractPortfolioHealth, ContractHealthPanel } from './ContractHealthPanels'

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

const portfolio = (over = {}) => ({
  agentKey: 'CONTRACT_ADMINISTRATION',
  schedule: { isEnabled: true, nextRunAt: '2026-06-02T07:00:00Z', lastSuccessfulRunAt: '2026-06-01T07:00:00Z', autonomyLevel: 'PROPOSE', cronExpression: '0 7 * * *' },
  lastRun: { id: 'run1', status: 'COMPLETED', createdAt: '2026-06-01T07:00:00Z', finishedAt: '2026-06-01T07:00:05Z', outputSummary: 'Assessed 1 contract', triggerType: 'SCHEDULE' },
  totals: {
    monitoredContracts: 1, assessedContracts: 1,
    HEALTHY: 1, ATTENTION: 0, CRITICAL: 0, INSUFFICIENT_DATA: 0,
    overdueDeliverables: 0, dueSoonDeliverables: 0, openOptionWindows: 0,
    popApproaching: 0, fundingWarnings: 0, openEscalations: 0,
  },
  contracts: [{
    contractId: 'c1', contractNumber: 'S7-CA-QA-001', title: 'Test contract', status: 'ACTIVE',
    endDate: '2027-01-01T00:00:00Z', ownerUserId: 'u1', health: 'HEALTHY',
    summary: 'HEALTHY', assessedAt: '2026-06-01T07:00:00Z', artifactId: 'a1', runId: 'run1',
    overdueDeliverables: 0, dueSoonDeliverables: 0, fundingThresholdState: 'OK',
    fundedRemaining: '148300.00', ceilingRemaining: '598300.00',
    openOptionWindows: 0, popState: 'ACTIVE', popDaysRemaining: 200,
  }],
  escalations: [],
  policy: { fundingWarningPct: 0.9 },
  ...over,
})

const detail = (over = {}) => ({
  contract: { id: 'c1', contractNumber: 'S7-CA-QA-001', title: 'Test contract', status: 'ACTIVE', ownerUserId: 'u1', startDate: '2026-01-01T00:00:00Z', endDate: '2027-01-01T00:00:00Z' },
  health: {
    artifactId: 'a1', runId: 'run1', assessedAt: '2026-06-01T07:00:00Z',
    confidenceState: 'HIGH', isHumanVerified: false, summary: 'HEALTHY',
    overallHealth: 'HEALTHY', generatedAt: '2026-06-01T07:00:00Z', clinCount: 1,
    warnings: [], dataLimitations: [],
    deliverables: { total: 1, dueSoon: 0, overdue: 0, awaitingReview: 0, unowned: 0, openItems: [], remindersSent: 0, escalationsSent: 0 },
    funding: {
      funded: '150000.00', ceiling: '600000.00', expended: '1700.00',
      fundedRemaining: '148300.00', ceilingRemaining: '598300.00',
      fundedConsumedPct: 0.0113, ceilingConsumedPct: 0.0028,
      burnRatePerDay: '56.67', avgMonthlyBurn: '1700.10', observationDays: 30,
      expenditureEventCount: 1, projectedFundingExhaustion: '2033-01-01T00:00:00Z',
      projectedCeilingExhaustion: null, depletionBeforeEnd: false,
      thresholdState: 'OK', insufficientData: false, reasons: [],
    },
    options: { total: 0, upcomingDecisionWindows: [], openWindowCount: 0, missingOwnerCount: 0 },
    periodOfPerformance: { startDate: '2026-01-01T00:00:00Z', endDate: '2027-01-01T00:00:00Z', state: 'ACTIVE', daysRemaining: 200, reasons: [] },
    modifications: { recent: [], unresolvedImpacts: [] },
  },
  lastRun: {
    id: 'run1', status: 'COMPLETED', triggerType: 'SCHEDULE', createdAt: '2026-06-01T07:00:00Z',
    finishedAt: '2026-06-01T07:00:05Z', outputSummary: 'Assessed 1 contract',
    confidenceState: 'HIGH', dataSufficiency: 'SUFFICIENT', warnings: [], limitations: [],
    tokenInput: 0, tokenOutput: 0, estimatedCostUsd: 0,
  },
  escalations: [],
  policy: {},
  ...over,
})

beforeEach(() => {
  getPortfolio.mockReset(); getContract.mockReset()
  getPortfolio.mockResolvedValue(portfolio())
  getContract.mockResolvedValue(detail())
})

// -------------------------------------------------------------
// Portfolio
// -------------------------------------------------------------

describe('ContractPortfolioHealth', () => {
  it('shows loading then the roll-up', async () => {
    wrap(<ContractPortfolioHealth />)
    expect(screen.getByText(/Loading contract health/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('contract-portfolio-health')).toBeInTheDocument())
    expect(screen.getByText('Contract Administration Agent')).toBeInTheDocument()
    expect(screen.getByText('ENABLED')).toBeInTheDocument()
  })

  it('renders the health tallies from the backend', async () => {
    getPortfolio.mockResolvedValue(portfolio({
      totals: { ...portfolio().totals, HEALTHY: 2, ATTENTION: 1, CRITICAL: 3, overdueDeliverables: 4, openEscalations: 5 },
    }))
    wrap(<ContractPortfolioHealth />)
    await waitFor(() => expect(screen.getByText('Critical')).toBeInTheDocument())
    // The label sits in its own div; the value is its sibling inside the card.
    const card = screen.getByText('Critical').parentElement!
    expect(within(card).getByText('3')).toBeInTheDocument()
  })

  it('shows NOT ASSESSED rather than healthy for an un-run contract', async () => {
    getPortfolio.mockResolvedValue(portfolio({
      totals: { ...portfolio().totals, assessedContracts: 0, HEALTHY: 0 },
      contracts: [{ ...portfolio().contracts[0], health: null, assessedAt: null, summary: null }],
    }))
    wrap(<ContractPortfolioHealth />)
    await waitFor(() => expect(screen.getByText('NOT ASSESSED')).toBeInTheDocument())
    expect(screen.getByText('not assessed')).toBeInTheDocument()
    expect(screen.queryByText('HEALTHY')).not.toBeInTheDocument()
  })

  it('warns when the agent is not enabled', async () => {
    getPortfolio.mockResolvedValue(portfolio({ schedule: { ...portfolio().schedule!, isEnabled: false } }))
    wrap(<ContractPortfolioHealth />)
    await waitFor(() => expect(screen.getByText(/is not enabled for this firm/i)).toBeInTheDocument())
    expect(screen.getByText('DISABLED')).toBeInTheDocument()
  })

  it('shows the empty state when nothing is monitored', async () => {
    getPortfolio.mockResolvedValue(portfolio({
      totals: { ...portfolio().totals, monitoredContracts: 0 }, contracts: [],
    }))
    wrap(<ContractPortfolioHealth />)
    await waitFor(() => expect(screen.getByText(/No active contracts are being monitored/i)).toBeInTheDocument())
  })

  it('shows an error state with retry', async () => {
    getPortfolio.mockRejectedValue({ response: { data: { error: 'Health unavailable' } } })
    wrap(<ContractPortfolioHealth />)
    await waitFor(() => expect(screen.getByText('Health unavailable')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })

  it('refetches on refresh', async () => {
    wrap(<ContractPortfolioHealth />)
    await waitFor(() => expect(screen.getByTestId('contract-portfolio-health')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Refresh/i }))
    await waitFor(() => expect(getPortfolio).toHaveBeenCalledTimes(2))
  })

  it('surfaces overdue deliverables and a funding warning on the row', async () => {
    getPortfolio.mockResolvedValue(portfolio({
      contracts: [{
        ...portfolio().contracts[0], health: 'CRITICAL', overdueDeliverables: 2,
        fundingThresholdState: 'FUNDING_CRITICAL',
      }],
    }))
    wrap(<ContractPortfolioHealth />)
    await waitFor(() => expect(screen.getByTestId('health-row-c1')).toBeInTheDocument())
    const row = screen.getByTestId('health-row-c1')
    expect(within(row).getByText('2 overdue')).toBeInTheDocument()
    expect(within(row).getByText('FUNDING CRITICAL')).toBeInTheDocument()
  })
})

// -------------------------------------------------------------
// Detail panel
// -------------------------------------------------------------

describe('ContractHealthPanel', () => {
  it('states plainly when the contract has never been assessed', async () => {
    getContract.mockResolvedValue(detail({ health: null, lastRun: null }))
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByText(/has not been assessed yet/i)).toBeInTheDocument())
  })

  it('renders funded remaining and ceiling remaining as DISTINCT figures', async () => {
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByText('Funded remaining')).toBeInTheDocument())
    expect(screen.getByText('Ceiling remaining')).toBeInTheDocument()
    expect(screen.getByText('$148300.00')).toBeInTheDocument()
    expect(screen.getByText('$598300.00')).toBeInTheDocument()
  })

  it('explains a suppressed burn projection instead of hiding it', async () => {
    const d = detail()
    getContract.mockResolvedValue(detail({
      health: {
        ...d.health, funding: {
          ...d.health!.funding, insufficientData: true, burnRatePerDay: null,
          projectedFundingExhaustion: null,
          reasons: ['Expenditure history too short (< 7 days) to project a burn rate'],
        },
      },
    }))
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByTestId('burn-insufficient-data')).toBeInTheDocument())
    expect(screen.getByText(/too short \(< 7 days\)/i)).toBeInTheDocument()
    expect(screen.getAllByText('Not available').length).toBeGreaterThan(0)
  })

  it('labels a derived option date as an INTERNAL RECOMMENDATION', async () => {
    const d = detail()
    getContract.mockResolvedValue(detail({
      health: {
        ...d.health,
        options: {
          total: 1, openWindowCount: 1, missingOwnerCount: 0,
          upcomingDecisionWindows: [{
            optionPeriodId: 'o1', label: 'OY1', exerciseStatus: 'PLANNED',
            startDate: '2026-10-01T00:00:00Z', endDate: null, optionValue: null,
            effectiveDecisionDate: '2026-07-03T00:00:00Z', dateBasis: 'INTERNAL_RECOMMENDATION',
            isInternalRecommendation: true, workingDaysUntilDecision: 20, state: 'OPEN',
            ownerUserId: 'u1', reasons: [],
          }],
        },
      },
    }))
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByTestId('option-window-o1')).toBeInTheDocument())
    expect(screen.getByText(/INTERNAL RECOMMENDATION/)).toBeInTheDocument()
    expect(screen.getByText(/not a government or contractual deadline/i)).toBeInTheDocument()
  })

  it('flags an option decision window with no owner', async () => {
    const d = detail()
    getContract.mockResolvedValue(detail({
      health: {
        ...d.health,
        options: {
          total: 1, openWindowCount: 1, missingOwnerCount: 1,
          upcomingDecisionWindows: [{
            optionPeriodId: 'o1', label: 'OY1', exerciseStatus: 'PLANNED',
            startDate: null, endDate: null, optionValue: null,
            effectiveDecisionDate: '2026-07-03T00:00:00Z', dateBasis: 'EXERCISE_DEADLINE',
            isInternalRecommendation: false, workingDaysUntilDecision: 5, state: 'OPEN',
            ownerUserId: null, reasons: [],
          }],
        },
      },
    }))
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByText('NO OWNER')).toBeInTheDocument())
  })

  it('lists overdue deliverables with their derived status', async () => {
    const d = detail()
    getContract.mockResolvedValue(detail({
      health: {
        ...d.health,
        overallHealth: 'CRITICAL',
        deliverables: {
          total: 1, dueSoon: 0, overdue: 1, awaitingReview: 0, unowned: 0,
          remindersSent: 3, escalationsSent: 2,
          openItems: [{
            id: 'd1', name: 'Monthly report', cdrlNumber: 'A001',
            dueDate: '2026-05-01T00:00:00Z', status: 'IN_PROGRESS', derivedStatus: 'OVERDUE',
            ownerUserId: 'u1', reviewerUserId: 'u2', isOverdue: true, isDueSoon: false,
            reminderLevel: 'ESCALATED', reminderReason: 'Overdue by 720 hours.',
            lastReminderAt: null, lastEscalationAt: null,
          }],
        },
      },
    }))
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByTestId('health-deliverable-d1')).toBeInTheDocument())
    const row = screen.getByTestId('health-deliverable-d1')
    expect(within(row).getByText('OVERDUE')).toBeInTheDocument()
    expect(within(row).getByText('ESCALATED')).toBeInTheDocument()
    expect(screen.getByText('CRITICAL')).toBeInTheDocument()
  })

  it('shows unapplied modifications and says the agent never applies them', async () => {
    const d = detail()
    getContract.mockResolvedValue(detail({
      health: {
        ...d.health,
        modifications: {
          unresolvedImpacts: [{ modificationId: 'm1', modNumber: 'P00001' }],
          recent: [{
            modificationId: 'm1', modNumber: 'P00001', status: 'RECORDED', isUnresolved: true,
            fundingChange: '25000.00', ceilingChange: null, projectedFundedValue: '175000.00',
            note: 'Recorded but not applied.',
          }],
        },
      },
    }))
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByText('Unapplied modifications')).toBeInTheDocument())
    expect(screen.getByText(/never applies a modification/i)).toBeInTheDocument()
    expect(screen.getByText(/projected funded \$175000\.00/)).toBeInTheDocument()
  })

  it('renders open escalations with a link to Agent Operations', async () => {
    getContract.mockResolvedValue(detail({
      escalations: [{
        id: 'e1', severity: 'HIGH', status: 'OPEN', title: 'Deliverable overdue',
        reason: 'Past due.', recommendedAction: 'Check with the owner.',
        entityType: 'ContractDeliverable', entityId: 'd1', createdAt: '2026-06-01T00:00:00Z',
      }],
    }))
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByTestId('health-escalation-e1')).toBeInTheDocument())
    expect(screen.getByText('Manage in Agent Operations')).toBeInTheDocument()
  })

  it('surfaces data limitations honestly', async () => {
    const d = detail()
    getContract.mockResolvedValue(detail({
      health: { ...d.health, dataLimitations: ['No contract ceiling is recorded, so ceiling remaining cannot be reported.'] },
    }))
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByText(/could not determine/i)).toBeInTheDocument())
    expect(screen.getByText(/No contract ceiling is recorded/i)).toBeInTheDocument()
  })

  it('shows an error state with retry', async () => {
    getContract.mockRejectedValue({ response: { data: { error: 'Contract not found.' } } })
    wrap(<ContractHealthPanel contractId="c1" />)
    await waitFor(() => expect(screen.getByText('Contract not found.')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })
})
