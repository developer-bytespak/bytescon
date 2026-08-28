// =============================================================
// §8.4 — Partner portal UI.
//
// The assertions that matter: a second factor stops short of a session, a
// deliverable response is described as submitted for review rather than done,
// a profile edit is described as proposed, and the reset screen says the same
// thing for every address.
// =============================================================
import { render as rtlRender, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactElement } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PartnerPortalPage, { PartnerLoginPage } from './PartnerPortal'

// The portal keeps its active tab in the URL, so every render needs a router.
const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>)

// Hoisted: vi.mock's factory runs before module-scope initialisation.
const h = vi.hoisted(() => ({
  api: {
    login: vi.fn(), verifyMfa: vi.fn(), forgotPassword: vi.fn(), resetPassword: vi.fn(),
    engagements: vi.fn(), invoices: vi.fn(), deliverables: vi.fn(), deliverable: vi.fn(),
    saveDeliverableDraft: vi.fn(), submitDeliverable: vi.fn(), downloadSubmission: vi.fn(),
    documents: vi.fn(), downloadDocument: vi.fn(), profile: vi.fn(), proposeProfileChange: vi.fn(),
    mfaStatus: vi.fn(), mfaEnroll: vi.fn(), mfaConfirm: vi.fn(), mfaDisable: vi.fn(),
    purchaseOrder: vi.fn(), uploadDocument: vi.fn(),
  },
  savePartnerAuth: vi.fn(),
  state: { auth: null as unknown },
}))

vi.mock('../../services/partnerPortalApi', () => ({
  partnerPortalApi: h.api,
  savePartnerAuth: h.savePartnerAuth,
  clearPartnerAuth: vi.fn(),
  loadPartnerAuth: () => h.state.auth,
}))

const api = h.api
const savePartnerAuth = h.savePartnerAuth

const AUTH = {
  token: 't', user: { id: 'u1', email: 'a@b.test', firstName: 'Ext', lastName: 'User' },
  branding: { brandingDisplayName: 'Bytescon', brandingLogoUrl: null, brandingPrimaryColor: null, brandingSecondaryColor: null },
}

beforeEach(() => {
  vi.clearAllMocks()
  h.state.auth = AUTH
  api.engagements.mockResolvedValue({ opportunities: [], contracts: [], purchaseOrders: [], note: 'Granted engagements only.' })
  api.invoices.mockResolvedValue([])
  api.deliverables.mockResolvedValue([])
  api.documents.mockResolvedValue([])
  api.mfaStatus.mockResolvedValue({ enabled: false, enrolledAt: null })
})

describe('partner sign-in', () => {
  it('stops at the second factor instead of storing a session', async () => {
    h.state.auth = null
    api.login.mockResolvedValue({ mfaRequired: true, mfaChallengeToken: 'challenge-token' })
    render(<PartnerLoginPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('Two-factor code')).toBeInTheDocument()
    expect(savePartnerAuth).not.toHaveBeenCalled()
  })

  it('stores the session only after the code is accepted', async () => {
    h.state.auth = null
    api.login.mockResolvedValue({ mfaRequired: true, mfaChallengeToken: 'challenge-token' })
    api.verifyMfa.mockResolvedValue(AUTH)
    render(<PartnerLoginPage />)
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.test' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    fireEvent.change(await screen.findByLabelText('Authentication code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }))
    await waitFor(() => expect(api.verifyMfa).toHaveBeenCalledWith('challenge-token', '123456'))
    await waitFor(() => expect(savePartnerAuth).toHaveBeenCalledWith(AUTH))
  })

  it('says the same thing for any address on the reset screen', async () => {
    h.state.auth = null
    api.forgotPassword.mockResolvedValue({ message: 'If that email address has a portal account, a reset link has been sent to it.' })
    render(<PartnerLoginPage />)
    fireEvent.click(screen.getByRole('button', { name: /Forgot your password/i }))
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'nobody@nowhere.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText(/If that email address has a portal account/i)).toBeInTheDocument()
  })
})

describe('deliverable submission', () => {
  const DELIVERABLE = {
    id: 'd1', name: 'Monthly report', cdrlNumber: 'A001', description: 'Report on the month.',
    dueDate: '2026-09-01T00:00:00.000Z', status: 'NOT_STARTED', primeStatus: 'NOT_STARTED',
    submissions: [], note: 'Submitting a response records it for the prime contractor to review.',
  }

  it('describes a submission as awaiting the prime, not as accepted', async () => {
    api.deliverables.mockResolvedValue([DELIVERABLE])
    api.deliverable.mockResolvedValue(DELIVERABLE)
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deliverables' }))
    fireEvent.click(await screen.findByText('Monthly report'))
    expect(await screen.findByText(/records it for the prime contractor to review/i)).toBeInTheDocument()
  })

  it('offers no control that accepts a response', async () => {
    api.deliverables.mockResolvedValue([DELIVERABLE])
    api.deliverable.mockResolvedValue({
      ...DELIVERABLE,
      submissions: [{ id: 's1', status: 'SUBMITTED', note: 'done', fileName: null, fileSize: null, submittedAt: '2026-08-10T00:00:00.000Z', reviewedAt: null, reviewNotes: null, createdAt: '2026-08-10T00:00:00.000Z' }],
    })
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deliverables' }))
    fireEvent.click(await screen.findByText('Monthly report'))
    await screen.findByText('SUBMITTED')
    expect(screen.queryByRole('button', { name: /accept/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument()
  })

  it('saves a draft and then submits it', async () => {
    api.deliverables.mockResolvedValue([DELIVERABLE])
    api.deliverable
      .mockResolvedValueOnce(DELIVERABLE)
      .mockResolvedValue({
        ...DELIVERABLE,
        submissions: [{ id: 's1', status: 'DRAFT', note: 'First pass', fileName: null, fileSize: null, submittedAt: null, reviewedAt: null, reviewNotes: null, createdAt: '2026-08-10T00:00:00.000Z' }],
      })
    api.saveDeliverableDraft.mockResolvedValue({ id: 's1', status: 'DRAFT' })
    api.submitDeliverable.mockResolvedValue({ id: 's1', status: 'SUBMITTED' })

    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deliverables' }))
    fireEvent.click(await screen.findByText('Monthly report'))
    fireEvent.change(await screen.findByLabelText('Submission note'), { target: { value: 'First pass' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => expect(api.saveDeliverableDraft).toHaveBeenCalledWith('d1', 'First pass', null))

    fireEvent.click(await screen.findByRole('button', { name: 'Submit for review' }))
    await waitFor(() => expect(api.submitDeliverable).toHaveBeenCalledWith('s1'))
  })

  it('surfaces a refusal from the server', async () => {
    api.deliverables.mockResolvedValue([DELIVERABLE])
    api.deliverable.mockRejectedValue({ response: { data: { error: 'You do not have access to this deliverable' } } })
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deliverables' }))
    fireEvent.click(await screen.findByText('Monthly report'))
    expect(await screen.findByText(/do not have access/i)).toBeInTheDocument()
  })
})

describe('documents', () => {
  it('downloads through the authenticated client rather than a plain link', async () => {
    api.documents.mockResolvedValue([
      { id: 'doc1', title: 'Insurance certificate', category: 'EVIDENCE', fileName: 'cert.pdf', reviewStatus: 'PENDING_REVIEW' },
    ])
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
    await waitFor(() => expect(api.downloadDocument).toHaveBeenCalledWith('doc1', 'cert.pdf'))
  })
})

describe('profile', () => {
  const PROFILE = {
    partner: {
      id: 'p1', name: 'Acme Sub', uei: 'ABC123', cage: '1A2B3', website: null, geography: null,
      contactName: null, contactEmail: null, contactPhone: null,
      capabilities: [], certifications: [], primaryNaicsCodes: [],
    },
    changeRequests: [],
    editableFields: ['website'],
    note: 'Changes are proposed, not applied. The prime contractor reviews each one before it takes effect.',
  }

  it('says a change is proposed rather than applied', async () => {
    api.profile.mockResolvedValue(PROFILE)
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }))
    expect(await screen.findByText(/proposed, not applied/i)).toBeInTheDocument()
  })

  it('submits only the fields the partner filled in', async () => {
    api.profile.mockResolvedValue(PROFILE)
    api.proposeProfileChange.mockResolvedValue({ id: 'r1', status: 'PENDING_REVIEW' })
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }))
    fireEvent.change(await screen.findByLabelText('website'), { target: { value: 'https://acme.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Propose changes' }))
    await waitFor(() => expect(api.proposeProfileChange).toHaveBeenCalledWith({ website: 'https://acme.example' }))
  })

  it('blocks a second proposal while one is under review', async () => {
    api.profile.mockResolvedValue({
      ...PROFILE,
      changeRequests: [{ id: 'r1', status: 'PENDING_REVIEW', proposed: {}, submittedNote: null, reviewNotes: null, reviewedAt: null, appliedAt: null, createdAt: '2026-08-01T00:00:00.000Z' }],
    })
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Profile' }))
    expect(await screen.findByRole('button', { name: 'A change is awaiting review' })).toBeDisabled()
  })
})

describe('security', () => {
  it('shows the recovery codes once, with a warning', async () => {
    api.mfaEnroll.mockResolvedValue({ secret: 'BASE32SECRET', otpauthUri: 'otpauth://totp/x' })
    api.mfaConfirm.mockResolvedValue({ enabled: true, recoveryCodes: ['aaaaa-bbbbb'], note: 'Save these now.' })
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Security' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on two-factor' }))
    fireEvent.change(await screen.findByLabelText('Authentication code'), { target: { value: '123456' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('aaaaa-bbbbb')).toBeInTheDocument()
    expect(screen.getByText(/not shown again/i)).toBeInTheDocument()
  })

  it('requires a code to turn the second factor off', async () => {
    api.mfaStatus.mockResolvedValue({ enabled: true, enrolledAt: '2026-08-01T00:00:00.000Z' })
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Security' }))
    const off = await screen.findByRole('button', { name: 'Turn off two-factor' })
    expect(off).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Authentication code'), { target: { value: '654321' } })
    fireEvent.click(screen.getByRole('button', { name: 'Turn off two-factor' }))
    await waitFor(() => expect(api.mfaDisable).toHaveBeenCalledWith('654321'))
  })
})

describe('documents', () => {
  const GRANTED = {
    opportunities: [], contracts: [{ id: 'c1', contractNumber: 'DEMO-CT-0001', title: 'Demo', agency: null, startDate: null, endDate: null }],
    purchaseOrders: [{ id: 'po1', poNumber: 'DEMO-PO-0001', status: 'APPROVED', ceilingAmount: '180000.00', startDate: null, endDate: null }],
    note: 'Granted engagements only.',
  }

  it('offers only granted engagements to upload against', async () => {
    api.engagements.mockResolvedValue(GRANTED)
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }))
    const select = await screen.findByLabelText('Engagement')
    expect(select).toHaveTextContent('Contract · DEMO-CT-0001')
    expect(select).toHaveTextContent('Subcontract · DEMO-PO-0001')
  })

  it('says there is nothing to upload against when no engagement was granted', async () => {
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }))
    expect(await screen.findByText(/nothing has been shared with you yet/i)).toBeInTheDocument()
  })

  it('sends the scope split into type and id, then reloads the list', async () => {
    api.engagements.mockResolvedValue(GRANTED)
    api.uploadDocument.mockResolvedValue({ id: 'd1' })
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }))
    fireEvent.change(await screen.findByLabelText('Engagement'), { target: { value: 'PURCHASE_ORDER:po1' } })
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Certificate of Insurance' } })

    const file = new File(['x'], 'coi.pdf', { type: 'application/pdf' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))

    await waitFor(() => expect(api.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: 'PURCHASE_ORDER', scopeId: 'po1', title: 'Certificate of Insurance' }),
      file,
    ))
    await waitFor(() => expect(api.documents).toHaveBeenCalledTimes(2))
  })

  it('refuses to upload without a file rather than sending an empty request', async () => {
    api.engagements.mockResolvedValue(GRANTED)
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }))
    fireEvent.change(await screen.findByLabelText('Title'), { target: { value: 'No file' } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    expect(await screen.findByText('Choose a file to upload.')).toBeInTheDocument()
    expect(api.uploadDocument).not.toHaveBeenCalled()
  })

  it('describes an upload as pending the primes review', async () => {
    api.engagements.mockResolvedValue(GRANTED)
    render(<PartnerPortalPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Documents' }))
    expect(await screen.findByText(/stays pending until someone there accepts it/i)).toBeInTheDocument()
  })
})
