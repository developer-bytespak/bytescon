// Qualify panel on the opportunity page: per-client scorecards, suggested
// scores shown with their reasons, and next steps after a Bid.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let contractor = false
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }), useIsContractor: () => contractor }))
vi.mock('../Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../BidReadinessCard', () => ({ BidReadinessCard: ({ clientCompanyId }: { clientCompanyId?: string | null }) => <p>Readiness for {clientCompanyId ?? 'own company'}</p> }))

const get = vi.fn()
const start = vi.fn()
const pursuitFor = vi.fn()
vi.mock('../../services/api', () => ({
  clientsApi: { list: () => Promise.resolve({ data: [{ id: 'c1', name: 'Cabling Co' }, { id: 'c2', name: 'Food Co' }] }) },
  qualificationApi: {
    get: (...a: unknown[]) => get(...a), start: (...a: unknown[]) => start(...a), pursuitFor: (...a: unknown[]) => pursuitFor(...a),
    saveScorecard: vi.fn(), refreshSuggestions: vi.fn(), decide: vi.fn(), reassess: vi.fn(),
  },
}))

import { QualifyPanel } from './QualifyPanel'

const view = (over: Record<string, unknown> = {}) => ({
  data: {
    exists: true, clientCompanyId: 'c1',
    clients: [{ clientCompanyId: 'c1', clientName: 'Cabling Co', status: 'NOT_REVIEWED', finalDecision: null, totalScore: 74 }, { clientCompanyId: 'c2', clientName: 'Food Co', status: 'NO_BID', finalDecision: 'NO_BID', totalScore: 20 }],
    signals: { winProbability: 0.61, engineRecommendation: 'BID', scoredAt: null },
    noBidReasons: [{ key: 'NO_CAPACITY', label: 'No capacity to deliver right now' }],
    pursuit: { id: 'p1', pipelineStage: 'QUALIFICATION', closedAt: null, opportunity: { id: 'o1', title: 'Cabling', agency: 'VA' } },
    scorecard: {
      id: 'sc1', status: 'NOT_REVIEWED', totalScore: 74, recommendation: 'CONDITIONAL', recommendationVersion: 'scorecard-v1',
      finalDecision: null, isOverride: false, overrideReason: null, decidedByUserId: null, decidedAt: null, reviewerUserId: null, reviewerComments: null, submittedForReviewAt: null,
      criteria: [
        { id: 'k1', key: 'capability_fit', name: 'Capability fit', description: null, weight: 60, score: 90, required: true, displayOrder: 1, evidence: null, suggestedScore: 90, suggestionNote: 'NAICS 238210 is one of your codes.' },
        { id: 'k2', key: 'capacity', name: 'Internal capacity', description: null, weight: 40, score: null, required: true, displayOrder: 2, evidence: null, suggestedScore: null, suggestionNote: 'Your judgement: Bytescon has no records to suggest a score from.' },
      ],
      history: [],
    },
    computed: { totalScore: 54, recommendation: 'REVIEW_REQUIRED', complete: false, missingRequiredKeys: ['capacity'], recommendationVersion: 'scorecard-v1' },
    ...over,
  },
})

function renderPanel(pursuitId: string | null = 'p1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><QualifyPanel opportunityId="o1" pursuitId={pursuitId} /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  contractor = false
  get.mockReset(); start.mockReset(); pursuitFor.mockReset()
})

describe('QualifyPanel', () => {
  it('qualifies a consulting firm\'s client, showing suggestions with their reasons and what still needs a person', async () => {
    get.mockResolvedValue(view())
    renderPanel()
    expect(await screen.findByText('NAICS 238210 is one of your codes.')).toBeInTheDocument()
    expect(get).toHaveBeenCalledWith('p1', 'c1')
    expect(screen.getByText('Readiness for c1')).toBeInTheDocument()
    expect(screen.getByText(/Suggested 90/)).toBeInTheDocument()
    expect(screen.getByText(/Still needs your score: Internal capacity/)).toBeInTheDocument()
    expect(screen.getByText('61%')).toBeInTheDocument()
    // The other client's decision is one click away.
    expect(screen.getByRole('button', { name: 'Food Co: No bid' })).toBeInTheDocument()
  })

  it('starts the scorecard for the chosen client, creating the pursuit when the notice has none', async () => {
    pursuitFor.mockResolvedValue({ data: { pursuitId: 'p9' } })
    start.mockResolvedValue({})
    get.mockResolvedValue(view({ exists: false, scorecard: undefined, computed: undefined }))
    renderPanel(null)
    const startButton = await screen.findByRole('button', { name: 'Start scorecard' })
    // Enabled once the client list has loaded and a client is chosen.
    await waitFor(() => expect(startButton).not.toBeDisabled())
    fireEvent.click(startButton)
    await waitFor(() => expect(start).toHaveBeenCalledWith('p9', 'c1'))
    expect(pursuitFor).toHaveBeenCalledWith('o1')
  })

  it('sends no client for a contractor and offers next steps after a Bid', async () => {
    contractor = true
    get.mockResolvedValue(view({ scorecard: { ...view().data.scorecard, status: 'BID', finalDecision: 'BID', decidedAt: '2026-11-12T00:00:00Z' } }))
    renderPanel()
    expect(await screen.findByRole('link', { name: /Open the proposal workspace/ })).toHaveAttribute('href', '/opportunities/o1/proposal')
    expect(get).toHaveBeenCalledWith('p1', null)
    expect(screen.queryByLabelText(/For client/)).not.toBeInTheDocument()
  })
})
