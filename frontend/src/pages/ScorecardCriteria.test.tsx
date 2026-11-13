// Bid Decisions → Scorecard criteria: admins change weights (total must be
// 100), what's required and what's in use; others only read.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let role = 'ADMIN'
const getConfig = vi.fn()
const saveConfig = vi.fn()
vi.mock('../services/api', () => ({ qualificationApi: { getConfig: () => getConfig(), saveConfig: (c: unknown) => saveConfig(c) } }))
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1', role } }) }))
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

import { ScorecardCriteriaPage } from './ScorecardCriteria'

const criteria = [
  { key: 'capability_fit', name: 'Capability fit', description: null, weight: 60, required: true, displayOrder: 1, isActive: true },
  { key: 'capacity', name: 'Internal capacity', description: 'People and time to deliver', weight: 40, required: true, displayOrder: 2, isActive: true },
]

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ScorecardCriteriaPage /></QueryClientProvider>)
}

beforeEach(() => {
  role = 'ADMIN'; getConfig.mockReset(); saveConfig.mockReset()
  getConfig.mockResolvedValue({ data: { criteria } })
  saveConfig.mockResolvedValue({ data: { criteria } })
})

describe('Scorecard criteria', () => {
  it('lets an admin change weights, saving only once they total 100', async () => {
    renderPage()
    const capacity = await screen.findByLabelText('Weight for Internal capacity')
    fireEvent.change(capacity, { target: { value: '30' } })
    expect(screen.getByRole('status')).toHaveTextContent('Total of weights in use: 90 / 100 — add 10 to save')
    expect(screen.getByRole('button', { name: /Save criteria/ })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Weight for Capability fit'), { target: { value: '70' } })
    fireEvent.click(screen.getByLabelText('Internal capacity is required'))
    expect(screen.getByRole('button', { name: /Save criteria/ })).not.toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /Save criteria/ }))
    await waitFor(() => expect(saveConfig).toHaveBeenCalled())
    expect(saveConfig.mock.calls[0][0]).toEqual([
      expect.objectContaining({ key: 'capability_fit', weight: 70, required: true, isActive: true }),
      expect.objectContaining({ key: 'capacity', weight: 30, required: false, isActive: true }),
    ])
  })

  it('leaves a criterion out of the total when it is not in use', async () => {
    renderPage()
    fireEvent.click(await screen.findByLabelText('Internal capacity is in use'))
    expect(screen.getByRole('status')).toHaveTextContent('Total of weights in use: 60 / 100')
  })

  it('is read-only for anyone but an admin', async () => {
    role = 'CONSULTANT'
    renderPage()
    expect(await screen.findByText('Internal capacity')).toBeInTheDocument()
    expect(screen.queryByLabelText('Weight for Internal capacity')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Save criteria/ })).not.toBeInTheDocument()
    expect(screen.getByText('Only administrators can change these.')).toBeInTheDocument()
  })
})
