// =============================================================
// Landing page — structure, live pricing from the public billing API,
// static fallback when the API is down, and the mobile nav toggle.
// =============================================================
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let authed = false
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ isAuthenticated: authed, user: authed ? { role: 'ADMIN' } : null }) }))

const getPlans = vi.fn()
const getAddons = vi.fn()
vi.mock('../services/api', () => ({
  billingApi: {
    getPublicPlans: () => getPlans(),
    getPublicAddons: () => getAddons(),
  },
}))

import { LandingPage } from './Landing'
import { AGENTS } from '../components/landing/Agents'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/']}>
        <LandingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  authed = false
  getPlans.mockReset()
  getAddons.mockReset()
})

describe('LandingPage', () => {
  it('renders the hero, primary CTAs and all five sections', () => {
    getPlans.mockResolvedValue({ plans: [] })
    getAddons.mockResolvedValue({ data: [] })
    renderPage()

    const h1 = screen.getByRole('heading', { level: 1 })
    expect(h1.textContent).toMatch(/Know your odds/)
    expect(h1.textContent).toMatch(/before you bid\./)

    const trial = screen.getAllByRole('link', { name: /start free trial/i })
    expect(trial.length).toBeGreaterThan(0)
    for (const l of trial) expect(l.getAttribute('href')).toMatch(/^\/register/)

    for (const id of ['how-it-works', 'agents', 'platform', 'pricing']) {
      expect(document.getElementById(id)).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: /read the trust page/i })).toHaveAttribute('href', '/trust')
    expect(screen.getAllByRole('img').length).toBeGreaterThanOrEqual(2)
  })

  it('lists all nine domain agents with their cadence', () => {
    getPlans.mockResolvedValue({ plans: [] })
    getAddons.mockResolvedValue({ data: [] })
    renderPage()
    expect(AGENTS).toHaveLength(9)
    for (const a of AGENTS) {
      expect(screen.getByRole('heading', { name: a.name })).toBeInTheDocument()
    }
    expect(screen.getByText('every 2h')).toBeInTheDocument()
  })

  it('renders plans and add-ons from the public billing API', async () => {
    getPlans.mockResolvedValue({
      plans: [
        { slug: 'all_access', name: 'API All Access', monthlyPriceUsd: 210, annualPriceUsd: 180, features: ['Everything'], sortOrder: 2 },
        { slug: 'base', name: 'API Core', monthlyPriceUsd: 101, annualPriceUsd: 86, features: ['Search', 'Score'], sortOrder: 1 },
      ],
    })
    getAddons.mockResolvedValue({
      data: [{ slug: 'x', name: 'API Module', priceMonthly: 33, priceAnnual: 28, status: 'available' }],
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('API Core')).toBeInTheDocument())
    expect(screen.getByText('API All Access')).toBeInTheDocument()
    expect(screen.getByText(/^\$101/)).toBeInTheDocument()
    expect(screen.getByText(/^\$210/)).toBeInTheDocument()
    const cards = screen.getAllByTestId(/^plan-/)
    expect(cards[0]).toHaveAttribute('data-testid', 'plan-base')
    expect(within(cards[0]).getByRole('link', { name: /start free trial/i })).toHaveAttribute('href', '/register?plan=base')
    expect(screen.getByText('API Module')).toBeInTheDocument()
    expect(screen.queryByText('Bytescon Core')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /annual/i }))
    expect(screen.getByText(/^\$86/)).toBeInTheDocument()
    expect(screen.getByText(/^\$180/)).toBeInTheDocument()
  })

  it('falls back to the static catalogue when the API is unreachable', async () => {
    getPlans.mockRejectedValue(new Error('offline'))
    getAddons.mockRejectedValue(new Error('offline'))
    renderPage()

    expect(screen.getByText('Bytescon Core')).toBeInTheDocument()
    expect(screen.getByText('All Access')).toBeInTheDocument()
    expect(screen.getByText(/^\$99/)).toBeInTheDocument()
    expect(screen.getByText(/^\$199/)).toBeInTheDocument()
    expect(screen.getByText('Proposal Studio')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /claim a founder slot/i })).toHaveAttribute('href', '/register?offer=lifetime')
    await waitFor(() => expect(getPlans).toHaveBeenCalled())
  })

  it('offers the dashboard instead of sign-in when already authenticated', () => {
    authed = true
    getPlans.mockResolvedValue({ plans: [] })
    getAddons.mockResolvedValue({ data: [] })
    renderPage()
    const header = within(screen.getByRole('banner'))
    expect(header.getByRole('link', { name: /open dashboard/i })).toHaveAttribute('href', '/dashboard')
    expect(header.queryByRole('link', { name: /^sign in$/i })).not.toBeInTheDocument()
  })

  it('toggles the mobile navigation menu', () => {
    getPlans.mockResolvedValue({ plans: [] })
    getAddons.mockResolvedValue({ data: [] })
    renderPage()

    const toggle = screen.getByRole('button', { name: /open menu/i })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(document.getElementById('lp-mobile-nav')).toBeNull()
    fireEvent.click(toggle)
    expect(document.getElementById('lp-mobile-nav')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /close menu/i })).toHaveAttribute('aria-expanded', 'true')
  })
})
