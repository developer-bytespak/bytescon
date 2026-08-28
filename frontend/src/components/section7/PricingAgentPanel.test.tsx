// =============================================================
// §7.6 — Pricing Agent benchmark panel.
//
// Pins the honesty rules: insufficient data is prominent and draws no
// percentile, a relaxed filter is named, the public cohort is inspectable
// award by award, out-of-range reads as position rather than verdict, multiple
// scenarios are shown without a recommendation, and the panel offers no control
// that could change a price.
// =============================================================
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const assessmentFn = vi.fn()
const cohortFn = vi.fn()
vi.mock('../../services/pricingAgentApi', () => ({
  pricingAgentApi: {
    assessment: () => assessmentFn(),
    cohort: () => cohortFn(),
  },
}))

import { PricingAgentPanel } from './PricingAgentPanel'

const wrap = () => render(<MemoryRouter><PricingAgentPanel workspaceId="w1" /></MemoryRouter>)

const POLICY = {
  policyVersion: 'competitive-range-v1',
  minimumCohortSize: 7,
  strongCohortSize: 15,
  lookbackMonths: 60,
  valueBandLowRatio: 0.25,
  valueBandHighRatio: 4,
  outlierIqrMultiplier: 3,
  riskWorkingDays: 15,
  nonComparableAwardTypes: ['IDIQ', 'BPA'],
  notes: [
    "The benchmark is built from public federal award records only. No other firm's pricing is ever read.",
    'Below 7 comparable awards no percentile and no competitive-range conclusion is calculated.',
  ],
}

const scenario = (over: Record<string, unknown> = {}) => ({
  scenarioId: 's1',
  name: 'Base',
  isPreferred: false,
  totals: {
    directLabor: '95000.00', fringe: '28500.00', overhead: '0.00', odc: '0.00',
    subcontractor: '0.00', ga: '0.00', subtotalBeforeFee: '123500.00',
    fee: '0.00', totalProposedPrice: '123500.00',
  },
  totalsRecomputed: false,
  rateStructure: { complete: true, state: 'COMPLETE', warnings: [] },
  rateDrift: [],
  benchmark: {
    cohortId: 'c1',
    status: 'PARTIAL',
    filterLevel: 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND',
    relaxedFilters: [],
    cohortSize: 9,
    periodStart: '2021-08-12T00:00:00.000Z',
    periodEnd: '2026-08-12T00:00:00.000Z',
    p25: '120000.00',
    median: '140000.00',
    p75: '160000.00',
    minimum: '100000.00',
    maximum: '180000.00',
    proposedPricePercentile: 33,
    rangeState: 'WITHIN_HISTORICAL_RANGE',
    summary: '$123500.00 sits within the interquartile range of comparable awards.',
    sourceIds: ['a1', 'a2', 'a3'],
    limitations: [],
  },
  templateStatus: { state: 'CURRENT', staleItems: [] },
  ...over,
})

const view = (over: Record<string, unknown> = {}) => ({
  agentKey: 'PRICING',
  workspace: {
    id: 'w1', opportunityId: 'o1', title: 'Cyber support pricing', status: 'DRAFT',
    ownerUserId: 'u1', preferredScenarioId: null,
    opportunity: { id: 'o1', title: 'Cyber support', agency: 'DoD', naicsCode: '541512', responseDeadline: '2026-10-01T00:00:00.000Z' },
  },
  schedule: {
    isEnabled: true, cronExpression: '0 */12 * * *', nextRunAt: '2026-08-12T12:00:00.000Z',
    lastRunAt: '2026-08-12T00:00:00.000Z', lastSuccessfulRunAt: '2026-08-12T00:00:00.000Z',
    lastFailureAt: null, lastFailureMessage: null, autonomyLevel: 'PROPOSE',
  },
  lastRun: {
    id: 'run-abcdef12', status: 'COMPLETED', triggerType: 'SCHEDULED',
    createdAt: '2026-08-12T00:00:00.000Z', finishedAt: '2026-08-12T00:00:04.000Z',
    outputSummary: 'Assessed 1 pricing workspace', warnings: [], limitations: [],
    tokenInput: 0, tokenOutput: 0, estimatedCostUsd: '0',
  },
  assessment: {
    artifactId: 'a1', generatedAt: '2026-08-12T00:00:00.000Z',
    opportunityId: 'o1', pricingWorkspaceId: 'w1', workspaceTitle: 'Cyber support pricing',
    workspaceStatus: 'DRAFT', methodVersion: 'pricing-v1',
    preferredScenarioId: null, preferredScenarioState: 'NO_PREFERRED_SCENARIO',
    scenarios: [scenario()],
    sensitivity: {
      status: 'UNVALIDATED_SCENARIO_ANALYSIS', probabilityMode: 'RAW',
      points: [{ scenarioId: 's1', label: 'Base', price: '123500.00', probability: 0.42 }],
      sampleSize: 0, assumptions: [],
      limitations: ['Win probability is UNVALIDATED_SCENARIO_ANALYSIS: it is modelled from price position, not from a calibrated tenant history.'],
    },
    amendmentImpact: { status: 'NO_PRICING_IMPACT_IDENTIFIED', evidence: ['No amendment impact is recorded for this opportunity.'], reviewRequired: false },
    recommendedHumanActions: [],
    warnings: [],
    dataLimitations: [],
  },
  escalations: [],
  policy: POLICY,
  ...over,
})

const cohortPayload = () => ({
  cohort: {
    id: 'c1', filterLevel: 'LEVEL_1_NAICS_AGENCY_SETASIDE_BAND', relaxedFilters: [],
    naics: '541512', agency: 'DoD', setAside: 'SDVOSB',
    periodStart: '2021-08-12T00:00:00.000Z', periodEnd: '2026-08-12T00:00:00.000Z',
    cohortSize: 2, sourceIds: ['a1', 'a2'], excludedSourceIds: ['a9'],
    exclusionReasons: [{ awardId: 'a9', reason: 'NOT_COMPARABLE: IDIQ is a multi-award vehicle ceiling.' }],
    minimumValue: '100000.00', p25Value: '120000.00', medianValue: '140000.00',
    p75Value: '160000.00', maximumValue: '180000.00',
    distributionData: [
      {
        awardId: 'a1', agency: 'Department of Defense', naics: '541512', setAside: 'SDVOSB',
        awardDate: '2025-02-01T00:00:00.000Z', awardAmount: '120000.00',
        contractNumber: 'W123-25-C-0001', recipientName: 'Acme Federal', included: true,
      },
      {
        awardId: 'a2', agency: 'Department of Defense', naics: '541512', setAside: 'SDVOSB',
        awardDate: '2025-06-01T00:00:00.000Z', awardAmount: '160000.00',
        contractNumber: 'W123-25-C-0002', recipientName: 'Beta Corp', included: true,
      },
    ],
    dataSufficiency: 'PARTIAL', limitations: [],
  },
  provenance: {
    sourceKind: 'PUBLIC_FEDERAL_AWARD_RECORDS',
    note: 'Every award listed is a public federal award record. No tenant-private pricing contributed to this cohort.',
  },
})

beforeEach(() => {
  assessmentFn.mockReset().mockResolvedValue(view())
  cohortFn.mockReset().mockResolvedValue(cohortPayload())
})

// -------------------------------------------------------------

describe('an unassessed workspace is never dressed up', () => {
  it('says the agent has not assessed it yet', async () => {
    assessmentFn.mockResolvedValue(view({ assessment: null }))
    wrap()
    expect(await screen.findByText(/has not assessed this workspace yet/i)).toBeInTheDocument()
    expect(screen.queryByTestId('pricing-scenario-s1')).not.toBeInTheDocument()
  })

  it('reports "Never run" rather than implying success', async () => {
    assessmentFn.mockResolvedValue(view({ assessment: null, lastRun: null }))
    wrap()
    expect(await screen.findByTestId('pricing-last-run')).toHaveTextContent('Never run')
  })

  it('surfaces a load failure with a retry', async () => {
    assessmentFn.mockRejectedValue({ response: { data: { error: 'boom' } } })
    wrap()
    expect(await screen.findByText('boom')).toBeInTheDocument()
  })

  it('names a schedule failure rather than hiding it', async () => {
    assessmentFn.mockResolvedValue(view({
      schedule: { ...view().schedule, lastFailureMessage: 'Award source unavailable.' },
    }))
    wrap()
    expect(await screen.findByTestId('pricing-last-failure')).toHaveTextContent('Award source unavailable.')
  })
})

describe('the agent is deterministic and says so', () => {
  it('states no AI inference, tokens or cost', async () => {
    wrap()
    expect(await screen.findByText(/No AI inference, no tokens, no cost/i)).toBeInTheDocument()
  })

  it('shows zero tokens on the run line', async () => {
    wrap()
    await screen.findByTestId('pricing-scenario-s1')
    expect(screen.getByText(/0 tokens/)).toBeInTheDocument()
  })
})

describe('the panel cannot change a price', () => {
  it('renders only the refresh and cohort-inspect controls', async () => {
    wrap()
    await screen.findByTestId('pricing-scenario-s1')
    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(2)
    expect(buttons.some((b) => b.getAttribute('aria-label') === 'Refresh Pricing Agent status')).toBe(true)
  })

  it('offers no control that would edit pricing', async () => {
    wrap()
    await screen.findByTestId('pricing-scenario-s1')
    for (const label of [/save/i, /apply/i, /set preferred/i, /approve/i, /submit/i, /update rate/i]) {
      expect(screen.queryByRole('button', { name: label }), String(label)).toBeNull()
    }
  })

  it('states the boundary in the disclaimer', async () => {
    wrap()
    expect(await screen.findByText(/never selects the preferred scenario/i)).toBeInTheDocument()
    expect(screen.getByText(/never approves a pricing review/i)).toBeInTheDocument()
  })
})

describe('totals come from the backend verbatim', () => {
  it('shows the canonical 1000h × $95 + 30% fringe figures', async () => {
    wrap()
    const card = await screen.findByTestId('pricing-scenario-s1')
    expect(within(card).getByText('$95,000.00')).toBeInTheDocument()
    expect(within(card).getByText('$28,500.00')).toBeInTheDocument()
    expect(await screen.findByTestId('total-s1')).toHaveTextContent('$123,500.00')
  })
})

describe('insufficient data', () => {
  const insufficientView = () =>
    view({
      assessment: {
        ...view().assessment,
        scenarios: [scenario({
          benchmark: {
            ...scenario().benchmark,
            cohortId: null, cohortSize: 3, rangeState: 'INSUFFICIENT_DATA',
            proposedPricePercentile: null, p25: null, median: null, p75: null,
            summary: 'Only 3 comparable public award(s) were available (minimum 7); no percentile or competitive-range conclusion was calculated.',
          },
        })],
      },
    })

  it('shows INSUFFICIENT DATA prominently', async () => {
    assessmentFn.mockResolvedValue(insufficientView())
    wrap()
    const block = await screen.findByTestId('insufficient-s1')
    expect(within(block).getByText('INSUFFICIENT DATA')).toBeInTheDocument()
  })

  it('explains how many awards were available against the minimum', async () => {
    assessmentFn.mockResolvedValue(insufficientView())
    wrap()
    expect(await screen.findByText(/3 comparable public award\(s\) were available against a minimum of 7/)).toBeInTheDocument()
  })

  it('draws no percentile and no quartile scale', async () => {
    assessmentFn.mockResolvedValue(insufficientView())
    wrap()
    await screen.findByTestId('insufficient-s1')
    expect(screen.queryByTestId('percentile-s1')).not.toBeInTheDocument()
    expect(screen.queryByText('Median')).not.toBeInTheDocument()
  })

  it('offers no cohort inspection when there is no cohort', async () => {
    assessmentFn.mockResolvedValue(insufficientView())
    wrap()
    await screen.findByTestId('insufficient-s1')
    expect(screen.queryByTestId('cohort-toggle-s1')).not.toBeInTheDocument()
  })
})

describe('a valid benchmark', () => {
  it('shows the quartiles and the percentile', async () => {
    wrap()
    const bench = await screen.findByTestId('benchmark-s1')
    expect(within(bench).getByText('$120,000.00')).toBeInTheDocument()
    expect(within(bench).getByText('$140,000.00')).toBeInTheDocument()
    expect(within(bench).getByText('$160,000.00')).toBeInTheDocument()
    expect(await screen.findByTestId('percentile-s1')).toHaveTextContent('33%')
  })

  it('shows the filter level, lookback and source count', async () => {
    wrap()
    const bench = await screen.findByTestId('benchmark-s1')
    expect(within(bench).getByText(/LEVEL_1_NAICS_AGENCY_SETASIDE_BAND/)).toBeInTheDocument()
    expect(within(bench).getByText(/3 public source\(s\)/)).toBeInTheDocument()
  })

  it('renders the backend summary verbatim', async () => {
    wrap()
    expect(await screen.findByTestId('range-summary-s1'))
      .toHaveTextContent('sits within the interquartile range of comparable awards')
  })

  it('names any relaxed filter rather than hiding it', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        scenarios: [scenario({
          benchmark: { ...scenario().benchmark, relaxedFilters: ['set-aside', 'agency'], filterLevel: 'LEVEL_3_NAICS_BAND' },
        })],
      },
    }))
    wrap()
    expect(await screen.findByTestId('relaxed-s1')).toHaveTextContent('Filters relaxed to find comparable awards: set-aside, agency.')
  })

  it('presents out-of-range as position, not verdict', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        scenarios: [scenario({
          benchmark: {
            ...scenario().benchmark,
            rangeState: 'ABOVE_HISTORICAL_RANGE',
            summary: '$170000.00 sits above the 75th percentile of comparable awards. Above the historical range is not the same as a bad price — a richer scope may justify it.',
          },
        })],
      },
    }))
    wrap()
    expect(await screen.findByText('ABOVE HISTORICAL RANGE')).toBeInTheDocument()
    expect(screen.getByTestId('range-summary-s1')).toHaveTextContent('not the same as a bad price')
  })
})

describe('the cohort composition is inspectable', () => {
  it('lists each public award with its identifiers', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('cohort-toggle-s1'))
    const list = await screen.findByTestId('cohort-list-s1')
    expect(within(list).getByText('W123-25-C-0001')).toBeInTheDocument()
    expect(within(list).getByText('W123-25-C-0002')).toBeInTheDocument()
    expect(within(list).getAllByText('541512').length).toBeGreaterThan(0)
    expect(within(list).getByText('$120,000.00')).toBeInTheDocument()
  })

  it('states the public provenance', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('cohort-toggle-s1'))
    await waitFor(() =>
      expect(screen.getByText(/No tenant-private pricing contributed to this cohort/)).toBeInTheDocument(),
    )
  })

  it('shows why an award was excluded', async () => {
    wrap()
    fireEvent.click(await screen.findByTestId('cohort-toggle-s1'))
    const excluded = await screen.findByTestId('cohort-excluded-s1')
    expect(within(excluded).getByText(/multi-award vehicle ceiling/)).toBeInTheDocument()
  })

  it('surfaces a cohort load failure', async () => {
    cohortFn.mockRejectedValue({ response: { data: { error: 'cohort gone' } } })
    wrap()
    fireEvent.click(await screen.findByTestId('cohort-toggle-s1'))
    await waitFor(() => expect(screen.getByText('cohort gone')).toBeInTheDocument())
  })
})

describe('rate structure and drift', () => {
  it('shows INCOMPLETE RATE STRUCTURE with its warnings', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        scenarios: [scenario({
          rateStructure: { complete: false, state: 'INCOMPLETE_RATE_STRUCTURE', warnings: ['No GA rate is recorded, so no GA cost is included in the total.'] },
        })],
      },
    }))
    wrap()
    const block = await screen.findByTestId('rate-structure-s1')
    expect(within(block).getByText('INCOMPLETE RATE STRUCTURE')).toBeInTheDocument()
    expect(within(block).getByText(/No GA rate is recorded/)).toBeInTheDocument()
  })

  it('shows rate drift as RATE_REVIEW_REQUIRED with both values', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        scenarios: [scenario({
          rateDrift: [{
            rateType: 'FRINGE', scenarioPercent: '30.0000', templatePercent: '35.0000',
            templateName: 'Canonical', state: 'RATE_REVIEW_REQUIRED',
            note: 'The scenario keeps its own rate. Adopting the template value is a human decision.',
          }],
        })],
      },
    }))
    wrap()
    const block = await screen.findByTestId('rate-drift-s1')
    expect(within(block).getByText('RATE_REVIEW_REQUIRED')).toBeInTheDocument()
    expect(within(block).getByText(/scenario 30.0000% · template "Canonical" 35.0000%/)).toBeInTheDocument()
    expect(within(block).getByText(/human decision/)).toBeInTheDocument()
  })

  it('shows the template staleness state', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        scenarios: [scenario({ templateStatus: { state: 'STALE', staleItems: ['Template "Old" was last effective 400 day(s) ago and may be stale.'] } })],
      },
    }))
    wrap()
    expect(await screen.findByTestId('template-s1')).toHaveTextContent('STALE')
    expect(screen.getByTestId('template-s1')).toHaveTextContent('may be stale')
  })
})

describe('sensitivity honesty', () => {
  it('labels a RAW curve as RAW rather than broken', async () => {
    wrap()
    const block = await screen.findByTestId('pricing-sensitivity')
    expect(within(block).getByText('RAW')).toBeInTheDocument()
    expect(within(block).getByText(/not from a calibrated tenant history/)).toBeInTheDocument()
    expect(block.textContent?.toLowerCase()).not.toContain('broken')
  })

  it('shows each price point with its probability', async () => {
    wrap()
    const block = await screen.findByTestId('pricing-sensitivity')
    expect(within(block).getByText(/\$123,500\.00 · 42\.0%/)).toBeInTheDocument()
  })
})

describe('multiple scenarios', () => {
  it('shows each with its own price and benchmark position', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        scenarios: [
          scenario(),
          scenario({
            scenarioId: 's2', name: 'Aggressive',
            totals: { ...scenario().totals, totalProposedPrice: '99000.00' },
            benchmark: { ...scenario().benchmark, rangeState: 'BELOW_HISTORICAL_RANGE', proposedPricePercentile: 11 },
          }),
        ],
      },
    }))
    wrap()
    expect(await screen.findByTestId('pricing-scenario-s1')).toBeInTheDocument()
    expect(screen.getByTestId('pricing-scenario-s2')).toBeInTheDocument()
    expect(screen.getByTestId('total-s2')).toHaveTextContent('$99,000.00')
    expect(screen.getByTestId('percentile-s2')).toHaveTextContent('11%')
  })

  it('recommends none of them', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        scenarios: [scenario(), scenario({ scenarioId: 's2', name: 'Aggressive' })],
      },
    }))
    wrap()
    expect(await screen.findByTestId('pricing-no-preferred'))
      .toHaveTextContent('the agent selected none')
  })

  it('marks the human-selected preferred scenario without changing it', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        preferredScenarioId: 's1', preferredScenarioState: 'SELECTED',
        scenarios: [scenario({ isPreferred: true })],
      },
    }))
    wrap()
    const card = await screen.findByTestId('pricing-scenario-s1')
    expect(within(card).getByText('PREFERRED')).toBeInTheDocument()
    expect(screen.queryByTestId('pricing-no-preferred')).not.toBeInTheDocument()
  })
})

describe('amendment impact and escalations', () => {
  it('shows the amendment pricing-review state', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: {
        ...view().assessment,
        amendmentImpact: {
          status: 'PRICING_REVIEW_REQUIRED',
          evidence: ['Amendment impact on PRICING: scope expanded.'],
          reviewRequired: true,
        },
      },
    }))
    wrap()
    const block = await screen.findByTestId('pricing-amendment')
    expect(within(block).getByText('PRICING_REVIEW_REQUIRED')).toBeInTheDocument()
    expect(within(block).getByText(/scope expanded/)).toBeInTheDocument()
  })

  it('lists open escalations with severity', async () => {
    assessmentFn.mockResolvedValue(view({
      escalations: [{
        id: 'e1', severity: 'MEDIUM', status: 'OPEN',
        title: 'Price outside historical range near submission',
        reason: 'This is a positioning warning, not a judgement that the price is wrong.',
        recommendedAction: 'Review the price against the cohort.',
        createdAt: '2026-08-12T00:00:00.000Z',
      }],
    }))
    wrap()
    const list = await screen.findByTestId('pricing-escalations')
    expect(within(list).getByText('Price outside historical range near submission')).toBeInTheDocument()
    expect(within(list).getByText(/not a judgement that the price is wrong/)).toBeInTheDocument()
  })

  it('lists the recommended human actions', async () => {
    assessmentFn.mockResolvedValue(view({
      assessment: { ...view().assessment, recommendedHumanActions: ['Complete the rate structure on "Base".'] },
    }))
    wrap()
    expect(await screen.findByTestId('pricing-actions')).toHaveTextContent('Complete the rate structure')
  })
})
