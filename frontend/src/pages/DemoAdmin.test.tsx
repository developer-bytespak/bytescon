// Demo Admin: an operator can change an account's business type, extend
// a live demo or reopen an ended one by a chosen number of days, and delete one.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const list = vi.fn()
const setBusinessType = vi.fn()
const extend = vi.fn()
const remove = vi.fn()
vi.mock('../demo/demoApi', () => ({
  demoApi: {
    list: () => list(),
    setBusinessType: (...a: unknown[]) => setBusinessType(...a),
    extend: (...a: unknown[]) => extend(...a),
    remove: (...a: unknown[]) => remove(...a),
    end: vi.fn(), setAccountType: vi.fn(), resetPassword: vi.fn(), create: vi.fn(),
  },
}))

import DemoAdminPage from './DemoAdmin'

const account = (over: Record<string, unknown>) => ({
  firmId: 'f1', companyName: 'Acme Federal', businessType: 'Health Care', businessTypeKey: 'health', accountType: 'CONSULTING',
  contactName: 'Pat Lee', email: 'pat@example.com', createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', expired: false, ...over,
})

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><DemoAdminPage /></QueryClientProvider>)
}

beforeEach(() => {
  list.mockReset(); setBusinessType.mockReset(); extend.mockReset(); remove.mockReset()
  list.mockResolvedValue({
    accounts: [account({}), account({ firmId: 'f2', companyName: 'Old Co', businessTypeKey: 'construction', businessType: 'Construction', expired: true })],
    defaultDays: 14, states: [],
    businessTypes: [{ key: 'health', label: 'Health Care' }, { key: 'construction', label: 'Construction' }, { key: 'it', label: 'IT Services' }],
  })
})

describe('Demo Admin — changing an account', () => {
  it('changes the business type from the row', async () => {
    setBusinessType.mockResolvedValue({ businessType: { key: 'it', label: 'IT Services' } })
    renderPage()
    const select = await screen.findByLabelText('Business type for Acme Federal')
    expect(select).toHaveValue('health')
    fireEvent.change(select, { target: { value: 'it' } })
    await waitFor(() => expect(setBusinessType).toHaveBeenCalledWith('f1', 'it'))
    expect(await screen.findByText(/Business type set to IT Services/)).toBeInTheDocument()
  })

  it('extends a live demo by the chosen number of days', async () => {
    extend.mockResolvedValue({ expiresAt: '2027-01-18T00:00:00Z' })
    renderPage()
    fireEvent.change(await screen.findByLabelText('Days to extend Acme Federal by'), { target: { value: '60' } })
    fireEvent.click(screen.getByRole('button', { name: 'Extend' }))
    await waitFor(() => expect(extend).toHaveBeenCalledWith('f1', 60))
    expect(await screen.findByText(/Demo extended/)).toBeInTheDocument()
  })

  it('offers Reopen on an ended demo', async () => {
    extend.mockResolvedValue({ expiresAt: '2026-12-03T00:00:00Z' })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect(extend).toHaveBeenCalledWith('f2', 14))
    expect(await screen.findByText(/Demo reopened/)).toBeInTheDocument()
  })

  it('deletes an account only after a second click, and can be cancelled', async () => {
    remove.mockResolvedValue({})
    renderPage()
    const deletes = await screen.findAllByRole('button', { name: 'Delete' })
    fireEvent.click(deletes[0])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(remove).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0])
    expect(screen.getByText(/Delete Acme Federal and all its work for good\?/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }))
    await waitFor(() => expect(remove).toHaveBeenCalledWith('f1'))
    expect(await screen.findByText(/Acme Federal deleted/)).toBeInTheDocument()
  })
})
