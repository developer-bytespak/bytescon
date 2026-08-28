// =============================================================
// Section 4 #8 — the "Log Submission" action must stay disabled until the data
// its form needs (clients + opportunities) has loaded, so it can't be clicked
// into an empty/half-ready form.
// =============================================================
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listClients = vi.fn()
const searchOpps = vi.fn()

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'ADMIN' } }) }))
vi.mock('../services/api', () => ({
  submissionsApi: {
    list: () => Promise.resolve({ data: [] }),
    pendingOutcomes: () => Promise.resolve({ meta: { pendingCount: 0 } }),
    recordOutcome: vi.fn(),
    create: vi.fn(),
  },
  clientsApi: { list: () => listClients() },
  opportunitiesApi: { search: () => searchOpps() },
}))

import { SubmissionsPage } from './Submissions'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <SubmissionsPage />
    </QueryClientProvider>,
  )
}

const logButton = () => screen.getByRole('button', { name: /log submission/i })

describe('SubmissionsPage — Log Submission gating (Section 4 #8)', () => {
  beforeEach(() => {
    listClients.mockReset()
    searchOpps.mockReset()
  })

  it('disables the action while the form dependency data is still loading', () => {
    // Queries never resolve → perpetual loading state.
    listClients.mockReturnValue(new Promise(() => {}))
    searchOpps.mockReturnValue(new Promise(() => {}))

    renderPage()
    expect(logButton()).toBeDisabled()
  })

  it('enables the action once clients and opportunities have loaded', async () => {
    listClients.mockResolvedValue({ data: [{ id: 'c1', name: 'Client One' }] })
    searchOpps.mockResolvedValue({ data: [{ id: 'o1', title: 'Opp One' }] })

    renderPage()
    await waitFor(() => expect(logButton()).toBeEnabled())
  })
})
