// A subcontractor or prime opened from Subs & Primes: its people, your
// interactions and how strong the relationship is, with a way back to the list.
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { PartnerRelationshipView } from './PartnerRelationshipView'

const getPartnerCrm = vi.fn()
vi.mock('../../services/crmApi', async () => {
  const actual = await vi.importActual<typeof import('../../services/crmApi')>('../../services/crmApi')
  return { ...actual, crmApi: { getPartnerCrm: (...a: unknown[]) => getPartnerCrm(...a), createPartnerContact: vi.fn() } }
})
vi.mock('./PartnerPortalAccess', () => ({ PartnerPortalAccess: () => null }))
vi.mock('../Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

describe('PartnerRelationshipView', () => {
  it('shows the company, its people and its teaming history, and goes back to the list', async () => {
    getPartnerCrm.mockResolvedValue({
      id: 'p1', name: 'Acme Subs LLC', uei: 'UEI123', cage: null, primaryNaicsCodes: [], capabilities: ['Cloud'],
      certifications: [], geography: null, followUps: [], performanceRecords: [], activities: [],
      contacts: [{ id: 'c1', fullName: 'Pat Lee', title: 'BD lead', email: null, isPrimary: true }],
      arrangements: [{ id: 'a1', role: 'SUB', teamingStatus: 'ACTIVE', agreementStatus: 'SIGNED', opportunity: { id: 'o1', title: 'Navy IT support', agency: null } }],
      relationship: { state: 'NO_DATA', score: null, reason: 'No interactions yet.', evidence: [], totalInteractions: 0, meaningfulInteractions: 0, lastInteractionAt: null, daysSinceLastInteraction: null },
    })
    const onBack = vi.fn()
    render(<PartnerRelationshipView partnerId="p1" onBack={onBack} />)
    expect(await screen.findByText('Acme Subs LLC')).toBeInTheDocument()
    expect(getPartnerCrm).toHaveBeenCalledWith('p1')
    expect(screen.getByText('Pat Lee')).toBeInTheDocument()
    expect(screen.getByText('Navy IT support')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Back to your subs & primes/ }))
    expect(onBack).toHaveBeenCalled()
  })
})
