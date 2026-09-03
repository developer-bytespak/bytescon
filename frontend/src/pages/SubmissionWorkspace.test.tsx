// =============================================================
// §5.1 Stage 7 Submission page — loading/empty/error/permission states, checklist
// generation, manual item add, readiness (completion vs readiness, false-100%
// prevention, blocking reasons), blocker + validation display, mark-ready +
// override-reason, submit + duplicate error, status history, overdue deadline,
// and the "user-recorded / not a government-portal submission" disclaimer.
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
  getWorkspace: vi.fn(), get: vi.fn(), create: vi.fn(), update: vi.fn(), archive: vi.fn(),
  generateChecklist: vi.fn(), addItem: vi.fn(), updateItem: vi.fn(), block: vi.fn(), resolveBlocker: vi.fn(),
  validateItem: vi.fn(), readiness: vi.fn(), markReady: vi.fn(), submit: vi.fn(), history: vi.fn(), reminders: vi.fn(),
}
vi.mock('../services/api', () => ({
  opportunitiesApi: { getById: (...a: unknown[]) => api.get(...a) },
  submissionApi: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as any)[k]?.(...a) }),
}))

import SubmissionWorkspace from './SubmissionWorkspace'

function item(over: Record<string, unknown> = {}) {
  return { id: 'it1', title: 'Cover letter', itemType: 'DOCUMENT', isMandatory: true, status: 'PENDING', isBlocker: false, blockerReason: null, validationState: 'UNVALIDATED', validationEvidence: null, dueDate: null, attachmentName: null, ...over }
}
function submission(over: Record<string, unknown> = {}) {
  return { id: 'sub1', title: 'Final Submission', status: 'IN_PROGRESS', readinessPercent: 50, finalDeadline: null, internalDeadline: null, confirmationReference: null, items: [item()], ...over }
}
function readiness(over: Record<string, unknown> = {}) {
  return { overallPercent: 50, mandatoryPercent: 50, canBeReady: false, blockerCount: 0, incompleteMandatoryCount: 1, overdueCount: 0, blockingReasons: ['1 mandatory item(s) incomplete'], ...over }
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><SubmissionWorkspace /></QueryClientProvider>)
}

beforeEach(() => {
  role = 'ADMIN'; toast.mockReset(); navigate.mockReset()
  Object.values(api).forEach((f) => f.mockReset())
  api.get.mockResolvedValue({ data: { id: 'opp1', title: 'Cyber RFP' } })
  api.history.mockResolvedValue({ data: { history: [] } })
})

describe('states', () => {
  it('shows a loading spinner before data resolves', () => {
    api.getWorkspace.mockReturnValue(new Promise(() => {}))
    const { container } = renderPage()
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })
  it('shows the empty state with a create form for ADMIN', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: false } })
    renderPage()
    expect(await screen.findByText(/No submission workspace yet/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Submission title/i)).toBeInTheDocument()
  })
  it('shows an error panel on API failure', async () => {
    api.getWorkspace.mockRejectedValue(new Error('boom'))
    renderPage()
    expect(await screen.findByText(/Could not load submission/i)).toBeInTheDocument()
  })
  it('shows read-only messaging for CONSULTANT', async () => {
    role = 'CONSULTANT'
    api.getWorkspace.mockResolvedValue({ data: { exists: false } })
    renderPage()
    expect(await screen.findByText(/Read-only access/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Submission title/i)).not.toBeInTheDocument()
  })
})

describe('checklist', () => {
  it('generates the checklist from verified requirements', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission(), readiness: readiness() } })
    api.generateChecklist.mockResolvedValue({ data: { added: 3, readiness: readiness() } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Generate checklist/i }))
    await waitFor(() => expect(api.generateChecklist).toHaveBeenCalledWith('sub1'))
  })
  it('adds a manual checklist item', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission(), readiness: readiness() } })
    api.addItem.mockResolvedValue({ data: { item: item(), readiness: readiness() } })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Add item/i }))
    fireEvent.change(screen.getByPlaceholderText('Item title'), { target: { value: 'Signature page' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))
    await waitFor(() => expect(api.addItem).toHaveBeenCalledWith('sub1', expect.objectContaining({ title: 'Signature page' })))
  })
})

describe('readiness — completion vs readiness, blockers, validation display', () => {
  it('does NOT show ready at 100% completion when a blocker remains', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission({ items: [item({ status: 'COMPLETE' }), item({ id: 'b1', title: 'blk', isBlocker: true, status: 'BLOCKED', blockerReason: 'awaiting signature' })] }), readiness: readiness({ overallPercent: 100, mandatoryPercent: 100, canBeReady: false, blockerCount: 1, incompleteMandatoryCount: 0, blockingReasons: ['1 unresolved blocker(s)'] }) } })
    renderPage()
    expect(await screen.findByText(/Not marked ready/i)).toBeInTheDocument()
    expect(screen.getByText(/unresolved blocker/i)).toBeInTheDocument()
    expect(screen.getByText(/Blocker: awaiting signature/i)).toBeInTheDocument()
  })
  it('shows FAILED / manual-required validation state on an item', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission({ items: [item({ validationState: 'FAILED', validationEvidence: 'Required document is missing (no file attached).' })] }), readiness: readiness() } })
    renderPage()
    expect(await screen.findByText('FAILED')).toBeInTheDocument()
    expect(screen.getByText(/Required document is missing/i)).toBeInTheDocument()
  })
  it('shows a ready state when canBeReady is true', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission({ items: [item({ status: 'COMPLETE' })] }), readiness: readiness({ overallPercent: 100, mandatoryPercent: 100, canBeReady: true, incompleteMandatoryCount: 0, blockingReasons: [] }) } })
    renderPage()
    await waitFor(() => expect(screen.getAllByText(/Ready to submit/i).length).toBeGreaterThanOrEqual(1))
  })
})

describe('workflow', () => {
  it('marks ready and forces an override reason when the backend reports not-ready', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission(), readiness: readiness() } })
    api.markReady.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Not ready: 1 mandatory item(s) incomplete.' } } }).mockResolvedValueOnce({ data: { submission: submission({ status: 'READY_TO_SUBMIT' }) } })
    vi.stubGlobal('prompt', vi.fn(() => 'client accepts risk'))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Mark ready to submit/i }))
    await waitFor(() => expect(api.markReady).toHaveBeenCalledWith('sub1', 'client accepts risk'))
    vi.unstubAllGlobals()
  })
  it('surfaces the duplicate-submission error', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission({ status: 'READY_TO_SUBMIT' }), readiness: readiness({ canBeReady: true }) } })
    api.submit.mockRejectedValue({ response: { status: 409, data: { error: 'This submission has already been submitted.' } } })
    vi.stubGlobal('prompt', vi.fn(() => 'REF'))
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Record submission/i }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringMatching(/already been submitted/i), 'error'))
    vi.unstubAllGlobals()
  })
  it('shows the "user-recorded / not a government portal" disclaimer', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission(), readiness: readiness() } })
    renderPage()
    expect(await screen.findByText(/does not submit to any government portal/i)).toBeInTheDocument()
  })
})

describe('history + deadline', () => {
  it('renders retained status history', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission({ status: 'SUBMITTED' }), readiness: readiness({ canBeReady: true }) } })
    api.history.mockResolvedValue({ data: { history: [{ id: 'h1', action: 'submitted', toStatus: 'SUBMITTED', createdAt: new Date().toISOString(), comment: null }] } })
    renderPage()
    expect(await screen.findByText(/Status history/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByText(/submitted/i).length).toBeGreaterThanOrEqual(1))
  })
  it('flags an overdue final deadline', async () => {
    api.getWorkspace.mockResolvedValue({ data: { exists: true, submission: submission({ finalDeadline: new Date(Date.now() - 86_400_000).toISOString() }), readiness: readiness() } })
    renderPage()
    expect(await screen.findByText(/passed/i)).toBeInTheDocument()
  })
})
