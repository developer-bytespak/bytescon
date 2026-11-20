// A contract held as a subcontractor says so, names the prime, and leaves out
// purchasing (orders to subcontractors are the prime's to place).
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'

let contract: Record<string, unknown> = {}
vi.mock('../services/api', () => ({
  contractMgmtApi: { get: () => Promise.resolve({ data: contract }) },
  teamingApi: { listPartners: () => Promise.resolve({ data: { partners: [] } }) },
}))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'ADMIN' } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))
vi.mock('../components/contracts/ContractHealthPanels', () => ({ ContractHealthPanel: () => null }))
vi.mock('../components/erp/ContractErpTabs', () => ({
  ContractBudgetTab: () => null, ContractFinancialsTab: () => null, ContractPurchasingTab: () => null, ContractResourcesTab: () => null,
}))

import ContractDetail from './ContractDetail'

const base = { id: 'k1', contractNumber: 'W91-001', title: 'Radar support', agency: 'Army', status: 'ACTIVE', clins: [], modifications: [], optionPeriods: [], deliverables: [], activity: [], isArchived: false }
const renderIt = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={['/contracts/k1']}><Routes><Route path="/contracts/:id" element={<ContractDetail />} /></Routes></MemoryRouter>
  </QueryClientProvider>,
)

describe('ContractDetail: prime or sub', () => {
  it('a subcontract names the prime and has no Purchasing tab', async () => {
    contract = { ...base, ourRole: 'SUB', primePartnerId: 'p1', primePartner: { id: 'p1', name: 'Big Prime Inc' } }
    renderIt()
    expect(await screen.findByText('Subcontract · work under Big Prime Inc')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Purchasing' })).not.toBeInTheDocument()
  })

  it('a prime contract keeps Purchasing', async () => {
    contract = { ...base, ourRole: 'PRIME', primePartnerId: null }
    renderIt()
    expect(await screen.findByText('Prime contract')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Purchasing' })).toBeInTheDocument()
  })
})
