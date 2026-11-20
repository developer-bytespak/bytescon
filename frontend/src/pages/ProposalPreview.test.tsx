// The proposal preview: the whole proposal and its price, with what's left
// before it can be submitted.
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getOpp = vi.fn()
const getProposal = vi.fn()
const getPrice = vi.fn()
vi.mock('../services/api', () => ({
  opportunitiesApi: { getById: () => getOpp() },
  proposalApi: { getWorkspace: () => getProposal() },
  pricingApi: { getWorkspace: () => getPrice() },
  clientReviewApi: { downloadPdf: vi.fn() },
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' }, firm: { id: 'f1', name: 'Acme Roofing' } }) }))

import ProposalPreview, { placeholdersIn } from './ProposalPreview'

const section = (id: string, title: string, draft: string | null, status = 'APPROVED', sortOrder = 0) => ({ id, title, sectionNumber: null, draft, status, sortOrder })
const scenario = {
  id: 's1', name: 'Base', isPreferred: true, sensitiveRedacted: false,
  totalDirectLabor: '100000', totalFringe: '30000', totalOverhead: null, totalGA: null, totalOdc: null, totalSubcontractor: null, totalFee: '10000', totalPrice: '140000',
  laborLines: [{ id: 'l1', categoryName: 'Roofer', hours: '1000', baseRate: '100', directLaborAmount: '100000' }], indirectRates: [], otherCosts: [],
}

function renderPage() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/opportunities/o1/preview']}>
        <Routes><Route path="/opportunities/:id/preview" element={<ProposalPreview />} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getOpp.mockResolvedValue({ data: { id: 'o1', title: 'Roof Replacement', agency: 'GSA', solicitationNumber: 'SOL-9', responseDeadline: '2026-12-07T19:00:00.000Z' } })
  getPrice.mockResolvedValue({ data: { exists: true, workspace: { status: 'APPROVED', preferredScenarioId: 's1', scenarios: [scenario] } } })
})

describe('ProposalPreview', () => {
  it('counts the REQUIRED placeholders the AI leaves', () => {
    expect(placeholdersIn('Factor 1: [EVALUATION FACTOR TITLE REQUIRED] and [SECTION M — FULL TEXT REQUIRED]. [note]')).toBe(2)
    expect(placeholdersIn(null)).toBe(0)
  })

  it('shows the cover, every section in order, and the price, and says when it is ready', async () => {
    getProposal.mockResolvedValue({ data: { exists: true, proposal: { id: 'p1', title: 'Volume I', sections: [section('b', 'Management Plan', 'We manage it.', 'APPROVED', 1), section('a', 'Technical Approach', 'We fix roofs.', 'APPROVED', 0)] } } })
    renderPage()
    expect(await screen.findByText(/ready to submit/)).toBeInTheDocument()
    expect(screen.getByText('Submitted to: GSA')).toBeInTheDocument()
    expect(screen.getByText('Prepared by: Acme Roofing')).toBeInTheDocument()
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
    expect(headings).toEqual(['Contents', '1. Technical Approach', '2. Management Plan', 'Price: Base'])
    expect(screen.getByText('We fix roofs.')).toBeInTheDocument()
    expect(screen.getByText('Roofer')).toBeInTheDocument()
    expect(screen.getByText('$140,000.00')).toBeInTheDocument()
  })

  it('lists what is left: unapproved sections, placeholders and an unapproved price', async () => {
    getProposal.mockResolvedValue({ data: { exists: true, proposal: { id: 'p1', title: 'Volume I', sections: [section('a', 'Evaluation', 'Factor: [FACTOR TITLE REQUIRED]', 'DRAFTING')] } } })
    getPrice.mockResolvedValue({ data: { exists: true, workspace: { status: 'IN_REVIEW', preferredScenarioId: 's1', scenarios: [scenario] } } })
    renderPage()
    expect(await screen.findByText(/Before you submit/)).toBeInTheDocument()
    expect(screen.getByText(/1 of 1 sections are not approved yet/)).toBeInTheDocument()
    expect(screen.getByText(/1 placeholder marked "REQUIRED"/)).toBeInTheDocument()
    expect(screen.getByText(/The price is not approved yet/)).toBeInTheDocument()
    // The placeholder is highlighted in the text.
    expect(screen.getByText('[FACTOR TITLE REQUIRED]').tagName).toBe('MARK')
  })
})
