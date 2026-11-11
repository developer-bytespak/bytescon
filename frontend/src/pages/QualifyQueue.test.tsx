// "To qualify" queue: notices with readiness and AI score, quick no-bid with a
// reason, watch, keyboard shortcuts and "why we pass".
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }), useIsContractor: () => true }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
const toggleFavorite = vi.fn()
vi.mock('../hooks/useFavorites', () => ({ useFavorites: () => ({ isFavorite: () => false, toggleFavorite }) }))

const queue = vi.fn()
const insights = vi.fn()
const quickNoBid = vi.fn()
vi.mock('../services/api', () => ({
  clientsApi: { list: vi.fn() },
  qualificationApi: { queue: (...a: unknown[]) => queue(...a), insights: (...a: unknown[]) => insights(...a), quickNoBid: (...a: unknown[]) => quickNoBid(...a) },
}))

import { QualifyQueuePage } from './QualifyQueue'

const item = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  opportunityId: id, title, agency: 'VA', naicsCode: '238210', setAsideType: 'SDVOSB', responseDeadline: '2026-12-15T19:00:00Z',
  daysLeft: 33, estimatedValue: 1_200_000, pursuitId: null, pipelineStage: null, winProbability: 0.58,
  readiness: { verdict: 'READY', problems: [] }, scorecard: null, ...over,
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><QualifyQueuePage /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  queue.mockReset(); insights.mockReset(); quickNoBid.mockReset(); toggleFavorite.mockReset()
  queue.mockResolvedValue({ data: { items: [item('o1', 'Cabling upgrade'), item('o2', 'Fence repair', { readiness: { verdict: 'NOT_ELIGIBLE', problems: ['Set-aside eligibility'] }, winProbability: null, daysLeft: 4 })], noBidReasons: [{ key: 'TOO_COMPETITIVE', label: 'Too competitive, or a strong incumbent' }] } })
  insights.mockResolvedValue({ data: { days: 90, decided: 5, byDecision: { BID: 2, NO_BID: 3 }, noBidReasons: [{ reason: 'TOO_COMPETITIVE', label: 'Too competitive, or a strong incumbent', count: 2 }, { reason: 'NO_CAPACITY', label: 'No capacity to deliver right now', count: 1 }], quickNoBids: 2 } })
})

describe('QualifyQueuePage', () => {
  it('lists notices with deadline, readiness and AI score, linking each to its qualify panel', async () => {
    renderPage()
    const link = await screen.findByRole('link', { name: 'Cabling upgrade' })
    expect(link).toHaveAttribute('href', '/opportunities/o1#qualify')
    expect(screen.getByText('Ready to bid')).toBeInTheDocument()
    expect(screen.getByText('AI 58%')).toBeInTheDocument()
    expect(screen.getByText('Not eligible')).toHaveAttribute('title', 'Problems: Set-aside eligibility')
    expect(screen.getByText('4 days left')).toBeInTheDocument()
    expect(queue).toHaveBeenCalledWith({ clientCompanyId: null, sort: 'fit', includeDecided: false, limit: 100 })
  })

  it('passes on a notice only once a reason is chosen', async () => {
    quickNoBid.mockResolvedValue({ data: {} })
    renderPage()
    await screen.findByRole('link', { name: 'Cabling upgrade' })
    fireEvent.click(screen.getAllByRole('button', { name: 'No-bid' })[0])
    const confirm = screen.getByRole('button', { name: 'Confirm no-bid' })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/Why not bid/), { target: { value: 'TOO_COMPETITIVE' } })
    fireEvent.change(screen.getByLabelText(/Note/), { target: { value: 'Incumbent since 2019' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(quickNoBid).toHaveBeenCalledWith('o1', { reason: 'TOO_COMPETITIVE', note: 'Incumbent since 2019' }, null))
  })

  it('works from the keyboard on a notice title: n opens the no-bid form, w watches, arrows move', async () => {
    renderPage()
    const first = await screen.findByRole('link', { name: 'Cabling upgrade' })
    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowDown' })
    expect(screen.getByRole('link', { name: 'Fence repair' })).toHaveFocus()
    fireEvent.keyDown(screen.getByRole('link', { name: 'Fence repair' }), { key: 'w' })
    expect(toggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ id: 'o2', title: 'Fence repair' }))
    fireEvent.keyDown(screen.getByRole('link', { name: 'Fence repair' }), { key: 'n' })
    await waitFor(() => expect(screen.getByLabelText(/Why not bid/)).toHaveFocus())
  })

  it('shows why the firm passes', async () => {
    renderPage()
    expect(await screen.findByText(/Most common reason to pass/)).toBeInTheDocument()
    expect(screen.getByLabelText('Why we pass')).toHaveTextContent('Too competitive, or a strong incumbent')
    expect(screen.getByLabelText('Why we pass')).toHaveTextContent('No capacity to deliver right now')
  })
})
