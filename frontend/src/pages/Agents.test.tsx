// =============================================================
// §7.0 — Agent Operations page.
//
// Pins the honesty rules the slice depends on: an unimplemented agent must
// render NOT IMPLEMENTED with its controls disabled, and a read-only account
// must never be offered a control it cannot use.
// =============================================================
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

let mockRole: 'ADMIN' | 'CONSULTANT' = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', role: mockRole } }),
}))

const getOverview = vi.fn()
const listRuns = vi.fn()
const listEscalations = vi.fn()
const listSchedules = vi.fn()
const getNotificationPreferences = vi.fn()
const triggerRun = vi.fn()
const saveSchedule = vi.fn()
const acknowledgeEscalation = vi.fn()
const resolveEscalation = vi.fn()

vi.mock('../services/agentsApi', () => ({
  agentsApi: {
    getOverview: () => getOverview(),
    listRuns: (...a: unknown[]) => listRuns(...a),
    listEscalations: (...a: unknown[]) => listEscalations(...a),
    listSchedules: () => listSchedules(),
    getNotificationPreferences: () => getNotificationPreferences(),
    triggerRun: (...a: unknown[]) => triggerRun(...a),
    saveSchedule: (...a: unknown[]) => saveSchedule(...a),
    acknowledgeEscalation: (...a: unknown[]) => acknowledgeEscalation(...a),
    resolveEscalation: (...a: unknown[]) => resolveEscalation(...a),
    saveNotificationPreference: vi.fn(),
  },
}))

import Agents from './Agents'

const renderPage = () => render(<MemoryRouter><Agents /></MemoryRouter>)

const agentRow = (over = {}) => ({
  key: 'PRICING', name: 'Pricing Agent', description: 'Keeps pricing sound.',
  implemented: false, plannedSlice: '7.6', requiresLlm: false,
  isEnabled: false, isConfigured: false, autonomyLevel: 'PROPOSE',
  scheduleType: null, cronExpression: '0 */12 * * *', timezone: 'UTC',
  nextRunAt: null, lastRunAt: null, lastSuccessfulRunAt: null,
  lastFailureAt: null, lastFailureMessage: null, consecutiveFailures: 0,
  openEscalations: 0, lastRun: null, ...over,
})

beforeEach(() => {
  mockRole = 'ADMIN'
  toast.mockReset()
  getOverview.mockReset(); listRuns.mockReset(); listEscalations.mockReset()
  listSchedules.mockReset(); getNotificationPreferences.mockReset()
  triggerRun.mockReset(); saveSchedule.mockReset()
  acknowledgeEscalation.mockReset(); resolveEscalation.mockReset()

  getOverview.mockResolvedValue([agentRow()])
  listRuns.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 })
  listEscalations.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, totalPages: 1 })
  listSchedules.mockResolvedValue([])
  getNotificationPreferences.mockResolvedValue([])
})

describe('Agents — overview honesty', () => {
  it('shows a loading state then the agent cards', async () => {
    renderPage()
    expect(screen.getByText(/Loading agents/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
  })

  it('renders NOT IMPLEMENTED — never a fake healthy state', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('NOT IMPLEMENTED')).toBeInTheDocument())
    expect(screen.queryByText('ENABLED')).not.toBeInTheDocument()
    expect(screen.getByText(/Planned in slice 7\.6/i)).toBeInTheDocument()
  })

  it('disables Run now for an unimplemented agent', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Run now/i })).toBeDisabled()
  })

  it('enables Run now for an implemented agent and triggers it', async () => {
    getOverview.mockResolvedValue([agentRow({ implemented: true, isEnabled: true })])
    triggerRun.mockResolvedValue({ created: true, run: {} })
    renderPage()
    await waitFor(() => expect(screen.getByText('ENABLED')).toBeInTheDocument())

    const btn = screen.getByRole('button', { name: /Run now/i })
    expect(btn).toBeEnabled()
    fireEvent.click(btn)

    await waitFor(() => expect(triggerRun).toHaveBeenCalledWith({ agentKey: 'PRICING' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Agent run queued.', 'success'))
  })

  it('reports an idempotent re-trigger without claiming a new run', async () => {
    getOverview.mockResolvedValue([agentRow({ implemented: true })])
    triggerRun.mockResolvedValue({ created: false, note: 'An identical run already exists.', run: {} })
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Run now/i }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('An identical run already exists.', 'info'))
  })

  it('surfaces the implemented-count summary', async () => {
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId('agent-implementation-summary')).toHaveTextContent('0 of 1 agents implemented'),
    )
  })

  it('shows the last failure message when present', async () => {
    getOverview.mockResolvedValue([agentRow({ lastFailureMessage: 'Provider timed out' })])
    renderPage()
    await waitFor(() => expect(screen.getByText('Provider timed out')).toBeInTheDocument())
  })

  it('shows an error state with retry', async () => {
    getOverview.mockRejectedValue({ response: { data: { error: 'Backend unavailable' } } })
    renderPage()
    await waitFor(() => expect(screen.getByText('Backend unavailable')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })
})

describe('Agents — permission states', () => {
  it('warns a read-only account and disables its controls', async () => {
    mockRole = 'CONSULTANT'
    getOverview.mockResolvedValue([agentRow({ implemented: true, isEnabled: true })])
    renderPage()

    await waitFor(() => expect(screen.getByText(/read-only access/i)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Run now/i })).toBeDisabled()
  })

  it('does not show the read-only warning to an admin', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    expect(screen.queryByText(/read-only access/i)).not.toBeInTheDocument()
  })
})

describe('Agents — run history', () => {
  it('shows the empty state with a useful hint', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Run history/i }))
    await waitFor(() => expect(screen.getByText(/No agent runs yet/i)).toBeInTheDocument())
  })

  it('renders runs and supports filtering by status', async () => {
    listRuns.mockResolvedValue({
      items: [{
        id: 'r1', agentKey: 'PRICING', status: 'COMPLETED', triggerType: 'MANUAL',
        triggerEntityType: null, triggerEntityId: null, attempt: 1, maxAttempts: 3,
        progressPercent: 100, progressStage: null, outputSummary: 'All good',
        confidenceState: 'HIGH', dataSufficiency: 'SUFFICIENT', startedAt: '2026-05-01T00:00:00Z',
        finishedAt: '2026-05-01T00:00:05Z', durationMs: 5000, createdAt: '2026-05-01T00:00:00Z',
        errorCode: null, tokenInput: 0, tokenOutput: 0, estimatedCostUsd: 0,
      }],
      total: 1, page: 1, pageSize: 25, totalPages: 1,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Run history/i }))

    await waitFor(() => expect(screen.getByTestId('run-row-r1')).toBeInTheDocument())
    expect(screen.getByText('All good')).toBeInTheDocument()
    // Scope to the row: "COMPLETED" also appears as a filter dropdown option.
    expect(within(screen.getByTestId('run-row-r1')).getByText('COMPLETED')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'FAILED' } })
    await waitFor(() => expect(listRuns).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'FAILED' })))
  })

  it('shows an error state for run history', async () => {
    listRuns.mockRejectedValue({ response: { data: { error: 'Run query failed' } } })
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Run history/i }))
    await waitFor(() => expect(screen.getByText('Run query failed')).toBeInTheDocument())
  })
})

describe('Agents — escalations', () => {
  const escalation = (over = {}) => ({
    id: 'e1', runId: 'r1', agentKey: 'PRICING', severity: 'HIGH', status: 'OPEN',
    title: 'Needs a human', reason: 'The agent refused to decide.',
    recommendedAction: 'Review the pricing.', entityType: null, entityId: null,
    dueAt: null, acknowledgedAt: null, resolvedAt: null, resolution: null,
    createdAt: '2026-05-01T00:00:00Z', ...over,
  })

  it('shows the empty state', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Escalations/i }))
    await waitFor(() => expect(screen.getByText('No escalations.')).toBeInTheDocument())
  })

  it('acknowledges an open escalation', async () => {
    listEscalations.mockResolvedValue({ items: [escalation()], total: 1, page: 1, pageSize: 25, totalPages: 1 })
    acknowledgeEscalation.mockResolvedValue({})
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Escalations/i }))

    await waitFor(() => expect(screen.getByText('Needs a human')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(acknowledgeEscalation).toHaveBeenCalledWith('e1'))
  })

  it('requires a resolution note before resolving', async () => {
    listEscalations.mockResolvedValue({ items: [escalation()], total: 1, page: 1, pageSize: 25, totalPages: 1 })
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Escalations/i }))
    await waitFor(() => expect(screen.getByText('Needs a human')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    fireEvent.click(screen.getByRole('button', { name: /Confirm resolve/i }))

    await waitFor(() => expect(toast).toHaveBeenCalledWith('A resolution note is required.', 'warning'))
    expect(resolveEscalation).not.toHaveBeenCalled()
  })

  it('resolves with a note', async () => {
    listEscalations.mockResolvedValue({ items: [escalation()], total: 1, page: 1, pageSize: 25, totalPages: 1 })
    resolveEscalation.mockResolvedValue({})
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Escalations/i }))
    await waitFor(() => expect(screen.getByText('Needs a human')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    fireEvent.change(screen.getByLabelText('Resolution note'), { target: { value: 'Reviewed and accepted.' } })
    fireEvent.click(screen.getByRole('button', { name: /Confirm resolve/i }))

    await waitFor(() => expect(resolveEscalation).toHaveBeenCalledWith('e1', 'Reviewed and accepted.'))
  })

  it('disables escalation actions for a read-only account', async () => {
    mockRole = 'CONSULTANT'
    listEscalations.mockResolvedValue({ items: [escalation()], total: 1, page: 1, pageSize: 25, totalPages: 1 })
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Escalations/i }))
    await waitFor(() => expect(screen.getByText('Needs a human')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeDisabled()
  })
})

describe('Agents — schedules', () => {
  it('states the PROPOSE default and blocks enabling an unimplemented agent', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Schedules/i }))

    await waitFor(() => expect(screen.getByTestId('schedule-PRICING')).toBeInTheDocument())
    expect(screen.getByText(/never silently changes verified business records/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Enable/i })).toBeDisabled()
  })

  it('saves an autonomy change for an implemented agent', async () => {
    getOverview.mockResolvedValue([agentRow({ implemented: true })])
    saveSchedule.mockResolvedValue({})
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Schedules/i }))

    await waitFor(() => expect(screen.getByTestId('schedule-PRICING')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText(/Autonomy level for Pricing Agent/i), { target: { value: 'OBSERVE' } })
    await waitFor(() => expect(saveSchedule).toHaveBeenCalledWith('PRICING', { autonomyLevel: 'OBSERVE' }))
  })
})

describe('Agents — notification preferences', () => {
  it('renders the effective defaults and marks them as defaults', async () => {
    getNotificationPreferences.mockResolvedValue([{
      agentKey: 'PRICING', agentName: 'Pricing Agent', isExplicit: false,
      inAppEnabled: true, emailEnabled: false, minimumSeverity: 'MEDIUM',
      notifyOnSuccess: false, notifyOnFailure: true, notifyOnEscalation: true,
      digestMode: false, timezone: 'UTC',
    }])
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Notifications/i }))

    await waitFor(() => expect(screen.getByTestId('pref-PRICING')).toBeInTheDocument())
    expect(screen.getByText('(default)')).toBeInTheDocument()
    expect(screen.getByLabelText(/Notify on failure for Pricing Agent/i)).toBeChecked()
    expect(screen.getByLabelText(/Notify on success for Pricing Agent/i)).not.toBeChecked()
  })

  it('explains why a read-only account cannot save a preference', async () => {
    mockRole = 'CONSULTANT'
    getNotificationPreferences.mockResolvedValue([{
      agentKey: 'PRICING', agentName: 'Pricing Agent', isExplicit: false,
      inAppEnabled: true, emailEnabled: false, minimumSeverity: 'MEDIUM',
      notifyOnSuccess: false, notifyOnFailure: true, notifyOnEscalation: true,
      digestMode: false, timezone: 'UTC',
    }])
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('tab', { name: /Notifications/i }))

    await waitFor(() => expect(screen.getByText(/team-member accounts are read-only/i)).toBeInTheDocument())
    expect(screen.getByLabelText(/Notify on failure for Pricing Agent/i)).toBeDisabled()
  })
})

// The card is entirely registry-driven, so the page needs no per-agent code.
// §7.9 completed Section 7: ALL NINE domain agents are implemented. These pin
// that every card renders as implemented and none renders NOT IMPLEMENTED.
describe('Agent Operations — delivered agents', () => {
  const DELIVERED = [
    { key: 'OPPORTUNITY', name: 'Opportunity Agent', plannedSlice: '7.2' },
    { key: 'CONTRACT_ADMINISTRATION', name: 'Contract Administration Agent', plannedSlice: '7.1' },
    { key: 'COMPLIANCE', name: 'Compliance Agent', plannedSlice: '7.3' },
    { key: 'QUALIFICATION', name: 'Qualification Agent', plannedSlice: '7.4' },
    { key: 'TEAMING', name: 'Teaming Agent', plannedSlice: '7.5' },
    { key: 'PRICING', name: 'Pricing Agent', plannedSlice: '7.6' },
    { key: 'PROPOSAL', name: 'Proposal Agent', plannedSlice: '7.7' },
    { key: 'FINANCE', name: 'Finance Agent', plannedSlice: '7.8' },
    { key: 'INTELLIGENCE', name: 'Intelligence Agent', plannedSlice: '7.9' },
  ]
  const REMAINING: Array<{ key: string; name: string; plannedSlice: string }> = []

  const fullRegistry = () => [
    ...DELIVERED.map((d) => agentRow({ ...d, implemented: true, isEnabled: true })),
    ...REMAINING.map((r) => agentRow({ ...r, implemented: false, isEnabled: false })),
  ]

  it('shows the Opportunity Agent as implemented and enabled', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-OPPORTUNITY')
    expect(within(card).getByText('ENABLED')).toBeInTheDocument()
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it('keeps Contract Administration implemented', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-CONTRACT_ADMINISTRATION')
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it('shows the Compliance Agent as implemented after §7.3', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-COMPLIANCE')
    expect(within(card).getByText('ENABLED')).toBeInTheDocument()
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it.each(DELIVERED)('renders $name as implemented with Run now enabled', async ({ key }) => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId(`agent-card-${key}`)
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
    expect(within(card).getByRole('button', { name: /Run now/i })).not.toBeDisabled()
  })

  it('shows the Qualification Agent as implemented after §7.4', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-QUALIFICATION')
    expect(within(card).getByText('ENABLED')).toBeInTheDocument()
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it('shows the Teaming Agent as implemented after §7.5', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-TEAMING')
    expect(within(card).getByText('ENABLED')).toBeInTheDocument()
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it('shows the Pricing Agent as implemented after §7.6', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-PRICING')
    expect(within(card).getByText('ENABLED')).toBeInTheDocument()
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it('shows the Proposal Agent as implemented after §7.7', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-PROPOSAL')
    expect(within(card).getByText('ENABLED')).toBeInTheDocument()
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it('shows the Finance Agent as implemented after §7.8', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-FINANCE')
    expect(within(card).getByText('ENABLED')).toBeInTheDocument()
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it('shows the Intelligence Agent as implemented after §7.9', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    const card = await screen.findByTestId('agent-card-INTELLIGENCE')
    expect(within(card).getByText('ENABLED')).toBeInTheDocument()
    expect(within(card).queryByText('NOT IMPLEMENTED')).toBeNull()
  })

  it('reports nine of nine implemented — Section 7 is complete', async () => {
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId('agent-implementation-summary')).toHaveTextContent('9 of 9 agents implemented'),
    )
  })

  it('leaves no domain agent unimplemented', async () => {
    expect(REMAINING).toHaveLength(0)
    getOverview.mockResolvedValue(fullRegistry())
    renderPage()
    await screen.findByTestId('agent-card-INTELLIGENCE')
    expect(screen.queryByText('NOT IMPLEMENTED')).toBeNull()
  })
})
