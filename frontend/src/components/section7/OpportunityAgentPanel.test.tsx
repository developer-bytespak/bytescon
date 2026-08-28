// =============================================================
// §7.2 — Opportunity Agent panel.
//
// Pins the honesty rules the slice depends on: an unrun agent is never rendered
// as healthy, a failing source is named rather than hidden, INSUFFICIENT DATA
// offers no Apply control at all, applying is ADMIN-only and requires explicit
// confirmation, and an applied learned adjustment is always disclosed.
// =============================================================
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const toast = vi.fn()
vi.mock('../Toast', () => ({ useToast: () => ({ toast }) }))

let mockRole: 'ADMIN' | 'CONSULTANT' = 'ADMIN'
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', role: mockRole } }),
}))

const getLatest = vi.fn()
const applyFeedback = vi.fn()
const revertFeedback = vi.fn()
vi.mock('../../services/opportunityAgentApi', () => ({
  opportunityAgentApi: {
    getLatest: () => getLatest(),
    applyFeedback: (...a: unknown[]) => applyFeedback(...a),
    revertFeedback: (...a: unknown[]) => revertFeedback(...a),
  },
}))

import { OpportunityAgentPanel } from './OpportunityAgentPanel'

const wrap = () => render(<MemoryRouter><OpportunityAgentPanel /></MemoryRouter>)

const POLICY = {
  minimumSampleSize: 20,
  minimumClassSize: 3,
  maxWeightAdjustmentPct: 0.25,
  criticalMatchScore: 85,
  highMatchScore: 70,
  criticalDeadlineWorkingDays: 5,
  learnableDimensions: ['capability', 'naics'],
  baseWeights: { capability: 0.28, naics: 0.18 },
  notes: ['Learned weights are advisory: nothing changes until an ADMIN applies them.'],
}

const source = (over = {}) => ({
  sourceConfigId: 's1', displayName: 'SAM.gov', adapterKey: 'sam_gov', category: 'SAM_GOV',
  isEnabled: true, state: 'OK', verification: 'LIVE_VERIFIED', dataQuality: 'OK',
  consecutiveFailures: 0, stalenessHours: 24, ageHours: 1, freshnessLabel: 'Synced 1h ago',
  lastSuccessfulSync: '2026-06-01T07:00:00Z', lastFailureAt: null, lastFailureMessage: null,
  nextRunAt: '2026-06-01T08:00:00Z', ...over,
})

const signal = (over = {}) => ({
  id: 'sig1', status: 'PROPOSED', algorithmVersion: 'pursuit-feedback-v1',
  sampleSize: 24, pursuedSampleSize: 12, ignoredSampleSize: 12, minimumSampleSize: 20,
  confidenceState: 'LOW', dataSufficiency: 'PARTIAL',
  baselineWeights: { capability: 0.28, naics: 0.18 },
  proposedWeights: { capability: 0.31, naics: 0.2 },
  evidence: {
    dimensions: [
      { dimension: 'capability', pursuedCount: 12, ignoredCount: 12, pursuedMean: 90, ignoredMean: 20, delta: 0.7, baseWeight: 0.28, adjustedWeight: 0.329, proposedWeight: 0.31, explanation: 'Pursued opportunities average 90 on capability against 20 for declined ones.' },
    ],
  },
  summary: '24 labelled decision(s). Production matching is unchanged until an administrator applies it.',
  generatedByRunId: 'run1', generatedAt: '2026-06-01T07:00:00Z',
  appliedByUserId: null, appliedAt: null, revertedByUserId: null, revertedAt: null,
  supersededBySignalId: null, supersededAt: null, ...over,
})

const latest = (over: Record<string, unknown> = {}) => ({
  agentKey: 'OPPORTUNITY',
  schedule: {
    isEnabled: true, scheduleType: 'CRON', cronExpression: '0 */2 * * *', intervalMinutes: null,
    timezone: 'UTC', nextRunAt: '2026-06-01T10:00:00Z', lastRunAt: '2026-06-01T08:00:00Z',
    lastSuccessfulRunAt: '2026-06-01T08:00:05Z', lastFailureAt: null, lastFailureMessage: null,
    consecutiveFailures: 0, autonomyLevel: 'PROPOSE',
  },
  lastRun: {
    id: 'run1abcdef', status: 'COMPLETED', triggerType: 'SCHEDULE', progressPercent: 100,
    progressStage: 'COMPLETE', createdAt: '2026-06-01T08:00:00Z', finishedAt: '2026-06-01T08:00:05Z',
    outputSummary: '12 live opportunit(ies) · 1 critical match(es)', confidenceState: 'HIGH',
    dataSufficiency: 'SUFFICIENT', warnings: [], limitations: [], errorMessage: null,
    tokenInput: 0, tokenOutput: 0, estimatedCostUsd: '0.000000',
  },
  lastSuccessfulRun: { id: 'run1abcdef', finishedAt: '2026-06-01T08:00:05Z', outputSummary: 'ok' },
  brief: {
    artifactId: 'a1', runId: 'run1abcdef', generatedAt: '2026-06-01T08:00:00Z', summary: '12 live',
    tenantSummary: {
      liveOpportunities: 12, newOpportunities: 2, changedOpportunities: 1,
      highPriorityMatches: 1, criticalMatches: 1, preSolicitationCount: 1,
      recompeteCount: 1, forecastCount: 1,
    },
    highMatchOpportunities: [{
      opportunityId: 'o1', title: 'Cyber support services', agency: 'DoD',
      deadline: '2026-06-05T00:00:00Z', source: 'SAM_GOV', noticeType: 'Solicitation',
      priority: 'CRITICAL', matchScore: 92, baseMatchScore: 88, weightProfile: 'BASE',
      matchDimensions: [], eligibility: 'ELIGIBLE', eligibilityReason: 'Certification active',
      certificationWarnings: [], whyItMatched: ['3 of 4 capabilities align.'],
      workingDaysToDeadline: 3, evidence: [],
    }],
    preSolicitation: [{
      opportunityId: 'o2', title: 'Market research', agency: 'GSA', noticeType: 'Sources Sought',
      kind: 'SOURCES_SOUGHT', label: 'Sources Sought', basis: 'NOTICE_TYPE',
      responseDeadline: '2026-06-20T00:00:00Z', capabilityFit: 60, eligibility: 'ELIGIBLE',
      whyEarlyResponseMayMatter: 'Responding does not guarantee influence, consideration, or award.',
    }],
    recompetes: [{
      signalId: 'r1', sourceContractId: 'c1', incumbent: 'Acme', agency: 'GSA',
      contractNumber: 'GS-00-1234', estimatedWindowStart: '2026-09-01T00:00:00Z',
      estimatedWindowEnd: '2027-03-01T00:00:00Z', confidence: 'AMBIGUOUS',
      confidenceReason: 'Derived from period-of-performance evidence.', status: 'UNVERIFIED',
      requiresHumanAcceptance: true,
    }],
    forecasts: [{
      forecastId: 'f1', title: 'Planned cyber buy', agency: 'DoD',
      anticipatedSolicitationDate: '2026-10-01T00:00:00Z', linkState: 'REVIEW_REQUIRED',
      linkedOpportunityId: null, linkConfidence: 0.6, requiresHumanConfirmation: true,
      note: 'A forecast is an agency planning record, not a released solicitation.',
    }],
    pursuitLearning: {
      status: 'PROPOSED', sampleSize: 24, pursuedSampleSize: 12, ignoredSampleSize: 12,
      minimumSampleSize: 20, confidence: 'LOW', proposedAdjustmentId: 'sig1',
      appliedAdjustmentId: null, effectiveWeightProfile: 'BASE', reason: 'ok',
    },
    operations: {
      successfulSources: ['SAM.gov'], failedSources: [], staleSources: [], notConfiguredSources: [],
      successfulPhases: ['LOAD_CONTEXT'], failedPhases: [],
    },
    warnings: [], dataLimitations: [],
  },
  sourceHealth: [source()],
  sourceTotals: { total: 1, healthy: 1, failing: 0, stale: 0, notConfigured: 0 },
  escalations: [],
  learning: {
    effectiveWeightProfile: 'BASE',
    effectiveWeights: { capability: 0.28, naics: 0.18 },
    appliedSignal: null,
    proposedSignal: signal(),
    insufficientSignal: null,
  },
  policy: POLICY,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockRole = 'ADMIN'
  getLatest.mockResolvedValue(latest())
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// -------------------------------------------------------------
// States
// -------------------------------------------------------------

describe('states', () => {
  it('shows a loading state first', () => {
    getLatest.mockReturnValue(new Promise(() => {}))
    wrap()
    expect(screen.getByText(/Loading Opportunity Agent status/i)).toBeInTheDocument()
  })

  it('shows an error state with a retry', async () => {
    getLatest.mockRejectedValue({ response: { data: { error: 'boom' } } })
    wrap()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('never renders an unrun agent as healthy', async () => {
    getLatest.mockResolvedValue(latest({ brief: null, lastRun: null, lastSuccessfulRun: null }))
    wrap()
    await waitFor(() => expect(screen.getByTestId('last-run')).toHaveTextContent('Never run'))
    expect(screen.getByText(/has not produced a brief yet/i)).toBeInTheDocument()
  })

  it('renders the latest run and next scheduled run', async () => {
    wrap()
    await waitFor(() => expect(screen.getByTestId('last-run')).toHaveTextContent('COMPLETED'))
    expect(screen.getByText('IMPLEMENTED')).toBeInTheDocument()
    expect(screen.getByText('ENABLED')).toBeInTheDocument()
  })

  it('reports zero tokens and zero cost', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText(/0 tokens/)).toBeInTheDocument())
    expect(screen.getByText(/\$0\.00/)).toBeInTheDocument()
  })

  it('shows a disabled agent as disabled rather than absent', async () => {
    getLatest.mockResolvedValue(latest({ schedule: { ...latest().schedule, isEnabled: false } }))
    wrap()
    await waitFor(() => expect(screen.getByText('DISABLED')).toBeInTheDocument())
  })

  it('refreshes on demand', async () => {
    wrap()
    await waitFor(() => expect(getLatest).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByLabelText(/Refresh Opportunity Agent status/i))
    await waitFor(() => expect(getLatest).toHaveBeenCalledTimes(2))
  })
})

// -------------------------------------------------------------
// Source health
// -------------------------------------------------------------

describe('source health', () => {
  it('names a failing source rather than hiding the failure', async () => {
    getLatest.mockResolvedValue(latest({
      sourceHealth: [source({ state: 'FAILING', consecutiveFailures: 6, lastFailureMessage: 'provider returned 503' })],
      sourceTotals: { total: 1, healthy: 0, failing: 1, stale: 0, notConfigured: 0 },
    }))
    wrap()
    const list = await screen.findByTestId('source-health-list')
    expect(within(list).getByText('FAILING')).toBeInTheDocument()
    expect(within(list).getByText(/provider returned 503/)).toBeInTheDocument()
  })

  it('shows the source\'s own staleness window, not a global rule', async () => {
    getLatest.mockResolvedValue(latest({
      sourceHealth: [source({ state: 'STALE', stalenessHours: 6, freshnessLabel: 'Stale — last successful sync 48h ago' })],
    }))
    wrap()
    const list = await screen.findByTestId('source-health-list')
    expect(within(list).getByText(/staleness window 6h/)).toBeInTheDocument()
  })

  it('warns that a brief built with failing sources may be incomplete', async () => {
    const base = latest()
    getLatest.mockResolvedValue(latest({
      brief: { ...base.brief, operations: { ...base.brief.operations, failedSources: ['SAM.gov'] } },
    }))
    wrap()
    expect(await screen.findByTestId('failed-sources')).toHaveTextContent(/may be incomplete/i)
  })

  it('reports an empty source list honestly', async () => {
    getLatest.mockResolvedValue(latest({
      sourceHealth: [], sourceTotals: { total: 0, healthy: 0, failing: 0, stale: 0, notConfigured: 0 },
    }))
    wrap()
    expect(await screen.findByText(/No opportunity sources are configured/i)).toBeInTheDocument()
  })
})

// -------------------------------------------------------------
// Brief content
// -------------------------------------------------------------

describe('brief', () => {
  it('lists high-priority matches with their evidence', async () => {
    wrap()
    const section = await screen.findByTestId('high-matches')
    expect(within(section).getByText('Cyber support services')).toBeInTheDocument()
    expect(within(section).getByText('CRITICAL')).toBeInTheDocument()
    expect(within(section).getByText(/3 of 4 capabilities align/)).toBeInTheDocument()
    expect(within(section).getByText(/3 working day\(s\) away/)).toBeInTheDocument()
  })

  it('shows certification warnings on a high match', async () => {
    const base = latest()
    getLatest.mockResolvedValue(latest({
      brief: {
        ...base.brief,
        highMatchOpportunities: [{
          ...base.brief.highMatchOpportunities[0],
          certificationWarnings: ['A certification this Solicitation relies on expires before the response deadline.'],
        }],
      },
    }))
    wrap()
    const section = await screen.findByTestId('high-matches')
    expect(within(section).getByText(/expires before the response deadline/)).toBeInTheDocument()
  })

  it('renders the pre-solicitation wording verbatim without overstating it', async () => {
    wrap()
    const section = await screen.findByTestId('presolicitation')
    expect(within(section).getByText(/does not guarantee influence, consideration, or award/)).toBeInTheDocument()
    expect(within(section).queryByText(/will win/i)).toBeNull()
  })

  it('marks a re-compete signal as needing human acceptance', async () => {
    wrap()
    const section = await screen.findByTestId('recompetes')
    expect(within(section).getByText('UNVERIFIED')).toBeInTheDocument()
    expect(within(section).getByText(/A human must accept it/)).toBeInTheDocument()
  })

  it('never presents a forecast as a released solicitation', async () => {
    wrap()
    const section = await screen.findByTestId('forecasts')
    expect(within(section).getByText(/not a released solicitation/)).toBeInTheDocument()
    expect(within(section).getByText(/needs human confirmation/)).toBeInTheDocument()
  })

  it('discloses a learned adjustment on an individual match', async () => {
    const base = latest()
    getLatest.mockResolvedValue(latest({
      brief: {
        ...base.brief,
        highMatchOpportunities: [{ ...base.brief.highMatchOpportunities[0], weightProfile: 'PURSUIT_ADJUSTED', baseMatchScore: 84 }],
      },
    }))
    wrap()
    expect(await screen.findByTestId('adjusted-o1')).toHaveTextContent(/Base score: 84/)
  })

  it('shows open escalations', async () => {
    getLatest.mockResolvedValue(latest({
      escalations: [{
        id: 'e1', severity: 'HIGH', status: 'OPEN', title: 'Opportunity source failing: SAM.gov',
        reason: '6 consecutive failures', recommendedAction: 'Check credentials',
        entityType: 'OpportunitySourceConfig', entityId: 's1', createdAt: '2026-06-01T08:00:00Z',
      }],
    }))
    wrap()
    const section = await screen.findByTestId('agent-escalations')
    expect(within(section).getByText(/Opportunity source failing/)).toBeInTheDocument()
  })
})

// -------------------------------------------------------------
// Pursuit learning — the human approval surface
// -------------------------------------------------------------

describe('pursuit learning', () => {
  it('shows INSUFFICIENT DATA and offers no Apply control', async () => {
    getLatest.mockResolvedValue(latest({
      learning: {
        effectiveWeightProfile: 'BASE',
        effectiveWeights: { capability: 0.28 },
        appliedSignal: null,
        proposedSignal: null,
        insufficientSignal: signal({
          status: 'INSUFFICIENT_DATA', sampleSize: 6, pursuedSampleSize: 3, ignoredSampleSize: 3,
          confidenceState: 'INSUFFICIENT_DATA',
          summary: 'Only 6 labelled pursue/ignore decision(s) are recorded.',
        }),
      },
    }))
    wrap()
    const card = await screen.findByTestId('pursuit-learning')
    expect(within(card).getByText('INSUFFICIENT DATA')).toBeInTheDocument()
    expect(within(card).getByTestId('sample-size')).toHaveTextContent('6 / 20 needed')
    expect(screen.queryByTestId('apply-feedback')).toBeNull()
    expect(screen.queryByTestId('revert-feedback')).toBeNull()
  })

  it('shows the proposed weighting with a dimension-by-dimension delta', async () => {
    wrap()
    const card = await screen.findByTestId('pursuit-learning')
    expect(within(card).getByText('PROPOSED')).toBeInTheDocument()
    expect(within(card).getByTestId('sample-size')).toHaveTextContent('24 / 20 needed')

    const table = within(card).getByTestId('dimension-deltas')
    expect(within(table).getByText('capability')).toBeInTheDocument()
    expect(within(table).getByText('0.28')).toBeInTheDocument()
    expect(within(table).getByText('0.31')).toBeInTheDocument()
  })

  it('states that production matching is unchanged until applied', async () => {
    wrap()
    const card = await screen.findByTestId('pursuit-learning')
    expect(within(card).getByText(/unchanged until an administrator applies it/)).toBeInTheDocument()
    expect(within(card).getByText('BASE RANKING')).toBeInTheDocument()
  })

  it('lets an ADMIN apply after explicit confirmation', async () => {
    applyFeedback.mockResolvedValue({ signal: signal({ status: 'APPLIED' }), matchesRefreshed: 12 })
    wrap()
    const button = await screen.findByTestId('apply-feedback')
    fireEvent.click(button)

    await waitFor(() => expect(applyFeedback).toHaveBeenCalledWith('sig1'))
    expect(window.confirm).toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('12 match(es) refreshed'), 'success')
  })

  it('does not apply when the confirmation is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrap()
    fireEvent.click(await screen.findByTestId('apply-feedback'))
    await waitFor(() => expect(applyFeedback).not.toHaveBeenCalled())
  })

  it('disables the Apply control for a CONSULTANT', async () => {
    mockRole = 'CONSULTANT'
    wrap()
    const button = await screen.findByTestId('apply-feedback')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('Only an administrator'))
  })

  it('shows who applied an active adjustment and offers Revert', async () => {
    getLatest.mockResolvedValue(latest({
      learning: {
        effectiveWeightProfile: 'PURSUIT_ADJUSTED',
        effectiveWeights: { capability: 0.31 },
        appliedSignal: signal({ status: 'APPLIED', appliedByUserId: 'u1', appliedAt: '2026-06-01T09:00:00Z' }),
        proposedSignal: null,
        insufficientSignal: null,
      },
    }))
    wrap()
    const card = await screen.findByTestId('pursuit-learning')
    expect(within(card).getByText('ADJUSTED RANKING')).toBeInTheDocument()
    expect(within(card).getByTestId('applied-by')).toHaveTextContent('u1')
    expect(within(card).getByTestId('revert-feedback')).toBeInTheDocument()
    expect(screen.queryByTestId('apply-feedback')).toBeNull()
  })

  it('lets an ADMIN revert after explicit confirmation', async () => {
    getLatest.mockResolvedValue(latest({
      learning: {
        effectiveWeightProfile: 'PURSUIT_ADJUSTED',
        effectiveWeights: { capability: 0.31 },
        appliedSignal: signal({ status: 'APPLIED', appliedByUserId: 'u1', appliedAt: '2026-06-01T09:00:00Z' }),
        proposedSignal: null,
        insufficientSignal: null,
      },
    }))
    revertFeedback.mockResolvedValue({ signal: signal({ status: 'REVERTED' }), restoredWeights: {}, matchesRefreshed: 9 })
    wrap()
    fireEvent.click(await screen.findByTestId('revert-feedback'))

    await waitFor(() => expect(revertFeedback).toHaveBeenCalledWith('sig1'))
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('reverted'), 'success')
  })

  it('surfaces a backend refusal rather than pretending the action worked', async () => {
    applyFeedback.mockRejectedValue({ response: { data: { error: 'Another learned adjustment is already applied.' } } })
    wrap()
    fireEvent.click(await screen.findByTestId('apply-feedback'))
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Another learned adjustment is already applied.', 'error'),
    )
  })

  it('renders the backend policy notes rather than hard-coding its own', async () => {
    wrap()
    const card = await screen.findByTestId('pursuit-learning')
    expect(within(card).getByText(/nothing changes until an ADMIN applies them/)).toBeInTheDocument()
  })
})
