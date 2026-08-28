// =============================================================
// §7.9 — Intelligence Agent handler. The ninth and final domain agent.
//
// A plain async handler on the shared §7.0 runtime. No new queue, worker,
// scheduler or reaper.
//
// FULLY DETERMINISTIC. Zero system prompts, zero LLM calls, zero tokens. The
// narrative in every recommendation is assembled from the structured evidence
// beside it, so every number in a sentence traces to a field above it and the
// same inputs always produce the same words.
//
// ADVISORY ONLY — at PROPOSE and ACT_WITH_GUARDRAILS alike. It never changes a
// BidDecision, a pursuit stage or priority, an OpportunityMatch weight, a
// qualification threshold, a pricing scenario, a teaming arrangement, a
// capability record, proposal content, contract or finance data, or a
// calibration. It writes exactly three things: its own segments, its own
// recommendations, and its own artifact.
//
// CANONICAL ENGINES REUSED, NOT REBUILT
//   Wilson interval   → scoring/confidenceInterval.wilsonInterval
//   HHI               → scoring/portfolioValue.hhi
//   Value hierarchy   → scoring/portfolioValue.computePortfolio
//   EMA + direction   → trendAnalysis.computeEMA / detectDirection
//   Public cohort     → agents/pricing/awardBenchmark.buildAwardBenchmark
// =============================================================
import { createHash } from 'crypto'
import { Prisma, SubmissionOutcome } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { notifyUser } from '../../notificationService'
import { computeEMA, detectDirection } from '../../trendAnalysis'
import { computePortfolio, hhi, VALUE_SOURCE_ORDER } from '../../scoring/portfolioValue'
import { CONFIDENCE_METHOD } from '../../scoring/confidenceInterval'
import {
  buildAwardBenchmark,
  MIN_BENCHMARK_COHORT_SIZE,
  BENCHMARK_ALGORITHM_VERSION,
} from '../pricing/awardBenchmark'
import type {
  AgentExecutionContext,
  AgentHandlerResult,
  EvidenceRef,
  ProposedArtifact,
  ProposedEscalation,
} from '../types'
import {
  analyseWinLoss,
  analyseOutcomeTrend,
  declineEscalationReason,
  rateToDecimal,
  valueBandFor,
  ANALYSIS_LOOKBACK_MONTHS,
  MIN_WIN_LOSS_SAMPLE_SIZE,
  WIN_LOSS_ALGORITHM_VERSION,
  UNKNOWN_KEY,
  type OutcomeObservation,
  type SegmentResult,
  type WinLossAnalysis,
  type OutcomeTrend,
} from './winLossAnalysis'
import {
  rankRecommendations,
  CAPTURE_ALGORITHM_VERSION,
  type CaptureInput,
  type CaptureRecommendationResult,
  type CapacityEvidence,
} from './captureFocus'
import {
  buildRoadmap,
  ROADMAP_ALGORITHM_VERSION,
  type GapCategory,
  type GapObservation,
  type RoadmapResult,
} from './capabilityRoadmap'
import { SUBMISSION_OUTCOME_RECORDED, CALIBRATION_UPDATED, CONTRACT_AWARDED } from './intelligenceEvents'

export const INTELLIGENCE_AGENT_KEY = 'INTELLIGENCE' as const
export const INTELLIGENCE_METHOD_VERSION = 'intelligence-v1'

const MONTH_MS = 30 * 86_400_000

/**
 * HHI above which portfolio concentration is escalated.
 *
 * 0.25 is the conventional "highly concentrated" threshold on a 0–1 scale. It
 * is Bytescon monitoring policy, not a legal or regulatory requirement, and
 * nothing here claims diversification is required.
 */
export const CONCENTRATION_HHI_THRESHOLD = 0.25

/** Ceiling on outcomes read in one sweep. */
export const MAX_OUTCOMES_PER_RUN = 2000

export const INTELLIGENCE_PHASES = [
  'LOAD_OUTCOME_HISTORY',
  'VALIDATE_OUTCOME_EVIDENCE',
  'BUILD_WIN_LOSS_SEGMENTS',
  'COMPUTE_WILSON_INTERVALS',
  'ANALYZE_AGENCY_PERFORMANCE',
  'ANALYZE_NAICS_PERFORMANCE',
  'ANALYZE_VEHICLE_PERFORMANCE',
  'ANALYZE_SET_ASIDE_PERFORMANCE',
  'ANALYZE_VALUE_BANDS',
  'COMPUTE_TRENDS',
  'COMPUTE_CONCENTRATION_RISK',
  'BUILD_PUBLIC_COMPARABLE_BENCHMARK',
  'BUILD_CAPTURE_FOCUS',
  'BUILD_CAPABILITY_ROADMAP',
  'BUILD_PORTFOLIO_INTELLIGENCE',
  'CREATE_NOTIFICATIONS',
  'CREATE_ESCALATIONS',
  'COMPLETE',
] as const

export type IntelligencePhase = (typeof INTELLIGENCE_PHASES)[number]

const TAIL: IntelligencePhase[] = ['BUILD_PORTFOLIO_INTELLIGENCE', 'CREATE_NOTIFICATIONS', 'CREATE_ESCALATIONS', 'COMPLETE']

/**
 * Only the phases a trigger needs.
 *
 * A calibration change alters how a PREDICTION is interpreted; it changes no
 * recorded outcome, so the public benchmark and the capability roadmap are not
 * re-derived for it.
 */
export function phasesForRun(triggerEventType: string | null): IntelligencePhase[] {
  if (triggerEventType === CALIBRATION_UPDATED) {
    return [
      'LOAD_OUTCOME_HISTORY', 'VALIDATE_OUTCOME_EVIDENCE', 'BUILD_WIN_LOSS_SEGMENTS',
      'COMPUTE_WILSON_INTERVALS', 'COMPUTE_TRENDS', ...TAIL,
    ]
  }
  if (triggerEventType === CONTRACT_AWARDED) {
    return [
      'LOAD_OUTCOME_HISTORY', 'VALIDATE_OUTCOME_EVIDENCE', 'BUILD_WIN_LOSS_SEGMENTS',
      'COMPUTE_WILSON_INTERVALS', 'COMPUTE_CONCENTRATION_RISK', ...TAIL,
    ]
  }
  return [...INTELLIGENCE_PHASES]
}

// -------------------------------------------------------------
// Artifact shape
// -------------------------------------------------------------

export interface PortfolioIntelligenceArtifact {
  generatedAt: string
  methodVersion: string
  analysisPeriod: { start: string; end: string; lookbackMonths: number }
  outcomeSummary: {
    confirmedWins: number
    confirmedLosses: number
    pending: number
    confirmedSampleSize: number
    minimumSampleSize: number
    additionalOutcomesNeeded: number
    dataSufficiency: string
    /** Null below the minimum sample. Never 0 as a placeholder. */
    winRate: number | null
    intervalLower: number | null
    intervalUpper: number | null
    intervalMethod: string
    /** The canonical RateBasis vocabulary, so the label is never overstated. */
    rateBasis: 'CONFIRMED_WIN_RATE' | 'INSUFFICIENT_DATA'
    duplicatesCollapsed: number
    nonContestExcluded: number
  }
  segments: {
    agencies: SegmentResult[]
    naics: SegmentResult[]
    vehicles: SegmentResult[]
    setAsides: SegmentResult[]
    valueBands: SegmentResult[]
  }
  trends: {
    overall: OutcomeTrend | null
    method: string
    limitations: string[]
  }
  concentration: {
    basis: string
    hhi: number | null
    state: 'CONCENTRATED' | 'MODERATE' | 'DIVERSIFIED' | 'INSUFFICIENT_DATA'
    threshold: number
    dominantSegments: Array<{ key: string; share: number; expectedValue: number }>
    limitations: string[]
  }
  comparablePublicBenchmark: {
    status: string
    /** Always says PUBLIC. It is never another customer's data. */
    sourceDescription: string
    cohortSize: number
    minimumCohortSize: number
    cohortRules: string[]
    sourceIds: string[]
    relaxedFilters: string[]
    statistics: Record<string, string | null>
    /** Award share is not a win rate. Named accordingly. */
    rateBasis: 'OBSERVED_AWARD_SHARE' | 'INSUFFICIENT_DATA'
    benchmarkHash: string | null
    limitations: string[]
  }
  captureFocus: CaptureRecommendationResult[]
  capabilityRoadmap: RoadmapResult
  outcomeDataQuality: {
    submittedWithoutOutcome: number
    overdueWithoutOutcome: number
    state: 'OK' | 'OUTCOME_DATA_INCOMPLETE'
    detail: string
  }
  notifications: string[]
  escalations: string[]
  /** Explicit zero counters — a regression appears as a number, not a silence. */
  advisoryOnly: {
    bidDecisionsChanged: 0
    pursuitsReprioritised: 0
    matchWeightsChanged: 0
    qualificationThresholdsChanged: 0
    pricingScenariosChanged: 0
    capabilitiesChanged: 0
    calibrationsChanged: 0
    externalSubmissions: 0
  }
  warnings: string[]
  /** Always present, even when empty. */
  dataLimitations: string[]
  inputHash: string
}

// -------------------------------------------------------------
// Loading
// -------------------------------------------------------------

/**
 * Read the firm's confirmed and pending participation outcomes.
 *
 * The only source is `SubmissionRecord`, joined to its opportunity for the
 * segmentation dimensions. A BidDecision is deliberately not read here: a
 * decision to bid is not a result.
 */
async function loadOutcomes(consultingFirmId: string, periodStart: Date): Promise<{
  observations: OutcomeObservation[]
  submittedWithoutOutcome: number
  overdueWithoutOutcome: number
}> {
  const records = await prisma.submissionRecord.findMany({
    where: {
      consultingFirmId,
      OR: [
        { outcomeRecordedAt: { gte: periodStart } },
        { submittedAt: { gte: periodStart } },
        { AND: [{ outcomeRecordedAt: null }, { submittedAt: null }, { createdAt: { gte: periodStart } }] },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_OUTCOMES_PER_RUN,
    select: {
      id: true,
      opportunityId: true,
      outcome: true,
      outcomeRecordedAt: true,
      submittedAt: true,
      createdAt: true,
      opportunity: {
        select: {
          id: true, agency: true, naicsCode: true, setAsideType: true,
          contractVehicle: true, estimatedValue: true, responseDeadline: true,
        },
      },
    },
  })

  const now = new Date()
  let submittedWithoutOutcome = 0
  let overdueWithoutOutcome = 0

  const observations: OutcomeObservation[] = records.map((r) => {
    if (r.outcome === null && r.submittedAt !== null) {
      submittedWithoutOutcome += 1
      // An award notice normally follows within a couple of months of the
      // response deadline. Long past that with nothing recorded is a data-
      // quality signal — it is NOT evidence of a loss.
      const deadline = r.opportunity?.responseDeadline
      if (deadline && now.getTime() - deadline.getTime() > 3 * MONTH_MS) overdueWithoutOutcome += 1
    }
    return {
      outcomeId: r.id,
      // The opportunity IS the real-world contest. Two records pointing at one
      // opportunity describe one procurement, not two.
      pursuitKey: r.opportunityId,
      outcome: r.outcome,
      recordedAt: r.outcomeRecordedAt,
      submittedAt: r.submittedAt ?? r.createdAt,
      agency: r.opportunity?.agency ?? null,
      naicsCode: r.opportunity?.naicsCode ?? null,
      contractVehicle: r.opportunity?.contractVehicle ?? null,
      setAside: r.opportunity?.setAsideType ?? null,
      estimatedValue: r.opportunity?.estimatedValue != null ? Number(r.opportunity.estimatedValue) : null,
    }
  })

  return { observations, submittedWithoutOutcome, overdueWithoutOutcome }
}

/** Capacity evidence from the canonical portfolio computation. */
function capacityFromPortfolio(conflicts: Array<{ date: string; count: number }>, hasRows: boolean): CapacityEvidence {
  if (!hasRows) {
    return {
      state: 'INSUFFICIENT_DATA',
      detail: 'No active pursuits are recorded, so capacity cannot be assessed. This is not evidence that capacity is available.',
      conflictCount: 0,
    }
  }
  if (conflicts.length === 0) {
    return { state: 'AVAILABLE', detail: 'No deadline clustering was detected across the active pursuit set.', conflictCount: 0 }
  }
  return {
    state: 'CONSTRAINED',
    detail: `${conflicts.length} date(s) carry a cluster of pursuit deadlines, which the portfolio view flags as a capacity conflict.`,
    conflictCount: conflicts.length,
  }
}

// -------------------------------------------------------------
// Public benchmark
// -------------------------------------------------------------

/**
 * The comparable-firm benchmark, from PUBLIC award data only.
 *
 * Delegates entirely to the §7.6 `buildAwardBenchmark`, which reads
 * `AwardHistory` — federal award records — and no private model of any tenant.
 * No second cohort engine is created here.
 *
 * The result is an OBSERVED AWARD SHARE picture. Public award records carry no
 * bid-participation denominator, so nothing here is called a win rate.
 */
async function buildPublicBenchmark(args: {
  consultingFirmId: string
  topNaics: string | null
  topAgency: string | null
  now: Date
}): Promise<PortfolioIntelligenceArtifact['comparablePublicBenchmark']> {
  const base = {
    sourceDescription: 'Public federal award records (AwardHistory, sourced from USAspending/FPDS ingestion). No other customer’s data is read.',
    minimumCohortSize: MIN_BENCHMARK_COHORT_SIZE,
    rateBasis: 'INSUFFICIENT_DATA' as const,
  }

  if (!args.topNaics) {
    return {
      ...base,
      status: 'INSUFFICIENT_DATA',
      cohortSize: 0,
      cohortRules: [],
      sourceIds: [],
      relaxedFilters: [],
      statistics: {},
      benchmarkHash: null,
      limitations: ['No NAICS could be established from the firm’s own outcome history, so no comparable public cohort can be selected.'],
    }
  }

  const result = await buildAwardBenchmark({
    consultingFirmId: args.consultingFirmId,
    opportunityId: null,
    pricingWorkspaceId: null,
    pricingScenarioId: null,
    naics: args.topNaics,
    agency: args.topAgency,
    setAside: null,
    // No reference price: Intelligence wants the public award-value picture,
    // not a position within a band around a proposed price.
    referencePrice: null,
    now: args.now,
  })

  const sufficient = result.cohortSize >= MIN_BENCHMARK_COHORT_SIZE
  return {
    ...base,
    status: result.dataSufficiency,
    cohortSize: result.cohortSize,
    cohortRules: [
      `NAICS ${args.topNaics}`,
      args.topAgency ? `Agency ${args.topAgency}` : 'Agency not constrained',
      `Filter level ${result.filterLevel}`,
    ],
    sourceIds: result.sourceIds.slice(0, 100),
    relaxedFilters: [...result.relaxedFilters],
    statistics: sufficient
      ? {
          median: result.distribution.median?.toFixed(2) ?? null,
          p25: result.distribution.p25?.toFixed(2) ?? null,
          p75: result.distribution.p75?.toFixed(2) ?? null,
          minimum: result.distribution.minimum?.toFixed(2) ?? null,
          maximum: result.distribution.maximum?.toFixed(2) ?? null,
        }
      : {},
    rateBasis: sufficient ? 'OBSERVED_AWARD_SHARE' : 'INSUFFICIENT_DATA',
    benchmarkHash: result.inputHash,
    limitations: [
      ...result.limitations,
      'Public award records show who was awarded, not who bid. This is an observed award-value distribution, not a competitor win rate.',
      ...(sufficient ? [] : [`Fewer than ${MIN_BENCHMARK_COHORT_SIZE} comparable public awards were found, so no distribution is reported.`]),
    ],
  }
}

// -------------------------------------------------------------
// Persistence
// -------------------------------------------------------------

/** Supersede prior live segments and write the new set. History is preserved. */
async function persistSegments(ctx: AgentExecutionContext, analysis: WinLossAnalysis, now: Date): Promise<number> {
  const all: SegmentResult[] = [
    analysis.overall, ...analysis.agencies, ...analysis.naics,
    ...analysis.vehicles, ...analysis.setAsides, ...analysis.valueBands,
  ]

  const previous = await prisma.winLossSegment.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, supersededAt: null },
    select: { id: true, segmentType: true, segmentKey: true, inputHash: true },
  })
  const previousByKey = new Map(previous.map((p) => [`${p.segmentType}:${p.segmentKey}`, p]))

  // Nothing material changed: leave the existing rows alone rather than
  // writing an identical generation and burying the audit trail.
  const changed = all.filter((s) => previousByKey.get(`${s.segmentType}:${s.segmentKey}`)?.inputHash !== s.inputHash)
  if (changed.length === 0 && previous.length > 0) return 0

  await prisma.$transaction(async (tx) => {
    if (previous.length > 0) {
      await tx.winLossSegment.updateMany({
        where: { consultingFirmId: ctx.consultingFirmId, supersededAt: null },
        data: { supersededAt: now },
      })
    }
    await tx.winLossSegment.createMany({
      data: all.map((s) => ({
        consultingFirmId: ctx.consultingFirmId,
        segmentType: s.segmentType,
        segmentKey: s.segmentKey,
        segmentLabel: s.segmentLabel,
        periodStart: analysis.periodStart,
        periodEnd: analysis.periodEnd,
        wins: s.wins,
        losses: s.losses,
        pending: s.pending,
        sampleSize: s.sampleSize,
        minimumSampleSize: s.minimumSampleSize,
        winRate: rateToDecimal(s.winRate),
        intervalLower: rateToDecimal(s.intervalLower),
        intervalUpper: rateToDecimal(s.intervalUpper),
        dataSufficiency: s.dataSufficiency,
        sourceOutcomeIds: s.sourceOutcomeIds,
        limitations: s.limitations,
        algorithmVersion: s.algorithmVersion,
        inputHash: s.inputHash,
        agentRunId: ctx.runId,
        supersedesId: previousByKey.get(`${s.segmentType}:${s.segmentKey}`)?.id ?? null,
        computedAt: now,
      })),
    })
  })
  return all.length
}

/**
 * Persist recommendations, honouring dismissals.
 *
 * A recommendation a person dismissed stays dismissed for the SAME evidence
 * fingerprint. Only materially changed evidence produces a new active version,
 * so the weekly run never re-raises what was already declined.
 */
async function persistRecommendations(
  ctx: AgentExecutionContext,
  results: CaptureRecommendationResult[],
  period: { start: Date; end: Date },
  now: Date,
): Promise<{ created: number; suppressedByDismissal: number }> {
  const dismissed = await prisma.captureRecommendation.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, status: 'DISMISSED' },
    select: { inputHash: true },
  })
  const dismissedHashes = new Set(dismissed.map((d) => d.inputHash))

  const fresh = results.filter((r) => !dismissedHashes.has(r.inputHash))
  const suppressedByDismissal = results.length - fresh.length

  const live = await prisma.captureRecommendation.findMany({
    where: { consultingFirmId: ctx.consultingFirmId, status: 'ACTIVE' },
    select: { id: true, inputHash: true },
  })
  const liveHashes = new Set(live.map((l) => l.inputHash))
  const unchanged = fresh.every((r) => liveHashes.has(r.inputHash)) && fresh.length === live.length
  if (unchanged && live.length > 0) return { created: 0, suppressedByDismissal }

  await prisma.$transaction(async (tx) => {
    if (live.length > 0) {
      await tx.captureRecommendation.updateMany({
        where: { consultingFirmId: ctx.consultingFirmId, status: 'ACTIVE' },
        data: { status: 'SUPERSEDED', supersededAt: now },
      })
    }
    for (const r of fresh) {
      await tx.captureRecommendation.create({
        data: {
          consultingFirmId: ctx.consultingFirmId,
          segmentType: r.segmentType,
          segmentKey: r.segmentKey,
          segmentLabel: r.segmentLabel,
          periodStart: period.start,
          periodEnd: period.end,
          score: r.score === null ? null : new Prisma.Decimal(r.score.toFixed(4)),
          scoreState: r.scoreState,
          rank: r.rank,
          rationale: r.rationale,
          evidence: r.evidence as Prisma.InputJsonObject,
          sampleSize: r.sampleSize,
          dataSufficiency: r.dataSufficiency,
          status: 'ACTIVE',
          inputHash: r.inputHash,
          algorithmVersion: r.algorithmVersion,
          agentRunId: ctx.runId,
        },
      })
    }
  })
  return { created: fresh.length, suppressedByDismissal }
}

// -------------------------------------------------------------
// Handler
// -------------------------------------------------------------

export async function intelligenceAgentHandler(ctx: AgentExecutionContext): Promise<AgentHandlerResult> {
  const now = new Date()
  const triggerEventType = await resolveTriggerEventType(ctx)
  const phases = phasesForRun(triggerEventType)

  const warnings: string[] = []
  const limitations: string[] = []
  const evidence: EvidenceRef[] = []
  const escalations: ProposedEscalation[] = []
  const notifications: string[] = []
  let componentsFailed = 0

  const periodStart = new Date(now.getTime() - ANALYSIS_LOOKBACK_MONTHS * MONTH_MS)

  ctx.log('intelligence scope resolved', {
    triggerEventType,
    lookbackMonths: ANALYSIS_LOOKBACK_MONTHS,
    autonomyLevel: ctx.autonomyLevel,
  })

  // ---- LOAD_OUTCOME_HISTORY ------------------------------------------------
  const { observations, submittedWithoutOutcome, overdueWithoutOutcome } = await loadOutcomes(ctx.consultingFirmId, periodStart)
  await ctx.heartbeat(15, 'outcome history loaded').catch(() => undefined)

  // ---- BUILD_WIN_LOSS_SEGMENTS / COMPUTE_WILSON_INTERVALS ------------------
  const analysis = analyseWinLoss({ observations, periodStart, periodEnd: now })
  limitations.push(...analysis.limitations)
  evidence.push({
    sourceType: 'SubmissionRecord',
    sourceId: null,
    retrievedAt: now.toISOString(),
    note:
      `${analysis.overall.sampleSize} confirmed outcome(s) (${analysis.overall.wins}W/${analysis.overall.losses}L) ` +
      `and ${analysis.overall.pending} pending across ${ANALYSIS_LOOKBACK_MONTHS} months. Minimum sample ${MIN_WIN_LOSS_SAMPLE_SIZE}.`,
  })

  const segmentsWritten = await persistSegments(ctx, analysis, now)
  await ctx.heartbeat(35, 'segments computed').catch(() => undefined)

  // ---- COMPUTE_TRENDS -------------------------------------------------------
  let trend: OutcomeTrend | null = null
  if (phases.includes('COMPUTE_TRENDS')) {
    try {
      trend = analyseOutcomeTrend(observations, computeEMA, detectDirection)
      limitations.push(...trend.limitations)
    } catch (err) {
      componentsFailed += 1
      warnings.push(`Trend analysis could not be completed: ${(err as Error).message}`)
    }
  }

  // ---- COMPUTE_CONCENTRATION_RISK ------------------------------------------
  let concentration: PortfolioIntelligenceArtifact['concentration'] = {
    basis: 'Expected pipeline value by agency (portfolioValue hierarchy)',
    hhi: null,
    state: 'INSUFFICIENT_DATA',
    threshold: CONCENTRATION_HHI_THRESHOLD,
    dominantSegments: [],
    limitations: ['Concentration was not computed for this run.'],
  }
  let portfolio: Awaited<ReturnType<typeof computePortfolio>> | null = null

  if (phases.includes('COMPUTE_CONCENTRATION_RISK') || phases.includes('BUILD_CAPTURE_FOCUS')) {
    try {
      portfolio = await computePortfolio(ctx.consultingFirmId, { now })
      const byAgency = portfolio.byAgency.filter((a) => a.expected > 0)
      const index = hhi(byAgency.map((a) => a.expected))
      const totalExpected = byAgency.reduce((s, a) => s + a.expected, 0)

      concentration = {
        basis: 'Expected pipeline value by agency, using the canonical portfolioValue hierarchy and its exclusions',
        hhi: index,
        state: index === null ? 'INSUFFICIENT_DATA' : index >= CONCENTRATION_HHI_THRESHOLD ? 'CONCENTRATED' : index >= 0.15 ? 'MODERATE' : 'DIVERSIFIED',
        threshold: CONCENTRATION_HHI_THRESHOLD,
        dominantSegments: byAgency
          .slice(0, 5)
          .map((a) => ({ key: a.key, share: totalExpected > 0 ? Number((a.expected / totalExpected).toFixed(4)) : 0, expectedValue: a.expected })),
        limitations: portfolio.exclusions.length > 0
          ? [`${portfolio.exclusions.length} opportunity(ies) were excluded from the value basis by the canonical hierarchy — they are not counted as zero.`]
          : [],
      }
      limitations.push(...concentration.limitations)
    } catch (err) {
      // One broken analytics component must not discard the rest.
      componentsFailed += 1
      warnings.push(`Concentration analysis could not be completed: ${(err as Error).message}`)
      logger.error('Intelligence concentration failed (continuing)', { runId: ctx.runId, error: (err as Error).message })
    }
  }
  await ctx.heartbeat(55, 'concentration computed').catch(() => undefined)

  // ---- BUILD_PUBLIC_COMPARABLE_BENCHMARK -----------------------------------
  let benchmark: PortfolioIntelligenceArtifact['comparablePublicBenchmark'] = {
    status: 'NOT_COMPUTED',
    sourceDescription: 'Public federal award records only.',
    cohortSize: 0,
    minimumCohortSize: MIN_BENCHMARK_COHORT_SIZE,
    cohortRules: [],
    sourceIds: [],
    relaxedFilters: [],
    statistics: {},
    rateBasis: 'INSUFFICIENT_DATA',
    benchmarkHash: null,
    limitations: ['The public benchmark was not computed for this run.'],
  }
  if (phases.includes('BUILD_PUBLIC_COMPARABLE_BENCHMARK')) {
    try {
      const topNaics = analysis.naics.find((n) => n.segmentKey !== UNKNOWN_KEY)?.segmentKey ?? null
      const topAgency = analysis.agencies.find((a) => a.segmentKey !== UNKNOWN_KEY)?.segmentKey ?? null
      benchmark = await buildPublicBenchmark({ consultingFirmId: ctx.consultingFirmId, topNaics, topAgency, now })
      limitations.push(...benchmark.limitations)
      evidence.push({
        sourceType: 'AwardHistory',
        sourceId: benchmark.benchmarkHash,
        retrievedAt: now.toISOString(),
        note: `${benchmark.cohortSize} public award(s) in the comparable cohort. ${benchmark.sourceDescription}`,
      })
    } catch (err) {
      componentsFailed += 1
      warnings.push(`Public benchmark could not be built: ${(err as Error).message}`)
    }
  }
  await ctx.heartbeat(70, 'benchmark built').catch(() => undefined)

  // ---- BUILD_CAPTURE_FOCUS ---------------------------------------------------
  let captureFocus: CaptureRecommendationResult[] = []
  let suppressedByDismissal = 0
  if (phases.includes('BUILD_CAPTURE_FOCUS')) {
    try {
      const capacity = capacityFromPortfolio(portfolio?.capacityConflicts ?? [], (portfolio?.rows.length ?? 0) > 0)
      const evByAgency = new Map((portfolio?.byAgency ?? []).map((a) => [a.key, a]))
      const evByNaics = new Map((portfolio?.byNaics ?? []).map((n) => [n.key, n]))

      const inputs: CaptureInput[] = [
        ...analysis.agencies.filter((s) => s.segmentKey !== UNKNOWN_KEY).map((segment) => {
          const ev = evByAgency.get(segment.segmentKey)
          return {
            segment,
            pipeline: {
              expectedValue: ev ? ev.expected : null,
              opportunityCount: ev?.count ?? 0,
              excludedCount: portfolio?.exclusions.length ?? 0,
              valueSourceNote: `Canonical value hierarchy: ${VALUE_SOURCE_ORDER.map((v) => v.key).join(' → ')}`,
            },
            capacity,
            trend,
            publicBenchmarkNote:
              benchmark.rateBasis === 'OBSERVED_AWARD_SHARE'
                ? `A comparable public cohort of ${benchmark.cohortSize} award(s) exists for context. Public awards show who won, not who bid, so this is not a competitor win rate.`
                : null,
          }
        }),
        ...analysis.naics.filter((s) => s.segmentKey !== UNKNOWN_KEY).map((segment) => {
          const ev = evByNaics.get(segment.segmentKey)
          return {
            segment,
            pipeline: {
              expectedValue: ev ? ev.expected : null,
              opportunityCount: ev?.count ?? 0,
              excludedCount: portfolio?.exclusions.length ?? 0,
              valueSourceNote: `Canonical value hierarchy: ${VALUE_SOURCE_ORDER.map((v) => v.key).join(' → ')}`,
            },
            capacity,
            trend,
            publicBenchmarkNote: null,
          }
        }),
      ]

      captureFocus = rankRecommendations(inputs)
      const persisted = await persistRecommendations(ctx, captureFocus, { start: periodStart, end: now }, now)
      suppressedByDismissal = persisted.suppressedByDismissal
      if (suppressedByDismissal > 0) {
        limitations.push(`${suppressedByDismissal} recommendation(s) matched evidence a person has already dismissed and were not re-raised.`)
      }
    } catch (err) {
      componentsFailed += 1
      warnings.push(`Capture focus could not be built: ${(err as Error).message}`)
      logger.error('Intelligence capture focus failed (continuing)', { runId: ctx.runId, error: (err as Error).message })
    }
  }

  // ---- BUILD_CAPABILITY_ROADMAP ----------------------------------------------
  let roadmap: RoadmapResult = { items: [], totalGapsObserved: 0, distinctGaps: 0, nonRecurringGaps: 0, limitations: [], algorithmVersion: ROADMAP_ALGORITHM_VERSION }
  if (phases.includes('BUILD_CAPABILITY_ROADMAP')) {
    try {
      roadmap = await buildRoadmapForFirm(ctx.consultingFirmId)
      limitations.push(...roadmap.limitations)
    } catch (err) {
      componentsFailed += 1
      warnings.push(`Capability roadmap could not be built: ${(err as Error).message}`)
      logger.error('Intelligence roadmap failed (continuing)', { runId: ctx.runId, error: (err as Error).message })
    }
  }
  await ctx.heartbeat(85, 'recommendations built').catch(() => undefined)

  // ---- CREATE_ESCALATIONS -----------------------------------------------------
  if (concentration.hhi !== null && concentration.hhi >= CONCENTRATION_HHI_THRESHOLD) {
    escalations.push({
      severity: 'MEDIUM',
      title: `Pipeline concentration above the ${CONCENTRATION_HHI_THRESHOLD} monitoring threshold`,
      reason:
        `Expected pipeline value is concentrated at an HHI of ${concentration.hhi} against a Bytescon monitoring threshold of ${CONCENTRATION_HHI_THRESHOLD}, ` +
        `measured on ${concentration.basis}. Dominant: ${concentration.dominantSegments.map((d) => `${d.key} ${(d.share * 100).toFixed(1)}%`).join(', ')}. ` +
        'This is a monitoring signal, not a claim that diversification is required.',
      recommendedAction: 'Review whether the pipeline mix reflects the firm’s intent. The agent has changed no pursuit or priority.',
      entityType: 'ConsultingFirm',
      entityId: ctx.consultingFirmId,
      dedupeHint: `intel-concentration:${concentration.hhi}:${concentration.dominantSegments.map((d) => d.key).join('|')}`,
    })
  }

  if (trend?.consecutiveDecline && analysis.overall.dataSufficiency === 'SUFFICIENT') {
    escalations.push({
      severity: 'MEDIUM',
      title: 'Confirmed win rate declining across consecutive quarters',
      reason: declineEscalationReason(trend, analysis.overall),
      recommendedAction: 'Review recent losses for a common cause. The agent has changed no decision or weight.',
      entityType: 'ConsultingFirm',
      entityId: ctx.consultingFirmId,
      dedupeHint: `intel-decline:${trend.periods.filter((p) => p.winRate !== null).slice(-3).map((p) => p.period).join('|')}`,
    })
  }

  // ---- CREATE_NOTIFICATIONS ---------------------------------------------------
  if (phases.includes('CREATE_NOTIFICATIONS') && ctx.autonomyLevel !== 'OBSERVE') {
    const recipients = await prisma.user.findMany({
      where: { consultingFirmId: ctx.consultingFirmId, role: 'ADMIN', isActive: true },
      select: { id: true },
      take: 10,
    })
    const scored = captureFocus.filter((r) => r.scoreState === 'SCORED')
    for (const { id: userId } of recipients) {
      if (scored.length > 0) {
        await notifyUser({
          consultingFirmId: ctx.consultingFirmId,
          userId,
          type: 'AGENT_ESCALATION',
          title: `${scored.length} evidence-backed capture recommendation(s) available`,
          body: 'Built from your confirmed outcomes and qualified pipeline. Advisory only — nothing in the pipeline has been changed.',
          linkPath: '/portfolio',
          entityType: 'CaptureRecommendation',
          dedupeKey: `intel-capture:${ctx.consultingFirmId}:${scored.map((r) => r.inputHash).sort().join('').slice(0, 60)}`,
        })
        notifications.push(`${scored.length} capture recommendation(s)`)
      }
      if (trend?.consecutiveDecline) {
        await notifyUser({
          consultingFirmId: ctx.consultingFirmId,
          userId,
          type: 'AGENT_ESCALATION',
          title: 'Confirmed win rate is declining across consecutive quarters',
          body: declineEscalationReason(trend, analysis.overall),
          linkPath: '/analytics',
          entityType: 'ConsultingFirm',
          entityId: ctx.consultingFirmId,
          dedupeKey: `intel-decline:${ctx.consultingFirmId}:${trend.periods.filter((p) => p.winRate !== null).slice(-3).map((p) => p.period).join('|')}:${userId}`,
        })
        notifications.push('Win-rate decline')
      }
    }
  }

  // ---- BUILD_PORTFOLIO_INTELLIGENCE -------------------------------------------
  const o = analysis.overall
  const sufficient = o.dataSufficiency === 'SUFFICIENT'

  if (!sufficient) {
    // Prominent, not buried. This is the honest answer for most new tenants.
    limitations.unshift(
      `A confirmed win rate cannot yet be reported. ${o.sampleSize} confirmed outcome(s) are available and ` +
        `${MIN_WIN_LOSS_SAMPLE_SIZE} are required — ${Math.max(0, MIN_WIN_LOSS_SAMPLE_SIZE - o.sampleSize)} more confirmed outcome(s) needed. ` +
        'No win rate is reported rather than a misleading zero, and public award data is never substituted for the firm’s own record.',
    )
  }

  const artifact: PortfolioIntelligenceArtifact = {
    generatedAt: now.toISOString(),
    methodVersion: INTELLIGENCE_METHOD_VERSION,
    analysisPeriod: { start: periodStart.toISOString(), end: now.toISOString(), lookbackMonths: ANALYSIS_LOOKBACK_MONTHS },
    outcomeSummary: {
      confirmedWins: o.wins,
      confirmedLosses: o.losses,
      pending: o.pending,
      confirmedSampleSize: o.sampleSize,
      minimumSampleSize: MIN_WIN_LOSS_SAMPLE_SIZE,
      additionalOutcomesNeeded: Math.max(0, MIN_WIN_LOSS_SAMPLE_SIZE - o.sampleSize),
      dataSufficiency: o.dataSufficiency,
      winRate: o.winRate,
      intervalLower: o.intervalLower,
      intervalUpper: o.intervalUpper,
      intervalMethod: CONFIDENCE_METHOD,
      rateBasis: sufficient ? 'CONFIRMED_WIN_RATE' : 'INSUFFICIENT_DATA',
      duplicatesCollapsed: analysis.duplicatesCollapsed,
      nonContestExcluded: analysis.nonContestExcluded,
    },
    segments: {
      agencies: analysis.agencies,
      naics: analysis.naics,
      vehicles: analysis.vehicles,
      setAsides: analysis.setAsides,
      valueBands: analysis.valueBands,
    },
    trends: { overall: trend, method: trend?.method ?? 'ema-span-3', limitations: trend?.limitations ?? [] },
    concentration,
    comparablePublicBenchmark: benchmark,
    captureFocus,
    capabilityRoadmap: roadmap,
    outcomeDataQuality: {
      submittedWithoutOutcome,
      overdueWithoutOutcome,
      state: overdueWithoutOutcome > 0 ? 'OUTCOME_DATA_INCOMPLETE' : 'OK',
      detail: overdueWithoutOutcome > 0
        ? `${overdueWithoutOutcome} submitted pursuit(s) passed their response deadline more than three months ago with no outcome recorded. They remain pending — the agent does not guess a loss.`
        : 'No submitted pursuit is long overdue for an outcome.',
    },
    notifications,
    escalations: escalations.map((e) => e.title),
    advisoryOnly: {
      bidDecisionsChanged: 0,
      pursuitsReprioritised: 0,
      matchWeightsChanged: 0,
      qualificationThresholdsChanged: 0,
      pricingScenariosChanged: 0,
      capabilitiesChanged: 0,
      calibrationsChanged: 0,
      externalSubmissions: 0,
    },
    warnings,
    dataLimitations: [...new Set(limitations)],
    inputHash: '',
  }
  artifact.inputHash = buildArtifactHash(artifact)

  const proposed: ProposedArtifact = {
    artifactType: 'PORTFOLIO_INTELLIGENCE',
    title: `Portfolio intelligence — ${o.sampleSize} confirmed outcome(s)`,
    summary: sufficient
      ? `Confirmed win rate ${((o.winRate ?? 0) * 100).toFixed(1)}% across ${o.sampleSize} outcome(s)` +
        (captureFocus.length > 0 ? ` · ${captureFocus.length} capture recommendation(s)` : '')
      : `Insufficient confirmed outcomes: ${o.sampleSize} of ${MIN_WIN_LOSS_SAMPLE_SIZE} required`,
    structuredData: artifact as unknown as Record<string, unknown>,
    evidence,
    sourceEntityType: 'ConsultingFirm',
    sourceEntityId: ctx.consultingFirmId,
    confidenceState: sufficient ? 'HIGH' : 'LOW',
    supersedeKey: `portfolio-intelligence:${ctx.consultingFirmId}`,
  }

  const summaryParts = [
    sufficient
      ? `Confirmed win rate ${((o.winRate ?? 0) * 100).toFixed(1)}% from ${o.wins} win(s) and ${o.losses} loss(es).`
      : `${o.sampleSize} confirmed outcome(s) — ${Math.max(0, MIN_WIN_LOSS_SAMPLE_SIZE - o.sampleSize)} more needed before a win rate is reported.`,
    `${o.pending} pursuit(s) pending and excluded from the denominator.`,
  ]
  if (captureFocus.length > 0) summaryParts.push(`${captureFocus.length} capture recommendation(s).`)
  if (roadmap.items.length > 0) summaryParts.push(`${roadmap.items.length} recurring capability gap(s).`)
  if (componentsFailed > 0) summaryParts.push(`${componentsFailed} analysis component(s) failed and were reported rather than discarding the rest.`)
  summaryParts.push('Advisory only — no decision, weight, priority or record was changed.')

  return {
    status: 'COMPLETED',
    summary: summaryParts.join(' '),
    confidence: sufficient ? 'HIGH' : 'LOW',
    // The runtime enum is SUFFICIENT | PARTIAL | INSUFFICIENT; the analysis
    // vocabulary uses INSUFFICIENT_DATA. Mapped explicitly, not coerced.
    dataSufficiency: sufficient ? (componentsFailed > 0 ? 'PARTIAL' : 'SUFFICIENT') : 'INSUFFICIENT',
    evidence,
    artifacts: [proposed],
    escalations,
    metrics: {
      confirmedOutcomes: o.sampleSize,
      confirmedWins: o.wins,
      confirmedLosses: o.losses,
      pendingOutcomes: o.pending,
      duplicatesCollapsed: analysis.duplicatesCollapsed,
      nonContestExcluded: analysis.nonContestExcluded,
      segmentsWritten,
      captureRecommendations: captureFocus.length,
      recommendationsSuppressedByDismissal: suppressedByDismissal,
      roadmapItems: roadmap.items.length,
      componentsFailed,
      notificationsSent: notifications.length,
      escalationsRaised: escalations.length,
      // Explicit zeros: the advisory-only guarantees, as numbers.
      bidDecisionsChanged: 0,
      pursuitsReprioritised: 0,
      matchWeightsChanged: 0,
      pricingScenariosChanged: 0,
      capabilitiesChanged: 0,
      calibrationsChanged: 0,
      externalSubmissions: 0,
    },
    warnings,
    limitations: artifact.dataLimitations,
    inputSnapshot: { lookbackMonths: ANALYSIS_LOOKBACK_MONTHS, observations: observations.length },
    inputHash: artifact.inputHash,
  }
}

// -------------------------------------------------------------
// Capability roadmap loading
// -------------------------------------------------------------

const GAP_FIELDS: Array<{ field: keyof Pick<
  { missingCapabilities: string[]; missingCertifications: string[]; missingEligibility: string[]; capacityGaps: string[]; geographyGaps: string[]; vehicleGaps: string[]; partialCoverage: string[] },
  'missingCapabilities' | 'missingCertifications' | 'missingEligibility' | 'capacityGaps' | 'geographyGaps' | 'vehicleGaps' | 'partialCoverage'
>; category: GapCategory }> = [
  { field: 'missingEligibility', category: 'MISSING_ELIGIBILITY' },
  { field: 'missingCertifications', category: 'MISSING_CERTIFICATION' },
  { field: 'missingCapabilities', category: 'MISSING_CAPABILITY' },
  { field: 'vehicleGaps', category: 'VEHICLE' },
  { field: 'capacityGaps', category: 'CAPACITY' },
  { field: 'geographyGaps', category: 'GEOGRAPHY' },
  { field: 'partialCoverage', category: 'PARTIAL_COVERAGE' },
]

async function buildRoadmapForFirm(consultingFirmId: string): Promise<RoadmapResult> {
  const assessments = await prisma.capabilityGapAssessment.findMany({
    where: { consultingFirmId },
    take: 500,
    select: {
      id: true, opportunityId: true,
      missingCapabilities: true, missingCertifications: true, missingEligibility: true,
      capacityGaps: true, geographyGaps: true, vehicleGaps: true, partialCoverage: true,
      partnerRecommendations: true,
      opportunity: { select: { estimatedValue: true } },
    },
  })
  if (assessments.length === 0) {
    return { items: [], totalGapsObserved: 0, distinctGaps: 0, nonRecurringGaps: 0, algorithmVersion: ROADMAP_ALGORITHM_VERSION,
      limitations: ['No capability gap assessments exist for this firm, so no recurring gap can be identified.'] }
  }

  const pursuitOpportunityIds = new Set(
    (await prisma.bidPursuit.findMany({
      where: { consultingFirmId, opportunityId: { in: assessments.map((a) => a.opportunityId) } },
      select: { opportunityId: true },
    })).map((p) => p.opportunityId),
  )

  const observations: GapObservation[] = []
  for (const a of assessments) {
    const partners = Array.isArray(a.partnerRecommendations) ? (a.partnerRecommendations as Array<Record<string, unknown>>) : []
    const partnerNames = partners.map((p) => String(p?.partnerName ?? '')).filter(Boolean)
    const value = a.opportunity?.estimatedValue != null ? Number(a.opportunity.estimatedValue) : null

    for (const { field, category } of GAP_FIELDS) {
      for (const rawLabel of (a as unknown as Record<string, string[]>)[field] ?? []) {
        if (!rawLabel?.trim()) continue
        // A partner "closes" this gap only when the recommendation names it.
        const covers = partners.some((p) =>
          Array.isArray(p?.closes) && (p.closes as unknown[]).some((c) => String(c).toLowerCase() === rawLabel.toLowerCase()),
        )
        observations.push({
          assessmentId: a.id,
          opportunityId: a.opportunityId,
          category,
          rawLabel: rawLabel.trim(),
          opportunityValue: value,
          partnerCoverage: covers,
          partnerNames: covers ? partnerNames : [],
          isActivePursuit: pursuitOpportunityIds.has(a.opportunityId),
        })
      }
    }
  }

  return buildRoadmap(observations)
}

// -------------------------------------------------------------
// Trigger resolution and idempotency
// -------------------------------------------------------------

async function resolveTriggerEventType(ctx: AgentExecutionContext): Promise<string | null> {
  if (!ctx.eventId) return null
  const event = await prisma.agentEvent.findFirst({
    where: { id: ctx.eventId, consultingFirmId: ctx.consultingFirmId },
    select: { eventType: true },
  })
  return event?.eventType ?? null
}

/**
 * Digest of everything that makes the analysis materially different.
 *
 * Deliberately excludes `generatedAt` and every other wall-clock field: an
 * unchanged portfolio must hash identically next week.
 */
function buildArtifactHash(a: PortfolioIntelligenceArtifact): string {
  const material = {
    outcome: `${a.outcomeSummary.confirmedWins}:${a.outcomeSummary.confirmedLosses}:${a.outcomeSummary.pending}:${a.outcomeSummary.winRate ?? 'null'}`,
    segments: [
      ...a.segments.agencies, ...a.segments.naics, ...a.segments.vehicles,
      ...a.segments.setAsides, ...a.segments.valueBands,
    ].map((s) => s.inputHash).sort(),
    trend: a.trends.overall ? `${a.trends.overall.state}:${a.trends.overall.periodsWithSufficientSample}` : 'none',
    concentration: `${a.concentration.hhi ?? 'null'}:${a.concentration.state}`,
    benchmark: a.comparablePublicBenchmark.benchmarkHash ?? 'none',
    capture: a.captureFocus.map((c) => c.inputHash).sort(),
    roadmap: a.capabilityRoadmap.items.map((r) => r.inputHash).sort(),
  }
  return createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export { SUBMISSION_OUTCOME_RECORDED, CALIBRATION_UPDATED, CONTRACT_AWARDED, BENCHMARK_ALGORITHM_VERSION }
export type { SubmissionOutcome }
