// =============================================================
// §7.3 — Compliance Agent surfaces.
//
// Pins the honesty rules: an unrun agent is never rendered as compliant, SAM
// freshness is stated verbatim rather than implying a live lookup, bonding with
// missing inputs shows INSUFFICIENT DATA rather than a manufactured figure,
// bonding writes are ADMIN-only, a legal-review count is never presented as
// resolved, and an amendment conflict says the verified value was preserved.
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
const getOpportunity = vi.fn()
const listBonding = vi.fn()
const createBonding = vi.fn()
const archiveBonding = vi.fn()
vi.mock('../../services/complianceAgentApi', () => ({
  complianceAgentApi: {
    getLatest: () => getLatest(),
    getOpportunity: (...a: unknown[]) => getOpportunity(...a),
    listBonding: () => listBonding(),
    createBonding: (...a: unknown[]) => createBonding(...a),
    updateBonding: vi.fn(),
    archiveBonding: (...a: unknown[]) => archiveBonding(...a),
  },
}))

import {
  ComplianceRegistrationPanel,
  ComplianceLibraryPanel,
  BondingCapacityManager,
  OpportunityCompliancePanel,
} from './ComplianceAgentPanels'

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

const POLICY = {
  samExpiryEscalationDays: 30,
  amendmentDeadlineWorkingDays: 5,
  mandatoryGapBlockerWorkingDays: 10,
  minMappingSimilarity: 0.28,
  clearMappingSimilarity: 0.5,
  notes: ['A completed extraction never makes a firm COMPLIANT.'],
}

const bonding = (over = {}) => ({
  recordId: 'b1', suretyName: 'Acme Surety',
  singleProjectLimit: '2000000.00', aggregateLimit: '8000000.00', committedAmount: '1500000.25',
  availableCapacity: '6499999.75', effectiveDate: null, expiryDate: '2027-01-01T00:00:00Z',
  daysUntilExpiry: 200, status: 'ACTIVE', state: 'SUFFICIENT', reasons: [], ...over,
})

const opportunityRow = (over = {}) => ({
  opportunityId: 'o1', pursuitId: 'p1', title: 'S7-COMP-QA solicitation', agency: 'DoD',
  responseDeadline: '2027-03-01T00:00:00Z', workingDaysToDeadline: 40, pipelineStage: 'PROPOSAL',
  matrix: { totalRequirements: 12, mandatoryRequirements: 5, verifiedRequirements: 2, unverifiedRequirements: 10, incompleteRequirements: 7, coveragePercent: 42 },
  lmCoverage: { instructions: 3, evaluationCriteria: 2, clearlyMapped: 1, reviewRequired: 2, unmapped: 1, gaps: [] },
  clauses: { total: 2, reviewRequired: 2, verified: 0, unresolvedFlowDowns: 2 },
  extraction: {
    latestJobId: 'j1', status: 'PARTIAL', progressPercent: 100, attempt: 1, maxAttempts: 3,
    parseWarnings: [], aiEnhanced: false,
    note: 'Deterministic parse only. AI-enhanced extraction has not run for this opportunity.',
  },
  amendment: null,
  submission: { submissionId: null, automatedPasses: 0, failures: 0, manualRequired: 0, unsupported: 0, blockers: [] },
  certificationWarnings: [],
  overallStatus: 'HUMAN_REVIEW_REQUIRED',
  statusReasons: ['2 clause(s) carry a possible subcontract flow-down. Potential flow-down identified — legal review required before relying on this classification.'],
  ...over,
})

const latest = (over: Record<string, unknown> = {}) => ({
  agentKey: 'COMPLIANCE',
  schedule: {
    isEnabled: true, cronExpression: '0 */6 * * *', nextRunAt: '2026-06-01T12:00:00Z',
    lastRunAt: '2026-06-01T06:00:00Z', lastSuccessfulRunAt: '2026-06-01T06:00:05Z',
    lastFailureAt: null, lastFailureMessage: null, autonomyLevel: 'PROPOSE',
  },
  lastRun: {
    id: 'run1abcdef', status: 'COMPLETED', triggerType: 'SCHEDULE', progressPercent: 100,
    progressStage: 'COMPLETE', createdAt: '2026-06-01T06:00:00Z', finishedAt: '2026-06-01T06:00:05Z',
    outputSummary: 'HUMAN REVIEW REQUIRED · 1 opportunit(ies) assessed', confidenceState: 'HIGH',
    dataSufficiency: 'PARTIAL', warnings: [], limitations: [], errorMessage: null,
    tokenInput: 0, tokenOutput: 0, estimatedCostUsd: '0.000000',
  },
  lastSuccessfulRun: { id: 'run1abcdef', finishedAt: '2026-06-01T06:00:05Z', outputSummary: 'ok' },
  status: {
    artifactId: 'a1', runId: 'run1abcdef', generatedAt: '2026-06-01T06:00:00Z', summary: 'HUMAN REVIEW REQUIRED',
    registration: {
      samStatus: 'ACTIVE', samExpiry: '2026-06-20T00:00:00Z', samDaysUntilExpiry: 19,
      samExpiryStatus: 'EXPIRING_SOON',
      samDataFreshness: 'Based on the stored registration profile, last updated 2026-05-01. No live SAM.gov lookup was performed.',
      certifications: [], insurance: [], bondingCapacity: bonding(),
    },
    documents: {
      reusable: 3, expiring: 1, expired: 2, missing: 0,
      items: [{ id: 'd1', name: 'Capability statement', category: 'CAPABILITY_STATEMENT', expiryState: 'EXPIRED', expiryMessage: 'Expired 10 days ago', approvedForReuse: true }],
    },
    opportunities: [opportunityRow()],
    totals: { opportunitiesAssessed: 1, blocked: 0, humanReviewRequired: 1, attentionRequired: 0, compliant: 0, insufficientData: 0 },
    overallStatus: 'HUMAN_REVIEW_REQUIRED',
    statusReasons: ['2 clause(s) carry a possible subcontract flow-down.'],
    llm: { aiExtractionAvailable: false, budgetExhausted: false, note: 'No AI-assisted extraction contributed to this status.' },
    warnings: [], dataLimitations: [],
  },
  registration: {
    sam: {
      status: 'ACTIVE', expiryDate: '2026-06-20T00:00:00Z', daysUntilExpiry: 19,
      expiryStatus: 'EXPIRING_SOON', withinEscalationWindow: true, missing: false,
      dataFreshness: 'Based on the stored registration profile, last updated 2026-05-01. No live SAM.gov lookup was performed.',
    },
    certifications: [{ id: 'c1', name: 'SDVOSB', expiryDate: '2026-07-01T00:00:00Z', expiryStatus: 'EXPIRING_SOON', daysUntilExpiry: 30 }],
    insurance: [{ id: 'i1', policyType: 'GENERAL_LIABILITY', expiryDate: '2026-05-01T00:00:00Z', expiryStatus: 'EXPIRED', daysUntilExpiry: -31 }],
    bonding: bonding(),
    health: { active: 1, expiringSoon: 2, expired: 1, missing: 0, total: 4 },
    blockers: [],
    attention: ['SAM registration expires in 19 day(s).'],
    insufficient: [],
  },
  escalations: [],
  policy: POLICY,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockRole = 'ADMIN'
  getLatest.mockResolvedValue(latest())
  listBonding.mockResolvedValue({ records: [{ id: 'b1', suretyName: 'Acme Surety', singleProjectLimit: '2000000.00', aggregateLimit: '8000000.00', committedAmount: '1500000.25', effectiveDate: null, expiryDate: '2027-01-01T00:00:00Z', status: 'ACTIVE', evidenceReference: null, notes: null, recordedByUserId: 'u1', verifiedByUserId: null, verifiedAt: null, createdAt: '', updatedAt: '', assessment: bonding() }] })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => { vi.restoreAllMocks() })

// -------------------------------------------------------------
// /registration
// -------------------------------------------------------------

describe('registration panel', () => {
  it('shows a loading state first', () => {
    getLatest.mockReturnValue(new Promise(() => {}))
    wrap(<ComplianceRegistrationPanel />)
    expect(screen.getByText(/Loading Compliance Agent status/i)).toBeInTheDocument()
  })

  it('shows an error state with a retry', async () => {
    getLatest.mockRejectedValue({ response: { data: { error: 'boom' } } })
    wrap(<ComplianceRegistrationPanel />)
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('never renders an unrun agent as compliant', async () => {
    getLatest.mockResolvedValue(latest({ status: null, lastRun: null, lastSuccessfulRun: null }))
    wrap(<ComplianceRegistrationPanel />)
    await waitFor(() => expect(screen.getByTestId('compliance-last-run')).toHaveTextContent('Never run'))
    expect(screen.queryByText('COMPLIANT — CURRENT')).toBeNull()
  })

  it('renders the overall status the backend decided', async () => {
    wrap(<ComplianceRegistrationPanel />)
    expect(await screen.findByText('HUMAN REVIEW REQUIRED')).toBeInTheDocument()
  })

  it('states SAM data freshness verbatim rather than implying a live lookup', async () => {
    wrap(<ComplianceRegistrationPanel />)
    const freshness = await screen.findByTestId('sam-freshness')
    expect(freshness).toHaveTextContent(/No live SAM\.gov lookup was performed/i)
  })

  it('shows the SAM escalation window from the backend policy', async () => {
    wrap(<ComplianceRegistrationPanel />)
    const sam = await screen.findByTestId('compliance-sam')
    expect(within(sam).getByText('EXPIRING_SOON')).toBeInTheDocument()
    expect(within(sam).getByText('30 days')).toBeInTheDocument()
  })

  it('never shows an expired certification or policy as valid', async () => {
    wrap(<ComplianceRegistrationPanel />)
    const insurance = await screen.findByTestId('compliance-insurance')
    expect(within(insurance).getByText('EXPIRED')).toBeInTheDocument()
    expect(within(insurance).getByText(/31d overdue/)).toBeInTheDocument()
  })

  it('renders firm-level blockers when the backend reports them', async () => {
    getLatest.mockResolvedValue(latest({
      registration: { ...latest().registration, blockers: ['SAM registration expired on 2026-05-01.'] },
    }))
    wrap(<ComplianceRegistrationPanel />)
    expect(await screen.findByTestId('compliance-blockers')).toHaveTextContent(/SAM registration expired/)
  })

  it('states that the agent never decides', async () => {
    wrap(<ComplianceRegistrationPanel />)
    await waitFor(() => expect(screen.getByText(/It does not verify a requirement/i)).toBeInTheDocument())
  })

  it('refreshes on demand', async () => {
    wrap(<ComplianceRegistrationPanel />)
    await waitFor(() => expect(getLatest).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByLabelText(/Refresh Compliance Agent status/i))
    await waitFor(() => expect(getLatest).toHaveBeenCalledTimes(2))
  })
})

// -------------------------------------------------------------
// Bonding
// -------------------------------------------------------------

describe('bonding capacity', () => {
  it('shows derived headroom exactly as the backend computed it', async () => {
    wrap(<BondingCapacityManager />)
    expect(await screen.findByTestId('bonding-available-b1')).toHaveTextContent('6499999.75')
  })

  it('shows INSUFFICIENT DATA and no headroom when inputs are missing', async () => {
    listBonding.mockResolvedValue({
      records: [{
        id: 'b2', suretyName: null, singleProjectLimit: null, aggregateLimit: '5000000.00',
        committedAmount: null, effectiveDate: null, expiryDate: null, status: 'ACTIVE',
        evidenceReference: null, notes: null, recordedByUserId: null, verifiedByUserId: null,
        verifiedAt: null, createdAt: '', updatedAt: '',
        assessment: bonding({
          recordId: 'b2', state: 'INSUFFICIENT_DATA', availableCapacity: null, committedAmount: null,
          singleProjectLimit: null, reasons: ['No committed amount is recorded, so available bonding headroom cannot be calculated.'],
        }),
      }],
    })
    wrap(<BondingCapacityManager />)
    expect(await screen.findByText('INSUFFICIENT DATA')).toBeInTheDocument()
    expect(screen.getByTestId('bonding-available-b2')).toHaveTextContent('—')
    expect(screen.getByText(/No committed amount is recorded/)).toBeInTheDocument()
  })

  it('reports an empty state honestly', async () => {
    listBonding.mockResolvedValue({ records: [] })
    wrap(<BondingCapacityManager />)
    expect(await screen.findByText(/No surety bonding capacity is recorded/i)).toBeInTheDocument()
    expect(screen.getByText(/cannot be assessed until a capacity letter is recorded/i)).toBeInTheDocument()
  })

  it('disables recording for a CONSULTANT', async () => {
    mockRole = 'CONSULTANT'
    wrap(<BondingCapacityManager />)
    const button = await screen.findByTestId('add-bonding')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', expect.stringContaining('Only an administrator'))
  })

  it('hides the archive control from a CONSULTANT', async () => {
    mockRole = 'CONSULTANT'
    wrap(<BondingCapacityManager />)
    await screen.findByTestId('bonding-list')
    expect(screen.queryByTestId('archive-bonding-b1')).toBeNull()
  })

  it('lets an ADMIN record capacity', async () => {
    createBonding.mockResolvedValue({})
    wrap(<BondingCapacityManager />)
    fireEvent.click(await screen.findByTestId('add-bonding'))
    const form = await screen.findByTestId('bonding-form')
    fireEvent.change(within(form).getByLabelText(/Aggregate limit/i), { target: { value: '9000000' } })
    fireEvent.submit(form)

    await waitFor(() => expect(createBonding).toHaveBeenCalled())
    expect(createBonding.mock.calls[0][0]).toMatchObject({ aggregateLimit: '9000000' })
    expect(toast).toHaveBeenCalledWith('Bonding capacity recorded.', 'success')
  })

  it('archives after explicit confirmation', async () => {
    archiveBonding.mockResolvedValue({})
    wrap(<BondingCapacityManager />)
    fireEvent.click(await screen.findByTestId('archive-bonding-b1'))
    await waitFor(() => expect(archiveBonding).toHaveBeenCalledWith('b1'))
    expect(window.confirm).toHaveBeenCalled()
  })

  it('surfaces a backend refusal instead of pretending it worked', async () => {
    createBonding.mockRejectedValue({ response: { data: { error: 'Must be a number' } } })
    wrap(<BondingCapacityManager />)
    fireEvent.click(await screen.findByTestId('add-bonding'))
    fireEvent.submit(await screen.findByTestId('bonding-form'))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Must be a number', 'error'))
  })
})

// -------------------------------------------------------------
// /document-library
// -------------------------------------------------------------

describe('library panel', () => {
  it('reports an unrun agent honestly', async () => {
    getLatest.mockResolvedValue(latest({ status: null }))
    wrap(<ComplianceLibraryPanel />)
    expect(await screen.findByText(/has not produced a status yet/i)).toBeInTheDocument()
  })

  it('shows document expiry health from the backend', async () => {
    wrap(<ComplianceLibraryPanel />)
    const docs = await screen.findByTestId('library-documents')
    expect(within(docs).getByText('Capability statement')).toBeInTheDocument()
    expect(within(docs).getByText('EXPIRED')).toBeInTheDocument()
    expect(within(docs).getByText(/Expired 10 days ago/)).toBeInTheDocument()
  })

  it('reports no submission blockers honestly rather than showing nothing', async () => {
    wrap(<ComplianceLibraryPanel />)
    const blockers = await screen.findByTestId('library-blockers')
    expect(within(blockers).getByText(/No submission blockers are recorded/i)).toBeInTheDocument()
  })

  it('lists submission blockers when they exist', async () => {
    const base = latest()
    getLatest.mockResolvedValue(latest({
      status: {
        ...base.status,
        opportunities: [opportunityRow({
          submission: { submissionId: 's1', automatedPasses: 1, failures: 1, manualRequired: 0, unsupported: 0, blockers: ['Submission check "Page count" failed: 42 pages.'] },
        })],
      },
    }))
    wrap(<ComplianceLibraryPanel />)
    const blockers = await screen.findByTestId('library-blockers')
    expect(within(blockers).getByText(/Page count/)).toBeInTheDocument()
  })
})

// -------------------------------------------------------------
// Opportunity panel
// -------------------------------------------------------------

describe('opportunity compliance panel', () => {
  const view = (over = {}) => ({
    opportunity: { id: 'o1', title: 'S7-COMP-QA solicitation', agency: 'DoD', responseDeadline: '2027-03-01T00:00:00Z' },
    compliance: opportunityRow(),
    generatedAt: '2026-06-01T06:00:00Z',
    artifactId: 'a1', runId: 'run1abcdef',
    lastRun: latest().lastRun,
    escalations: [],
    policy: POLICY,
    ...over,
  })

  beforeEach(() => { getOpportunity.mockResolvedValue(view()) })

  it('reports an unassessed opportunity honestly', async () => {
    getOpportunity.mockResolvedValue(view({ compliance: null }))
    wrap(<OpportunityCompliancePanel opportunityId="o1" />)
    expect(await screen.findByText(/has not assessed this opportunity yet/i)).toBeInTheDocument()
  })

  it('renders the backend status and its reasons', async () => {
    wrap(<OpportunityCompliancePanel opportunityId="o1" />)
    expect(await screen.findByText('HUMAN REVIEW REQUIRED')).toBeInTheDocument()
    expect(screen.getByTestId('compliance-reasons')).toHaveTextContent(/legal review required/i)
  })

  it('shows matrix and L/M figures without recomputing them', async () => {
    wrap(<OpportunityCompliancePanel opportunityId="o1" />)
    await waitFor(() => expect(screen.getByTestId('verified-count')).toHaveTextContent('2'))
    expect(screen.getByTestId('mapping-review')).toHaveTextContent('2')
    expect(screen.getByTestId('legal-review')).toHaveTextContent('2')
  })

  it('states the extraction basis honestly', async () => {
    wrap(<OpportunityCompliancePanel opportunityId="o1" />)
    expect(await screen.findByTestId('extraction-note')).toHaveTextContent(/AI-enhanced extraction has not run/i)
  })

  it('shows certification warnings as blockers', async () => {
    getOpportunity.mockResolvedValue(view({
      compliance: opportunityRow({
        overallStatus: 'BLOCKED',
        certificationWarnings: ['Certification "SDVOSB" expires on 2027-02-01, before the response deadline.'],
      }),
    }))
    wrap(<OpportunityCompliancePanel opportunityId="o1" />)
    expect(await screen.findByTestId('cert-warning')).toHaveTextContent(/before the response deadline/)
    expect(screen.getByText('BLOCKED')).toBeInTheDocument()
  })

  it('says the verified value was preserved when an amendment conflicts', async () => {
    getOpportunity.mockResolvedValue(view({
      compliance: opportunityRow({
        amendment: {
          latestRevisionId: 'r1', latestRevisionNo: 2, changedRequirements: 3, changedClauses: 1,
          changedLmCriteria: 1, unresolvedImpacts: 4, conflictsWithVerified: 2,
          workingDaysToDeadline: 3, humanReviewRequired: true,
          analysisBasis: 'Deterministic §6.4B comparison only.',
        },
      }),
    }))
    wrap(<OpportunityCompliancePanel opportunityId="o1" />)
    const conflicts = await screen.findByTestId('amendment-conflicts')
    expect(conflicts).toHaveTextContent(/2 human-verified record\(s\) conflict/)
    expect(conflicts).toHaveTextContent(/preserved unchanged/)
  })

  it('shows submission blockers and the manual-check caveat', async () => {
    getOpportunity.mockResolvedValue(view({
      compliance: opportunityRow({
        submission: { submissionId: 's1', automatedPasses: 2, failures: 1, manualRequired: 3, unsupported: 1, blockers: ['Missing SF-33.'] },
      }),
    }))
    wrap(<OpportunityCompliancePanel opportunityId="o1" />)
    expect(await screen.findByTestId('submission-blockers')).toHaveTextContent('Missing SF-33.')
    expect(screen.getByText(/cannot verify them automatically/i)).toBeInTheDocument()
  })

  it('offers no control that would verify or approve anything', async () => {
    wrap(<OpportunityCompliancePanel opportunityId="o1" />)
    await screen.findByTestId('opportunity-compliance-panel')
    expect(screen.queryByRole('button', { name: /verify/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /acknowledge/i })).toBeNull()
  })
})
