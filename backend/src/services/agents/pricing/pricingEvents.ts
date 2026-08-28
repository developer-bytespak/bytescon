// =============================================================
// §7.6 — Pricing Agent triggers.
//
// Two events are NEW here: PRICING_SCENARIO_CHANGED and INDIRECT_RATE_CHANGED.
// The other two the agent subscribes to already exist and are NOT duplicated:
// BID_DECISION_RECORDED (§7.5, emitted from the canonical human decision) and
// AMENDMENT_RECORDED (§7.3, emitted from the amendment persistence path).
//
// Both new events go through the §7.0 transactional outbox inside the same
// transaction as the write they describe, and both carry IDs and a fingerprint
// only — never a rate, an hour count, or a price. A tenant's pricing figures
// must not sit in an event payload.
// =============================================================
import { Prisma } from '@prisma/client'
import { emitAgentEvent } from '../outbox'

export const PRICING_SCENARIO_CHANGED = 'PRICING_SCENARIO_CHANGED'
export const INDIRECT_RATE_CHANGED = 'INDIRECT_RATE_CHANGED'

export const PRICING_SCENARIO_ENTITY_TYPE = 'PricingScenario'
export const PRICING_TEMPLATE_ENTITY_TYPE = 'PricingTemplate'

/** The numbers that define a scenario's pricing identity. */
export interface PricingFingerprintInput {
  laborLines: Array<{
    categoryName: string
    hours: Prisma.Decimal | number | string
    baseRate: Prisma.Decimal | number | string
    escalationPct: Prisma.Decimal | number | string
    personnelCount: number | null
    isActive: boolean
  }>
  indirectRates: Array<{
    rateType: string
    percent: Prisma.Decimal | number | string
    costBase: string
    isActive: boolean
  }>
  otherCosts: Array<{
    costCategory: string
    quantity: Prisma.Decimal | number | string
    unitCost: Prisma.Decimal | number | string
  }>
}

const dec = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v).toFixed(4)

/**
 * A normalized fingerprint of everything that MATERIALLY affects pricing.
 *
 * Deliberately excludes description, notes, sortOrder and the scenario name, so
 * renaming a scenario or reordering lines emits nothing. Deliberately includes
 * hours, rates, escalation, cost bases and quantities, because any of those
 * changes the price and therefore the benchmark comparison.
 *
 * Entries are sorted, so re-saving identical lines in a different order
 * produces the same fingerprint and no event.
 */
export function pricingFingerprint(input: PricingFingerprintInput): string {
  const labor = input.laborLines
    .map((l) => [l.categoryName.trim(), dec(l.hours), dec(l.baseRate), dec(l.escalationPct), String(l.personnelCount ?? ''), String(l.isActive)].join('|'))
    .sort()
  const indirect = input.indirectRates
    .map((r) => [r.rateType, dec(r.percent), r.costBase, String(r.isActive)].join('|'))
    .sort()
  const other = input.otherCosts
    .map((o) => [o.costCategory, dec(o.quantity), dec(o.unitCost)].join('|'))
    .sort()
  return JSON.stringify({ labor, indirect, other })
}

/** True when the pricing identity actually moved. */
export function pricingChangedMaterially(before: string | null, after: string): boolean {
  return before !== after
}

/**
 * A pricing scenario's numbers changed.
 *
 * Emitted from `recomputeScenario` — the one chokepoint every labour, indirect,
 * other-cost and scenario mutation already funnels through — so there is
 * exactly one emitter no matter which route did the writing.
 */
export function emitPricingScenarioChanged(
  args: {
    consultingFirmId: string
    scenarioId: string
    workspaceId: string
    opportunityId: string | null
    /** Digest only. The fingerprint itself carries rates and is never sent. */
    fingerprintHash: string
  },
  tx: Prisma.TransactionClient,
): Promise<{ eventId: string | null; created: boolean }> {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: PRICING_SCENARIO_CHANGED,
      entityType: PRICING_SCENARIO_ENTITY_TYPE,
      entityId: args.scenarioId,
      payload: {
        scenarioId: args.scenarioId,
        workspaceId: args.workspaceId,
        opportunityId: args.opportunityId,
        fingerprintHash: args.fingerprintHash,
      },
      // Keyed on the fingerprint: re-saving the same numbers never re-fires,
      // and a genuinely different set of numbers does.
      dedupeKey: `pricing-scenario:${args.consultingFirmId}:${args.scenarioId}:${args.fingerprintHash}`,
    },
    tx,
  )
}

/**
 * A reusable rate source changed.
 *
 * ONE event per logical rate update. It carries the template id and a digest of
 * the new rate set — never the rates themselves — because the handler re-reads
 * them under its own tenant scope.
 *
 * Emitting this does NOT change any scenario. Scenario rates are human-entered
 * snapshots; the agent reports drift and a person decides.
 */
export function emitIndirectRateChanged(
  args: {
    consultingFirmId: string
    templateId: string
    rateSetHash: string
  },
  tx: Prisma.TransactionClient,
): Promise<{ eventId: string | null; created: boolean }> {
  return emitAgentEvent(
    {
      consultingFirmId: args.consultingFirmId,
      eventType: INDIRECT_RATE_CHANGED,
      entityType: PRICING_TEMPLATE_ENTITY_TYPE,
      entityId: args.templateId,
      payload: { templateId: args.templateId, rateSetHash: args.rateSetHash },
      dedupeKey: `indirect-rate:${args.consultingFirmId}:${args.templateId}:${args.rateSetHash}`,
    },
    tx,
  )
}

/** Normalized digest of a template's indirect rate set. */
export function templateRateFingerprint(
  indirectRatesJson: unknown,
  feeDefaultPct: Prisma.Decimal | null,
): string {
  const rates = Array.isArray(indirectRatesJson) ? indirectRatesJson : []
  const normalised = rates
    .map((r) => {
      const row = (r ?? {}) as Record<string, unknown>
      const percent = row.percent
      return [
        String(row.rateType ?? ''),
        percent === undefined || percent === null ? '' : dec(percent as Prisma.Decimal.Value),
        String(row.costBase ?? ''),
      ].join('|')
    })
    .sort()
  return JSON.stringify({ rates: normalised, fee: feeDefaultPct ? dec(feeDefaultPct) : null })
}
