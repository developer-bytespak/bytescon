// =============================================================
// §8.3 — Knowledge hub, personnel and the partner portal.
//
// The assertions that matter: the hub links to existing pages rather than
// duplicating them, "no approved resume" is stated rather than left blank, an
// unverified qualification looks unverified, and the external portal renders no
// internal navigation or prime figures.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import KnowledgePage from './Knowledge'
import { PersonnelSection } from '../components/knowledge/PersonnelSection'
import PartnerPortalPage from './partner/PartnerPortal'
import type { PersonnelSummary } from '../services/knowledgeApi'

const list = vi.fn()
const get = vi.fn()
const create = vi.fn()
const approveResume = vi.fn()
const verifyQualification = vi.fn()
const createResume = vi.fn()
const uploadResumeFile = vi.fn()

vi.mock('../services/knowledgeApi', async () => {
  const actual = await vi.importActual<typeof import('../services/knowledgeApi')>('../services/knowledgeApi')
  return {
    ...actual,
    personnelApi: {
      list: (...a: unknown[]) => list(...a),
      get: (...a: unknown[]) => get(...a),
      create: (...a: unknown[]) => create(...a),
      approveResume: (...a: unknown[]) => approveResume(...a),
      verifyQualification: (...a: unknown[]) => verifyQualification(...a),
      addQualification: vi.fn(), importFromUser: vi.fn(), archive: vi.fn(),
      createResume: (...a: unknown[]) => createResume(...a),
      uploadResumeFile: (...a: unknown[]) => uploadResumeFile(...a),
      downloadResumeFile: vi.fn(),
      listKeyPersonnel: vi.fn(), addKeyPersonnel: vi.fn(),
    },
  }
})

const engagements = vi.fn()
const invoices = vi.fn()
vi.mock('../services/partnerPortalApi', async () => {
  const actual = await vi.importActual<typeof import('../services/partnerPortalApi')>('../services/partnerPortalApi')
  return {
    ...actual,
    loadPartnerAuth: () => ({
      token: 't', user: { id: 'u', email: 'e@x.test', firstName: 'Ext', lastName: 'User' },
      branding: { brandingDisplayName: 'Prime Co', brandingLogoUrl: null, brandingPrimaryColor: null, brandingSecondaryColor: null },
    }),
    partnerPortalApi: {
      engagements: (...a: unknown[]) => engagements(...a),
      invoices: (...a: unknown[]) => invoices(...a),
      purchaseOrder: vi.fn(), login: vi.fn(), me: vi.fn(),
    },
  }
})

vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

const person = (over: Partial<PersonnelSummary> = {}): PersonnelSummary => ({
  id: 'p1', firstName: 'Jane', lastName: 'Doe', jobTitle: 'Senior Cyber Engineer',
  employmentType: 'CONSULTANT', source: 'INTERNAL', isActive: true, isArchived: false,
  user: null, qualifications: [], resumes: [], _count: { proposalUses: 0, allocations: 0 },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([])
  invoices.mockResolvedValue([])
})

describe('Knowledge hub', () => {
  it('links to the existing knowledge pages rather than duplicating them', async () => {
    wrap(<KnowledgePage />)
    for (const label of ['Capabilities', 'Past performance', 'Templates & forms', 'Standing documents']) {
      expect(await screen.findByText(label)).toBeInTheDocument()
    }
    expect(screen.getByText(/rather than holding a second copy/i)).toBeInTheDocument()
  })

  it('shows an honest empty state for personnel', async () => {
    wrap(<KnowledgePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Personnel' }))
    expect(await screen.findByText(/Nobody is in the personnel library yet/i)).toBeInTheDocument()
    expect(screen.getAllByText(/A login is not required/i).length).toBeGreaterThan(0)
  })

  // The empty state used to REPLACE the section that owns "Add a person", so
  // an empty library could never be filled. The controls must survive it.
  it('still offers a way to add the first person when the library is empty', async () => {
    wrap(<KnowledgePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Personnel' }))
    expect(await screen.findByRole('button', { name: 'Add person' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument()
  })
})

describe('Personnel list', () => {
  it('says NO APPROVED RESUME rather than leaving it blank', () => {
    wrap(<PersonnelSection people={[person()]} onChanged={vi.fn()} />)
    expect(screen.getByText('NO APPROVED RESUME')).toBeInTheDocument()
  })

  it('shows the approved version when there is one', () => {
    wrap(<PersonnelSection people={[person({ resumes: [{ id: 'r1', versionNumber: 3, approvedAt: '2026-01-01T00:00:00.000Z' }] })]} onChanged={vi.fn()} />)
    expect(screen.getByText('APPROVED RESUME v3')).toBeInTheDocument()
  })

  it('states when a person has no linked account', () => {
    wrap(<PersonnelSection people={[person()]} onChanged={vi.fn()} />)
    expect(screen.getByText(/no linked account/i)).toBeInTheDocument()
  })

  it('flags partner-submitted people so their provenance is visible', () => {
    wrap(<PersonnelSection people={[person({ source: 'PARTNER_SUBMITTED' })]} onChanged={vi.fn()} />)
    expect(screen.getByText('PARTNER SUBMITTED')).toBeInTheDocument()
  })
})

describe('Personnel detail', () => {
  const detail = {
    ...person(),
    email: null, phone: null, location: null, summary: null, yearsExperience: null,
    resumes: [
      { id: 'r1', versionNumber: 1, status: 'APPROVED' as const, title: null, content: {}, source: 'INTERNAL' as const, approvedAt: '2026-01-01T00:00:00.000Z', supersededAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'r2', versionNumber: 2, status: 'DRAFT' as const, title: null, content: {}, source: 'INTERNAL' as const, approvedAt: null, supersededAt: null, createdAt: '2026-02-01T00:00:00.000Z' },
    ],
    qualifications: [
      { id: 'q1', laborCategory: 'Senior Cyber Analyst', verification: 'UNVERIFIED' as const, yearsExperience: null, evidence: null, effectiveDate: null, expirationDate: null },
    ],
    allocations: [], proposalUses: [],
  }

  it('shows an unverified qualification as unverified and offers verification', async () => {
    get.mockResolvedValue(detail)
    wrap(<PersonnelSection people={[person()]} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByText('Jane Doe'))
    expect(await screen.findByText('UNVERIFIED')).toBeInTheDocument()
    expect(screen.getByText(/Matching a job title is not evidence/i)).toBeInTheDocument()
  })

  it('offers approval only on the draft version', async () => {
    get.mockResolvedValue(detail)
    wrap(<PersonnelSection people={[person()]} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByText('Jane Doe'))
    await screen.findByText('v1')
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1)
    expect(screen.getByText(/An approved version can never be edited/i)).toBeInTheDocument()
  })

  it('says years of experience are not recorded rather than showing zero', async () => {
    get.mockResolvedValue(detail)
    wrap(<PersonnelSection people={[person()]} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByText('Jane Doe'))
    expect(await screen.findByText(/Years of experience not recorded/i)).toBeInTheDocument()
  })
})

describe('Partner portal (external)', () => {
  it('renders no internal navigation', async () => {
    engagements.mockResolvedValue({ opportunities: [], contracts: [], purchaseOrders: [], note: 'You see only granted engagements.' })
    wrap(<PartnerPortalPage />)
    await screen.findByText(/No engagements have been shared with you yet/i)
    for (const internal of ['Opportunities', 'Portfolio', 'Discovery', 'Relationships', 'Knowledge', 'Receivables']) {
      expect(screen.queryByText(internal)).not.toBeInTheDocument()
    }
  })

  it('shows the prime brand and an honest no-access state', async () => {
    engagements.mockResolvedValue({ opportunities: [], contracts: [], purchaseOrders: [], note: 'You see only granted engagements.' })
    wrap(<PartnerPortalPage />)
    expect(await screen.findByText('Prime Co')).toBeInTheDocument()
    expect(screen.getByText(/grants access to each piece of work separately/i)).toBeInTheDocument()
  })

  it('shows only the partner’s own subcontract figures', async () => {
    engagements.mockResolvedValue({
      opportunities: [], contracts: [],
      purchaseOrders: [{ id: 'po1', poNumber: 'PO-1', status: 'APPROVED', ceilingAmount: '50000.00', startDate: null, endDate: null }],
      note: 'You see only granted engagements.',
    })
    wrap(<PartnerPortalPage />)
    expect(await screen.findByText('PO-1')).toBeInTheDocument()
    expect(screen.getByText(/Ceiling \$50,000\.00/)).toBeInTheDocument()
    // No prime-side figures anywhere on the page.
    const body = document.body.textContent ?? ''
    for (const forbidden of ['Budget', 'Margin', 'Backlog', 'Win probability']) {
      expect(body).not.toContain(forbidden)
    }
  })
})

// The resume controls live on a person's own page, and the row is the only way
// in. Without a visible cue people conclude resumes are missing entirely.
describe('Personnel list — finding the resume controls', () => {
  it('says the person row opens their resume', async () => {
    list.mockResolvedValue([{
      id: 'p1', firstName: 'Alicia', lastName: 'Reyes', jobTitle: 'PM',
      employmentType: 'EMPLOYEE', source: 'INTERNAL', isArchived: false,
      user: null, qualifications: [], resumes: [],
      _count: { proposalUses: 0, allocations: 0 },
    }])
    wrap(<KnowledgePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Personnel' }))
    expect(await screen.findByText(/Open to add a resume/i)).toBeInTheDocument()
  })

  it('says the add form records who the person is, not their resume', async () => {
    wrap(<KnowledgePage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Personnel' }))
    expect(await screen.findByText(/Their resume, qualifications and document live on their own page/i)).toBeInTheDocument()
  })
})

// A resume usually arrives as a finished document. Requiring a typed summary
// before one could be uploaded made people conclude there was no way to add a
// resume at all.
describe('Personnel detail — adding a resume', () => {
  const detailNoResume = {
    ...person(),
    email: null, phone: null, location: null, summary: null, yearsExperience: null,
    resumes: [], qualifications: [], proposalUses: [], allocations: [],
  }

  const openPerson = async () => {
    get.mockResolvedValue(detailNoResume)
    wrap(<PersonnelSection people={[person()]} onChanged={vi.fn()} />)
    fireEvent.click(screen.getByText('Jane Doe'))
    await screen.findByLabelText('Resume summary')
  }

  it('creates a draft with no summary typed', async () => {
    createResume.mockResolvedValue({ id: 'r1' })
    await openPerson()
    fireEvent.click(screen.getByRole('button', { name: 'New draft' }))
    await waitFor(() => expect(createResume).toHaveBeenCalledWith('p1', {}))
  })

  it('uploading a document creates the version it belongs to', async () => {
    createResume.mockResolvedValue({ id: 'r1' })
    uploadResumeFile.mockResolvedValue({})
    await openPerson()
    const file = new File(['cv'], 'jane.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByLabelText('Upload a resume document'), { target: { files: [file] } })
    await waitFor(() => expect(createResume).toHaveBeenCalled())
    await waitFor(() => expect(uploadResumeFile).toHaveBeenCalledWith('r1', file))
  })

  it('says a summary is optional', async () => {
    await openPerson()
    expect(screen.getByText(/A summary is optional/i)).toBeInTheDocument()
  })
})
