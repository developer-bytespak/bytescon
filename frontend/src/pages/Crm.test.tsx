// =============================================================
// §8.1 — CRM UI.
//
// The assertion that matters most: NO_DATA must render as "not enough data",
// never as a zero score and never as a weak relationship.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import CrmPage from './Crm'
import { RelationshipPanel } from '../components/crm/CrmUi'
import { OpportunityCrmPanel } from '../components/crm/OpportunityCrmPanel'
import type { RelationshipStrength } from '../services/crmApi'

const listAgencies = vi.fn()
const listContacts = vi.fn()
const listActivities = vi.fn()
const listFollowUps = vi.fn()
const createFollowUp = vi.fn()
const transitionFollowUp = vi.fn()
const opportunityContext = vi.fn()
const listOffices = vi.fn()
const createOffice = vi.fn()
const createContact = vi.fn()
const createActivity = vi.fn()
const getContact = vi.fn()
const searchOpportunityOptions = vi.fn()
const getOpportunityOption = vi.fn()

vi.mock('../services/crmApi', async () => {
  const actual = await vi.importActual<typeof import('../services/crmApi')>('../services/crmApi')
  return {
    ...actual,
    crmApi: {
      listAgencies: (...a: unknown[]) => listAgencies(...a),
      listContacts: (...a: unknown[]) => listContacts(...a),
      listActivities: (...a: unknown[]) => listActivities(...a),
      listFollowUps: (...a: unknown[]) => listFollowUps(...a),
      createFollowUp: (...a: unknown[]) => createFollowUp(...a),
      transitionFollowUp: (...a: unknown[]) => transitionFollowUp(...a),
      opportunityContext: (...a: unknown[]) => opportunityContext(...a),
      listOffices: (...a: unknown[]) => listOffices(...a),
      createOffice: (...a: unknown[]) => createOffice(...a),
      getContact: (...a: unknown[]) => getContact(...a),
      createContact: (...a: unknown[]) => createContact(...a),
      createActivity: (...a: unknown[]) => createActivity(...a),
      listPartnerContacts: vi.fn(),
      createPartnerContact: vi.fn(),
      getPartnerCrm: vi.fn(),
    },
    searchOpportunityOptions: (...a: unknown[]) => searchOpportunityOptions(...a),
    getOpportunityOption: (...a: unknown[]) => getOpportunityOption(...a),
  }
})

vi.mock('../services/api', () => ({ teamingApi: { listPartners: vi.fn().mockResolvedValue({ data: { partners: [] } }) } }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  listAgencies.mockResolvedValue({ items: [], note: 'There is no separate agency registry.' })
  listContacts.mockResolvedValue([])
  listActivities.mockResolvedValue([])
  listFollowUps.mockResolvedValue([])
  listOffices.mockResolvedValue([])
  searchOpportunityOptions.mockResolvedValue([])
  getOpportunityOption.mockResolvedValue(null)
})

describe('CRM page', () => {
  it('renders the five CRM sections', async () => {
    wrap(<CrmPage />)
    for (const label of ['Agencies', 'Contacts', 'Activities', 'Follow-ups', 'Partners']) {
      expect(await screen.findByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('states that agencies are grouped rather than stored as a registry', async () => {
    listAgencies.mockResolvedValue({
      items: [{ agencyName: 'DEPT OF THE NAVY', officeCount: 1, contactCount: 2, activityCount: 3, lastActivityAt: null }],
      note: 'There is no separate agency registry.',
    })
    wrap(<CrmPage />)
    expect(await screen.findByText('DEPT OF THE NAVY')).toBeInTheDocument()
    expect(screen.getByText(/no separate agency registry/i)).toBeInTheDocument()
  })

  it('shows an honest empty state rather than an empty grid', async () => {
    wrap(<CrmPage />)
    expect(await screen.findByText(/No agency relationships yet/i)).toBeInTheDocument()
  })

  it('offers Start and Done on an open follow-up and calls the transition', async () => {
    listFollowUps.mockResolvedValue([
      { id: 'f1', title: 'Call the CO', dueAt: '2027-01-01T00:00:00.000Z', status: 'OPEN', priority: 'HIGH', ownerUserId: 'u1', notes: null, completedAt: null },
    ])
    transitionFollowUp.mockResolvedValue({})
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Follow-ups' }))
    expect(await screen.findByText('Call the CO')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(transitionFollowUp).toHaveBeenCalledWith('f1', 'DONE'))
  })

  it('marks a past-due follow-up as overdue', async () => {
    listFollowUps.mockResolvedValue([
      { id: 'f2', title: 'Overdue item', dueAt: '2020-01-01T00:00:00.000Z', status: 'OPEN', priority: 'HIGH', ownerUserId: 'u1', notes: null, completedAt: null },
    ])
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Follow-ups' }))
    expect(await screen.findByText('OVERDUE')).toBeInTheDocument()
  })

  it('says follow-ups reuse the existing reminder scan', async () => {
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Follow-ups' }))
    expect(await screen.findByText(/existing reminder scan/i)).toBeInTheDocument()
  })
})

describe('RelationshipPanel', () => {
  const noData: RelationshipStrength = {
    state: 'NO_DATA',
    score: null,
    reason: 'No interactions have been logged with this contact yet.',
    evidence: [],
    totalInteractions: 0,
    meaningfulInteractions: 0,
    lastInteractionAt: null,
    daysSinceLastInteraction: null,
  }

  it('renders NO_DATA as "not enough data" — never as weak, never as zero', () => {
    wrap(<RelationshipPanel relationship={noData} />)
    expect(screen.getByText(/NOT ENOUGH DATA/i)).toBeInTheDocument()
    expect(screen.queryByText(/WEAK/i)).not.toBeInTheDocument()
    expect(screen.queryByText('· 0')).not.toBeInTheDocument()
  })

  it('shows the score and every evidence line when data exists', () => {
    wrap(
      <RelationshipPanel
        relationship={{
          ...noData,
          state: 'ACTIVE',
          score: 62,
          reason: '3 meaningful touchpoints.',
          evidence: [
            { factor: 'Recency', detail: 'Last interaction was 4 day(s) ago.', points: 30 },
            { factor: 'Frequency', detail: '4 interaction(s) in the last 365 days.', points: 20 },
          ],
          totalInteractions: 4,
          meaningfulInteractions: 3,
        }}
      />,
    )
    expect(screen.getByText(/ACTIVE · 62/)).toBeInTheDocument()
    expect(screen.getByText(/Last interaction was 4 day\(s\) ago/)).toBeInTheDocument()
    expect(screen.getByText(/never written by an agent/i)).toBeInTheDocument()
  })
})

describe('OpportunityCrmPanel', () => {
  it('shows agency, contacts, next follow-up and defers value to the portfolio service', async () => {
    opportunityContext.mockResolvedValue({
      opportunityId: 'o1',
      agencyName: 'DEPT OF THE NAVY',
      offices: [{ id: 'of1', agencyName: 'DEPT OF THE NAVY', officeName: 'NAVSUP', officeSymbol: null, location: null, notes: null }],
      contacts: [{ id: 'c1', fullName: 'Dana Reyes', contactRole: 'CONTRACTING_OFFICER', agencyName: 'DEPT OF THE NAVY', agencyOfficeId: null, title: 'CO', email: null, phone: null, status: 'ACTIVE', notes: null }],
      activities: [{ id: 'a1', activityType: 'CALL', occurredAt: '2026-08-01T00:00:00.000Z', subject: 'Intro call', summary: null, notes: null, durationMinutes: 20, location: null, participants: [], followUpNeeded: false, agencyName: null }],
      nextFollowUp: { id: 'f1', title: 'Send capability statement', dueAt: '2027-01-01T00:00:00.000Z', status: 'OPEN', priority: 'HIGH', ownerUserId: 'u1', notes: null, completedAt: null },
      openFollowUps: [],
      partnersEngaged: 1,
      valueNote: 'Weighted opportunity value is provided by the portfolio service, not by the CRM.',
    })
    wrap(<OpportunityCrmPanel opportunityId="o1" />)
    expect(await screen.findByText('DEPT OF THE NAVY')).toBeInTheDocument()
    expect(screen.getByText('Dana Reyes')).toBeInTheDocument()
    expect(screen.getByText('Send capability statement')).toBeInTheDocument()
    expect(screen.getByText('Intro call')).toBeInTheDocument()
    expect(screen.getByText(/portfolio service, not by the CRM/i)).toBeInTheDocument()
  })

  it('does not render a weighted value of its own', async () => {
    opportunityContext.mockResolvedValue({
      opportunityId: 'o1', agencyName: 'DEPT OF TEST', offices: [], contacts: [], activities: [],
      nextFollowUp: null, openFollowUps: [], partnersEngaged: 0,
      valueNote: 'Weighted opportunity value is provided by the portfolio service, not by the CRM.',
    })
    wrap(<OpportunityCrmPanel opportunityId="o1" />)
    await screen.findByText(/No relationship history on this opportunity yet/i)
    expect(screen.queryByText(/expected value/i)).not.toBeInTheDocument()
  })
})

// =============================================================
// §8.1 follow-up — the three link paths that had no UI, and the agency-name
// mismatch that hid a contact from its own opportunity.
// =============================================================

describe('CRM page — agency offices', () => {
  it('offers a form to add an office, since agencies themselves are never created', async () => {
    wrap(<CrmPage />)
    expect(await screen.findByLabelText('Office agency')).toBeInTheDocument()
    expect(screen.getByLabelText('Office name')).toBeInTheDocument()
    expect(screen.getByText(/no separate agency record to create/i)).toBeInTheDocument()
  })

  it('creates the office with the agency it belongs to', async () => {
    createOffice.mockResolvedValue({})
    wrap(<CrmPage />)
    fireEvent.change(await screen.findByLabelText('Office agency'), { target: { value: 'Department of Energy' } })
    fireEvent.change(screen.getByLabelText('Office name'), { target: { value: 'EM-Portsmouth' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add office' }))
    await waitFor(() => expect(createOffice).toHaveBeenCalledWith(
      expect.objectContaining({ agencyName: 'Department of Energy', officeName: 'EM-Portsmouth' }),
    ))
  })

  it('keeps the agency list working when offices cannot be loaded', async () => {
    listOffices.mockRejectedValue(new Error('offline'))
    listAgencies.mockResolvedValue({
      items: [{ agencyName: 'Department of Energy', officeCount: 0, contactCount: 1, activityCount: 0, lastActivityAt: null }],
      note: 'note',
    })
    wrap(<CrmPage />)
    // Supplementary detail failing must not hide the point of the tab.
    expect(await screen.findByText('Department of Energy')).toBeInTheDocument()
  })
})

describe('CRM page — linking an interaction to an opportunity', () => {
  const CONTACT = {
    id: 'c1', agencyName: 'Department of Energy', agencyOfficeId: null, fullName: 'John Test',
    title: 'Contracting Officer', contactRole: 'CONTRACTING_OFFICER', email: null, phone: null,
    status: 'ACTIVE', notes: null, activities: [], followUps: [],
    relationship: { state: 'NO_DATA', score: null, reason: 'No interactions logged yet.', evidence: [], totalInteractions: 0, meaningfulInteractions: 0, lastInteractionAt: null, daysSinceLastInteraction: null },
  }

  beforeEach(() => {
    listContacts.mockResolvedValue([{ ...CONTACT, _count: { activities: 0, followUps: 0 } }])
    getContact.mockResolvedValue(CONTACT)
    searchOpportunityOptions.mockResolvedValue([
      { id: 'opp-1', title: 'DOE Cybersecurity Support', agency: 'Department of Energy' },
    ])
  })

  it('offers a searchable opportunity picker when logging an interaction', async () => {
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Contacts' }))
    fireEvent.click(await screen.findByText('John Test'))
    const picker = await screen.findByLabelText('Link to an opportunity (optional)')
    fireEvent.focus(picker)
    expect(await screen.findByText('DOE Cybersecurity Support')).toBeInTheDocument()
  })

  it('searches on the server rather than filtering a preloaded list', async () => {
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Contacts' }))
    fireEvent.click(await screen.findByText('John Test'))
    const picker = await screen.findByLabelText('Link to an opportunity (optional)')
    fireEvent.focus(picker)
    fireEvent.change(picker, { target: { value: 'cy' } })
    await waitFor(() => expect(searchOpportunityOptions).toHaveBeenCalledWith('cy'))
  })

  it('sends the chosen opportunity with the interaction', async () => {
    createActivity.mockResolvedValue({})
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Contacts' }))
    fireEvent.click(await screen.findByText('John Test'))
    fireEvent.change(await screen.findByLabelText('Subject'), { target: { value: 'Intro call' } })
    const picker = screen.getByLabelText('Link to an opportunity (optional)')
    fireEvent.focus(picker)
    fireEvent.click(await screen.findByText('DOE Cybersecurity Support'))
    fireEvent.click(screen.getByRole('button', { name: 'Log interaction' }))
    await waitFor(() => expect(createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ opportunityId: 'opp-1', governmentContactId: 'c1' }),
    ))
  })

  it('leaves the link optional, and sends null when none is chosen', async () => {
    createActivity.mockResolvedValue({})
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Contacts' }))
    fireEvent.click(await screen.findByText('John Test'))
    fireEvent.change(await screen.findByLabelText('Subject'), { target: { value: 'Quick note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Log interaction' }))
    await waitFor(() => expect(createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ opportunityId: null }),
    ))
  })

  it('says plainly that linking records history and does not move the pipeline', async () => {
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Contacts' }))
    fireEvent.click(await screen.findByText('John Test'))
    expect(await screen.findByText(/never moves the pursuit/i)).toBeInTheDocument()
  })
})

describe('CRM page — linking a follow-up', () => {
  beforeEach(() => {
    searchOpportunityOptions.mockResolvedValue([
      { id: 'opp-1', title: 'DOE Cybersecurity Support', agency: 'Department of Energy' },
    ])
    listContacts.mockResolvedValue([
      { id: 'c1', agencyName: 'Department of Energy', fullName: 'John Test', contactRole: 'CONTRACTING_OFFICER', status: 'ACTIVE', agencyOfficeId: null, title: null, email: null, phone: null, notes: null },
    ])
  })

  it('offers both a contact and an opportunity picker', async () => {
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Follow-ups' }))
    expect(await screen.findByLabelText('Link to contact')).toBeInTheDocument()
    expect(screen.getByLabelText('Link to an opportunity (optional)')).toBeInTheDocument()
  })

  it('sends both links when they are chosen', async () => {
    createFollowUp.mockResolvedValue({})
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Follow-ups' }))
    fireEvent.change(await screen.findByLabelText('Follow-up title'), { target: { value: 'Call the CO' } })
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-12-01' } })
    fireEvent.change(await screen.findByLabelText('Link to contact'), { target: { value: 'c1' } })
    const picker = screen.getByLabelText('Link to an opportunity (optional)')
    fireEvent.focus(picker)
    fireEvent.click(await screen.findByText('DOE Cybersecurity Support'))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(createFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ governmentContactId: 'c1', opportunityId: 'opp-1' }),
    ))
  })

  it('still creates an unlinked follow-up', async () => {
    createFollowUp.mockResolvedValue({})
    wrap(<CrmPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Follow-ups' }))
    fireEvent.change(await screen.findByLabelText('Follow-up title'), { target: { value: 'General task' } })
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-12-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(createFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ governmentContactId: null, opportunityId: null }),
    ))
  })
})

describe('OpportunityCrmPanel — the agency SAM actually stores', () => {
  const SAM_RAW = 'ENERGY, DEPARTMENT OF.ENERGY, DEPARTMENT OF.EM-PORTSMOUTH/PADUCAH PROJECT OFC'

  it('shows the department as a person says it, not SAM’s dotted path', async () => {
    opportunityContext.mockResolvedValue({
      opportunityId: 'opp-1',
      agencyName: SAM_RAW,
      agencyPath: {
        department: 'Department of Energy', subTier: null, office: 'EM-PORTSMOUTH/PADUCAH PROJECT OFC',
        display: 'Department of Energy — EM-PORTSMOUTH/PADUCAH PROJECT OFC',
        segments: ['Department of Energy', 'EM-PORTSMOUTH/PADUCAH PROJECT OFC'],
      },
      offices: [], contacts: [], activities: [], nextFollowUp: null, openFollowUps: [],
      partnersEngaged: 0, valueNote: 'note',
    })
    wrap(<OpportunityCrmPanel opportunityId="opp-1" />)
    expect(await screen.findByText('Department of Energy')).toBeInTheDocument()
    expect(screen.getByText(/EM-PORTSMOUTH\/PADUCAH PROJECT OFC/)).toBeInTheDocument()
    // The raw dotted string is never shown to a user.
    expect(screen.queryByText(SAM_RAW)).not.toBeInTheDocument()
  })

  it('shows a contact typed as "Department of Energy" against a SAM-formatted opportunity', async () => {
    opportunityContext.mockResolvedValue({
      opportunityId: 'opp-1',
      agencyName: SAM_RAW,
      agencyPath: {
        department: 'Department of Energy', subTier: null, office: 'EM-PORTSMOUTH/PADUCAH PROJECT OFC',
        display: 'Department of Energy', segments: ['Department of Energy'],
      },
      offices: [],
      contacts: [{
        id: 'c1', agencyName: 'Department of Energy', agencyOfficeId: null, fullName: 'John Test',
        title: 'Contracting Officer', contactRole: 'CONTRACTING_OFFICER', email: null, phone: null,
        status: 'ACTIVE', notes: null,
      }],
      activities: [], nextFollowUp: null, openFollowUps: [], partnersEngaged: 0, valueNote: 'note',
    })
    wrap(<OpportunityCrmPanel opportunityId="opp-1" />)
    expect(await screen.findByText('John Test')).toBeInTheDocument()
  })

  it('tells the user how to make an interaction appear here', async () => {
    opportunityContext.mockResolvedValue({
      opportunityId: 'opp-1', agencyName: SAM_RAW,
      agencyPath: { department: 'Department of Energy', subTier: null, office: null, display: 'Department of Energy', segments: ['Department of Energy'] },
      offices: [], contacts: [], activities: [], nextFollowUp: null, openFollowUps: [], partnersEngaged: 0, valueNote: 'note',
    })
    wrap(<OpportunityCrmPanel opportunityId="opp-1" />)
    expect(await screen.findByText(/Link to an opportunity/i)).toBeInTheDocument()
  })
})
