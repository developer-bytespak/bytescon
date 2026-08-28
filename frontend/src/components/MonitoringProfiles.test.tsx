// =============================================================
// §5.1 Saved Monitoring Profiles panel — states, apply, admin-gated actions,
// save-current-filters, and the filter mapping helpers.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role } }) }))
vi.mock('./Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const list = vi.fn()
const create = vi.fn()
const archive = vi.fn()
vi.mock('../services/api', () => ({
  monitoringProfilesApi: {
    list: () => list(), create: (...a: unknown[]) => create(...a), archive: (...a: unknown[]) => archive(...a),
    update: vi.fn(), duplicate: vi.fn(), setActive: vi.fn(), restore: vi.fn(), count: vi.fn(),
  },
}))

import { MonitoringProfiles, profileFiltersToPage, pageFiltersToProfile } from './MonitoringProfiles'

const onApply = vi.fn()
function renderPanel(pageFilters: Record<string, string | number> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MonitoringProfiles pageFilters={pageFilters} activeProfileId={null} onApply={onApply} />
    </QueryClientProvider>,
  )
}
const profile = (over = {}) => ({ id: 'p1', name: 'Navy IT', description: '5415xx', filters: { naicsCode: '5415', agency: 'Navy' }, alertFrequency: 'DAILY', isActive: true, isArchived: false, lastResultCount: 7, ...over })

beforeEach(() => { role = 'ADMIN'; list.mockReset(); create.mockReset(); archive.mockReset(); onApply.mockReset(); list.mockResolvedValue({ data: [] }); create.mockResolvedValue({ data: {} }) })

describe('filter mapping helpers', () => {
  it('round-trips page <-> profile filters', () => {
    const profileFilters = { naicsCode: '5415', agency: 'Navy', estimatedValueMin: 1000, recompeteOnly: true, showExpired: false }
    const page = profileFiltersToPage(profileFilters)
    expect(page.naicsCode).toBe('5415')
    expect(page.estimatedValueMin).toBe('1000')
    expect(page.recompeteOnly).toBe('true')
    const back = pageFiltersToProfile(page)
    expect(back.naicsCode).toBe('5415')
    expect(back.estimatedValueMin).toBe(1000)
    expect(back.recompeteOnly).toBe(true)
    expect('showExpired' in back).toBe(false) // false booleans are omitted
  })
})

describe('MonitoringProfiles panel', () => {
  it('shows an empty state when there are no profiles', async () => {
    renderPanel()
    fireEvent.click(screen.getByText(/Saved monitoring profiles/i))
    expect(await screen.findByText(/No saved profiles yet/i)).toBeInTheDocument()
  })

  it('renders a profile with its alert badge and match count, and applies it', async () => {
    list.mockResolvedValue({ data: [profile()] })
    renderPanel()
    fireEvent.click(screen.getByText(/Saved monitoring profiles/i))
    expect(await screen.findByText('Navy IT')).toBeInTheDocument()
    expect(screen.getByText('daily')).toBeInTheDocument()
    expect(screen.getByText(/7 matches/i)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    expect(onApply).toHaveBeenCalledWith('p1', expect.objectContaining({ naicsCode: '5415', agency: 'Navy' }))
  })

  it('gives an ADMIN a Save-current-filters control that submits mapped filters', async () => {
    renderPanel({ naicsCode: '541512', showExpired: 'true' })
    fireEvent.click(screen.getByText(/Saved monitoring profiles/i))
    fireEvent.click(await screen.findByRole('button', { name: /save current filters/i }))
    fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'My monitor' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    const arg = create.mock.calls[0][0]
    expect(arg.name).toBe('My monitor')
    expect(arg.filters).toEqual({ naicsCode: '541512', showExpired: true })
  })

  it('hides admin actions for a CONSULTANT but still allows Apply', async () => {
    list.mockResolvedValue({ data: [profile()] })
    role = 'CONSULTANT'
    renderPanel()
    fireEvent.click(screen.getByText(/Saved monitoring profiles/i))
    await screen.findByText('Navy IT')
    expect(screen.queryByRole('button', { name: /save current filters/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /archive/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument()
  })
})
