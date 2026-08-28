// =============================================================
// §5.1 Stage 10 / §5.2 Past Performance page — library (loading/empty/error/
// permission, search filter, create, detail + verify/archive, honest missing-CPARS,
// reference redaction, create-from-contract + duplicate prevention) and matrix
// (deterministic relevance display, insufficient-data, human select/deselect,
// AI-labelled adaptation draft, master-record immutability messaging).
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
let routeId: string | undefined
const toast = vi.fn()
const navigate = vi.fn()
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role }, firm: { id: 'f1' } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: routeId }), useNavigate: () => navigate }))

const api = {
  list: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), verify: vi.fn(), archive: vi.fn(),
  restore: vi.fn(), fromContract: vi.fn(), matrix: vi.fn(), score: vi.fn(), select: vi.fn(), deselect: vi.fn(), adapt: vi.fn(),
}
const oppGet = vi.fn()
vi.mock('../services/api', () => ({
  opportunitiesApi: { getById: (...a: unknown[]) => oppGet(...a) },
  pastPerformanceLibraryApi: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as any)[k]?.(...a) }),
}))

import PastPerformanceLibrary from './PastPerformanceLibrary'

function record(over: Record<string, unknown> = {}) {
  return { id: 'r1', contractNumber: 'N-001', contractTitle: 'Navy Cloud', customerName: 'US Navy', customerAgency: 'Department of the Navy', naicsCode: '541512', totalValue: '900000', performerRole: 'PRIME', cparsRating: null, verificationStatus: 'DRAFT', isArchived: false, scopeSummary: 'cloud cybersecurity', referenceEmail: 'jane@navy.mil', referenceRedacted: false, referenceName: 'Jane', permissionToContact: true, referenceAvailability: 'AVAILABLE', updatedAt: new Date().toISOString(), ...over }
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><PastPerformanceLibrary /></QueryClientProvider>)
}

beforeEach(() => {
  role = 'ADMIN'; routeId = undefined; toast.mockReset(); navigate.mockReset(); oppGet.mockReset()
  Object.values(api).forEach((f) => f.mockReset())
  oppGet.mockResolvedValue({ data: { id: 'opp1', title: 'Cyber RFP' } })
})

// -------------------- LIBRARY MODE --------------------
describe('library — states', () => {
  it('shows a loading spinner', () => {
    api.list.mockReturnValue(new Promise(() => {}))
    const { container } = renderPage()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })
  it('shows the empty state', async () => {
    api.list.mockResolvedValue({ data: { records: [], total: 0, totalPages: 1 } })
    renderPage()
    expect(await screen.findByText(/No records match/i)).toBeInTheDocument()
  })
  it('shows an error panel on API failure', async () => {
    api.list.mockRejectedValue(new Error('boom'))
    renderPage()
    expect(await screen.findByText(/Could not load/i)).toBeInTheDocument()
  })
  it('hides the New record button for CONSULTANT', async () => {
    role = 'CONSULTANT'
    api.list.mockResolvedValue({ data: { records: [], total: 0, totalPages: 1 } })
    renderPage()
    await screen.findByText(/No records match/i)
    expect(screen.queryByRole('button', { name: /New record/i })).not.toBeInTheDocument()
  })
})

describe('library — search, create, detail', () => {
  it('re-queries with the search filter', async () => {
    api.list.mockResolvedValue({ data: { records: [record()], total: 1, totalPages: 1 } })
    renderPage()
    await screen.findByText('Navy Cloud')
    fireEvent.change(screen.getByPlaceholderText(/Search contract/i), { target: { value: 'Navy' } })
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ search: 'Navy' })))
  })
  it('filters by agency and NAICS', async () => {
    api.list.mockResolvedValue({ data: { records: [record()], total: 1, totalPages: 1 } })
    renderPage()
    await screen.findByText('Navy Cloud')
    fireEvent.change(screen.getByPlaceholderText('Agency'), { target: { value: 'Navy' } })
    fireEvent.change(screen.getByPlaceholderText('NAICS'), { target: { value: '541512' } })
    await waitFor(() => expect(api.list).toHaveBeenCalledWith(expect.objectContaining({ agency: 'Navy', naicsCode: '541512' })))
  })
  it('creates a record from the drawer', async () => {
    api.list.mockResolvedValue({ data: { records: [], total: 0, totalPages: 1 } })
    api.create.mockResolvedValue({ data: { record: record() } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /New record/i }))
    fireEvent.change(screen.getByPlaceholderText(/Contract number/i), { target: { value: 'N-999' } })
    fireEvent.change(screen.getByPlaceholderText(/Customer name/i), { target: { value: 'US Army' } })
    fireEvent.click(screen.getByRole('button', { name: /Create record/i }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ contractNumber: 'N-999', customerName: 'US Army' })))
  })
  it('prefills from a completed contract and surfaces duplicate prevention', async () => {
    api.list.mockResolvedValue({ data: { records: [], total: 0, totalPages: 1 } })
    api.fromContract.mockRejectedValue({ response: { data: { error: 'A past-performance record already exists for this contract.' } } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /New record/i }))
    fireEvent.change(screen.getByPlaceholderText('Contract ID'), { target: { value: 'c1' } })
    fireEvent.click(screen.getByRole('button', { name: /Prefill/i }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/already exists/i), 'error'))
  })
  it('shows honest missing-CPARS and reference protection in the detail drawer', async () => {
    api.list.mockResolvedValue({ data: { records: [record()], total: 1, totalPages: 1 } })
    api.get.mockResolvedValue({ data: { record: record({ cparsRating: null, referenceRedacted: true, referenceEmail: null, referenceName: null }) } })
    renderPage()
    fireEvent.click(await screen.findByText('Navy Cloud'))
    expect(await screen.findByText(/Not entered — manual/i)).toBeInTheDocument()
    expect(screen.getByText(/restricted to authorized roles/i)).toBeInTheDocument()
  })
  it('verifies a record from the detail drawer', async () => {
    api.list.mockResolvedValue({ data: { records: [record()], total: 1, totalPages: 1 } })
    api.get.mockResolvedValue({ data: { record: record() } })
    api.verify.mockResolvedValue({ data: { record: record({ verificationStatus: 'VERIFIED' }) } })
    renderPage()
    fireEvent.click(await screen.findByText('Navy Cloud'))
    fireEvent.click(await screen.findByRole('button', { name: /^Verify$/i }))
    await waitFor(() => expect(api.verify).toHaveBeenCalledWith('r1'))
  })
})

// -------------------- MATRIX MODE --------------------
function matrixRow(over: Record<string, unknown> = {}) {
  return { record: record(), selection: { id: 'sel1', relevanceScore: 78, confidence: 'HIGH', matchingFactors: ['NAICS exact match (541512)'], missingFactors: [], relevanceExplanation: 'Deterministic relevance 78/100. Selection does not guarantee award.', isSelected: false }, ...over }
}

describe('matrix — relevance, selection, adaptation', () => {
  beforeEach(() => { routeId = 'opp1' })
  it('runs deterministic scoring', async () => {
    api.matrix.mockResolvedValue({ data: { rows: [matrixRow()], selectedCount: 0 } })
    api.score.mockResolvedValue({ data: { scored: 1 } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Score relevance/i }))
    await waitFor(() => expect(api.score).toHaveBeenCalledWith('opp1'))
  })
  it('displays relevance score, confidence and explanation', async () => {
    api.matrix.mockResolvedValue({ data: { rows: [matrixRow()], selectedCount: 0 } })
    renderPage()
    expect(await screen.findByText(/score 78/i)).toBeInTheDocument()
    expect(screen.getByText('HIGH')).toBeInTheDocument()
    expect(screen.getByText(/does not guarantee award/i)).toBeInTheDocument()
  })
  it('shows INSUFFICIENT_DATA confidence for a record with no data', async () => {
    api.matrix.mockResolvedValue({ data: { rows: [matrixRow({ selection: { id: 's', relevanceScore: 0, confidence: 'INSUFFICIENT_DATA', matchingFactors: [], missingFactors: ['NAICS missing'], relevanceExplanation: 'Insufficient stored data', isSelected: false } })], selectedCount: 0 } })
    renderPage()
    expect(await screen.findByText('INSUFFICIENT_DATA')).toBeInTheDocument()
  })
  it('selects a record for the proposal (human selection)', async () => {
    api.matrix.mockResolvedValue({ data: { rows: [matrixRow()], selectedCount: 0 } })
    api.select.mockResolvedValue({ data: { selection: { isSelected: true } } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^Select$/ }))
    await waitFor(() => expect(api.select).toHaveBeenCalledWith('opp1', 'r1'))
  })
  it('generates an AI-labelled adaptation draft in a drawer', async () => {
    api.matrix.mockResolvedValue({ data: { rows: [matrixRow()], selectedCount: 0 } })
    api.adapt.mockResolvedValue({ data: { content: 'AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW\n\nHuman Review Required\n- verify metrics', source: 'DETERMINISTIC' } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^Adapt$/ }))
    expect(await screen.findByText(/master record is unchanged/i)).toBeInTheDocument()
    expect(screen.getByText(/AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW/)).toBeInTheDocument()
  })
  it('states that selection is preserved separately and does not guarantee award', async () => {
    api.matrix.mockResolvedValue({ data: { rows: [matrixRow()], selectedCount: 0 } })
    renderPage()
    expect(await screen.findByText(/preserved separately from the automated score/i)).toBeInTheDocument()
  })
})
