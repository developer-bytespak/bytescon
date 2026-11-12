// "Can I bid on this?" card: verdict, per-item status and fix text, the link
// to fix records, loading and error states.
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const readiness = vi.fn()
vi.mock('../services/api', () => ({ opportunitiesApi: { readiness: (id: string) => readiness(id) } }))

import { BidReadinessCard } from './BidReadinessCard'

function renderCard(clientCompanyId?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><BidReadinessCard opportunityId="opp-1" clientCompanyId={clientCompanyId} /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const DISCLAIMER = 'Not a legal determination — the contracting officer decides.'

beforeEach(() => { readiness.mockReset() })

describe('BidReadinessCard', () => {
  it('shows READY when every check passes', async () => {
    readiness.mockResolvedValue({ data: {
      verdict: 'READY', disclaimer: DISCLAIMER,
      items: [{ key: 'SAM', label: 'SAM.gov registration', status: 'PASS', detail: 'Active until 2027-06-01.' }],
    } })
    renderCard()
    expect(await screen.findByText('Ready to bid')).toBeInTheDocument()
    expect(screen.getByText('Active until 2027-06-01.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(readiness).toHaveBeenCalledWith('opp-1')
  })

  it('shows FIX_FIRST with the fix text and a link to update records', async () => {
    readiness.mockResolvedValue({ data: {
      verdict: 'FIX_FIRST', disclaimer: DISCLAIMER,
      items: [{ key: 'SAM', label: 'SAM.gov registration', status: 'FAIL', blocking: 'FIXABLE',
        detail: 'No SAM.gov registration is recorded for your firm.', fix: 'It usually takes 2 to 4 weeks, so start now.' }],
    } })
    renderCard()
    expect(await screen.findByText('Fix these first')).toBeInTheDocument()
    expect(screen.getByText(/2 to 4 weeks/)).toBeInTheDocument()
    // A contractor's SAM details are edited on My Company.
    expect(screen.getByRole('link', { name: /Update it on My Company/ })).toHaveAttribute('href', '/my-company')
  })

  it('sends each check to where it is fixed: profile, certifications or bonding', async () => {
    const items = [
      { key: 'NAICS', label: 'Industry code (NAICS)', status: 'WARN', detail: 'Not one of your codes.' },
      { key: 'SET_ASIDE', label: 'Set-aside eligibility', status: 'WARN', detail: 'No certification on record.' },
      { key: 'BONDING', label: 'Bonding', status: 'WARN', detail: 'No bonding capacity recorded.' },
      { key: 'DEADLINE', label: 'Response deadline', status: 'WARN', detail: 'Due soon.' },
    ]
    readiness.mockResolvedValue({ data: { verdict: 'FIX_FIRST', disclaimer: DISCLAIMER, items } })
    const { unmount } = renderCard()
    await screen.findByText('Fix these first')
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/my-company', '/registration', '/registration'])
    unmount()

    // A consulting firm's client: its details and certifications are on its page; bonding is the firm's.
    renderCard('c1')
    await screen.findByText('Fix these first')
    expect(screen.getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual(['/clients/c1', '/clients/c1', '/registration'])
  })

  it('shows NOT_ELIGIBLE', async () => {
    readiness.mockResolvedValue({ data: {
      verdict: 'NOT_ELIGIBLE', disclaimer: DISCLAIMER,
      items: [{ key: 'DEADLINE', label: 'Response deadline', status: 'FAIL', blocking: 'HARD', detail: 'The response deadline (2026-11-01) has passed.' }],
    } })
    renderCard()
    expect(await screen.findByText('Not eligible to bid')).toBeInTheDocument()
    expect(screen.getByText(DISCLAIMER)).toBeInTheDocument()
  })

  it('shows an error message when the check fails to load', async () => {
    readiness.mockRejectedValue(new Error('boom'))
    renderCard()
    expect(await screen.findByText(/couldn't run the bid readiness check/i)).toBeInTheDocument()
  })
})
