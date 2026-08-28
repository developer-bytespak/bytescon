// =============================================================
// §8.5 — Approval surfaces at a phone viewport.
//
// COMPONENT / RESPONSIVE TEST LEVEL ONLY. jsdom has no layout engine, so this
// suite cannot prove anything about how a screen looks. What it CAN prove, and
// what actually matters, is that shrinking the viewport does not remove or
// weaken an approval control: the same buttons, the same confirmations, the
// same disabled states.
//
// The failure this guards against is a "mobile-friendly" refactor that quietly
// drops a confirmation because a dialog was awkward on a small screen.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ContractPurchasingTab, ContractBudgetTab } from '../components/erp/ContractErpTabs'

const listPurchaseOrders = vi.fn()
const transitionPurchaseOrder = vi.fn()
const budgetVsActual = vi.fn()
const listBudgets = vi.fn()

vi.mock('../services/erpApi', async () => {
  const actual = await vi.importActual<typeof import('../services/erpApi')>('../services/erpApi')
  return {
    ...actual,
    erpApi: {
      listPurchaseOrders: (...a: unknown[]) => listPurchaseOrders(...a),
      transitionPurchaseOrder: (...a: unknown[]) => transitionPurchaseOrder(...a),
      budgetVsActual: (...a: unknown[]) => budgetVsActual(...a),
      listBudgets: (...a: unknown[]) => listBudgets(...a),
      createBudget: vi.fn(), activateBudget: vi.fn(), capacity: vi.fn(), financialSummary: vi.fn(),
    },
  }
})
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const PHONE = 390
const DESKTOP = 1440

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width })
  window.dispatchEvent(new Event('resize'))
}

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

const PO = {
  id: 'p1', poNumber: 'PO-1', vendorName: 'Acme', status: 'PENDING_APPROVAL' as const,
  ceilingAmount: '20000.00', isSubcontract: true, description: null, lines: [],
  _count: { invoices: 0, flowDowns: 0 },
}

beforeEach(() => {
  vi.clearAllMocks()
  listBudgets.mockResolvedValue([])
  listPurchaseOrders.mockResolvedValue([PO])
  transitionPurchaseOrder.mockResolvedValue({})
})

afterEach(() => setViewport(DESKTOP))

describe('approval controls at a phone viewport (iPhone 12-class, 390px)', () => {
  it('still offers purchase-order approval to an admin', async () => {
    setViewport(PHONE)
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument()
  })

  it('still refuses approval to a non-admin, small screen or not', async () => {
    setViewport(PHONE)
    wrap(<ContractPurchasingTab contractId="c1" isAdmin={false} />)
    await screen.findByRole('button', { name: /PO-1/ })
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('still performs the same transition it does on a desktop', async () => {
    setViewport(PHONE)
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(transitionPurchaseOrder).toHaveBeenCalledWith('p1', 'APPROVED'))
  })

  it('keeps the statement that approval is a human action', async () => {
    setViewport(PHONE)
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    expect(await screen.findByText(/No agent can perform any of them/i)).toBeInTheDocument()
  })

  it('keeps budget figures separate rather than collapsing them for width', async () => {
    setViewport(PHONE)
    budgetVsActual.mockResolvedValue({
      contractId: 'c1', budgetId: 'b1', budgetVersion: 1, budgetStatus: 'ACTIVE', hasBudget: true,
      dataNote: 'Committed money is not available to spend twice.',
      totals: { budget: '100000.00', actual: '50000.00', committed: '20000.00', remaining: '30000.00', variance: '30000.00', variancePercent: 30, overBudget: false },
      byCategory: [], byClin: [], actualBreakdown: { labor: '0.00', nonLabor: '0.00', subcontract: '0.00' }, threshold: null,
    })
    wrap(<ContractBudgetTab contractId="c1" isAdmin={false} />)
    expect(await screen.findByText('$50,000.00')).toBeInTheDocument()
    expect(screen.getByText('$20,000.00')).toBeInTheDocument()
    expect(screen.getByText(/not available to spend twice/i)).toBeInTheDocument()
  })

  it('renders the same control set at both viewports', async () => {
    setViewport(DESKTOP)
    const desktop = wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    await screen.findByRole('button', { name: 'Approve' })
    const desktopButtons = desktop.container.querySelectorAll('button').length
    desktop.unmount()

    setViewport(PHONE)
    const phone = wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    await screen.findByRole('button', { name: 'Approve' })
    expect(phone.container.querySelectorAll('button').length).toBe(desktopButtons)
  })
})
