// =============================================================
// §8.3 — Key personnel on a proposal.
//
// The rule under test: only an APPROVED resume version may be cited. The
// picker has to enforce it visibly rather than letting someone pick a draft
// and discover the refusal on save.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../Toast', () => ({ useToast: () => ({ toast }) }))

const listKeyPersonnel = vi.fn()
const addKeyPersonnel = vi.fn()
const removeKeyPersonnel = vi.fn()
const list = vi.fn()
const get = vi.fn()
vi.mock('../../services/knowledgeApi', async () => {
  const actual = await vi.importActual<typeof import('../../services/knowledgeApi')>('../../services/knowledgeApi')
  return {
    ...actual,
    personnelApi: {
      listKeyPersonnel: (...a: unknown[]) => listKeyPersonnel(...a),
      addKeyPersonnel: (...a: unknown[]) => addKeyPersonnel(...a),
      removeKeyPersonnel: (...a: unknown[]) => removeKeyPersonnel(...a),
      list: (...a: unknown[]) => list(...a),
      get: (...a: unknown[]) => get(...a),
    },
  }
})

import { KeyPersonnelPanel } from './KeyPersonnelPanel'

const SELECTION = {
  id: 'k1', proposalRole: 'Program Manager', laborCategory: 'PM-01',
  personnel: { id: 'p1', firstName: 'Alicia', lastName: 'Reyes', jobTitle: 'PM', isArchived: false },
  resume: { id: 'r1', versionNumber: 3, status: 'APPROVED', approvedAt: '2026-06-01T00:00:00.000Z' },
}

beforeEach(() => {
  vi.clearAllMocks()
  listKeyPersonnel.mockResolvedValue({ items: [SELECTION], provenanceNote: 'Each selection keeps a snapshot and a live link.' })
  list.mockResolvedValue([
    { id: 'p1', firstName: 'Alicia', lastName: 'Reyes', jobTitle: 'PM', isArchived: false },
    { id: 'p2', firstName: 'Sam', lastName: 'Okafor', jobTitle: 'Engineer', isArchived: false },
  ])
  get.mockResolvedValue({
    id: 'p2', resumes: [
      { id: 'r9', versionNumber: 2, status: 'DRAFT' },
      { id: 'r8', versionNumber: 1, status: 'APPROVED' },
    ],
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

describe('KeyPersonnelPanel', () => {
  it('shows which resume version was cited', async () => {
    render(<KeyPersonnelPanel proposalId="pr1" canEdit />)
    expect(await screen.findByText('RESUME v3')).toBeInTheDocument()
  })

  it('flags a selection with no resume cited', async () => {
    listKeyPersonnel.mockResolvedValue({ items: [{ ...SELECTION, resume: null }], provenanceNote: '' })
    render(<KeyPersonnelPanel proposalId="pr1" canEdit />)
    expect(await screen.findByText('NO RESUME CITED')).toBeInTheDocument()
  })

  it('offers only APPROVED resume versions, never a draft', async () => {
    render(<KeyPersonnelPanel proposalId="pr1" canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: /Add person/ }))
    fireEvent.change(await screen.findByLabelText('Person'), { target: { value: 'p2' } })
    await waitFor(() => expect(get).toHaveBeenCalledWith('p2'))
    const options = await screen.findAllByRole('option')
    const labels = options.map((o) => o.textContent)
    expect(labels).toContain('v1 — approved')
    expect(labels.some((l) => l?.includes('v2'))).toBe(false)
  })

  it('warns when the chosen person has no approved resume at all', async () => {
    get.mockResolvedValue({ id: 'p2', resumes: [{ id: 'r9', versionNumber: 1, status: 'DRAFT' }] })
    render(<KeyPersonnelPanel proposalId="pr1" canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: /Add person/ }))
    fireEvent.change(await screen.findByLabelText('Person'), { target: { value: 'p2' } })
    expect(await screen.findByText(/no approved resume version/i)).toBeInTheDocument()
  })

  it('adds a person with the version chosen', async () => {
    addKeyPersonnel.mockResolvedValue({})
    render(<KeyPersonnelPanel proposalId="pr1" canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: /Add person/ }))
    fireEvent.change(await screen.findByLabelText('Person'), { target: { value: 'p2' } })
    await waitFor(() => expect(get).toHaveBeenCalled())
    fireEvent.change(screen.getByLabelText('Resume version'), { target: { value: 'r8' } })
    fireEvent.change(screen.getByLabelText('Proposal role'), { target: { value: 'Lead Engineer' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add to proposal' }))
    await waitFor(() => expect(addKeyPersonnel).toHaveBeenCalledWith('pr1', expect.objectContaining({
      personnelId: 'p2', resumeId: 'r8', proposalRole: 'Lead Engineer',
    })))
  })

  it('removes a person from the proposal', async () => {
    removeKeyPersonnel.mockResolvedValue({})
    render(<KeyPersonnelPanel proposalId="pr1" canEdit />)
    fireEvent.click(await screen.findByRole('button', { name: /Remove Alicia Reyes/ }))
    await waitFor(() => expect(removeKeyPersonnel).toHaveBeenCalledWith('k1'))
  })

  it('gives a reader no add or remove control', async () => {
    render(<KeyPersonnelPanel proposalId="pr1" canEdit={false} />)
    await screen.findByText('RESUME v3')
    expect(screen.queryByRole('button', { name: /Add person/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Remove Alicia Reyes/ })).not.toBeInTheDocument()
  })

  it('says nobody is named rather than showing an empty list', async () => {
    listKeyPersonnel.mockResolvedValue({ items: [], provenanceNote: '' })
    render(<KeyPersonnelPanel proposalId="pr1" canEdit />)
    expect(await screen.findByText(/Nobody is named on this proposal yet/i)).toBeInTheDocument()
  })
})
