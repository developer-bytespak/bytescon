// =============================================================
// §6.2G / §6.2B — Portfolio expected value + calibration.
//
// Pins the honesty rules: exclusions are shown rather than counted as zero,
// the value hierarchy is published, a partial interval says so, and a
// calibration that failed its acceptance criteria is never shown as active.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

const getPortfolio = vi.fn()
const getCalibration = vi.fn()
const fitCalibration = vi.fn()

vi.mock('../services/section6Api', () => ({
  scoringApi: {
    getPortfolio: (...a: unknown[]) => getPortfolio(...a),
    getCalibration: () => getCalibration(),
    fitCalibration: () => fitCalibration(),
    rollbackCalibration: vi.fn(),
  },
}))

import Portfolio from './Portfolio'

const renderPage = () => render(<MemoryRouter><Portfolio /></MemoryRouter>)

const row = (over = {}) => ({
  opportunityId: 'o1', title: 'Cyber support', agency: 'DoD', naicsCode: '541512',
  value: 1_000_000, valueSource: 'OPPORTUNITY_ESTIMATE', valueType: 'ESTIMATED',
  probability: 0.4, probabilityLower: null, probabilityUpper: null,
  expectedValue: 400_000, expectedValueLower: null, expectedValueUpper: null,
  pipelineStage: null, ownerUserId: null, responseDeadline: '2027-01-01T00:00:00Z',
  eligibility: 'ELIGIBLE', intervalAvailable: false, ...over,
})

const portfolio = (over = {}) => ({
  activeOpportunityCount: 1,
  totalNominalValue: 1_000_000,
  weightedExpectedValue: 400_000,
  lowerExpectedValue: null,
  upperExpectedValue: null,
  intervalPartial: true,
  byValueType: { CEILING: { count: 0, nominal: 0, expected: 0 }, FUNDED: { count: 0, nominal: 0, expected: 0 }, ESTIMATED: { count: 1, nominal: 1_000_000, expected: 400_000 }, FORECAST: { count: 0, nominal: 0, expected: 0 } },
  byAgency: [{ key: 'DoD', count: 1, nominal: 1_000_000, expected: 400_000 }],
  byNaics: [], byPipelineStage: [], byOwner: [], byPeriod: [],
  highValueHighUncertainty: [],
  concentration: { agencyHhi: 1, naicsHhi: 1, topAgencyShare: 1, interpretation: 'Highly concentrated by agency (HHI 1).' },
  upcomingDeadlines: [],
  capacityConflicts: [],
  exclusions: [{ opportunityId: 'o2', title: 'Unvalued pursuit', reason: 'No usable contract, notice or forecast value — excluded rather than counted as zero.' }],
  rows: [row()],
  methodVersion: 'v1',
  calculatedAt: '2026-06-01T00:00:00Z',
  valueHierarchy: [
    { key: 'CONTRACT_CEILING', type: 'CEILING', description: 'Ceiling value of a linked awarded contract' },
    { key: 'OPPORTUNITY_ESTIMATE', type: 'ESTIMATED', description: 'Estimated value published on the notice' },
  ],
  ...over,
})

beforeEach(() => {
  toast.mockReset(); getPortfolio.mockReset(); getCalibration.mockReset(); fitCalibration.mockReset()
  getPortfolio.mockResolvedValue(portfolio())
  getCalibration.mockResolvedValue({ featureEnabled: true, active: null, versions: [], verifiedSampleCount: 0, note: 'A calibration is only activated when it beats the baseline.' })
})

describe('Portfolio — expected value', () => {
  it('shows a loading state then the KPIs', async () => {
    renderPage()
    expect(screen.getByText(/Computing portfolio/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Weighted expected value')).toBeInTheDocument())
    // The figure appears both as a KPI and on the pursuit row.
    expect(screen.getAllByText('$400K').length).toBeGreaterThan(0)
  })

  it('says the range is not available rather than inventing one', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Expected value range')).toBeInTheDocument())
    expect(screen.getByText('Not available')).toBeInTheDocument()
  })

  it('warns that the interval covers only part of the portfolio', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/covers only/i)).toBeInTheDocument())
    expect(screen.getByText(/not a range over the whole portfolio/i)).toBeInTheDocument()
  })

  it('lists exclusions with their reason instead of counting them as zero', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/Excluded from expected value \(1\)/)).toBeInTheDocument())
    expect(screen.getByText('Unvalued pursuit')).toBeInTheDocument()
    // Stated both as the section's rationale and as this row's reason.
    expect(screen.getAllByText(/excluded rather than counted as zero/i).length).toBeGreaterThanOrEqual(1)
  })

  it('publishes the documented value hierarchy', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('How value is chosen')).toBeInTheDocument())
    expect(screen.getByText('Ceiling value of a linked awarded contract')).toBeInTheDocument()
    expect(screen.getByText(/Expected value = opportunity value × final win probability/i)).toBeInTheDocument()
  })

  it('shows the empty state when nothing can be valued', async () => {
    getPortfolio.mockResolvedValue(portfolio({ activeOpportunityCount: 0, rows: [] }))
    renderPage()
    await waitFor(() => expect(screen.getByText(/No active pursuits could be valued/i)).toBeInTheDocument())
  })

  it('shows an error state with retry', async () => {
    getPortfolio.mockRejectedValue({ response: { data: { error: 'Timed out' } } })
    renderPage()
    await waitFor(() => expect(screen.getByText('Timed out')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })
})

describe('Portfolio — calibration tab', () => {
  it('reports honestly when a firm has no verified outcomes', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Calibration/i }))
    await waitFor(() => expect(screen.getByText(/only activated when it beats the baseline/i)).toBeInTheDocument())
    expect(screen.getByText(/No calibration has been attempted yet/i)).toBeInTheDocument()
    expect(screen.getByText('None')).toBeInTheDocument()
  })

  it('surfaces the reason when a fit is not activated', async () => {
    fitCalibration.mockResolvedValue({
      activated: false,
      reason: 'Only 4 verified outcome(s); 30 are required. Scores stay RAW until enough real outcomes are recorded.',
      sampleSize: 4, brierScore: null, baselineBrierScore: null,
    })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Calibration/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Fit calibration/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Fit calibration/i }))
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringContaining('30 are required'), 'warning'),
    )
  })

  it('shows a rejected version with its rejection reason', async () => {
    getCalibration.mockResolvedValue({
      featureEnabled: true, active: null, verifiedSampleCount: 40,
      note: 'A calibration is only activated when it beats the baseline.',
      versions: [{
        id: 'c1', version: 1, state: 'REJECTED', sampleSize: 40, holdoutSize: 12,
        brierScore: 0.24, baselineBrierScore: 0.23, improvement: -0.01,
        activationReason: null,
        rejectionReason: 'Calibrated Brier 0.24 did not beat the uncalibrated baseline 0.23. Not activated — scores remain uncalibrated.',
        createdAt: '2026-06-01T00:00:00Z',
      }],
    })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Calibration/i }))
    await waitFor(() => expect(screen.getByText('REJECTED')).toBeInTheDocument())
    expect(screen.getByText(/did not beat the uncalibrated baseline/i)).toBeInTheDocument()
    expect(screen.getByText(/scores remain uncalibrated/i)).toBeInTheDocument()
  })

  it('warns when the active calibration has gone stale', async () => {
    getCalibration.mockResolvedValue({
      featureEnabled: true, verifiedSampleCount: 120,
      note: 'note',
      active: { id: 'c2', version: 2, sampleSize: 120, activatedAt: '2025-01-01T00:00:00Z', brierScore: 0.19, baselineBrierScore: 0.24, isStale: true },
      versions: [],
    })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Calibration/i }))
    await waitFor(() => expect(screen.getByText(/no longer being applied/i)).toBeInTheDocument())
    expect(screen.getByText(/reverted to\s+uncalibrated/i)).toBeInTheDocument()
  })
})

describe('Portfolio — risk tab', () => {
  it('renders concentration and capacity information', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Weighted expected value')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Risk & capacity/i }))
    await waitFor(() => expect(screen.getByText('Concentration')).toBeInTheDocument())
    expect(screen.getByText(/Highly concentrated by agency/i)).toBeInTheDocument()
    expect(screen.getByText(/No week has an unusual cluster of deadlines/i)).toBeInTheDocument()
  })
})
