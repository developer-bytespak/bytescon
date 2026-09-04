// =============================================================
// Command palette — opens on Ctrl+K, filters, respects roles, navigates.
// =============================================================
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role: 'ADMIN' | 'CONSULTANT' = 'CONSULTANT'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role }, isAuthenticated: true }) }))
vi.mock('../hooks/useFavorites', () => ({ useFavorites: () => ({ favorites: [{ id: 'opp-1', title: 'Radar sustainment IDIQ' }], removeFavorite: vi.fn() }) }))
vi.mock('../hooks/useRecentlyViewed', () => ({ useRecentlyViewed: () => ({ items: [{ id: 'opp-2', title: 'Fleet telematics BPA' }], clearHistory: vi.fn() }) }))
vi.mock('../services/api', () => ({
  clientDocumentsApi: { canModerateTemplates: () => Promise.resolve({ data: { canModerate: false } }) },
}))

import { CommandPalette, useCommandPalette } from './CommandPalette'

function LocationProbe() {
  const { pathname } = useLocation()
  return <div data-testid="location">{pathname}</div>
}

function Harness() {
  const palette = useCommandPalette()
  return (
    <>
      <button onClick={() => palette.setOpen(true)}>open</button>
      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
      <LocationProbe />
    </>
  )
}

function renderPalette() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="*" element={<Harness />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => { role = 'CONSULTANT' })

describe('CommandPalette', () => {
  it('opens with Ctrl+K, filters by typed words and navigates on Enter', async () => {
    renderPalette()
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true })
    const input = await screen.findByLabelText('Search pages')

    fireEvent.change(input, { target: { value: 'receiv' } })
    expect(screen.getByText('Finance › Receivables')).toBeInTheDocument()
    expect(screen.queryByText('Dashboard')).toBeNull()

    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/finance/receivables'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('includes pinned and recent opportunities and hides admin-only pages from consultants', async () => {
    renderPalette()
    fireEvent.click(screen.getByText('open'))
    const input = await screen.findByLabelText('Search pages')

    fireEvent.change(input, { target: { value: 'radar' } })
    expect(screen.getByText('Radar sustainment IDIQ')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'telematics' } })
    expect(screen.getByText('Fleet telematics BPA')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'admin' } })
    expect(screen.queryByText(/Admin › Compliance log/)).toBeNull()
  })

  it('shows admin pages to admins and closes on Escape', async () => {
    role = 'ADMIN'
    renderPalette()
    fireEvent.click(screen.getByText('open'))
    const input = await screen.findByLabelText('Search pages')
    fireEvent.change(input, { target: { value: 'compliance log' } })
    expect(screen.getByText('Admin › Compliance log')).toBeInTheDocument()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
