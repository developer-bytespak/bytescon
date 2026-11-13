// =============================================================
// "Use my rates" — a starting point for a new price, from the firm's own
// records, never invented.
//
//   Indirect rates  the firm's latest FINAL actual rate per type (Finance →
//                   Indirect rates); a type with none falls back to the last
//                   approved price.
//   Labour + fee    the last approved price on another opportunity (its
//                   preferred scenario): categories, people, rates and hours
//                   as a starting estimate, each noting where it came from.
//
// Only adds what the scenario doesn't have yet (by category name / rate type);
// a person then adjusts hours and rates for this job. Pure planning in
// `planStartingPoint`; `loadStartingPointSources` reads the records.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'

/** The usual base for each indirect rate type. */
export const DEFAULT_COST_BASE: Record<string, string> = {
  FRINGE: 'DIRECT_LABOUR',
  OVERHEAD: 'LABOUR_PLUS_FRINGE',
  GA: 'TOTAL_DIRECT_COST',
  MATERIAL_HANDLING: 'MATERIAL_COST',
  SUBCONTRACT_HANDLING: 'SUBCONTRACTOR_COST',
  FEE: 'TOTAL_DIRECT_COST',
  OTHER: 'TOTAL_DIRECT_COST',
}
const RATE_NAME: Record<string, string> = { FRINGE: 'Fringe', OVERHEAD: 'Overhead', GA: 'G&A', MATERIAL_HANDLING: 'Material handling', SUBCONTRACT_HANDLING: 'Subcontract handling', FEE: 'Profit / fee', OTHER: 'Other' }

export interface SourceLabour { categoryName: string; categoryCode: string | null; personnelCount: number | null; hours: Prisma.Decimal; baseRate: Prisma.Decimal; periodLabel: string | null; escalationPct: Prisma.Decimal }
export interface SourceRate { rateType: string; name: string; percent: Prisma.Decimal; costBase: string }
export interface StartingPointSources {
  /** Latest FINAL actual per rate type (Finance). */
  actuals: Array<{ rateType: string; poolName: string | null; actualRate: Prisma.Decimal; fiscalYear: number }>
  /** The last approved price elsewhere, if any. */
  lastPrice: { title: string; opportunityTitle: string; labour: SourceLabour[]; rates: SourceRate[] } | null
}
export interface ExistingScenario { labourNames: string[]; rateTypes: string[] }

export interface StartingPointPlan {
  labour: Array<SourceLabour & { notes: string }>
  rates: Array<{ rateType: string; name: string; percent: Prisma.Decimal; costBase: string; source: string }>
  /** Where each kind came from, for the message. */
  from: string[]
}

export function planStartingPoint(src: StartingPointSources, existing: ExistingScenario): StartingPointPlan {
  const haveLabour = new Set(existing.labourNames.map((n) => n.trim().toLowerCase()))
  const haveRate = new Set(existing.rateTypes)
  const from = new Set<string>()
  const rates: StartingPointPlan['rates'] = []

  for (const a of src.actuals) {
    if (haveRate.has(a.rateType)) continue
    rates.push({ rateType: a.rateType, name: a.poolName || RATE_NAME[a.rateType] || a.rateType, percent: a.actualRate, costBase: DEFAULT_COST_BASE[a.rateType] ?? 'TOTAL_DIRECT_COST', source: `Finance actual rates, FY${a.fiscalYear}` })
    haveRate.add(a.rateType)
    from.add('your actual indirect rates (Finance)')
  }
  const lp = src.lastPrice
  if (lp) {
    for (const r of lp.rates) {
      if (haveRate.has(r.rateType)) continue
      rates.push({ ...r, source: `Last approved price: ${lp.opportunityTitle}` })
      haveRate.add(r.rateType)
      from.add(`your last approved price (${lp.opportunityTitle})`)
    }
  }
  const labour: StartingPointPlan['labour'] = []
  if (lp) {
    for (const l of lp.labour) {
      if (haveLabour.has(l.categoryName.trim().toLowerCase())) continue
      labour.push({ ...l, notes: `From your price for "${lp.opportunityTitle}": adjust the hours for this job.` })
      haveLabour.add(l.categoryName.trim().toLowerCase())
      from.add(`your last approved price (${lp.opportunityTitle})`)
    }
  }
  return { labour, rates, from: [...from] }
}

export async function loadStartingPointSources(consultingFirmId: string, excludeOpportunityId: string): Promise<StartingPointSources> {
  const finals = await prisma.actualIndirectRate.findMany({
    where: { consultingFirmId, status: 'FINAL' },
    orderBy: [{ periodEnd: 'desc' }, { updatedAt: 'desc' }],
    select: { rateType: true, poolName: true, actualRate: true, fiscalYear: true },
  })
  const latest = new Map<string, (typeof finals)[number]>()
  for (const f of finals) if (!latest.has(f.rateType)) latest.set(f.rateType, f)

  const ws = await prisma.pricingWorkspace.findFirst({
    where: { consultingFirmId, status: 'APPROVED', isArchived: false, opportunityId: { not: excludeOpportunityId } },
    orderBy: [{ approvedAt: 'desc' }, { updatedAt: 'desc' }],
    select: { title: true, opportunityId: true, preferredScenarioId: true, scenarios: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' }, select: { id: true } } },
  })
  let lastPrice: StartingPointSources['lastPrice'] = null
  const scenarioId = ws?.preferredScenarioId ?? ws?.scenarios[0]?.id
  if (ws && scenarioId) {
    const [opp, labour, rates] = await Promise.all([
      prisma.opportunity.findUnique({ where: { id: ws.opportunityId }, select: { title: true } }),
      prisma.pricingLaborLine.findMany({ where: { scenarioId, isActive: true }, orderBy: { sortOrder: 'asc' }, select: { categoryName: true, categoryCode: true, personnelCount: true, hours: true, baseRate: true, periodLabel: true, escalationPct: true } }),
      prisma.pricingIndirectRate.findMany({ where: { scenarioId, isActive: true }, orderBy: { sortOrder: 'asc' }, select: { rateType: true, name: true, percent: true, costBase: true } }),
    ])
    lastPrice = { title: ws.title, opportunityTitle: opp?.title ?? ws.title, labour, rates }
  }
  return { actuals: [...latest.values()], lastPrice }
}
