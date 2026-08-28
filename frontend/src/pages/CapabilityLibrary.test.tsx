// =============================================================
// §8.3 — Capability library.
//
// The one distinction worth testing hardest: a DRAFT is not quotable and an
// APPROVED version is. Everything on screen has to keep those apart, including
// when a narrative has drafts but no approved version at all.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

let role = 'ADMIN'
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role } }) }))

const library = vi.fn()
const createNarrative = vi.fn()
const addVersion = vi.fn()
const approveVersion = vi.fn()
const archiveNarrative = vi.fn()
vi.mock('../services/proposalAgentApi', async () => {
  const actual = await vi.importActual<typeof import('../services/proposalAgentApi')>('../services/proposalAgentApi')
  return {
    ...actual,
    proposalAgentApi: {
      library: (...a: unknown[]) => library(...a),
      createNarrative: (...a: unknown[]) => createNarrative(...a),
      addVersion: (...a: unknown[]) => addVersion(...a),
      approveVersion: (...a: unknown[]) => approveVersion(...a),
      archiveNarrative: (...a: unknown[]) => archiveNarrative(...a),
    },
  }
})

import CapabilityLibrary from './CapabilityLibrary'

const DRAFT_V = {
  id: 'v2', versionNumber: 2, content: 'Newer wording awaiting review.', contentHash: 'bbbb2222cccc3333',
  status: 'DRAFT' as const, sourceReferences: [], approvedByUserId: null, approvedAt: null, createdAt: '2026-08-01T00:00:00.000Z',
}
const APPROVED_V = {
  id: 'v1', versionNumber: 1, content: 'The wording the firm stands behind.', contentHash: 'aaaa1111bbbb2222',
  status: 'APPROVED' as const, sourceReferences: ['CPARS 2025'], approvedByUserId: 'u1',
  approvedAt: '2026-06-01T00:00:00.000Z', createdAt: '2026-05-01T00:00:00.000Z',
}
const NARRATIVE = {
  id: 'n1', title: 'Zero-trust migration approach', category: 'TECHNICAL_NARRATIVE', status: 'ACTIVE',
  capabilityKeys: ['zero trust'], naicsCodes: ['541512'], agencyTags: ['DOE'], tags: [],
  currentApprovedVersionId: 'v1', createdByUserId: 'u1', updatedAt: '2026-08-01T00:00:00.000Z',
  versions: [DRAFT_V, APPROVED_V],
}

beforeEach(() => {
  vi.clearAllMocks()
  role = 'ADMIN'
  library.mockResolvedValue({ narratives: [NARRATIVE] })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('CapabilityLibrary', () => {
  it('shows which version is approved', async () => {
    render(<CapabilityLibrary />)
    expect(await screen.findByText('APPROVED v1')).toBeInTheDocument()
  })

  it('calls out a narrative with no approved wording', async () => {
    library.mockResolvedValue({ narratives: [{ ...NARRATIVE, currentApprovedVersionId: null, versions: [DRAFT_V] }] })
    render(<CapabilityLibrary />)
    expect(await screen.findByText('NOT YET APPROVED')).toBeInTheDocument()
    expect(screen.getByText(/nothing here may be quoted as a firm claim/i)).toBeInTheDocument()
  })

  it('offers approval only on a draft, never on an already-approved version', async () => {
    render(<CapabilityLibrary />)
    fireEvent.click(await screen.findByRole('button', { name: /Zero-trust migration approach/ }))
    await screen.findByText('The wording the firm stands behind.')
    expect(screen.getAllByRole('button', { name: /Approve/ })).toHaveLength(1)
  })

  it('approves a draft version', async () => {
    approveVersion.mockResolvedValue({})
    render(<CapabilityLibrary />)
    fireEvent.click(await screen.findByRole('button', { name: /Zero-trust migration approach/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Approve/ }))
    await waitFor(() => expect(approveVersion).toHaveBeenCalledWith('v2'))
  })

  it('saves new wording as a draft and says so', async () => {
    addVersion.mockResolvedValue({})
    render(<CapabilityLibrary />)
    fireEvent.click(await screen.findByRole('button', { name: 'New version' }))
    fireEvent.change(screen.getByLabelText('Version content'), { target: { value: 'Fresh wording.' } })
    fireEvent.change(screen.getByLabelText('Source references'), { target: { value: 'ISO 27001, CPARS 2026' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }))
    await waitFor(() => expect(addVersion).toHaveBeenCalledWith('n1', {
      content: 'Fresh wording.', sourceReferences: ['ISO 27001', 'CPARS 2026'],
    }))
  })

  it('says saving never approves', async () => {
    render(<CapabilityLibrary />)
    fireEvent.click(await screen.findByRole('button', { name: 'New version' }))
    expect(await screen.findByText(/Saving never approves/i)).toBeInTheDocument()
  })

  it('creates a narrative with its retrieval tags', async () => {
    createNarrative.mockResolvedValue({})
    render(<CapabilityLibrary />)
    fireEvent.click(await screen.findByRole('button', { name: /New narrative/ }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Incident response' } })
    fireEvent.change(screen.getByLabelText('NAICS codes'), { target: { value: '541512, 541519' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create narrative' }))
    await waitFor(() => expect(createNarrative).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Incident response', naicsCodes: ['541512', '541519'] }),
    ))
  })

  it('says a superseded version stays readable', async () => {
    render(<CapabilityLibrary />)
    expect(await screen.findByText(/supersedes the previous one rather than deleting it/i)).toBeInTheDocument()
  })

  it('gives a non-admin no way to create, version or approve', async () => {
    role = 'CONSULTANT'
    render(<CapabilityLibrary />)
    await screen.findByText('APPROVED v1')
    expect(screen.queryByRole('button', { name: /New narrative/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New version' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()
  })

  it('explains an empty library rather than showing a blank page', async () => {
    library.mockResolvedValue({ narratives: [] })
    render(<CapabilityLibrary />)
    expect(await screen.findByText(/The capability library is empty/i)).toBeInTheDocument()
  })
})
