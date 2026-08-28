// =============================================================
// §8.5 — SSO settings.
//
// The secret is write-only, enforcement carries its warning, and a user
// without SSO_MANAGE sees nothing to fill in.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SsoSettings } from './SsoSettings'

const config = vi.fn()
const save = vi.fn()
const me = vi.fn()
const catalog = vi.fn()

vi.mock('../../services/integrationsApi', () => ({
  ssoApi: { config: () => config(), save: (...a: unknown[]) => save(...a), identities: vi.fn() },
  rbacApi: { me: () => me(), catalog: () => catalog(), users: vi.fn(), updateUser: vi.fn() },
}))

const CONFIG = {
  id: 's1', providerType: 'OIDC' as const, displayName: 'Sign in with Okta', enabled: true,
  issuer: 'https://idp.example.com', clientId: 'client-1', clientSecretConfigured: true,
  authorizationUrl: 'https://idp.example.com/authorize', tokenUrl: 'https://idp.example.com/token',
  jwksUri: null, allowedEmailDomains: ['example.com'], enforced: false, breakGlassEmails: [],
  autoProvision: false, defaultRole: 'VIEWER', lastLoginAt: null, lastError: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  me.mockResolvedValue({ role: 'ADMIN', permissions: ['SSO_MANAGE'] })
  catalog.mockResolvedValue({ roles: [{ role: 'ADMIN', permissions: [] }, { role: 'VIEWER', permissions: [] }], permissions: [] })
  config.mockResolvedValue(CONFIG)
})

describe('SsoSettings', () => {
  it('says a secret is stored without showing it', async () => {
    render(<SsoSettings />)
    expect(await screen.findByText(/one is stored — type a new one to replace it/i)).toBeInTheDocument()
    expect((screen.getByLabelText('Client secret') as HTMLInputElement).value).toBe('')
  })

  it('does not send an empty secret, so saving cannot clear a stored one', async () => {
    save.mockResolvedValue(CONFIG)
    render(<SsoSettings />)
    fireEvent.click(await screen.findByRole('button', { name: /Save single sign-on/i }))
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(Object.keys(save.mock.calls[0][0])).not.toContain('clientSecret')
  })

  it('sends a secret the administrator typed', async () => {
    save.mockResolvedValue(CONFIG)
    render(<SsoSettings />)
    fireEvent.change(await screen.findByLabelText('Client secret'), { target: { value: 'a-new-secret-value' } })
    fireEvent.click(screen.getByRole('button', { name: /Save single sign-on/i }))
    await waitFor(() => expect(save.mock.calls[0][0].clientSecret).toBe('a-new-secret-value'))
  })

  it('warns what enforcement without a break-glass address means', async () => {
    render(<SsoSettings />)
    expect(await screen.findByText(/lock your firm out of its own account/i)).toBeInTheDocument()
  })

  it('never offers ADMIN as the automatic provisioning role', async () => {
    render(<SsoSettings />)
    fireEvent.click(await screen.findByLabelText('Create accounts automatically'))
    const select = await screen.findByLabelText('Default role')
    const options = Array.from(select.querySelectorAll('option')).map((o) => o.textContent)
    expect(options).not.toContain('ADMIN')
    expect(options).toContain('VIEWER')
  })

  it('shows nothing to configure without SSO_MANAGE', async () => {
    me.mockResolvedValue({ role: 'FINANCE', permissions: ['FINANCE_APPROVE'] })
    render(<SsoSettings />)
    expect(await screen.findByText(/do not have permission/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Client secret')).not.toBeInTheDocument()
  })
})
