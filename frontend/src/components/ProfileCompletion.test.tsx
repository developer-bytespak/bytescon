// "Complete your profile" card and the dialog shown when an action is refused
// for an incomplete profile (PROFILE_INCOMPLETE).
import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ProfileStatusResponse } from '../services/api'

const status = vi.fn<() => Promise<ProfileStatusResponse>>()
vi.mock('../services/api', () => ({ profileApi: { status: () => status() } }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ isAuthenticated: true }) }))

import { ProfileCompletionCard } from './ProfileCompletionCard'
import { ProfileIncompleteModal } from './ProfileIncompleteModal'

const FIELDS = { required: [], optional: [] }
const own = (over: Partial<ProfileStatusResponse['clients'][number]> = {}) => ({
  clientCompanyId: 'self-1', name: 'ARK', isSelf: true, complete: false, percent: 40,
  missing: [
    { key: 'uei', label: 'UEI (SAM.gov Unique Entity ID)', where: 'REGISTRATION' as const },
    { key: 'capabilityKeywords', label: 'Capability keywords', where: 'PROFILE' as const },
    { key: 'pastPerformance', label: 'At least one past-performance project', where: 'PAST_PERFORMANCE' as const },
    { key: 'state', label: 'State (address)', where: 'PROFILE' as const },
  ],
  ...over,
})

function Where() { return <p data-testid="where">{useLocation().pathname}</p> }

function renderAt(path = '/dashboard', node = <ProfileCompletionCard />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="*" element={<>{node}<Where /></>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => { status.mockReset() })

describe('ProfileCompletionCard', () => {
  it('asks a contractor to complete its company profile, linking each missing field', async () => {
    status.mockResolvedValue({ accountType: 'CONTRACTOR', complete: false, incompleteCount: 1, clients: [own()], fields: FIELDS })
    renderAt()
    expect(await screen.findByText('Complete your company profile (40%)')).toBeInTheDocument()
    // Registration details are edited on My Company too.
    expect(screen.getByRole('link', { name: 'UEI (SAM.gov Unique Entity ID)' })).toHaveAttribute('href', '/my-company')
    expect(screen.getByRole('link', { name: 'Capability keywords' })).toHaveAttribute('href', '/my-company')
    expect(screen.getByRole('link', { name: 'At least one past-performance project' })).toHaveAttribute('href', '/library/past-performance')
    expect(screen.getByText('and 1 more')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Complete profile/ })).toHaveAttribute('href', '/my-company')
  })

  it('lists a consulting firm\'s incomplete clients with links to each', async () => {
    status.mockResolvedValue({
      accountType: 'CONSULTING', complete: false, incompleteCount: 1, fields: FIELDS,
      clients: [
        { ...own({ clientCompanyId: 'c1', name: 'Acme Co', isSelf: false, percent: 55 }) },
        { ...own({ clientCompanyId: 'c2', name: 'Done Co', isSelf: false, complete: true, percent: 100, missing: [] }) },
      ],
    })
    renderAt()
    expect(await screen.findByText('1 client profile is incomplete')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Acme Co — 55%, 4 required items missing/ })).toHaveAttribute('href', '/clients/c1')
    expect(screen.queryByText(/Done Co/)).toBeNull()
  })

  it('asks a consulting firm with no clients to add one', async () => {
    status.mockResolvedValue({ accountType: 'CONSULTING', complete: false, incompleteCount: 0, clients: [], fields: FIELDS })
    renderAt()
    expect(await screen.findByText('Add your first client')).toBeInTheDocument()
  })

  it('is hidden once every profile is complete', async () => {
    status.mockResolvedValue({ accountType: 'CONTRACTOR', complete: true, incompleteCount: 0, clients: [own({ complete: true, percent: 80, missing: [] })], fields: FIELDS })
    renderAt()
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByRole('region', { name: 'Complete your profile' })).toBeNull()
  })
})

describe('ProfileIncompleteModal', () => {
  it('shows what is missing when an action is refused, and goes to the profile', async () => {
    status.mockResolvedValue({ accountType: 'CONTRACTOR', complete: false, incompleteCount: 1, clients: [own()], fields: FIELDS })
    renderAt('/opportunities/o1', <ProfileIncompleteModal />)
    act(() => {
      window.dispatchEvent(new CustomEvent('bytescon:profile-incomplete', {
        detail: { error: 'Complete your company profile first.', clientCompanyId: 'self-1', clientName: 'ARK', isSelf: true, missing: own().missing },
      }))
    })
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/Complete your company profile first\./)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Complete profile' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/my-company')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('sends a consulting firm with no complete client to its clients', async () => {
    renderAt('/opportunities/o1', <ProfileIncompleteModal />)
    act(() => {
      window.dispatchEvent(new CustomEvent('bytescon:profile-incomplete', {
        detail: { error: 'Complete at least one client profile first.', clientCompanyId: null, clientName: null, isSelf: false, missing: [] },
      }))
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Go to clients' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/clients')
  })
})
