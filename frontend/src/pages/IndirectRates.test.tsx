// =============================================================
// §8.2 — Indirect rates.
//
// The distinction the screen exists to protect: a rate somebody typed in is
// not the same as a rate somebody has checked, and a provisional rate is not a
// negotiated billing rate. Both must survive on screen.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role } }) }))

const actualRates = vi.fn()
const status = vi.fn()
const recordActualRate = vi.fn()
const verifyActualRate = vi.fn()
vi.mock('../services/financeAgentApi', async () => {
  const actual = await vi.importActual<typeof import('../services/financeAgentApi')>('../services/financeAgentApi')
  return {
    ...actual,
    financeAgentApi: {
      actualRates: () => actualRates(),
      status: () => status(),
      recordActualRate: (...a: unknown[]) => recordActualRate(...a),
      verifyActualRate: (...a: unknown[]) => verifyActualRate(...a),
    },
  }
})

import IndirectRates from './IndirectRates'

const RATE = {
  id: 'r1', periodStart: '2025-01-01T00:00:00.000Z', periodEnd: '2025-12-31T00:00:00.000Z',
  fiscalYear: 2025, rateType: 'FRINGE', poolName: null, actualRate: '31.4200',
  source: 'MANUAL_ENTRY', sourceReference: null, status: 'FINAL',
  isHumanVerified: false, verifiedByUserId: null, verifiedAt: null, notes: null,
}

const VARIANCE = {
  rateType: 'OVERHEAD', poolName: 'Engineering', period: { start: '2025-01-01T00:00:00.000Z', end: '2025-12-31T00:00:00.000Z', fiscalYear: 2025 },
  provisionalRate: '118.0000', actualRate: '126.5000', absoluteVariance: '8.5000', relativeVariancePct: 7.2,
  state: 'REVIEW_RECOMMENDED', provisionalSource: 'Pricing template v3',
  semanticMapping: 'PROPOSAL_PRICING_TO_ACTUAL', actualRateId: 'r2', actualIsHumanVerified: true,
  evidence: ['Pool cost recorded for the full year.'], limitations: [],
}

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  role = 'ADMIN'
  actualRates.mockResolvedValue({ rates: [RATE], policy: {} })
  status.mockResolvedValue({ status: { indirectRates: { variances: [VARIANCE] }, dataLimitations: [] } })
})

describe('IndirectRates — variance', () => {
  it('shows provisional and actual side by side', async () => {
    wrap(<IndirectRates />)
    expect(await screen.findByText('118.0000%')).toBeInTheDocument()
    expect(screen.getByText('126.5000%')).toBeInTheDocument()
  })

  it('says the provisional side is a pricing rate, not a billing rate', async () => {
    wrap(<IndirectRates />)
    expect(await screen.findByText(/not a negotiated billing rate/i)).toBeInTheDocument()
  })

  it('never derives one side from the other, and says so', async () => {
    wrap(<IndirectRates />)
    expect(await screen.findByText(/never derived from a provisional one/i)).toBeInTheDocument()
  })

  it('explains an empty state instead of showing a blank panel', async () => {
    status.mockResolvedValue({ status: { indirectRates: { variances: [] }, dataLimitations: [] } })
    wrap(<IndirectRates />)
    expect(await screen.findByText(/No rate variance yet/i)).toBeInTheDocument()
  })

  it('still renders when the agent status cannot be read', async () => {
    status.mockRejectedValue(new Error('agent down'))
    wrap(<IndirectRates />)
    expect(await screen.findByText(/No rate variance yet/i)).toBeInTheDocument()
  })
})

describe('IndirectRates — recorded actuals', () => {
  const openActuals = async () => {
    wrap(<IndirectRates />)
    fireEvent.click(await screen.findByRole('button', { name: 'Recorded actuals' }))
  }

  it('separates a recorded rate from a verified one', async () => {
    await openActuals()
    expect(await screen.findByText('RECORDED ONLY')).toBeInTheDocument()
  })

  it('verifies a rate through the API', async () => {
    verifyActualRate.mockResolvedValue({})
    await openActuals()
    fireEvent.click(await screen.findByRole('button', { name: /Verify/ }))
    await waitFor(() => expect(verifyActualRate).toHaveBeenCalledWith('r1'))
  })

  it('records a new actual rate', async () => {
    recordActualRate.mockResolvedValue({})
    await openActuals()
    fireEvent.change(await screen.findByLabelText('Actual rate'), { target: { value: '29.5' } })
    fireEvent.click(screen.getByRole('button', { name: /Record rate/ }))
    await waitFor(() => expect(recordActualRate).toHaveBeenCalledWith(
      expect.objectContaining({ rateType: 'FRINGE', actualRate: '29.5', source: 'MANUAL_ENTRY' }),
    ))
  })

  it('says pool cost is never back-solved from the rate', async () => {
    await openActuals()
    expect(await screen.findByText(/never back-solved/i)).toBeInTheDocument()
  })

  it('gives a non-admin no way to record or verify', async () => {
    role = 'CONSULTANT'
    await openActuals()
    await screen.findByText('RECORDED ONLY')
    expect(screen.queryByRole('button', { name: /Record rate/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Verify/ })).not.toBeInTheDocument()
  })
})
