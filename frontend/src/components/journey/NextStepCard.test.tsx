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

describe('NextStepCard — the step guide', () => {
  const guide = {
    current: { step: 'Price', number: 5, of: 8, what: 'Check the price, send it for review, then approve it.', action: { label: 'Approve the price', to: '/opportunities/o1/pricing' } },
    then: { step: 'Package', action: { label: 'Prepare the submission', to: '/opportunities/o1/submission' } },
  }
  it('says which step this is and what finishing it means; one button when the step is on another page', async () => {
    journey.mockResolvedValue(j(guide))
    renderAt('/opportunities/o1/proposal')
    expect(await screen.findByRole('heading', { name: 'Step 5 of 8: Price' })).toBeInTheDocument()
    expect(screen.getByText('Check the price, send it for review, then approve it.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Approve the price/ })).toHaveAttribute('href', '/opportunities/o1/pricing')
    // The step after (Package) isn't offered: finishing the price comes first.
    expect(screen.queryByRole('link', { name: /Next step/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Then:/)).not.toBeInTheDocument()
  })
  it("on the step's own page, the finish button scrolls to it, with the step's own label", async () => {
    journey.mockResolvedValue(j(guide))
    const onHere = renderAt('/opportunities/o1/pricing')
    fireEvent.click(await screen.findByRole('button', { name: /Approve the price/ }))
    expect(onHere).toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /Next step: Package/ })).toBeInTheDocument()
  })
  it('at the end, shows the step with no buttons it cannot back', async () => {
    journey.mockResolvedValue(j({ current: { step: 'Award', number: 8, of: 8, what: 'Wait for the award, then record whether you won or lost.', action: null }, then: null }))
    renderAt('/opportunities/o1')
    expect(await screen.findByRole('heading', { name: 'Step 8 of 8: Award' })).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.queryByText(/Next step/)).not.toBeInTheDocument()
  })
})

