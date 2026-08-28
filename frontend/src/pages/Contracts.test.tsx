// =============================================================
// Section 5 Module 8 — Contracts page: loading/error/empty/loaded states,
// role-gated create control, and the global overdue/upcoming deliverable panels.
// =============================================================
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const list = vi.fn()
const overdue = vi.fn()
const upcoming = vi.fn()
vi.mock('../services/api', () => ({
  contractMgmtApi: {
    list: () => list(),
    overdueDeliverables: () => overdue(),
    upcomingDeliverables: () => upcoming(),
    create: vi.fn(),
  },
}))

import { ContractsPage } from './Contracts'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ContractsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  role = 'ADMIN'
  list.mockReset(); overdue.mockReset(); upcoming.mockReset()
  overdue.mockResolvedValue({ data: [] })
  upcoming.mockResolvedValue({ data: [] })
})

describe('ContractsPage (Section 5 Module 8)', () => {
  it('shows a loading spinner while contracts load', () => {
    list.mockReturnValue(new Promise(() => {}))
    const { container } = renderPage()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('shows an error state when the contracts query fails', async () => {
    list.mockRejectedValue(new Error('boom'))
    renderPage()
    expect(await screen.findByText(/could not load contracts/i)).toBeInTheDocument()
  })

  it('shows the empty state when there are no contracts', async () => {
    list.mockResolvedValue({ data: [], meta: { total: 0 } })
    renderPage()
    expect(await screen.findByText(/no contracts yet/i)).toBeInTheDocument()
  })

  it('renders contracts and the overdue/upcoming panels when loaded', async () => {
    list.mockResolvedValue({ data: [{ id: 'c1', contractNumber: 'FA-001', title: 'Base Support', agency: 'USAF', status: 'ACTIVE', awardValue: '1000000', fundedValue: '400000', endDate: '2027-01-01T00:00:00Z' }], meta: { total: 1 } })
    overdue.mockResolvedValue({ data: [{ id: 'd1', name: 'Late Report', dueDate: '2026-07-01T00:00:00Z', derivedStatus: 'OVERDUE', contract: { id: 'c1', contractNumber: 'FA-001', title: 'Base Support' } }] })
    renderPage()
    expect(await screen.findByText('Base Support')).toBeInTheDocument()
    expect(screen.getByText('FA-001')).toBeInTheDocument()
    expect(screen.getByText('Overdue deliverables')).toBeInTheDocument()
    expect(screen.getByText('Late Report')).toBeInTheDocument()
  })

  it('shows New Contract for ADMIN and hides it for CONSULTANT', async () => {
    list.mockResolvedValue({ data: [], meta: { total: 0 } })
    role = 'ADMIN'
    const { unmount } = renderPage()
    expect(await screen.findByRole('button', { name: /new contract/i })).toBeInTheDocument()
    unmount()

    role = 'CONSULTANT'
    renderPage()
    await screen.findByText(/no contracts yet/i)
    expect(screen.queryByRole('button', { name: /new contract/i })).not.toBeInTheDocument()
  })
})
