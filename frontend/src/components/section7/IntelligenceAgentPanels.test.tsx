// =============================================================
// §7.9 — Intelligence Agent panels.
//
// Pins the small-sample presentation above everything else: a null win rate
// must read as INSUFFICIENT DATA with the real counts and the shortfall, never
// as 0%, never as a 50% placeholder, and never as a coloured ranking. A rate
// that IS reported must always appear with its sample and interval.
// =============================================================
import { render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const portfolioFn = vi.fn()
const recommendationsFn = vi.fn()
const dismissFn = vi.fn()
vi.mock('../../services/intelligenceAgentApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/intelligenceAgentApi')>()
  return {
    ...actual,
    intelligenceAgentApi: {
      portfolio: () => portfolioFn(),
      recommendations: () => recommendationsFn(),
      dismiss: (...a: unknown[]) => dismissFn(...a),
      acknowledge: vi.fn(),
    },
  }
})

import { WinLossIntelligencePanel, CaptureIntelligencePanel } from './IntelligenceAgentPanels'
import { formatRate, insufficientSampleMessage } from '../../services/intelligenceAgentApi'

const POLICY = {
  algorithmVersion: 'intelligence-winloss-v1',
  minimumSampleSize: 8,
  minimumTrendPeriods: 3,
  minimumGapRecurrence: 2,
  minimumPublicCohortSize: 7,
  concentrationThreshold: 0.25,
  analysisLookbackMonths: 36,
  intervalMethod: 'wilson-bin-v1',
  maxRecommendations: 10,
  valueBands: [{ key: 'UNDER_250K', label: 'Under $250K' }],
  confirmedOutcomes: ['WON', 'LOST'],
  nonContestOutcomes: ['NO_AWARD', 'WITHDRAWN'],
  notes: ['A win rate is reported only once 8 confirmed outcomes exist.'],
}

const segment = (over: Record<string, unknown> = {}) => ({
  segmentType: 'AGENCY', segmentKey: 'DoD', segmentLabel: 'Department of Defense',
  wins: 6, losses: 2, pending: 1, sampleSize: 8, minimumSampleSize: 8,
  winRate: 0.75, intervalLower: 0.4093, intervalUpper: 0.9367,
  dataSufficiency: 'SUFFICIENT', sourceOutcomeIds: [], limitations: [],
  algorithmVersion: 'v1', inputHash: 'h',
  ...over,
})

const intelligence = (over: Record<string, unknown> = {}) => ({
  artifactId: 'art-1',
  generatedAt: '2026-08-12T08:00:00.000Z',
  methodVersion: 'intelligence-v1',
  analysisPeriod: { start: '2023-08-12T00:00:00.000Z', end: '2026-08-12T00:00:00.000Z', lookbackMonths: 36 },
  outcomeSummary: {
    confirmedWins: 6, confirmedLosses: 2, pending: 3, confirmedSampleSize: 8,
    minimumSampleSize: 8, additionalOutcomesNeeded: 0, dataSufficiency: 'SUFFICIENT',
    winRate: 0.75, intervalLower: 0.4093, intervalUpper: 0.9367,
    intervalMethod: 'wilson-bin-v1', rateBasis: 'CONFIRMED_WIN_RATE',
    duplicatesCollapsed: 1, nonContestExcluded: 2,
  },
  segments: { agencies: [segment()], naics: [], vehicles: [], setAsides: [], valueBands: [] },
  trends: { overall: { state: 'STABLE', method: 'ema-span-3', periods: [], periodsWithSufficientSample: 3, consecutiveDecline: false, changePercent: 1.2, limitations: [] }, method: 'ema-span-3', limitations: [] },
  concentration: {
    basis: 'Expected pipeline value by agency, using the canonical portfolioValue hierarchy and its exclusions',
    hhi: 0.31, state: 'CONCENTRATED', threshold: 0.25,
    dominantSegments: [{ key: 'DoD', share: 0.55, expectedValue: 5_000_000 }], limitations: [],
  },
  comparablePublicBenchmark: {
    status: 'PARTIAL',
    sourceDescription: 'Public federal award records (AwardHistory, sourced from USAspending/FPDS ingestion). No other customer’s data is read.',
    cohortSize: 12, minimumCohortSize: 7, cohortRules: ['NAICS 541512', 'Agency DoD'],
    sourceIds: ['a1', 'a2'], relaxedFilters: [], statistics: { median: '1200000.00' },
    rateBasis: 'OBSERVED_AWARD_SHARE', benchmarkHash: 'bh',
    limitations: ['Public award records show who was awarded, not who bid. This is an observed award-value distribution, not a competitor win rate.'],
  },
  captureFocus: [],
  capabilityRoadmap: { items: [], totalGapsObserved: 0, distinctGaps: 0, nonRecurringGaps: 0, limitations: [] },
  outcomeDataQuality: { submittedWithoutOutcome: 3, overdueWithoutOutcome: 0, state: 'OK', detail: 'No submitted pursuit is long overdue.' },
  notifications: [], escalations: [], advisoryOnly: {}, warnings: [],
  dataLimitations: [],
  inputHash: 'ih',
  ...over,
})

const view = (over: Record<string, unknown> = {}) => ({
  agentKey: 'INTELLIGENCE',
  schedule: { isEnabled: true, cronExpression: '0 5 * * 1', nextRunAt: null, lastRunAt: null, lastSuccessfulRunAt: null, lastFailureAt: null, lastFailureMessage: null, autonomyLevel: 'PROPOSE' },
  lastRun: { id: 'run-abcd1234', status: 'COMPLETED', triggerType: 'SCHEDULE', createdAt: '2026-08-12T05:00:00.000Z', finishedAt: null, outputSummary: null, warnings: [], limitations: [], tokenInput: 0, tokenOutput: 0, estimatedCostUsd: '0.00' },
  intelligence: intelligence(),
  escalations: [],
  policy: POLICY,
  ...over,
})

const recommendation = (over: Record<string, unknown> = {}) => ({
  id: 'rec-1', segmentType: 'AGENCY', segmentKey: 'DoD', segmentLabel: 'Department of Defense',
  score: '600000.0000', scoreState: 'SCORED', rank: 1,
  rationale: 'Department of Defense has 8 confirmed outcomes: 6 wins and 2 losses, a confirmed win rate of 75.0%.',
  evidence: { winLoss: { wins: 6, losses: 2 } }, sampleSize: 8, dataSufficiency: 'SUFFICIENT',
  status: 'ACTIVE', dismissedByUserId: null, dismissedAt: null, dismissReason: null,
  createdAt: '2026-08-12T05:00:00.000Z',
  ...over,
})

beforeEach(() => {
  portfolioFn.mockReset()
  recommendationsFn.mockReset()
  dismissFn.mockReset()
  recommendationsFn.mockResolvedValue({ recommendations: [], policy: POLICY })
})

// =============================================================
// Rate rendering — the frontend never calculates
// =============================================================

describe('formatRate', () => {
  it('renders a supplied rate', () => {
    expect(formatRate(0.75)).toBe('75.0%')
    expect(formatRate(0)).toBe('0.0%')
    expect(formatRate(1)).toBe('100.0%')
  })

  it('renders a null rate as a dash, never as 0%', () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(undefined)).toBe('—')
    expect(formatRate(null)).not.toBe('0.0%')
  })

  it('states the shortfall using the backend numbers', () => {
    expect(insufficientSampleMessage(4, 8)).toContain('4 confirmed outcomes are available')
    expect(insufficientSampleMessage(4, 8)).toContain('8 are required')
    expect(insufficientSampleMessage(4, 8)).toContain('4 more needed')
  })
})

// =============================================================
// Small sample presentation
// =============================================================

describe('small sample presentation', () => {
  it('shows INSUFFICIENT DATA rather than 0% for a fresh tenant', async () => {
    portfolioFn.mockResolvedValue(view({
      intelligence: intelligence({
        outcomeSummary: {
          confirmedWins: 0, confirmedLosses: 0, pending: 0, confirmedSampleSize: 0,
          minimumSampleSize: 8, additionalOutcomesNeeded: 8, dataSufficiency: 'INSUFFICIENT_DATA',
          winRate: null, intervalLower: null, intervalUpper: null,
          intervalMethod: 'wilson-bin-v1', rateBasis: 'INSUFFICIENT_DATA',
          duplicatesCollapsed: 0, nonContestExcluded: 0,
        },
        dataLimitations: ['A confirmed win rate cannot yet be reported. 0 confirmed outcome(s) are available and 8 are required — 8 more confirmed outcome(s) needed.'],
      }),
    }))
    render(<WinLossIntelligencePanel />)
    const rate = await screen.findByTestId('overall-rate')
    expect(rate).toHaveTextContent('INSUFFICIENT DATA')
    expect(rate).not.toHaveTextContent('0.0%')
    expect(rate).not.toHaveTextContent('50%')
  })

  it('states the exact shortfall from backend policy numbers', async () => {
    portfolioFn.mockResolvedValue(view({
      intelligence: intelligence({
        outcomeSummary: {
          confirmedWins: 3, confirmedLosses: 1, pending: 2, confirmedSampleSize: 4,
          minimumSampleSize: 8, additionalOutcomesNeeded: 4, dataSufficiency: 'PARTIAL',
          winRate: null, intervalLower: null, intervalUpper: null,
          intervalMethod: 'wilson-bin-v1', rateBasis: 'INSUFFICIENT_DATA',
          duplicatesCollapsed: 0, nonContestExcluded: 0,
        },
      }),
    }))
    render(<WinLossIntelligencePanel />)
    const rate = await screen.findByTestId('overall-rate')
    expect(rate).toHaveTextContent('4 confirmed outcomes are available')
    expect(rate).toHaveTextContent('8 are required')
    expect(rate).toHaveTextContent('4 more needed')
    expect(rate).toHaveTextContent('3 win(s), 1 loss(es), 2 pending')
  })

  it('never colours an insufficient segment as good or bad', async () => {
    portfolioFn.mockResolvedValue(view({
      intelligence: intelligence({
        segments: { agencies: [segment({ segmentKey: 'DHS', segmentLabel: 'DHS', wins: 1, losses: 0, sampleSize: 1, winRate: null, intervalLower: null, intervalUpper: null, dataSufficiency: 'PARTIAL' })], naics: [], vehicles: [], setAsides: [], valueBands: [] },
      }),
    }))
    render(<WinLossIntelligencePanel />)
    const row = await screen.findByTestId('segment-AGENCY-DHS')
    expect(row).toHaveTextContent('INSUFFICIENT DATA')
    expect(row.querySelector('.text-green-300, .text-red-300')).toBeNull()
  })
})

// =============================================================
// Wilson presentation
// =============================================================

describe('Wilson presentation', () => {
  it('always shows the rate with its sample and interval', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    const rate = await screen.findByTestId('overall-rate')
    expect(rate).toHaveTextContent('75.0%')
    expect(rate).toHaveTextContent('6W / 2L across 8 confirmed outcome(s)')
    expect(rate).toHaveTextContent('95% interval 40.9% to 93.7%')
  })

  it('says pending is excluded from the denominator', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    expect(await screen.findByTestId('overall-rate')).toHaveTextContent('3 pending, excluded from the denominator')
  })

  it('reports collapsed duplicates and excluded non-contests', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    const summary = await screen.findByTestId('outcome-summary')
    expect(summary).toHaveTextContent('1 duplicate record(s) collapsed')
    expect(summary).toHaveTextContent('no contest was decided')
  })
})

// =============================================================
// Public benchmark
// =============================================================

describe('public benchmark presentation', () => {
  it('labels the benchmark as public award data', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    expect(await screen.findByTestId('public-benchmark')).toHaveTextContent('PUBLIC AWARD DATA')
  })

  it('names the source and says no other customer’s data is read', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    const source = await screen.findByTestId('benchmark-source')
    expect(source).toHaveTextContent('Public federal award records')
    expect(source).toHaveTextContent('No other customer')
  })

  it('never calls an award share a competitor win rate', async () => {
    portfolioFn.mockResolvedValue(view())
    const { container } = render(<WinLossIntelligencePanel />)
    await screen.findByTestId('public-benchmark')
    expect(screen.getByTestId('public-benchmark')).toHaveTextContent('not a competitor win rate')
    expect(container.textContent ?? '').not.toMatch(/competitor win rate of/i)
  })

  it('shows cohort size against the minimum and the cohort rules', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    const bench = await screen.findByTestId('public-benchmark')
    expect(bench).toHaveTextContent('Cohort 12 of a minimum 7')
    expect(bench).toHaveTextContent('NAICS 541512')
    expect(bench).toHaveTextContent('2 source award(s)')
  })
})

// =============================================================
// Concentration, trend and limitations
// =============================================================

describe('analysis blocks', () => {
  it('shows concentration with its basis and threshold', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    const block = await screen.findByTestId('concentration-block')
    expect(block).toHaveTextContent('CONCENTRATED')
    expect(block).toHaveTextContent('HHI 0.31')
    expect(block).toHaveTextContent('portfolioValue hierarchy')
    expect(block).toHaveTextContent('Monitoring threshold 0.25')
  })

  it('shows the trend with its qualifying period count and method', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    const block = await screen.findByTestId('trend-block')
    expect(block).toHaveTextContent('stable')
    expect(block).toHaveTextContent('3 qualifying quarter(s)')
    expect(block).toHaveTextContent('ema-span-3')
  })

  it('always renders a data-limitations block, even when empty', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<WinLossIntelligencePanel />)
    expect(await screen.findByTestId('data-limitations')).toHaveTextContent('None recorded')
  })

  it('surfaces limitations prominently when present', async () => {
    portfolioFn.mockResolvedValue(view({
      intelligence: intelligence({ dataLimitations: ['A confirmed win rate cannot yet be reported.'] }),
    }))
    render(<WinLossIntelligencePanel />)
    expect(await screen.findByTestId('data-limitations')).toHaveTextContent('cannot yet be reported')
  })

  it('says the agent has not run rather than showing zeros', async () => {
    portfolioFn.mockResolvedValue(view({ intelligence: null }))
    render(<WinLossIntelligencePanel />)
    expect(await screen.findByText(/has not analysed this firm yet/i)).toBeInTheDocument()
  })
})

// =============================================================
// Capture panel
// =============================================================

describe('CaptureIntelligencePanel', () => {
  it('states that everything is advisory', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<CaptureIntelligencePanel />)
    const note = await screen.findByTestId('advisory-note')
    expect(note).toHaveTextContent('Nothing in your pipeline, scoring or pursuits has been')
    expect(note).toHaveTextContent('acting on a recommendation is your decision')
  })

  it('renders a recommendation with its rank and deterministic rationale', async () => {
    portfolioFn.mockResolvedValue(view())
    recommendationsFn.mockResolvedValue({ recommendations: [recommendation()], policy: POLICY })
    render(<CaptureIntelligencePanel />)
    const rec = await screen.findByTestId('recommendation-rec-1')
    expect(rec).toHaveTextContent('#1')
    expect(rec).toHaveTextContent('Department of Defense')
    expect(rec).toHaveTextContent('8 confirmed outcomes: 6 wins and 2 losses')
  })

  it('marks an exploratory recommendation as unscored', async () => {
    portfolioFn.mockResolvedValue(view())
    recommendationsFn.mockResolvedValue({
      recommendations: [recommendation({ scoreState: 'EXPLORATORY', score: null, rank: null, dataSufficiency: 'PARTIAL' })],
      policy: POLICY,
    })
    render(<CaptureIntelligencePanel />)
    const rec = await screen.findByTestId('recommendation-rec-1')
    expect(rec).toHaveTextContent('EXPLORATORY')
    expect(within(rec).getByTestId('no-score-rec-1')).toHaveTextContent('surfaced for exploration only')
    expect(rec).not.toHaveTextContent('#1')
  })

  it('offers a dismiss control and no apply control', async () => {
    portfolioFn.mockResolvedValue(view())
    recommendationsFn.mockResolvedValue({ recommendations: [recommendation()], policy: POLICY })
    render(<CaptureIntelligencePanel />)
    await screen.findByTestId('recommendation-rec-1')
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument()
    for (const label of [/^apply/i, /prioriti[sz]e/i, /add to pipeline/i, /update weights/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })

  it('says dismissing changes no pursuit, weight or measurement', async () => {
    portfolioFn.mockResolvedValue(view())
    recommendationsFn.mockResolvedValue({ recommendations: [recommendation()], policy: POLICY })
    render(<CaptureIntelligencePanel />)
    expect(await screen.findByTestId('recommendation-rec-1'))
      .toHaveTextContent('changes no pursuit, weight or measurement')
  })

  it('explains an empty recommendation list by sample, not by failure', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<CaptureIntelligencePanel />)
    expect(await screen.findByText(/not yet enough confirmed outcomes to rank a segment/i)).toBeInTheDocument()
  })

  it('renders a roadmap item with known value and unknown-value count', async () => {
    portfolioFn.mockResolvedValue(view({
      intelligence: intelligence({
        capabilityRoadmap: {
          items: [{
            gapKey: 'MISSING_CAPABILITY:cloud-migration', gapLabel: 'Cloud migration', category: 'MISSING_CAPABILITY',
            severity: 'MAJOR', recommendation: 'INVESTIGATE_CAPABILITY_DEVELOPMENT',
            affectedOpportunityCount: 4, affectedPursuitCount: 2,
            knownAffectedValue: 3_500_000, unknownValueCount: 2, partnerCoverageCount: 0,
            partnerNames: [], sourceGapIds: [], evidence: [], dataSufficiency: 'PARTIAL',
            limitations: ['Affected value is understated: opportunities with no recorded value are excluded rather than assumed to be zero.'],
          }],
          totalGapsObserved: 6, distinctGaps: 1, nonRecurringGaps: 0, limitations: [],
        },
      }),
    }))
    render(<CaptureIntelligencePanel />)
    const item = await screen.findByTestId('roadmap-MISSING_CAPABILITY:cloud-migration')
    expect(item).toHaveTextContent('Cloud migration')
    expect(item).toHaveTextContent('MAJOR')
    expect(item).toHaveTextContent('investigate capability development')
    expect(item).toHaveTextContent('$3,500,000')
    expect(item).toHaveTextContent('2 opportunity(ies) have no recorded value and are not counted as zero')
  })

  it('never labels a roadmap item as a mandatory investment', async () => {
    portfolioFn.mockResolvedValue(view())
    const { container } = render(<CaptureIntelligencePanel />)
    await screen.findByTestId('capability-roadmap')
    expect(container.textContent ?? '').not.toMatch(/must invest|required investment|acquire this capability/i)
  })

  it('shows concentration risk on the portfolio surface too', async () => {
    portfolioFn.mockResolvedValue(view())
    render(<CaptureIntelligencePanel />)
    expect(await screen.findByTestId('portfolio-concentration')).toHaveTextContent('CONCENTRATED')
  })

  it('renders open escalations', async () => {
    portfolioFn.mockResolvedValue(view({
      escalations: [{
        id: 'e1', severity: 'MEDIUM', status: 'OPEN',
        title: 'Confirmed win rate declining across consecutive quarters',
        reason: 'The confirmed win rate has fallen across 3 consecutive quarters.',
        recommendedAction: null, entityType: null, entityId: null, createdAt: '2026-08-12T00:00:00.000Z',
      }],
    }))
    render(<CaptureIntelligencePanel />)
    expect(await screen.findByTestId('intel-escalations')).toHaveTextContent('declining across consecutive quarters')
  })

  it('shows the backend error rather than a blank panel', async () => {
    portfolioFn.mockRejectedValue({ response: { data: { error: 'Intelligence unavailable' } } })
    render(<CaptureIntelligencePanel />)
    expect(await screen.findByText('Intelligence unavailable')).toBeInTheDocument()
  })
})
