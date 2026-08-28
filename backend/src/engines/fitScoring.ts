// =============================================================
// Fit Score — Layer 2: Client capability vs opportunity requirements
// Returns 0-100 score measuring how well a client can execute this contract
// =============================================================
import { FitScoreOutput } from '../types'

interface ClientData {
  naicsCodes: string[]
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBusiness: boolean
  state?: string | null
  performanceStats?: {
    totalWon: number
    totalLost: number
    totalSubmitted: number
    completionRate: number
    totalPenalties: string | number
  } | null
  // Opportunity-specific structured past-performance signal. Supplied only when
  // the RELEVANT_PAST_PERFORMANCE_ENABLED flag is on (see decisionEngine); when
  // absent the past-performance factor behaves exactly as before. Bounded blend.
  relevantPastPerformance?: {
    matchedCount: number
    avgCparsScore: number | null
  } | null
}

interface OpportunityData {
  naicsCode: string
  estimatedValue: number | null
  responseDeadline: Date
  placeOfPerformance?: string | null
  historicalAvgAward?: number | null
}

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v))
}

// ─── Factor 1: NAICS depth match (25%) ───────────────────────
function scoreNaicsDepth(clientNaics: string[], oppNaics: string): number {
  if (clientNaics.length === 0) return 0
  if (clientNaics.some((c) => c.trim() === oppNaics.trim())) return 100
  if (clientNaics.some((c) => c.substring(0, 4) === oppNaics.substring(0, 4))) return 60
  if (clientNaics.some((c) => c.substring(0, 2) === oppNaics.substring(0, 2))) return 30
  return 0
}

// ─── Factor 2: Past performance record (20%) ─────────────────
function scorePastPerformance(
  stats: ClientData['performanceStats'],
  relevant?: ClientData['relevantPastPerformance']
): number {
  // Base score from the aggregate submission win/loss + completion signal.
  let base: number
  if (!stats) {
    base = 40 // No data — neutral/low assumption
  } else {
    const totalDecided = stats.totalWon + stats.totalLost
    if (totalDecided === 0 && stats.totalSubmitted === 0) {
      base = 35
    } else {
      base = 35
      // Win rate (60% of this factor)
      if (totalDecided > 0) {
        const winRate = stats.totalWon / totalDecided
        base += winRate * 60
      } else {
        base += 20 // No wins/losses yet, give partial credit
      }
      // Completion rate (40% of this factor)
      const completionRate = stats.completionRate || 0
      base += completionRate * 0.4 * 40 // up to 16 extra points
    }
  }

  // Relevance-aware adjustment (flag-gated; `relevant` is only ever populated
  // when RELEVANT_PAST_PERFORMANCE_ENABLED is on). Bounded to ±30 so structured
  // records refine, never dominate, the aggregate signal:
  //   • CPARS quality on matched contracts: ±20 around the SATISFACTORY (50)
  //     baseline — above-baseline lifts, sub-par penalises.
  //   • Relevant volume: up to +10, saturating at 3 matched contracts.
  // CALIBRATION-SENSITIVE — must be backtested before the flag is enabled.
  if (relevant && relevant.matchedCount > 0) {
    const cparsComponent =
      relevant.avgCparsScore != null ? ((relevant.avgCparsScore - 50) / 50) * 20 : 0
    const volumeComponent = (Math.min(relevant.matchedCount, 3) / 3) * 10
    base += cparsComponent + volumeComponent
  }

  return clamp100(base)
}

// ─── Factor 3: Capacity / scale fit (20%) ───────────────────
function scoreCapacityFit(
  estimatedValue: number | null,
  historicalAvgAward: number | null,
  stats: ClientData['performanceStats']
): number {
  if (!estimatedValue) return 50

  // Estimate client's typical award range from performance stats
  // If we have historical avg from USAspending, use that as the benchmark
  const referenceAward = historicalAvgAward || 500000

  // Sweet spot: contract is within 0.5x–2x of reference
  const ratio = estimatedValue / referenceAward
  if (ratio >= 0.5 && ratio <= 2.0) return 100
  if (ratio >= 0.25 && ratio < 0.5) return 75
  if (ratio > 2.0 && ratio <= 5.0) return 65
  if (ratio > 5.0 && ratio <= 10.0) return 40
  if (ratio > 10.0) return 20
  return 50 // very small contract vs historical
}

// ─── Factor 4: Geographic fit (10%) ──────────────────────────
function scoreGeographicFit(
  clientState: string | null | undefined,
  placeOfPerformance: string | null | undefined
): number {
  if (!placeOfPerformance || !clientState) return 65 // No data — default pass

  const pop = placeOfPerformance.toUpperCase()

  // Remote/nationwide/CONUS
  if (
    pop.includes('NATIONWIDE') ||
    pop.includes('NATIONAL') ||
    pop.includes('CONUS') ||
    pop.includes('REMOTE') ||
    pop.includes('N/A')
  ) {
    return 80
  }

  // State match
  if (pop.includes(clientState.toUpperCase())) return 100

  // Adjacent/DC area heuristic
  const dcStates = ['DC', 'VA', 'MD', 'PA', 'DE', 'WV', 'NJ']
  if (dcStates.includes(clientState.toUpperCase()) && dcStates.some((s) => pop.includes(s))) {
    return 75
  }

  return 40 // Different region
}

// ─── Factor 5: Resource readiness (15%) ──────────────────────
function scoreResourceReadiness(responseDeadline: Date): number {
  const daysLeft = (responseDeadline.getTime() - Date.now()) / 86400000
  if (daysLeft > 45) return 100
  if (daysLeft > 30) return 90
  if (daysLeft > 20) return 75
  if (daysLeft > 14) return 60
  if (daysLeft > 7) return 40
  if (daysLeft > 3) return 20
  return 5
}

// ─── Factor 6: Financial strength (10%) ──────────────────────
function scoreFinancialStrength(stats: ClientData['performanceStats']): number {
  if (!stats) return 60

  const totalPenalties = Number(stats.totalPenalties || 0)
  if (totalPenalties === 0) return 100
  if (totalPenalties < 5000) return 85
  if (totalPenalties < 25000) return 70
  if (totalPenalties < 100000) return 50
  return 30
}

// ─── Composite Fit Score ──────────────────────────────────────
export function computeFitScore(client: ClientData, opportunity: OpportunityData): FitScoreOutput {
  const naicsDepth = clamp100(scoreNaicsDepth(client.naicsCodes, opportunity.naicsCode))
  const pastPerformance = clamp100(
    scorePastPerformance(client.performanceStats, client.relevantPastPerformance)
  )
  const capacityFit = clamp100(
    scoreCapacityFit(
      opportunity.estimatedValue,
      opportunity.historicalAvgAward ?? null,
      client.performanceStats
    )
  )
  const geographicFit = clamp100(scoreGeographicFit(client.state, opportunity.placeOfPerformance))
  const resourceReadiness = clamp100(scoreResourceReadiness(opportunity.responseDeadline))
  const financialStrength = clamp100(scoreFinancialStrength(client.performanceStats))

  const total = clamp100(
    naicsDepth       * 0.25 +
    pastPerformance  * 0.20 +
    capacityFit      * 0.20 +
    resourceReadiness * 0.15 +
    geographicFit    * 0.10 +
    financialStrength * 0.10
  )

  return {
    total: Math.round(total),
    breakdown: {
      naicsDepth: Math.round(naicsDepth),
      pastPerformance: Math.round(pastPerformance),
      capacityFit: Math.round(capacityFit),
      geographicFit: Math.round(geographicFit),
      resourceReadiness: Math.round(resourceReadiness),
      financialStrength: Math.round(financialStrength),
    },
  }
}
