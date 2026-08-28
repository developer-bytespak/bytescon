// =============================================================
// Section 5 Module 9 — Timekeeping page: loading/empty/loaded states, ADMIN
// "Log time" + approval queue, CONSULTANT read-only (no controls).
// =============================================================
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const myTime = vi.fn()
const approvals = vi.fn()
const list = vi.fn()
vi.mock('../services/api', () => ({
  financeApi: { myTime: () => myTime(), approvals: () => approvals(), addTime: vi.fn(), submitTime: vi.fn(), approveTime: vi.fn(), rejectTime: vi.fn() },
  contractMgmtApi: { list: () => list() },
}))

import { TimekeepingPage } from './Timekeeping'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><TimekeepingPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  role = 'ADMIN'
  myTime.mockReset(); approvals.mockReset(); list.mockReset()
  list.mockResolvedValue({ data: [] })
  approvals.mockResolvedValue({ data: [] })
})

describe('TimekeepingPage (Section 5 Module 9)', () => {
  it('shows loading then the empty state for no time entries', async () => {
    myTime.mockResolvedValue({ data: [] })
    renderPage()
    expect(await screen.findByText(/no time logged yet/i)).toBeInTheDocument()
  })

  it('renders time entries with billing and status when loaded', async () => {
    myTime.mockResolvedValue({ data: [{ id: 't1', workDate: '2026-08-01T00:00:00Z', laborCategory: 'Engineer', hours: '8', billingAmount: '1200', status: 'APPROVED' }] })
    renderPage()
    expect(await screen.findByText('Engineer')).toBeInTheDocument()
    expect(screen.getByText('APPROVED')).toBeInTheDocument()
  })

  it('shows the ADMIN Log time button and approval queue', async () => {
    role = 'ADMIN'
    myTime.mockResolvedValue({ data: [] })
    approvals.mockResolvedValue({ data: [{ id: 's1', workDate: '2026-08-01T00:00:00Z', laborCategory: 'PM', hours: '4', contract: { contractNumber: 'C-1' } }] })
    renderPage()
    expect(await screen.findByRole('button', { name: /log time/i })).toBeInTheDocument()
    expect(screen.getByText('Approval queue')).toBeInTheDocument()
    expect(await screen.findByText('C-1')).toBeInTheDocument()
  })

  it('hides Log time + approval queue for a CONSULTANT (read-only)', async () => {
    role = 'CONSULTANT'
    myTime.mockResolvedValue({ data: [] })
    renderPage()
    await screen.findByText(/no time logged yet/i)
    expect(screen.queryByRole('button', { name: /log time/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Approval queue')).not.toBeInTheDocument()
  })
})
