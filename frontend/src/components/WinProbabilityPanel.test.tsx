// =============================================================
// §5.1 Stage 3 — Win-probability panel: RAW / CALIBRATED / FALLBACK labels,
// honest fallback explanation, raw-vs-calibrated display, unscored + error.
// =============================================================
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

const winProbability = vi.fn()
vi.mock('../services/api', () => ({ opportunitiesApi: { winProbability: () => winProbability() } }))

import { WinProbabilityPanel } from './WinProbabilityPanel'

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><WinProbabilityPanel opportunityId="o1" /></QueryClientProvider>)
}
const data = (over: Record<string, unknown> = {}) => ({ data: { scored: true, rawScore: 42, finalScore: 42, scoreType: 'RAW', changed: false, method: null, methodVersion: null, sampleSize: null, lastFittedAt: null, reason: 'CALIBRATION_DISABLED', dataSufficiency: 'SUFFICIENT', ...over } })

// Each test sets its own mock behaviour (mockResolvedValue/mockImplementation
// overwrite the prior one), so no shared mockReset is needed — and a reset here
// interacts badly with the rejected-query test under this runner.

describe('WinProbabilityPanel', () => {
  it('shows a loading spinner', async () => {
    let settle: (v: unknown) => void = () => {}
    winProbability.mockReturnValue(new Promise((r) => { settle = r }))
    const { container } = renderIt()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
    // Settle so the query resolves and RTL cleanup doesn't hang on a pending promise.
    settle({ data: { scored: false, rawScore: null, finalScore: null, scoreType: null } })
    await waitFor(() => expect(container.querySelector('.animate-spin')).toBeFalsy())
  })

  it('shows an error state', async () => {
    winProbability.mockRejectedValue(new Error('boom'))
    renderIt()
    // waitFor + getByText (rather than findByText) settles the rejected query
    // cleanly without the runner flagging a benign unhandled rejection.
    await waitFor(() => expect(screen.getByText(/could not load the win probability/i)).toBeInTheDocument())
  })

  it('shows a RAW label + honest explanation (no misleading calibrated wording)', async () => {
    winProbability.mockResolvedValue(data())
    renderIt()
    expect(await screen.findByText('42%')).toBeInTheDocument()
    expect(screen.getByText('RAW')).toBeInTheDocument()
    expect(screen.getByText(/fitted but not enabled/i)).toBeInTheDocument()
    expect(screen.queryByText(/Calibrated via/i)).not.toBeInTheDocument()
  })

  it('shows a CALIBRATED label with raw→calibrated when the score changed', async () => {
    winProbability.mockResolvedValue(data({ scoreType: 'CALIBRATED', rawScore: 50, finalScore: 70, changed: true, method: 'isotonic', methodVersion: 'v2-permutation', sampleSize: 200, lastFittedAt: '2026-07-01T00:00:00Z', reason: null }))
    renderIt()
    expect(await screen.findByText('70%')).toBeInTheDocument()
    expect(screen.getByText('CALIBRATED')).toBeInTheDocument()
    expect(screen.getByText(/raw 50% → calibrated 70%/i)).toBeInTheDocument()
    expect(screen.getByText(/Calibrated via isotonic \(v2-permutation\)/i)).toBeInTheDocument()
  })

  it('shows a FALLBACK label with the fallback reason', async () => {
    winProbability.mockResolvedValue(data({ scoreType: 'FALLBACK', reason: 'INSUFFICIENT_SAMPLE', dataSufficiency: 'INSUFFICIENT', sampleSize: 10, lastFittedAt: '2026-07-01T00:00:00Z' }))
    renderIt()
    expect(await screen.findByText('FALLBACK')).toBeInTheDocument()
    expect(screen.getByText(/not enough historical outcomes/i)).toBeInTheDocument()
    expect(screen.getByText(/data sufficiency: insufficient/i)).toBeInTheDocument()
  })

  it('shows an honest unavailable state when not scored', async () => {
    winProbability.mockResolvedValue({ data: { scored: false, rawScore: null, finalScore: null, scoreType: null } })
    renderIt()
    expect(await screen.findByText(/not scored yet/i)).toBeInTheDocument()
  })
})
