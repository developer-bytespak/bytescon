// =============================================================
// §8.4 — Public API token panel.
//
// The assertions that matter: the secret is shown once with a warning that it
// cannot be shown again, the panel lists only PUBLIC_API credentials, and the
// scopes a token was minted with are visible afterwards.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PublicApiTokens } from './PublicApiTokens'

const listTokens = vi.fn()
const createPublicApiToken = vi.fn()
const revokeToken = vi.fn()

vi.mock('../services/api', () => ({
  mcpApi: {
    listTokens: () => listTokens(),
    createPublicApiToken: (...a: unknown[]) => createPublicApiToken(...a),
    revokeToken: (id: string) => revokeToken(id),
  },
}))

const wrap = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><PublicApiTokens /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  listTokens.mockResolvedValue({ data: [] })
})

describe('PublicApiTokens', () => {
  it('warns that the secret is read-only once, before it is generated', async () => {
    wrap()
    expect(await screen.findByText(/Version 1 is read-only/i)).toBeInTheDocument()
  })

  it('creates a token with the chosen scopes and shows the secret once', async () => {
    createPublicApiToken.mockResolvedValue({ data: { id: 't1', rawToken: 'raw-secret-value-123' } })
    wrap()
    fireEvent.change(await screen.findByLabelText('Token name'), { target: { value: 'Reporting job' } })
    fireEvent.click(screen.getByRole('button', { name: 'contracts:read' }))
    fireEvent.click(screen.getByRole('button', { name: 'Create API token' }))

    await waitFor(() => expect(createPublicApiToken).toHaveBeenCalledWith(
      'Reporting job', ['opportunities:read', 'contracts:read'], 'CORE',
    ))
    expect(await screen.findByText('raw-secret-value-123')).toBeInTheDocument()
    expect(screen.getByText(/cannot be shown again/i)).toBeInTheDocument()
  })

  it('lists only PUBLIC_API credentials, with their scopes', async () => {
    listTokens.mockResolvedValue({
      data: [
        { id: 'a', name: 'Reporting', tokenPrefix: 'abcd1234', tier: 'CORE', kind: 'PUBLIC_API', scopes: ['contracts:read'], expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: '2026-08-01T00:00:00.000Z' },
        { id: 'b', name: 'Claude host', tokenPrefix: 'wxyz9999', tier: 'CORE', kind: 'MCP', scopes: [], expiresAt: null, revokedAt: null, lastUsedAt: null, createdAt: '2026-08-01T00:00:00.000Z' },
      ],
    })
    wrap()
    expect(await screen.findByText('Reporting')).toBeInTheDocument()
    expect(screen.queryByText('Claude host')).not.toBeInTheDocument()
    expect(screen.getByText('abcd1234…')).toBeInTheDocument()
  })

  it('refuses to submit without a name or a scope', async () => {
    wrap()
    const button = await screen.findByRole('button', { name: 'Create API token' })
    expect(button).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Token name'), { target: { value: 'x' } })
    expect(screen.getByRole('button', { name: 'Create API token' })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'opportunities:read' }))
    expect(screen.getByRole('button', { name: 'Create API token' })).toBeDisabled()
  })

  it('shows a revoked token as revoked and offers no revoke control', async () => {
    listTokens.mockResolvedValue({
      data: [{ id: 'a', name: 'Old', tokenPrefix: 'abcd1234', tier: 'CORE', kind: 'PUBLIC_API', scopes: ['crm:read'], expiresAt: null, revokedAt: '2026-08-02T00:00:00.000Z', lastUsedAt: null, createdAt: '2026-08-01T00:00:00.000Z' }],
    })
    wrap()
    expect(await screen.findByText('revoked')).toBeInTheDocument()
    expect(screen.queryByTitle('Revoke token')).not.toBeInTheDocument()
  })
})
