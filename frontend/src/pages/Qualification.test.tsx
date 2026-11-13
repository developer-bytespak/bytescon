// =============================================================
// §5.2 Qualification page — states, criteria/weights/total rendering, system
// recommendation vs human decision, override-reason gating, gate reviews,
// history, and role-gated controls.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'admin-1', role } }), useIsContractor: () => true }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const getScorecard = vi.fn()
const decide = vi.fn()
const gatesForPursuit = vi.fn()
const users = vi.fn()
const journey = vi.fn()
vi.mock('../services/api', () => ({
  qualificationApi: {
    get: () => getScorecard(), start: vi.fn(), score: vi.fn(), saveScorecard: vi.fn(), refreshSuggestions: vi.fn(), resetScorecard: vi.fn(), submitReview: vi.fn(), decide: (...a: unknown[]) => decide(...a), reassess: vi.fn(),
  },
  gateReviewsApi: { listForPursuit: () => gatesForPursuit(), create: vi.fn(), submit: vi.fn(), approve: vi.fn(), reject: vi.fn(), requestChanges: vi.fn(), waive: vi.fn() },
  firmApi: { users: () => users() },
  opportunitiesApi: { journey: () => journey() },
}))

import { QualificationPage } from './Qualification'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/pipeline/p1']}>
        <Routes><Route path="/pipeline/:pursuitId" element={<QualificationPage />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Fields every scorecard view carries: the company it's for, the engine's view
// and the no-bid reasons.
const VIEW_EXTRAS = {
  clientCompanyId: 'self-1', clients: [],
  signals: { winProbability: 0.42, engineRecommendation: null, scoredAt: null },
  noBidReasons: [{ key: 'NO_CAPACITY', label: 'No capacity to deliver right now' }],
}

const startedScorecard = (over: Record<string, unknown> = {}) => ({
  data: {
    exists: true,
    ...VIEW_EXTRAS,
    pursuit: { id: 'p1', pipelineStage: 'QUALIFICATION', opportunity: { id: 'o1', title: 'Radar Sustainment', agency: 'DoD' } },
    scorecard: {
      id: 'sc1', status: 'NOT_REVIEWED', totalScore: 85, recommendation: 'BID', recommendationVersion: 'scorecard-v1',
      finalDecision: null, isOverride: false, overrideReason: null, decidedByUserId: null, decidedAt: null,
      reviewerUserId: null, reviewerComments: null, submittedForReviewAt: null,
      criteria: [
        { id: 'c1', key: 'capability_fit', name: 'Capability fit', description: 'fit', weight: 40, score: 85, required: true, displayOrder: 1, evidence: null },
        { id: 'c2', key: 'competition', name: 'Competition', description: null, weight: 60, score: 85, required: true, displayOrder: 2, evidence: null },
      ],
      history: [{ id: 'h1', status: 'NOT_REVIEWED', recommendation: 'REVIEW_REQUIRED', totalScore: 0, isOverride: false, overrideReason: null, changeReason: 'Qualification started', createdAt: '2026-08-06T00:00:00Z' }],
      ...(over.scorecard as object ?? {}),
    },
    computed: { totalScore: 85, recommendation: 'BID', complete: true, missingRequiredKeys: [], recommendationVersion: 'scorecard-v1', ...(over.computed as object ?? {}) },
  },
})

beforeEach(() => {
  role = 'ADMIN'
  getScorecard.mockReset(); decide.mockReset(); gatesForPursuit.mockReset(); users.mockReset()
  gatesForPursuit.mockResolvedValue({ data: [] })
  users.mockResolvedValue({ data: [{ id: 'admin-1', firstName: 'Ada', lastName: 'Byte', email: 'ada@f.com', role: 'ADMIN' }] })
  decide.mockResolvedValue({ data: {} })
})

describe('QualificationPage (§5.2)', () => {
  it('shows a loading spinner initially', () => {
    getScorecard.mockReturnValue(new Promise(() => {}))
    const { container } = renderPage()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('shows an error state on failure', async () => {
    getScorecard.mockRejectedValue(new Error('boom'))
    renderPage()
    expect(await screen.findByText(/could not load the scorecard/i)).toBeInTheDocument()
  })

  it('offers a Start button when not yet started (admin)', async () => {
    getScorecard.mockResolvedValue({ data: { exists: false, pursuit: { id: 'p1', pipelineStage: 'IDENTIFIED', opportunity: { id: 'o1', title: 'X', agency: 'DoD' } } } })
    renderPage()
    expect(await screen.findByRole('button', { name: /start scorecard/i })).toBeInTheDocument()
    expect(screen.getByText(/suggested scores from your records/i)).toBeInTheDocument()
  })

  it('renders criteria, weights, weighted total and the system recommendation', async () => {
    getScorecard.mockResolvedValue(startedScorecard())
    renderPage()
    expect(await screen.findByText('Capability fit')).toBeInTheDocument()
    expect(screen.getByText('85/100')).toBeInTheDocument() // weighted total
    expect(screen.getByText('System recommendation')).toBeInTheDocument()
    expect(screen.getAllByText('Bid').length).toBeGreaterThan(0)
    // The engine's view is shown as an input, not the decision.
    expect(screen.getByText('42%')).toBeInTheDocument()
  })

  it('requires an override reason when the decision differs from the recommendation', async () => {
    getScorecard.mockResolvedValue(startedScorecard())
    renderPage()
    await screen.findByText('Capability fit')
    // recommendation is BID; choosing No-bid needs a reason to pass AND a reason for overriding
    fireEvent.click(screen.getByRole('button', { name: 'No-bid' }))
    expect(await screen.findByText(/Say why \(at least 20 characters\)/i)).toBeInTheDocument()
    const record = screen.getByRole('button', { name: /record decision/i })
    expect(record).toBeDisabled() // blocked until both reasons are given
    fireEvent.change(screen.getByLabelText(/differs from the Bid recommendation/i), { target: { value: 'Leadership pulled resourcing' } })
    expect(record).toBeDisabled() // still needs the no-bid reason
    fireEvent.change(screen.getByLabelText(/Why not bid/i), { target: { value: 'NO_CAPACITY' } })
    await waitFor(() => expect(record).not.toBeDisabled())
    fireEvent.click(record)
    await waitFor(() => expect(decide).toHaveBeenCalledWith('p1', { decision: 'NO_BID', overrideReason: 'Leadership pulled resourcing', noBidReason: 'NO_CAPACITY', noBidNote: undefined }, null))
  })

  it('shows the decision history', async () => {
    getScorecard.mockResolvedValue(startedScorecard())
    renderPage()
    expect(await screen.findByText(/Decision history/i)).toBeInTheDocument()
    expect(screen.getByText(/Qualification started/i)).toBeInTheDocument()
  })

  it('is read-only for a CONSULTANT (no score inputs, note shown)', async () => {
    getScorecard.mockResolvedValue(startedScorecard())
    role = 'CONSULTANT'
    renderPage()
    await screen.findByText('Capability fit')
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/Score for Capability fit/i)).not.toBeInTheDocument()
  })

  it('surfaces a human-override badge when a decided scorecard was overridden', async () => {
    getScorecard.mockResolvedValue(startedScorecard({ scorecard: { status: 'NO_BID', finalDecision: 'NO_BID', isOverride: true, overrideReason: 'Directed elsewhere', decidedAt: '2026-08-06T01:00:00Z' } }))
    renderPage()
    expect((await screen.findAllByText(/differs from the recommendation/i)).length).toBeGreaterThan(0)
    expect(screen.getByText(/Directed elsewhere/i)).toBeInTheDocument()
  })
})

describe('QualificationPage — What to do next', () => {
  const journeyWith = (next: { text: string; action: { label: string; to: string } | null } | null) => ({ data: {
    pursuitId: 'p1', stage: 'QUALIFICATION', stageLabel: 'Qualify', steps: [], lastDone: null, outcomeActions: false, warning: null, also: null,
    status: { text: 'Decided to bid.', where: { label: 'Pipeline', to: '/pipeline' } }, next,
  } })
  beforeEach(() => { gatesForPursuit.mockResolvedValue({ data: [] }); users.mockResolvedValue({ data: [] }); getScorecard.mockResolvedValue(startedScorecard()) })

  it('ends the page with the next step and a button to where it is done', async () => {
    journey.mockResolvedValue(journeyWith({ text: 'Start the proposal: outline, draft and approve its sections.', action: { label: 'Open the proposal workspace', to: '/opportunities/o1/proposal' } }))
    renderPage()
    expect(await screen.findByRole('heading', { name: 'What to do next' })).toBeInTheDocument()
    expect(screen.getByText(/Start the proposal/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open the proposal workspace/ })).toHaveAttribute('href', '/opportunities/o1/proposal')
  })

  it('points to the scorecard on this page when the next step is qualifying', async () => {
    journey.mockResolvedValue(journeyWith({ text: 'Resolve the conditions, then record a final Bid or No-bid.', action: { label: 'Open the Qualify panel', to: '/opportunities/o1#qualify' } }))
    renderPage()
    expect(await screen.findByRole('button', { name: /Do it here: go to the scorecard/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Open the Qualify panel/ })).not.toBeInTheDocument()
  })
})
