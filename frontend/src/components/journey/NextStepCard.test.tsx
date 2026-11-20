// "What to do next" on a step's page: a button to the next step's page, or —
// when the next step is done on this page — a button that goes to it here.
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const journey = vi.fn()
vi.mock('../../services/api', () => ({ opportunitiesApi: { journey: (...a: unknown[]) => journey(...a) } }))

import { NextStepCard } from './NextStepCard'

const j = (over: Record<string, unknown>) => ({ data: {
  pursuitId: 'p1', stage: 'PROPOSAL', stageLabel: 'Proposal', steps: [], lastDone: null, outcomeActions: false, warning: null, also: null,
  status: { text: 'Proposal: being written.', where: { label: 'Pipeline', to: '/pipeline' } }, next: null, ...over,
} })

function renderAt(path: string, onHere = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}><NextStepCard opportunityId="o1" isHere={(to) => to === path} hereLabel="Do it here" onHere={onHere} /></MemoryRouter>
    </QueryClientProvider>,
  )
  return onHere
}

beforeEach(() => journey.mockReset())

describe('NextStepCard', () => {
  it('on the Pricing page, once the price is approved, links to the Submission workspace', async () => {
    journey.mockResolvedValue(j({ next: { text: 'Set up the submission package and its checklist.', action: { label: 'Prepare the submission', to: '/opportunities/o1/submission' } } }))
    renderAt('/opportunities/o1/pricing')
    expect(await screen.findByText('What to do next')).toBeInTheDocument()
    expect(screen.getByText('Set up the submission package and its checklist.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Prepare the submission/ })).toHaveAttribute('href', '/opportunities/o1/submission')
  })

  it('when the next step is on this page, offers a button that goes to it here', async () => {
    journey.mockResolvedValue(j({ next: { text: 'Send your price for review and get it approved.', action: { label: 'Build the price', to: '/opportunities/o1/pricing' } } }))
    const onHere = renderAt('/opportunities/o1/pricing')
    fireEvent.click(await screen.findByRole('button', { name: /Do it here/ }))
    expect(onHere).toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: /Build the price/ })).not.toBeInTheDocument()
  })

  it('shows "also" advice without a link back to the page you are on', async () => {
    journey.mockResolvedValue(j({
      next: { text: 'Draft and approve the remaining 2 sections.', action: { label: 'Write the proposal', to: '/opportunities/o1/proposal' } },
      also: { text: 'You can build your price at the same time.', action: { label: 'Build the price', to: '/opportunities/o1/pricing' } },
    }))
    renderAt('/opportunities/o1/pricing')
    expect(await screen.findByText(/You can build your price at the same time/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Write the proposal/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Build the price/ })).not.toBeInTheDocument()
  })
})
