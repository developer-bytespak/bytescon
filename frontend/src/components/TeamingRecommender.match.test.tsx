// =============================================================
// §5.1 Stage 4 — TeamingRecommender shows the richer match explanation:
// matching capabilities, missing requirements, certification fit, geography
// fit, why recommended, data limitations, and insufficient-data.
// =============================================================
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const search = vi.fn()
const recommend = vi.fn()
vi.mock('../services/api', () => ({
  teamingApi: { recommend: () => recommend() },
  opportunitiesApi: { search: () => search() },
}))

import { TeamingRecommender } from './TeamingRecommender'

function renderIt() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><TeamingRecommender /></QueryClientProvider>)
}

beforeEach(() => {
  search.mockReset(); recommend.mockReset()
  search.mockResolvedValue({ data: { opportunities: [{ id: 'o1', title: 'Radar Opp', agency: 'DoD', naicsCode: '541512', setAsideType: 'SDVOSB' }] } })
  recommend.mockResolvedValue({ data: { opportunity: { id: 'o1' }, recommendations: [
    { partnerId: 'p1', name: 'Match Strong', uei: 'U1', cmmcLevel: 2, score: 85, factors: [{ factor: 'NAICS', points: 40, detail: 'exact NAICS 541512' }], matchedCapabilities: ['cybersecurity'], matchingCapabilities: ['cybersecurity'], missingRequirements: [], certificationFit: { required: 'SDVOSB', met: true, detail: 'partner carries SDVOSB' }, geographyFit: { level: 'FULL', detail: 'CA overlaps San Diego' }, whyRecommended: 'Recommended based on exact NAICS match. Historical fit signal only — not a guarantee the partner qualifies.', dataLimitations: ['Capability matching is keyword-based.'], insufficientData: false },
    { partnerId: 'p2', name: 'Match Empty', uei: null, cmmcLevel: null, score: 0, factors: [], matchedCapabilities: [], matchingCapabilities: [], missingRequirements: ['NAICS 541512 not in partner\'s primary codes'], certificationFit: { required: 'SDVOSB', met: false, detail: 'partner does not carry SDVOSB' }, geographyFit: { level: 'UNKNOWN', detail: 'not recorded' }, whyRecommended: '', dataLimitations: [], insufficientData: true },
  ] } })
})

async function openRecs() {
  renderIt()
  fireEvent.change(screen.getByPlaceholderText(/search an opportunity/i), { target: { value: 'radar' } })
  fireEvent.click(screen.getByRole('button', { name: /search/i }))
  fireEvent.click(await screen.findByText('Radar Opp'))
}

describe('TeamingRecommender match explanation', () => {
  it('shows matching capabilities, cert fit, geography fit and why for a strong match', async () => {
    await openRecs()
    expect(await screen.findByText('Match Strong')).toBeInTheDocument()
    expect(screen.getByText(/not a guarantee the partner qualifies/i)).toBeInTheDocument()
    expect(screen.getByText(/partner carries SDVOSB/i)).toBeInTheDocument()
    expect(screen.getByText(/FULL — CA overlaps San Diego/i)).toBeInTheDocument()
    expect(screen.getByText(/keyword-based/i)).toBeInTheDocument()
  })
  it('flags insufficient data and missing requirements for an empty partner', async () => {
    await openRecs()
    expect(await screen.findByText('Match Empty')).toBeInTheDocument()
    expect(screen.getByText(/insufficient partner data/i)).toBeInTheDocument()
    expect(screen.getByText(/not in partner's primary codes/i)).toBeInTheDocument()
  })
})
