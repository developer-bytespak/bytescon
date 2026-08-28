// =============================================================
// §7.4 — Deterministic narrative.
//
// The rules under test: byte-identical output for identical input, no number
// the input did not supply, no invented incumbent or competitor, no pricing
// claim, and a competitor's observed award share never called a win rate.
// =============================================================
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { evaluateBorderline, type BorderlineInput } from './borderlinePolicy'
import { renderRecommendationNarrative, NARRATIVE_VERSION, type NarrativeInput } from './recommendationNarrative'

const QUALIFICATION_DIR = __dirname

const policyInput = (over: Partial<BorderlineInput> = {}): BorderlineInput => ({
  finalProbability: 61, intervalLower: 44, intervalUpper: 78,
  confidenceState: 'MEDIUM', dataSufficiency: 'SUFFICIENT',
  capabilityGapSeverity: 'CRITICAL', capacityState: 'AVAILABLE',
  complianceBlockers: 0, complianceHumanReviewItems: 0, scorecardScore: 66,
  ...over,
})

const narrativeInput = (over: Partial<NarrativeInput> = {}): NarrativeInput => ({
  outcome: evaluateBorderline(policyInput()),
  opportunityTitle: 'Cyber support services',
  finalProbability: 61,
  rawProbability: 58,
  probabilityMode: 'RAW',
  probabilityReason: 'tenant calibration history is insufficient',
  intervalLower: 44,
  intervalUpper: 78,
  confidenceState: 'MEDIUM',
  scorecardScore: 66,
  matchScore: 82,
  capabilityGapSeverity: 'CRITICAL',
  criticalGaps: ['certification: SDVOSB'],
  capacityState: 'AVAILABLE',
  capacityDetail: '2 of 5 declared concurrent capacity is committed.',
  pastPerformanceCount: 3,
  incumbent: {
    name: 'Acme Federal', retentionNumerator: 4, retentionDenominator: 7,
    retentionRatePct: 57, available: true, limitation: null,
  },
  competitors: [
    { name: 'Beta Corp', awardsObserved: 3, totalObserved: 12, observedAwardSharePct: 25, isConfirmedWinRate: false },
  ],
  pricing: { availability: 'PRICING_DATA_NOT_AVAILABLE', detail: 'No pricing scenario exists for this opportunity.' },
  compliance: { blockers: 0, humanReviewItems: 1, available: true },
  dataLimitations: [],
  ...over,
})

describe('determinism', () => {
  it('produces byte-identical output for identical input', () => {
    const input = narrativeInput()
    expect(renderRecommendationNarrative(input)).toBe(renderRecommendationNarrative(input))
  })

  it('contains no timestamp, so the same evidence always renders the same bytes', () => {
    const text = renderRecommendationNarrative(narrativeInput())
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(text).not.toMatch(/GMT|UTC/)
  })

  it('changes when the evidence changes', () => {
    const a = renderRecommendationNarrative(narrativeInput())
    const b = renderRecommendationNarrative(narrativeInput({ finalProbability: 62 }))
    expect(a).not.toBe(b)
  })

  it('exposes a stable version tag', () => {
    expect(NARRATIVE_VERSION).toBe('qualification-narrative-v1')
  })
})

describe('it only repeats numbers the input supplied', () => {
  it('renders the supplied probability and interval verbatim', () => {
    const text = renderRecommendationNarrative(narrativeInput())
    expect(text).toContain('Win probability is 61% (RAW) with a 44–78% confidence interval.')
  })

  it('introduces no percentage the input did not carry', () => {
    const input = narrativeInput()
    let text = renderRecommendationNarrative(input)
    // The policy's own reason sentences are rendered verbatim (asserted
    // separately), and they legitimately quote policy constants. Remove them so
    // this test measures only what the NARRATIVE itself produced.
    for (const reason of input.outcome.reasons) text = text.split(reason).join('')

    const supplied = new Set(['61', '58', '44', '78', '66', '82', '4', '7', '57', '25', '3', '12'])
    for (const match of text.matchAll(/(\d+)%/g)) {
      expect(supplied.has(match[1]), `narrative invented the figure ${match[1]}%`).toBe(true)
    }
  })

  it('renders the scorecard total verbatim', () => {
    expect(renderRecommendationNarrative(narrativeInput())).toContain('The qualification scorecard totals 66.')
  })

  it('states the match score verbatim', () => {
    expect(renderRecommendationNarrative(narrativeInput())).toContain('Capability match for "Cyber support services" scores 82.')
  })

  it('shows the calibrated movement only when calibration actually moved it', () => {
    const raw = renderRecommendationNarrative(narrativeInput())
    expect(raw).not.toContain('calibration moved it')
    const calibrated = renderRecommendationNarrative(narrativeInput({ probabilityMode: 'CALIBRATED', rawProbability: 58, finalProbability: 61 }))
    expect(calibrated).toContain('The uncalibrated score was 58%; calibration moved it to 61%.')
  })
})

describe('honesty rules', () => {
  it('never calls an observed award share a win rate', () => {
    const text = renderRecommendationNarrative(narrativeInput())
    expect(text).toContain('observed award share of 25%')
    expect(text).toContain('This is not a win rate')
    expect(text).not.toMatch(/Beta Corp has a confirmed win rate/)
  })

  it('uses win-rate wording only when the denominator is confirmed participation', () => {
    const text = renderRecommendationNarrative(narrativeInput({
      competitors: [{ name: 'Beta Corp', awardsObserved: 6, totalObserved: 10, observedAwardSharePct: 60, isConfirmedWinRate: true }],
    }))
    expect(text).toContain('Beta Corp has a confirmed win rate of 60% across 10 confirmed bid(s).')
  })

  it('never invents an incumbent', () => {
    const text = renderRecommendationNarrative(narrativeInput({
      incumbent: { name: null, retentionNumerator: null, retentionDenominator: null, retentionRatePct: null, available: false, limitation: 'No incumbent could be identified from the award evidence for this opportunity.' },
    }))
    expect(text).not.toMatch(/Incumbent \w/)
    expect(text).toContain('No incumbent could be identified')
  })

  it('always shows the incumbent numerator and denominator, never a bare rate', () => {
    const text = renderRecommendationNarrative(narrativeInput())
    expect(text).toContain('retained 4 of 7 comparable award(s)')
  })

  it('states that pricing is unavailable rather than implying it supports the call', () => {
    const text = renderRecommendationNarrative(narrativeInput())
    expect(text).toContain('No pricing scenario exists for this opportunity.')
  })

  it('labels a RAW probability honestly with its reason', () => {
    const text = renderRecommendationNarrative(narrativeInput())
    expect(text).toContain('Probability is RAW: tenant calibration history is insufficient')
  })

  it('says capacity is unknown rather than available', () => {
    const text = renderRecommendationNarrative(narrativeInput({
      capacityState: 'INSUFFICIENT_DATA',
      capacityDetail: 'No capability records a concurrent capacity limit.',
    }))
    expect(text).toContain('This is not the same as having capacity.')
  })

  it('always ends by saying only a person records a decision', () => {
    expect(renderRecommendationNarrative(narrativeInput())).toContain(
      'This is an agent recommendation. A bid or no-bid decision is recorded only by a person.',
    )
  })

  it('renders the policy reasons verbatim and adds none of its own', () => {
    const input = narrativeInput()
    const text = renderRecommendationNarrative(input)
    for (const reason of input.outcome.reasons) expect(text).toContain(reason)
  })

  it('reports no interval honestly instead of a 0–100 range', () => {
    const outcome = evaluateBorderline(policyInput({ intervalLower: null, intervalUpper: null }))
    const text = renderRecommendationNarrative(narrativeInput({ outcome, intervalLower: null, intervalUpper: null }))
    expect(text).toContain('with no confidence interval available')
    expect(text).not.toContain('0–100%')
  })

  it('deduplicates limitations reported by two sources', () => {
    const text = renderRecommendationNarrative(narrativeInput({
      dataLimitations: ['No pricing scenario exists for this opportunity.'],
    }))
    const occurrences = text.split('No pricing scenario exists for this opportunity.').length - 1
    expect(occurrences).toBe(1)
  })
})

describe('headlines', () => {
  it.each([
    ['RECOMMEND_BID', 'Bid.'],
    ['RECOMMEND_NO_BID', 'Do not bid.'],
    ['BORDERLINE_REVIEW', 'Borderline — human review required.'],
    ['INSUFFICIENT_DATA', 'Insufficient data — no recommendation.'],
  ])('renders the %s headline', (result, headline) => {
    const outcome = { ...evaluateBorderline(policyInput()), recommendation: result as never, strength: 'NONE' as const }
    expect(renderRecommendationNarrative(narrativeInput({ outcome }))).toContain(headline)
  })
})

/** Source with comments removed, so these assertions check CODE, not prose. */
function codeOf(file: string): string {
  const raw = readFileSync(join(QUALIFICATION_DIR, file), 'utf8')
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function sourceFiles(): string[] {
  return readdirSync(QUALIFICATION_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
}

describe('§7.4 introduces no prompt and cannot decide', () => {
  it('declares no system prompt constant anywhere in the qualification directory', () => {
    const files = sourceFiles()
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      expect(/export const \w*SYSTEM_PROMPT\w* =/.test(codeOf(file)), `${file} must not declare a system prompt`).toBe(false)
    }
  })

  it('never calls the LLM router or imports the LLM layer', () => {
    for (const file of sourceFiles()) {
      const code = codeOf(file)
      expect(code.includes('generateWithRouter('), `${file} must not call the LLM router`).toBe(false)
      expect(/from '.*\/llm\//.test(code), `${file} must not import the LLM layer`).toBe(false)
    }
  })

  it('never imports the human decision writer, so it cannot record a decision', () => {
    for (const file of sourceFiles()) {
      const code = codeOf(file)
      expect(
        /from '.*qualificationDecision'/.test(code),
        `${file} must not import the human decision writer`,
      ).toBe(false)
      expect(code.includes('recordQualificationDecision('), `${file} must not call the decision writer`).toBe(false)
    }
  })

  it('never touches BidDecision, Scorecard decisions or GateReview completion', () => {
    for (const file of sourceFiles()) {
      const code = codeOf(file)
      // Prisma ACCESS, not the word — `bidDecisionsWritten: 0` is a metric name.
      expect(/\b(prisma|tx)\.bidDecision\b/.test(code), `${file} must never touch BidDecision`).toBe(false)
      expect(/\b(prisma|tx)\.scorecardDecision\b/.test(code), `${file} must never write a ScorecardDecision`).toBe(false)
      expect(/\b(prisma|tx)\.scorecard\.update\b/.test(code), `${file} must never update a Scorecard`).toBe(false)
      expect(/\b(prisma|tx)\.gateReview\.update\b/.test(code), `${file} must never complete a GateReview`).toBe(false)
    }
  })
})
