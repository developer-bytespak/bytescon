// My Company: a contractor's own profile — status, registration fields shown
// read-only, and the editable fields saved.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const myCompany = vi.fn()
const saveMyCompany = vi.fn()
const toast = vi.fn()
vi.mock('../services/api', () => ({ profileApi: { myCompany: () => myCompany(), saveMyCompany: (b: unknown) => saveMyCompany(b) } }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

import { MyCompanyPage } from './MyCompany'

const COMPANY = {
  name: 'ARK Telecom', uei: null, cage: null, naicsCodes: ['238210'], samRegStatus: 'Active',
  sdvosb: true, wosb: false, hubzone: false, eightA: false,
  streetAddress: null, city: null, state: null, zipCode: null, phone: null, website: null,
  capabilityKeywords: [], pscCodes: [], contractVehicles: [], employeeCount: null, annualRevenue: null,
  securityClearances: [], isoCertifications: [],
}
const STATUS = {
  clientCompanyId: 'self-1', name: 'ARK Telecom', isSelf: true, complete: false, percent: 30,
  missing: [
    { key: 'state', label: 'State (address)', where: 'PROFILE' },
    { key: 'uei', label: 'UEI (SAM.gov Unique Entity ID)', where: 'REGISTRATION' },
    { key: 'capabilityKeywords', label: 'Capability keywords', where: 'PROFILE' },
  ],
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><MyCompanyPage /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  myCompany.mockReset(); saveMyCompany.mockReset(); toast.mockReset()
  myCompany.mockResolvedValue({ company: COMPANY, status: STATUS })
})

describe('MyCompanyPage', () => {
  it('shows how complete the profile is and what is still needed', async () => {
    renderPage()
    expect(await screen.findByText(/Profile 30% complete — 3 required items missing/)).toBeInTheDocument()
    expect(screen.getByText('ARK Telecom')).toBeInTheDocument()
    expect(screen.getByText('238210')).toBeInTheDocument()
    expect(screen.getByText('SDVOSB')).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /Add it in Registration & Compliance/ })[0]).toHaveAttribute('href', '/registration')
  })

  it('saves the editable fields, turning lists and numbers into their types', async () => {
    saveMyCompany.mockResolvedValue({ company: { ...COMPANY, state: 'TX' }, status: { ...STATUS, complete: true, percent: 70, missing: [] } })
    renderPage()
    await screen.findByText(/Profile 30% complete/)
    fireEvent.change(screen.getByLabelText(/^State/), { target: { value: 'TX' } })
    fireEvent.change(screen.getByLabelText(/^Capability keywords/), { target: { value: 'fiber, structured cabling ,' } })
    fireEvent.change(screen.getByLabelText(/^Employee count/), { target: { value: '14' } })
    fireEvent.change(screen.getByLabelText(/^Average annual revenue/), { target: { value: '$4,500,000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(saveMyCompany).toHaveBeenCalled())
    expect(saveMyCompany.mock.calls[0][0]).toMatchObject({
      state: 'TX', capabilityKeywords: ['fiber', 'structured cabling'], employeeCount: 14, annualRevenue: 4_500_000, city: null,
    })
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Profile complete. Scores and proposals are on.', 'success'))
  })

  it('refuses a revenue that is not a number', async () => {
    renderPage()
    await screen.findByText(/Profile 30% complete/)
    fireEvent.change(screen.getByLabelText(/^Average annual revenue/), { target: { value: 'lots' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(saveMyCompany).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Employee count and annual revenue must be numbers', 'error')
  })
})
