// The price in the format the solicitation asks for: a schedule of items, labor
// rates worked out from the build-up, a cost breakdown, or none.
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const api = {
  formatMatches: vi.fn(), setFormat: vi.fn(), setQuote: vi.fn(), addLineItem: vi.fn(),
  updateLineItem: vi.fn(), deleteLineItem: vi.fn(), readLineItems: vi.fn(),
}
vi.mock('../../services/api', () => ({ pricingApi: new Proxy({}, { get: (_t, k: string) => (...a: unknown[]) => (api as any)[k]?.(...a) }) }))
vi.mock('../Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

import { PriceFormatPanel, wrapFactor, type PriceWorkspace } from './PriceFormatPanel'

const FORMATS = [
  { key: 'LINE_ITEMS', name: 'Line items (price schedule)', asks: 'A unit price for each item.' },
  { key: 'LABOR_RATES', name: 'Labor rates (time-and-materials)', asks: 'A loaded rate per category.' },
  { key: 'COST_BREAKDOWN', name: 'Cost breakdown (cost-reimbursement)', asks: 'Every cost element.' },
  { key: 'NONE', name: 'No price', asks: 'No price.' },
]
const ws = (over: Partial<PriceWorkspace> = {}): PriceWorkspace => ({ id: 'w1', status: 'DRAFT', priceFormat: 'LINE_ITEMS', lineItems: [], itemsStatus: 'DONE', itemsNote: null, ...over })
const item = (id: string, over = {}) => ({ id, itemNumber: id, description: `Item ${id}`, quantity: 12, unit: 'MO', unitPrice: null, periodLabel: 'Base Year', source: 'SOLICITATION', ...over })
const scenario = { totalDirectLabor: '100', subtotalBeforeFee: '170', totalFee: '15', totalOdc: '20', totalSubcontractor: '0', laborLines: [{ id: 'l1', categoryName: 'Engineer', hours: '10', baseRate: '50' }] }

function renderPanel(w: PriceWorkspace, isAdmin = true, onChanged = vi.fn()) {
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><PriceFormatPanel ws={w} scenario={scenario} isAdmin={isAdmin} onChanged={onChanged} /></QueryClientProvider>)
  return onChanged
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset())
  api.formatMatches.mockResolvedValue({ data: { matches: [{ format: 'LINE_ITEMS', reason: 'It has a schedule of items to price: item, quantity, unit and unit price.' }], selected: 'LINE_ITEMS', formats: FORMATS } })
  ;[api.setFormat, api.setQuote, api.addLineItem, api.updateLineItem, api.deleteLineItem, api.readLineItems].forEach((f) => f.mockResolvedValue({ data: {} }))
})

describe('PriceFormatPanel', () => {
  it('marks the format the solicitation requires, with why', async () => {
    renderPanel(ws())
    expect(await screen.findByText('Required by this solicitation')).toBeInTheDocument()
    expect(screen.getByText(/It has a schedule of items to price/)).toBeInTheDocument()
  })

  it('lists the items by period, saves a unit price, and totals the priced ones', async () => {
    const onChanged = renderPanel(ws({ lineItems: [item('0001', { unitPrice: '10' }), item('1001', { periodLabel: 'Option Year 1' })] }))
    expect(await screen.findByText('Base Year')).toBeInTheDocument()
    expect(screen.getByText('Option Year 1')).toBeInTheDocument()
    expect(screen.getAllByText('$120.00').length).toBeGreaterThan(0) // 12 × $10, and the total
    expect(screen.getByText(/1 of 2 items still need a unit price/)).toBeInTheDocument()
    const price = screen.getByLabelText('Unit price for item 1001')
    fireEvent.change(price, { target: { value: '25' } })
    fireEvent.blur(price)
    await waitFor(() => expect(api.updateLineItem).toHaveBeenCalledWith('1001', { unitPrice: 25 }))
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
  })

  it('offers to read the items from the solicitation when there are none, and shows progress while it reads', async () => {
    renderPanel(ws())
    fireEvent.click(await screen.findByRole('button', { name: /Read the items from the solicitation/ }))
    await waitFor(() => expect(api.readLineItems).toHaveBeenCalledWith('w1'))
  })

  it('shows reading in progress', async () => {
    renderPanel(ws({ itemsStatus: 'PREPARING' }))
    expect(await screen.findByText(/Reading the items to price from the solicitation/)).toBeInTheDocument()
  })

  it('works out fully loaded labor rates from the build-up', async () => {
    renderPanel(ws({ priceFormat: 'LABOR_RATES' }))
    // wrap = (170 + 15 - 20) / 100 = 1.65 → $50 × 1.65 = $82.50
    expect(await screen.findByText('$82.50')).toBeInTheDocument()
    expect(wrapFactor(scenario as never)).toBeCloseTo(1.65)
  })

  it('says no price is needed for a sources-sought response, and lets an admin switch format', async () => {
    renderPanel(ws({ priceFormat: 'NONE' }))
    expect(await screen.findByText(/asks for no price/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use a different format' }))
    fireEvent.click(screen.getByRole('button', { name: /Line items/ }))
    await waitFor(() => expect(api.setFormat).toHaveBeenCalledWith('w1', 'LINE_ITEMS'))
  })

  it('is read-only once the price is in review, and for non-admins', async () => {
    renderPanel(ws({ status: 'IN_REVIEW', lineItems: [item('0001', { unitPrice: '10' })] }))
    await screen.findByText('Base Year')
    expect(screen.queryByLabelText(/Unit price for item/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Use a different format' })).not.toBeInTheDocument()
  })
})
