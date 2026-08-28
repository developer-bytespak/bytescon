// =============================================================
// §7.8 — Indirect rate variance monitoring.
//
// A SEMANTIC WARNING, STATED IN THE OUTPUT RATHER THAN HIDDEN
// ------------------------------------------------------------
// The platform has no negotiated *contract provisional billing rate* model.
// What it has is:
//   · PricingIndirectRate  — an indirect rate inside one bid's pricing scenario
//   · PricingTemplate.indirectRatesJson — the firm's standard rate set, which is
//     firm-scoped, effective-dated and versioned
//
// The firm-level template is the closest thing to a planned/provisional rate,
// so that is what this module compares against. It is NOT the same thing as a
// rate negotiated with a contracting officer, and every variance carries
// `provisionalSource` and `semanticMapping` saying so. Comparing a proposal
// pricing assumption to a realised rate is a useful monitoring signal; calling
// it a provisional-billing-rate variance would be a false claim.
//
// The agent never writes either rate. An actual rate is source data supplied by
// a person or an import; a provisional rate belongs to pricing.
// =============================================================
import { Prisma } from '@prisma/client'
import { D } from '../../contractFinance'

export const RATE_VARIANCE_METHOD_VERSION = 'finance-rate-variance-v1'

/**
 * Monitoring thresholds on the RELATIVE variance, as a percentage.
 *
 * These are Bytescon product monitoring policy. They are not a DCAA rule, a
 * FAR threshold, or a statement about what is permissible — they decide only
 * when the product asks a person to look.
 */
export const VARIANCE_REVIEW_PCT = 5
export const VARIANCE_MATERIAL_PCT = 15

export type VarianceState =
  | 'WITHIN_MONITORING_RANGE'
  | 'REVIEW_RECOMMENDED'
  | 'MATERIAL_VARIANCE'
  | 'INSUFFICIENT_DATA'

/** Where the provisional side of the comparison came from. */
export type ProvisionalSource = 'PRICING_TEMPLATE' | 'PRICING_SCENARIO' | 'NONE'

/**
 * How well the two sides of the comparison actually correspond.
 *
 * `PROPOSAL_PRICING_TO_ACTUAL` is honest about the gap described in the header:
 * a planned bid rate is being monitored against a realised one.
 */
export type SemanticMapping = 'PROPOSAL_PRICING_TO_ACTUAL' | 'UNMAPPED'

export const SEMANTIC_MAPPING_NOTE =
  'The provisional side of this comparison is the firm’s pricing rate set, not a provisional billing rate negotiated with a contracting officer — the platform does not model one. Treat this as internal monitoring, not a billing-rate reconciliation.'

export interface ProvisionalRateInput {
  rateType: string
  percent: Prisma.Decimal
  source: ProvisionalSource
  sourceReference: string | null
  effectiveDate: Date | null
  endDate: Date | null
}

export interface ActualRateInput {
  id: string
  rateType: string
  poolName: string | null
  actualRate: Prisma.Decimal
  periodStart: Date
  periodEnd: Date
  fiscalYear: number
  status: string
  isHumanVerified: boolean
  source: string
  sourceReference: string | null
}

export interface RateVarianceResult {
  rateType: string
  poolName: string | null
  period: { start: string; end: string; fiscalYear: number }
  provisionalRate: string | null
  actualRate: string | null
  /** actual − provisional, in rate points. Positive = the actual ran higher. */
  absoluteVariance: string | null
  /** As a percentage OF the provisional rate. Null when provisional is zero. */
  relativeVariancePct: number | null
  state: VarianceState
  provisionalSource: ProvisionalSource
  semanticMapping: SemanticMapping
  actualRateId: string | null
  actualIsHumanVerified: boolean
  evidence: string[]
  limitations: string[]
  /** Stable while the compared pair is unchanged. */
  dedupeKey: string
}

/**
 * Does a provisional rate apply during an actual rate's period?
 *
 * An open-ended template (no dates) applies to everything; that is the common
 * case and treating it as inapplicable would silence all monitoring.
 */
function appliesToPeriod(provisional: ProvisionalRateInput, periodStart: Date, periodEnd: Date): boolean {
  if (provisional.effectiveDate && provisional.effectiveDate > periodEnd) return false
  if (provisional.endDate && provisional.endDate < periodStart) return false
  return true
}

/** State from the relative variance. Absolute-only comparisons cannot be graded. */
export function varianceState(relativePct: number | null): VarianceState {
  if (relativePct === null) return 'INSUFFICIENT_DATA'
  const abs = Math.abs(relativePct)
  if (abs >= VARIANCE_MATERIAL_PCT) return 'MATERIAL_VARIANCE'
  if (abs >= VARIANCE_REVIEW_PCT) return 'REVIEW_RECOMMENDED'
  return 'WITHIN_MONITORING_RANGE'
}

/**
 * Compare each actual rate to the applicable provisional rate of the same type.
 *
 * An actual with no matching provisional is reported as INSUFFICIENT_DATA, not
 * dropped and not compared to zero — the firm may simply never have priced that
 * pool, and inventing a baseline would manufacture a variance.
 */
export function computeRateVariances(args: {
  provisionals: ProvisionalRateInput[]
  actuals: ActualRateInput[]
}): RateVarianceResult[] {
  const results: RateVarianceResult[] = []

  for (const actual of args.actuals) {
    const candidates = args.provisionals.filter(
      (p) => p.rateType === actual.rateType && appliesToPeriod(p, actual.periodStart, actual.periodEnd),
    )
    // Most recently effective wins; an undated template is the fallback.
    const provisional = candidates.sort((a, b) => {
      const at = a.effectiveDate?.getTime() ?? 0
      const bt = b.effectiveDate?.getTime() ?? 0
      return bt - at
    })[0] ?? null

    const evidence: string[] = [
      `Actual ${actual.rateType} rate ${D(actual.actualRate).toFixed(4)}% for ${actual.periodStart.toISOString().slice(0, 10)} to ${actual.periodEnd.toISOString().slice(0, 10)} (source: ${actual.source}${actual.sourceReference ? `, ${actual.sourceReference}` : ''}).`,
    ]
    const limitations: string[] = []

    if (!actual.isHumanVerified) {
      limitations.push(
        `The actual ${actual.rateType} rate for this period has not been verified by a person. The variance is computed from unverified source data.`,
      )
    }

    if (!provisional) {
      limitations.push(
        `No pricing rate of type ${actual.rateType} applies to this period, so there is no baseline to compare against. The agent does not substitute one.`,
      )
      results.push({
        rateType: actual.rateType,
        poolName: actual.poolName,
        period: {
          start: actual.periodStart.toISOString(),
          end: actual.periodEnd.toISOString(),
          fiscalYear: actual.fiscalYear,
        },
        provisionalRate: null,
        actualRate: D(actual.actualRate).toFixed(4),
        absoluteVariance: null,
        relativeVariancePct: null,
        state: 'INSUFFICIENT_DATA',
        provisionalSource: 'NONE',
        semanticMapping: 'UNMAPPED',
        actualRateId: actual.id,
        actualIsHumanVerified: actual.isHumanVerified,
        evidence,
        limitations,
        dedupeKey: `rate-variance:${actual.id}:UNMAPPED`,
      })
      continue
    }

    const prov = D(provisional.percent)
    const act = D(actual.actualRate)
    const diff = act.minus(prov)
    const relative = prov.eq(0) ? null : Math.round(Number(diff.div(prov)) * 100 * 100) / 100

    if (prov.eq(0)) {
      limitations.push(
        'The pricing rate for this pool is zero, so a relative variance cannot be expressed as a percentage. The absolute difference is still reported.',
      )
    }

    evidence.push(
      `Pricing ${provisional.rateType} rate ${prov.toFixed(4)}% (source: ${provisional.source}${provisional.sourceReference ? `, ${provisional.sourceReference}` : ''}).`,
      SEMANTIC_MAPPING_NOTE,
    )

    results.push({
      rateType: actual.rateType,
      poolName: actual.poolName,
      period: {
        start: actual.periodStart.toISOString(),
        end: actual.periodEnd.toISOString(),
        fiscalYear: actual.fiscalYear,
      },
      provisionalRate: prov.toFixed(4),
      actualRate: act.toFixed(4),
      absoluteVariance: diff.toFixed(4),
      relativeVariancePct: relative,
      state: varianceState(relative),
      provisionalSource: provisional.source,
      semanticMapping: 'PROPOSAL_PRICING_TO_ACTUAL',
      actualRateId: actual.id,
      actualIsHumanVerified: actual.isHumanVerified,
      evidence,
      limitations,
      dedupeKey: `rate-variance:${actual.id}:${prov.toFixed(4)}:${act.toFixed(4)}`,
    })
  }

  return results
}

/** Wording for a material variance. Reports the numbers; draws no conclusion. */
export function varianceEscalationReason(v: RateVarianceResult): string {
  return (
    `The actual ${v.rateType} rate for ${v.period.start.slice(0, 10)} to ${v.period.end.slice(0, 10)} is ` +
    `${v.actualRate}% against a pricing rate of ${v.provisionalRate}% — a difference of ${v.absoluteVariance} points` +
    `${v.relativeVariancePct !== null ? ` (${v.relativeVariancePct}% relative)` : ''}, beyond the ${VARIANCE_MATERIAL_PCT}% ` +
    'Bytescon monitoring threshold. ' +
    SEMANTIC_MAPPING_NOTE +
    ' The agent has changed no rate, invoice or pricing record.'
  )
}

/**
 * Read a firm's standard rate set out of a PricingTemplate's JSON column.
 *
 * Tolerant by design: a malformed entry is skipped rather than throwing, since
 * one bad row in a template must not stop the whole finance run.
 */
export function provisionalRatesFromTemplate(
  template: { id: string; name: string; indirectRatesJson: unknown; effectiveDate: Date | null; version: number } | null,
): ProvisionalRateInput[] {
  if (!template || !Array.isArray(template.indirectRatesJson)) return []
  const out: ProvisionalRateInput[] = []
  for (const raw of template.indirectRatesJson as Array<Record<string, unknown>>) {
    const rateType = typeof raw?.rateType === 'string' ? raw.rateType : null
    const percent = raw?.percent
    if (!rateType) continue
    if (typeof percent !== 'number' && typeof percent !== 'string') continue
    try {
      out.push({
        rateType,
        percent: new Prisma.Decimal(percent),
        source: 'PRICING_TEMPLATE',
        sourceReference: `${template.name} v${template.version}`,
        effectiveDate: template.effectiveDate,
        endDate: null,
      })
    } catch {
      // A percent that is not a number is not a rate. Skip it.
    }
  }
  return out
}
