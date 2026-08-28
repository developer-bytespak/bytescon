// =============================================================
// Market Score — Layer 3: Opportunity attractiveness
// Returns 0-100 score independent of client capability
// Measures how favorable the market conditions are
// =============================================================
import { MarketScoreOutput } from '../types'

interface MarketData {
  // Competition signals
  offersReceived?: number | null      // FPDS: actual bidder count per solicitation
  competitionCount?: number | null    // USAspending: unique historical winners
  // Incumbent signals
  incumbentProbability?: number | null
  recompeteFlag?: boolean
  // Contract signals
  estimatedValue?: number | null
  historicalAvgAward?: number | null
  noticeType?: string | null
  setAsideType?: string
  // Agency signals
  agencySmallBizRate?: number | null
  agencySdvosbRate?: number | null
  // Client certification (to compute agency alignment bonus)
  clientProfile?: { sdvosb: boolean; wosb: boolean; hubzone: boolean; smallBusiness: boolean }
}

function clamp100(v: number): number {
  return Math.max(0, Math.min(100, v))
}

// ─── Factor 1: Competition density (30%) ─────────────────────
// offersReceived = actual bidders on THIS solicitation (FPDS): more bidders =
// harder to win. competitionCount = distinct historical winners for the
// NAICS+agency (USAspending): that measures market FRAGMENTATION, not
// per-solicitation competition — many distinct winners signal an accessible,
// churning market (favorable to a small-business entrant), while a lone
// historical winner signals an entrenched incumbent. The two must use
// different curves; the prior code applied the bidder curve to both, which
// wrongly scored healthy, fragmented markets as "highly contested" (15) and
// suppressed market scores wherever real bidder counts were unavailable.
function scoreOffersReceived(offers: number): number {
  if (offers <= 1) return 95   // Near-sole-source (very favorable)
  if (offers <= 2) return 88
  if (offers <= 3) return 80
  if (offers <= 5) return 70
  if (offers <= 8) return 58
  if (offers <= 12) return 45
  if (offers <= 20) return 30
  return 15  // Highly contested
}

function scoreMarketFragmentation(distinctWinners: number): number {
  // Weak proxy, so kept in a narrow band around neutral. Incumbent entrenchment
  // is already captured by the separate incumbent-strength factor, so a lone
  // historical winner is treated as neutral here rather than doubly penalized.
  if (distinctWinners <= 1) return 50  // single historical winner — neutral
  if (distinctWinners <= 3) return 55  // somewhat consolidated
  if (distinctWinners <= 8) return 62  // moderately open
  return 67                            // fragmented / accessible market
}

function scoreCompetitionDensity(
  offersReceived: number | null | undefined,
  competitionCount: number | null | undefined
): number {
  if (offersReceived !== null && offersReceived !== undefined) return scoreOffersReceived(offersReceived)
  if (competitionCount !== null && competitionCount !== undefined) return scoreMarketFragmentation(competitionCount)
  return 55 // Unknown — slight optimism bias
}

// ─── Factor 2: Incumbent strength (25%) ──────────────────────
function scoreIncumbentStrength(
  incumbentProbability: number | null | undefined,
  recompeteFlag: boolean | undefined
): number {
  if (incumbentProbability === null || incumbentProbability === undefined) {
    // No data — recompete is a mild positive signal
    return recompeteFlag ? 60 : 50
  }

  // Lower incumbent probability = easier to displace = more attractive market
  let base: number
  if (incumbentProbability < 0.15) base = 95  // Very fragmented market
  else if (incumbentProbability < 0.30) base = 85
  else if (incumbentProbability < 0.45) base = 72
  else if (incumbentProbability < 0.60) base = 55
  else if (incumbentProbability < 0.75) base = 38
  else base = 22  // Dominant incumbent — high barrier

  // Recompete signal: incumbent may be vulnerable regardless of prior win rate
  if (recompeteFlag && incumbentProbability < 0.65) {
    base = clamp100(base + 12)
  }

  return base
}

// ─── Factor 3: Contract value fit (20%) ──────────────────────
// Sweet spot for SDVOSB/small business: $500K–$15M
function scoreContractValueFit(estimatedValue: number | null | undefined): number {
  if (!estimatedValue) return 50

  if (estimatedValue >= 500000 && estimatedValue <= 5000000) return 95
  if (estimatedValue > 5000000 && estimatedValue <= 15000000) return 85
  if (estimatedValue > 15000000 && estimatedValue <= 30000000) return 65
  if (estimatedValue > 30000000 && estimatedValue <= 50000000) return 45
  if (estimatedValue > 50000000) return 25  // Large prime — hard to win as small biz
  if (estimatedValue >= 150000 && estimatedValue < 500000) return 75  // Micro-prime range
  return 55 // Very small (micropurchase territory)
}

// ─── Factor 4: Agency buying patterns (15%) ──────────────────
function scoreAgencyBuyingPatterns(
  agencySmallBizRate: number | null | undefined,
  agencySdvosbRate: number | null | undefined,
  clientProfile?: MarketData['clientProfile']
): number {
  if (!agencySmallBizRate && !agencySdvosbRate) return 50

  let score = 50

  if (clientProfile?.sdvosb && agencySdvosbRate != null) {
    // Agency-specific SDVOSB rate
    if (agencySdvosbRate > 0.15) score = 95
    else if (agencySdvosbRate > 0.10) score = 82
    else if (agencySdvosbRate > 0.05) score = 68
    else score = 45
  } else if ((clientProfile?.smallBusiness || clientProfile?.wosb || clientProfile?.hubzone) && agencySmallBizRate != null) {
    if (agencySmallBizRate > 0.35) score = 90
    else if (agencySmallBizRate > 0.25) score = 75
    else if (agencySmallBizRate > 0.15) score = 60
    else score = 40
  } else if (agencySmallBizRate != null) {
    score = 40 + agencySmallBizRate * 100
  }

  return clamp100(score)
}

// ─── Factor 5: Timing advantage (10%) ────────────────────────
function scoreTimingAdvantage(
  noticeType: string | null | undefined,
  recompeteFlag: boolean | undefined
): number {
  let score = 50

  const nt = (noticeType || '').toLowerCase()

  // Sources Sought / RFI = early engagement opportunity
  if (nt.includes('sources sought') || nt.includes('request for information')) score = 85
  // Presolicitation = can shape requirements
  else if (nt.includes('presolicitation')) score = 72
  // Solicitation = competitive timeline, standard
  else if (nt.includes('solicitation')) score = 55
  // Award notice (modification/follow-on) = late stage
  else if (nt.includes('award')) score = 30
  // Sole source = usually not open to others
  else if (nt.includes('sole source') || nt.includes('j&a')) score = 15

  // Recompete timing bonus — these often have incumbent transition risk
  if (recompeteFlag) score = clamp100(score + 10)

  return score
}

// ─── Composite Market Score ───────────────────────────────────
export function computeMarketScore(data: MarketData): MarketScoreOutput {
  const competitionDensity = scoreCompetitionDensity(data.offersReceived, data.competitionCount)
  const incumbentStrength = scoreIncumbentStrength(data.incumbentProbability, data.recompeteFlag)
  // SAM rarely states a dollar value on solicitations, so fall back to the
  // agency/NAICS historical average award (USAspending) as a value proxy
  // instead of sitting at the neutral 50 — keeps real deal-size signal in play.
  const contractValueFit = scoreContractValueFit(data.estimatedValue ?? data.historicalAvgAward ?? null)
  const agencyBuyingPatterns = scoreAgencyBuyingPatterns(
    data.agencySmallBizRate,
    data.agencySdvosbRate,
    data.clientProfile
  )
  const timingAdvantage = scoreTimingAdvantage(data.noticeType, data.recompeteFlag)

  const total = clamp100(
    competitionDensity  * 0.30 +
    incumbentStrength   * 0.25 +
    contractValueFit    * 0.20 +
    agencyBuyingPatterns * 0.15 +
    timingAdvantage     * 0.10
  )

  return {
    total: Math.round(total),
    breakdown: {
      competitionDensity: Math.round(competitionDensity),
      incumbentStrength: Math.round(incumbentStrength),
      contractValueFit: Math.round(contractValueFit),
      agencyBuyingPatterns: Math.round(agencyBuyingPatterns),
      timingAdvantage: Math.round(timingAdvantage),
    },
  }
}
