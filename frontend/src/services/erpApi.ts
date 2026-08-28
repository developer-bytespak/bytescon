// =============================================================
// §8.2 — API client for the ERP surface.
//
// Every money figure arrives from the backend as an exact decimal string and is
// rendered as-is. Nothing is recomputed here: budget, actual, committed,
// remaining, backlog and capacity all have one owner, and it is the server.
// =============================================================
import { api } from './api'

export type BudgetStatus = 'DRAFT' | 'ACTIVE' | 'SUPERSEDED'
export type BudgetCategory = 'LABOR' | 'ODC' | 'SUBCONTRACT' | 'TRAVEL' | 'MATERIAL' | 'INDIRECT' | 'OTHER'
export type PurchaseOrderStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'PARTIALLY_RECEIVED' | 'COMPLETE' | 'CANCELLED'
export type SubcontractInvoiceStatus = 'RECEIVED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'PAID'
export type FlowDownState = 'INSUFFICIENT_DATA' | 'REVIEW_REQUIRED' | 'APPLICABLE_CONFIRMED' | 'NOT_APPLICABLE_CONFIRMED' | 'INCLUDED' | 'NOT_INCLUDED'
export type CapacityState = 'INSUFFICIENT_DATA' | 'AVAILABLE' | 'NEAR_CAPACITY' | 'OVER_ALLOCATED'

export const BUDGET_CATEGORIES: BudgetCategory[] = ['LABOR', 'ODC', 'SUBCONTRACT', 'TRAVEL', 'MATERIAL', 'INDIRECT', 'OTHER']

export interface BudgetLineComparison {
  category: BudgetCategory
  clinId: string | null
  clinNumber: string | null
  budget: string
  actual: string
  committed: string
  remaining: string
  variance: string
  variancePercent: number | null
  overBudget: boolean
}

export interface BudgetVsActual {
  contractId: string
  budgetId: string | null
  budgetVersion: number | null
  budgetStatus: BudgetStatus | null
  hasBudget: boolean
  dataNote: string
  totals: {
    budget: string | null
    actual: string
    committed: string
    remaining: string | null
    variance: string | null
    variancePercent: number | null
    overBudget: boolean
  }
  byCategory: BudgetLineComparison[]
  byClin: BudgetLineComparison[]
  actualBreakdown: { labor: string; nonLabor: string; subcontract: string }
  threshold: { key: string; label: string; consumedPct: number } | null
}

export interface ContractBudget {
  id: string
  versionNumber: number
  status: BudgetStatus
  title: string | null
  approvedAt: string | null
  supersededAt: string | null
  lines: Array<{ id: string; category: BudgetCategory; plannedAmount: string; description: string | null; clin?: { id: string; clinNumber: string } | null }>
}

export interface CapacitySnapshot {
  windowStart: string
  windowEnd: string | null
  state: CapacityState
  dataNote: string
  peopleWithPlans: number
  totalAllocationPercent: number
  recentActualHours: string | null
  people: Array<{
    userId: string
    name: string
    allocatedPercent: number
    remainingPercent: number
    state: CapacityState
    conflict: boolean
    allocations: Array<{
      id: string; contractId: string; contractNumber: string | null
      allocationPercent: number; startDate: string; endDate: string | null
      laborCategory: string | null; status: string
    }>
  }>
  conflicts: Array<{ userId: string; name: string; allocatedPercent: number }>
}

export interface PurchaseOrder {
  id: string
  poNumber: string
  vendorName: string
  status: PurchaseOrderStatus
  ceilingAmount: string
  isSubcontract: boolean
  description: string | null
  partner?: { id: string; name: string } | null
  contract?: { id: string; contractNumber: string } | null
  lines: Array<{ id: string; description: string; amount: string; category: BudgetCategory; quantity: string | null; unit: string | null; unitPrice: string | null; clin?: { id: string; clinNumber: string } | null }>
  _count?: { invoices: number; flowDowns: number }
  balance?: { ceiling: string; invoicedTotal: string; postedTotal: string; remaining: string; overInvoiced: boolean }
  invoices?: SubcontractInvoice[]
  flowDowns?: FlowDown[]
}

export interface SubcontractInvoice {
  id: string
  invoiceNumber: string
  vendorName: string
  invoiceDate: string
  amount: string
  status: SubcontractInvoiceStatus
  postedContractCostId: string | null
  postedAt: string | null
  paymentReference: string | null
  purchaseOrder?: { id: string; poNumber: string }
}

export interface FlowDown {
  id: string
  clauseNumber: string
  clauseTitle: string | null
  state: FlowDownState
  evidence: string | null
  reviewedByUserId: string | null
  reviewedAt: string | null
}

export interface FinancialSummary {
  contractId: string
  contractNumber: string
  contractValue: string | null
  contractValueSource: 'CEILING' | 'AWARD' | null
  funded: string
  unfunded: string | null
  budget: string | null
  actual: string
  committed: string
  remainingBudget: string | null
  fundedRemaining: string
  backlog: string | null
  backlogBasis: string
  receivables: { billed: string; collected: string; outstanding: string }
  subcontractCommitments: { orderCount: number; committed: string; invoiced: string; posted: string }
  limitations: string[]
  budgetDetail: BudgetVsActual
}

async function get<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await api.get(url, { params })
  return res.data.data as T
}
async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await api.post(url, body)
  return res.data.data as T
}

export const erpApi = {
  listBudgets: (contractId: string) => get<ContractBudget[]>(`/erp/contracts/${contractId}/budgets`),
  createBudget: (body: Record<string, unknown>) => post<ContractBudget>('/erp/budgets', body),
  activateBudget: (id: string) => post<ContractBudget>(`/erp/budgets/${id}/activate`, {}),
  budgetVsActual: (contractId: string) => get<BudgetVsActual>(`/erp/contracts/${contractId}/budget-vs-actual`),

  capacity: (params?: Record<string, unknown>) => get<CapacitySnapshot>('/erp/capacity', params),
  listAllocations: (params?: Record<string, unknown>) => get<Array<Record<string, unknown>>>('/erp/resource-allocations', params),
  createAllocation: (body: Record<string, unknown>) => post<Record<string, unknown>>('/erp/resource-allocations', body),

  listPurchaseOrders: (params?: Record<string, unknown>) => get<PurchaseOrder[]>('/erp/purchase-orders', params),
  getPurchaseOrder: (id: string) => get<PurchaseOrder>(`/erp/purchase-orders/${id}`),
  createPurchaseOrder: (body: Record<string, unknown>) => post<PurchaseOrder>('/erp/purchase-orders', body),
  transitionPurchaseOrder: (id: string, status: PurchaseOrderStatus, reason?: string) =>
    post<PurchaseOrder>(`/erp/purchase-orders/${id}/transition`, { status, reason }),

  listSubcontractInvoices: (params?: Record<string, unknown>) => get<SubcontractInvoice[]>('/erp/subcontract-invoices', params),
  createSubcontractInvoice: (body: Record<string, unknown>) => post<SubcontractInvoice>('/erp/subcontract-invoices', body),
  transitionSubcontractInvoice: (id: string, status: SubcontractInvoiceStatus, extra?: Record<string, unknown>) =>
    post<SubcontractInvoice>(`/erp/subcontract-invoices/${id}/transition`, { status, ...extra }),

  listFlowDowns: (poId: string) => get<{ items: FlowDown[]; disclaimer: string }>(`/erp/purchase-orders/${poId}/flow-downs`),
  seedFlowDowns: (poId: string) => post<{ created: number; examined?: number; note?: string }>(`/erp/purchase-orders/${poId}/flow-downs/seed`, {}),
  reviewFlowDown: (id: string, state: FlowDownState, evidence?: string) =>
    post<FlowDown>(`/erp/flow-downs/${id}/review`, { state, evidence }),

  financialSummary: (contractId: string) => get<FinancialSummary>(`/erp/contracts/${contractId}/financial-summary`),
}
