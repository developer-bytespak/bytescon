// =============================================================
// Contract modification math (Section 5 Module 8D)
//
// Applying a modification adjusts the contract's funded/ceiling totals and
// period dates. The arithmetic is decimal-safe (Prisma.Decimal / decimal.js) so
// financial values never suffer float drift. Pure + side-effect-free; the route
// wraps this in a transaction guarded by `appliedAt` for idempotency.
// =============================================================
import { Prisma } from '@prisma/client'

export type ModStatus = 'DRAFT' | 'RECORDED' | 'APPLIED' | 'VOIDED'

export interface ContractTotals {
  fundedValue: Prisma.Decimal | null
  ceilingValue: Prisma.Decimal | null
  startDate: Date | null
  endDate: Date | null
}

export interface ModChanges {
  fundingChange?: Prisma.Decimal | number | null
  ceilingChange?: Prisma.Decimal | number | null
  startDateChange?: Date | null
  endDateChange?: Date | null
}

const asDecimal = (v: Prisma.Decimal | number | null | undefined): Prisma.Decimal => new Prisma.Decimal(v ?? 0)

/**
 * Compute the contract totals AFTER applying a modification's deltas. Null base
 * values are treated as 0 for the increment (so a first funding action sets the
 * value); a null delta leaves that field unchanged. Deterministic + exact.
 */
export function computeContractAfterMod(before: ContractTotals, mod: ModChanges): ContractTotals {
  return {
    fundedValue:
      mod.fundingChange != null ? asDecimal(before.fundedValue).plus(asDecimal(mod.fundingChange)) : before.fundedValue,
    ceilingValue:
      mod.ceilingChange != null ? asDecimal(before.ceilingValue).plus(asDecimal(mod.ceilingChange)) : before.ceilingValue,
    startDate: mod.startDateChange ?? before.startDate,
    endDate: mod.endDateChange ?? before.endDate,
  }
}

/** A modification may only be applied from DRAFT or RECORDED, and only once. */
export function canApplyModification(status: ModStatus, appliedAt: Date | null): { ok: boolean; reason?: string } {
  if (appliedAt) return { ok: false, reason: 'Modification has already been applied' }
  if (status === 'APPLIED') return { ok: false, reason: 'Modification is already APPLIED' }
  if (status === 'VOIDED') return { ok: false, reason: 'A voided modification cannot be applied' }
  return { ok: true }
}
