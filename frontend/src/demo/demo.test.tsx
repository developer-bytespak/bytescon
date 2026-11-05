import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

const tour = vi.fn()
vi.mock('./demoTour', () => ({ startDemoTour: () => tour(), registerTourNavigation: () => undefined }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', firstName: 'Pat' } }) }))
const api = { status: vi.fn(), list: vi.fn(), create: vi.fn(), extend: vi.fn(), end: vi.fn(), resetPassword: vi.fn() }
vi.mock('./demoApi', () => ({ demoApi: api }))

const wrap = (node: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>{node}</MemoryRouter>
  </QueryClientProvider>
)

async function loadOnDemoSite() {
  vi.resetModules()
  vi.stubEnv('VITE_APP_ENV', 'demo')
  return {
    guard: await import('./DemoFileGuard'),
    onboarding: await import('./DemoOnboarding'),
    banner: await import('./DemoBanner'),
    admin: await import('../pages/DemoAdmin'),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  document.body.innerHTML = ''
})
afterEach(() => vi.unstubAllEnvs())

const element = (html: string) => {
  const host = document.createElement('div')
  host.innerHTML = html
  return host.firstElementChild as Element
}

describe('hiding file controls', () => {
  it.each([
    '<input type="file" />',
    '<button>Upload document</button>',
    '<button>Download PDF</button>',
    '<a href="/x.csv">Export CSV</a>',
    '<a href="/x" download>Report</a>',
    '<button aria-label="Download"></button>',
    '<button title="Export"></button>',
    '<label>Attach a file</label>',
    '<button>CSV</button>',
    '<a href="/x">PDF</a>',
    '<button aria-label="Export receivables ageing as CSV" title="Nothing to export in receivables ageing yet">CSV</button>',
    '<div data-demo-hide>Any block marked for the demo to hide</div>',
  ])('hides %s', async (html) => {
    const { guard } = await loadOnDemoSite()
    expect(guard.shouldHide(element(html))).toBe(true)
  })

  it.each([
    '<button>Save</button>',
    '<a href="/opportunities">Opportunities</a>',
    '<button>Important deadlines</button>',
    '<input type="text" />',
    '<button>A long row describing a contract whose description happens to mention an upload somewhere in it</button>',
  ])('leaves %s alone', async (html) => {
    const { guard } = await loadOnDemoSite()
    expect(guard.shouldHide(element(html))).toBe(false)
  })

  it('removes controls that appear later', async () => {
    const { guard } = await loadOnDemoSite()
    render(<guard.DemoFileGuard />)
    const button = document.createElement('button')
    button.textContent = 'Upload'
    document.body.appendChild(button)
    await waitFor(() => expect(button.style.display).toBe('none'))
  })
})

describe('onboarding', () => {
  it('goes through three steps, then starts the tour once', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const { onboarding } = await loadOnDemoSite()
    const { unmount } = render(<onboarding.DemoOnboarding />)
    expect(screen.getByText('Welcome to Bytescon, Pat')).toBeTruthy()
    fireEvent.click(screen.getByText('Next'))
    expect(screen.getByText('What it does and how')).toBeTruthy()
    fireEvent.click(screen.getByText('Next'))
    expect(screen.getByText('Key features')).toBeTruthy()
    expect(screen.getByText('Win probability scoring')).toBeTruthy()
    expect(screen.getByText(/Uploading and downloading files and payments are turned off/)).toBeTruthy()
    fireEvent.click(screen.getByText('Start the tour'))
    vi.runAllTimers()
    vi.useRealTimers()
    expect(tour).toHaveBeenCalledTimes(1)
    unmount()

    render(<onboarding.DemoOnboarding />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('comes back at the next sign-in, but not on a refresh', async () => {
    const { onboarding } = await loadOnDemoSite()
    const { resetDemoOnboarding } = await import('./demoMode')
    const first = render(<onboarding.DemoOnboarding />)
    fireEvent.click(screen.getByText('Skip for now'))
    first.unmount()

    const refreshed = render(<onboarding.DemoOnboarding />)
    expect(screen.queryByRole('dialog')).toBeNull()
    refreshed.unmount()

    resetDemoOnboarding('u1')
    render(<onboarding.DemoOnboarding />)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('can be skipped without the tour', async () => {
    const { onboarding } = await loadOnDemoSite()
    render(<onboarding.DemoOnboarding />)
    fireEvent.click(screen.getByText('Skip for now'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(tour).not.toHaveBeenCalled()
  })

  it('never shows outside the demo site', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_APP_ENV', 'production')
    const { DemoOnboarding } = await import('./DemoOnboarding')
    render(<DemoOnboarding />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the banner', () => {
  it('shows the days left and replays the tour', async () => {
    api.status.mockResolvedValue({ expiresAt: new Date(Date.now() + 3 * 86_400_000 - 1000).toISOString(), isOperator: false })
    const { banner } = await loadOnDemoSite()
    render(wrap(<banner.DemoBanner />))
    expect(await screen.findByText(/3 days left/)).toBeTruthy()
    expect(screen.queryByText(/sample data/i)).toBeNull()
    expect(screen.queryByText('Demo accounts')).toBeNull()
    fireEvent.click(screen.getByText('Take the tour'))
    expect(tour).toHaveBeenCalled()
  })

  it('links operators to the account screen', async () => {
    api.status.mockResolvedValue({ expiresAt: null, isOperator: true })
    const { banner } = await loadOnDemoSite()
    render(wrap(<banner.DemoBanner />))
    expect(await screen.findByText('Demo accounts')).toBeTruthy()
  })

  it('counts days without going below zero', async () => {
    const { banner } = await loadOnDemoSite()
    expect(banner.daysLeft(new Date(Date.now() - 86_400_000).toISOString())).toBe(0)
  })
})

describe('when a demo ends during a session', () => {
  it('keeps the reason for the login page to show', async () => {
    const { api: client } = await import('../services/api')
    const { readDemoEnded, clearDemoEnded } = await import('./demoMode')
    clearDemoEnded()
    const ended = { response: { status: 401, data: { code: 'DEMO_EXPIRED', error: 'Your demo has ended.' } } }
    await client.get('/x', { adapter: () => Promise.reject(ended) }).catch(() => undefined)
    expect(readDemoEnded()).toBe('Your demo has ended.')
    clearDemoEnded()
    expect(readDemoEnded()).toBe('')
  })
})

describe('the operator screen', () => {
  it('creates an account and shows the login once', async () => {
    api.list.mockResolvedValue({ accounts: [], defaultDays: 14, states: [{ code: 'TX', name: 'Texas' }, { code: 'OH', name: 'Ohio' }], businessTypes: [{ key: 'IT', label: 'Information / IT' }, { key: 'HEALTH', label: 'Health Care' }] })
    api.create.mockResolvedValue({ firmId: 'f1', email: 'a@b.co', password: 'Secret123', expiresAt: '2026-12-01T00:00:00Z' })
    const { admin } = await loadOnDemoSite()
    render(wrap(<admin.default />))
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Pat Lee' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } })
    await screen.findByRole('option', { name: 'Texas' })
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'HEALTH' } })
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(await screen.findByText('Secret123')).toBeTruthy()
    expect(api.create.mock.calls[0][0]).toEqual({ companyName: 'Acme', contactName: 'Pat Lee', email: 'a@b.co', businessType: 'HEALTH', state: 'TX', days: 14 })
  })

  it('offers the server\'s states plus Other, which asks where', async () => {
    api.list.mockResolvedValue({ accounts: [], defaultDays: 14, states: [{ code: 'OH', name: 'Ohio' }], businessTypes: [{ key: 'IT', label: 'Information / IT' }, { key: 'HEALTH', label: 'Health Care' }] })
    api.create.mockResolvedValue({ firmId: 'f1', email: 'a@b.co', password: 'Secret123', expiresAt: '2026-12-01T00:00:00Z' })
    const { admin } = await loadOnDemoSite()
    render(wrap(<admin.default />))
    expect(await screen.findByRole('option', { name: 'Ohio' })).toBeTruthy()
    expect(screen.queryByLabelText('Other location')).toBeNull()
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Pat' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } })
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'HEALTH' } })
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'OTHER' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(api.create).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Other location'), { target: { value: 'Puerto Rico' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('Secret123')
    expect(api.create.mock.calls[0][0]).toMatchObject({ businessType: 'HEALTH', state: 'OTHER', otherLocation: 'Puerto Rico' })
  })

  it('has no button to create accounts in bulk', async () => {
    api.list.mockResolvedValue({ accounts: [], defaultDays: 14, states: [{ code: 'TX', name: 'Texas' }, { code: 'OH', name: 'Ohio' }], businessTypes: [{ key: 'IT', label: 'Information / IT' }, { key: 'HEALTH', label: 'Health Care' }] })
    const { admin } = await loadOnDemoSite()
    render(wrap(<admin.default />))
    expect(await screen.findByRole('button', { name: 'Generate' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /standard/i })).toBeNull()
  })

  it('will not generate an account until a state and business type are chosen', async () => {
    api.list.mockResolvedValue({ accounts: [], defaultDays: 14, states: [{ code: 'TX', name: 'Texas' }, { code: 'OH', name: 'Ohio' }], businessTypes: [{ key: 'IT', label: 'Information / IT' }, { key: 'HEALTH', label: 'Health Care' }] })
    const { admin } = await loadOnDemoSite()
    render(wrap(<admin.default />))
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Pat' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect(api.create).not.toHaveBeenCalled()
  })

  it('shows why an action failed', async () => {
    api.list.mockResolvedValue({ accounts: [], defaultDays: 14, states: [{ code: 'TX', name: 'Texas' }, { code: 'OH', name: 'Ohio' }], businessTypes: [{ key: 'IT', label: 'Information / IT' }, { key: 'HEALTH', label: 'Health Care' }] })
    api.create.mockRejectedValue({ response: { data: { error: 'An account with this email already exists.' } } })
    const { admin } = await loadOnDemoSite()
    render(wrap(<admin.default />))
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Pat' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } })
    await screen.findByRole('option', { name: 'Texas' })
    fireEvent.change(screen.getByLabelText('Business type'), { target: { value: 'HEALTH' } })
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'TX' } })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    expect((await screen.findByRole('alert')).textContent).toContain('already exists')
  })

  it('lists accounts and ends one', async () => {
    api.list.mockResolvedValue({
      accounts: [{ firmId: 'f1', companyName: 'Acme', contactName: 'Pat', email: 'a@b.co', createdAt: '2026-11-01', expiresAt: '2026-12-01', expired: false }],
      defaultDays: 14,
      states: [],
      businessTypes: [],
    })
    api.end.mockResolvedValue({})
    const { admin } = await loadOnDemoSite()
    render(wrap(<admin.default />))
    fireEvent.click(await screen.findByText('End now'))
    await waitFor(() => expect(api.end).toHaveBeenCalledWith('f1'))
  })
})
