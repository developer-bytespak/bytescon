// =============================================================
// §8.4 — Signature requests.
//
// The assertions that matter are about consequence, not layout: sending is the
// moment a document leaves the building, a completed agreement can never be
// voided, and a page with no provider connected has to say so before someone
// prepares a request they cannot send.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

const list = vi.fn()
const create = vi.fn()
const send = vi.fn()
const voidRequest = vi.fn()
const downloadDocument = vi.fn()
const integrationsList = vi.fn()
vi.mock('../services/integrationsApi', async () => {
  const actual = await vi.importActual<typeof import('../services/integrationsApi')>('../services/integrationsApi')
  return {
    ...actual,
    esignApi: {
      list: (...a: unknown[]) => list(...a),
      create: (...a: unknown[]) => create(...a),
      send: (...a: unknown[]) => send(...a),
      void: (...a: unknown[]) => voidRequest(...a),
      downloadDocument: (...a: unknown[]) => downloadDocument(...a),
    },
    integrationsApi: { list: (...a: unknown[]) => integrationsList(...a) },
  }
})

import Signatures from './Signatures'

const request = (over: Record<string, unknown> = {}) => ({
  id: 'r1', documentType: 'TEAMING_AGREEMENT', status: 'DRAFT',
  title: 'Teaming agreement — DOE Cyber', provider: null, providerStatus: null,
  sentAt: null, completedAt: null, declinedAt: null, declineReason: null,
  lastError: null, fileName: 'ta.pdf', createdAt: '2026-08-01T00:00:00.000Z',
  signers: [{ id: 's1', name: 'Alicia Reyes', email: 'alicia@demosub.example', routingOrder: 1, status: 'PENDING', signedAt: null }],
  ...over,
})

const connected = [{
  id: 'i1', provider: 'DOCUSIGN', category: 'ESIGNATURE', label: 'DocuSign', status: 'CONNECTED',
  externalAccountName: null, grantedScopes: [], connectedAt: null, lastSyncAt: null,
  lastSuccessfulSyncAt: null, lastError: null, consecutiveFailures: 0, config: {},
  implementation: 'ADAPTER_IMPLEMENTED', capabilities: [], platformConfigured: true,
  missingEnv: [], configurationNote: '',
}]

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([request()])
  integrationsList.mockResolvedValue(connected)
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('Signatures — provider state', () => {
  it('warns up front when no e-signature account is connected', async () => {
    integrationsList.mockResolvedValue([])
    render(<Signatures />)
    expect(await screen.findByText(/No e-signature account is connected/i)).toBeInTheDocument()
  })

  it('says nothing can be sent without one', async () => {
    integrationsList.mockResolvedValue([])
    render(<Signatures />)
    expect(await screen.findByText(/nothing can be sent until an account is connected/i)).toBeInTheDocument()
  })

  it('does not warn once a provider is connected', async () => {
    render(<Signatures />)
    await screen.findByText('Teaming agreement — DOE Cyber')
    expect(screen.queryByText(/No e-signature account is connected/i)).not.toBeInTheDocument()
  })

  it('still lists requests when the provider state cannot be read', async () => {
    integrationsList.mockRejectedValue(new Error('down'))
    render(<Signatures />)
    expect(await screen.findByText('Teaming agreement — DOE Cyber')).toBeInTheDocument()
  })
})

describe('Signatures — lifecycle', () => {
  it('offers Send only while the request is unsent', async () => {
    render(<Signatures />)
    expect(await screen.findByRole('button', { name: /Send/ })).toBeInTheDocument()
  })

  it('offers no Send once it has already gone out', async () => {
    list.mockResolvedValue([request({ status: 'SENT', sentAt: '2026-08-02T00:00:00.000Z' })])
    render(<Signatures />)
    await screen.findByText('Teaming agreement — DOE Cyber')
    expect(screen.queryByRole('button', { name: /Send/ })).not.toBeInTheDocument()
  })

  it('never offers Void on a completed agreement', async () => {
    list.mockResolvedValue([request({ status: 'COMPLETED', completedAt: '2026-08-03T00:00:00.000Z' })])
    render(<Signatures />)
    await screen.findByText('Teaming agreement — DOE Cyber')
    expect(screen.queryByRole('button', { name: /Void/ })).not.toBeInTheDocument()
  })

  it('sends after confirming', async () => {
    send.mockResolvedValue({})
    render(<Signatures />)
    fireEvent.click(await screen.findByRole('button', { name: /Send/ }))
    await waitFor(() => expect(send).toHaveBeenCalledWith('r1'))
  })

  it('voids with a recorded reason', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Superseded by a revised draft')
    voidRequest.mockResolvedValue({})
    render(<Signatures />)
    fireEvent.click(await screen.findByRole('button', { name: /Void/ }))
    await waitFor(() => expect(voidRequest).toHaveBeenCalledWith('r1', 'Superseded by a revised draft'))
  })

  it('surfaces a provider error against the request it belongs to', async () => {
    list.mockResolvedValue([request({ status: 'ERROR', lastError: 'DocuSign rejected the envelope.' })])
    render(<Signatures />)
    expect(await screen.findByText(/DocuSign rejected the envelope/i)).toBeInTheDocument()
  })
})

describe('Signatures — creating a request', () => {
  it('creates a draft with its signers, and says it was not sent', async () => {
    create.mockResolvedValue({})
    render(<Signatures />)
    fireEvent.click(await screen.findByRole('button', { name: /New request/ }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'NDA — Acme' } })
    fireEvent.change(screen.getByLabelText('Signer 1 name'), { target: { value: 'Sam Okafor' } })
    fireEvent.change(screen.getByLabelText('Signer 1 email'), { target: { value: 'sam@acme.example' } })
    fireEvent.click(screen.getByRole('button', { name: /Create draft/ }))
    await waitFor(() => expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'NDA — Acme',
        signers: [expect.objectContaining({ name: 'Sam Okafor', email: 'sam@acme.example', routingOrder: 1 })],
      }),
      null,
    ))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/has not been sent/i), 'success'))
  })

  it('refuses to create a request with no signer', async () => {
    render(<Signatures />)
    fireEvent.click(await screen.findByRole('button', { name: /New request/ }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'NDA — Acme' } })
    fireEvent.click(screen.getByRole('button', { name: /Create draft/ }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/at least one signer/i), 'error'))
    expect(create).not.toHaveBeenCalled()
  })

  it('says creating never sends', async () => {
    render(<Signatures />)
    fireEvent.click(await screen.findByRole('button', { name: /New request/ }))
    expect(await screen.findByText(/Creating never sends/i)).toBeInTheDocument()
  })

  it('states that no agent can send or void', async () => {
    render(<Signatures />)
    expect(await screen.findByText(/No agent can create, send or void/i)).toBeInTheDocument()
  })
})
