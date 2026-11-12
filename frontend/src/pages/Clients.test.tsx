// Adding a client by hand asks for its core profile, so it starts complete
// (backend services/profileCompleteness.ts newProfileProblems). Past
// performance is optional and not asked for here.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const create = vi.fn()
vi.mock('../services/api', () => ({
  clientsApi: {
    list: () => Promise.resolve({ data: [] }),
    create: (body: unknown) => create(body),
    searchNaics: () => Promise.resolve({ data: [] }),
    samLookup: vi.fn(),
  },
  clientPortalUsersApi: new Proxy({}, { get: () => vi.fn().mockResolvedValue({ data: [] }) }),
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }) }))
vi.mock('../hooks/useProfileStatus', () => ({ useProfileStatus: () => ({ data: undefined }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../components/TutorialOverlay', () => ({ TutorialOverlay: () => null }))
vi.mock('../hooks/useTutorial', () => ({ useTutorial: () => ({ hasSeen: () => true, markSeen: vi.fn() }) }))
// A plain text box stands in for the NAICS search.
vi.mock('../components/NaicsPicker', () => ({
  NaicsPicker: ({ label, selected, onChange }: { label: string; selected: string[]; onChange: (c: string[]) => void }) => (
    <label>{label}<input aria-label="NAICS codes" value={selected.join(', ')} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} /></label>
  ),
}))

import { ClientsPage } from './Clients'

async function openForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><MemoryRouter><ClientsPage /></MemoryRouter></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: /Add Client/ }))
  await screen.findByText('New Client Company')
}
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })

beforeEach(() => { create.mockReset(); create.mockResolvedValue({ data: { id: 'c9' } }) })

describe('Clients — add a client with its profile', () => {
  it('says what is missing and does not create a client with only a name', async () => {
    await openForm()
    type('Company Name *', 'Ready Co')
    fireEvent.submit(screen.getByRole('button', { name: 'Create Client' }).closest('form')!)
    const banner = await screen.findByText(/Fill in the client's profile/)
    for (const text of ['State is required', 'NAICS code', 'UEI is required', 'SAM.gov registration status', 'capability keyword']) expect(banner.textContent).toContain(text)
    expect(banner.textContent).not.toMatch(/past performance/i)
    expect(create).not.toHaveBeenCalled()
  })

  it('creates the client with the core profile and the set-aside answers confirmed', async () => {
    await openForm()
    type('Company Name *', 'Ready Co')
    type('UEI *', 'j7m9hptgj1s8')
    type('NAICS codes', '238210')
    type('SAM.gov registration status *', 'Active')
    type('Capability keywords *', 'fiber, structured cabling')
    type('State *', 'TX')
    fireEvent.submit(screen.getByRole('button', { name: 'Create Client' }).closest('form')!)
    await waitFor(() => expect(create).toHaveBeenCalled())
    expect(create.mock.calls[0][0]).toMatchObject({
      name: 'Ready Co', uei: 'J7M9HPTGJ1S8', naicsCodes: ['238210'], samRegStatus: 'Active',
      capabilityKeywords: ['fiber', 'structured cabling'], state: 'TX', setAsideStatusConfirmed: true,
    })
  })
})
