// =============================================================
// Bid/No-Bid scorecard scoring — the single backend source of truth for the
// weighted total and the system recommendation (§5.2). Pure + deterministic:
// integer arithmetic only (no floating-point), so identical input always
// yields identical output. The frontend never computes the authoritative total.
//
// Weight rule (documented): active criteria weights must sum to EXACTLY 100.
// Scores are integers 0-100.
//
//   weightedContribution_i = score_i (0-100) × weight_i (0-100)
//   rawSum                 = Σ weightedContribution_i        (0 .. 10000)
//   totalScore             = round(rawSum / 100)             (0 .. 100)
//
// round() is half-up via Math.round on an integer ratio — deterministic.
//
// Thresholds (recommendationVersion "scorecard-v1"):
//   REVIEW_REQUIRED  — any REQUIRED active criterion is unscored
//   BID              — totalScore >= 70
//   CONDITIONAL      — 50 <= totalScore < 70
//   NO_BID           — totalScore < 50
// =============================================================
import { ScorecardRecommendation } from '@prisma/client'

export const RECOMMENDATION_VERSION = 'scorecard-v1'
export const BID_THRESHOLD = 70
export const CONDITIONAL_THRESHOLD = 50

export interface ScoringCriterion {
  key: string
  weight: number // integer 0-100
  score: number | null // integer 0-100, null = unscored
  required: boolean
  isActive?: boolean // configs may be inactive; scorecard snapshots are all active
}

export interface ScoringResult {
  totalScore: number // 0-100 integer
  recommendation: ScorecardRecommendation
  complete: boolean // all required active criteria scored
  missingRequiredKeys: string[]
  recommendationVersion: string
}

// Validate a set of criterion WEIGHTS (config-time). Returns an error message
// or null. Active weights must be integers in [0,100] and sum to exactly 100.
export function validateWeights(criteria: { weight: number; isActive?: boolean }[]): string | null {
  const active = criteria.filter((c) => c.isActive !== false)
  if (active.length === 0) return 'At least one active criterion is required'
  let sum = 0
  for (const c of active) {
    if (!Number.isInteger(c.weight)) return 'Weights must be whole numbers'
    if (c.weight < 0) return 'Weights cannot be negative'
    if (c.weight > 100) return 'A single weight cannot exceed 100'
    sum += c.weight
  }
  if (sum !== 100) return `Active weights must total exactly 100 (currently ${sum})`
  return null
}

export function isValidScore(score: unknown): score is number {
  return Number.isInteger(score) && (score as number) >= 0 && (score as number) <= 100
}

// Deterministic weighted total + recommendation. Only active criteria count.
export function computeScorecard(criteria: ScoringCriterion[]): ScoringResult {
  const active = criteria.filter((c) => c.isActive !== false)

  const missingRequiredKeys = active
    .filter((c) => c.required && (c.score === null || c.score === undefined))
    .map((c) => c.key)

  let rawSum = 0
  for (const c of active) {
    const score = c.score === null || c.score === undefined ? 0 : c.score
    rawSum += score * c.weight
  }
  const totalScore = Math.round(rawSum / 100)

  const complete = missingRequiredKeys.length === 0
  let recommendation: ScorecardRecommendation
  if (!complete) {
    recommendation = 'REVIEW_REQUIRED'
  } else if (totalScore >= BID_THRESHOLD) {
    recommendation = 'BID'
  } else if (totalScore >= CONDITIONAL_THRESHOLD) {
    recommendation = 'CONDITIONAL'
  } else {
    recommendation = 'NO_BID'
  }

  return { totalScore, recommendation, complete, missingRequiredKeys, recommendationVersion: RECOMMENDATION_VERSION }
}

// Sensible default criteria, seeded per firm on first scorecard access. Weights
// total exactly 100. Order matches §5.2 guidance.
export const DEFAULT_CRITERIA: {
  key: string
  name: string
  description: string
  weight: number
  required: boolean
  displayOrder: number
}[] = [
  { key: 'capability_fit', name: 'Capability fit', description: 'How well our capabilities and past work match the requirement.', weight: 20, required: true, displayOrder: 1 },
  { key: 'competition', name: 'Competition', description: 'Competitive landscape and our differentiation (higher = more favorable to us).', weight: 12, required: true, displayOrder: 2 },
  { key: 'capacity', name: 'Internal capacity', description: 'Availability of staff, PM and resources to execute if won.', weight: 12, required: true, displayOrder: 3 },
  { key: 'relationship', name: 'Agency/customer relationship', description: 'Strength of our relationship and past performance with this customer.', weight: 12, required: false, displayOrder: 4 },
  { key: 'past_performance', name: 'Past-performance relevance', description: 'Relevance and strength of qualifying past-performance references.', weight: 12, required: true, displayOrder: 5 },
  { key: 'eligibility', name: 'Eligibility', description: 'Set-aside, certification and compliance eligibility to bid.', weight: 12, required: true, displayOrder: 6 },
  { key: 'timeline', name: 'Timeline feasibility', description: 'Feasibility of producing a compliant, competitive proposal in the time available.', weight: 8, required: true, displayOrder: 7 },
  { key: 'strategic_value', name: 'Strategic value', description: 'Strategic value: market entry, recompete positioning, follow-on potential.', weight: 8, required: false, displayOrder: 8 },
  { key: 'pricing', name: 'Pricing competitiveness', description: 'Confidence we can price competitively while protecting margin.', weight: 4, required: false, displayOrder: 9 },
]
