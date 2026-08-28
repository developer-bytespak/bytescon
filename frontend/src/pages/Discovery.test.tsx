// =============================================================
// §6.1H — Opportunity Discovery page.
//
// Covers the required UI states (loading, empty, error, permission,
// submitting) and the honesty rules: coverage notes are rendered verbatim,
// a source is never shown as live until it has been verified live, and
// forecasts are always badged as forecasts.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

// §7.2 — the Agent tab renders a panel that needs auth context and its own API.
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'a@b.c', firstName: 'A', lastName: 'B', role: 'ADMIN' } }),
}))
vi.mock('../services/opportunityAgentApi', () => ({
  opportunityAgentApi: {
    getLatest: () => new Promise(() => {}),
    applyFeedback: vi.fn(),
    revertFeedback: vi.fn(),
  },
}))

const listAdapters = vi.fn()
const listSources = vi.fn()
const createSource = vi.fn()
const syncSource = vi.fn()
const listForecasts = vi.fn()
const listRecompetes = vi.fn()
const listNotices = vi.fn()
const listCapabilities = vi.fn()

vi.mock('../services/section6Api', () => ({
  discoveryApi: {
    listAdapters: () => listAdapters(),
    listSources: () => listSources(),
    createSource: (...a: unknown[]) => createSource(...a),
    updateSource: vi.fn(),
    syncSource: (...a: unknown[]) => syncSource(...a),
    listForecasts: (...a: unknown[]) => listForecasts(...a),
    linkForecasts: vi.fn(),
    decideForecastLink: vi.fn(),
    listRecompetes: () => listRecompetes(),
    detectRecompetes: vi.fn(),
    decideRecompete: vi.fn(),
    listNotices: () => listNotices(),
    listCapabilities: () => listCapabilities(),
    createCapability: vi.fn(),
    verifyCapability: vi.fn(),
  },
}))

import Discovery from './Discovery'

const renderPage = () => render(<MemoryRouter><Discovery /></MemoryRouter>)

const adapter = (over = {}) => ({
  key: 'state_local', displayName: 'State / Local Procurement Feed', category: 'STATE_LOCAL',
  produces: 'OPPORTUNITY', supportsIncremental: false, isDelegated: false,
  coverageNote: 'Coverage is limited to the jurisdictions you configure — this is not, and does not claim to be, national state and local coverage.',
  ...over,
})

const source = (over = {}) => ({
  id: 's1', adapterKey: 'grants_gov', displayName: 'Grants.gov', category: 'GRANTS_GOV',
  isEnabled: true, baseUrl: null, authEnvKey: null, configJson: {},
  lastRunAt: null, lastSuccessfulSync: null, lastFailureAt: null, lastFailureMessage: null,
  consecutiveFailures: 0, dataQuality: 'UNVERIFIED', verification: 'NOT_CONFIGURED',
  stalenessHours: 48, coverageNote: 'Federal grant opportunities from the public Grants.gov Search2 API.',
  freshness: { isStale: true, ageHours: null, label: 'Never synced' }, lastRun: null,
  ...over,
})

beforeEach(() => {
  toast.mockReset()
  listAdapters.mockReset(); listSources.mockReset(); createSource.mockReset(); syncSource.mockReset()
  listForecasts.mockReset(); listRecompetes.mockReset(); listNotices.mockReset(); listCapabilities.mockReset()
  listAdapters.mockResolvedValue([adapter()])
  listSources.mockResolvedValue([])
  listForecasts.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25, recordKind: 'FORECAST', disclaimer: 'Forecasts are agency planning estimates.' })
  listRecompetes.mockResolvedValue({ signals: [], disclaimer: 'Estimated windows, not announced dates.' })
  listNotices.mockResolvedValue([])
  listCapabilities.mockResolvedValue([])
})

describe('Discovery — sources tab', () => {
  it('shows a loading state, then the empty state', async () => {
    renderPage()
    expect(screen.getByText(/Loading ingestion sources/i)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/No ingestion sources are configured yet/i)).toBeInTheDocument())
    expect(screen.getByText(/the platform runs without any of them/i)).toBeInTheDocument()
  })

  it('renders the adapter coverage note verbatim', async () => {
    renderPage()
    await waitFor(() =>
      expect(screen.getByText(/does not claim to be, national state and local coverage/i)).toBeInTheDocument(),
    )
  })

  it('shows an error state with a retry action', async () => {
    listSources.mockRejectedValue({ response: { data: { error: 'Database unavailable' } } })
    renderPage()
    await waitFor(() => expect(screen.getByText('Database unavailable')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Try again/i })).toBeInTheDocument()
  })

  it('never labels an unverified source as live', async () => {
    listSources.mockResolvedValue([source()])
    renderPage()
    await waitFor(() => expect(screen.getByText('NOT CONFIGURED')).toBeInTheDocument())
    expect(screen.queryByText('LIVE VERIFIED')).not.toBeInTheDocument()
    expect(screen.getByText('Never synced')).toBeInTheDocument()
  })

  it('labels a source live only once it has actually synced', async () => {
    listSources.mockResolvedValue([source({
      verification: 'LIVE_VERIFIED', dataQuality: 'OK',
      lastSuccessfulSync: '2026-06-01T00:00:00Z',
      freshness: { isStale: false, ageHours: 2, label: 'Synced 2h ago' },
    })])
    renderPage()
    await waitFor(() => expect(screen.getByText('LIVE VERIFIED')).toBeInTheDocument())
  })

  it('surfaces a source failure without implying the data is current', async () => {
    listSources.mockResolvedValue([source({
      consecutiveFailures: 3, lastFailureMessage: 'HTTP 503 from provider',
      lastSuccessfulSync: '2026-05-01T00:00:00Z',
    })])
    renderPage()
    await waitFor(() => expect(screen.getByText(/is not syncing/i)).toBeInTheDocument())
    expect(screen.getByText('HTTP 503 from provider')).toBeInTheDocument()
    expect(screen.getByText(/may be out of date/i)).toBeInTheDocument()
  })

  it('shows a permission message when a non-admin adds a source', async () => {
    createSource.mockRejectedValue({ response: { status: 403 } })
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /Add source/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Add source/i }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Only a firm admin can add an ingestion source.', 'error'))
  })

  it('shows a submitting state while adding a source', async () => {
    let resolve: (v: unknown) => void = () => {}
    createSource.mockReturnValue(new Promise((r) => { resolve = r }))
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /Add source/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Add source/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /Adding…/i })).toBeInTheDocument())
    resolve({})
  })

  it('reports an honest message when a sync is skipped', async () => {
    listSources.mockResolvedValue([source()])
    syncSource.mockResolvedValue({ status: 'SKIPPED', recordsCreated: 0, recordsUpdated: 0, errorMessage: null })
    renderPage()
    await waitFor(() => expect(screen.getByRole('button', { name: /Sync now/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /Sync now/i }))
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith('Grants.gov is not configured, so nothing was synced.', 'success'),
    )
  })
})

describe('Discovery — forecasts tab', () => {
  it('renders the forecast disclaimer and badges every row as a forecast', async () => {
    listForecasts.mockResolvedValue({
      items: [{
        id: 'f1', externalId: 'FY27-1', agency: 'VA', subAgency: null, title: 'Base operations',
        description: null, anticipatedSolicitationDate: '2027-01-15T00:00:00Z', anticipatedAwardDate: null,
        fiscalYear: 2027, naicsCode: '561210', psc: null, setAsideExpectation: 'SDVOSB',
        contractVehicle: null, estimatedValue: '12500000', incumbentName: null, placeOfPerformance: null,
        sourceUrl: null, completeness: 0.8, dataQuality: 'OK', lastSeenAt: '2026-06-01T00:00:00Z',
        lastSyncedAt: null, linkState: 'UNLINKED', linkEvidence: null, linkConfidence: null, linkedOpportunity: null,
      }],
      total: 1, page: 1, pageSize: 25, recordKind: 'FORECAST',
      disclaimer: 'Forecasts are agency planning estimates published before a solicitation exists.',
    })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Forecasts/i }))
    await waitFor(() => expect(screen.getByText('Base operations')).toBeInTheDocument())
    expect(screen.getByText('FORECAST')).toBeInTheDocument()
    expect(screen.getByText(/published before a solicitation exists/i)).toBeInTheDocument()
    expect(screen.getByText('No solicitation yet')).toBeInTheDocument()
  })

  it('asks for human review on an uncertain forecast link', async () => {
    listForecasts.mockResolvedValue({
      items: [{
        id: 'f2', externalId: 'FY27-2', agency: 'VA', subAgency: null, title: 'Ambiguous forecast',
        description: null, anticipatedSolicitationDate: null, anticipatedAwardDate: null, fiscalYear: null,
        naicsCode: null, psc: null, setAsideExpectation: null, contractVehicle: null, estimatedValue: null,
        incumbentName: null, placeOfPerformance: null, sourceUrl: null, completeness: 0.2, dataQuality: 'PARTIAL',
        lastSeenAt: '2026-06-01T00:00:00Z', lastSyncedAt: null,
        linkState: 'REVIEW_REQUIRED',
        linkEvidence: 'Same agency and NAICS, title similarity 62%. Identifiers do not match, so this needs human confirmation.',
        linkConfidence: 0.62,
        linkedOpportunity: { id: 'o1', title: 'Possible match', responseDeadline: '2027-02-01T00:00:00Z' },
      }],
      total: 1, page: 1, pageSize: 25, recordKind: 'FORECAST', disclaimer: 'x',
    })
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Forecasts/i }))
    await waitFor(() => expect(screen.getByText(/needs your review/i)).toBeInTheDocument())
    expect(screen.getByText(/Identifiers do not match/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Confirm link/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Not a match/i })).toBeInTheDocument()
  })
})

describe('Discovery — pre-solicitation notices', () => {
  it('renders the carefully worded early-response note without promising influence', async () => {
    listNotices.mockResolvedValue([{
      id: 'n1', title: 'Sources sought for cyber support', agency: 'DoD', noticeType: 'Sources Sought',
      presolicitationKind: 'SOURCES_SOUGHT', responseDeadline: '2027-01-01T00:00:00Z', postedDate: null,
      sourceUrl: null, source: 'SAM_GOV', sourceLastSeenAt: '2026-06-01T00:00:00Z', dataQuality: 'OK',
      naicsCode: '541512', setAsideType: 'NONE', amendmentCount: 0, ownerUserId: null,
      match: { overallScore: 72, eligibility: 'ELIGIBLE', eligibilityReason: 'Active SDVOSB', hasSufficientData: true },
      classification: {
        kind: 'SOURCES_SOUGHT', label: 'Sources Sought', basis: 'NOTICE_TYPE',
        whyEarlyResponseMayMatter: 'Responding does not guarantee influence, consideration, or award.',
        priority: 'HIGH',
      },
    }])
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Pre-solicitation/i }))
    await waitFor(() => expect(screen.getByText('Sources sought for cyber support')).toBeInTheDocument())
    expect(screen.getByText('PRE-SOLICITATION')).toBeInTheDocument()
    expect(screen.getByText(/does not guarantee influence, consideration, or award/i)).toBeInTheDocument()
    expect(screen.getByText('72%')).toBeInTheDocument()
    expect(screen.getByText('Eligible')).toBeInTheDocument()
  })
})

describe('Discovery — re-competes', () => {
  it('renders the never-certain disclaimer', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Re-competes/i }))
    await waitFor(() => expect(screen.getByText(/Estimated windows, not announced dates/i)).toBeInTheDocument())
    expect(screen.getByText(/No re-compete signals detected/i)).toBeInTheDocument()
  })
})

describe('Discovery — capabilities', () => {
  it('explains that nothing is inferred', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /Capabilities/i }))
    await waitFor(() => expect(screen.getByText(/Your capability library is empty/i)).toBeInTheDocument())
    expect(screen.getByText(/Only recorded capabilities count towards a match — nothing is inferred/i)).toBeInTheDocument()
  })
})

// §7.2 — the Opportunity Agent panel is a tab on THIS page, not a second
// discovery application. The panel's own behaviour is covered in
// components/section7/OpportunityAgentPanel.test.tsx.
describe('Discovery — Opportunity Agent tab', () => {
  it('lands on Sources exactly as before §7.2', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByRole('tab', { name: /Sources/i })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByRole('tab', { name: /^Agent/i })).toHaveAttribute('aria-selected', 'false')
  })

  it('opens the agent panel from its tab', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('tab', { name: /^Agent/i }))
    await waitFor(() => expect(screen.getByText(/Loading Opportunity Agent status/i)).toBeInTheDocument())
    expect(screen.getByRole('tab', { name: /^Agent/i })).toHaveAttribute('aria-selected', 'true')
  })
})
