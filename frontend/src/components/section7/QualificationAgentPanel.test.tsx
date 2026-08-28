// =============================================================
// §7.4 — Qualification Agent panel.
//
// Pins the one rule the slice rests on: a recommendation is never rendered as a
// decision. The header says a human decision is required, an unrun agent is not
// dressed up as an answer, an observed award share is never called a win rate,
// only an ADMIN can record anything, and once a person has decided, the agent's
// recommendation and the human's decision are shown side by side.
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

const get = vi.fn()
const accept = vi.fn()
const reject = vi.fn()
vi.mock('../../services/qualificationAgentApi', () => ({
  qualificationAgentApi: {
    get: () => get(),
    accept: (...a: unknown[]) => accept(...a),
    reject: (...a: unknown[]) => reject(...a),
  },
}))

import { QualificationAgentPanel } from './QualificationAgentPanel'

const wrap = () => render(<MemoryRouter><QualificationAgentPanel pursuitId="p1" /></MemoryRouter>)

const POLICY = {
  policyVersion: 'qualification-borderline-v1',
  decisionBoundary: 50,
  borderlineLower: 40,
  borderlineUpper: 60,
  maxUsefulIntervalWidth: 40,
  notes: ['A borderline recommendation is never silently converted into a bid or a no-bid.'],
}

const INCUMBENT = {
  available: true, name: 'Acme Federal',
  retentionNumerator: 4, retentionDenominator: 7, retentionRatePct: 57,
  basisLabel: 'Observed award share', sampleSize: 7, limitation: null,
}

const brief = (over: Record<string, unknown> = {}) => ({
  artifactId: 'a1', runId: 'r1', generatedAt: '2026-08-10T00:00:00.000Z',
  summary: 'BORDERLINE_REVIEW · v1',
  recommendation: {
    result: 'BORDERLINE_REVIEW', strength: 'NONE', borderline: true,
    reasonCodes: ['PROBABILITY_NEAR_BOUNDARY'], reasons: ['The probability sits inside the borderline band.'],
    version: 1, recommendationId: 'rec1',
  },
  scorecard: { total: 66, complete: true, recommendation: 'BID', criteria: [], missingRequiredKeys: [], note: 'note' },
  probability: {
    raw: 52, final: 52, mode: 'RAW', calibrationStatus: 'isotonic', calibrationReason: 'NO_CALIBRATION',
    sampleSize: null, intervalLower: null, intervalUpper: null, intervalAvailable: false,
    intervalUnavailableLabel: 'Not enough verified outcomes to state an interval.',
    confidenceState: 'INSUFFICIENT_DATA', calibrationSampleSufficiency: 'NONE', dataSufficiency: 'PARTIAL',
    modelVersion: 'v1',
  },
  capability: { matchScore: 82, severity: 'CRITICAL', gaps: ['certification: SDVOSB'], criticalGaps: ['certification: SDVOSB'] },
  capacity: { state: 'AVAILABLE', conflicts: [], detail: '2 of 5 declared concurrent capacity is committed.' },
  pastPerformance: { relevantRecords: 3, records: [], limitations: [] },
  incumbent: INCUMBENT,
  competitors: [
    { name: 'Beta Corp', awardsObserved: 3, totalObserved: 12, observedAwardSharePct: 25, isConfirmedWinRate: false, basisLabel: 'Observed award share' },
  ],
  competitorLimitation: 'These are observed award shares, not win rates.',
  pricing: { availability: 'PRICING_DATA_NOT_AVAILABLE', validity: null, detail: 'No pricing scenario exists for this opportunity.' },
  compliance: { available: false, overallStatus: null, blockers: 0, humanReviewItems: 0, detail: 'No Compliance Agent status is available.' },
  stageContradiction: { contradicts: false, reason: null },
  proposedPriority: 'HIGH',
  narrative: 'Borderline — human review required.\nWin probability is 52% (RAW) with no confidence interval available.',
  warnings: [],
  dataLimitations: ['No qualification scorecard has been started for this pursuit.'],
  ...over,
})

const recommendation = (over: Record<string, unknown> = {}) => ({
  id: 'rec1', pursuitId: 'p1', opportunityId: 'o1', agentRunId: 'r1',
  version: 1, algorithmVersion: 'qualification-v1',
  recommendation: 'BORDERLINE_REVIEW', strength: 'NONE',
  rawProbability: 52, finalProbability: 52, probabilityMode: 'RAW', calibrationnote: 'NO_CALIBRATION',
  confidenceLower: null, confidenceUpper: null, confidenceState: 'INSUFFICIENT_DATA', dataSufficiency: 'PARTIAL',
  scorecardScore: 66, isBorderline: true, borderlineReasons: ['PROBABILITY_NEAR_BOUNDARY'],
  capabilityGapSeverity: 'CRITICAL', capacityState: 'AVAILABLE',
  incumbentEvidence: INCUMBENT, competitorEvidence: [], pricingEvidence: null, complianceEvidence: null,
  narrative: 'Borderline — human review required.\nWin probability is 52% (RAW) with no confidence interval available.',
  dataLimitations: [], proposedPriority: 'HIGH',
  status: 'ACTIVE', supersedesId: null, supersededAt: null,
  acceptedByUserId: null, acceptedAt: null, rejectedByUserId: null, rejectedAt: null,
  humanDecision: null, createdAt: '2026-08-10T00:00:00.000Z',
  ...over,
})

const view = (over: Record<string, unknown> = {}) => ({
  agentKey: 'QUALIFICATION',
  pursuit: {
    id: 'p1', opportunityId: 'o1', pipelineStage: 'QUALIFICATION', priority: 'MEDIUM', ownerUserId: 'u1',
    opportunity: { id: 'o1', title: 'Cyber support services', agency: 'DoD', responseDeadline: '2026-10-01T00:00:00.000Z' },
  },
  schedule: {
    isEnabled: true, cronExpression: '0 */6 * * *', nextRunAt: '2026-08-10T06:00:00.000Z',
    lastRunAt: '2026-08-10T00:00:00.000Z', lastSuccessfulRunAt: '2026-08-10T00:00:00.000Z',
    lastFailureAt: null, lastFailureMessage: null, autonomyLevel: 'PROPOSE',
  },
  lastRun: {
    id: 'run-abcdef123', status: 'COMPLETED', triggerType: 'SCHEDULED',
    createdAt: '2026-08-10T00:00:00.000Z', finishedAt: '2026-08-10T00:00:05.000Z',
    outputSummary: 'BORDERLINE_REVIEW', warnings: [], limitations: [],
    tokenInput: 0, tokenOutput: 0, estimatedCostUsd: '0',
  },
  recommendation: recommendation(),
  brief: brief(),
  gateReview: {
    id: 'g1', name: 'Qualification gate', status: 'NOT_STARTED', reviewerUserId: 'u1',
    dueDate: null, comments: 'The agent opened this review and does not complete it.',
  },
  humanDecision: null,
  escalations: [],
  policy: POLICY,
  ...over,
})

beforeEach(() => {
  mockRole = 'ADMIN'
  toast.mockReset()
  get.mockReset().mockResolvedValue(view())
  accept.mockReset().mockResolvedValue({ recommendation: recommendation({ status: 'ACCEPTED' }) })
  reject.mockReset().mockResolvedValue({ recommendation: recommendation({ status: 'REJECTED' }) })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => { vi.restoreAllMocks() })

// -------------------------------------------------------------

describe('a recommendation is never presented as a decision', () => {
  it('titles the panel as a recommendation requiring a human decision', async () => {
    wrap()
    expect(await screen.findByText('Agent recommendation — human decision required')).toBeInTheDocument()
  })

  it('says plainly that the agent has not decided and cannot', async () => {
    wrap()
    expect(await screen.findByText(/The agent has not recorded one and cannot/i)).toBeInTheDocument()
  })

  it('never labels the result a final decision', async () => {
    wrap()
    await screen.findByTestId('qual-recommendation')
    expect(screen.queryByText(/Final Bid Decision/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Decision: BID/i)).not.toBeInTheDocument()
  })

  it('states the agent never records a decision or completes a review', async () => {
    wrap()
    expect(await screen.findByText(/recommends; it never decides/i)).toBeInTheDocument()
  })

  it('renders the borderline result as requiring human review', async () => {
    wrap()
    expect(await screen.findByText('BORDERLINE — HUMAN REVIEW REQUIRED')).toBeInTheDocument()
  })
})

describe('an unrun agent is not dressed up as an answer', () => {
  it('says the pursuit has not been qualified when there is no recommendation', async () => {
    get.mockResolvedValue(view({ recommendation: null, brief: null }))
    wrap()
    expect(await screen.findByText(/has not qualified this pursuit yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId('qual-recommendation')).not.toBeInTheDocument()
  })

  it('offers no decision controls when there is no recommendation', async () => {
    get.mockResolvedValue(view({ recommendation: null, brief: null }))
    wrap()
    await screen.findByText(/has not qualified this pursuit yet/i)
    expect(screen.queryByTestId('qual-accept')).not.toBeInTheDocument()
    expect(screen.queryByTestId('qual-reject')).not.toBeInTheDocument()
  })

  it('reports "Never run" rather than implying success', async () => {
    get.mockResolvedValue(view({ lastRun: null, recommendation: null, brief: null }))
    wrap()
    expect(await screen.findByTestId('qual-last-run')).toHaveTextContent('Never run')
  })

  it('surfaces a load failure with a retry', async () => {
    get.mockRejectedValue({ response: { data: { error: 'boom' } } })
    wrap()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })
})

describe('numbers are shown exactly as the backend computed them', () => {
  it('shows the probability with its mode', async () => {
    wrap()
    expect(await screen.findByTestId('qual-probability')).toHaveTextContent('52% (RAW)')
  })

  it('states why no interval exists instead of showing 0–100%', async () => {
    wrap()
    const interval = await screen.findByTestId('qual-interval')
    expect(interval).toHaveTextContent('Not enough verified outcomes to state an interval.')
    expect(interval).not.toHaveTextContent('0–100')
  })

  it('shows an interval when one is available', async () => {
    get.mockResolvedValue(view({
      recommendation: recommendation({ confidenceLower: 44, confidenceUpper: 78, confidenceState: 'MEDIUM' }),
      brief: brief({
        probability: { ...brief().probability, intervalAvailable: true, intervalLower: 44, intervalUpper: 78 },
      }),
    }))
    wrap()
    expect(await screen.findByTestId('qual-interval')).toHaveTextContent('44–78%')
  })

  it('shows the capability gap severity and capacity state verbatim', async () => {
    wrap()
    expect(await screen.findByTestId('qual-gap')).toHaveTextContent('CRITICAL')
    expect(screen.getByTestId('qual-capacity')).toHaveTextContent('AVAILABLE')
  })

  it('renders the backend narrative unmodified', async () => {
    wrap()
    expect(await screen.findByTestId('qual-narrative')).toHaveTextContent('Win probability is 52% (RAW)')
  })

  it('reports zero tokens and zero cost, because the agent uses no LLM', async () => {
    wrap()
    await screen.findByTestId('qual-recommendation')
    expect(screen.getByText(/0 tokens/)).toBeInTheDocument()
    expect(screen.getByText(/No AI inference, no tokens, no cost/i)).toBeInTheDocument()
  })
})

describe('evidence honesty', () => {
  it('never calls an observed award share a win rate', async () => {
    wrap()
    const competitors = await screen.findByTestId('qual-competitors')
    expect(within(competitors).getByText(/observed award share 25%/i)).toBeInTheDocument()
    expect(within(competitors).queryByText(/confirmed win rate/i)).not.toBeInTheDocument()
    // The limitation line exists precisely to say these are NOT win rates.
    expect(within(competitors).getByText(/not win rates/i)).toBeInTheDocument()
  })

  it('uses win-rate wording only for a confirmed denominator', async () => {
    get.mockResolvedValue(view({
      brief: brief({
        competitors: [{ name: 'Beta Corp', awardsObserved: 6, totalObserved: 10, observedAwardSharePct: 60, isConfirmedWinRate: true, basisLabel: 'Confirmed win rate' }],
        competitorLimitation: null,
      }),
    }))
    wrap()
    const competitors = await screen.findByTestId('qual-competitors')
    expect(within(competitors).getByText(/confirmed win rate 60% of 10 bid\(s\)/i)).toBeInTheDocument()
  })

  it('shows the incumbent numerator and denominator, never a bare rate', async () => {
    wrap()
    const incumbent = await screen.findByTestId('qual-incumbent')
    expect(within(incumbent).getByText(/Retained 4 of 7 comparable award\(s\)/i)).toBeInTheDocument()
  })

  it('invents no incumbent when none was identified', async () => {
    get.mockResolvedValue(view({
      brief: brief({
        incumbent: { available: false, name: null, retentionNumerator: null, retentionDenominator: null, retentionRatePct: null, basisLabel: 'Insufficient data', sampleSize: 0, limitation: null },
      }),
    }))
    wrap()
    const incumbent = await screen.findByTestId('qual-incumbent')
    expect(within(incumbent).getByText(/No incumbent could be identified/i)).toBeInTheDocument()
  })

  it('states that pricing is unavailable', async () => {
    wrap()
    const other = await screen.findByTestId('qual-other-evidence')
    expect(within(other).getByText(/No pricing scenario exists for this opportunity/i)).toBeInTheDocument()
  })

  it('discloses the data limitations rather than hiding them', async () => {
    wrap()
    expect(await screen.findByText(/No qualification scorecard has been started/i)).toBeInTheDocument()
  })

  it('shows a stage contradiction when the backend reports one', async () => {
    get.mockResolvedValue(view({
      brief: brief({ stageContradiction: { contradicts: true, reason: 'This pursuit is in PROPOSAL but the agent recommends no-bid.' } }),
    }))
    wrap()
    expect(await screen.findByTestId('qual-contradiction')).toHaveTextContent('recommends no-bid')
  })
})

describe('the proposed priority is a proposal', () => {
  it('says the agent does not change the priority', async () => {
    wrap()
    const note = await screen.findByTestId('qual-proposed-priority')
    expect(note).toHaveTextContent('Proposed priority: HIGH')
    expect(note).toHaveTextContent('does not change')
  })
})

describe('the gate review belongs to a human', () => {
  it('shows the review as NOT_STARTED and says the agent does not complete it', async () => {
    wrap()
    const gate = await screen.findByTestId('qual-gate-review')
    expect(within(gate).getByText('NOT_STARTED')).toBeInTheDocument()
    expect(within(gate).getByText(/does not complete it/i)).toBeInTheDocument()
  })
})

describe('only an administrator records a decision', () => {
  it('offers no controls to a consultant', async () => {
    mockRole = 'CONSULTANT'
    wrap()
    expect(await screen.findByTestId('qual-consultant-note')).toHaveTextContent('Only a firm administrator')
    expect(screen.queryByTestId('qual-accept')).not.toBeInTheDocument()
    expect(screen.queryByTestId('qual-reject')).not.toBeInTheDocument()
  })

  it('offers accept and reject to an admin', async () => {
    wrap()
    expect(await screen.findByTestId('qual-accept')).toBeInTheDocument()
    expect(screen.getByTestId('qual-reject')).toBeInTheDocument()
  })

  it('requires explicit confirmation before accepting', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrap()
    fireEvent.click(await screen.findByTestId('qual-accept'))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(accept).not.toHaveBeenCalled()
  })

  it('tells the admin the decision is recorded as theirs', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrap()
    fireEvent.click(await screen.findByTestId('qual-accept'))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(confirmSpy.mock.calls[0][0]).toContain('recorded as yours')
  })

  it('sends the chosen decision and rationale when accepting', async () => {
    wrap()
    fireEvent.change(await screen.findByTestId('qual-decision-select'), { target: { value: 'NO_BID' } })
    fireEvent.change(screen.getByTestId('qual-rationale'), { target: { value: 'Capacity is committed.' } })
    fireEvent.click(screen.getByTestId('qual-accept'))
    await waitFor(() => expect(accept).toHaveBeenCalledWith('rec1', { decision: 'NO_BID', overrideReason: 'Capacity is committed.' }))
  })

  it('refuses to reject without the human stating their own decision', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('qual-reject'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Choose the decision you are recording instead.', 'error'))
    expect(reject).not.toHaveBeenCalled()
  })

  it('sends the human decision when rejecting', async () => {
    wrap()
    fireEvent.change(await screen.findByTestId('qual-decision-select'), { target: { value: 'NO_BID' } })
    fireEvent.change(screen.getByTestId('qual-rationale'), { target: { value: 'The reviewer disagrees.' } })
    fireEvent.click(screen.getByTestId('qual-reject'))
    await waitFor(() => expect(reject).toHaveBeenCalledWith('rec1', { decision: 'NO_BID', overrideReason: 'The reviewer disagrees.' }))
  })

  it('says the agent recommendation is preserved when rejecting', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrap()
    fireEvent.change(await screen.findByTestId('qual-decision-select'), { target: { value: 'NO_BID' } })
    fireEvent.click(screen.getByTestId('qual-reject'))
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(confirmSpy.mock.calls[0][0]).toContain('preserved as evidence')
  })

  it('surfaces a backend refusal instead of pretending it worked', async () => {
    accept.mockRejectedValue({ response: { data: { error: 'Scorecard not started not found' } } })
    wrap()
    fireEvent.change(await screen.findByTestId('qual-decision-select'), { target: { value: 'BID' } })
    fireEvent.click(screen.getByTestId('qual-accept'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Scorecard not started not found', 'error'))
  })

  it('disables the controls once the recommendation is no longer ACTIVE', async () => {
    get.mockResolvedValue(view({ recommendation: recommendation({ status: 'SUPERSEDED' }) }))
    wrap()
    expect(await screen.findByTestId('qual-accept')).toBeDisabled()
    expect(screen.getByTestId('qual-reject')).toBeDisabled()
  })
})

describe('once a person has decided, both are shown', () => {
  const decided = () => view({
    recommendation: recommendation({ recommendation: 'RECOMMEND_BID', status: 'REJECTED', humanDecision: 'NO_BID' }),
    humanDecision: {
      id: 'sc1', status: 'DECIDED', finalDecision: 'NO_BID', decidedByUserId: 'u1',
      decidedAt: '2026-08-10T01:00:00.000Z', isOverride: true, overrideReason: 'Capacity is committed elsewhere.',
    },
  })

  it('shows the agent recommendation and the human decision side by side', async () => {
    get.mockResolvedValue(decided())
    wrap()
    const block = await screen.findByTestId('qual-decision-recorded')
    expect(within(block).getByText(/Agent recommended:/)).toBeInTheDocument()
    expect(within(block).getByText('RECOMMEND_BID')).toBeInTheDocument()
    expect(within(block).getByText(/Human decided:/)).toBeInTheDocument()
    expect(within(block).getByText('NO_BID')).toBeInTheDocument()
  })

  it('shows the human rationale', async () => {
    get.mockResolvedValue(decided())
    wrap()
    expect(await screen.findByText(/Rationale: Capacity is committed elsewhere\./)).toBeInTheDocument()
  })

  it('replaces the controls once a decision exists', async () => {
    get.mockResolvedValue(decided())
    wrap()
    await screen.findByTestId('qual-decision-recorded')
    expect(screen.queryByTestId('qual-accept')).not.toBeInTheDocument()
    expect(screen.queryByTestId('qual-reject')).not.toBeInTheDocument()
  })
})

describe('escalations', () => {
  it('lists open escalations with their severity', async () => {
    get.mockResolvedValue(view({
      escalations: [{
        id: 'e1', severity: 'HIGH', status: 'OPEN', title: 'Borderline qualification',
        reason: 'No person has recorded any decision.', recommendedAction: 'Review the brief.',
        createdAt: '2026-08-10T00:00:00.000Z',
      }],
    }))
    wrap()
    const list = await screen.findByTestId('qual-escalations')
    expect(within(list).getByText('Borderline qualification')).toBeInTheDocument()
    expect(within(list).getByText('HIGH')).toBeInTheDocument()
  })

  it('renders no escalation panel when there are none', async () => {
    wrap()
    await screen.findByTestId('qual-recommendation')
    expect(screen.queryByTestId('qual-escalations')).not.toBeInTheDocument()
  })
})

describe('the policy is disclosed', () => {
  it('lists the policy notes verbatim', async () => {
    wrap()
    expect(await screen.findByText(/never silently converted into a bid or a no-bid/i)).toBeInTheDocument()
  })
})
