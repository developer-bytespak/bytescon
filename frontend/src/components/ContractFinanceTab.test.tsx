// =============================================================
// §8.2 — the contract finance surface.
//
// These cover the parts that had no screen at all until now: labour rates,
// direct costs and their approval flow, timesheets, and the printable invoice.
// The assertions favour consequence over layout — an approved cost is money, a
// draft one is not, and the page has to say which is which.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('./Toast', () => ({ useToast: () => ({ toast }) }))

const summary = vi.fn()
const listFunding = vi.fn()
const listInvoices = vi.fn()
const listRates = vi.fn()
const listCosts = vi.fn()
const listTime = vi.fn()
const rateVariance = vi.fn()
const getInvoice = vi.fn()
const addRate = vi.fn()
const addCost = vi.fn()
const costAction = vi.fn()
const approveTime = vi.fn()
const voidFunding = vi.fn()
const exportInvoice = vi.fn()
const exportInvoicePdf = vi.fn()
const exportInvoiceLedger = vi.fn()
const listClins = vi.fn()

vi.mock('../services/api', () => ({
  financeApi: {
    summary: (...a: unknown[]) => summary(...a),
    listFunding: (...a: unknown[]) => listFunding(...a),
    listInvoices: (...a: unknown[]) => listInvoices(...a),
    listRates: (...a: unknown[]) => listRates(...a),
    listCosts: (...a: unknown[]) => listCosts(...a),
    listTime: (...a: unknown[]) => listTime(...a),
    rateVariance: (...a: unknown[]) => rateVariance(...a),
    getInvoice: (...a: unknown[]) => getInvoice(...a),
    addRate: (...a: unknown[]) => addRate(...a),
    addCost: (...a: unknown[]) => addCost(...a),
    costAction: (...a: unknown[]) => costAction(...a),
    approveTime: (...a: unknown[]) => approveTime(...a),
    rejectTime: vi.fn(),
    voidFunding: (...a: unknown[]) => voidFunding(...a),
    exportInvoice: (...a: unknown[]) => exportInvoice(...a),
    exportInvoicePdf: (...a: unknown[]) => exportInvoicePdf(...a),
    exportInvoiceLedger: (...a: unknown[]) => exportInvoiceLedger(...a),
    addFunding: vi.fn(), createInvoice: vi.fn(), invoiceAction: vi.fn(), addPayment: vi.fn(),
  },
  contractMgmtApi: { listClins: (...a: unknown[]) => listClins(...a) },
}))

import { ContractFinanceTab } from './ContractFinanceTab'

const SUMMARY = {
  funded: '1560000.00', expended: '54262.50', remainingFunded: '1505737.50',
  expendedPct: 0.03, warning: 'NONE', insufficientData: false,
  estimatedDepletionDate: null, burnRatePerDay: null,
}
const INVOICE = {
  id: 'i1', invoiceNumber: 'INV-00001', total: '58462.50', amountPaid: '8000.00',
  dueDate: '2026-09-08T00:00:00.000Z', status: 'PARTIALLY_PAID',
}
const INVOICE_DETAIL = {
  ...INVOICE, subtotal: '58462.50', invoiceDate: '2026-08-09T00:00:00.000Z',
  periodStart: null, periodEnd: null, customerName: 'Department of Energy',
  lineItems: [
    { id: 'l1', kind: 'LABOR', description: 'SOC Analyst II — 8 hrs', quantity: '8', rate: '124', amount: '992.00', clin: { clinNumber: '0001' } },
    { id: 'l2', kind: 'FEE', description: 'Fee', quantity: null, rate: null, amount: '4200.00', clin: null },
  ],
}

const wrap = (isAdmin = true) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ContractFinanceTab contractId="c1" isAdmin={isAdmin} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  summary.mockResolvedValue({ data: SUMMARY })
  listFunding.mockResolvedValue({ data: [], meta: { fundedTotal: '1560000.00' } })
  listInvoices.mockResolvedValue({ data: [] })
  listRates.mockResolvedValue({ data: [] })
  listCosts.mockResolvedValue({ data: [] })
  listTime.mockResolvedValue({ data: [] })
  listClins.mockResolvedValue({ data: [{ id: 'k1', clinNumber: '0001' }] })
  rateVariance.mockResolvedValue({ data: { entries: [] } })
  getInvoice.mockResolvedValue({ data: INVOICE_DETAIL })
})

describe('Labour rates', () => {
  it('warns that time costs at zero when no rate exists', async () => {
    wrap()
    expect(await screen.findByText(/Approved time will cost at zero/i)).toBeInTheDocument()
  })

  it('says an approved amount is never re-priced by a later rate change', async () => {
    wrap()
    expect(await screen.findByText(/never re-prices work that was already approved/i)).toBeInTheDocument()
  })

  it('adds a rate', async () => {
    addRate.mockResolvedValue({})
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: /Add rate/ }))
    fireEvent.change(screen.getByLabelText('Labour category'), { target: { value: 'Engineer' } })
    fireEvent.change(screen.getByLabelText('Billing rate'), { target: { value: '185' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(addRate).toHaveBeenCalledWith('c1', expect.objectContaining({ categoryName: 'Engineer', billingRate: 185 })))
  })

  it('shows a consultant that the cost rate is withheld, not zero', async () => {
    listRates.mockResolvedValue({ data: [{ id: 'r1', categoryName: 'Engineer', rateType: 'BILLING', billingRate: '185', costRate: null, effectiveStart: null, effectiveEnd: null }] })
    wrap(false)
    expect(await screen.findByText('hidden')).toBeInTheDocument()
  })
})

describe('Direct costs', () => {
  const COST = { id: 'c1', category: 'TRAVEL', description: 'Site visit', amount: '1842.50', incurredDate: '2026-07-01T00:00:00.000Z', status: 'SUBMITTED' }

  it('offers approve and reject only on a submitted cost', async () => {
    listCosts.mockResolvedValue({ data: [COST] })
    wrap()
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
  })

  it('approves a cost through the action endpoint', async () => {
    listCosts.mockResolvedValue({ data: [COST] })
    costAction.mockResolvedValue({})
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(costAction).toHaveBeenCalledWith('c1', 'approve'))
  })

  it('says only an approved cost is an incurred cost', async () => {
    wrap()
    expect(await screen.findByText(/Only an APPROVED cost is an incurred cost/i)).toBeInTheDocument()
  })

  it('says a cost is voided rather than deleted', async () => {
    wrap()
    expect(await screen.findByText(/a cost is never deleted/i)).toBeInTheDocument()
  })

  it('gives a non-admin no cost actions', async () => {
    listCosts.mockResolvedValue({ data: [COST] })
    wrap(false)
    await screen.findByText('Site visit')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })
})

describe('Timesheets', () => {
  it('calls out a timesheet with no rate instead of showing it as zero', async () => {
    listTime.mockResolvedValue({ data: [{ id: 't1', workDate: '2026-07-06T00:00:00.000Z', laborCategory: 'Engineer', hours: '8', billingAmount: null, status: 'APPROVED' }] })
    wrap()
    expect(await screen.findByText('no rate')).toBeInTheDocument()
  })

  it('approves a submitted timesheet', async () => {
    listTime.mockResolvedValue({ data: [{ id: 't1', workDate: '2026-07-06T00:00:00.000Z', laborCategory: 'Engineer', hours: '8', billingAmount: '1480.00', status: 'SUBMITTED' }] })
    approveTime.mockResolvedValue({})
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(approveTime).toHaveBeenCalledWith('t1'))
  })
})

describe('Funding ledger', () => {
  it('says a funding entry is voided rather than deleted', async () => {
    wrap()
    expect(await screen.findByText(/A funding entry is never deleted/i)).toBeInTheDocument()
  })
})

describe('Invoice preview', () => {
  it('opens a printable copy showing each line against its CLIN', async () => {
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('dialog', { name: 'Invoice preview' })).toBeInTheDocument()
    expect(screen.getByText('0001')).toBeInTheDocument()
    expect(screen.getByText('SOC Analyst II — 8 hrs')).toBeInTheDocument()
  })

  it('says the printable copy is not a filed submission', async () => {
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    expect(await screen.findByText(/not a filed submission/i)).toBeInTheDocument()
  })

  it('downloads the CSV from the preview', async () => {
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    exportInvoice.mockResolvedValue(undefined)
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Download CSV' }))
    await waitFor(() => expect(exportInvoice).toHaveBeenCalledWith('i1', 'INV-00001'))
  })

  it('downloads the PDF from the preview', async () => {
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    exportInvoicePdf.mockResolvedValue(undefined)
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(await screen.findByRole('button', { name: /Download PDF/ }))
    await waitFor(() => expect(exportInvoicePdf).toHaveBeenCalledWith('i1', 'INV-00001'))
  })

  it('says so instead of failing silently when an export cannot be produced', async () => {
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    exportInvoicePdf.mockRejectedValue(new Error('boom'))
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    fireEvent.click(await screen.findByRole('button', { name: /Download PDF/ }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/could not be exported/i), 'error'))
  })

  it('offers a non-admin the exports it offers an admin — reading is not approving', async () => {
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    wrap(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview' }))
    expect(await screen.findByRole('button', { name: /Download PDF/ })).toBeInTheDocument()
  })

  it('exports every line item, not a row of invoice totals', async () => {
    // The summary this replaced reported one row per invoice while the table
    // beneath it listed fourteen lines, and dropped all fourteen.
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    exportInvoiceLedger.mockResolvedValue(undefined)
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: /invoice ledger/i }))
    await waitFor(() => expect(exportInvoiceLedger).toHaveBeenCalledWith('c1', expect.any(String)))
  })

  it('offers no ledger export when there are no invoices', async () => {
    listInvoices.mockResolvedValue({ data: [] })
    wrap()
    await screen.findByText(/No invoices yet/i)
    expect(screen.getByRole('button', { name: /invoice ledger/i })).toBeDisabled()
  })

  it('says so when the ledger cannot be produced', async () => {
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    exportInvoiceLedger.mockRejectedValue(new Error('boom'))
    wrap()
    fireEvent.click(await screen.findByRole('button', { name: /invoice ledger/i }))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.stringMatching(/ledger could not be exported/i), 'error'))
  })

  it('lets a non-admin preview without offering any approval control', async () => {
    listInvoices.mockResolvedValue({ data: [INVOICE] })
    wrap(false)
    expect(await screen.findByRole('button', { name: 'Preview' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument()
  })
})
