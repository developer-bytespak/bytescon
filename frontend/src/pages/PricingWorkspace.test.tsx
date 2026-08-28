// =============================================================
// §5.1 Stage 6 / §5.2 Pricing workspace page — loading/empty/error/permission
// states, workspace creation + duplicate-active handling, labour line entry +
// direct-labour + indirect + ODC/subcontractor display, negative/invalid
// validation surfaced, scenario compare, approved immutability, sensitive-rate
// redaction for non-ADMIN, honest no-benchmark.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
const toast = vi.fn()
const navigate = vi.fn()
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role }, firm: { id: 'f1' } }) }))
vi.mock('../hooks/useBranding', () => ({ useBranding: () => ({ branding: { primaryColor: '#22d3ee', secondaryColor: '#06b6d4', displayName: 'Bytescon' }, loading: false }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: 'opp1' }), useNavigate: () => navigate }))

const api = {
  getWorkspace: vi.fn(), get: vi.fn(), create: vi.fn(), archive: vi.fn(), newVersion: vi.fn(),
  submit: vi.fn(), approve: vi.fn(), reject: vi.fn(), requestChanges: vi.fn(), reviews: vi.fn(),
  compare: vi.fn(), benchmark: vi.fn(), addScenario: vi.fn(), duplicateScenario: vi.fn(),
  selectScenario: vi.fn(), addLabor: vi.fn(), deleteLabor: vi.fn(), addIndirect: vi.fn(),
  deleteIndirect: vi.fn(), addOther: vi.fn(), deleteOther: vi.fn(), deleteScenario: vi.fn(), updateScenario: vi.fn(),
}
vi.mock('../services/api', () => ({
  opportunitiesApi: { getById: (...a: unknown[]) => api.get(...a) },
  pricingApi: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as any)[k]?.(...a) }),
}))

import PricingWorkspace from './PricingWorkspace'

function scenario(over: Record<string, unknown> = {}) {
  return {
    id: 's1', name: 'Base', description: null, isPreferred: true,
    totalDirectLabor: '100000', totalFringe: '30000', totalOverhead: '65000', totalOdc: '5000',
    totalSubcontractor: '20000', totalGA: '22000', subtotalBeforeFee: '242000', totalFee: '19360', totalPrice: '261360',
    sensitiveRedacted: false,
    laborLines: [{ id: 'l1', categoryName: 'Engineer', hours: '1000', baseRate: '100', escalationPct: '0', directLaborAmount: '100000', personnelCount: null }],
    indirectRates: [{ id: 'i1', name: 'Fringe', rateType: 'FRINGE', percent: '30', costBase: 'DIRECT_LABOUR' }],
    otherCosts: [{ id: 'o1', costCategory: 'SUBCONTRACTOR', description: 'Sub A', quantity: '1', unitCost: '20000', totalAmount: '20000' }],
    ...over,
  }
}
function workspace(over: Record<string, unknown> = {}) {
  return { id: 'w1', title: 'Cost Volume', status: 'DRAFT', version: 1, preferredScenarioId: 's1', scenarios: [scenario()], ...over }
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><PricingWorkspace /></QueryClientProvider>)
}

beforeEach(() => {
  role = 'ADMIN'; toast.mockReset(); navigate.mockReset()
  Object.values(api).forEach((f) => f.mockReset())
  api.get.mockResolvedValue({ data: { id: 'opp1', title: 'Cyber RFP' } })
  api.benchmark.mockResolvedValue({ data: { available: false, message: 'No reliable benchmark available for this opportunity.' } })
  api.compare.mockResolvedValue({ data: { scenarios: [], preferredScenarioId: 's1' } })
  api.reviews.mockResolvedValue({ data: { reviews: [] } })
})

describe('states', () => {
  it('shows a loading spinner before data resolves', () => {
    api.getWorkspace.mockReturnValue(new Promise(() => {}))
    const { container } = renderPage()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })
  it('shows the empty state with a create form for ADMIN', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: false, versions: [] } })
    renderPage()
    expect(await screen.findByText(/No active pricing workspace/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Pricing title/i)).toBeInTheDocument()
  })
  it('shows an error panel with retry on API failure', async () => {
    api.getWorkspace.mockRejectedValue(new Error('boom'))
    renderPage()
    expect(await screen.findByText(/Could not load pricing/i)).toBeInTheDocument()
  })
  it('shows read-only messaging and no create form for CONSULTANT', async () => {
    role = 'CONSULTANT'
    api.getWorkspace.mockResolvedValue({ data: { exists: false, versions: [] } })
    renderPage()
    expect(await screen.findByText(/Read-only access/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Pricing title/i)).not.toBeInTheDocument()
  })
})

describe('workspace creation + duplicate handling', () => {
  it('creates a pricing workspace from the title input', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: false, versions: [] } })
    api.create.mockResolvedValue({ data: { workspace: workspace() } })
    renderPage()
    fireEvent.change(await screen.findByPlaceholderText(/Pricing title/i), { target: { value: 'Cost Vol III' } })
    fireEvent.click(screen.getByRole('button', { name: /Create/i }))
    await waitFor(() => expect(api.create).toHaveBeenCalledWith('opp1', { title: 'Cost Vol III' }))
  })
  it('surfaces the duplicate-active workspace error via toast', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: false, versions: [] } })
    api.create.mockRejectedValue({ response: { data: { error: 'An active pricing workspace already exists for this opportunity.' } } })
    renderPage()
    fireEvent.change(await screen.findByPlaceholderText(/Pricing title/i), { target: { value: 'Dup' } })
    fireEvent.click(screen.getByRole('button', { name: /Create/i }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/already exists/i), 'error'))
  })
})

describe('scenario editor — lines, calc display, validation', () => {
  it('renders direct labour, indirect, ODC and subcontractor lines with the calculation breakdown', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace(), versions: [] } })
    renderPage()
    expect(await screen.findByText('Engineer')).toBeInTheDocument()
    expect(screen.getAllByText(/\$100,000/).length).toBeGreaterThanOrEqual(1) // direct labour amount (line + summary)
    expect(screen.getAllByText('Fringe').length).toBeGreaterThanOrEqual(1) // indirect rate name + summary row
    expect(screen.getByText('Sub A')).toBeInTheDocument() // subcontractor line
    expect(screen.getByText(/Total proposed price/i)).toBeInTheDocument()
    expect(screen.getByText(/\$261,360/)).toBeInTheDocument()
  })
  it('submits a new labour line', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace(), versions: [] } })
    api.addLabor.mockResolvedValue({ data: { line: {}, totals: {} } })
    renderPage()
    fireEvent.change(await screen.findByPlaceholderText('Category'), { target: { value: 'PM' } })
    fireEvent.change(screen.getByPlaceholderText('Hours'), { target: { value: '10' } })
    fireEvent.change(screen.getByPlaceholderText('Rate'), { target: { value: '150' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Add$/ })[0])
    await waitFor(() => expect(api.addLabor).toHaveBeenCalledWith('s1', expect.objectContaining({ categoryName: 'PM', hours: 10, baseRate: 150 })))
  })
  it('surfaces a negative-value validation error from the backend', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace(), versions: [] } })
    api.addLabor.mockRejectedValue({ response: { data: { error: 'hours must be non-negative' } } })
    renderPage()
    fireEvent.change(await screen.findByPlaceholderText('Category'), { target: { value: 'X' } })
    fireEvent.change(screen.getByPlaceholderText('Hours'), { target: { value: '-5' } })
    fireEvent.change(screen.getByPlaceholderText('Rate'), { target: { value: '100' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Add$/ })[0])
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/non-negative/i), 'error'))
  })
  it('surfaces the circular cost-base validation error for an indirect rate', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace(), versions: [] } })
    api.addIndirect.mockRejectedValue({ response: { data: { error: 'Cost base TOTAL_DIRECT_COST is not valid for a FRINGE rate (would be circular).' } } })
    renderPage()
    fireEvent.change(await screen.findByPlaceholderText('Name'), { target: { value: 'Bad' } })
    fireEvent.change(screen.getByPlaceholderText('%'), { target: { value: '10' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^Add$/ })[1])
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/circular/i), 'error'))
  })
})

describe('workflow + redaction + benchmark', () => {
  it('submits for review from a DRAFT workspace', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace(), versions: [] } })
    api.submit.mockResolvedValue({ data: { workspace: workspace({ status: 'IN_REVIEW' }) } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Submit for review/i }))
    await waitFor(() => expect(api.submit).toHaveBeenCalledWith('w1'))
  })
  it('shows the approved-lock message and hides line-add forms when APPROVED', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace({ status: 'APPROVED' }), versions: [] } })
    renderPage()
    expect(await screen.findByText(/Approved & locked/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Category')).not.toBeInTheDocument()
  })
  it('redacts sensitive rates for CONSULTANT but shows the total price', async () => {
    role = 'CONSULTANT'
    const redacted = scenario({ sensitiveRedacted: true, totalFringe: null, totalOverhead: null, totalGA: null, totalFee: null, subtotalBeforeFee: null, laborLines: [{ id: 'l1', categoryName: 'Engineer', hours: '1000', baseRate: null, escalationPct: null, directLaborAmount: null, personnelCount: null }], indirectRates: [{ id: 'i1', name: 'Fringe', rateType: 'FRINGE', percent: null, costBase: 'DIRECT_LABOUR' }], otherCosts: [] })
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace({ scenarios: [redacted] }), versions: [] } })
    renderPage()
    expect(await screen.findByText(/Sensitive cost rates are hidden/i)).toBeInTheDocument()
    expect(screen.getByText(/\$261,360/)).toBeInTheDocument() // total price still visible
  })
  it('shows the honest no-benchmark state', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace(), versions: [] } })
    renderPage()
    expect(await screen.findByText(/No reliable benchmark available/i)).toBeInTheDocument()
  })
  it('renders the scenario comparison when multiple scenarios exist', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, workspace: workspace(), versions: [] } })
    api.compare.mockResolvedValue({ data: { scenarios: [{ id: 's1', name: 'Base', isPreferred: true, totalPrice: '261360' }, { id: 's2', name: 'Competitive', isPreferred: false, totalPrice: '240000' }], preferredScenarioId: 's1' } })
    renderPage()
    expect(await screen.findByText('Scenario comparison')).toBeInTheDocument()
    expect(screen.getByText('Competitive')).toBeInTheDocument()
  })
})
