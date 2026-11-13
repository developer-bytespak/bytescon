// An empty proposal says what to do next: add the solicitation's requirements,
// or start from a standard outline (backend routes/proposal.ts outline route).
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const summary = vi.fn()
const generateOutline = vi.fn()
const getWorkspace = vi.fn()
const generateDraft = vi.fn()
vi.mock('../services/api', () => ({
  complianceMatrixApi: { summary: (...a: unknown[]) => summary(...a) },
  firmApi: { users: () => Promise.resolve({ data: [] }) },
  opportunitiesApi: { getById: () => Promise.resolve({ data: { id: 'o1', title: 'Roof Replacement' } }) },
  proposalApi: {
    getWorkspace: () => getWorkspace(),
    listArchived: () => Promise.resolve({ data: { proposals: [] } }),
    generateOutline: (...a: unknown[]) => generateOutline(...a),
    generateDraft: (...a: unknown[]) => generateDraft(...a),
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

const emptyProposal = { exists: true, proposal: { id: 'p1', title: 'Volume I', sections: [] }, progress: { total: 0, approved: 0, percent: 0 } }

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

beforeEach(() => {
  summary.mockReset(); generateOutline.mockReset(); getWorkspace.mockReset(); generateDraft.mockReset()
  getWorkspace.mockResolvedValue({ data: emptyProposal })
  generateOutline.mockResolvedValue({ data: { sections: [{}, {}, {}, {}], standard: true } })
})

describe('ProposalWorkspace — an empty proposal', () => {
  it('without requirements: no 0% bar, the outline button explains itself, and offers a standard outline', async () => {
    summary.mockResolvedValue({ data: { counts: { verified: 0, total: 0 }, requirements: [] } })
    renderPage()
    expect(await screen.findByText(/no requirements to build them from/)).toBeInTheDocument()
    expect(screen.queryByText(/sections approved/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Generate outline from verified requirements/ })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Use a standard outline/ }))
    await waitFor(() => expect(generateOutline).toHaveBeenCalledWith('p1', { standard: true }))
  })

  it('goes to the Compliance Matrix tab from the empty state', async () => {
    summary.mockResolvedValue({ data: { counts: { verified: 0, total: 0 }, requirements: [] } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Go to Compliance Matrix/ }))
    expect(await screen.findByRole('button', { name: /Add requirement/ })).toBeInTheDocument()
  })

  it('with verified requirements: builds the outline from them', async () => {
    summary.mockResolvedValue({ data: { counts: { verified: 3, total: 3 }, requirements: [] } })
    renderPage()
    const button = await screen.findByRole('button', { name: /Generate outline from verified requirements \(3\)/ })
    expect(button).not.toBeDisabled()
    expect(screen.queryByRole('button', { name: /Use a standard outline/ })).not.toBeInTheDocument()
    fireEvent.click(button)
    await waitFor(() => expect(generateOutline).toHaveBeenCalledWith('p1', { standard: false }))
  })
})

const section = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id, title, sectionNumber: null, outline: null, draft: null, sortOrder: 0, ownerUserId: null, reviewerUserId: null, status: 'OUTLINE',
  dueDate: null, reviewDate: null, notes: null, dependencies: [], attachmentName: null, isAiGenerated: false, generationStatus: 'IDLE', wordCount: 0, ...over,
})

describe('ProposalWorkspace — Draft all empty sections', () => {
  it('drafts only the empty sections, one after another, leaving written and approved ones alone', async () => {
    summary.mockResolvedValue({ data: { counts: { verified: 2, total: 2 }, requirements: [] } })
    getWorkspace.mockResolvedValue({ data: { exists: true, proposal: { id: 'p1', title: 'Volume I', sections: [
      section('s1', 'Technical Approach'),
      section('s2', 'Management Plan', { draft: 'Already written by us.', status: 'DRAFTING' }),
      section('s3', 'Past Performance', { draft: 'Final text', status: 'APPROVED' }),
      section('s4', 'Key Personnel'),
    ] }, progress: { total: 4, approved: 1, percent: 25 } } })
    generateDraft.mockResolvedValue({ data: { version: 1 } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Draft all empty sections \(2\)/ }))
    await waitFor(() => expect(generateDraft).toHaveBeenCalledTimes(2))
    expect(generateDraft.mock.calls.map((c) => c[0])).toEqual(['s1', 's4'])
  })
})
