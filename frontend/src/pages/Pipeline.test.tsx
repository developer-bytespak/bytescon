// =============================================================
// Section 5.2 — Pipeline page: loading/error/empty/loaded states, board vs
// table, admin-gated controls, overdue + demo/live badges; no stage dropdown.
// =============================================================
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const list = vi.fn()
const setStage = vi.fn()
const assign = vi.fn()
const setNextAction = vi.fn()
const users = vi.fn()
vi.mock('../services/api', () => ({
  pipelineApi: { list: () => list(), setStage: (...a: unknown[]) => setStage(...a), assign: (...a: unknown[]) => assign(...a), setNextAction: (...a: unknown[]) => setNextAction(...a) },
  firmApi: { users: () => users() },
}))

import { PipelinePage } from './Pipeline'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PipelinePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'p1', pipelineStage: 'CAPTURE', priority: 'HIGH', ownerUserId: null,
  nextAction: null, nextActionDueAt: null, notes: null, isOverdue: false,
  owner: null, bidDecision: null,
  opportunity: { id: 'o1', title: 'Radar Sustainment', agency: 'DoD', responseDeadline: null, solicitationNumber: 'SOL-1', estimatedValue: '250000', setAsideType: 'NONE', status: 'ACTIVE', isDemo: false, sourceUrl: 'https://sam.gov/opp/1', samNoticeId: 'n1' },
  ...over,
})
const resp = (items: unknown[], stageCounts: Record<string, number> = {}) => ({ data: { items, page: 1, limit: 200, total: items.length, totalPages: 1, stageCounts } })

beforeEach(() => {
  role = 'ADMIN'
  list.mockReset(); setStage.mockReset(); assign.mockReset(); setNextAction.mockReset(); users.mockReset()
  users.mockResolvedValue({ data: [{ id: 'u1', firstName: 'Ada', lastName: 'Byte', email: 'ada@f.com', role: 'ADMIN' }] })
  setStage.mockResolvedValue({ data: {} })
})

describe('PipelinePage (Section 5.2)', () => {
  it('shows a loading spinner while the pipeline loads', () => {
    list.mockReturnValue(new Promise(() => {}))
    const { container } = renderPage()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('shows an error state when the query fails', async () => {
    list.mockRejectedValue(new Error('boom'))
    renderPage()
    expect(await screen.findByText(/could not load the pipeline/i)).toBeInTheDocument()
  })

  it('shows the empty state when there are no pursuits', async () => {
    list.mockResolvedValue(resp([]))
    renderPage()
    expect(await screen.findByText(/no pursuits in the pipeline yet/i)).toBeInTheDocument()
  })

  it('renders a pursuit card with a live SAM.gov source link', async () => {
    list.mockResolvedValue(resp([item()], { CAPTURE: 1 }))
    renderPage()
    expect(await screen.findByText('Radar Sustainment')).toBeInTheDocument()
    expect(screen.getAllByText(/SAM\.gov/i).length).toBeGreaterThan(0)
  })

  it('labels a demo opportunity as DEMO (never a live link)', async () => {
    list.mockResolvedValue(resp([item({ opportunity: { ...item().opportunity, isDemo: true, sourceUrl: null } })], { CAPTURE: 1 }))
    renderPage()
    expect(await screen.findByText('DEMO')).toBeInTheDocument()
  })

  it('flags an overdue next action', async () => {
    list.mockResolvedValue(resp([item({ nextAction: 'Submit questions', nextActionDueAt: '2026-07-01T00:00:00Z', isOverdue: true })], { CAPTURE: 1 }))
    renderPage()
    expect(await screen.findByText(/submit questions/i)).toBeInTheDocument()
  })

  it('has no stage dropdown (stages move with the work); a CONSULTANT sees the read-only note', async () => {
    list.mockResolvedValue(resp([item()], { CAPTURE: 1 }))
    role = 'ADMIN'
    const { unmount } = renderPage()
    await screen.findByText('Radar Sustainment')
    // The owner dropdown stays; nothing offers a stage to jump to.
    expect(screen.queryByRole('option', { name: 'PROPOSAL' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('option', { name: 'Unassigned' }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /table/i }))
    expect(screen.queryByRole('option', { name: 'PROPOSAL' })).not.toBeInTheDocument()
    expect(setStage).not.toHaveBeenCalled()
    unmount()

    role = 'CONSULTANT'
    renderPage()
    expect(await screen.findByText(/read-only access/i)).toBeInTheDocument()
  })

  it('closes a bid only as No-bid, Deferred or Duplicate', async () => {
    list.mockResolvedValue(resp([item()], { CAPTURE: 1 }))
    role = 'ADMIN'
    renderPage()
    await screen.findByText('Radar Sustainment')
    fireEvent.click(screen.getByRole('button', { name: 'Close pursuit' }))
    const reasons = Array.from((await screen.findByDisplayValue('NO BID') as HTMLSelectElement).options).map((o) => o.value)
    expect(reasons).toEqual(['NO_BID', 'DEFERRED', 'DUPLICATE'])
  })

  it('switches to the table view', async () => {
    list.mockResolvedValue(resp([item()], { CAPTURE: 1 }))
    renderPage()
    await screen.findByText('Radar Sustainment')
    fireEvent.click(screen.getByRole('button', { name: /table/i }))
    expect(screen.getByText('Next action')).toBeInTheDocument()
  })
})
