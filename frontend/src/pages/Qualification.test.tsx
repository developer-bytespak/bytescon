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
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'admin-1', role } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const getScorecard = vi.fn()
const decide = vi.fn()
const gatesForPursuit = vi.fn()
const users = vi.fn()
vi.mock('../services/api', () => ({
  qualificationApi: {
    get: () => getScorecard(), start: vi.fn(), score: vi.fn(), submitReview: vi.fn(), decide: (...a: unknown[]) => decide(...a), reassess: vi.fn(),
  },
  gateReviewsApi: { listForPursuit: () => gatesForPursuit(), create: vi.fn(), submit: vi.fn(), approve: vi.fn(), reject: vi.fn(), requestChanges: vi.fn(), waive: vi.fn() },
  firmApi: { users: () => users() },
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

const startedScorecard = (over: Record<string, unknown> = {}) => ({
  data: {
    exists: true,
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
    expect(await screen.findByRole('button', { name: /start qualification/i })).toBeInTheDocument()
  })

  it('renders criteria, weights, weighted total and the system recommendation', async () => {
    getScorecard.mockResolvedValue(startedScorecard())
    renderPage()
    expect(await screen.findByText('Capability fit')).toBeInTheDocument()
    expect(screen.getByText('85/100')).toBeInTheDocument() // weighted total
    expect(screen.getByText('System recommendation')).toBeInTheDocument()
    expect(screen.getAllByText('BID').length).toBeGreaterThan(0)
  })

  it('requires an override reason when the decision differs from the recommendation', async () => {
    getScorecard.mockResolvedValue(startedScorecard())
    renderPage()
    await screen.findByText('Capability fit')
    // recommendation is BID; choosing NO_BID triggers the override reason requirement
    fireEvent.click(screen.getByRole('button', { name: 'NO BID' }))
    expect(await screen.findByText(/a reason of at least 20 characters is required/i)).toBeInTheDocument()
    const record = screen.getByRole('button', { name: /record decision/i })
    expect(record).toBeDisabled() // blocked until a reason is entered
    fireEvent.change(screen.getByPlaceholderText(/override reason/i), { target: { value: 'Leadership pulled resourcing' } })
    await waitFor(() => expect(record).not.toBeDisabled())
    fireEvent.click(record)
    await waitFor(() => expect(decide).toHaveBeenCalledWith('p1', { decision: 'NO_BID', overrideReason: 'Leadership pulled resourcing' }))
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
    expect(await screen.findByText(/Human override/i)).toBeInTheDocument()
    expect(screen.getByText(/Directed elsewhere/i)).toBeInTheDocument()
  })
})
