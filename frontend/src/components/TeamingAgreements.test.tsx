// =============================================================
// §5.1 Stage 4 Teaming agreements tracker — states, agreement/NDA status,
// reminders, draft-with-disclaimer, role-gated controls.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role } }) }))
vi.mock('./Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const listArrangements = vi.fn()
const reminders = vi.fn()
const updateArrangement = vi.fn()
const generateDraft = vi.fn()
vi.mock('../services/api', () => ({
  teamingApi: {
    listArrangements: () => listArrangements(), reminders: () => reminders(),
    updateArrangement: (...a: unknown[]) => updateArrangement(...a), generateDraft: (...a: unknown[]) => generateDraft(...a),
    dispatchReminders: vi.fn(), uploadAttachment: vi.fn(),
  },
}))

import { TeamingAgreements } from './TeamingAgreements'

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><TeamingAgreements /></QueryClientProvider>)
}
const arrangement = (over = {}) => ({ id: 'a1', role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', scopePercent: 30, teamingStatus: 'COMMITTED', agreementStatus: 'SENT', ndaStatus: 'NONE', agreementDueDate: '2026-07-01T00:00:00Z', agreementDocumentName: null, workshareDescription: null, capabilityContribution: null, partner: { id: 'p1', name: 'Acme Federal' }, opportunity: { id: 'o1', title: 'Radar Opp', agency: 'DoD' }, ...over })

beforeEach(() => {
  role = 'ADMIN'
  listArrangements.mockReset(); reminders.mockReset(); updateArrangement.mockReset(); generateDraft.mockReset()
  reminders.mockResolvedValue({ data: { reminders: [], total: 0, overdue: 0 } })
  updateArrangement.mockResolvedValue({ data: {} })
})

describe('TeamingAgreements', () => {
  it('shows an empty state when there are no arrangements', async () => {
    listArrangements.mockResolvedValue({ data: { arrangements: [] } })
    renderIt()
    expect(await screen.findByText(/no teaming arrangements yet/i)).toBeInTheDocument()
  })

  it('shows an error state when arrangements fail to load', async () => {
    listArrangements.mockResolvedValue({ data: { arrangements: [] } })
    listArrangements.mockRejectedValueOnce(new Error('boom'))
    renderIt()
    await waitFor(() => expect(screen.getByText(/could not load teaming arrangements/i)).toBeInTheDocument())
  })

  it('renders arrangement rows with agreement + NDA status and workshare', async () => {
    listArrangements.mockResolvedValue({ data: { arrangements: [arrangement()] } })
    renderIt()
    expect(await screen.findByText('Acme Federal')).toBeInTheDocument()
    expect(screen.getByText('Radar Opp')).toBeInTheDocument()
    expect(screen.getByText('30%')).toBeInTheDocument()
  })

  it('lets an ADMIN change the agreement status and generate a draft (with disclaimer)', async () => {
    listArrangements.mockResolvedValue({ data: { arrangements: [arrangement()] } })
    generateDraft.mockResolvedValue({ data: { draft: { teamingArrangementId: 'a1', content: 'DRAFT FOR REVIEW — NOT LEGAL ADVICE — NOT EXECUTED.\n\nbody' } } })
    renderIt()
    await screen.findByText('Acme Federal')
    fireEvent.click(screen.getByRole('button', { name: /draft agreement/i }))
    await waitFor(() => expect(generateDraft).toHaveBeenCalledWith('a1', { draftType: 'TEAMING_AGREEMENT' }))
    expect(await screen.findByText('Draft for review — not legal advice')).toBeInTheDocument() // the badge (exact)
  })

  it('surfaces overdue reminders', async () => {
    listArrangements.mockResolvedValue({ data: { arrangements: [] } })
    reminders.mockResolvedValue({ data: { total: 1, overdue: 1, reminders: [{ arrangement: { id: 'a1', partner: { name: 'Acme' }, opportunity: { title: 'Radar' } }, overdue: true, reasons: ['agreement overdue'] }] } })
    renderIt()
    expect(await screen.findByText(/agreement overdue/i)).toBeInTheDocument()
  })

  it('hides admin controls for a CONSULTANT (status shown read-only)', async () => {
    listArrangements.mockResolvedValue({ data: { arrangements: [arrangement()] } })
    role = 'CONSULTANT'
    renderIt()
    await screen.findByText('Acme Federal')
    expect(screen.queryByRole('button', { name: /draft agreement/i })).not.toBeInTheDocument()
    expect(screen.getByText('SENT')).toBeInTheDocument()
  })
})
