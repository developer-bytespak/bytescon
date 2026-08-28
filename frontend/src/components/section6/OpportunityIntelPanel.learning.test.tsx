// =============================================================
// §7.2 — Learned-adjustment disclosure on the existing match panel.
//
// The §7.2 rule this pins: when an ADMIN has applied a pursuit-preference
// weighting, the match panel says so and shows the unadjusted score alongside.
// A base match must show no such notice, so the disclosure can never be
// mistaken for boilerplate.
//
// The panel itself is Section 6's and is otherwise untouched.
// =============================================================
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMatch = vi.fn()
vi.mock('../../services/section6Api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    discoveryApi: { getMatch: (...a: unknown[]) => getMatch(...a), refreshMatch: vi.fn() },
    milestonesApi: { getSchedule: vi.fn().mockResolvedValue(null) },
    requirementsApi: { list: vi.fn().mockResolvedValue([]) },
    scoringApi: { getScore: vi.fn().mockResolvedValue(null) },
  }
})

import { OpportunityIntelPanel } from './OpportunityIntelPanel'

const dimension = (key: string) => ({
  key, score: 0.8, weight: 0.28, baseWeight: 0.28, evidence: `${key} evidence`,
})

const match = (over: Record<string, unknown> = {}) => ({
  id: 'm1', opportunityId: 'o1', overallScore: 82,
  capabilityScore: 80, naicsScore: 80, pscScore: null, certificationScore: 80,
  pastPerformanceScore: null, geographyScore: null, vehicleScore: null, keywordScore: 40,
  matchedCapabilityIds: ['c1'], missingCapabilities: [], capacityWarning: null,
  evidence: { dimensions: [dimension('capability'), dimension('naics')], weightProfile: 'BASE' },
  dataLimitations: [], hasSufficientData: true,
  eligibility: 'ELIGIBLE', eligibilityReason: 'Certification active.',
  eligibilityEvidence: { evidence: [], requiredCertKeys: [], partnerCoverage: [], disclaimer: 'Not legal advice.' },
  expiringCertificationIds: [], matchMethod: 'capability-match-v1', methodVersion: 'v1',
  calculatedAt: '2026-06-01T08:00:00Z',
  ...over,
})

const wrap = () => render(<MemoryRouter><OpportunityIntelPanel opportunityId="o1" /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('learned adjustment disclosure', () => {
  it('shows no disclosure on a base match', async () => {
    getMatch.mockResolvedValue(match())
    wrap()
    await waitFor(() => expect(screen.getByText('82%')).toBeInTheDocument())
    expect(screen.queryByTestId('learned-adjustment-disclosure')).toBeNull()
  })

  it('names the applied adjustment and shows the unadjusted score', async () => {
    getMatch.mockResolvedValue(match({
      overallScore: 88,
      evidence: {
        dimensions: [
          { key: 'capability', score: 0.8, weight: 0.31, baseWeight: 0.28, evidence: 'capability evidence' },
        ],
        weightProfile: 'PURSUIT_ADJUSTED',
        appliedPursuitSignalId: 'sig1',
        baseOverallScore: 82,
      },
    }))
    wrap()
    const notice = await screen.findByTestId('learned-adjustment-disclosure')
    expect(notice).toHaveTextContent(/an administrator applied/i)
    expect(notice).toHaveTextContent('82%')
  })

  it('states plainly that preference is not eligibility, capability or win probability', async () => {
    getMatch.mockResolvedValue(match({
      evidence: { dimensions: [dimension('capability')], weightProfile: 'PURSUIT_ADJUSTED', baseOverallScore: 80 },
    }))
    wrap()
    const notice = await screen.findByTestId('learned-adjustment-disclosure')
    expect(notice).toHaveTextContent(/not capability, not win probability, and not/i)
    expect(notice).toHaveTextContent(/eligibility, which is calculated independently/i)
  })

  it('still renders the per-dimension evidence under an applied weighting', async () => {
    getMatch.mockResolvedValue(match({
      evidence: {
        dimensions: [{ key: 'capability', score: 0.8, weight: 0.31, baseWeight: 0.28, evidence: 'capability evidence' }],
        weightProfile: 'PURSUIT_ADJUSTED',
        baseOverallScore: 80,
      },
    }))
    wrap()
    await waitFor(() => expect(screen.getByText('capability evidence')).toBeInTheDocument())
  })
})
