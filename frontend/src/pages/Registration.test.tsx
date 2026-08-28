// =============================================================
// Section 5 Module 2 — Registration page: loading/error/loaded states, health
// summary rendering, and role-gating (CONSULTANT is read-only).
// =============================================================
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const health = vi.fn()
const listCerts = vi.fn()
const listInsurance = vi.fn()
vi.mock('../services/api', () => ({
  registrationApi: {
    health: () => health(),
    listCertifications: () => listCerts(),
    listInsurance: () => listInsurance(),
    createCertification: vi.fn(),
    archiveCertification: vi.fn(),
    createInsurance: vi.fn(),
    archiveInsurance: vi.fn(),
  },
}))

import { RegistrationPage } from './Registration'

const HEALTH = {
  data: {
    summary: { active: 2, expiringSoon: 1, expired: 0, missing: 0, total: 3 },
    attention: [{ kind: 'SAM_REGISTRATION', id: 'sam', label: 'SAM.gov registration', expiryDate: '2026-09-01T00:00:00.000Z', status: 'EXPIRING_SOON', daysUntil: 28 }],
    items: [{ kind: 'SAM_REGISTRATION', id: 'sam', label: 'SAM.gov registration', expiryDate: '2026-09-01T00:00:00.000Z', status: 'EXPIRING_SOON', daysUntil: 28 }],
  },
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RegistrationPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  role = 'ADMIN'
  health.mockReset(); listCerts.mockReset(); listInsurance.mockReset()
})

describe('RegistrationPage (Section 5 Module 2)', () => {
  it('shows a loading spinner while data loads', () => {
    health.mockReturnValue(new Promise(() => {}))
    listCerts.mockReturnValue(new Promise(() => {}))
    listInsurance.mockReturnValue(new Promise(() => {}))
    const { container } = renderPage()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  it('shows an error state when a query fails', async () => {
    health.mockRejectedValue(new Error('boom'))
    listCerts.mockResolvedValue({ data: [] })
    listInsurance.mockResolvedValue({ data: [] })
    renderPage()
    expect(await screen.findByText(/could not load registration data/i)).toBeInTheDocument()
  })

  it('renders the health summary and attention reminder when loaded', async () => {
    health.mockResolvedValue(HEALTH)
    listCerts.mockResolvedValue({ data: [] })
    listInsurance.mockResolvedValue({ data: [] })
    renderPage()
    expect(await screen.findByText('Registration & Compliance')).toBeInTheDocument()
    expect(screen.getAllByText(/expiring soon/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('SAM.gov registration')).toBeInTheDocument()
    // empty states for the two logs
    expect(screen.getByText(/no certifications tracked yet/i)).toBeInTheDocument()
  })

  it('shows admin write controls for an ADMIN', async () => {
    role = 'ADMIN'
    health.mockResolvedValue(HEALTH)
    listCerts.mockResolvedValue({ data: [] })
    listInsurance.mockResolvedValue({ data: [] })
    renderPage()
    expect(await screen.findByRole('button', { name: /add certification/i })).toBeInTheDocument()
  })

  it('hides write controls and shows read-only notice for a CONSULTANT', async () => {
    role = 'CONSULTANT'
    health.mockResolvedValue(HEALTH)
    listCerts.mockResolvedValue({ data: [] })
    listInsurance.mockResolvedValue({ data: [] })
    renderPage()
    await screen.findByText('Registration & Compliance')
    expect(screen.queryByRole('button', { name: /add certification/i })).not.toBeInTheDocument()
    expect(screen.getByText(/read-only access/i)).toBeInTheDocument()
  })
})
