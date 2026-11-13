// Status and next step: the bar on the opportunity page, the outcome buttons,
// and the pop-up after an action.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }) }))
const toast = vi.fn()
vi.mock('../Toast', () => ({ useToast: () => ({ toast }) }))
const journey = vi.fn()
const setStage = vi.fn()
vi.mock('../../services/api', () => ({
  opportunitiesApi: { journey: (...a: unknown[]) => journey(...a) },
  pipelineApi: { setStage: (...a: unknown[]) => setStage(...a) },
}))

import { JourneyBar } from './JourneyBar'
import { nextStepMessage, type Journey } from '../../hooks/useNextStep'

const steps = (current: number) => ['Identified', 'Qualify', 'Capture', 'Proposal', 'Submitted', 'Award']
  .map((label, i) => ({ key: label.toUpperCase(), label, state: (i < current ? 'done' : i === current ? 'current' : 'todo') as 'done' | 'current' | 'todo' }))

const capture: Journey = {
  pursuitId: 'p1', stage: 'CAPTURE', stageLabel: 'Capture', steps: steps(2),
  lastDone: 'Decision recorded: Bid.',
  status: { text: 'Capture: you are bidding, proposal not started.', where: { label: 'Pipeline → Capture', to: '/pipeline' } },
  next: { text: 'Start the proposal: outline, draft and approve its sections.', action: { label: 'Open the proposal workspace', to: '/opportunities/o1/proposal' } },
  outcomeActions: false, warning: null,
}

function renderBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><JourneyBar opportunityId="o1" /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => { journey.mockReset(); setStage.mockReset(); toast.mockReset() })

describe('JourneyBar', () => {
  it('shows what is done, where it stands and where to check it, and the next step with its link', async () => {
    journey.mockResolvedValue({ data: capture })
    renderBar()
    expect(await screen.findByText('Decision recorded: Bid.')).toBeInTheDocument()
    expect(screen.getByText(/Capture: you are bidding/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'See it in Pipeline → Capture' })).toHaveAttribute('href', '/pipeline')
    expect(screen.getByRole('link', { name: /Open the proposal workspace/ })).toHaveAttribute('href', '/opportunities/o1/proposal')
    expect(screen.getByText('Capture').closest('li')).toHaveAttribute('aria-current', 'step')
  })

  it('records the outcome of a submitted bid, then shows the next step', async () => {
    journey.mockResolvedValueOnce({ data: { ...capture, stage: 'SUBMITTED', outcomeActions: true, next: { text: 'When the agency announces the award, record whether you won or lost.', action: null } } })
    journey.mockResolvedValue({ data: { ...capture, stage: 'AWARDED', lastDone: 'Recorded as won.', status: { text: 'Won.', where: capture.status.where }, next: { text: 'Set up the contract.', action: { label: 'Go to Contracts', to: '/contracts' } } } })
    setStage.mockResolvedValue({})
    renderBar()
    fireEvent.click(await screen.findByRole('button', { name: /Mark as won/ }))
    await waitFor(() => expect(setStage).toHaveBeenCalledWith('p1', 'AWARDED'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Recorded as won.', 'success', { detail: 'Now: Won. Next: Set up the contract.', action: { label: 'Go to Contracts', to: '/contracts' } }))
  })

  it('suggests pricing alongside the writing', async () => {
    journey.mockResolvedValue({ data: { ...capture, stage: 'PROPOSAL', stageLabel: 'Proposal',
      next: { text: 'Draft and approve the remaining 3 sections.', action: { label: 'Open the proposal workspace', to: '/opportunities/o1/proposal' } },
      also: { text: 'You can build your price at the same time.', action: { label: 'Open the Pricing workspace', to: '/opportunities/o1/pricing' } } } })
    renderBar()
    expect(await screen.findByText(/Also: You can build your price at the same time./)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open the Pricing workspace' })).toHaveAttribute('href', '/opportunities/o1/pricing')
  })

  it('warns when the deadline has passed', async () => {
    journey.mockResolvedValue({ data: { ...capture, warning: 'The response deadline passed on Nov 1, 2026.' } })
    renderBar()
    expect(await screen.findByText('The response deadline passed on Nov 1, 2026.')).toBeInTheDocument()
  })
})

describe('nextStepMessage', () => {
  it('says what was done, where it stands and what is next, linking to where the next step is done', () => {
    expect(nextStepMessage(capture, 'Proposal started.')).toEqual({
      message: 'Proposal started.',
      detail: 'Now: Capture: you are bidding, proposal not started. Next: Start the proposal: outline, draft and approve its sections.',
      action: { label: 'Open the proposal workspace', to: '/opportunities/o1/proposal' },
    })
  })

  it('mentions what can be done alongside', () => {
    const m = nextStepMessage({ ...capture, also: { text: 'You can build your price at the same time.', action: { label: 'Open the Pricing workspace', to: '/x' } } })
    expect(m.detail).toMatch(/Also: You can build your price at the same time.$/)
  })

  it('links to where to check the status when the next step has no page of its own', () => {
    const m = nextStepMessage({ ...capture, next: { text: 'Record the outcome.', action: null } })
    expect(m.message).toBe('Decision recorded: Bid.')
    expect(m.action).toEqual({ label: 'Pipeline → Capture', to: '/pipeline' })
  })
})
