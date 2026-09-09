// =============================================================
// State & Municipal page — stats, list, filters, sources report, sync.
// =============================================================
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../components/AddonGate', () => ({ AddonGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const list = vi.fn()
const stats = vi.fn()
const syncStatus = vi.fn()
const sync = vi.fn()
vi.mock('../services/api', () => ({
  stateMunicipalApi: {
    list: (p: unknown) => list(p),
    stats: () => stats(),
    syncStatus: () => syncStatus(),
    sync: () => sync(),
    delete: vi.fn(),
    create: vi.fn(),
    previewImport: vi.fn(),
    bulkImport: vi.fn(),
  },
}))

import { StateMunicipalPage } from './StateMunicipalPage'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><StateMunicipalPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

const OPP = {
  id: 'o1', title: 'Bridge deck rehabilitation, Route 9', agency: 'NYS Department of Transportation', state: 'NY',
  contractLevel: 'STATE', naicsCode: '237310', estimatedValue: '2400000', responseDeadline: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  solicitationNumber: 'NYSCR-12345', sourceUrl: 'https://www.nyscr.ny.gov/Ads/Detail?adId=1', postedAt: null,
}

beforeEach(() => {
  list.mockReset(); stats.mockReset(); syncStatus.mockReset(); sync.mockReset()
  stats.mockResolvedValue({ success: true, data: { total: 3, byLevel: [{ contractLevel: 'STATE', _count: { _all: 2 } }, { contractLevel: 'MUNICIPAL', _count: { _all: 1 } }], byState: [{ state: 'NY', _count: { _all: 3 } }] } })
  list.mockResolvedValue({ success: true, data: { opportunities: [OPP], total: 1 } })
  syncStatus.mockResolvedValue({ success: true, data: { running: false, finishedAt: '2026-09-09T10:00:00Z', fetched: 85, created: 3, skipped: 82, bySource: { nyscr: 25, tx: 0, usaspending: 60, pa: 'failed' } } })
  sync.mockResolvedValue({ success: true })
})

describe('StateMunicipalPage', () => {
  it('shows stats, the sources report and the list', async () => {
    renderPage()
    expect(await screen.findByText('Bridge deck rehabilitation, Route 9')).toBeInTheDocument()
    expect(screen.getByText('NYS Department of Transportation')).toBeInTheDocument()
    expect(screen.getByText('NYSCR-12345 · NAICS 237310')).toBeInTheDocument()
    expect(screen.getByText('$2.4M')).toBeInTheDocument()
    expect(screen.getByText('5d left')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText(/85 rows fetched · 3 new · 82 already tracked/)).toBeInTheDocument())
    const chips = screen.getByTestId('source-chips')
    expect(chips).toHaveTextContent('NY Contract Reporter · 25')
    expect(chips).toHaveTextContent('TX ESBD · 0')
    expect(chips).toHaveTextContent('PA eMarketplace · failed')
    expect(screen.getByText('County & municipal')).toBeInTheDocument()
  })

  it('passes filters to the list query', async () => {
    renderPage()
    await screen.findByText('Bridge deck rehabilitation, Route 9')
    fireEvent.change(screen.getByLabelText('Search titles'), { target: { value: 'bridge' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'bridge', level: 'NON_FEDERAL' })))
    fireEvent.change(screen.getByLabelText('Filter by level'), { target: { value: 'MUNICIPAL' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ level: 'MUNICIPAL', search: 'bridge' })))
  })

  it('starts a sync and disables the button while one is running', async () => {
    renderPage()
    const btn = await screen.findByRole('button', { name: /sync sources/i })
    fireEvent.click(btn)
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(1))

    syncStatus.mockResolvedValue({ success: true, data: { running: true, startedAt: '2026-09-09T10:05:00Z' } })
    renderPage()
    await waitFor(() => expect(screen.getAllByRole('button', { name: /syncing/i })[0]).toBeDisabled())
    expect(screen.getAllByText('Pulling public portals now').length).toBeGreaterThan(0)
  })

  it('shows the empty state when nothing is tracked', async () => {
    stats.mockResolvedValue({ success: true, data: { total: 0, byLevel: [], byState: [] } })
    list.mockResolvedValue({ success: true, data: { opportunities: [], total: 0 } })
    renderPage()
    expect(await screen.findByText(/No state or municipal bids yet/)).toBeInTheDocument()
  })
})
