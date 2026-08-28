// =============================================================
// §8.2 — Incurred-cost / audit readiness package.
//
// Assembles, for one fiscal period, the evidence a government auditor asks
// for: direct labour, direct costs, subcontract costs, what was billed, and
// the indirect rates in force — each traced to the CLIN it was recorded
// against.
//
// The part that matters most is `gaps`. A package that quietly omits
// unapproved time, or silently treats an unattributed cost as if it belonged
// somewhere, is worse than no package: it looks complete right up to the point
// an auditor finds the hole. So nothing is inferred, nothing is filled in, and
// every omission is named.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { D, money2 } from '../contractFinance'

export const AUDIT_PACKAGE_METHOD_VERSION = 'erp-audit-package-v1'

/** Only these ever count as incurred cost. Anything else is not yet a cost. */
const INCURRED_STATUS = 'APPROVED'

export interface AuditPackageGap {
  severity: 'BLOCKING' | 'REVIEW'
  area: string
  detail: string
  count: number
}

export interface AuditPackageContract {
  contractId: string
  contractNumber: string
  title: string
  agency: string | null
  directLabour: string
  directCosts: string
  subcontract: string
  totalIncurred: string
  billed: string
  collected: string
  byClin: Array<{
    clinId: string | null
    clinNumber: string | null
    clinLevel: string | null
    directLabour: string
    directCosts: string
    total: string
  }>
}

export interface AuditPackage {
  methodVersion: string
  fiscalYear: number
  periodStart: string
  periodEnd: string
  generatedAt: string
  contracts: AuditPackageContract[]
  totals: {
    directLabour: string
    directCosts: string
    subcontract: string
    totalIncurred: string
    billed: string
    collected: string
  }
  indirectRates: Array<{
    rateType: string
    poolName: string | null
    actualRate: string
    status: string
    isHumanVerified: boolean
    periodStart: string
    periodEnd: string
  }>
  gaps: AuditPackageGap[]
  /** Plain statements of what this package is and is not. */
  notes: string[]
}

/** A fiscal year, as a calendar year, unless the caller gives explicit dates. */
export function fiscalPeriod(fiscalYear: number, start?: Date | null, end?: Date | null): { start: Date; end: Date } {
  return {
    start: start ?? new Date(Date.UTC(fiscalYear, 0, 1, 0, 0, 0, 0)),
    end: end ?? new Date(Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999)),
  }
}

export async function buildAuditPackage(args: {
  consultingFirmId: string
  fiscalYear: number
  periodStart?: Date | null
  periodEnd?: Date | null
  contractId?: string | null
}): Promise<AuditPackage> {
  const { consultingFirmId } = args
  const { start, end } = fiscalPeriod(args.fiscalYear, args.periodStart, args.periodEnd)
  const scope = args.contractId ? { id: args.contractId } : {}

  const contracts = await prisma.contract.findMany({
    where: { consultingFirmId, isArchived: false, ...scope },
    select: { id: true, contractNumber: true, title: true, agency: true },
    orderBy: { contractNumber: 'asc' },
    take: 500,
  })
  const contractIds = contracts.map((c) => c.id)

  if (contractIds.length === 0) {
    return {
      methodVersion: AUDIT_PACKAGE_METHOD_VERSION,
      fiscalYear: args.fiscalYear,
      periodStart: start.toISOString(), periodEnd: end.toISOString(),
      generatedAt: new Date().toISOString(),
      contracts: [], totals: zeroTotals(), indirectRates: [],
      gaps: [{ severity: 'BLOCKING', area: 'Scope', detail: 'No contract falls in this period, so there is nothing to submit.', count: 0 }],
      notes: PACKAGE_NOTES,
    }
  }

  const [time, costs, invoices, rates, unapprovedTime, unapprovedCosts] = await Promise.all([
    prisma.timeEntry.findMany({
      where: { consultingFirmId, contractId: { in: contractIds }, status: INCURRED_STATUS, workDate: { gte: start, lte: end } },
      // Cost only. `billingAmount` is what the customer was charged and is a
      // different question — it is reported separately as "billed", from the
      // invoices, so this module never sums it.
      select: { contractId: true, clinId: true, costAmount: true },
    }),
    prisma.contractCost.findMany({
      where: { consultingFirmId, contractId: { in: contractIds }, status: INCURRED_STATUS, incurredDate: { gte: start, lte: end } },
      select: { contractId: true, clinId: true, amount: true, category: true },
    }),
    prisma.contractInvoice.findMany({
      where: { consultingFirmId, contractId: { in: contractIds }, status: { not: 'VOIDED' }, invoiceDate: { gte: start, lte: end } },
      select: { contractId: true, total: true, amountPaid: true },
    }),
    prisma.actualIndirectRate.findMany({
      where: { consultingFirmId, fiscalYear: args.fiscalYear, status: { not: 'SUPERSEDED' } },
      orderBy: [{ rateType: 'asc' }, { periodStart: 'asc' }],
    }),
    prisma.timeEntry.count({
      where: { consultingFirmId, contractId: { in: contractIds }, status: { notIn: [INCURRED_STATUS, 'REJECTED'] }, workDate: { gte: start, lte: end } },
    }),
    prisma.contractCost.count({
      where: { consultingFirmId, contractId: { in: contractIds }, status: { notIn: [INCURRED_STATUS, 'REJECTED'] }, incurredDate: { gte: start, lte: end } },
    }),
  ])

  const clins = await prisma.clin.findMany({
    where: { consultingFirmId, contractId: { in: contractIds } },
    select: { id: true, clinNumber: true, clinLevel: true },
  })
  const clinById = new Map(clins.map((c) => [c.id, c]))

  const rows: AuditPackageContract[] = contracts.map((c) => {
    const myTime = time.filter((t) => t.contractId === c.id)
    const myCosts = costs.filter((x) => x.contractId === c.id)
    const myInvoices = invoices.filter((i) => i.contractId === c.id)

    // Labour is taken at its COST, not its billing amount: an incurred-cost
    // submission reports what the work cost the firm, not what the customer
    // was charged for it.
    const labour = myTime.reduce((s, t) => s.plus(D(t.costAmount ?? 0)), D(0))
    const subcontract = myCosts.filter((x) => x.category === 'SUBCONTRACTOR').reduce((s, x) => s.plus(D(x.amount)), D(0))
    const other = myCosts.filter((x) => x.category !== 'SUBCONTRACTOR').reduce((s, x) => s.plus(D(x.amount)), D(0))

    const clinKeys = new Set<string | null>([
      ...myTime.map((t) => t.clinId),
      ...myCosts.map((x) => x.clinId),
    ])
    const byClin = [...clinKeys].map((clinId) => {
      const l = myTime.filter((t) => t.clinId === clinId).reduce((s, t) => s.plus(D(t.costAmount ?? 0)), D(0))
      const d = myCosts.filter((x) => x.clinId === clinId).reduce((s, x) => s.plus(D(x.amount)), D(0))
      const clin = clinId ? clinById.get(clinId) : null
      return {
        clinId,
        clinNumber: clin?.clinNumber ?? null,
        clinLevel: clin?.clinLevel ?? null,
        directLabour: money2(l).toFixed(2),
        directCosts: money2(d).toFixed(2),
        total: money2(l.plus(d)).toFixed(2),
      }
    }).sort((a, b) => (a.clinNumber ?? 'zzz').localeCompare(b.clinNumber ?? 'zzz'))

    return {
      contractId: c.id, contractNumber: c.contractNumber, title: c.title, agency: c.agency,
      byClin,
      directLabour: money2(labour).toFixed(2),
      directCosts: money2(other).toFixed(2),
      subcontract: money2(subcontract).toFixed(2),
      totalIncurred: money2(labour.plus(other).plus(subcontract)).toFixed(2),
      billed: money2(myInvoices.reduce((s, i) => s.plus(D(i.total)), D(0))).toFixed(2),
      collected: money2(myInvoices.reduce((s, i) => s.plus(D(i.amountPaid)), D(0))).toFixed(2),
    }
  })

  const sum = (pick: (r: AuditPackageContract) => string) =>
    money2(rows.reduce((s, r) => s.plus(D(pick(r))), D(0))).toFixed(2)

  // ---- What would fail an audit, said out loud ----------------------------
  const gaps: AuditPackageGap[] = []

  if (unapprovedTime > 0) {
    gaps.push({
      severity: 'BLOCKING', area: 'Timekeeping', count: unapprovedTime,
      detail: unapprovedTime === 1
        ? '1 time entry is still unapproved in this period and is therefore excluded. Approve or reject it before submitting.'
        : `${unapprovedTime} time entries are still unapproved in this period and are therefore excluded. Approve or reject them before submitting.`,
    })
  }
  if (unapprovedCosts > 0) {
    gaps.push({
      severity: 'BLOCKING', area: 'Direct costs', count: unapprovedCosts,
      detail: unapprovedCosts === 1
        ? '1 cost is still unapproved in this period and is therefore excluded.'
        : `${unapprovedCosts} costs are still unapproved in this period and are therefore excluded.`,
    })
  }

  const labourNoRate = time.filter((t) => t.costAmount == null).length
  if (labourNoRate > 0) {
    gaps.push({
      severity: 'BLOCKING', area: 'Labour cost', count: labourNoRate,
      detail: `${labourNoRate} approved time entr${labourNoRate === 1 ? 'y has' : 'ies have'} no cost rate on the work date, so ${labourNoRate === 1 ? 'it contributes' : 'they contribute'} nothing to incurred cost.`,
    })
  }

  const unattributed = time.filter((t) => t.clinId == null).length + costs.filter((c) => c.clinId == null).length
  if (unattributed > 0) {
    gaps.push({
      severity: 'REVIEW', area: 'CLIN attribution', count: unattributed,
      detail: `${unattributed} record${unattributed === 1 ? '' : 's'} carr${unattributed === 1 ? 'ies' : 'y'} no CLIN. They are included in the contract total but cannot be shown against a line.`,
    })
  }

  if (rates.length === 0) {
    gaps.push({
      severity: 'BLOCKING', area: 'Indirect rates', count: 0,
      detail: `No actual indirect rate has been recorded for FY${args.fiscalYear}. An incurred-cost submission needs the pools that were actually experienced.`,
    })
  } else {
    const unverified = rates.filter((r) => !r.isHumanVerified).length
    if (unverified > 0) {
      gaps.push({
        severity: 'REVIEW', area: 'Indirect rates', count: unverified,
        detail: `${unverified} recorded rate${unverified === 1 ? ' has' : 's have'} not been verified by a person.`,
      })
    }
  }

  return {
    methodVersion: AUDIT_PACKAGE_METHOD_VERSION,
    fiscalYear: args.fiscalYear,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    generatedAt: new Date().toISOString(),
    contracts: rows,
    totals: {
      directLabour: sum((r) => r.directLabour),
      directCosts: sum((r) => r.directCosts),
      subcontract: sum((r) => r.subcontract),
      totalIncurred: sum((r) => r.totalIncurred),
      billed: sum((r) => r.billed),
      collected: sum((r) => r.collected),
    },
    indirectRates: rates.map((r) => ({
      rateType: r.rateType,
      poolName: r.poolName,
      actualRate: (r.actualRate as Prisma.Decimal).toFixed(4),
      status: r.status,
      isHumanVerified: r.isHumanVerified,
      periodStart: r.periodStart.toISOString(),
      periodEnd: r.periodEnd.toISOString(),
    })),
    gaps,
    notes: PACKAGE_NOTES,
  }
}

const PACKAGE_NOTES = [
  'Only APPROVED time and costs count as incurred. Anything still awaiting a decision is excluded and listed as a gap.',
  'Labour is reported at its cost rate, not its billing rate. What the customer was charged is shown separately as "billed".',
  'Indirect rates are the actual rates a person recorded. The platform never derives an actual rate from a provisional one.',
  'This is an evidence package assembled from the firm’s own records. It is not a filed submission, and no schedule is transmitted anywhere.',
]

function zeroTotals() {
  return { directLabour: '0.00', directCosts: '0.00', subcontract: '0.00', totalIncurred: '0.00', billed: '0.00', collected: '0.00' }
}

/** The same package as CSV, one section per schedule. */
export function auditPackageToCsv(pkg: AuditPackage): string {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows: string[][] = [
    ['Incurred cost evidence package'],
    ['Fiscal year', String(pkg.fiscalYear)],
    ['Period', pkg.periodStart.slice(0, 10), pkg.periodEnd.slice(0, 10)],
    ['Generated', pkg.generatedAt],
    ['Method', pkg.methodVersion],
    [],
    ['Schedule A — incurred cost by contract'],
    ['Contract', 'Title', 'Agency', 'Direct labour', 'Direct costs', 'Subcontract', 'Total incurred', 'Billed', 'Collected'],
    ...pkg.contracts.map((c) => [c.contractNumber, c.title, c.agency ?? '', c.directLabour, c.directCosts, c.subcontract, c.totalIncurred, c.billed, c.collected]),
    ['TOTAL', '', '', pkg.totals.directLabour, pkg.totals.directCosts, pkg.totals.subcontract, pkg.totals.totalIncurred, pkg.totals.billed, pkg.totals.collected],
    [],
    ['Schedule B — incurred cost by CLIN'],
    ['Contract', 'CLIN', 'Tier', 'Direct labour', 'Direct costs', 'Total'],
    ...pkg.contracts.flatMap((c) => c.byClin.map((k) => [
      c.contractNumber, k.clinNumber ?? '(unattributed)', k.clinLevel ?? '', k.directLabour, k.directCosts, k.total,
    ])),
    [],
    ['Schedule C — actual indirect rates'],
    ['Pool', 'Pool name', 'Rate %', 'Period start', 'Period end', 'Status', 'Verified'],
    ...pkg.indirectRates.map((r) => [
      r.rateType, r.poolName ?? '', r.actualRate, r.periodStart.slice(0, 10), r.periodEnd.slice(0, 10), r.status, r.isHumanVerified ? 'YES' : 'NO',
    ]),
    [],
    ['Gaps — what is missing or unverified'],
    ['Severity', 'Area', 'Count', 'Detail'],
    ...pkg.gaps.map((g) => [g.severity, g.area, String(g.count), g.detail]),
    [],
    ['Notes'],
    ...pkg.notes.map((n) => [n]),
  ]
  return rows.map((r) => r.map(esc).join(',')).join('\n')
}
