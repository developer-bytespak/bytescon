// B25 — the status filter only offers statuses a lead can actually have.
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../services/api', async (original) => ({
  ...(await original<object>()),
  subcontractingApi: new Proxy({}, { get: () => vi.fn(async () => ({ data: { items: [], opportunities: [], total: 0, stats: {} } })) }),
}))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

import { SubcontractingPage } from './SubcontractingPage'

describe('the subcontracting status filter', () => {
  it('offers Open, Saved and Dismissed, and nothing the backend never sets', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter><SubcontractingPage /></MemoryRouter>
      </QueryClientProvider>,
    )
    const labels = (await screen.findAllByRole('option')).map((o) => o.textContent)
    expect(labels).toEqual(expect.arrayContaining(['OPEN', 'SAVED', 'DISMISSED']))
    expect(labels).not.toContain('CLOSED')
    expect(labels).not.toContain('AWARDED')
  })
})
