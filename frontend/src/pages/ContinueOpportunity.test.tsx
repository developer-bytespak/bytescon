// A contract opened from the Pipeline lands where its current step is done.
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Journey } from '../hooks/journey'

const journey = vi.fn()
vi.mock('../services/api', () => ({ opportunitiesApi: { journey: (...a: unknown[]) => journey(...a) } }))

import ContinueOpportunity, { continueTarget } from './ContinueOpportunity'

const j = (stage: string | null, to: string | null, pursuitId: string | null = 'pur1'): Journey => ({
  pursuitId, stage, stageLabel: stage ?? '', steps: [], lastDone: null, outcomeActions: false, warning: null,
  status: { text: '', where: { label: 'Pipeline', to: '/pipeline' } }, next: null,
  current: to ? { step: 'X', number: 1, of: 8, what: '', action: { label: 'Go', to } } : null, then: null,
})

describe('continueTarget', () => {
  it('opens each stage where its work is done', () => {
    expect(continueTarget('o1', j('IDENTIFIED', '/opportunities/o1#qualify'))).toBe('/opportunities/o1#qualify')
    expect(continueTarget('o1', j('QUALIFICATION', '/opportunities/o1#qualify'))).toBe('/pipeline/pur1#decision')
    expect(continueTarget('o1', j('CAPTURE', '/opportunities/o1/proposal'))).toBe('/opportunities/o1/proposal')
    // Proposal written: the guide's step is the price, then the submission.
    expect(continueTarget('o1', j('PROPOSAL', '/opportunities/o1/pricing'))).toBe('/opportunities/o1/pricing')
    expect(continueTarget('o1', j('PROPOSAL', '/opportunities/o1/submission'))).toBe('/opportunities/o1/submission')
  })
  it('opens the opportunity page once the bid is submitted or closed, or when nothing is known', () => {
    expect(continueTarget('o1', j('SUBMITTED', null))).toBe('/opportunities/o1')
    expect(continueTarget('o1', j('AWARDED', '/contracts'))).toBe('/opportunities/o1')
    expect(continueTarget('o1', j('NO_BID', '/opportunities/o1#qualify'))).toBe('/opportunities/o1')
    expect(continueTarget('o1', null)).toBe('/opportunities/o1')
  })
})

describe('ContinueOpportunity', () => {
  beforeEach(() => journey.mockReset())
  function Where() { return <p data-testid="where">{useLocation().pathname + useLocation().search + useLocation().hash}</p> }
  const renderAt = (path: string) => render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/opportunities/:id/continue" element={<ContinueOpportunity />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  it('goes to the step and keeps the client a consulting firm opened it for', async () => {
    journey.mockResolvedValue({ data: j('PROPOSAL', '/opportunities/o1/pricing') })
    renderAt('/opportunities/o1/continue?client=c9')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/opportunities/o1/pricing?client=c9'))
    expect(journey).toHaveBeenCalledWith('o1', 'c9')
  })
  it('falls back to the opportunity page when the journey says nothing', async () => {
    journey.mockResolvedValue({ data: null })
    renderAt('/opportunities/o1/continue')
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/opportunities\/o1$/))
  })
})
