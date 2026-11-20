// The proposal preview: laid out in a template (template 1 by default, others
// to choose), in the solicitation's format, with what's left before submitting
// and PDF / Word downloads.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getOpp = vi.fn()
const getProposal = vi.fn()
const getPrice = vi.fn()
const getDocument = vi.fn()
const setTemplate = vi.fn()
const exportFile = vi.fn()
let role = 'ADMIN'
vi.mock('../services/api', () => ({
  opportunitiesApi: { getById: () => getOpp() },
  proposalApi: {
    getWorkspace: () => getProposal(),
    document: (...a: unknown[]) => getDocument(...a),
    setTemplate: (...a: unknown[]) => setTemplate(...a),
    exportFile: (...a: unknown[]) => exportFile(...a),
  },
  pricingApi: { getWorkspace: () => getPrice() },
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role }, firm: { id: 'f1', name: 'Acme Roofing' } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

import ProposalPreview, { placeholdersIn } from './ProposalPreview'

const TEMPLATES = [
  { key: 'FULL_PROPOSAL', name: 'Full proposal (FAR Part 15 RFP)', use: 'Negotiated contracts.', form: { code: 'SF-33', name: 'Solicitation, Offer and Award', url: 'https://www.gsa.gov/x' } },
  { key: 'SOURCES_SOUGHT', name: 'Sources Sought / RFI response', use: 'Market research.', form: null },
]
const format = (over = {}) => ({ font: 'Arial', fontSize: 11, marginsIn: 1, lineSpacing: 1, pageLimits: [], sources: [{ rule: 'Font: Arial', text: 'Use 11-point Arial.' }], ...over })
let matches: Array<{ key: string; reason: string }> = []
const doc = (selected: string, over: Record<string, unknown> = {}) => ({ data: {
  templates: TEMPLATES, matches, selected, saved: null, totalPages: 3,
  document: { template: TEMPLATES.find((t) => t.key === selected), format: format(), title: 'Roof Replacement', parts: selected === 'FULL_PROPOSAL'
    ? [{ key: 'cover', title: 'Cover page', volume: null, blocks: [{ kind: 'heading', text: 'Roof Replacement' }, { kind: 'facts', rows: [['CAGE code', '[CAGE CODE REQUIRED]']] }] },
      { key: 'technical', title: 'Volume I: Technical', volume: 'technical', blocks: [{ kind: 'heading', text: '1. Technical Approach' }, { kind: 'para', text: 'We fix roofs.' }] }]
    : [{ key: 'capability', title: 'Capability statement', volume: 'capability', blocks: [{ kind: 'para', text: 'Acme answers.' }] }] },
  pageCounts: { cover: 1, technical: 2, capability: 1 },
  limits: [{ part: 'technical', title: 'Volume I: Technical', pages: 2, limit: 1, over: true, source: 'Technical volume: 1 page.' }],
  ...over,
} })

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
  role = 'ADMIN'
  matches = []
  ;[getDocument, setTemplate, exportFile].forEach((f) => f.mockReset())
  getOpp.mockResolvedValue({ data: { id: 'o1', title: 'Roof Replacement', agency: 'GSA' } })
  getProposal.mockResolvedValue({ data: { exists: true, proposal: { id: 'p1', title: 'Volume I', sections: [{ id: 'a', status: 'APPROVED' }] } } })
  getPrice.mockResolvedValue({ data: { exists: true, workspace: { status: 'APPROVED' } } })
  getDocument.mockImplementation((_id: string, t?: string) => Promise.resolve(doc(t ?? 'FULL_PROPOSAL')))
  setTemplate.mockResolvedValue({ data: {} })
  exportFile.mockResolvedValue(undefined)
})

describe('ProposalPreview', () => {
  it('counts the REQUIRED placeholders', () => {
    expect(placeholdersIn('[EVALUATION FACTOR TITLE REQUIRED] and [SECTION M — FULL TEXT REQUIRED]. [note]')).toBe(2)
    expect(placeholdersIn(null)).toBe(0)
  })

  it('opens in template 1, in the solicitation\'s format, with its form and what is left', async () => {
    renderPage()
    expect(await screen.findByRole('radio', { name: /Full proposal/ })).toHaveAttribute('aria-checked', 'true')
    expect(getDocument).toHaveBeenCalledWith('p1', undefined)
    expect(screen.getByText(/Arial, 11 pt/)).toBeInTheDocument()
    expect(screen.getByText(/from "Use 11-point Arial\."/)).toBeInTheDocument()
    expect(screen.getByText(/goes with form/)).toBeInTheDocument()
    // Over its page limit, and a placeholder on the cover, are both listed.
    expect(screen.getByText(/Volume I: Technical is 2 pages; the solicitation allows 1/)).toBeInTheDocument()
    expect(screen.getByText(/1 placeholder marked "REQUIRED"/)).toBeInTheDocument()
    expect(screen.getByText('[CAGE CODE REQUIRED]').tagName).toBe('MARK')
    expect(screen.getByText('We fix roofs.')).toBeInTheDocument()
  })

  it('switches template, keeps the choice, and downloads that layout as PDF or Word', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('radio', { name: /Sources Sought/ }))
    await waitFor(() => expect(setTemplate).toHaveBeenCalledWith('p1', 'SOURCES_SOUGHT'))
    expect(await screen.findByText('Acme answers.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Download Word/ }))
    await waitFor(() => expect(exportFile).toHaveBeenCalledWith('p1', 'SOURCES_SOUGHT', 'docx', 'Volume_I.docx'))
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }))
    await waitFor(() => expect(exportFile).toHaveBeenCalledWith('p1', 'SOURCES_SOUGHT', 'pdf', 'Volume_I.pdf'))
  })

  it('lets a non-admin preview another template without saving it', async () => {
    role = 'CONSULTANT'
    renderPage()
    fireEvent.click(await screen.findByRole('radio', { name: /Sources Sought/ }))
    expect(await screen.findByText('Acme answers.')).toBeInTheDocument()
    expect(setTemplate).not.toHaveBeenCalled()
  })
})

describe('ProposalPreview — the template the solicitation calls for', () => {
  it('marks the one required template, picked automatically, and keeps the rest a click away', async () => {
    matches = [{ key: 'SOURCES_SOUGHT', reason: 'It is a Sources Sought notice: a capability statement answers it.' }]
    getDocument.mockImplementation((_id: string, t?: string) => Promise.resolve(doc(t ?? 'SOURCES_SOUGHT')))
    renderPage()
    const required = await screen.findByRole('radio', { name: /Sources Sought/ })
    expect(required).toHaveAttribute('aria-checked', 'true')
    expect(required).toHaveTextContent('Required by this solicitation')
    expect(required).toHaveTextContent('It is a Sources Sought notice')
    expect(screen.queryByRole('radio', { name: /Full proposal/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use a different template' }))
    expect(screen.getByRole('radio', { name: /Full proposal/ })).not.toHaveTextContent('Required')
    expect(setTemplate).not.toHaveBeenCalled()
  })

  it('shows every template the solicitation accepts, each marked', async () => {
    matches = [{ key: 'FULL_PROPOSAL', reason: 'It asks for form SF-33.' }, { key: 'SOURCES_SOUGHT', reason: 'It also asks for a capability statement.' }]
    renderPage()
    expect(await screen.findByText(/accepts 2 formats: use either/)).toBeInTheDocument()
    expect(screen.getAllByText('Accepted by this solicitation')).toHaveLength(2)
  })

  it('shows them all, and says so, when the solicitation names no format', async () => {
    renderPage()
    expect(await screen.findByText(/doesn't say which format it wants/)).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.queryByText(/Required by|Accepted by/)).not.toBeInTheDocument()
  })
})

