// =============================================================
// §8.5 — Integration cards.
//
// The assertions are all about honesty: a provider with no server-side
// credential must not offer a connect button, a contract-only provider must
// say so, and no response field that could hold a token may ever be rendered.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IntegrationCards } from './IntegrationCards'

const list = vi.fn()
const authorize = vi.fn()
const connectTeams = vi.fn()
const test_ = vi.fn()
const sync = vi.fn()
const disconnect = vi.fn()
const saveCredentials = vi.fn()
const syncRecords = vi.fn()

vi.mock('../../services/integrationsApi', () => ({
  integrationsApi: {
    list: () => list(),
    authorize: (...a: unknown[]) => authorize(...a),
    connectTeams: (...a: unknown[]) => connectTeams(...a),
    test: (...a: unknown[]) => test_(...a),
    sync: (...a: unknown[]) => sync(...a),
    disconnect: (...a: unknown[]) => disconnect(...a),
    saveCredentials: (...a: unknown[]) => saveCredentials(...a),
    syncRecords: (...a: unknown[]) => syncRecords(...a),
  },
}))

const row = (over: Record<string, unknown> = {}) => ({
  id: 'c1', provider: 'QUICKBOOKS', category: 'ACCOUNTING', label: 'QuickBooks Online',
  status: 'NOT_CONFIGURED', externalAccountName: null, grantedScopes: [], connectedAt: null,
  lastSyncAt: null, lastSuccessfulSyncAt: null, lastError: null, consecutiveFailures: 0,
  config: {}, implementation: 'ADAPTER_IMPLEMENTED', capabilities: ['OAUTH2'],
  platformConfigured: true, missingEnv: [], configurationNote: 'note', ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('IntegrationCards', () => {
  it('offers no connect button when the deployment has no credentials', async () => {
    list.mockResolvedValue([row({ status: 'CREDENTIAL_REQUIRED', platformConfigured: false, missingEnv: ['QUICKBOOKS_CLIENT_ID'] })])
    render(<IntegrationCards />)
    expect(await screen.findByText('Credentials required')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Connect/i })).toBeDisabled()
    expect(screen.getByText(/QUICKBOOKS_CLIENT_ID/)).toBeInTheDocument()
  })

  it('distinguishes not-connected from credentials-required', async () => {
    list.mockResolvedValue([row({ status: 'NOT_CONFIGURED', platformConfigured: true })])
    render(<IntegrationCards />)
    expect(await screen.findByText('Not connected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Connect/i })).not.toBeDisabled()
  })

  it('says a contract-only provider needs configuration instead of offering a connect', async () => {
    list.mockResolvedValue([row({
      provider: 'UNANET', label: 'Unanet', implementation: 'CONTRACT_ONLY',
      configurationNote: 'Unanet exposes a per-tenant API supplied under contract.',
      platformConfigured: false, missingEnv: ['UNANET_API_KEY'],
    })])
    render(<IntegrationCards />)
    expect(await screen.findByText(/supplied under contract/i)).toBeInTheDocument()
    expect(screen.getByText(/Configuration required before this can sync/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Connect$/ })).not.toBeInTheDocument()
  })

  it('shows the last error on a connection that failed', async () => {
    list.mockResolvedValue([row({ status: 'ERROR', lastError: 'The provider rejected the stored credential.' })])
    render(<IntegrationCards />)
    expect(await screen.findByText('Error')).toBeInTheDocument()
    expect(screen.getByText(/rejected the stored credential/i)).toBeInTheDocument()
  })

  it('shows the last successful sync on a connected provider', async () => {
    list.mockResolvedValue([row({
      status: 'CONNECTED', externalAccountName: 'Acme Books',
      lastSuccessfulSyncAt: '2026-08-01T00:00:00.000Z',
    })])
    render(<IntegrationCards />)
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(screen.getByText(/Connected to Acme Books/)).toBeInTheDocument()
    expect(screen.getByText(/Last successful sync/)).toBeInTheDocument()
  })

  it('renders no token even when one is present in the payload', async () => {
    list.mockResolvedValue([row({
      status: 'CONNECTED',
      config: { realmId: '123', accessTokenEnc: 'SHOULD-NEVER-RENDER' },
    })])
    const { container } = render(<IntegrationCards />)
    await screen.findByText('Connected')
    expect(container.textContent).not.toContain('SHOULD-NEVER-RENDER')
  })

  it('connects a Teams channel by webhook URL', async () => {
    list.mockResolvedValue([row({ provider: 'MICROSOFT_TEAMS', category: 'CHAT', label: 'Microsoft Teams' })])
    connectTeams.mockResolvedValue({})
    render(<IntegrationCards />)
    fireEvent.change(await screen.findByLabelText('Teams webhook URL'), {
      target: { value: 'https://outlook.webhook.office.com/webhookb2/abc' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(connectTeams).toHaveBeenCalledWith('https://outlook.webhook.office.com/webhookb2/abc'))
  })

  it('surfaces a refusal from the server', async () => {
    list.mockResolvedValue([row({ status: 'NOT_CONFIGURED' })])
    authorize.mockRejectedValue({ response: { data: { error: 'QuickBooks Online is not configured on this deployment.' } } })
    render(<IntegrationCards />)
    fireEvent.click(await screen.findByRole('button', { name: /Connect/i }))
    expect(await screen.findByText(/not configured on this deployment/i)).toBeInTheDocument()
  })

  it('offers test and disconnect only once connected', async () => {
    list.mockResolvedValue([row({ status: 'CONNECTED' })])
    test_.mockResolvedValue({})
    render(<IntegrationCards />)
    fireEvent.click(await screen.findByRole('button', { name: /Test/i }))
    await waitFor(() => expect(test_).toHaveBeenCalledWith('c1'))
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument()
  })
})

// §8.4 — the two integration writes that had no control at all.
describe('API-key providers', () => {
  const unanet = () => row({
    provider: 'UNANET', label: 'Unanet', implementation: 'CONTRACT_ONLY',
    configurationNote: 'Unanet exposes a per-tenant API supplied under contract.',
    platformConfigured: false, missingEnv: ['UNANET_API_KEY'],
  })

  it('offers a key form, because credential storage is in place', async () => {
    list.mockResolvedValue([unanet()])
    render(<IntegrationCards />)
    expect(await screen.findByLabelText('UNANET API key')).toBeInTheDocument()
  })

  it('still says it cannot sync, so a saved key does not read as finished', async () => {
    list.mockResolvedValue([unanet()])
    render(<IntegrationCards />)
    expect(await screen.findByText(/Configuration required before this can sync/i)).toBeInTheDocument()
    expect(screen.getByText(/does not complete the request mapping/i)).toBeInTheDocument()
  })

  it('refuses a key that is obviously too short', async () => {
    list.mockResolvedValue([unanet()])
    render(<IntegrationCards />)
    const key = await screen.findByLabelText('UNANET API key')
    fireEvent.change(key, { target: { value: 'abc' } })
    expect(screen.getByRole('button', { name: /Save credentials/ })).toBeDisabled()
  })

  it('saves the key with its optional base url', async () => {
    list.mockResolvedValue([unanet()])
    saveCredentials.mockResolvedValue({})
    render(<IntegrationCards />)
    fireEvent.change(await screen.findByLabelText('UNANET API key'), { target: { value: 'a-real-looking-key' } })
    fireEvent.change(screen.getByLabelText('UNANET base URL'), { target: { value: 'https://unanet.example' } })
    fireEvent.click(screen.getByRole('button', { name: /Save credentials/ }))
    await waitFor(() => expect(saveCredentials).toHaveBeenCalledWith('UNANET', expect.objectContaining({
      apiKey: 'a-real-looking-key', baseUrl: 'https://unanet.example',
    })))
  })
})

describe('Synced records', () => {
  const connected = () => row({ id: 'c1', status: 'CONNECTED', implementation: 'ADAPTER_IMPLEMENTED' })

  it('loads them only when asked', async () => {
    list.mockResolvedValue([connected()])
    syncRecords.mockResolvedValue([])
    render(<IntegrationCards />)
    await screen.findByRole('button', { name: /Synced records/ })
    expect(syncRecords).not.toHaveBeenCalled()
  })

  it('says nothing has crossed rather than showing an empty table', async () => {
    list.mockResolvedValue([connected()])
    syncRecords.mockResolvedValue([])
    render(<IntegrationCards />)
    fireEvent.click(await screen.findByRole('button', { name: /Synced records/ }))
    expect(await screen.findByText(/Nothing has been synced through this connection yet/i)).toBeInTheDocument()
  })

  it('counts the records that failed on their last attempt', async () => {
    list.mockResolvedValue([connected()])
    syncRecords.mockResolvedValue([
      { id: 'r1', localType: 'ContractInvoice', localId: 'i1', externalId: 'E-1', direction: 'OUTBOUND', lastSyncedAt: '2026-08-01T00:00:00.000Z', lastError: null },
      { id: 'r2', localType: 'ContractInvoice', localId: 'i2', externalId: null, direction: 'OUTBOUND', lastSyncedAt: null, lastError: 'rejected' },
    ])
    render(<IntegrationCards />)
    fireEvent.click(await screen.findByRole('button', { name: /Synced records/ }))
    expect(await screen.findByText(/1 record\(s\) failed on their last attempt/i)).toBeInTheDocument()
  })
})
