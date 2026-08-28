// =============================================================
// §7.6 — Pricing Agent handler.
//
// A plain async handler on the shared §7.0 runtime. No new queue, worker,
// scheduler or reaper.
//
// FULLY DETERMINISTIC. This slice adds ZERO system prompts and makes ZERO LLM
// calls: rate arithmetic, indirect allocation, cohort selection, percentiles,
// competitive-range classification, sensitivity, template staleness and
// amendment impact are all computed, never generated. `pricing.noLlm.test.ts`
// asserts the directory contains no prompt literal and no router import.
//
// THE CANONICAL PRICING ENGINE STAYS AUTHORITATIVE. `computePricing` from
// `services/pricingCalc.ts` owns direct labour, fringe, overhead, G&A, ODC,
// subcontractor cost, fee and the total. Nothing here re-derives a total by a
// second route.
//
// WHAT IT MAY NEVER DO — at PROPOSE and ACT_WITH_GUARDRAILS alike
//   change a labour rate · change hours · change an indirect rate · change an
//   ODC or subcontract amount · change fee · select the preferred scenario ·
//   approve a PricingReview · submit pricing · overwrite an approved scenario
// =============================================================
import { createHash } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { notifyUser } from '../../notificationService'
import { computePricing, validateRateBase, type PricingTotals } from '../../pricingCalc'
import { runPricingSensitivity, MIN_REPORTED_PROBABILITY, MAX_REPORTED_PROBABILITY } from '../../scoring/pricingSensitivity'
import { workingDaysBetween } from '../../milestones/workingDays'
import { buildWorkingCalendar } from '../workingCalendar'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import {
  buildAwardBenchmark,
  persistBenchmarkCohort,
  MIN_BENCHMARK_COHORT_SIZE,
  type BenchmarkResult,
} from './awardBenchmark'
import { assessCompetitiveRange, warrantsReview, type RangeAssessment } from './competitiveRange'

export const PRICING_AGENT_KEY = 'PRICING' as const
export const PRICING_METHOD_VERSION = 'pricing-v1'

const DAY_MS = 86_400_000

/** Workspace statuses the agent will assess. An archived one is left alone. */
export const ASSESSABLE_STATUSES = ['DRAFT', 'IN_REVIEW', 'APPROVED'] as const

/** Statuses whose scenarios must never be recomputed — the numbers are final. */
export const LOCKED_STATUSES = ['APPROVED', 'REJECTED', 'SUPERSEDED', 'ARCHIVED'] as const

export const MAX_WORKSPACES_PER_SWEEP = 25

/** Inside this many working days, an out-of-range price escalates. */
export const PRICING_RISK_WORKING_DAYS = 15

/** A template with no update in this long is stale. */
export const TEMPLATE_STALE_DAYS = 365
export const TEMPLATE_EXPIRING_DAYS = 300

/** A rate differing from the canonical template by more than this is drift. */
export const RATE_DRIFT_TOLERANCE_PCT = 0.01

export const PRICING_PHASES = [
  'LOAD_PRICING_WORKSPACE',
  'LOAD_SCENARIOS',
  'VALIDATE_RATE_STRUCTURE',
  'RECOMPUTE_DERIVED_TOTALS',
  'CHECK_INDIRECT_RATES',
  'CHECK_TEMPLATE_STALENESS',
  'REFRESH_PRICING_SENSITIVITY',
  'BUILD_PUBLIC_AWARD_COHORT',
  'COMPUTE_COMPETITIVE_RANGE',
  'CHECK_AMENDMENT_IMPACT',
  'BUILD_PRICING_ASSESSMENT',
  'CREATE_NOTIFICATIONS',
  'CREATE_ESCALATIONS',
  'COMPLETE',
] as const

export type PricingPhase = (typeof PRICING_PHASES)[number]

/** Only the phases a given trigger needs. */
export function phasesForRun(triggerEntityType: string | null): PricingPhase[] {
  if (triggerEntityType === 'PricingTemplate') {
    // A rate-source change needs drift and staleness, not a fresh cohort.
    return [
      'LOAD_PRICING_WORKSPACE', 'LOAD_SCENARIOS', 'CHECK_INDIRECT_RATES', 'CHECK_TEMPLATE_STALENESS',
      'BUILD_PRICING_ASSESSMENT', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE',
    ]
  }
  if (triggerEntityType === 'Amendment') {
    return [
      'LOAD_PRICING_WORKSPACE', 'LOAD_SCENARIOS', 'CHECK_AMENDMENT_IMPACT',
      'BUILD_PRICING_ASSESSMENT', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE',
    ]
  }
  return [...PRICING_PHASES]
}

export type AmendmentImpactState =
  | 'NO_PRICING_IMPACT_IDENTIFIED'
  | 'POTENTIAL_PRICING_IMPACT'
  | 'PRICING_REVIEW_REQUIRED'
  | 'INSUFFICIENT_DATA'

export type TemplateState = 'CURRENT' | 'EXPIRING_SOON' | 'STALE' | 'NO_EFFECTIVE_DATE' | 'INSUFFICIENT_DATA'

// -------------------------------------------------------------
// Assessment shape
// -------------------------------------------------------------

export interface ScenarioAssessment {
  scenarioId: string
  name: string
  isPreferred: boolean
  totals: {
    directLabor: string
    fringe: string
    overhead: string
    odc: string
    subcontractor: string
    ga: string
    subtotalBeforeFee: string
    fee: string
    totalProposedPrice: string
  }
  totalsRecomputed: boolean
  rateStructure: {
    complete: boolean
    state: 'COMPLETE' | 'INCOMPLETE_RATE_STRUCTURE'
    warnings: string[]
  }
  rateDrift: Array<{
    rateType: string
    scenarioPercent: string
    templatePercent: string
    templateName: string
    state: 'RATE_REVIEW_REQUIRED'
    note: string
  }>
  benchmark: {
    cohortId: string | null
    status: string
    filterLevel: string
    relaxedFilters: string[]
    cohortSize: number
    periodStart: string
    periodEnd: string
    p25: string | null
    median: string | null
    p75: string | null
    minimum: string | null
    maximum: string | null
    proposedPricePercentile: number | null
    rangeState: string
    summary: string
    sourceIds: string[]
    limitations: string[]
  }
  templateStatus: { state: TemplateState; staleItems: string[] }
}

export interface PricingAssessment {
  opportunityId: string
  pricingWorkspaceId: string
  workspaceTitle: string
  workspaceStatus: string
  generatedAt: string
  methodVersion: string
  preferredScenarioId: string | null
  /** Reported, never chosen. */
  preferredScenarioState: 'SELECTED' | 'NO_PREFERRED_SCENARIO'
  scenarios: ScenarioAssessment[]
  sensitivity: {
    status: string
    probabilityMode: string
    points: Array<{ scenarioId: string | null; label: string; price: string; probability: number }>
    sampleSize: number
    assumptions: string[]
    limitations: string[]
  }
  amendmentImpact: {
    status: AmendmentImpactState
    evidence: string[]
    reviewRequired: boolean
  }
  recommendedHumanActions: string[]
  warnings: string[]
  dataLimitations: string[]
  inputHash: string
}

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

export async function pricingAgentHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  const mayAct = ctx.autonomyLevel !== 'OBSERVE'
  const phases = phasesForRun(ctx.triggerEntityType)

  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []
  const artifacts: ProposedArtifact[] = []

  const workspaces = await resolveScope(ctx)
  ctx.log('pricing scope resolved', {
    workspaces: workspaces.length,
    triggerEntityType: ctx.triggerEntityType,
    mayAct,
  })

  if (workspaces.length === 0) {
    return {
      status: 'SKIPPED',
      summary: ctx.triggerEntityId
        ? 'The targeted record has no assessable pricing workspace in this firm.'
        : 'No active pricing workspace exists for this firm.',
      confidence: 'HIGH',
      dataSufficiency: 'SUFFICIENT',
      metrics: { workspacesScanned: 0, scenariosAssessed: 0 },
      limitations: [`Only workspaces in status ${ASSESSABLE_STATUSES.join(', ')} are assessed.`],
      inputSnapshot: { scope: ctx.triggerEntityId ?? 'TENANT', workspaceCount: 0 },
      inputHash: `pricing:${ctx.consultingFirmId}:none:${now.toISOString().slice(0, 10)}`,
    }
  }

  let assessed = 0
  let failed = 0
  let changed = 0
  let scenariosAssessed = 0
  let outOfRange = 0
  let insufficientBenchmark = 0
  let driftFindings = 0
  let notified = 0

  for (const workspace of workspaces) {
    if (ctx.signal.aborted) {
      limitations.push('The run was cancelled before every pricing workspace was assessed.')
      break
    }
    try {
      const outcome = await assessWorkspace({ ctx, workspace, now, mayAct, phases })
      assessed += 1
      changed += outcome.changed ? 1 : 0
      scenariosAssessed += outcome.assessment.scenarios.length
      outOfRange += outcome.outOfRangeCount
      insufficientBenchmark += outcome.insufficientBenchmarkCount
      driftFindings += outcome.driftCount
      notified += outcome.notified

      warnings.push(...outcome.assessment.warnings.map((w) => `[${workspace.title}] ${w}`))
      limitations.push(...outcome.assessment.dataLimitations.map((l) => `[${workspace.title}] ${l}`))
      evidence.push(...outcome.evidence)
      escalations.push(...outcome.escalations)
      artifacts.push(outcome.artifact)
    } catch (err) {
      // One unreadable workspace, or one unavailable public award source, must
      // not take the tenant run down.
      failed += 1
      const message = (err as Error).message
      warnings.push(`[${workspace.title}] could not be assessed: ${message}`)
      limitations.push(`[${workspace.title}] was skipped because its pricing evidence could not be read safely.`)
      logger.error('Pricing assessment failed for one workspace (continuing)', {
        workspaceId: workspace.id, runId: ctx.runId, error: message,
      })
    }
    await ctx
      .heartbeat(Math.round((assessed / Math.max(1, workspaces.length)) * 100), `assessed ${assessed}/${workspaces.length}`)
      .catch(() => undefined)
  }

  const summaryParts = [
    `Assessed ${assessed} pricing workspace(s) covering ${scenariosAssessed} scenario(s).`,
  ]
  if (outOfRange > 0) summaryParts.push(`${outOfRange} scenario(s) sit outside the historical range of comparable public awards.`)
  if (insufficientBenchmark > 0) summaryParts.push(`${insufficientBenchmark} scenario(s) had too little comparable public data to position.`)
  if (driftFindings > 0) summaryParts.push(`${driftFindings} indirect rate(s) differ from the current template.`)
  if (failed > 0) summaryParts.push(`${failed} workspace(s) could not be assessed.`)
  summaryParts.push('No price, rate or scenario selection was changed.')

  return {
    status: 'COMPLETED',
    summary: summaryParts.join(' '),
    confidence: assessed === 0 ? 'LOW' : failed > 0 ? 'MEDIUM' : 'HIGH',
    dataSufficiency: failed > 0 || limitations.length > 0 ? 'PARTIAL' : 'SUFFICIENT',
    evidence,
    artifacts,
    escalations,
    metrics: {
      workspacesScanned: workspaces.length,
      workspacesAssessed: assessed,
      workspacesFailed: failed,
      assessmentsChanged: changed,
      scenariosAssessed,
      outOfRangeScenarios: outOfRange,
      insufficientBenchmarks: insufficientBenchmark,
      rateDriftFindings: driftFindings,
      escalationsRaised: escalations.length,
      notificationsSent: notified,
      // Proven zero by test at both autonomy levels, and live.
      priceInputsChanged: 0,
      preferredScenariosChanged: 0,
      pricingReviewsApproved: 0,
      llmCalls: 0,
    },
    warnings,
    limitations,
    inputSnapshot: {
      scope: ctx.triggerEntityId ?? 'TENANT',
      triggerEntityType: ctx.triggerEntityType,
      workspaceIds: workspaces.map((w) => w.id),
      autonomyLevel: ctx.autonomyLevel,
    },
    inputHash: `pricing:${ctx.consultingFirmId}:${ctx.triggerEntityId ?? 'TENANT'}:${workspaces.map((w) => w.id).sort().join(',').slice(0, 200)}`,
  }
}

// -------------------------------------------------------------
// Scope — always tenant-filtered
// -------------------------------------------------------------

interface ScopeWorkspace {
  id: string
  opportunityId: string
  title: string
  status: string
  ownerUserId: string | null
  preferredScenarioId: string | null
  opportunity: {
    id: string
    title: string
    agency: string
    naicsCode: string
    setAsideType: string
    responseDeadline: Date | null
  }
}

async function resolveScope(ctx: AgentExecutionContext): Promise<ScopeWorkspace[]> {
  // `PricingWorkspace.opportunityId` is a loose scalar, not a Prisma relation,
  // so the opportunity is read separately and joined here — always under the
  // same tenant scope, so a workspace can never pick up a foreign opportunity.
  const select = {
    id: true, opportunityId: true, title: true, status: true,
    ownerUserId: true, preferredScenarioId: true,
  } as const

  const attach = async (rows: Array<{
    id: string; opportunityId: string; title: string; status: string
    ownerUserId: string | null; preferredScenarioId: string | null
  }>): Promise<ScopeWorkspace[]> => {
    if (rows.length === 0) return []
    const opportunities = await prisma.opportunity.findMany({
      where: { id: { in: rows.map((r) => r.opportunityId) }, consultingFirmId: ctx.consultingFirmId },
      select: { id: true, title: true, agency: true, naicsCode: true, setAsideType: true, responseDeadline: true },
    })
    const byId = new Map(opportunities.map((o) => [o.id, o]))
    return rows.flatMap((r) => {
      const opportunity = byId.get(r.opportunityId)
      // A workspace whose opportunity is not in this firm is dropped, not
      // assessed against a stand-in.
      return opportunity ? [{ ...r, opportunity }] : []
    })
  }

  const statusFilter = { status: { in: [...ASSESSABLE_STATUSES] }, isArchived: false }

  // Every branch filters on consultingFirmId. A targeted id belonging to
  // another firm resolves to nothing rather than to that firm's workspace.
  if (ctx.triggerEntityType === 'PricingScenario' && ctx.triggerEntityId) {
    const scenario = await prisma.pricingScenario.findFirst({
      where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
      select: { workspaceId: true },
    })
    if (!scenario) return []
    return attach(await prisma.pricingWorkspace.findMany({
      where: { id: scenario.workspaceId, consultingFirmId: ctx.consultingFirmId, ...statusFilter },
      select,
    }))
  }

  if (ctx.triggerEntityType === 'BidPursuit' && ctx.triggerEntityId) {
    const pursuit = await prisma.bidPursuit.findFirst({
      where: { id: ctx.triggerEntityId, consultingFirmId: ctx.consultingFirmId },
      select: { opportunityId: true },
    })
    if (!pursuit) return []
    return attach(await prisma.pricingWorkspace.findMany({
      where: { opportunityId: pursuit.opportunityId, consultingFirmId: ctx.consultingFirmId, ...statusFilter },
      select,
    }))
  }

  if ((ctx.triggerEntityType === 'Opportunity' || ctx.triggerEntityType === 'Amendment') && ctx.triggerEntityId) {
    let opportunityId = ctx.triggerEntityId
    if (ctx.triggerEntityType === 'Amendment') {
      const amendment = await prisma.amendment.findUnique({
        where: { id: ctx.triggerEntityId },
        select: { opportunityId: true },
      })
      if (!amendment) return []
      opportunityId = amendment.opportunityId
    }
    return attach(await prisma.pricingWorkspace.findMany({
      where: { opportunityId, consultingFirmId: ctx.consultingFirmId, ...statusFilter },
      select,
    }))
  }

  // A template change re-checks every assessable workspace for drift.
  return attach(await prisma.pricingWorkspace.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, ...statusFilter },
    select,
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    take: MAX_WORKSPACES_PER_SWEEP,
  }))
}

// -------------------------------------------------------------
// Per-workspace assessment
// -------------------------------------------------------------

interface WorkspaceOutcome {
  assessment: PricingAssessment
  artifact: ProposedArtifact
  escalations: ProposedEscalation[]
  evidence: EvidenceRef[]
  changed: boolean
  notified: number
  outOfRangeCount: number
  insufficientBenchmarkCount: number
  driftCount: number
}

async function assessWorkspace(args: {
  ctx: AgentExecutionContext
  workspace: ScopeWorkspace
  now: Date
  mayAct: boolean
  phases: PricingPhase[]
}): Promise<WorkspaceOutcome> {
  const { ctx, workspace, now, mayAct, phases } = args
  const warnings: string[] = []
  const dataLimitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []
  const recommendedHumanActions: string[] = []

  const scenarios = await prisma.pricingScenario.findMany({
    where: { workspaceId: workspace.id, consultingFirmId: ctx.consultingFirmId, isArchived: false },
    include: {
      laborLines: { orderBy: { sortOrder: 'asc' } },
      indirectRates: { orderBy: { sortOrder: 'asc' } },
      otherCosts: { orderBy: { sortOrder: 'asc' } },
    },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  })

  if (scenarios.length === 0) {
    dataLimitations.push('This pricing workspace has no scenario, so nothing could be priced or positioned.')
  }

  // The canonical template set, read once, for drift and staleness.
  const templates = await prisma.pricingTemplate.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, isArchived: false, isActive: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })
  const templateStatus = assessTemplateStaleness(templates, now)

  const scenarioAssessments: ScenarioAssessment[] = []
  let outOfRangeCount = 0
  let insufficientBenchmarkCount = 0
  let driftCount = 0

  for (const scenario of scenarios) {
    // ---- VALIDATE_RATE_STRUCTURE ------------------------------------
    const structure = validateRateStructure(scenario)

    // ---- RECOMPUTE_DERIVED_TOTALS -----------------------------------
    // Derived totals may be refreshed; human-entered inputs never are. A
    // locked workspace is left exactly as the human approved it.
    const totals = computePricing(
      scenario.laborLines.map((l) => ({
        hours: l.hours, baseRate: l.baseRate, escalationPct: l.escalationPct,
        personnelCount: l.personnelCount, isActive: l.isActive,
      })),
      scenario.indirectRates.map((r) => ({ rateType: r.rateType, percent: r.percent, costBase: r.costBase, isActive: r.isActive })),
      scenario.otherCosts.map((o) => ({ costCategory: o.costCategory, quantity: o.quantity, unitCost: o.unitCost })),
    )

    const locked = (LOCKED_STATUSES as readonly string[]).includes(workspace.status)
    let totalsRecomputed = false
    if (
      mayAct &&
      !locked &&
      phases.includes('RECOMPUTE_DERIVED_TOTALS') &&
      !new Prisma.Decimal(scenario.totalPrice).equals(totals.totalPrice)
    ) {
      await prisma.pricingScenario.update({
        where: { id: scenario.id },
        data: {
          totalDirectLabor: totals.totalDirectLabor, totalFringe: totals.totalFringe,
          totalOverhead: totals.totalOverhead, totalOdc: totals.totalOdc,
          totalSubcontractor: totals.totalSubcontractor, totalGA: totals.totalGA,
          subtotalBeforeFee: totals.subtotalBeforeFee, totalFee: totals.totalFee,
          totalPrice: totals.totalPrice, calculatedAt: now,
        },
      })
      totalsRecomputed = true
      warnings.push(`[${scenario.name}] the stored totals were stale and were recomputed from the recorded lines. No input was changed.`)
    }
    if (locked && !new Prisma.Decimal(scenario.totalPrice).equals(totals.totalPrice)) {
      dataLimitations.push(
        `[${scenario.name}] the stored totals differ from the recorded lines, but the workspace is ${workspace.status} so nothing was rewritten.`,
      )
    }

    // ---- CHECK_INDIRECT_RATES (drift) -------------------------------
    const drift = phases.includes('CHECK_INDIRECT_RATES') ? detectRateDrift(scenario.indirectRates, templates) : []
    driftCount += drift.length
    if (drift.length > 0) {
      recommendedHumanActions.push(
        `Review ${drift.length} indirect rate(s) on "${scenario.name}" that differ from the current template, and decide whether to adopt the new value.`,
      )
    }

    // ---- BUILD_PUBLIC_AWARD_COHORT + COMPUTE_COMPETITIVE_RANGE ------
    let benchmark: BenchmarkResult | null = null
    let cohortId: string | null = null
    let range: RangeAssessment | null = null

    if (phases.includes('BUILD_PUBLIC_AWARD_COHORT')) {
      try {
        benchmark = await buildAwardBenchmark({
          consultingFirmId: ctx.consultingFirmId,
          opportunityId: workspace.opportunityId,
          pricingWorkspaceId: workspace.id,
          pricingScenarioId: scenario.id,
          naics: workspace.opportunity.naicsCode,
          agency: workspace.opportunity.agency,
          setAside: workspace.opportunity.setAsideType,
          referencePrice: totals.totalPrice,
          now,
        })
        if (benchmark.inputHash) {
          const persisted = await persistBenchmarkCohort({
            consultingFirmId: ctx.consultingFirmId,
            result: benchmark,
            opportunityId: workspace.opportunityId,
            pricingWorkspaceId: workspace.id,
            pricingScenarioId: scenario.id,
          })
          cohortId = persisted.cohort.id
          evidence.push({
            sourceType: 'AwardBenchmarkCohort',
            sourceId: persisted.cohort.id,
            retrievedAt: now.toISOString(),
            note: `${benchmark.cohortSize} comparable public award(s) at ${benchmark.filterLevel}`,
          })
        }
        range = assessCompetitiveRange({ proposedPrice: totals.totalPrice, benchmark })
      } catch (err) {
        // An unavailable public source degrades this scenario, not the run.
        warnings.push(`[${scenario.name}] the public award benchmark could not be built: ${(err as Error).message}`)
        dataLimitations.push(`[${scenario.name}] no benchmark was produced, so no historical positioning is available.`)
      }
    }

    if (range) {
      if (range.state === 'INSUFFICIENT_DATA') insufficientBenchmarkCount += 1
      else if (warrantsReview(range)) outOfRangeCount += 1
    }

    scenarioAssessments.push({
      scenarioId: scenario.id,
      name: scenario.name,
      isPreferred: scenario.isPreferred,
      totals: {
        directLabor: totals.totalDirectLabor.toFixed(2),
        fringe: totals.totalFringe.toFixed(2),
        overhead: totals.totalOverhead.toFixed(2),
        odc: totals.totalOdc.toFixed(2),
        subcontractor: totals.totalSubcontractor.toFixed(2),
        ga: totals.totalGA.toFixed(2),
        subtotalBeforeFee: totals.subtotalBeforeFee.toFixed(2),
        fee: totals.totalFee.toFixed(2),
        totalProposedPrice: totals.totalPrice.toFixed(2),
      },
      totalsRecomputed,
      rateStructure: structure,
      rateDrift: drift,
      benchmark: {
        cohortId,
        status: benchmark?.dataSufficiency ?? 'INSUFFICIENT_DATA',
        filterLevel: benchmark?.filterLevel ?? 'NONE',
        relaxedFilters: benchmark?.relaxedFilters ?? [],
        cohortSize: benchmark?.cohortSize ?? 0,
        periodStart: benchmark?.periodStart.toISOString() ?? '',
        periodEnd: benchmark?.periodEnd.toISOString() ?? '',
        p25: benchmark?.distribution.p25?.toFixed(2) ?? null,
        median: benchmark?.distribution.median?.toFixed(2) ?? null,
        p75: benchmark?.distribution.p75?.toFixed(2) ?? null,
        minimum: benchmark?.distribution.minimum?.toFixed(2) ?? null,
        maximum: benchmark?.distribution.maximum?.toFixed(2) ?? null,
        // Null unless the cohort earned it.
        proposedPricePercentile: range?.percentile ?? null,
        rangeState: range?.state ?? 'INSUFFICIENT_DATA',
        summary: range?.summary ?? 'No benchmark was produced.',
        sourceIds: benchmark?.sourceIds ?? [],
        limitations: range?.limitations ?? [],
      },
      templateStatus,
    })

    if (structure.state === 'INCOMPLETE_RATE_STRUCTURE') {
      recommendedHumanActions.push(`Complete the rate structure on "${scenario.name}" before relying on its total.`)
    }
  }

  // ---- REFRESH_PRICING_SENSITIVITY ----------------------------------
  // The §6 engine owns this. It reads scenarios and never writes them back.
  let sensitivity: PricingAssessment['sensitivity'] = {
    status: 'INSUFFICIENT_DATA', probabilityMode: 'RAW', points: [],
    sampleSize: 0, assumptions: [], limitations: ['Pricing sensitivity was not refreshed on this run.'],
  }
  if (phases.includes('REFRESH_PRICING_SENSITIVITY') && scenarios.length > 0) {
    try {
      const result = await runPricingSensitivity(ctx.consultingFirmId, workspace.opportunityId, { now })
      sensitivity = {
        status: result.validity,
        // The §6 stack owns calibration. Nothing here re-labels a RAW curve.
        probabilityMode: result.validity === 'CALIBRATED' ? 'CALIBRATED' : 'RAW',
        points: result.points.map((p) => ({
          scenarioId: p.scenarioId ?? null,
          label: p.label,
          price: String(p.price),
          probability: p.probability,
        })),
        sampleSize: result.sampleSize,
        assumptions: result.assumptions,
        limitations: result.validity === 'CALIBRATED'
          ? []
          : [`Win probability is ${result.validity}: it is modelled from price position, not from a calibrated tenant history.`],
      }
      evidence.push({
        sourceType: 'PricingSensitivityAnalysis',
        sourceId: result.id,
        retrievedAt: now.toISOString(),
        note: `${result.points.length} price point(s), validity ${result.validity}`,
      })
    } catch (err) {
      dataLimitations.push(`Pricing sensitivity could not be refreshed: ${(err as Error).message}`)
    }
  }

  // ---- CHECK_AMENDMENT_IMPACT ---------------------------------------
  const amendmentImpact = phases.includes('CHECK_AMENDMENT_IMPACT')
    ? await assessAmendmentImpact(ctx.consultingFirmId, workspace.opportunityId, workspace.id)
    : { status: 'INSUFFICIENT_DATA' as AmendmentImpactState, evidence: [], reviewRequired: false }

  if (amendmentImpact.reviewRequired) {
    recommendedHumanActions.push('Re-review pricing against the amended scope before submission.')
  }

  // ---- BUILD_PRICING_ASSESSMENT --------------------------------------
  const assessment: PricingAssessment = {
    opportunityId: workspace.opportunityId,
    pricingWorkspaceId: workspace.id,
    workspaceTitle: workspace.title,
    workspaceStatus: workspace.status,
    generatedAt: now.toISOString(),
    methodVersion: PRICING_METHOD_VERSION,
    preferredScenarioId: workspace.preferredScenarioId,
    // Reported, never chosen — even when one scenario models better.
    preferredScenarioState: workspace.preferredScenarioId ? 'SELECTED' : 'NO_PREFERRED_SCENARIO',
    scenarios: scenarioAssessments,
    sensitivity,
    amendmentImpact,
    recommendedHumanActions,
    warnings,
    dataLimitations,
    inputHash: '',
  }
  if (!workspace.preferredScenarioId && scenarios.length > 1) {
    dataLimitations.push('No preferred scenario has been selected. The agent assessed every scenario and selected none.')
  }

  assessment.inputHash = buildAssessmentHash(assessment)

  const previous = await prisma.agentArtifact.findFirst({
    where: {
      consultingFirmId: ctx.consultingFirmId,
      agentKey: PRICING_AGENT_KEY,
      artifactType: 'PRICING_ASSESSMENT',
      sourceEntityType: 'PricingWorkspace',
      sourceEntityId: workspace.id,
      supersededByArtifactId: null,
    },
    orderBy: { createdAt: 'desc' },
    select: { structuredData: true },
  })
  const previousHash = (previous?.structuredData as { inputHash?: string } | null)?.inputHash ?? null
  const changed = previousHash !== assessment.inputHash

  const artifact: ProposedArtifact = {
    artifactType: 'PRICING_ASSESSMENT',
    title: `Pricing assessment — ${workspace.title}`,
    summary:
      `${scenarioAssessments.length} scenario(s)` +
      (outOfRangeCount > 0 ? ` · ${outOfRangeCount} outside the historical range` : '') +
      (insufficientBenchmarkCount > 0 ? ` · ${insufficientBenchmarkCount} without sufficient benchmark data` : '') +
      (driftCount > 0 ? ` · ${driftCount} rate drift finding(s)` : ''),
    structuredData: assessment as unknown as Record<string, unknown>,
    evidence,
    sourceEntityType: 'PricingWorkspace',
    sourceEntityId: workspace.id,
    confidenceState: outOfRangeCount > 0 ? 'MEDIUM' : insufficientBenchmarkCount > 0 ? 'LOW' : 'HIGH',
    supersedeKey: `pricing-assessment:${workspace.id}`,
  }

  // ---- CREATE_ESCALATIONS ---------------------------------------------
  const calendar = await buildWorkingCalendar(ctx.consultingFirmId, now)
  const deadline = workspace.opportunity.responseDeadline
  const workingDays = deadline ? workingDaysBetween(now, deadline, calendar) : null
  const nearSubmission = workingDays !== null && workingDays >= 0 && workingDays <= PRICING_RISK_WORKING_DAYS

  for (const s of scenarioAssessments) {
    if (nearSubmission && ['BELOW_HISTORICAL_RANGE', 'ABOVE_HISTORICAL_RANGE', 'EXTREME_OUTLIER'].includes(s.benchmark.rangeState)) {
      escalations.push({
        severity: s.benchmark.rangeState === 'EXTREME_OUTLIER' ? 'HIGH' : 'MEDIUM',
        title: `Price outside historical range near submission — ${workspace.title}`,
        reason:
          `Scenario "${s.name}" at $${s.totals.totalProposedPrice} is ${s.benchmark.rangeState} with ${workingDays} working day(s) until the response deadline. ` +
          `${s.benchmark.summary} This is a positioning warning, not a judgement that the price is wrong.`,
        recommendedAction: 'Review the price against the cohort before submission, and record the rationale.',
        entityType: 'PricingWorkspace',
        entityId: workspace.id,
        assignedToUserId: workspace.ownerUserId,
        dedupeHint: `pricing-out-of-range:${s.scenarioId}:${s.benchmark.rangeState}`,
      })
    }

    if (s.rateStructure.state === 'INCOMPLETE_RATE_STRUCTURE') {
      escalations.push({
        severity: 'MEDIUM',
        title: `Required indirect rates missing — ${workspace.title}`,
        reason: `Scenario "${s.name}" has an incomplete rate structure: ${s.rateStructure.warnings.join('; ')}`,
        recommendedAction: 'Add the missing rates before relying on the total price.',
        entityType: 'PricingWorkspace',
        entityId: workspace.id,
        assignedToUserId: workspace.ownerUserId,
        dedupeHint: `pricing-incomplete-rates:${s.scenarioId}`,
      })
    }

    if (nearSubmission && s.benchmark.rangeState === 'INSUFFICIENT_DATA') {
      escalations.push({
        severity: 'LOW',
        title: `Benchmark data insufficient near submission — ${workspace.title}`,
        reason:
          `Historical benchmark has insufficient comparable data for confident assessment of "${s.name}": ` +
          `${s.benchmark.cohortSize} comparable public award(s) against a minimum of ${MIN_BENCHMARK_COHORT_SIZE}, with ${workingDays} working day(s) remaining. ` +
          'This does not mean the price is wrong.',
        recommendedAction: 'Price on internal cost and scope evidence; no historical position could be established.',
        entityType: 'PricingWorkspace',
        entityId: workspace.id,
        assignedToUserId: workspace.ownerUserId,
        dedupeHint: `pricing-insufficient-benchmark:${s.scenarioId}`,
      })
    }

    if (s.rateDrift.length > 0) {
      escalations.push({
        severity: 'LOW',
        title: `Indirect rate differs from current template — ${workspace.title}`,
        reason:
          `Scenario "${s.name}" assumes ${s.rateDrift.map((d) => `${d.rateType} at ${d.scenarioPercent}% against the template's ${d.templatePercent}%`).join('; ')}. ` +
          'The scenario rate was not changed; a person decides whether to adopt the template value.',
        recommendedAction: 'Review the rate difference and update the scenario if the new rate applies.',
        entityType: 'PricingWorkspace',
        entityId: workspace.id,
        assignedToUserId: workspace.ownerUserId,
        dedupeHint: `pricing-rate-drift:${s.scenarioId}:${s.rateDrift.map((d) => `${d.rateType}=${d.templatePercent}`).sort().join(',')}`,
      })
    }
  }

  if (templateStatus.state === 'STALE' && nearSubmission) {
    escalations.push({
      severity: 'MEDIUM',
      title: `Rate template stale near submission — ${workspace.title}`,
      reason: `${templateStatus.staleItems.join('; ')}. ${workingDays} working day(s) remain until the response deadline.`,
      recommendedAction: 'Confirm the rates are still current before submission.',
      entityType: 'PricingWorkspace',
      entityId: workspace.id,
      assignedToUserId: workspace.ownerUserId,
      dedupeHint: `pricing-stale-template:${workspace.id}`,
    })
  }

  if (amendmentImpact.status === 'PRICING_REVIEW_REQUIRED') {
    escalations.push({
      severity: 'MEDIUM',
      title: `Amendment may affect pricing — ${workspace.title}`,
      reason: `${amendmentImpact.evidence.join('; ')} No labour, rate, quantity or fee was changed by the agent.`,
      recommendedAction: 'Re-review the pricing against the amended scope.',
      entityType: 'PricingWorkspace',
      entityId: workspace.id,
      assignedToUserId: workspace.ownerUserId,
      dedupeHint: `pricing-amendment-review:${workspace.id}:${amendmentImpact.evidence.length}`,
    })
  }

  // ---- CREATE_NOTIFICATIONS -------------------------------------------
  let notified = 0
  if (mayAct && changed && workspace.ownerUserId) {
    const outOfRangeScenarios = scenarioAssessments.filter((s) =>
      ['BELOW_HISTORICAL_RANGE', 'ABOVE_HISTORICAL_RANGE', 'EXTREME_OUTLIER'].includes(s.benchmark.rangeState),
    )
    // Never notified for INSUFFICIENT_DATA as though the price were out of range.
    if (outOfRangeScenarios.length > 0) {
      await notifyUser({
        consultingFirmId: ctx.consultingFirmId,
        userId: workspace.ownerUserId,
        type: 'PRICING_REVIEW',
        title: `Pricing outside historical range — ${workspace.title}`,
        body: `${outOfRangeScenarios.length} scenario(s) sit outside the range of comparable public awards. Nothing was changed.`.slice(0, 400),
        linkPath: `/opportunities/${workspace.opportunityId}/pricing`,
        entityType: 'PricingWorkspace',
        entityId: workspace.id,
        dedupeKey: `pricing-out-of-range:${workspace.id}:${assessment.inputHash}`,
      }).catch((err) => warnings.push(`Owner notification failed: ${(err as Error).message}`))
      notified += 1
    }

    const driftScenarios = scenarioAssessments.filter((s) => s.rateDrift.length > 0)
    if (driftScenarios.length > 0) {
      const admins = await prisma.user.findMany({
        where: { consultingFirmId: ctx.consultingFirmId, role: 'ADMIN', isActive: true },
        select: { id: true },
        take: 5,
      })
      const driftKey = driftScenarios
        .flatMap((s) => s.rateDrift.map((d) => `${s.scenarioId}:${d.rateType}:${d.templatePercent}`))
        .sort()
        .join(',')
      for (const admin of admins) {
        await notifyUser({
          consultingFirmId: ctx.consultingFirmId,
          userId: admin.id,
          type: 'PRICING_REVIEW',
          title: `Indirect rate differs from template — ${workspace.title}`,
          body: 'A scenario assumes an indirect rate that differs from the current template. The scenario was not changed.'.slice(0, 400),
          linkPath: `/opportunities/${workspace.opportunityId}/pricing`,
          entityType: 'PricingWorkspace',
          entityId: workspace.id,
          // Keyed on the rate values, so an unchanged warning never repeats.
          dedupeKey: `pricing-rate-drift:${workspace.id}:${createHash('sha256').update(driftKey).digest('hex').slice(0, 32)}:${admin.id}`,
        }).catch(() => undefined)
        notified += 1
      }
    }
  }

  return {
    assessment,
    artifact,
    escalations,
    evidence,
    changed,
    notified,
    outOfRangeCount,
    insufficientBenchmarkCount,
    driftCount,
  }
}

// -------------------------------------------------------------
// Rate structure
// -------------------------------------------------------------

/**
 * Validate against the canonical model. Nothing is defaulted: a missing rate
 * is reported as missing rather than assumed to be zero, because a silent zero
 * would understate a price.
 */
export function validateRateStructure(scenario: {
  laborLines: Array<{ categoryName: string; hours: Prisma.Decimal; baseRate: Prisma.Decimal; isActive: boolean }>
  indirectRates: Array<{ rateType: string; percent: Prisma.Decimal; costBase: string; isActive: boolean }>
  otherCosts: Array<{ costCategory: string; quantity: Prisma.Decimal; unitCost: Prisma.Decimal }>
}): { complete: boolean; state: 'COMPLETE' | 'INCOMPLETE_RATE_STRUCTURE'; warnings: string[] } {
  const warnings: string[] = []
  const activeLabor = scenario.laborLines.filter((l) => l.isActive)
  const activeRates = scenario.indirectRates.filter((r) => r.isActive)

  if (activeLabor.length === 0 && scenario.otherCosts.length === 0) {
    warnings.push('The scenario records no active labour line and no other cost, so there is nothing to price.')
  }
  for (const line of activeLabor) {
    if (new Prisma.Decimal(line.hours).lessThanOrEqualTo(0)) {
      warnings.push(`Labour line "${line.categoryName}" records no hours.`)
    }
    if (new Prisma.Decimal(line.baseRate).lessThanOrEqualTo(0)) {
      warnings.push(`Labour line "${line.categoryName}" records no rate.`)
    }
  }
  for (const rate of activeRates) {
    if (!validateRateBase(rate.rateType, rate.costBase)) {
      warnings.push(`Indirect rate ${rate.rateType} is applied to an unsupported cost base ${rate.costBase}.`)
    }
    if (new Prisma.Decimal(rate.percent).lessThan(0)) {
      warnings.push(`Indirect rate ${rate.rateType} records a negative percentage.`)
    }
  }
  if (activeLabor.length > 0) {
    for (const required of ['FRINGE', 'OVERHEAD', 'GA'] as const) {
      if (!activeRates.some((r) => r.rateType === required)) {
        warnings.push(`No ${required} rate is recorded, so no ${required} cost is included in the total.`)
      }
    }
  }

  return {
    complete: warnings.length === 0,
    state: warnings.length === 0 ? 'COMPLETE' : 'INCOMPLETE_RATE_STRUCTURE',
    warnings,
  }
}

// -------------------------------------------------------------
// Template staleness + rate drift
// -------------------------------------------------------------

export function assessTemplateStaleness(
  templates: Array<{ id: string; name: string; effectiveDate: Date | null; updatedAt: Date }>,
  now: Date,
): { state: TemplateState; staleItems: string[] } {
  if (templates.length === 0) {
    return { state: 'INSUFFICIENT_DATA', staleItems: ['No active rate template exists, so template currency could not be assessed.'] }
  }

  const withoutDate = templates.filter((t) => t.effectiveDate === null)
  const staleItems: string[] = []
  let worst: TemplateState = 'CURRENT'

  for (const template of templates) {
    const reference = template.effectiveDate ?? template.updatedAt
    const ageDays = Math.floor((now.getTime() - reference.getTime()) / DAY_MS)
    if (ageDays >= TEMPLATE_STALE_DAYS) {
      staleItems.push(`Template "${template.name}" was last effective ${ageDays} day(s) ago and may be stale.`)
      worst = 'STALE'
    } else if (ageDays >= TEMPLATE_EXPIRING_DAYS && worst !== 'STALE') {
      staleItems.push(`Template "${template.name}" is ${ageDays} day(s) old and will need review soon.`)
      worst = 'EXPIRING_SOON'
    }
  }

  if (worst === 'CURRENT' && withoutDate.length === templates.length) {
    return {
      state: 'NO_EFFECTIVE_DATE',
      staleItems: [`${withoutDate.length} template(s) record no effective date, so currency was judged from the last update instead.`],
    }
  }
  return { state: worst, staleItems }
}

/**
 * Compare each scenario rate against the canonical template.
 *
 * Reports only. The scenario rate is a human-entered snapshot and is never
 * rewritten — a person decides whether the new template value applies.
 */
export function detectRateDrift(
  scenarioRates: Array<{ rateType: string; percent: Prisma.Decimal; isActive: boolean }>,
  templates: Array<{ name: string; indirectRatesJson: Prisma.JsonValue; updatedAt: Date }>,
): ScenarioAssessment['rateDrift'] {
  if (templates.length === 0) return []
  const canonical = templates[0]
  const rows = Array.isArray(canonical.indirectRatesJson) ? canonical.indirectRatesJson : []

  const templateByType = new Map<string, Prisma.Decimal>()
  for (const raw of rows) {
    const row = (raw ?? {}) as Record<string, unknown>
    const rateType = typeof row.rateType === 'string' ? row.rateType : null
    const percent = row.percent
    if (!rateType || percent === undefined || percent === null) continue
    try {
      templateByType.set(rateType, new Prisma.Decimal(percent as Prisma.Decimal.Value))
    } catch {
      // A malformed template row is ignored rather than reported as drift.
    }
  }

  const drift: ScenarioAssessment['rateDrift'] = []
  for (const rate of scenarioRates.filter((r) => r.isActive)) {
    const templatePercent = templateByType.get(rate.rateType)
    if (!templatePercent) continue
    const scenarioPercent = new Prisma.Decimal(rate.percent)
    if (scenarioPercent.minus(templatePercent).abs().greaterThan(RATE_DRIFT_TOLERANCE_PCT)) {
      drift.push({
        rateType: rate.rateType,
        scenarioPercent: scenarioPercent.toFixed(4),
        templatePercent: templatePercent.toFixed(4),
        templateName: canonical.name,
        state: 'RATE_REVIEW_REQUIRED',
        note: 'The scenario keeps its own rate. Adopting the template value is a human decision.',
      })
    }
  }
  return drift
}

// -------------------------------------------------------------
// Amendment impact
// -------------------------------------------------------------

/**
 * Classify amendment pricing impact from EXISTING §7.3 evidence.
 *
 * It never claims a price must change by a figure, because no structured
 * quantity or rate change exists to support one. The strongest statement it
 * makes is that a person should re-review.
 */
export async function assessAmendmentImpact(
  consultingFirmId: string,
  opportunityId: string,
  workspaceId: string,
): Promise<{ status: AmendmentImpactState; evidence: string[]; reviewRequired: boolean }> {
  // §7.3's AmendmentImpact rows are the canonical evidence, already
  // tenant-scoped. This slice runs no second amendment parser.
  const impacts = await prisma.amendmentImpact.findMany({
    where: { consultingFirmId, opportunityId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true, area: true, impact: true, reviewRequired: true,
      acknowledgedAt: true, createdAt: true, targetLabel: true,
    },
  })

  if (impacts.length === 0) {
    return {
      status: 'NO_PRICING_IMPACT_IDENTIFIED',
      evidence: ['No amendment impact is recorded for this opportunity.'],
      reviewRequired: false,
    }
  }

  // Only impacts recorded AFTER the last human pricing review matter: anything
  // earlier was in front of the reviewer when they signed off.
  const lastReview = await prisma.pricingReview.findFirst({
    where: { consultingFirmId, workspaceId },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  const since = lastReview?.createdAt ?? null
  const relevant = since ? impacts.filter((i) => i.createdAt > since) : impacts

  if (relevant.length === 0) {
    return {
      status: 'NO_PRICING_IMPACT_IDENTIFIED',
      evidence: ['Every recorded amendment impact predates the most recent pricing review.'],
      reviewRequired: false,
    }
  }

  const evidence: string[] = []
  const pricingTouching = relevant.filter((i) => i.area === 'PRICING')
  const scopeTouching = relevant.filter((i) => i.area === 'PROPOSAL_SECTION' || i.area === 'COMPLIANCE_MATRIX')
  const unacknowledged = relevant.filter((i) => i.reviewRequired && i.acknowledgedAt === null)

  for (const impact of pricingTouching) {
    evidence.push(`Amendment impact on PRICING${impact.targetLabel ? ` (${impact.targetLabel})` : ''}: ${impact.impact}`)
  }
  for (const impact of scopeTouching) {
    evidence.push(`Amendment impact on ${impact.area}${impact.targetLabel ? ` (${impact.targetLabel})` : ''}: ${impact.impact}`)
  }

  if (pricingTouching.length > 0 || scopeTouching.length > 0) {
    return {
      status: 'PRICING_REVIEW_REQUIRED',
      evidence: [
        ...evidence,
        `${unacknowledged.length} impact(s) still await human acknowledgement. ` +
          'The agent has not altered any labour line, rate, quantity or fee — a change in scope is a human-reviewed input.',
      ],
      reviewRequired: true,
    }
  }

  // Impacts exist but touch neither pricing nor scope — a date-only or
  // document-only amendment. Worth reporting, not worth a review demand.
  for (const impact of relevant.slice(0, 5)) {
    evidence.push(`Amendment impact on ${impact.area}: ${impact.impact}`)
  }
  return { status: 'POTENTIAL_PRICING_IMPACT', evidence, reviewRequired: false }
}

// -------------------------------------------------------------
// Idempotency
// -------------------------------------------------------------

/** Digest of everything that makes an assessment materially different. */
function buildAssessmentHash(assessment: PricingAssessment): string {
  const material = {
    workspace: assessment.pricingWorkspaceId,
    status: assessment.workspaceStatus,
    preferred: assessment.preferredScenarioId,
    scenarios: assessment.scenarios
      .map((s) =>
        [
          s.scenarioId,
          s.totals.totalProposedPrice,
          s.rateStructure.state,
          s.benchmark.rangeState,
          s.benchmark.cohortSize,
          s.benchmark.proposedPricePercentile ?? 'null',
          s.rateDrift.map((d) => `${d.rateType}=${d.templatePercent}`).sort().join('|'),
          s.templateStatus.state,
        ].join(':'),
      )
      .sort(),
    sensitivity: `${assessment.sensitivity.status}:${assessment.sensitivity.points.length}`,
    amendment: assessment.amendmentImpact.status,
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

/** Re-exported so tests can assert the §6 clamps are untouched. */
export { MIN_REPORTED_PROBABILITY, MAX_REPORTED_PROBABILITY }
export type { PricingTotals }
