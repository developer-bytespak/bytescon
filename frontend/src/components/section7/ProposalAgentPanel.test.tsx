// =============================================================
// §7.7 — Proposal Agent panel.
//
// Pins the human-control rules as UI facts: no Approve, Verify, Select,
// Sign-off or Submit control exists anywhere in the panel; an approved section
// reads as LOCKED; a skeleton never reads as covered; an AI compliance finding
// never reads as verified; past performance reads as candidates; and with no
// provider the panel states the limitation rather than showing an empty
// drafting block.
// =============================================================
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const statusFn = vi.fn()
vi.mock('../../services/proposalAgentApi', () => ({
  proposalAgentApi: { status: () => statusFn() },
}))

import { ProposalAgentPanel } from './ProposalAgentPanel'

const wrap = () => render(<MemoryRouter><ProposalAgentPanel proposalId="p1" /></MemoryRouter>)

const POLICY = {
  policyVersion: 'proposal-agent-v1',
  riskWindowWorkingDays: 10,
  maxSectionsDraftedPerRun: 5,
  reviewOverdueWorkingDays: 3,
  cycleStallWorkingDays: 10,
  cycleOrder: ['PINK', 'RED', 'GOLD', 'WHITE'],
  minCapabilityRelevance: 10,
  maxSourcesPerSection: 6,
  notes: [
    'Every draft the agent produces is a DRAFT. It never approves a section, a review or a cycle.',
    'A skeleton section is not coverage — a heading existing is not a requirement being answered.',
  ],
}

const section = (over: Record<string, unknown> = {}) => ({
  sectionId: 'sec-1',
  title: 'Technical Approach',
  sectionNumber: 'L.1',
  ownerUserId: 'owner-1',
  reviewerUserId: 'reviewer-1',
  currentVersionId: 'v1',
  currentVersionStatus: 'DRAFTING',
  draftState: 'HUMAN_DRAFT',
  sourceMaterialState: 'SUFFICIENT',
  coverageState: 'COVERED',
  requirementIds: ['req-1'],
  mandatoryRequirementIds: ['req-1'],
  reviewState: 'IN_REVIEW',
  overdue: false,
  isLocked: false,
  ...over,
})

const status = (over: Record<string, unknown> = {}) => ({
  artifactId: 'art-1',
  generatedAt: '2026-08-12T00:00:00.000Z',
  opportunityId: 'opp-1',
  proposalId: 'p1',
  methodVersion: 'proposal-agent-v1',
  outline: {
    totalItems: 2,
    mandatoryRequirements: 2,
    mappedMandatoryRequirements: 2,
    unmappedMandatoryRequirements: [],
    coverageState: 'COMPLETE',
    ambiguities: [],
  },
  sections: [section()],
  drafting: {
    providerAvailable: true,
    sectionsReadyForDraft: 1,
    sectionsDrafted: 1,
    sectionsNeedingSourceMaterial: 0,
    limitations: [],
  },
  capabilityLibrary: {
    narratives: 2, approvedVersions: 2, draftVersions: 1,
    narrativesWithoutApproval: 0, available: true,
    detail: '2 approved version(s) across 2 narrative(s) are available for drafting.',
  },
  pastPerformance: {
    proposedSelections: [
      { recordId: 'pp-1', title: 'DHS SOC support', relevanceScore: 72, confidence: 'HIGH', explanation: 'Same NAICS and agency.' },
    ],
    approvedSelections: [],
    adaptedDrafts: 0,
    unsupportedClaims: [],
  },
  compliance: {
    deterministicBlockers: [],
    aiFindings: [],
    uncoveredMandatoryRequirements: [],
    legalReviewItems: [],
    manualRequiredChecks: [],
    aiAdvisoryNote: 'AI compliance findings are advisory. They never mark a requirement human-verified.',
  },
  reviewCycles: [],
  sectionReviews: [],
  adherence: { score: null, state: 'INSUFFICIENT_DATA', limitations: [] },
  submissionReadiness: { state: 'NOT_READY', blockers: [], manualRequired: [] },
  recommendedHumanActions: [],
  warnings: [],
  dataLimitations: [],
  inputHash: 'abc123',
  ...over,
})

const view = (over: Record<string, unknown> = {}) => ({
  agentKey: 'PROPOSAL',
  proposal: {
    id: 'p1', opportunityId: 'opp-1', title: 'Cyber support proposal', status: 'DRAFT',
    opportunity: { id: 'opp-1', title: 'Cyber support', agency: 'DoD', responseDeadline: '2026-10-01T00:00:00.000Z' },
  },
  schedule: {
    isEnabled: true, cronExpression: '0 */6 * * *', nextRunAt: '2026-08-12T06:00:00.000Z',
    lastRunAt: '2026-08-12T00:00:00.000Z', lastSuccessfulRunAt: '2026-08-12T00:00:00.000Z',
    lastFailureAt: null, lastFailureMessage: null, autonomyLevel: 'PROPOSE',
  },
  lastRun: {
    id: 'run-12345678', status: 'SUCCEEDED', triggerType: 'MANUAL',
    createdAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:00:05.000Z',
    outputSummary: '1 proposal assessed', warnings: [], limitations: [],
    tokenInput: 0, tokenOutput: 0, estimatedCostUsd: '0.00',
  },
  status: status(),
  escalations: [],
  policy: POLICY,
  ...over,
})

beforeEach(() => { statusFn.mockReset() })

// =============================================================
// Loading, error and not-yet-assessed
// =============================================================

describe('ProposalAgentPanel shell', () => {
  it('shows a loading state first', () => {
    statusFn.mockReturnValue(new Promise(() => {}))
    wrap()
    expect(screen.getByText(/Loading Proposal Agent status/i)).toBeInTheDocument()
  })

  it('shows the backend error message on failure', async () => {
    statusFn.mockRejectedValue({ response: { data: { error: 'Proposal not found' } } })
    wrap()
    expect(await screen.findByText('Proposal not found')).toBeInTheDocument()
  })

  it('says plainly when the agent has not assessed the proposal', async () => {
    statusFn.mockResolvedValue(view({ status: null }))
    wrap()
    expect(await screen.findByText(/has not assessed this proposal yet/i)).toBeInTheDocument()
  })

  it('renders the run summary', async () => {
    statusFn.mockResolvedValue(view())
    wrap()
    await waitFor(() => expect(screen.getByTestId('proposal-last-run')).toHaveTextContent('SUCCEEDED'))
  })
})

// =============================================================
// §4 — the controls that must not exist
// =============================================================

describe('human control', () => {
  it('offers no approve, verify, select, sign-off or submit control', async () => {
    statusFn.mockResolvedValue(view())
    wrap()
    await screen.findByTestId('proposal-agent-panel')

    for (const label of [/^approve/i, /verify/i, /select/i, /sign.?off/i, /submit/i, /send/i, /waive/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    // The only button besides refresh would be a control; there is exactly one.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /refresh proposal agent status/i })).toBeInTheDocument()
  })

  it('marks an approved section as locked', async () => {
    statusFn.mockResolvedValue(view({
      status: status({ sections: [section({ draftState: 'APPROVED', isLocked: true, currentVersionStatus: 'APPROVED' })] }),
    }))
    wrap()
    const row = await screen.findByTestId('proposal-section-sec-1')
    expect(row).toHaveTextContent(/locked/i)
    expect(row).toHaveTextContent(/Approved by a person/i)
  })

  it('states that the agent never submits', async () => {
    statusFn.mockResolvedValue(view())
    wrap()
    expect(await screen.findByTestId('proposal-readiness')).toHaveTextContent(/never submits a proposal/i)
  })

  it('states that the agent does not choose a reviewer', async () => {
    statusFn.mockResolvedValue(view({
      status: status({
        sectionReviews: [{
          sectionId: 'sec-1', title: 'Technical Approach', status: 'IN_REVIEW',
          ownerUserId: 'owner-1', reviewerUserId: null, submittedForReviewAt: '2026-08-01T00:00:00.000Z',
          workingDaysInReview: 8, isOverdue: true, reviewerAssignmentRequired: true, dueDate: null,
        }],
      }),
    }))
    wrap()
    expect(await screen.findByTestId('proposal-reviewer-required')).toHaveTextContent(/does not choose a reviewer/i)
  })
})

// =============================================================
// A skeleton is not coverage
// =============================================================

describe('coverage honesty', () => {
  it('labels a skeleton as a skeleton rather than covered', async () => {
    statusFn.mockResolvedValue(view({
      status: status({ sections: [section({ draftState: 'SKELETON_ONLY', coverageState: 'SKELETON_ONLY' })] }),
    }))
    wrap()
    const row = await screen.findByTestId('proposal-section-sec-1')
    expect(row).toHaveTextContent(/Skeleton only/i)
    expect(row).not.toHaveTextContent(/^Covered$/)
  })

  it('lists every unmapped mandatory requirement with its reason', async () => {
    statusFn.mockResolvedValue(view({
      status: status({
        outline: {
          totalItems: 2, mandatoryRequirements: 2, mappedMandatoryRequirements: 0,
          unmappedMandatoryRequirements: [
            { requirementId: 'req-1', section: 'L.1', reason: 'A section still needs to exist.' },
            { requirementId: 'req-2', section: 'L.2', reason: 'A section still needs to exist.' },
          ],
          coverageState: 'GAPS_PRESENT', ambiguities: [],
        },
      }),
    }))
    wrap()
    const unmapped = await screen.findByTestId('proposal-unmapped')
    expect(unmapped).toHaveTextContent('L.1')
    expect(unmapped).toHaveTextContent('L.2')
    expect(screen.getByTestId('proposal-outline')).toHaveTextContent('GAPS_PRESENT')
  })

  it('flags a section with no approved source material', async () => {
    statusFn.mockResolvedValue(view({
      status: status({ sections: [section({ sourceMaterialState: 'SOURCE_MATERIAL_REQUIRED' })] }),
    }))
    wrap()
    expect(await screen.findByTestId('proposal-section-sec-1'))
      .toHaveTextContent(/No approved source material covers this section/i)
  })
})

// =============================================================
// No provider
// =============================================================

describe('no provider configured', () => {
  it('names the limitation instead of showing an empty drafting block', async () => {
    statusFn.mockResolvedValue(view({
      status: status({
        drafting: {
          providerAvailable: false, sectionsReadyForDraft: 2, sectionsDrafted: 2,
          sectionsNeedingSourceMaterial: 0,
          limitations: ['AI drafting unavailable — no provider configured'],
        },
      }),
    }))
    wrap()
    const drafting = await screen.findByTestId('proposal-drafting')
    expect(drafting).toHaveTextContent('DETERMINISTIC ONLY')
    expect(screen.getByTestId('proposal-drafting-limitation'))
      .toHaveTextContent('AI drafting unavailable — no provider configured')
  })
})

// =============================================================
// Advisory findings and candidate selections
// =============================================================

describe('advisory framing', () => {
  it('says an AI compliance finding never marks a requirement verified', async () => {
    statusFn.mockResolvedValue(view())
    wrap()
    expect(await screen.findByTestId('proposal-compliance'))
      .toHaveTextContent(/never mark a requirement human-verified/i)
  })

  it('presents past performance as candidates a person must choose', async () => {
    statusFn.mockResolvedValue(view())
    wrap()
    const pp = await screen.findByTestId('proposal-past-performance')
    expect(pp).toHaveTextContent(/does not select final past performance/i)
    expect(pp).toHaveTextContent('DHS SOC support')
  })

  it('shows deterministic blockers as blockers', async () => {
    statusFn.mockResolvedValue(view({
      status: status({
        compliance: {
          deterministicBlockers: ['2 mandatory requirement(s) have no proposal section.'],
          aiFindings: [], uncoveredMandatoryRequirements: [], legalReviewItems: [],
          manualRequiredChecks: [], aiAdvisoryNote: 'AI compliance findings are advisory.',
        },
      }),
    }))
    wrap()
    expect(await screen.findByTestId('proposal-blockers'))
      .toHaveTextContent('2 mandatory requirement(s) have no proposal section.')
  })

  it('warns when a narrative has no approved version', async () => {
    statusFn.mockResolvedValue(view({
      status: status({
        capabilityLibrary: {
          narratives: 3, approvedVersions: 0, draftVersions: 3, narrativesWithoutApproval: 3,
          available: false,
          detail: '3 narrative(s) exist but none has an approved version. Only approved versions may be quoted as contractor facts.',
        },
      }),
    }))
    wrap()
    const lib = await screen.findByTestId('proposal-library')
    expect(lib).toHaveTextContent(/none has an approved version/i)
    expect(lib).toHaveTextContent(/cannot be\s+quoted/i)
  })
})

// =============================================================
// Escalations and policy
// =============================================================

describe('escalations and policy', () => {
  it('renders open escalations with their recommended action', async () => {
    statusFn.mockResolvedValue(view({
      escalations: [{
        id: 'esc-1', severity: 'HIGH', status: 'OPEN',
        title: 'Mandatory requirement has no section',
        reason: 'L.3 is unmapped 2 working days before the deadline.',
        recommendedAction: 'Create a section for L.3.',
        entityType: 'Proposal', entityId: 'p1', createdAt: '2026-08-12T00:00:00.000Z',
      }],
    }))
    wrap()
    const esc = await screen.findByTestId('proposal-escalations')
    expect(esc).toHaveTextContent('Mandatory requirement has no section')
    expect(esc).toHaveTextContent('Create a section for L.3.')
  })

  it('shows the policy notes so a reader can check the rules', async () => {
    statusFn.mockResolvedValue(view())
    wrap()
    const policy = await screen.findByTestId('proposal-policy')
    expect(policy).toHaveTextContent(/never approves a section, a review or a cycle/i)
    expect(policy).toHaveTextContent(/A skeleton section is not coverage/i)
  })

  it('shows the colour-team order', async () => {
    statusFn.mockResolvedValue(view())
    wrap()
    expect(await screen.findByTestId('proposal-reviews')).toHaveTextContent('PINK → RED → GOLD → WHITE')
  })
})
