// =============================================================
// Pricing & rate build-up calculation engine (§5.1 Stage 6 / §5.2).
//
// The BACKEND is the authoritative source for every pricing figure. All money
// math uses Prisma.Decimal (decimal.js) — NEVER JavaScript floating point. Pure
// and deterministic so the whole build-up is unit-testable.
//
// Deterministic calculation order (fixed family order → no circular application):
//   1. Direct labour   = Σ line( hours × baseRate × (1 + escalationPct/100) )
//   2. Fringe          = Σ fringe-rate( base × pct )              base ∈ {DL, material, subK}
//   3. Overhead        = Σ overhead/handling-rate( base × pct )   base ∈ {DL, DL+fringe, material, subK}
//   4. ODC             = Σ other-cost lines (non-subcontractor)
//   5. Subcontractor   = Σ other-cost lines (SUBCONTRACTOR category)
//   6. G&A             = Σ ga-rate( base × pct )                  base ∈ {totalDirectCost, DL+fringe, DL}
//   7. Fee             = Σ fee-rate( subtotalBeforeFee × pct )
//   8. Total price     = subtotalBeforeFee + fee
// where totalDirectCost = DL + fringe + overhead + ODC + subK
//       subtotalBeforeFee = totalDirectCost + G&A
//
// Rounding: money2 (2 dp, ROUND_HALF_UP) at each aggregation boundary. Rate
// percentages are applied as pct/100. Circular base references (e.g. fringe on
// TOTAL_DIRECT_COST) are rejected by validateRateBase — never silently computed.
// =============================================================
import { Prisma } from '@prisma/client'
import { D, money2 } from './contractFinance'

export const RATE_TYPES = ['FRINGE', 'OVERHEAD', 'GA', 'MATERIAL_HANDLING', 'SUBCONTRACT_HANDLING', 'FEE', 'OTHER'] as const
export type RateType = (typeof RATE_TYPES)[number]
export const COST_BASES = ['DIRECT_LABOUR', 'LABOUR_PLUS_FRINGE', 'TOTAL_DIRECT_COST', 'SUBCONTRACTOR_COST', 'MATERIAL_COST', 'CUSTOM_SUPPORTED_BASE'] as const
export type CostBase = (typeof COST_BASES)[number]
export const OTHER_COST_CATEGORIES = ['TRAVEL', 'MATERIALS', 'EQUIPMENT', 'SUPPLIES', 'ODC', 'SUBCONTRACTOR', 'CONSULTANT', 'OTHER'] as const

export interface LaborLineInput {
  hours: Prisma.Decimal | number | string
  baseRate: Prisma.Decimal | number | string
  escalationPct?: Prisma.Decimal | number | string | null
  personnelCount?: number | null
  isActive?: boolean
}
export interface IndirectRateInput {
  rateType: string
  percent: Prisma.Decimal | number | string
  costBase: string
  isActive?: boolean
}
export interface OtherCostInput {
  costCategory: string
  quantity: Prisma.Decimal | number | string
  unitCost: Prisma.Decimal | number | string
}

export interface PricingTotals {
  totalDirectLabor: Prisma.Decimal
  totalFringe: Prisma.Decimal
  totalOverhead: Prisma.Decimal
  totalOdc: Prisma.Decimal
  totalSubcontractor: Prisma.Decimal
  totalGA: Prisma.Decimal
  subtotalBeforeFee: Prisma.Decimal
  totalFee: Prisma.Decimal
  totalPrice: Prisma.Decimal
}

// Allowed cost bases per rate family — anything else is circular / unsupported.
const ALLOWED_BASES: Record<string, CostBase[]> = {
  FRINGE: ['DIRECT_LABOUR', 'MATERIAL_COST', 'SUBCONTRACTOR_COST', 'CUSTOM_SUPPORTED_BASE'],
  OVERHEAD: ['DIRECT_LABOUR', 'LABOUR_PLUS_FRINGE', 'MATERIAL_COST', 'SUBCONTRACTOR_COST', 'CUSTOM_SUPPORTED_BASE'],
  MATERIAL_HANDLING: ['MATERIAL_COST', 'DIRECT_LABOUR', 'CUSTOM_SUPPORTED_BASE'],
  SUBCONTRACT_HANDLING: ['SUBCONTRACTOR_COST', 'DIRECT_LABOUR', 'CUSTOM_SUPPORTED_BASE'],
  OTHER: ['DIRECT_LABOUR', 'LABOUR_PLUS_FRINGE', 'MATERIAL_COST', 'SUBCONTRACTOR_COST', 'CUSTOM_SUPPORTED_BASE'],
  GA: ['TOTAL_DIRECT_COST', 'LABOUR_PLUS_FRINGE', 'DIRECT_LABOUR', 'CUSTOM_SUPPORTED_BASE'],
  FEE: ['TOTAL_DIRECT_COST', 'LABOUR_PLUS_FRINGE', 'DIRECT_LABOUR', 'SUBCONTRACTOR_COST', 'MATERIAL_COST', 'CUSTOM_SUPPORTED_BASE'],
}

/** True when (rateType, costBase) is a supported, non-circular pairing. */
export function validateRateBase(rateType: string, costBase: string): boolean {
  const allowed = ALLOWED_BASES[rateType]
  return !!allowed && (allowed as string[]).includes(costBase)
}

/** direct-labour amount for one line = hours × baseRate × (1 + escalation%/100). */
export function laborLineAmount(line: LaborLineInput): Prisma.Decimal {
  const esc = D(line.escalationPct ?? 0).div(100).plus(1)
  return money2(D(line.hours).times(D(line.baseRate)).times(esc))
}

function pctOf(base: Prisma.Decimal, percent: Prisma.Decimal | number | string): Prisma.Decimal {
  return money2(base.times(D(percent).div(100)))
}

// Deterministic, decimal-safe build-up. `unsupportedRates` lists any rate whose
// (rateType, costBase) pairing was rejected — those contribute 0 (never a wrong,
// silently-circular number).
export function computePricing(
  labor: LaborLineInput[],
  indirects: IndirectRateInput[],
  others: OtherCostInput[],
): PricingTotals & { unsupportedRates: number } {
  const active = <T extends { isActive?: boolean }>(xs: T[]) => xs.filter((x) => x.isActive !== false)

  const totalDirectLabor = money2(active(labor).reduce((s, l) => s.plus(laborLineAmount(l)), D(0)))

  const otherTotal = (predicate: (c: string) => boolean) =>
    money2(others.filter((o) => predicate(o.costCategory)).reduce((s, o) => s.plus(D(o.quantity).times(D(o.unitCost))), D(0)))
  const totalSubcontractor = otherTotal((c) => c === 'SUBCONTRACTOR')
  const totalOdc = otherTotal((c) => c !== 'SUBCONTRACTOR')
  const materialBase = otherTotal((c) => c === 'MATERIALS')

  let unsupportedRates = 0
  const rated = active(indirects)
  const sumFamily = (
    families: string[],
    resolveBase: (costBase: string) => Prisma.Decimal | null,
  ): Prisma.Decimal =>
    money2(
      rated
        .filter((r) => families.includes(r.rateType))
        .reduce((s, r) => {
          if (!validateRateBase(r.rateType, r.costBase)) { unsupportedRates++; return s }
          const base = resolveBase(r.costBase)
          if (base === null) { unsupportedRates++; return s }
          return s.plus(pctOf(base, r.percent))
        }, D(0)),
    )

  // 2. Fringe (bases finalized before this stage: DL, material, subK)
  const totalFringe = sumFamily(['FRINGE'], (b) =>
    b === 'DIRECT_LABOUR' ? totalDirectLabor
      : b === 'MATERIAL_COST' ? materialBase
      : b === 'SUBCONTRACTOR_COST' ? totalSubcontractor
      : b === 'CUSTOM_SUPPORTED_BASE' ? totalDirectLabor
      : null)

  const laborPlusFringe = money2(totalDirectLabor.plus(totalFringe))

  // 3. Overhead + handling pools (fringe now final)
  const totalOverhead = sumFamily(['OVERHEAD', 'MATERIAL_HANDLING', 'SUBCONTRACT_HANDLING', 'OTHER'], (b) =>
    b === 'DIRECT_LABOUR' ? totalDirectLabor
      : b === 'LABOUR_PLUS_FRINGE' ? laborPlusFringe
      : b === 'MATERIAL_COST' ? materialBase
      : b === 'SUBCONTRACTOR_COST' ? totalSubcontractor
      : b === 'CUSTOM_SUPPORTED_BASE' ? totalDirectLabor
      : null)

  const totalDirectCost = money2(totalDirectLabor.plus(totalFringe).plus(totalOverhead).plus(totalOdc).plus(totalSubcontractor))

  // 6. G&A (all direct cost finalized)
  const totalGA = sumFamily(['GA'], (b) =>
    b === 'TOTAL_DIRECT_COST' ? totalDirectCost
      : b === 'LABOUR_PLUS_FRINGE' ? laborPlusFringe
      : b === 'DIRECT_LABOUR' ? totalDirectLabor
      : b === 'CUSTOM_SUPPORTED_BASE' ? totalDirectCost
      : null)

  const subtotalBeforeFee = money2(totalDirectCost.plus(totalGA))

  // 7. Fee always applies to subtotal-before-fee (documented; base field ignored for FEE).
  const totalFee = money2(
    rated.filter((r) => r.rateType === 'FEE').reduce((s, r) => s.plus(pctOf(subtotalBeforeFee, r.percent)), D(0)),
  )

  const totalPrice = money2(subtotalBeforeFee.plus(totalFee))

  return { totalDirectLabor, totalFringe, totalOverhead, totalOdc, totalSubcontractor, totalGA, subtotalBeforeFee, totalFee, totalPrice, unsupportedRates }
}

/** escalated rate = previous rate × (1 + escalation%/100) — exposed for callers/tests. */
export function escalateRate(previousRate: Prisma.Decimal | number | string, escalationPct: Prisma.Decimal | number | string): Prisma.Decimal {
  return money2(D(previousRate).times(D(escalationPct).div(100).plus(1)).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP))
}

/** otherCost line total = quantity × unitCost, decimal-safe to cents. */
export function otherCostLineTotal(quantity: Prisma.Decimal | number | string, unitCost: Prisma.Decimal | number | string): Prisma.Decimal {
  return money2(D(quantity).times(D(unitCost)))
}
