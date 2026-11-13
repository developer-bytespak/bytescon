// Compliance Matrix tab: "Verify all" verifies every unverified requirement at
// once (backend POST /compliance-matrix/:opportunityId/verify-all).
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const summary = vi.fn()
const verifyAll = vi.fn()
const importSamDocuments = vi.fn()
let attachments: { url: string; label: string }[] = []
vi.mock('../services/api', () => ({
  complianceMatrixApi: { summary: (...a: unknown[]) => summary(...a), verifyAll: (...a: unknown[]) => verifyAll(...a) },
  firmApi: { users: () => Promise.resolve({ data: [] }) },
  opportunitiesApi: { getById: () => Promise.resolve({ data: { id: 'o1', title: 'Roof Replacement', attachments } }) },
  proposalApi: {
    getWorkspace: () => Promise.resolve({ data: { exists: true, proposal: { id: 'p1', title: 'Volume I', sections: [] }, progress: { total: 0, approved: 0, percent: 0 } } }),
    listArchived: () => Promise.resolve({ data: { proposals: [] } }),
    importSamDocuments: (...a: unknown[]) => importSamDocuments(...a),
  },
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' }, firm: { id: 'f1' } }), useIsContractor: () => true }))
vi.mock('../hooks/useBranding', () => ({ useBranding: () => ({ branding: { primaryColor: '#000', secondaryColor: '#111' } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../hooks/useNextStep', () => ({ useNextStep: () => vi.fn() }))
vi.mock('../components/section7/ProposalAgentPanel', () => ({ ProposalAgentPanel: () => null }))
vi.mock('../components/ClientReviewPanel', () => ({ ClientReviewPanel: () => null }))
vi.mock('../components/knowledge/KeyPersonnelPanel', () => ({ KeyPersonnelPanel: () => null }))

import ProposalWorkspace from './ProposalWorkspace'

function renderMatrix() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/opportunities/o1/proposal?tab=compliance']}>
        <Routes><Route path="/opportunities/:id/proposal" element={<ProposalWorkspace />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const counts = (unverified: number) => ({ data: { compliancePercent: 50, counts: { total: 5, mandatory: 2, verified: 5 - unverified, unverified, linked: 0 }, requirements: [] } })

beforeEach(() => { summary.mockReset(); verifyAll.mockReset(); importSamDocuments.mockReset(); attachments = []; verifyAll.mockResolvedValue({ data: { verified: 3 } }) })

describe('Compliance Matrix — Verify all', () => {
  it('verifies every unverified requirement after a confirmation', async () => {
    summary.mockResolvedValue(counts(3))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderMatrix()
    fireEvent.click(await screen.findByRole('button', { name: /Verify all \(3\)/ }))
    await waitFor(() => expect(verifyAll).toHaveBeenCalledWith('o1'))
  })

  it('does nothing if the confirmation is declined, and hides the button when all are verified', async () => {
    summary.mockResolvedValue(counts(3))
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { unmount } = renderMatrix()
    fireEvent.click(await screen.findByRole('button', { name: /Verify all \(3\)/ }))
    expect(verifyAll).not.toHaveBeenCalled()
    unmount()
    summary.mockResolvedValue(counts(0))
    renderMatrix()
    await screen.findByRole('button', { name: /Add requirement/ })
    expect(screen.queryByRole('button', { name: /Verify all/ })).not.toBeInTheDocument()
  })
})

describe('Compliance Matrix — solicitation documents from SAM.gov', () => {
  it('brings them in and says what happened to each', async () => {
    attachments = [{ url: 'https://sam.gov/f1', label: 'Attachment 1' }, { url: 'https://sam.gov/f2', label: 'Attachment 2' }]
    summary.mockResolvedValue(counts(0))
    importSamDocuments.mockResolvedValue({ data: { queuedForReading: 1, results: [
      { label: 'Attachment 1', outcome: 'imported', fileName: 'Solicitation.pdf', readAutomatically: true, message: 'Added; its requirements are being read into the Compliance Matrix.' },
      { label: 'Attachment 2', outcome: 'restricted', fileName: null, readAutomatically: false, message: 'SAM.gov restricts this file. Download it from SAM.gov and upload it here.' },
    ] } })
    renderMatrix()
    fireEvent.click(await screen.findByRole('button', { name: /Get solicitation documents from SAM.gov \(2\)/ }))
    await waitFor(() => expect(importSamDocuments).toHaveBeenCalledWith('o1'))
    expect(await screen.findByText('Solicitation.pdf')).toBeInTheDocument()
    expect(screen.getByText(/restricts this file/)).toBeInTheDocument()
    expect(screen.getByText(/arrive unverified/)).toBeInTheDocument()
  })

  it('has no button when SAM.gov lists no documents', async () => {
    summary.mockResolvedValue(counts(0))
    renderMatrix()
    await screen.findByRole('button', { name: /Add requirement/ })
    expect(screen.queryByRole('button', { name: /solicitation documents/ })).not.toBeInTheDocument()
  })
})
