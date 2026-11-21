// "What to do next" on a step's page: a button to the next step's page, or —
// when the next step is done on this page — a button that goes to it here.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
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

  it('on the page of the "also" work (pricing while writing), shows that work with its own button', async () => {
    journey.mockResolvedValue(j({
      next: { text: 'Draft and approve the remaining 2 sections.', action: { label: 'Write the proposal', to: '/opportunities/o1/proposal' } },
      also: { text: 'You can build your price at the same time.', action: { label: 'Build the price', to: '/opportunities/o1/pricing' } },
    }))
    const onHere = renderAt('/opportunities/o1/pricing')
    expect(await screen.findByRole('link', { name: /Write the proposal/ })).toBeInTheDocument()
    expect(screen.getByText('On this page: You can build your price at the same time.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Build the price/ }))
    expect(onHere).toHaveBeenCalled()
  })
  it('shows "also" advice with its link on another page', async () => {
    journey.mockResolvedValue(j({
      next: { text: 'Draft and approve the remaining 2 sections.', action: { label: 'Write the proposal', to: '/opportunities/o1/proposal' } },
      also: { text: 'You can build your price at the same time.', action: { label: 'Build the price', to: '/opportunities/o1/pricing' } },
    }))
    renderAt('/opportunities/o1/proposal')
    expect(await screen.findByText(/You can build your price at the same time/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Build the price/ })).toHaveAttribute('href', '/opportunities/o1/pricing')
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

describe('NextStepCard — doing the step from the guide', () => {
  const pricing = (label: string) => ({ current: { step: 'Price', number: 5, of: 8, what: 'Check the price, send it for review, then approve it.', action: { label, to: '/opportunities/o1/pricing' } }, then: { step: 'Package', action: { label: 'Prepare the submission', to: '/opportunities/o1/submission' } } })
  function Where() { return <p data-testid="where">{useLocation().pathname}</p> }
  function renderDoing(run: () => Promise<unknown>, label: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/opportunities/o1/pricing']}>
          <Routes><Route path="*" element={<><Where /><NextStepCard opportunityId="o1" isHere={(to) => to.endsWith('/pricing')} doHere={{ label, run }} /></>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('sends the price for review and stays, since approving it is done here too', async () => {
    journey.mockResolvedValue(j(pricing('Approve the price')))
    const run = vi.fn().mockResolvedValue(undefined)
    renderDoing(run, 'Submit the price for review')
    fireEvent.click(await screen.findByRole('button', { name: /Submit the price for review/ }))
    await waitFor(() => expect(run).toHaveBeenCalled())
    await waitFor(() => expect(journey).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('where')).toHaveTextContent('/opportunities/o1/pricing')
  })

  it('approves the price, then goes to the page of the next step', async () => {
    journey.mockResolvedValueOnce(j(pricing('Approve the price')))
      .mockResolvedValue(j({ current: { step: 'Package', number: 6, of: 8, what: 'Prepare the submission.', action: { label: 'Prepare the submission', to: '/opportunities/o1/submission' } }, then: null }))
    const run = vi.fn().mockResolvedValue(undefined)
    renderDoing(run, 'Approve the price')
    fireEvent.click(await screen.findByRole('button', { name: /Approve the price/ }))
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/opportunities/o1/submission'))
  })

  it('stays put when the action fails', async () => {
    journey.mockResolvedValue(j(pricing('Approve the price')))
    renderDoing(vi.fn().mockRejectedValue(new Error('no')), 'Approve the price')
    fireEvent.click(await screen.findByRole('button', { name: /Approve the price/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Approve the price/ })).not.toBeDisabled())
    expect(screen.getByTestId('where')).toHaveTextContent('/opportunities/o1/pricing')
  })
})

function Where() { return <p data-testid="where">{useLocation().pathname}</p> }

describe('NextStepCard — pricing while the writing goes on', () => {
  it("runs the page's own action for the also work, and stays on the page", async () => {
    journey.mockResolvedValue(j({
      current: { step: 'Proposal', number: 4, of: 9, what: 'Write each section and approve it.', action: { label: 'Write and approve sections', to: '/opportunities/o1/proposal' } },
      then: { step: 'Price', action: { label: 'Build the price', to: '/opportunities/o1/pricing' } },
      also: { text: 'You can get your price reviewed and approved now.', action: { label: 'Build the price', to: '/opportunities/o1/pricing' } },
    }))
    const run = vi.fn().mockResolvedValue(undefined)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/opportunities/o1/pricing']}>
          <Routes><Route path="*" element={<><Where /><NextStepCard opportunityId="o1" isHere={(to) => to.endsWith('/pricing')} doHere={{ label: 'Submit the price for review', run }} /></>} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('link', { name: /Write and approve sections/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Submit the price for review/ }))
    await waitFor(() => expect(run).toHaveBeenCalled())
    await waitFor(() => expect(journey).toHaveBeenCalledTimes(2))
    // Writing is still the step: it stays here rather than jumping to the proposal.
    expect(screen.getByTestId('where')).toHaveTextContent('/opportunities/o1/pricing')
  })
})

describe('NextStepCard — no repeated buttons', () => {
  it('drops the "Also" link when "Next step" already opens the same page', async () => {
    journey.mockResolvedValue(j({
      current: { step: 'Proposal', number: 4, of: 9, what: 'Write each section and approve it.', action: { label: 'Write and approve sections', to: '/opportunities/o1/proposal' } },
      then: { step: 'Price', action: { label: 'Build the price', to: '/opportunities/o1/pricing' } },
      also: { text: 'You can build your price at the same time.', action: { label: 'Build the price', to: '/opportunities/o1/pricing' } },
    }))
    renderAt('/opportunities/o1/proposal')
    expect(await screen.findByRole('link', { name: /Next step: Price/ })).toHaveAttribute('href', '/opportunities/o1/pricing')
    expect(screen.queryByText(/You can build your price at the same time/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('link')).toHaveLength(1)
  })
})

