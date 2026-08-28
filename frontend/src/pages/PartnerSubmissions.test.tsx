// =============================================================
// §8.3 — Partner submissions review queues.
//
// The assertions that matter are the ones about consequence: an already-decided
// row offers no second decision, accepting a deliverable response is described
// as the PRIME accepting it rather than the deliverable being done, and the
// profile queue shows what would actually be written before it is written.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

const listUploads = vi.fn()
const reviewUpload = vi.fn()
const downloadUpload = vi.fn()
const listDeliverableSubmissions = vi.fn()
const reviewDeliverableSubmission = vi.fn()
const downloadDeliverableSubmission = vi.fn()
const listProfileChanges = vi.fn()
const reviewProfileChange = vi.fn()

vi.mock('../services/crmApi', () => ({
  partnerSubmissionsApi: {
    listUploads: () => listUploads(),
    reviewUpload: (...a: unknown[]) => reviewUpload(...a),
    downloadUpload: (...a: unknown[]) => downloadUpload(...a),
    listDeliverableSubmissions: () => listDeliverableSubmissions(),
    reviewDeliverableSubmission: (...a: unknown[]) => reviewDeliverableSubmission(...a),
    downloadDeliverableSubmission: (...a: unknown[]) => downloadDeliverableSubmission(...a),
    listProfileChanges: () => listProfileChanges(),
    reviewProfileChange: (...a: unknown[]) => reviewProfileChange(...a),
  },
}))

import PartnerSubmissions from './PartnerSubmissions'

const UPLOAD = {
  id: 'up1', title: 'Certificate of Insurance', category: 'Insurance certificate',
  fileName: 'coi.pdf', fileSize: 2048, notes: null, scopeType: 'PURCHASE_ORDER', scopeId: 'po1',
  reviewStatus: 'PENDING_REVIEW', reviewNotes: null, reviewedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z', partner: { id: 'p1', name: 'Demo Sub LLC' },
}

const SUBMISSION = {
  id: 's1', status: 'SUBMITTED', note: 'August report attached', fileName: 'soc.pdf', fileSize: 1024,
  submittedAt: '2026-08-10T00:00:00.000Z', reviewedAt: null, reviewNotes: null, createdAt: '2026-08-10T00:00:00.000Z',
  partner: { id: 'p1', name: 'Demo Sub LLC' },
  deliverable: { id: 'd1', name: 'Monthly SOC report', cdrlNumber: 'A004', dueDate: '2026-08-15T00:00:00.000Z', status: 'IN_PROGRESS', contractId: 'c1' },
}

const CHANGE = {
  id: 'pc1', status: 'PENDING_REVIEW',
  proposed: { contactPhone: '+1-703-555-0199' }, previous: { contactPhone: '+1-703-555-0142' },
  submittedNote: 'New office number', reviewNotes: null, reviewedAt: null, appliedAt: null,
  createdAt: '2026-08-12T00:00:00.000Z', partner: { id: 'p1', name: 'Demo Sub LLC' },
  portalUser: { id: 'u1', email: 'sub@demo.test', firstName: 'Alicia', lastName: 'Reyes' },
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><PartnerSubmissions /></MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listUploads.mockResolvedValue([])
  listDeliverableSubmissions.mockResolvedValue([])
  listProfileChanges.mockResolvedValue([])
})

describe('documents queue', () => {
  it('sends the verdict with the note typed alongside it', async () => {
    listUploads.mockResolvedValue([UPLOAD])
    reviewUpload.mockResolvedValue({})
    renderPage()
    await screen.findByText('Certificate of Insurance')
    fireEvent.change(screen.getByPlaceholderText('Note to the partner (optional)'), { target: { value: 'Received.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(reviewUpload).toHaveBeenCalledWith('up1', { status: 'ACCEPTED', reviewNotes: 'Received.' }))
  })

  it('offers no second decision on a row already decided', async () => {
    listUploads.mockResolvedValue([{ ...UPLOAD, reviewStatus: 'ACCEPTED', reviewNotes: 'Received.' }])
    renderPage()
    await screen.findByText('Certificate of Insurance')
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
  })

  it('says accepting does not adopt the file into the library', async () => {
    listUploads.mockResolvedValue([UPLOAD])
    renderPage()
    expect(await screen.findByText(/does not move the file into your document library/i)).toBeInTheDocument()
  })

  it('says nothing has arrived rather than showing an empty table', async () => {
    renderPage()
    expect(await screen.findByText(/no subcontractor has uploaded a document yet/i)).toBeInTheDocument()
  })
})

describe('deliverable responses queue', () => {
  it('maps "request changes" to CHANGES_REQUESTED, not a rejection', async () => {
    listDeliverableSubmissions.mockResolvedValue([SUBMISSION])
    reviewDeliverableSubmission.mockResolvedValue({})
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Deliverable responses/ }))
    await screen.findByText('Monthly SOC report')
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }))
    await waitFor(() => expect(reviewDeliverableSubmission).toHaveBeenCalledWith('s1', { status: 'CHANGES_REQUESTED', reviewNotes: null }))
  })

  it('says acceptance is the prime accepting, not the deliverable being done', async () => {
    listDeliverableSubmissions.mockResolvedValue([SUBMISSION])
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Deliverable responses/ }))
    expect(await screen.findByText(/does not change the deliverable's own status/i)).toBeInTheDocument()
  })

  it('leaves a draft response alone — it was never submitted', async () => {
    listDeliverableSubmissions.mockResolvedValue([{ ...SUBMISSION, status: 'DRAFT', submittedAt: null }])
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Deliverable responses/ }))
    await screen.findByText('Monthly SOC report')
    expect(screen.queryByRole('button', { name: 'Accept response' })).not.toBeInTheDocument()
  })
})

describe('profile changes queue', () => {
  it('shows the old value and the proposed value before anything is written', async () => {
    listProfileChanges.mockResolvedValue([CHANGE])
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Profile changes/ }))
    await screen.findByText('contactPhone')
    expect(screen.getByText('+1-703-555-0142')).toBeInTheDocument()
    expect(screen.getByText('+1-703-555-0199')).toBeInTheDocument()
  })

  it('reports which fields were actually applied', async () => {
    listProfileChanges.mockResolvedValue([CHANGE])
    reviewProfileChange.mockResolvedValue({ appliedFields: ['contactPhone'] })
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Profile changes/ }))
    await screen.findByText('contactPhone')
    fireEvent.click(screen.getByRole('button', { name: 'Approve and apply' }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Applied: contactPhone', 'success'))
  })

  it('says CRM notes and relationship score are never reachable this way', async () => {
    listProfileChanges.mockResolvedValue([CHANGE])
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: /Profile changes/ }))
    expect(await screen.findByText(/notes and relationship score are never/i)).toBeInTheDocument()
  })
})
