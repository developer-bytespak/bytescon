// Sign-up: choosing a consulting firm or a contractor account, and sending
// that choice to register-firm.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const registerFirm = vi.fn()
vi.mock('../services/api', () => ({
  authApi: {
    legalCurrent: () => Promise.resolve({ data: { tos: { version: 'v1', title: 'Terms', body: 'Terms body' } } }),
    registerFirm: (body: unknown) => registerFirm(body),
  },
}))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

import { RegisterPage } from './Register'

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><RegisterPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

async function fillAndSubmit() {
  const [company, first, last, email] = screen.getAllByRole('textbox')
  fireEvent.change(company, { target: { value: 'ARK Telecom' } })
  fireEvent.change(first, { target: { value: 'Hari' } })
  fireEvent.change(last, { target: { value: 'Test' } })
  fireEvent.change(email, { target: { value: 'hari@ark.test' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'Strong-Pass-123!' } })
  fireEvent.click(screen.getByRole('checkbox'))
  // The terms load asynchronously; submit once they have arrived.
  await waitFor(() => {
    fireEvent.click(screen.getByRole('button', { name: /Create (Consulting Firm|Company) Account/ }))
    expect(registerFirm).toHaveBeenCalled()
  })
}

beforeEach(() => {
  registerFirm.mockReset()
  registerFirm.mockResolvedValue({ data: { email: 'hari@ark.test' } })
})

describe('RegisterPage account type', () => {
  it('defaults to a consulting firm', async () => {
    renderPage()
    expect(screen.getByRole('radio', { name: /Consulting firm/ })).toBeChecked()
    expect(screen.getByText('Consulting Firm Name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Consulting Firm Account →' })).toBeInTheDocument()
    await fillAndSubmit()
    await waitFor(() => expect(registerFirm).toHaveBeenCalled())
    expect(registerFirm.mock.calls[0][0]).toMatchObject({ accountType: 'CONSULTING', firmName: 'ARK Telecom' })
  })

  it('sends CONTRACTOR and relabels the name field when Contractor is chosen', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('radio', { name: /Contractor/ }))
    expect(screen.getByText('Company Name')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create Company Account →' })).toBeInTheDocument()
    await fillAndSubmit()
    await waitFor(() => expect(registerFirm).toHaveBeenCalled())
    expect(registerFirm.mock.calls[0][0]).toMatchObject({ accountType: 'CONTRACTOR' })
  })

  it('shows and hides the password', () => {
    renderPage()
    const field = screen.getByLabelText('Password') as HTMLInputElement
    expect(field.type).toBe('password')
    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(field.type).toBe('text')
    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(field.type).toBe('password')
  })
})
