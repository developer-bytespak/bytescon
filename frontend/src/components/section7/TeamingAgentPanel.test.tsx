// =============================================================
// §7.5 — Teaming Agent panel.
//
// Pins the honesty rules the slice depends on: an unrun agent is never rendered
// as a plan, every agreement draft shows the legal banner prominently, every
// outreach draft says a human must send it, there is NO execute/sign/send
// control anywhere, a performance grade is withheld below the minimum sample,
// and "no suitable partner" always describes THIS network.
// =============================================================
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const plan = vi.fn()
vi.mock('../../services/teamingAgentApi', () => ({
  teamingAgentApi: {
    plan: () => plan(),
    goals: vi.fn(),
    performance: vi.fn(),
    createGoal: vi.fn(),
    updateGoal: vi.fn(),
  },
}))

import { TeamingAgentPanel } from './TeamingAgentPanel'

const wrap = () => render(<MemoryRouter><TeamingAgentPanel pursuitId="p1" /></MemoryRouter>)

const POLICY = {
  policyVersion: 'teaming-v1',
  minimumPerformanceSample: 5,
  atRiskWorkingDays: 20,
  legalReviewBanner: 'REQUIRES LEGAL REVIEW — NOT EXECUTABLE',
  noSuitablePartnerMessage: 'No suitable partner was found in the current partner network.',
  notes: [
    'Every agreement and NDA is a draft. The agent never signs, executes, or clears legal review.',
    'Every outreach message is a draft. The agent never sends anything.',
  ],
}

const candidate = (over: Record<string, unknown> = {}) => ({
  partnerId: 'partner-1',
  name: 'Acme Federal',
  overallFit: 78,
  dimensions: [
    { dimension: 'NAICS', points: 20, detail: '541512 matches the solicitation NAICS' },
    { dimension: 'Capability', points: 25, detail: 'incident response, continuous monitoring' },
    { dimension: 'Geography', points: 5, detail: 'VA matches the place of performance' },
  ],
  matchingCapabilities: ['incident response'],
  missingRequirements: [],
  certifications: {
    claimed: ['SDVOSB'],
    requiredForSetAside: 'SDVOSB',
    met: true,
    detail: 'Partner records the required certification.',
    verificationState: 'UNVERIFIED_SELF_DECLARED',
  },
  geography: { level: 'FULL', detail: 'VA matches the place of performance' },
  relevantExperience: { priorTeamedBids: 2, priorWins: 1, detail: '1 win(s) across 2 prior teamed bid(s) with this firm.' },
  performanceSummary: {
    available: true, sampleSize: 12, dataSufficiency: 'SUFFICIENT',
    onTime: '10 of 12 (83%)', acceptance: '11 of 12 (92%)',
    detail: 'Based on 12 attributed deliverable(s) in the measured period.',
  },
  evidence: 'Matches on NAICS and two recorded capabilities.',
  limitations: [],
  eligibilityState: 'POSSIBLY_ELIGIBLE',
  ...over,
})

const planPayload = (over: Record<string, unknown> = {}) => ({
  artifactId: 'a1',
  generatedAt: '2026-08-11T00:00:00.000Z',
  pursuitId: 'p1',
  opportunityId: 'o1',
  opportunityTitle: 'Cyber support services',
  methodVersion: 'teaming-v1',
  capabilityGaps: [
    {
      gapId: 'CERTIFICATION:SDVOSB', requirement: 'SDVOSB', gapClass: 'CERTIFICATION',
      severity: 'CRITICAL', evidence: 'Certification requirement assessment',
      dataSufficiency: 'SUFFICIENT', mitigationStatus: 'PROPOSED_MITIGATION',
    },
  ],
  partnerCandidates: [candidate()],
  noSuitablePartner: false,
  noSuitablePartnerMessage: null,
  proposedWorkshare: {
    status: 'PROPOSED', primePercent: 70, partnerPercent: 30,
    description: 'Starting point for discussion.', rationale: 'Derived from recorded gaps.',
    limitations: ['PROPOSED only. This is not agreed, is not binding, and has not changed any arrangement, pricing or subcontracting goal.'],
  },
  drafts: [
    {
      draftId: 'partner-1:TEAMING_AGREEMENT', documentType: 'TEAMING_AGREEMENT', status: 'DRAFT',
      source: 'DETERMINISTIC_TEMPLATE', legalReviewRequired: true, executionAllowed: false,
      banner: 'REQUIRES LEGAL REVIEW — NOT EXECUTABLE', partnerId: 'partner-1',
    },
  ],
  outreachDrafts: [
    {
      draftId: 'p1:partner-1:OUTREACH', partnerId: 'partner-1', status: 'DRAFT',
      source: 'DETERMINISTIC_TEMPLATE', sendAllowed: false, humanSendRequired: true,
      subject: 'Teaming enquiry — Cyber support services',
    },
  ],
  subcontractingGoals: [
    {
      goalId: 'g1', goalType: 'SDVOSB', targetType: 'PERCENT', target: '20.00',
      achieved: '12.50', remaining: '7.50', riskState: 'WATCH', dataSufficiency: 'PARTIAL',
      dueDate: '2026-10-01T00:00:00.000Z', workingDaysRemaining: 35,
      isHumanVerified: true, source: 'SUBCONTRACTING_PLAN', limitations: [],
    },
  ],
  obligationDeadlines: [{ goalId: 'g1', dueDate: '2026-10-01T00:00:00.000Z', workingDaysRemaining: 35, riskState: 'WATCH' }],
  partnerPerformance: [
    {
      partnerId: 'partner-1', partnerName: 'Acme Federal', sampleSize: 12,
      dataSufficiency: 'SUFFICIENT', onTime: '10 of 12 (83%)', acceptance: '11 of 12 (92%)',
      declineDetected: false, detail: 'Based on 12 attributed deliverable(s) in the measured period.',
    },
  ],
  notifications: [],
  escalations: [],
  warnings: [],
  dataLimitations: ['No pricing scenario exists for this opportunity.'],
  ...over,
})

const view = (over: Record<string, unknown> = {}) => ({
  agentKey: 'TEAMING',
  pursuit: {
    id: 'p1', opportunityId: 'o1', pipelineStage: 'CAPTURE', ownerUserId: 'u1',
    opportunity: { id: 'o1', title: 'Cyber support services', agency: 'DoD', responseDeadline: '2026-10-01T00:00:00.000Z' },
  },
  schedule: {
    isEnabled: true, cronExpression: '0 3 * * *', nextRunAt: '2026-08-12T03:00:00.000Z',
    lastRunAt: '2026-08-11T03:00:00.000Z', lastSuccessfulRunAt: '2026-08-11T03:00:00.000Z',
    lastFailureAt: null, lastFailureMessage: null, autonomyLevel: 'PROPOSE',
  },
  lastRun: {
    id: 'run-abcdef12', status: 'COMPLETED', triggerType: 'SCHEDULED',
    createdAt: '2026-08-11T03:00:00.000Z', finishedAt: '2026-08-11T03:00:05.000Z',
    outputSummary: 'Planned teaming for 1 pursuit', warnings: [], limitations: [],
    tokenInput: 0, tokenOutput: 0, estimatedCostUsd: '0',
  },
  plan: planPayload(),
  escalations: [],
  policy: POLICY,
  ...over,
})

beforeEach(() => {
  plan.mockReset().mockResolvedValue(view())
})

// -------------------------------------------------------------

describe('an unrun agent is never rendered as a plan', () => {
  it('says the pursuit has not been planned when there is no plan', async () => {
    plan.mockResolvedValue(view({ plan: null }))
    wrap()
    expect(await screen.findByText(/has not planned this pursuit yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId('teaming-gaps')).not.toBeInTheDocument()
  })

  it('reports "Never run" rather than implying success', async () => {
    plan.mockResolvedValue(view({ plan: null, lastRun: null }))
    wrap()
    expect(await screen.findByTestId('teaming-last-run')).toHaveTextContent('Never run')
  })

  it('surfaces a load failure with a retry', async () => {
    plan.mockRejectedValue({ response: { data: { error: 'boom' } } })
    wrap()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('names a schedule failure rather than hiding it', async () => {
    plan.mockResolvedValue(view({
      schedule: { ...view().schedule, lastFailureMessage: 'Partner network could not be read.' },
    }))
    wrap()
    expect(await screen.findByTestId('teaming-last-failure')).toHaveTextContent('Partner network could not be read.')
  })
})

describe('the agent proposes and never commits', () => {
  it('says so in the header', async () => {
    wrap()
    expect(await screen.findByText(/never signs, executes, or sends anything/i)).toBeInTheDocument()
  })

  it('says so again in the disclaimer', async () => {
    wrap()
    expect(await screen.findByText(/proposes; it never commits/i)).toBeInTheDocument()
  })

  it('reports zero tokens and zero cost', async () => {
    wrap()
    await screen.findByTestId('teaming-gaps')
    expect(screen.getByText(/0 tokens/)).toBeInTheDocument()
  })

  it('lists the policy notes verbatim', async () => {
    wrap()
    expect(await screen.findByText(/never signs, executes, or clears legal review/i)).toBeInTheDocument()
  })
})

describe('there is no execute, sign, or send control anywhere', () => {
  it('renders no button that could commit anything', async () => {
    wrap()
    await screen.findByTestId('teaming-gaps')
    for (const label of [/execute/i, /auto-sign/i, /^sign$/i, /send for e-signature/i, /^send$/i, /approve/i]) {
      expect(screen.queryByRole('button', { name: label }), String(label)).toBeNull()
    }
  })

  it('renders only the refresh control', async () => {
    wrap()
    await screen.findByTestId('teaming-gaps')
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAttribute('aria-label', 'Refresh Teaming Agent status')
  })

  it('mentions no e-signature anywhere — that is Section 8 scope', async () => {
    const { container } = wrap()
    await screen.findByTestId('teaming-gaps')
    expect(container.textContent?.toLowerCase()).not.toContain('e-signature')
    expect(container.textContent?.toLowerCase()).not.toContain('docusign')
  })
})

describe('agreement and NDA drafts', () => {
  it('shows the exact legal banner prominently', async () => {
    wrap()
    const banner = await screen.findByTestId('teaming-draft-banner')
    expect(banner).toHaveTextContent('REQUIRES LEGAL REVIEW — NOT EXECUTABLE')
  })

  it('never styles a draft as a signed or executed document', async () => {
    wrap()
    const draft = await screen.findByTestId('teaming-draft-partner-1:TEAMING_AGREEMENT')
    expect(within(draft).getByText('DRAFT')).toBeInTheDocument()
    expect(within(draft).queryByText(/SIGNED/)).toBeNull()
    expect(within(draft).queryByText(/EXECUTED/)).toBeNull()
  })

  it('states the two safety flags explicitly', async () => {
    wrap()
    const draft = await screen.findByTestId('teaming-draft-partner-1:TEAMING_AGREEMENT')
    expect(within(draft).getByText(/Legal review required: yes/)).toBeInTheDocument()
    expect(within(draft).getByText(/Execution allowed: no/)).toBeInTheDocument()
  })

  it('labels a template draft as TEMPLATE, not AI-assisted', async () => {
    wrap()
    const draft = await screen.findByTestId('teaming-draft-partner-1:TEAMING_AGREEMENT')
    expect(within(draft).getByText('TEMPLATE')).toBeInTheDocument()
  })

  it('labels an LLM-assisted draft honestly', async () => {
    plan.mockResolvedValue(view({
      plan: planPayload({ drafts: [{ ...planPayload().drafts[0], source: 'LLM_ASSISTED' }] }),
    }))
    wrap()
    const draft = await screen.findByTestId('teaming-draft-partner-1:TEAMING_AGREEMENT')
    expect(within(draft).getByText('AI-ASSISTED')).toBeInTheDocument()
  })

  it('renders no draft panel when none was prepared', async () => {
    plan.mockResolvedValue(view({ plan: planPayload({ drafts: [] }) }))
    wrap()
    await screen.findByTestId('teaming-gaps')
    expect(screen.queryByTestId('teaming-drafts')).not.toBeInTheDocument()
  })
})

describe('outreach drafts', () => {
  it('shows DRAFT — HUMAN SEND REQUIRED', async () => {
    wrap()
    const outreach = await screen.findByTestId('teaming-outreach')
    expect(within(outreach).getByText('DRAFT — HUMAN SEND REQUIRED')).toBeInTheDocument()
  })

  it('says plainly that sending is not automated', async () => {
    wrap()
    expect(await screen.findByTestId('outreach-send-p1:partner-1:OUTREACH'))
      .toHaveTextContent('Sending is not automated')
  })

  it('offers no send control', async () => {
    wrap()
    const outreach = await screen.findByTestId('teaming-outreach')
    expect(within(outreach).queryByRole('button')).toBeNull()
  })
})

describe('capability gaps', () => {
  it('shows severity and gap class', async () => {
    wrap()
    const gaps = await screen.findByTestId('teaming-gaps')
    expect(within(gaps).getByText('CRITICAL')).toBeInTheDocument()
    expect(within(gaps).getByText('CERTIFICATION')).toBeInTheDocument()
  })

  it('says a proposed partner leaves the gap open', async () => {
    wrap()
    expect(await screen.findByTestId('gap-mitigation-CERTIFICATION:SDVOSB'))
      .toHaveTextContent('Partner proposed — gap still open')
  })

  it('distinguishes an arrangement a person approved', async () => {
    plan.mockResolvedValue(view({
      plan: planPayload({
        capabilityGaps: [{ ...planPayload().capabilityGaps[0], mitigationStatus: 'HUMAN_APPROVED_ARRANGEMENT' }],
      }),
    }))
    wrap()
    expect(await screen.findByTestId('gap-mitigation-CERTIFICATION:SDVOSB'))
      .toHaveTextContent('Arrangement approved by a person')
  })

  it('says so honestly when there is no gap', async () => {
    plan.mockResolvedValue(view({ plan: planPayload({ capabilityGaps: [] }) }))
    wrap()
    expect(await screen.findByText(/No open capability gap was found/i)).toBeInTheDocument()
  })
})

describe('partner candidates', () => {
  it('shows every dimension with its evidence, never one opaque score', async () => {
    wrap()
    const dims = await screen.findByTestId('dimensions-partner-1')
    expect(within(dims).getByText('NAICS')).toBeInTheDocument()
    expect(within(dims).getByText('541512 matches the solicitation NAICS')).toBeInTheDocument()
    expect(within(dims).getByText('Capability')).toBeInTheDocument()
    expect(within(dims).getByText('Geography')).toBeInTheDocument()
  })

  it('never calls a self-declared certification verified', async () => {
    wrap()
    expect(await screen.findByTestId('cert-state-partner-1')).toHaveTextContent('UNVERIFIED_SELF_DECLARED')
  })

  it('shows POSSIBLY_ELIGIBLE, never ELIGIBLE', async () => {
    wrap()
    const card = await screen.findByTestId('candidate-partner-1')
    expect(within(card).getByText('POSSIBLY_ELIGIBLE')).toBeInTheDocument()
  })

  it('shows prior experience with this firm', async () => {
    wrap()
    const card = await screen.findByTestId('candidate-partner-1')
    expect(within(card).getByText(/1 win\(s\) across 2 prior teamed bid\(s\)/)).toBeInTheDocument()
  })

  it('shows the geography evidence, not a guess', async () => {
    wrap()
    const card = await screen.findByTestId('candidate-partner-1')
    expect(within(card).getByText(/Geography: FULL — VA matches the place of performance/)).toBeInTheDocument()
  })

  it('withholds a performance grade below the minimum sample', async () => {
    plan.mockResolvedValue(view({
      plan: planPayload({
        partnerCandidates: [candidate({
          performanceSummary: {
            available: true, sampleSize: 3, dataSufficiency: 'INSUFFICIENT_DATA',
            onTime: '3 of 3 (below the minimum sample — no rate stated)',
            acceptance: '3 of 3 (below the minimum sample — no rate stated)',
            detail: 'Below the minimum sample.',
          },
        })],
      }),
    }))
    wrap()
    const perf = await screen.findByTestId('perf-partner-1')
    expect(perf).toHaveTextContent('no grade shown')
    expect(perf).toHaveTextContent('below the minimum sample of 5')
  })

  it('shows the fraction once the sample supports it', async () => {
    wrap()
    expect(await screen.findByTestId('perf-partner-1')).toHaveTextContent('on time 10 of 12 (83%)')
  })
})

describe('no suitable partner', () => {
  it('describes THIS network and never claims none exists', async () => {
    plan.mockResolvedValue(view({
      plan: planPayload({
        noSuitablePartner: true,
        noSuitablePartnerMessage: 'No suitable partner was found in the current partner network.',
      }),
    }))
    wrap()
    const notice = await screen.findByTestId('teaming-no-partner')
    expect(notice).toHaveTextContent('in the current partner network')
    expect(notice).toHaveTextContent('the platform has not searched the market')
    expect(notice.textContent).not.toContain('No suitable partner exists')
  })

  it('renders no such notice when a candidate was found', async () => {
    wrap()
    await screen.findByTestId('teaming-candidates')
    expect(screen.queryByTestId('teaming-no-partner')).not.toBeInTheDocument()
  })
})

describe('proposed workshare', () => {
  it('is labelled PROPOSED and disclosed as not binding', async () => {
    wrap()
    const ws = await screen.findByTestId('teaming-workshare')
    expect(within(ws).getByText('PROPOSED')).toBeInTheDocument()
    expect(within(ws).getByText(/is not agreed, is not binding/)).toBeInTheDocument()
  })

  it('says nothing is proposed when there is nothing to propose', async () => {
    plan.mockResolvedValue(view({
      plan: planPayload({
        proposedWorkshare: { status: 'NOT_AVAILABLE', primePercent: null, partnerPercent: null, description: null, rationale: null, limitations: [] },
      }),
    }))
    wrap()
    expect(await screen.findByText('No workshare is proposed.')).toBeInTheDocument()
  })
})

describe('subcontracting goals', () => {
  it('distinguishes the target from what has been achieved', async () => {
    wrap()
    const goal = await screen.findByTestId('goal-g1')
    expect(within(goal).getByText('Target')).toBeInTheDocument()
    expect(within(goal).getByText('20.00%')).toBeInTheDocument()
    expect(within(goal).getByText('Achieved')).toBeInTheDocument()
    expect(within(goal).getByText('12.50%')).toBeInTheDocument()
    expect(within(goal).getByText('Remaining')).toBeInTheDocument()
    expect(within(goal).getByText('7.50%')).toBeInTheDocument()
  })

  it('shows the risk state, due date and working days', async () => {
    wrap()
    const goal = await screen.findByTestId('goal-g1')
    expect(within(goal).getByText('WATCH')).toBeInTheDocument()
    expect(within(goal).getByText(/35 working day\(s\) remaining/)).toBeInTheDocument()
  })

  it('shows the source and the verification state', async () => {
    wrap()
    const goal = await screen.findByTestId('goal-g1')
    expect(within(goal).getByText('VERIFIED')).toBeInTheDocument()
    expect(within(goal).getByText(/Source SUBCONTRACTING_PLAN/)).toBeInTheDocument()
  })

  it('marks an unverified obligation as such', async () => {
    plan.mockResolvedValue(view({
      plan: planPayload({ subcontractingGoals: [{ ...planPayload().subcontractingGoals[0], isHumanVerified: false }] }),
    }))
    wrap()
    expect(within(await screen.findByTestId('goal-g1')).getByText('UNVERIFIED')).toBeInTheDocument()
  })

  it('shows INSUFFICIENT_DATA rather than implying zero achievement', async () => {
    plan.mockResolvedValue(view({
      plan: planPayload({
        subcontractingGoals: [{
          ...planPayload().subcontractingGoals[0],
          achieved: null, remaining: null, riskState: 'INSUFFICIENT_DATA', dataSufficiency: 'INSUFFICIENT_DATA',
        }],
      }),
    }))
    wrap()
    const goal = await screen.findByTestId('goal-g1')
    expect(within(goal).getAllByText('INSUFFICIENT_DATA').length).toBeGreaterThan(0)
    expect(goal.textContent).not.toMatch(/Achieved\s*0(\.00)?%/)
  })
})

describe('partner performance panel', () => {
  it('shows numerator and denominator for both rates', async () => {
    wrap()
    const perf = await screen.findByTestId('performance-partner-1')
    expect(within(perf).getByText('On time: 10 of 12 (83%)')).toBeInTheDocument()
    expect(within(perf).getByText('Accepted: 11 of 12 (92%)')).toBeInTheDocument()
  })

  it('shows the sample size', async () => {
    wrap()
    expect(await screen.findByTestId('performance-partner-1')).toHaveTextContent('Sample size 12')
  })

  it('flags a detected decline as a measurement', async () => {
    plan.mockResolvedValue(view({
      plan: planPayload({ partnerPerformance: [{ ...planPayload().partnerPerformance[0], declineDetected: true }] }),
    }))
    wrap()
    expect(within(await screen.findByTestId('performance-partner-1')).getByText('DECLINE DETECTED')).toBeInTheDocument()
  })
})

describe('escalations and limitations', () => {
  it('lists open escalations with severity', async () => {
    plan.mockResolvedValue(view({
      escalations: [{
        id: 'e1', severity: 'CRITICAL', status: 'OPEN',
        title: 'Critical capability gap near submission',
        reason: 'A proposed partner does not close the gap.',
        recommendedAction: 'Review the teaming plan.',
        entityType: 'BidPursuit', entityId: 'p1', createdAt: '2026-08-11T00:00:00.000Z',
      }],
    }))
    wrap()
    const list = await screen.findByTestId('teaming-escalations')
    expect(within(list).getByText('Critical capability gap near submission')).toBeInTheDocument()
    expect(within(list).getByText('CRITICAL')).toBeInTheDocument()
  })

  it('discloses data limitations rather than hiding them', async () => {
    wrap()
    await waitFor(() =>
      expect(screen.getByText(/No pricing scenario exists for this opportunity\./)).toBeInTheDocument(),
    )
  })
})
