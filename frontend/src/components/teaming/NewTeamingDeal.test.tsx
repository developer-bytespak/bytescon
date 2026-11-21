// A teaming deal names the company bidding: a consulting firm's client, or a
// contractor's own company, and says plainly who leads the bid.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let contractor = false
const createArrangement = vi.fn()
vi.mock('../../hooks/useAuth', () => ({ useIsContractor: () => contractor }))
vi.mock('../Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../../services/api', () => ({
  clientsApi: { list: () => Promise.resolve({ data: { clients: [{ id: 'c1', name: 'Meridian Federal' }, { id: 'c2', name: 'Beta Systems' }] } }) },
  teamingApi: {
    listPartners: () => Promise.resolve({ data: { partners: [{ id: 'p1', name: 'Acme Subs' }] } }),
    createArrangement: (...a: unknown[]) => createArrangement(...a),
  },
}))
vi.mock('../../services/crmApi', () => ({ searchOpportunityOptions: vi.fn(), getOpportunityOption: vi.fn() }))
// The opportunity search is its own component; here it is a plain input.
vi.mock('../SearchSelect', () => ({ SearchSelect: ({ onChange }: { onChange: (id: string) => void }) => <input aria-label="Opportunity" onChange={(e) => onChange(e.target.value)} /> }))

import { NewTeamingDeal } from './NewTeamingDeal'

const renderIt = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NewTeamingDeal onDone={vi.fn()} /></QueryClientProvider>)

beforeEach(() => { contractor = false; createArrangement.mockReset(); createArrangement.mockResolvedValue({ data: {} }) })

describe('NewTeamingDeal', () => {
  it('needs the client for a consulting firm, and says who leads in their names', async () => {
    renderIt()
    fireEvent.change(screen.getByLabelText('Opportunity'), { target: { value: 'o1' } })
    await screen.findByRole('option', { name: 'Acme Subs' })
    fireEvent.change(screen.getByLabelText('Partner'), { target: { value: 'p1' } })
    const add = screen.getByRole('button', { name: 'Add teaming deal' })
    expect(add).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Client bidding with this partner'), { target: { value: 'c2' } })
    expect(screen.getByLabelText('Beta Systems is the prime; Acme Subs is a subcontractor')).toBeChecked()
    fireEvent.click(screen.getByLabelText('Acme Subs is the prime; Beta Systems is a subcontractor'))
    fireEvent.click(add)
    await waitFor(() => expect(createArrangement).toHaveBeenCalledWith({ opportunityId: 'o1', partnerId: 'p1', role: 'PRIME', arrangementType: 'SUBCONTRACT', clientCompanyId: 'c2' }))
  })

  it('a contractor bids as its own company', async () => {
    contractor = true
    renderIt()
    expect(screen.getByText('Your company (from My profile)')).toBeInTheDocument()
    expect(screen.queryByLabelText('Client bidding with this partner')).not.toBeInTheDocument()
  })
})
