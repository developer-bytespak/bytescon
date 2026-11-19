// =============================================================
// Civilian Programs — filtered to the company's state by default; any other
// state, or all states, can be picked.
// =============================================================
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const list = vi.fn()
const homeState = vi.fn()
vi.mock('../services/api', () => ({
  civilianApi: { list: (p: unknown) => list(p), homeState: () => homeState() },
}))

import { CivilianProgramsPage } from './CivilianProgramsPage'

const opp = (id: string, title: string, place: string) => ({
  id, title, agency: 'Example School District', noticeType: 'FCC Form 470', solicitationNumber: null,
  responseDeadline: null, placeOfPerformance: place, sourceUrl: null, description: null,
})

const renderPage = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><CivilianProgramsPage /></MemoryRouter>
  </QueryClientProvider>,
)

beforeEach(() => {
  list.mockReset()
  homeState.mockReset()
  list.mockImplementation((p: { state?: string }) => Promise.resolve({
    data: p.state === 'OH' ? [opp('2', 'Ohio Wi-Fi upgrade', 'Akron, OH')] : p.state ? [opp('1', 'Texas fiber', 'Austin, TX')] : [opp('1', 'Texas fiber', 'Austin, TX'), opp('2', 'Ohio Wi-Fi upgrade', 'Akron, OH')],
    meta: { total: 1 },
  }))
})

describe('CivilianProgramsPage', () => {
  it("shows the company's state first, and other states or all states on request", async () => {
    homeState.mockResolvedValue('TX')
    renderPage()
    expect(await screen.findByText('Texas fiber')).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ state: 'TX' }))
    // Never fetched unfiltered before the company's state was known.
    expect(list).not.toHaveBeenCalledWith(expect.objectContaining({ state: undefined }))
    expect(screen.getByRole('option', { name: 'Texas (your state)' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'OH' } })
    expect(await screen.findByText('Ohio Wi-Fi upgrade')).toBeInTheDocument()
    expect(screen.queryByText('Texas fiber')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('State'), { target: { value: '' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ state: undefined })))
    expect(await screen.findByText('Texas fiber')).toBeInTheDocument()
    expect(screen.getByText('Ohio Wi-Fi upgrade')).toBeInTheDocument()
  })

  it('shows all states, and says where to set one, when the company has no state yet', async () => {
    homeState.mockResolvedValue(null)
    renderPage()
    expect(await screen.findByText('Ohio Wi-Fi upgrade')).toBeInTheDocument()
    expect(screen.getByLabelText('State')).toHaveValue('')
    expect(screen.getByText(/Add your state to your company profile/)).toBeInTheDocument()
  })
})
