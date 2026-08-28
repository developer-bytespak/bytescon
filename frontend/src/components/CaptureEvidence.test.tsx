// =============================================================
// §5.1 Stage 3 Capture Evidence — loading, reliable/ambiguous/unavailable
// incumbent, competitor historical wording, source details, role-gated
// correction with validation, and API-error state.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role } }) }))
vi.mock('./Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const getEvidence = vi.fn()
const correct = vi.fn()
const verify = vi.fn()
vi.mock('../services/api', () => ({
  evidenceApi: { get: () => getEvidence(), refresh: vi.fn(), verifyIncumbent: (...a: unknown[]) => verify(...a), correctIncumbent: (...a: unknown[]) => correct(...a), setNotes: vi.fn() },
}))

import { CaptureEvidence } from './CaptureEvidence'

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><CaptureEvidence opportunityId="o1" /></QueryClientProvider>)
}
const resp = (over: Record<string, unknown> = {}) => ({ data: { incumbent: null, competitors: [], lastRefreshedAt: '2026-08-06T00:00:00Z', ...over } })
const incumbent = (over = {}) => ({ id: 'inc1', name: 'Acme Federal Inc', uei: 'UEI1', confidence: 'CONFIRMED', evidenceSource: 'Award history (USASpending/FPDS)', whyShown: 'Sole award recipient', agency: 'Navy', awardReference: 'K-9', awardValue: '500000', periodOfPerformance: null, sourceRecordDate: '2025-01-01T00:00:00Z', verification: 'UNVERIFIED', correctionReason: null, originalName: null, notes: null, ...over })

beforeEach(() => { role = 'ADMIN'; getEvidence.mockReset(); correct.mockReset(); verify.mockReset(); correct.mockResolvedValue({ data: {} }); verify.mockResolvedValue({ data: {} }) })

describe('CaptureEvidence', () => {
  it('shows a loading spinner', () => {
    getEvidence.mockReturnValue(new Promise(() => {}))
    const { container } = renderIt()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('shows an API error state', async () => {
    getEvidence.mockRejectedValue(new Error('boom'))
    renderIt()
    expect(await screen.findByText(/could not load evidence/i)).toBeInTheDocument()
  })

  it('shows honest unavailable states for incumbent and competitors', async () => {
    getEvidence.mockResolvedValue(resp())
    renderIt()
    expect(await screen.findByText(/no incumbent identified/i)).toBeInTheDocument()
    expect(screen.getByText(/no reliable competitor evidence available/i)).toBeInTheDocument()
  })

  it('renders a CONFIRMED incumbent with source attribution + award reference', async () => {
    getEvidence.mockResolvedValue(resp({ incumbent: incumbent() }))
    renderIt()
    expect(await screen.findByText('Acme Federal Inc')).toBeInTheDocument()
    expect(screen.getByText('CONFIRMED')).toBeInTheDocument()
    expect(screen.getByText('K-9')).toBeInTheDocument()
    expect(screen.getByText(/award history/i)).toBeInTheDocument()
  })

  it('flags ambiguous evidence honestly', async () => {
    getEvidence.mockResolvedValue(resp({ incumbent: incumbent({ confidence: 'AMBIGUOUS', name: 'Not available' }) }))
    renderIt()
    expect(await screen.findByText(/ambiguous evidence/i)).toBeInTheDocument()
  })

  it('labels competitor evidence as historical (not a prediction)', async () => {
    getEvidence.mockResolvedValue(resp({ competitors: [{ id: 'c1', name: 'Beta Corp', uei: null, confidence: 'PROBABLE', whyShown: '3 relevant historical awards (same agency). Historical evidence — not a prediction they will bid.', evidenceSource: 'Award history', relevantAwardCount: 3, relevantAwardValue: '150000', agencyRelevant: true, naicsRelevant: false, pscRelevant: false, isIncumbent: false, sourceRecordDate: null, notes: null }] }))
    renderIt()
    expect(await screen.findByText('Beta Corp')).toBeInTheDocument()
    expect(screen.getByText(/historical award evidence — not a prediction/i)).toBeInTheDocument()
    expect(screen.getByText(/not a prediction they will bid/i)).toBeInTheDocument()
  })

  it('requires a name and reason for a correction (submit disabled until filled)', async () => {
    getEvidence.mockResolvedValue(resp({ incumbent: incumbent() }))
    renderIt()
    await screen.findByText('Acme Federal Inc')
    fireEvent.click(screen.getByRole('button', { name: /correct identity/i }))
    const reason = await screen.findByLabelText(/correction reason/i)
    const save = screen.getByRole('button', { name: /save correction/i })
    // name is prefilled from the incumbent; clearing the reason keeps it disabled
    expect(save).toBeDisabled()
    fireEvent.change(reason, { target: { value: 'Verified via contracting officer' } })
    await waitFor(() => expect(save).not.toBeDisabled())
    fireEvent.click(save)
    await waitFor(() => expect(correct).toHaveBeenCalledWith('inc1', expect.objectContaining({ reason: 'Verified via contracting officer' })))
  })

  it('hides admin controls (verify/correct) for a CONSULTANT', async () => {
    getEvidence.mockResolvedValue(resp({ incumbent: incumbent() }))
    role = 'CONSULTANT'
    renderIt()
    await screen.findByText('Acme Federal Inc')
    expect(screen.queryByRole('button', { name: /correct identity/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /verify/i })).not.toBeInTheDocument()
  })
})
