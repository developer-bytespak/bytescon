// =============================================================
// §8.3 — Standing document library, version history.
//
// The page always claimed that "uploading a new version resets approval", but
// nothing on screen could record one. These cover the claim being true AND
// reachable: a superseded version stays listed, and recording one says out
// loud that approval has gone.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))
vi.mock('../components/section7/ComplianceAgentPanels', () => ({
  ComplianceLibraryPanel: () => null,
}))

const listDocuments = vi.fn()
const documentVersions = vi.fn()
const documentUsage = vi.fn()
const createDocumentVersion = vi.fn()
const approveDocument = vi.fn()
const syncDocuments = vi.fn()
const validationCatalogue = vi.fn()
vi.mock('../services/section6Api', async () => {
  const actual = await vi.importActual<typeof import('../services/section6Api')>('../services/section6Api')
  return {
    ...actual,
    requirementsApi: {
      listDocuments: (...a: unknown[]) => listDocuments(...a),
      documentVersions: (...a: unknown[]) => documentVersions(...a),
      documentUsage: (...a: unknown[]) => documentUsage(...a),
      createDocumentVersion: (...a: unknown[]) => createDocumentVersion(...a),
      approveDocument: (...a: unknown[]) => approveDocument(...a),
      syncDocuments: (...a: unknown[]) => syncDocuments(...a),
      createDocument: vi.fn(),
      validationCatalogue: (...a: unknown[]) => validationCatalogue(...a),
    },
  }
})

import DocumentLibraryPage from './DocumentLibrary'

const DOC = {
  id: 'd1', name: 'Cyber liability insurance certificate', category: 'INSURANCE',
  expiryDate: '2027-03-31T00:00:00.000Z', expiryState: 'VALID', expiryMessage: 'Valid.',
  approvedForReuse: true, verification: 'VERIFIED', usageCount: 2,
  sourceSystem: 'LIBRARY', currentVersionNo: 2,
}

const wrap = () => render(<MemoryRouter><DocumentLibraryPage /></MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  listDocuments.mockResolvedValue({ documents: [DOC], expiryLabels: { VALID: 'Valid' } })
  documentUsage.mockResolvedValue({ links: [{ id: 'l1' }, { id: 'l2' }] })
  validationCatalogue.mockResolvedValue([])
  documentVersions.mockResolvedValue({
    document: { id: 'd1', name: DOC.name, currentVersionNo: 2 },
    versions: [
      { id: 'v2', versionNo: 2, fileName: 'cyber-2027.pdf', fileType: null, fileSize: null, pageCount: null, changeNote: 'Renewed for 2027', isCurrent: true, createdAt: '2026-08-01T00:00:00.000Z', uploadedByUserId: 'u1' },
      { id: 'v1', versionNo: 1, fileName: 'cyber-2026.pdf', fileType: null, fileSize: null, pageCount: null, changeNote: null, isCurrent: false, createdAt: '2025-08-01T00:00:00.000Z', uploadedByUserId: 'u1' },
    ],
  })
})

const openHistory = async () => {
  wrap()
  fireEvent.click(await screen.findByRole('button', { name: /History \(v2\)/ }))
  await waitFor(() => expect(documentVersions).toHaveBeenCalledWith('d1'))
}

describe('DocumentLibrary — version history', () => {
  it('shows the current version count on the row', async () => {
    wrap()
    expect(await screen.findByRole('button', { name: /History \(v2\)/ })).toBeInTheDocument()
  })

  it('loads history only when opened', async () => {
    wrap()
    await screen.findByText('Cyber liability insurance certificate')
    expect(documentVersions).not.toHaveBeenCalled()
  })

  it('keeps a superseded version listed rather than replacing it', async () => {
    await openHistory()
    expect(await screen.findByText('CURRENT')).toBeInTheDocument()
    expect(screen.getByText('SUPERSEDED')).toBeInTheDocument()
    expect(screen.getByText(/cyber-2026\.pdf/)).toBeInTheDocument()
  })

  it('records a new version with what changed', async () => {
    createDocumentVersion.mockResolvedValue({})
    await openHistory()
    fireEvent.change(screen.getByLabelText('New version file name'), { target: { value: 'cyber-2028.pdf' } })
    fireEvent.change(screen.getByLabelText('What changed'), { target: { value: 'Renewed for 2028' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record new version' }))
    await waitFor(() => expect(createDocumentVersion).toHaveBeenCalledWith('d1', {
      fileName: 'cyber-2028.pdf', changeNote: 'Renewed for 2028',
    }))
  })

  it('says recording a version withdraws approval', async () => {
    await openHistory()
    expect(await screen.findByText(/Recording a version withdraws approval/i)).toBeInTheDocument()
  })

  it('warns that a replacement changes what existing references point at', async () => {
    await openHistory()
    expect(await screen.findByText(/changes what those references point at/i)).toBeInTheDocument()
  })

  it('stays usable when usage cannot be read', async () => {
    documentUsage.mockRejectedValue(new Error('nope'))
    await openHistory()
    expect(await screen.findByText('CURRENT')).toBeInTheDocument()
  })
})
