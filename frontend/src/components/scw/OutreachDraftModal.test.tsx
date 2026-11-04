import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OutreachDraftModal } from './OutreachDraftModal'
import { scwApi, type ScwLikelyPrime, type ScwOutreachDraft } from '../../services/api'

vi.mock('../../services/api', () => ({
  scwApi: { listOutreachDrafts: vi.fn(), approveOutreachDraft: vi.fn(), generateOutreachDraft: vi.fn(), draftOutreach: vi.fn() },
}))

const prime = { primeName: 'Prime Co', primeUei: 'U1' } as unknown as ScwLikelyPrime
const draft = (over: Partial<ScwOutreachDraft>): ScwOutreachDraft => ({
  id: 'd1', opportunityId: 'o1', primeUei: 'U1', primeName: 'Prime Co', outreachType: 'cold_first_touch',
  subject: 'Earlier subject', body: 'Earlier body', salutation: 'Hi', closing: 'Thanks', factsCited: [],
  reviewChecklist: ['Check one', 'Check two'], requiresHumanReview: true, humanApprovedAt: null,
  createdAt: '2026-11-01T00:00:00Z', ...over,
})

beforeEach(() => vi.clearAllMocks())

describe('OutreachDraftModal', () => {
  it('lists earlier drafts for this prime only, and reopens one', async () => {
    vi.mocked(scwApi.listOutreachDrafts).mockResolvedValue({
      success: true,
      data: [draft({}), draft({ id: 'd2', primeName: 'Another Prime', subject: 'Not this one' })],
    })
    render(<OutreachDraftModal opportunityId="o1" prime={prime} onClose={() => undefined} />)

    const row = await screen.findByText('Earlier subject')
    expect(screen.queryByText('Not this one')).toBeNull()
    fireEvent.click(row)
    expect(await screen.findByText(/Earlier body/)).toBeTruthy()
  })

  it('sends the confirmed checklist when approving', async () => {
    vi.mocked(scwApi.listOutreachDrafts).mockResolvedValue({ success: true, data: [draft({})] })
    vi.mocked(scwApi.approveOutreachDraft).mockResolvedValue({ success: true, data: draft({}) })
    render(<OutreachDraftModal opportunityId="o1" prime={prime} onClose={() => undefined} />)
    fireEvent.click(await screen.findByText('Earlier subject'))

    fireEvent.click(await screen.findByText('Check one'))
    fireEvent.click(screen.getByText('Check two'))
    fireEvent.click(screen.getByRole('button', { name: /Approve draft/ }))

    await waitFor(() => expect(scwApi.approveOutreachDraft).toHaveBeenCalledWith('d1', ['Check one', 'Check two']))
  })
})
