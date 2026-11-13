// A contractor can download its proposal as one PDF (consulting firms get it
// in the client-review panel); the demo has no file downloads.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const downloadPdf = vi.fn()
let contractor = true
let demo = false
vi.mock('../services/api', () => ({
  clientReviewApi: { downloadPdf: (...a: unknown[]) => downloadPdf(...a) },
  complianceMatrixApi: { summary: () => Promise.resolve({ data: { counts: { verified: 0, total: 0 }, requirements: [] } }) },
  firmApi: { users: () => Promise.resolve({ data: [] }) },
  opportunitiesApi: { getById: () => Promise.resolve({ data: { id: 'o1', title: 'Roof Replacement' } }) },
  proposalApi: {
    getWorkspace: () => Promise.resolve({ data: { exists: true, proposal: { id: 'p1', title: 'Volume I — Technical', sections: [] }, progress: { total: 0, approved: 0, percent: 0 } } }),
    listArchived: () => Promise.resolve({ data: { proposals: [] } }),
  },
}))
vi.mock('../demo/demoMode', () => ({ get isDemoSite() { return demo } }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' }, firm: { id: 'f1' } }), useIsContractor: () => contractor }))
vi.mock('../hooks/useBranding', () => ({ useBranding: () => ({ branding: { primaryColor: '#000', secondaryColor: '#111' } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../hooks/useNextStep', () => ({ useNextStep: () => vi.fn() }))
vi.mock('../components/section7/ProposalAgentPanel', () => ({ ProposalAgentPanel: () => null }))
vi.mock('../components/ClientReviewPanel', () => ({ ClientReviewPanel: () => <p>Client review panel</p> }))
vi.mock('../components/knowledge/KeyPersonnelPanel', () => ({ KeyPersonnelPanel: () => null }))

import ProposalWorkspace from './ProposalWorkspace'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/opportunities/o1/proposal']}>
        <Routes><Route path="/opportunities/:id/proposal" element={<ProposalWorkspace />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => { downloadPdf.mockReset(); downloadPdf.mockResolvedValue(undefined); contractor = true; demo = false })

describe('ProposalWorkspace — proposal PDF', () => {
  it('lets a contractor download the proposal as one PDF', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Download PDF/ }))
    await waitFor(() => expect(downloadPdf).toHaveBeenCalledWith('proposal', 'p1', 'Volume_I_Technical.pdf'))
    expect(screen.queryByText('Client review panel')).not.toBeInTheDocument()
  })

  it('gives a consulting firm the client-review panel instead', async () => {
    contractor = false
    renderPage()
    expect(await screen.findByText('Client review panel')).toBeInTheDocument()
    expect(screen.queryByText('Your proposal as one PDF')).not.toBeInTheDocument()
  })

  it('is not offered on the demo, which has no file downloads', async () => {
    demo = true
    renderPage()
    await screen.findByText('Roof Replacement')
    expect(screen.queryByRole('button', { name: /Download PDF/ })).not.toBeInTheDocument()
  })
})
