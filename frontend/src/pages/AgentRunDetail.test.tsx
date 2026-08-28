// =============================================================
// §7.0 — Agent run detail.
//
// Asserts the run's honesty surfaces reach the screen unmodified: confidence,
// data sufficiency, warnings, limitations, artifacts, errors and the audit
// trail — plus that cancellation is only offered when it is actually possible.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

let mockRole: 'ADMIN' | 'CONSULTANT' = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', role: mockRole } }),
}))

const getRun = vi.fn()
const cancelRun = vi.fn()
vi.mock('../services/agentsApi', () => ({
  agentsApi: {
    getRun: (...a: unknown[]) => getRun(...a),
    cancelRun: (...a: unknown[]) => cancelRun(...a),
  },
}))

import AgentRunDetail from './AgentRunDetail'

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/agents/runs/r1']}>
      <Routes><Route path="/agents/runs/:id" element={<AgentRunDetail />} /></Routes>
    </MemoryRouter>,
  )

const run = (over = {}) => ({
  id: 'r1', agentName: 'Pricing Agent', agentKey: 'PRICING', status: 'COMPLETED',
  triggerType: 'SCHEDULE', triggerEntityType: null, triggerEntityId: null,
  autonomyLevel: 'PROPOSE', idempotencyKey: 'abc', initiatedByUserId: null,
  attempt: 1, maxAttempts: 3, progressPercent: 100, progressStage: null,
  outputSummary: 'Assessed 4 scenarios.', confidenceState: 'MEDIUM', dataSufficiency: 'PARTIAL',
  warnings: [], limitations: [], errorCode: null, errorMessage: null,
  startedAt: '2026-05-01T00:00:00Z', finishedAt: '2026-05-01T00:00:03Z',
  heartbeatAt: '2026-05-01T00:00:02Z', durationMs: 3000, createdAt: '2026-05-01T00:00:00Z',
  tokenInput: 120, tokenOutput: 45, estimatedCostUsd: 0.0032,
  inputSnapshot: null, artifacts: [], escalations: [], schedule: null, event: null,
  auditEvents: [], ...over,
})

beforeEach(() => {
  mockRole = 'ADMIN'
  toast.mockReset(); getRun.mockReset(); cancelRun.mockReset()
  getRun.mockResolvedValue(run())
})

describe('AgentRunDetail', () => {
  it('shows loading then the run header and summary', async () => {
    renderPage()
    expect(screen.getByText(/Loading run/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    expect(screen.getByText('Assessed 4 scenarios.')).toBeInTheDocument()
    expect(screen.getByText('COMPLETED')).toBeInTheDocument()
  })

  it('renders confidence and data sufficiency verbatim', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('MEDIUM')).toBeInTheDocument())
    expect(screen.getByText('PARTIAL')).toBeInTheDocument()
  })

  it('shows token usage and estimated cost', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('120 / 45')).toBeInTheDocument())
    expect(screen.getByText('$0.0032')).toBeInTheDocument()
  })

  it('renders warnings and limitations rather than hiding them', async () => {
    getRun.mockResolvedValue(run({
      warnings: ['One human-verified artifact was left untouched.'],
      limitations: ['Monthly AI budget exhausted — no provider call was made.'],
    }))
    renderPage()
    await waitFor(() => expect(screen.getByText(/human-verified artifact was left untouched/i)).toBeInTheDocument())
    expect(screen.getByText(/Monthly AI budget exhausted/i)).toBeInTheDocument()
  })

  it('renders an error block for a failed run', async () => {
    getRun.mockResolvedValue(run({ status: 'FAILED', errorCode: 'HANDLER_ERROR', errorMessage: 'boom' }))
    renderPage()
    await waitFor(() => expect(screen.getByText('HANDLER_ERROR')).toBeInTheDocument())
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('renders artifacts with their structured data and verification state', async () => {
    getRun.mockResolvedValue(run({
      artifacts: [{
        id: 'a1', runId: 'r1', agentKey: 'PRICING', artifactType: 'PRICING_ASSESSMENT',
        title: 'Pricing assessment', summary: 'Four scenarios.', structuredData: { scenarios: 4 },
        evidence: null, sourceEntityType: null, sourceEntityId: null, confidenceState: 'MEDIUM',
        isHumanVerified: false, verifiedByUserId: null, verifiedAt: null,
        supersededByArtifactId: null, createdAt: '2026-05-01T00:00:03Z',
      }],
    }))
    renderPage()
    await waitFor(() => expect(screen.getByTestId('artifact-a1')).toBeInTheDocument())
    expect(screen.getByText('Pricing assessment')).toBeInTheDocument()
    expect(screen.getByText(/"scenarios": 4/)).toBeInTheDocument()
    expect(screen.getByText('Not verified')).toBeInTheDocument()
  })

  it('states plainly when a run produced no artifacts', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('This run produced no artifacts.')).toBeInTheDocument())
  })

  it('renders the audit trail and marks system actions', async () => {
    getRun.mockResolvedValue(run({
      auditEvents: [
        { id: 'x1', action: 'AGENT_RUN_STARTED', rationale: 'attempt 1/3', actorUserId: null, createdAt: '2026-05-01T00:00:00Z' },
      ],
    }))
    renderPage()
    await waitFor(() => expect(screen.getByText('AGENT_RUN_STARTED')).toBeInTheDocument())
    expect(screen.getByText('(system)')).toBeInTheDocument()
  })

  it('offers cancel only while the run is still cancellable', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Pricing Agent')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /Cancel/i })).not.toBeInTheDocument()

    getRun.mockResolvedValue(run({ status: 'RUNNING', progressPercent: 40, progressStage: 'scoring' }))
    renderPage()
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Cancel/i }).length).toBeGreaterThan(0))
  })

  it('cancels a running run', async () => {
    getRun.mockResolvedValue(run({ status: 'RUNNING' }))
    cancelRun.mockResolvedValue({ cancelled: true })
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('r1'))
  })

  it('disables cancel for a read-only account', async () => {
    mockRole = 'CONSULTANT'
    getRun.mockResolvedValue(run({ status: 'RUNNING' }))
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled())
  })

  it('shows an error state with retry', async () => {
    getRun.mockRejectedValue({ response: { data: { error: 'Run not found.' } } })
    renderPage()
    await waitFor(() => expect(screen.getByText('Run not found.')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })
})
