// My Company: a contractor's own profile — status, and every field (including
// the registration details) edited and saved from this page.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const myCompany = vi.fn()
const saveMyCompany = vi.fn()
const uploadLogo = vi.fn()
const listProjects = vi.fn()
const createProject = vi.fn()
const toast = vi.fn()
vi.mock('../services/api', () => ({
  profileApi: {
    myCompany: () => myCompany(),
    saveMyCompany: (b: unknown) => saveMyCompany(b),
    uploadMyCompanyLogo: (f: File) => uploadLogo(f),
    removeMyCompanyLogo: vi.fn(),
  },
  pastPerformanceApi: { list: () => listProjects(), create: (b: unknown) => createProject(b) },
}))
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
    { key: 'uei', label: 'UEI (SAM.gov Unique Entity ID)', where: 'PROFILE' },
    { key: 'capabilityKeywords', label: 'Capability keywords', where: 'PROFILE' },
  ],
}

const REGISTRATION = {
  uei: null, cageCode: null, naicsCodes: ['238210'], samStatus: 'ACTIVE', samExpiryDate: null, setAsideCerts: ['SDVOSB'],
}

// The section's "Add project" opener and the new-project form's submit share a name; the submit is last.
const lastAddButton = () => { const all = screen.getAllByRole('button', { name: 'Add project' }); return all[all.length - 1] }

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter><MyCompanyPage /></MemoryRouter></QueryClientProvider>)
}

beforeEach(() => {
  myCompany.mockReset(); saveMyCompany.mockReset(); toast.mockReset()
  uploadLogo.mockReset(); listProjects.mockReset(); createProject.mockReset()
  listProjects.mockResolvedValue({ data: [] })
  myCompany.mockResolvedValue({ company: COMPANY, registration: REGISTRATION, status: STATUS })
})

describe('MyCompanyPage', () => {
  it('shows how complete the profile is and what is still needed', async () => {
    renderPage()
    expect(await screen.findByText(/Profile 30% complete — 3 required items missing/)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Company name/)).toHaveValue('ARK Telecom')
    expect(screen.getByLabelText(/^NAICS codes/)).toHaveValue('238210')
    expect(screen.getByLabelText(/^SAM.gov status/)).toHaveValue('ACTIVE')
    expect(screen.getByRole('button', { name: 'SDVOSB' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('link', { name: 'Registration & Compliance' })).toHaveAttribute('href', '/registration')
  })

  it('saves the registration details from this page too', async () => {
    saveMyCompany.mockResolvedValue({ company: COMPANY, registration: REGISTRATION, status: STATUS })
    renderPage()
    await screen.findByText(/Profile 30% complete/)
    fireEvent.change(screen.getByLabelText(/^UEI/), { target: { value: 'J7M9HPTGJ1S8' } })
    fireEvent.change(screen.getByLabelText(/^CAGE code/), { target: { value: '9ARK1' } })
    fireEvent.change(screen.getByLabelText(/^NAICS codes/), { target: { value: '238210, 237130' } })
    fireEvent.change(screen.getByLabelText(/^SAM.gov expiry date/), { target: { value: '2027-09-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'SDVOSB' }))
    fireEvent.click(screen.getByRole('button', { name: 'HUBZone' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(saveMyCompany).toHaveBeenCalled())
    expect(saveMyCompany.mock.calls[0][0]).toMatchObject({
      name: 'ARK Telecom', uei: 'J7M9HPTGJ1S8', cageCode: '9ARK1', naicsCodes: ['238210', '237130'],
      samStatus: 'ACTIVE', samExpiryDate: '2027-09-01T00:00:00.000Z', setAsideCerts: ['HUBZONE'],
    })
  })

  it('saves the editable fields, turning lists and numbers into their types', async () => {
    saveMyCompany.mockResolvedValue({ company: { ...COMPANY, state: 'TX' }, registration: REGISTRATION, status: { ...STATUS, complete: true, percent: 70, missing: [] } })
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

  it('shows a complete profile as complete, with the optional extras listed separately', async () => {
    myCompany.mockResolvedValue({
      company: COMPANY, registration: REGISTRATION,
      status: { ...STATUS, complete: true, percent: 100, missing: [], optional: { filled: 2, total: 14, missing: ['Phone', 'Logo'], improving: [{ label: 'Logo', improves: 'proposal PDFs' }] } },
    })
    renderPage()
    expect(await screen.findByText('Profile complete — scores, bid decisions and proposals are on')).toBeInTheDocument()
    expect(screen.getByText('To improve your results, you can also add: Logo (proposal PDFs).')).toBeInTheDocument()
  })

  it('shows what is wrong under each field and refuses to save until fixed', async () => {
    renderPage()
    await screen.findByText(/Profile 30% complete/)
    const uei = screen.getByLabelText(/^UEI/)
    fireEvent.change(uei, { target: { value: 'j7m9hptg' } })
    expect(uei).toHaveValue('J7M9HPTG')
    expect(screen.queryByText(/UEI must be exactly 12/)).not.toBeInTheDocument() // not until the field is left
    fireEvent.blur(uei)
    expect(screen.getByText('UEI must be exactly 12 characters (you have 8)')).toBeInTheDocument()
    expect(uei).toHaveAttribute('aria-invalid', 'true')

    fireEvent.change(screen.getByLabelText(/^Average annual revenue/), { target: { value: 'lots' } })
    fireEvent.change(screen.getByLabelText(/^ZIP code/), { target: { value: '787' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    expect(saveMyCompany).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith('Fix the 3 highlighted fields before saving', 'error')
    expect(screen.getByText(/Average annual revenue must be an amount in dollars/)).toBeInTheDocument()
    expect(screen.getByText(/ZIP code must be 5 digits/)).toBeInTheDocument()

    fireEvent.change(uei, { target: { value: 'J7M9HPTGJ1S8' } })
    expect(screen.queryByText(/UEI must be exactly 12/)).not.toBeInTheDocument()
  })

  it('adds a past-performance project from this page', async () => {
    createProject.mockResolvedValue({ data: { id: 'pp-1' } })
    renderPage()
    await screen.findByText('No projects yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Add project' }))
    // Required fields are checked first.
    fireEvent.click(lastAddButton())
    expect(screen.getByText('Contract number is required')).toBeInTheDocument()
    expect(createProject).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/^Contract number/), { target: { value: 'W91-23-C-0042' } })
    fireEvent.change(screen.getByLabelText(/^Customer/), { target: { value: 'Army Corps' } })
    fireEvent.change(screen.getByLabelText(/^Contract value/), { target: { value: '$1,250,000' } })
    fireEvent.change(screen.getByLabelText(/^Start date/), { target: { value: '2024-01-01' } })
    fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: '2023-01-01' } })
    fireEvent.click(lastAddButton())
    expect(screen.getByText('The end date must be after the start date')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^End date/), { target: { value: '2025-06-30' } })
    fireEvent.click(lastAddButton())
    await waitFor(() => expect(createProject).toHaveBeenCalled())
    expect(createProject.mock.calls[0][0]).toMatchObject({
      clientCompanyId: 'self-1', contractNumber: 'W91-23-C-0042', customerName: 'Army Corps', totalValue: 1_250_000,
      periodOfPerformanceStart: '2024-01-01T00:00:00.000Z', periodOfPerformanceEnd: '2025-06-30T00:00:00.000Z',
    })
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Project added', 'success'))
  })

  it('uploads a logo, refusing files that are not images or too big', async () => {
    uploadLogo.mockResolvedValue({ logoUrl: '/uploads/branding/x.png' })
    renderPage()
    await screen.findByText('No logo')
    const input = screen.getByLabelText('Logo file')
    fireEvent.change(input, { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } })
    expect(toast).toHaveBeenCalledWith('The logo must be a PNG, JPEG, SVG or WebP image', 'error')
    const big = new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [big] } })
    expect(toast).toHaveBeenCalledWith('The logo must be 2 MB or smaller (this one is 3.0 MB)', 'error')
    expect(uploadLogo).not.toHaveBeenCalled()
    const logo = new File(['png'], 'logo.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [logo] } })
    await waitFor(() => expect(uploadLogo).toHaveBeenCalledWith(logo))
  })
})
