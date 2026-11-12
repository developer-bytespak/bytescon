// Opportunities shows every notice by default; "Matches my business type"
// narrows it (backend services/opportunityMatch.ts).
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const search = vi.fn()
const matchOptions = vi.fn()
vi.mock('../services/api', () => ({
  opportunitiesApi: { search: (p: unknown) => search(p), matchOptions: () => matchOptions(), exportPipeline: vi.fn() },
  jobsApi: { getJob: vi.fn(), triggerEnrich: vi.fn(), triggerIngest: vi.fn() },
  firmApi: { get: () => Promise.resolve({ data: {} }) },
}))
vi.mock('../services/fetchHistoryApi', () => ({ fetchHistoryApi: new Proxy({}, { get: () => vi.fn().mockResolvedValue({ data: [] }) }) }))
vi.mock('../components/TutorialOverlay', () => ({ TutorialOverlay: () => null }))
vi.mock('../hooks/useTutorial', () => ({ useTutorial: () => ({ hasSeen: () => true, markSeen: vi.fn() }) }))
vi.mock('../components/MonitoringProfiles', () => ({ MonitoringProfiles: () => null }))
vi.mock('../hooks/useExportCsv', () => ({ useExportCsv: () => ({ exporting: false, exportCsv: vi.fn(), note: null }) }))

import { OpportunitiesPage } from './Opportunities'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><OpportunitiesPage /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  search.mockReset(); matchOptions.mockReset()
  search.mockResolvedValue({ data: [], meta: { page: 1, limit: 25, total: 0, totalPages: 1, match: { mode: 'all', prefixes: null } } })
})

describe('Opportunities — Matches my business type', () => {
  it('lists every notice by default and offers the business type and each client', async () => {
    matchOptions.mockResolvedValue({ data: { businessType: { label: 'Health Care' }, clients: [{ id: 'c1', name: 'Cabling Co', hasNaics: true }, { id: 'c2', name: 'New Co', hasNaics: false }] } })
    renderPage()
    const select = await screen.findByLabelText('Matches my business type')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Matches my business type (Health Care)' })).toBeInTheDocument())
    expect(select).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Matches any of my clients' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'New Co (no NAICS codes yet)' })).toBeInTheDocument()
    await waitFor(() => expect(search).toHaveBeenCalled())
    expect(search.mock.calls[0][0]).not.toHaveProperty('match', expect.anything())
  })

  it('sends the chosen match to the server', async () => {
    matchOptions.mockResolvedValue({ data: { businessType: null, clients: [{ id: 'c1', name: 'Cabling Co', hasNaics: true }] } })
    renderPage()
    const select = await screen.findByLabelText('Matches my business type')
    await waitFor(() => expect(screen.getByRole('option', { name: 'Cabling Co' })).toBeInTheDocument())
    expect(screen.queryByRole('option', { name: /Matches my business type \(/ })).not.toBeInTheDocument()
    fireEvent.change(select, { target: { value: 'client:c1' } })
    await waitFor(() => expect(search.mock.calls.some(([p]) => (p as { match?: string }).match === 'client:c1')).toBe(true))
  })
})
