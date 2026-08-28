// =============================================================
// §8.2 — Budget vs actual, with commitments.
//
// The one canonical place this comparison is made. The frontend never
// recomputes any of it.
//
// Cost hierarchy — deliberately identical to the existing burn definition in
// `contractFinanceQueries.loadBurnInputs`, so the ERP view and the Contract
// Administration Agent can never drift into two meanings of "spent":
//
//   ACTUAL     = approved TimeEntry.billingAmount + approved ContractCost.amount
//   COMMITTED  = approved/open PurchaseOrder ceiling, less what it has already
//                posted as actual cost
//   REMAINING  = budget − actual − committed
//
// The subtlety that makes double counting impossible: an approved subcontractor
// invoice posts exactly one ContractCost row, so the moment it becomes actual it
// is also deducted from its purchase order's outstanding commitment. A dollar is
// therefore either committed or incurred, never both.
//
// All money is Prisma.Decimal end to end. The only Number conversions are
// percentages, which are ratios and never money.
// =============================================================
import { BudgetCategory, BudgetStatus, Prisma, PurchaseOrderStatus } from '@prisma/client'
import { prisma } from '../../config/database'
import { D, money2, recognizedExpenditure } from '../contractFinance'

type Dec = Prisma.Decimal

/** Orders whose ceiling still represents money the firm has committed. */
export const COMMITTING_PO_STATUSES: PurchaseOrderStatus[] = [
  PurchaseOrderStatus.APPROVED,
  PurchaseOrderStatus.PARTIALLY_RECEIVED,
]

export interface BudgetLineComparison {
  category: BudgetCategory
  clinId: string | null
  clinNumber: string | null
  budget: string
  actual: string
  committed: string
  remaining: string
  variance: string
  /** Null when budget is zero — a percentage of nothing is not a number. */
  variancePercent: number | null
  overBudget: boolean
}

export interface BudgetVsActualResult {
  contractId: string
  budgetId: string | null
  budgetVersion: number | null
  budgetStatus: BudgetStatus | null
  hasBudget: boolean
  /** Stated rather than implied, so the caller never renders 0 as a plan. */
  dataNote: string
  totals: {
    budget: string | null
    actual: string
    committed: string
    /** Null without a budget — "remaining" against no plan is meaningless. */
    remaining: string | null
    variance: string | null
    variancePercent: number | null
    overBudget: boolean
  }
  byCategory: BudgetLineComparison[]
  byClin: BudgetLineComparison[]
  actualBreakdown: { labor: string; nonLabor: string; subcontract: string }
}

const ZERO = new Prisma.Decimal(0)

function pct(numerator: Dec, denominator: Dec): number | null {
  if (denominator.isZero()) return null
  return Number(numerator.dividedBy(denominator).times(100).toDecimalPlaces(2))
}

/**
 * Category a ContractCost row counts against. The existing `category` strings
 * predate the budget vocabulary, so they are mapped rather than rewritten.
 */
function costCategoryToBudget(category: string): BudgetCategory {
  switch (category) {
    case 'SUBCONTRACTOR': return BudgetCategory.SUBCONTRACT
    case 'TRAVEL': return BudgetCategory.TRAVEL
    case 'MATERIAL': return BudgetCategory.MATERIAL
    case 'EQUIPMENT': return BudgetCategory.MATERIAL
    case 'OTHER_DIRECT_COST': return BudgetCategory.ODC
    default: return BudgetCategory.OTHER
  }
}

/**
 * Compare the active budget for one contract against real actual and committed
 * cost. Tenant-scoped on every query — a contract id alone is never trusted.
 */
export async function computeBudgetVsActual(
  consultingFirmId: string,
  contractId: string,
): Promise<BudgetVsActualResult> {
  const [budget, approvedTime, approvedCosts, orders, clins] = await Promise.all([
    prisma.contractBudget.findFirst({
      where: { consultingFirmId, contractId, status: BudgetStatus.ACTIVE },
      include: { lines: true },
      orderBy: { versionNumber: 'desc' },
    }),
    prisma.timeEntry.findMany({
      where: { consultingFirmId, contractId, status: 'APPROVED' },
      select: { billingAmount: true, clinId: true },
    }),
    prisma.contractCost.findMany({
      where: { consultingFirmId, contractId, status: 'APPROVED' },
      select: { amount: true, category: true, clinId: true },
    }),
    prisma.purchaseOrder.findMany({
      where: { consultingFirmId, contractId, status: { in: COMMITTING_PO_STATUSES } },
      select: {
        id: true, ceilingAmount: true, clinId: true,
        invoices: {
          where: { postedContractCostId: { not: null } },
          select: { amount: true },
        },
      },
    }),
    prisma.clin.findMany({ where: { consultingFirmId, contractId }, select: { id: true, clinNumber: true } }),
  ])

  const clinNumber = new Map(clins.map((c) => [c.id, c.clinNumber]))

  // ---- ACTUAL ----
  // §8 acceptance audit — the TOTAL comes from recognizedExpenditure, the one
  // definition of what a contract has actually cost (approved time billing plus
  // approved cost). The breakdown below is a decomposition of that same number
  // for display; it must never become a second way of arriving at it, because
  // then budget-vs-actual and the financial summary could quietly disagree.
  const labor = approvedTime.reduce((s, t) => s.plus(D(t.billingAmount)), ZERO)
  const nonLabor = approvedCosts.reduce((s, c) => s.plus(D(c.amount)), ZERO)
  const subcontractActual = approvedCosts
    .filter((c) => c.category === 'SUBCONTRACTOR')
    .reduce((s, c) => s.plus(D(c.amount)), ZERO)
  const actualTotal = recognizedExpenditure(approvedTime, approvedCosts)

  // ---- COMMITTED ----
  // An order's outstanding commitment is its ceiling less what it has already
  // turned into actual cost. Floored at zero: an over-invoiced order has no
  // remaining commitment, and a negative commitment would understate spend.
  let committedTotal = ZERO
  const committedByClin = new Map<string | null, Dec>()
  for (const po of orders) {
    const posted = po.invoices.reduce((s, i) => s.plus(D(i.amount)), ZERO)
    const outstanding = D(po.ceilingAmount).minus(posted)
    const commitment = outstanding.isNegative() ? ZERO : outstanding
    committedTotal = committedTotal.plus(commitment)
    committedByClin.set(po.clinId, (committedByClin.get(po.clinId) ?? ZERO).plus(commitment))
  }
  committedTotal = money2(committedTotal)

  // ---- ACTUAL grouped ----
  const actualByCategory = new Map<BudgetCategory, Dec>()
  actualByCategory.set(BudgetCategory.LABOR, labor)
  for (const c of approvedCosts) {
    const key = costCategoryToBudget(c.category)
    actualByCategory.set(key, (actualByCategory.get(key) ?? ZERO).plus(D(c.amount)))
  }

  const actualByClin = new Map<string | null, Dec>()
  for (const t of approvedTime) {
    actualByClin.set(t.clinId, (actualByClin.get(t.clinId) ?? ZERO).plus(D(t.billingAmount)))
  }
  for (const c of approvedCosts) {
    actualByClin.set(c.clinId, (actualByClin.get(c.clinId) ?? ZERO).plus(D(c.amount)))
  }

  const actualBreakdown = {
    labor: money2(labor).toFixed(2),
    nonLabor: money2(nonLabor).toFixed(2),
    subcontract: money2(subcontractActual).toFixed(2),
  }

  if (!budget) {
    return {
      contractId,
      budgetId: null,
      budgetVersion: null,
      budgetStatus: null,
      hasBudget: false,
      dataNote:
        'No active budget exists for this contract. Actual and committed cost are reported; remaining and variance are not, because there is no plan to compare against.',
      totals: {
        budget: null,
        actual: actualTotal.toFixed(2),
        committed: committedTotal.toFixed(2),
        remaining: null,
        variance: null,
        variancePercent: null,
        overBudget: false,
      },
      byCategory: [],
      byClin: [],
      actualBreakdown,
    }
  }

  // ---- BUDGET grouped ----
  const budgetByCategory = new Map<BudgetCategory, Dec>()
  const budgetByClin = new Map<string | null, Dec>()
  for (const line of budget.lines) {
    budgetByCategory.set(line.category, (budgetByCategory.get(line.category) ?? ZERO).plus(D(line.plannedAmount)))
    budgetByClin.set(line.clinId, (budgetByClin.get(line.clinId) ?? ZERO).plus(D(line.plannedAmount)))
  }
  const budgetTotal = money2(budget.lines.reduce((s, l) => s.plus(D(l.plannedAmount)), ZERO))

  const build = (
    key: { category?: BudgetCategory; clinId?: string | null },
    b: Dec,
    a: Dec,
    c: Dec,
  ): BudgetLineComparison => {
    const remaining = money2(b.minus(a).minus(c))
    const variance = money2(b.minus(a).minus(c))
    return {
      category: key.category ?? BudgetCategory.OTHER,
      clinId: key.clinId ?? null,
      clinNumber: key.clinId ? clinNumber.get(key.clinId) ?? null : null,
      budget: money2(b).toFixed(2),
      actual: money2(a).toFixed(2),
      committed: money2(c).toFixed(2),
      remaining: remaining.toFixed(2),
      variance: variance.toFixed(2),
      variancePercent: pct(variance, b),
      overBudget: remaining.isNegative(),
    }
  }

  const categories = new Set<BudgetCategory>([...budgetByCategory.keys(), ...actualByCategory.keys()])
  const byCategory = [...categories]
    .filter((cat) => !(budgetByCategory.get(cat) ?? ZERO).isZero() || !(actualByCategory.get(cat) ?? ZERO).isZero())
    .map((cat) =>
      build(
        { category: cat },
        budgetByCategory.get(cat) ?? ZERO,
        actualByCategory.get(cat) ?? ZERO,
        // Purchase orders are commitments against the subcontract line.
        cat === BudgetCategory.SUBCONTRACT ? committedTotal : ZERO,
      ),
    )
    .sort((x, y) => x.category.localeCompare(y.category))

  const clinKeys = new Set<string | null>([...budgetByClin.keys(), ...actualByClin.keys(), ...committedByClin.keys()])
  const byClin = [...clinKeys].map((cid) =>
    build(
      { clinId: cid },
      budgetByClin.get(cid) ?? ZERO,
      actualByClin.get(cid) ?? ZERO,
      committedByClin.get(cid) ?? ZERO,
    ),
  )

  const remainingTotal = money2(budgetTotal.minus(actualTotal).minus(committedTotal))

  return {
    contractId,
    budgetId: budget.id,
    budgetVersion: budget.versionNumber,
    budgetStatus: budget.status,
    hasBudget: true,
    dataNote:
      'Remaining is budget less actual incurred cost AND outstanding purchase-order commitments. Committed money is not available to spend twice.',
    totals: {
      budget: budgetTotal.toFixed(2),
      actual: actualTotal.toFixed(2),
      committed: committedTotal.toFixed(2),
      remaining: remainingTotal.toFixed(2),
      variance: remainingTotal.toFixed(2),
      variancePercent: pct(remainingTotal, budgetTotal),
      overBudget: remainingTotal.isNegative(),
    },
    byCategory,
    byClin,
    actualBreakdown,
  }
}

/** Centralised variance thresholds, so alerting cannot drift from reporting. */
export const BUDGET_THRESHOLDS = [
  { key: 'EXCEEDED', atOrAbovePct: 100, label: 'Budget exceeded' },
  { key: 'CRITICAL', atOrAbovePct: 90, label: '90% of budget consumed' },
  { key: 'WARNING', atOrAbovePct: 80, label: '80% of budget consumed' },
] as const

export type BudgetThresholdKey = (typeof BUDGET_THRESHOLDS)[number]['key']

/**
 * Highest breached threshold, counting actual AND committed against the plan —
 * a contract with 70% spent and 25% committed is at 95%, not 70%.
 */
export function budgetThresholdFor(result: BudgetVsActualResult): {
  key: BudgetThresholdKey
  label: string
  consumedPct: number
} | null {
  if (!result.hasBudget || result.totals.budget === null) return null
  const budget = D(result.totals.budget)
  if (budget.isZero()) return null
  const consumed = D(result.totals.actual).plus(D(result.totals.committed))
  const consumedPct = Number(consumed.dividedBy(budget).times(100).toDecimalPlaces(2))
  const hit = BUDGET_THRESHOLDS.find((t) => consumedPct >= t.atOrAbovePct)
  return hit ? { key: hit.key, label: hit.label, consumedPct } : null
}
