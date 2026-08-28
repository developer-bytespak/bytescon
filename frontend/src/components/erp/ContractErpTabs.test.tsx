// =============================================================
// §8.2 — ERP panels.
//
// The assertions that matter: committed money is shown separately from actual,
// no-plan capacity says "no resource plan" rather than available, and the UI
// never derives a money figure of its own.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import {
  ContractBudgetTab, ContractFinancialsTab, ContractPurchasingTab, ContractResourcesTab,
} from './ContractErpTabs'

const budgetVsActual = vi.fn()
const listBudgets = vi.fn()
const capacity = vi.fn()
const listPurchaseOrders = vi.fn()
const transitionPurchaseOrder = vi.fn()
const financialSummary = vi.fn()
const getPurchaseOrder = vi.fn()
const listAllocations = vi.fn()
const createPurchaseOrder = vi.fn()
const transitionSubcontractInvoice = vi.fn()

vi.mock('../../services/erpApi', async () => {
  const actual = await vi.importActual<typeof import('../../services/erpApi')>('../../services/erpApi')
  return {
    ...actual,
    erpApi: {
      budgetVsActual: (...a: unknown[]) => budgetVsActual(...a),
      listBudgets: (...a: unknown[]) => listBudgets(...a),
      createBudget: vi.fn(), activateBudget: vi.fn(),
      capacity: (...a: unknown[]) => capacity(...a),
      listAllocations: (...a: unknown[]) => listAllocations(...a),
      createAllocation: vi.fn(),
      createPurchaseOrder: (...a: unknown[]) => createPurchaseOrder(...a),
      createSubcontractInvoice: vi.fn(),
      reviewFlowDown: vi.fn(),
      seedFlowDowns: vi.fn(),
      listPurchaseOrders: (...a: unknown[]) => listPurchaseOrders(...a),
      transitionPurchaseOrder: (...a: unknown[]) => transitionPurchaseOrder(...a),
      financialSummary: (...a: unknown[]) => financialSummary(...a),
      getPurchaseOrder: (...a: unknown[]) => getPurchaseOrder(...a),
      transitionSubcontractInvoice: (...a: unknown[]) => transitionSubcontractInvoice(...a),
    },
  }
})
vi.mock('../Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const wrap = (ui: React.ReactElement) => render(<MemoryRouter>{ui}</MemoryRouter>)

beforeEach(() => {
  vi.clearAllMocks()
  listBudgets.mockResolvedValue([])
  listAllocations.mockResolvedValue([])
})

describe('Budget tab', () => {
  it('shows actual and committed as separate figures, and remaining net of both', async () => {
    budgetVsActual.mockResolvedValue({
      contractId: 'c1', budgetId: 'b1', budgetVersion: 1, budgetStatus: 'ACTIVE', hasBudget: true,
      dataNote: 'Committed money is not available to spend twice.',
      totals: { budget: '100000.00', actual: '50000.00', committed: '20000.00', remaining: '30000.00', variance: '30000.00', variancePercent: 30, overBudget: false },
      byCategory: [], byClin: [], actualBreakdown: { labor: '0.00', nonLabor: '0.00', subcontract: '0.00' }, threshold: null,
    })
    wrap(<ContractBudgetTab contractId="c1" isAdmin={false} />)
    expect(await screen.findByText('$50,000.00')).toBeInTheDocument()
    expect(screen.getByText('$20,000.00')).toBeInTheDocument()
    expect(screen.getByText('$30,000.00')).toBeInTheDocument()
    expect(screen.getByText(/not available to spend twice/i)).toBeInTheDocument()
  })

  it('reports no budget as unknown rather than zero', async () => {
    budgetVsActual.mockResolvedValue({
      contractId: 'c1', budgetId: null, budgetVersion: null, budgetStatus: null, hasBudget: false,
      dataNote: 'No active budget exists, so there is no plan to compare against.',
      totals: { budget: null, actual: '1000.00', committed: '0.00', remaining: null, variance: null, variancePercent: null, overBudget: false },
      byCategory: [], byClin: [], actualBreakdown: { labor: '0.00', nonLabor: '0.00', subcontract: '0.00' }, threshold: null,
    })
    wrap(<ContractBudgetTab contractId="c1" isAdmin={false} />)
    await screen.findByText('$1,000.00')
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
    expect(screen.getByText(/no plan to compare against/i)).toBeInTheDocument()
  })

  it('surfaces a breached threshold with its consumed percentage', async () => {
    budgetVsActual.mockResolvedValue({
      contractId: 'c1', budgetId: 'b1', budgetVersion: 2, budgetStatus: 'ACTIVE', hasBudget: true, dataNote: '',
      totals: { budget: '100.00', actual: '70.00', committed: '25.00', remaining: '5.00', variance: '5.00', variancePercent: 5, overBudget: false },
      byCategory: [], byClin: [], actualBreakdown: { labor: '0.00', nonLabor: '0.00', subcontract: '0.00' },
      threshold: { key: 'CRITICAL', label: '90% of budget consumed', consumedPct: 95 },
    })
    wrap(<ContractBudgetTab contractId="c1" isAdmin={false} />)
    expect(await screen.findByText(/90% of budget consumed/i)).toBeInTheDocument()
    expect(screen.getByText(/95% of budget consumed/i)).toBeInTheDocument()
  })

  it('hides activation from a non-admin', async () => {
    budgetVsActual.mockResolvedValue({
      contractId: 'c1', budgetId: null, budgetVersion: null, budgetStatus: null, hasBudget: false, dataNote: '',
      totals: { budget: null, actual: '0.00', committed: '0.00', remaining: null, variance: null, variancePercent: null, overBudget: false },
      byCategory: [], byClin: [], actualBreakdown: { labor: '0.00', nonLabor: '0.00', subcontract: '0.00' }, threshold: null,
    })
    listBudgets.mockResolvedValue([{ id: 'b9', versionNumber: 1, status: 'DRAFT', title: null, approvedAt: null, supersededAt: null, lines: [] }])
    wrap(<ContractBudgetTab contractId="c1" isAdmin={false} />)
    await screen.findByText('DRAFT')
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
  })
})

describe('Resources tab', () => {
  it('says NO RESOURCE PLAN rather than implying availability', async () => {
    capacity.mockResolvedValue({
      windowStart: '', windowEnd: null, state: 'INSUFFICIENT_DATA',
      dataNote: 'No resource allocations cover this window. This is not a statement that the team is available.',
      peopleWithPlans: 0, totalAllocationPercent: 0, people: [], conflicts: [], recentActualHours: null,
    })
    wrap(<ContractResourcesTab contractId="c1" />)
    expect(await screen.findByText(/No resource plan/i)).toBeInTheDocument()
    expect(screen.getByText(/not a statement that the team is available/i)).toBeInTheDocument()
    expect(screen.queryByText(/100%/)).not.toBeInTheDocument()
  })

  it('flags an over-allocated person as a conflict', async () => {
    capacity.mockResolvedValue({
      windowStart: '', windowEnd: null, state: 'OVER_ALLOCATED', dataNote: 'note',
      peopleWithPlans: 1, totalAllocationPercent: 130, recentActualHours: '42.00',
      people: [{
        userId: 'u1', name: 'Sam Rivera', allocatedPercent: 130, remainingPercent: -30,
        state: 'OVER_ALLOCATED', conflict: true,
        allocations: [{ id: 'a1', contractId: 'c1', contractNumber: 'N001', allocationPercent: 130, startDate: '2027-01-01T00:00:00.000Z', endDate: null, laborCategory: 'Engineer', status: 'ACTIVE' }],
      }],
      conflicts: [{ userId: 'u1', name: 'Sam Rivera', allocatedPercent: 130 }],
    })
    wrap(<ContractResourcesTab contractId="c1" />)
    expect(await screen.findByText('CAPACITY CONFLICT')).toBeInTheDocument()
    expect(screen.getByText(/130% allocated/)).toBeInTheDocument()
  })
})

describe('Purchasing tab', () => {
  const po = {
    id: 'p1', poNumber: 'PO-1', vendorName: 'Acme', status: 'PENDING_APPROVAL' as const,
    ceilingAmount: '20000.00', isSubcontract: true, description: null, lines: [],
    _count: { invoices: 0, flowDowns: 0 },
  }

  it('offers approval to an admin and calls the transition', async () => {
    listPurchaseOrders.mockResolvedValue([po])
    transitionPurchaseOrder.mockResolvedValue({})
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(transitionPurchaseOrder).toHaveBeenCalledWith('p1', 'APPROVED'))
  })

  it('offers no approval control to a non-admin', async () => {
    listPurchaseOrders.mockResolvedValue([po])
    wrap(<ContractPurchasingTab contractId="c1" isAdmin={false} />)
    await screen.findByRole('button', { name: /PO-1/ })
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })

  it('states that approval is a human action', async () => {
    listPurchaseOrders.mockResolvedValue([po])
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    expect(await screen.findByText(/No agent can perform any of them/i)).toBeInTheDocument()
  })
})

describe('Purchase order detail', () => {
  const summary = {
    id: 'p1', poNumber: 'PO-1', vendorName: 'Acme', status: 'APPROVED' as const,
    ceilingAmount: '180000.00', isSubcontract: true, description: null, lines: [],
    _count: { invoices: 2, flowDowns: 1 },
  }
  const detail = {
    ...summary,
    description: 'After-hours SOC coverage',
    balance: { ceiling: '180000.00', invoicedTotal: '39550.00', postedTotal: '18400.00', remaining: '140450.00', overInvoiced: false },
    lines: [
      { id: 'l1', description: 'After-hours SOC analyst', amount: '138000.00', category: 'SUBCONTRACT' as const, quantity: '1200', unit: 'hour', unitPrice: '115', clin: { id: 'k1', clinNumber: '0001' } },
      { id: 'l2', description: 'Travel for surge', amount: '12000.00', category: 'TRAVEL' as const, quantity: null, unit: null, unitPrice: null, clin: null },
    ],
    invoices: [
      { id: 'i1', invoiceNumber: 'SUB-06', vendorName: 'Acme', invoiceDate: '2026-06-30T00:00:00.000Z', amount: '18400.00', status: 'PAID' as const, postedContractCostId: 'cc1', postedAt: '2026-07-02T00:00:00.000Z', paymentReference: 'ACH-1' },
      { id: 'i2', invoiceNumber: 'SUB-08', vendorName: 'Acme', invoiceDate: '2026-08-10T00:00:00.000Z', amount: '16720.00', status: 'RECEIVED' as const, postedContractCostId: null, postedAt: null, paymentReference: null },
    ],
    flowDowns: [
      { id: 'f1', clauseNumber: '252.204-7012', clauseTitle: 'Safeguarding Covered Defense Information', state: 'INCLUDED' as const, evidence: 'Included at Article 14.', reviewedByUserId: 'u1', reviewedAt: '2026-05-01T00:00:00.000Z' },
      { id: 'f2', clauseNumber: '52.219-8', clauseTitle: 'Utilization of Small Business Concerns', state: 'REVIEW_REQUIRED' as const, evidence: null, reviewedByUserId: null, reviewedAt: null },
    ],
  }

  const open = async () => {
    listPurchaseOrders.mockResolvedValue([summary])
    getPurchaseOrder.mockResolvedValue(detail)
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    fireEvent.click(await screen.findByRole('button', { name: /PO-1/ }))
  }

  it('fetches the order only once it is opened', async () => {
    listPurchaseOrders.mockResolvedValue([summary])
    getPurchaseOrder.mockResolvedValue(detail)
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    await screen.findByRole('button', { name: /PO-1/ })
    expect(getPurchaseOrder).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /PO-1/ }))
    await waitFor(() => expect(getPurchaseOrder).toHaveBeenCalledWith('p1'))
  })

  it('shows each line against its CLIN', async () => {
    await open()
    expect(await screen.findByText('After-hours SOC analyst')).toBeInTheDocument()
    expect(screen.getByText('0001')).toBeInTheDocument()
  })

  it('separates what was invoiced from what became an actual cost', async () => {
    await open()
    expect(await screen.findByText('Posted as cost')).toBeInTheDocument()
    expect(screen.getByText('Invoiced')).toBeInTheDocument()
    // Invoiced is the larger figure: only the approved invoice posted as a cost.
    expect(screen.getByText('$39,550.00')).toBeInTheDocument()
    // $18,400 shows twice on purpose — as the posted total and as the paid
    // invoice it came from.
    expect(screen.getAllByText('$18,400.00')).toHaveLength(2)
  })

  it('offers a decision only on an invoice still awaiting one', async () => {
    await open()
    await screen.findByText('SUB-08')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeInTheDocument()
    // The paid one is finished, so it carries no action.
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument()
  })

  it('approves a vendor invoice through the transition endpoint', async () => {
    transitionSubcontractInvoice.mockResolvedValue({})
    await open()
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(transitionSubcontractInvoice).toHaveBeenCalledWith('i2', 'APPROVED'))
  })

  it('shows a clause still needing review as a warning, not a decided state', async () => {
    await open()
    expect(await screen.findByText('52.219-8')).toBeInTheDocument()
    expect(screen.getByText('REVIEW REQUIRED')).toBeInTheDocument()
  })

  it('says a flow-down state is set by a reviewer rather than inferred', async () => {
    await open()
    expect(await screen.findByText(/set by a reviewer, never inferred/i)).toBeInTheDocument()
  })

  it('gives a non-admin no invoice actions', async () => {
    listPurchaseOrders.mockResolvedValue([summary])
    getPurchaseOrder.mockResolvedValue(detail)
    wrap(<ContractPurchasingTab contractId="c1" isAdmin={false} />)
    fireEvent.click(await screen.findByRole('button', { name: /PO-1/ }))
    await screen.findByText('SUB-08')
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
  })
})

describe('Financials tab', () => {
  it('keeps backlog, receivables and commitments apart', async () => {
    financialSummary.mockResolvedValue({
      contractId: 'c1', contractNumber: 'N001', contractValue: '1000000.00', contractValueSource: 'CEILING',
      funded: '400000.00', unfunded: '600000.00', budget: '300000.00', actual: '2450.50', committed: '23800.00',
      remainingBudget: '273749.50', fundedRemaining: '397549.50', backlog: '997549.50',
      backlogBasis: 'Backlog is contract value less actual cost. It is not pipeline, and it is not receivables.',
      receivables: { billed: '0.00', collected: '0.00', outstanding: '0.00' },
      subcontractCommitments: { orderCount: 2, committed: '23800.00', invoiced: '10200.00', posted: '1200.00' },
      limitations: [], budgetDetail: {} as never,
    })
    wrap(<ContractFinancialsTab contractId="c1" />)
    expect(await screen.findByText('$997,549.50')).toBeInTheDocument()
    expect(screen.getByText('$600,000.00')).toBeInTheDocument()
    expect(screen.getByText(/not pipeline, and it is not receivables/i)).toBeInTheDocument()
  })

  it('renders unknown values as unknown and lists the limitation', async () => {
    financialSummary.mockResolvedValue({
      contractId: 'c1', contractNumber: 'N002', contractValue: null, contractValueSource: null,
      funded: '0.00', unfunded: null, budget: null, actual: '0.00', committed: '0.00',
      remainingBudget: null, fundedRemaining: '0.00', backlog: null,
      backlogBasis: 'basis',
      receivables: { billed: '0.00', collected: '0.00', outstanding: '0.00' },
      subcontractCommitments: { orderCount: 0, committed: '0.00', invoiced: '0.00', posted: '0.00' },
      limitations: ['No ceiling or award value is recorded, so backlog cannot be computed.'],
      budgetDetail: {} as never,
    })
    wrap(<ContractFinancialsTab contractId="c1" />)
    expect(await screen.findByText(/backlog cannot be computed/i)).toBeInTheDocument()
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3)
  })
})

// §8.2 — the writes that had no screen until now.
describe('Purchasing tab — creating an order', () => {
  const po = {
    id: 'p1', poNumber: 'PO-1', vendorName: 'Acme', status: 'DRAFT' as const,
    ceilingAmount: '20000.00', isSubcontract: true, description: null, lines: [],
    _count: { invoices: 0, flowDowns: 0 },
  }

  it('creates an order as a DRAFT, never pre-approved', async () => {
    listPurchaseOrders.mockResolvedValue([])
    createPurchaseOrder.mockResolvedValue({})
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    fireEvent.click(await screen.findByRole('button', { name: 'New purchase order' }))
    fireEvent.change(screen.getByLabelText('PO number'), { target: { value: 'PO-9' } })
    fireEvent.change(screen.getByLabelText('Vendor name'), { target: { value: 'Acme' } })
    fireEvent.change(screen.getByLabelText('Ceiling amount'), { target: { value: '50000' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create draft order' }))
    await waitFor(() => expect(createPurchaseOrder).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: 'c1', poNumber: 'PO-9', ceilingAmount: 50000 }),
    ))
  })

  it('says an order starts as a draft and approval is separate', async () => {
    listPurchaseOrders.mockResolvedValue([po])
    wrap(<ContractPurchasingTab contractId="c1" isAdmin />)
    expect(await screen.findByText(/Approving it is a separate, human act/i)).toBeInTheDocument()
  })

  it('offers a non-admin no way to create one', async () => {
    listPurchaseOrders.mockResolvedValue([po])
    wrap(<ContractPurchasingTab contractId="c1" isAdmin={false} />)
    await screen.findByRole('button', { name: /PO-1/ })
    expect(screen.queryByRole('button', { name: 'New purchase order' })).not.toBeInTheDocument()
  })
})

describe('Resources tab — allocating people', () => {
  it('says an allocation is a plan, not actual hours', async () => {
    capacity.mockResolvedValue({
      windowStart: '2026-01-01', windowEnd: null, state: 'INSUFFICIENT_DATA',
      dataNote: 'No allocation recorded.', peopleWithPlans: 0, totalAllocationPercent: 0,
      recentActualHours: null, people: [], conflicts: [],
    })
    wrap(<ContractResourcesTab contractId="c1" isAdmin />)
    expect(await screen.findByText(/never derived from it/i)).toBeInTheDocument()
  })

  it('gives a non-admin no allocation control', async () => {
    capacity.mockResolvedValue({
      windowStart: '2026-01-01', windowEnd: null, state: 'INSUFFICIENT_DATA',
      dataNote: 'No allocation recorded.', peopleWithPlans: 0, totalAllocationPercent: 0,
      recentActualHours: null, people: [], conflicts: [],
    })
    wrap(<ContractResourcesTab contractId="c1" isAdmin={false} />)
    await screen.findByText(/No resource plan/i)
    expect(screen.queryByRole('button', { name: 'Allocate someone' })).not.toBeInTheDocument()
  })
})
