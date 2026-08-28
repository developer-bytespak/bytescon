import { prisma } from '../config/database'
import { config } from '../config/config'
import { scoreOpportunityForClient } from '../engines/probabilityEngine'
import { computeMatchScoreV2 } from '../engines/matchingV2'
import { logger } from '../utils/logger'

export interface MatchSuggestion {
  opportunityId: string
  opportunityTitle: string
  agency: string
  estimatedValue: number
  daysToDeadline: number
  clientId: string
  clientName: string
  matchScore: number       // 0-100
  winProbability: number
  expectedValue: number
  matchReasons: string[]
}

export async function findTopMatches(
  consultingFirmId: string,
  limit: number = 10
): Promise<MatchSuggestion[]> {
  try {
    // Get active clients first so we can push their NAICS prefixes into the
    // opportunity query, instead of loading every active opportunity and doing
    // the whole N×M filter in memory.
    const clients = await prisma.clientCompany.findMany({
      where: {
        consultingFirmId,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        naicsCodes: true,
        pscCodes: true,
        sdvosb: true,
        wosb: true,
        hubzone: true,
        smallBusiness: true,
        state: true,
        performanceStats: {
          select: {
            totalWon: true,
            totalLost: true,
            totalSubmitted: true,
            completionRate: true,
          },
        },
      },
    })

    // 2-digit NAICS prefixes across all clients — the coarse match key. With no
    // clients (or no NAICS on file) there can be no matches.
    const clientPrefixes = Array.from(
      new Set(
        clients.flatMap((c) =>
          c.naicsCodes.map((code) => code.substring(0, 2)).filter((p) => p.length === 2)
        )
      )
    )
    if (clients.length === 0 || clientPrefixes.length === 0) return []

    // Get active, future-deadline opportunities whose NAICS shares a 2-digit
    // prefix with at least one client. The prefix filter runs in SQL and the
    // candidate set is capped (soonest deadlines first) to bound the in-memory
    // scoring loop below — previously this loaded every active opportunity.
    const opportunities = await prisma.opportunity.findMany({
      where: {
        consultingFirmId,
        status: 'ACTIVE',
        responseDeadline: { gt: new Date() },
        OR: clientPrefixes.map((p) => ({ naicsCode: { startsWith: p } })),
      },
      select: {
        id: true,
        title: true,
        agency: true,
        naicsCode: true,
        psc: true,
        setAsideType: true,
        estimatedValue: true,
        responseDeadline: true,
        placeOfPerformance: true,
        historicalAvgAward: true,
        incumbentProbability: true,
        competitionCount: true,
        agencySdvosbRate: true,
        historicalAwardCount: true,
        documentIntelScore: true,
        isEnriched: true,
        bidDecisions: { select: { clientCompanyId: true } },
      },
      orderBy: { responseDeadline: 'asc' },
      take: 2000,
    })

    if (opportunities.length >= 2000) {
      logger.warn('findTopMatches hit the 2000-candidate cap — some opportunities were not scored', { consultingFirmId })
    }

    const suggestions: MatchSuggestion[] = []

    for (const opp of opportunities) {
      const existingDecisionClients = new Set(
        opp.bidDecisions.map((d) => d.clientCompanyId)
      )

      for (const client of clients) {
        // Skip if decision already exists
        if (existingDecisionClients.has(client.id)) continue

        // Pre-filter: at least 2-digit NAICS prefix match
        const oppPrefix = opp.naicsCode.substring(0, 2)
        const hasNaicsOverlap = client.naicsCodes.some(
          (code) => code.substring(0, 2) === oppPrefix
        )
        if (!hasNaicsOverlap) continue

        const estValue = opp.estimatedValue ? Number(opp.estimatedValue) : null

        const result = scoreOpportunityForClient({
          opportunityNaics: opp.naicsCode,
          opportunityEstimatedValue: estValue,
          opportunityAgency: opp.agency,
          clientNaics: client.naicsCodes,
          clientProfile: {
            sdvosb: client.sdvosb,
            wosb: client.wosb,
            hubzone: client.hubzone,
            smallBusiness: client.smallBusiness,
          },
          incumbentProbability: opp.incumbentProbability,
          competitionCount: opp.competitionCount,
          agencySdvosbRate: opp.agencySdvosbRate,
          historicalDistribution: opp.historicalAwardCount
            ? Math.min(opp.historicalAwardCount / 1000, 0.8)
            : 0.3,
          documentAlignmentScore: opp.documentIntelScore,
        })

        // P1-1: skip pairs whose win-probability compute failed — never emit a
        // match suggestion built on a fabricated score.
        if (result.status !== 'OK') continue

        // Matching v2 (GB-101/102): when enabled, the operator-facing match
        // score is the renormalized relevance/fit score, which credits NAICS
        // prefixes + PSC and is not deflated by the win-probability baseline.
        // Win probability and expected value still come from the probability
        // model. When the flag is off, behavior is exactly as before.
        const matchV2 = config.matching.v2Enabled
          ? computeMatchScoreV2(
              {
                naicsCodes: client.naicsCodes,
                pscCodes: client.pscCodes,
                sdvosb: client.sdvosb,
                wosb: client.wosb,
                hubzone: client.hubzone,
                smallBusiness: client.smallBusiness,
                state: client.state,
                performanceStats: client.performanceStats,
              },
              {
                naicsCode: opp.naicsCode,
                psc: opp.psc,
                estimatedValue: estValue,
                placeOfPerformance: opp.placeOfPerformance,
                historicalAvgAward: opp.historicalAvgAward ? Number(opp.historicalAvgAward) : null,
                setAsideType: opp.setAsideType,
              },
              config.matching.weights
            )
          : null

        // Skip non-matches. v2: drop only zero-overlap pairs (the renormalized
        // score is a relevance signal, not a win-probability cutoff — gating it
        // on probability is the legacy defect that hid canonical matches).
        // Legacy: preserve the historical < 0.15 probability filter.
        if (matchV2) {
          if (matchV2.total <= 0) continue
        } else if (result.probability < 0.15) {
          continue
        }

        const matchScore = matchV2 ? matchV2.total : Math.round(result.probability * 100)

        const matchReasons: string[] = []
        const f = result.features

        if (matchV2) {
          const b = matchV2.breakdown
          if (b.naics.present && b.naics.raw >= 1) matchReasons.push('Exact NAICS match')
          else if (b.naics.present && b.naics.raw >= 0.6) matchReasons.push('Strong NAICS alignment')
          else if (b.naics.present && b.naics.raw > 0) matchReasons.push('Adjacent NAICS match')
          if (b.psc.present && b.psc.raw >= 1) matchReasons.push('Exact PSC match')
          else if (b.psc.present && b.psc.raw > 0) matchReasons.push('Same PSC family')
          if (b.setAsideAlignment.present && b.setAsideAlignment.raw >= 1) matchReasons.push('Set-aside fits firm certifications')
          if (b.awardSize.present && b.awardSize.raw >= 0.9) matchReasons.push('Award size fits client capacity')
          if (b.geography.present && b.geography.raw >= 1) matchReasons.push('In-state place of performance')
        } else {
          if (f.naicsOverlapScore >= 0.8) matchReasons.push('Strong NAICS alignment')
          else if (f.naicsOverlapScore >= 0.5) matchReasons.push('Partial NAICS match')

          if (f.agencyAlignmentScore >= 0.8) matchReasons.push('Favorable agency set-aside profile')
          if (f.incumbentWeaknessScore > 0.7) matchReasons.push('Weak incumbent — opportunity to compete')
          if (f.documentAlignmentScore > 0.7) matchReasons.push('Strong SOW alignment')
          if (f.agencyAlignmentScore > 0.7) matchReasons.push('Favorable agency alignment')
          if (f.awardSizeFitScore > 0.8) matchReasons.push('Award size fits client capacity')
          if (f.competitionDensityScore > 0.7) matchReasons.push('Low competition density')
        }

        if (opp.isEnriched) matchReasons.push('Enriched with historical data')

        const daysToDeadline = Math.ceil(
          (new Date(opp.responseDeadline).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        )

        suggestions.push({
          opportunityId: opp.id,
          opportunityTitle: opp.title,
          agency: opp.agency,
          estimatedValue: estValue || 0,
          daysToDeadline,
          clientId: client.id,
          clientName: client.name,
          matchScore,
          winProbability: result.probability,
          expectedValue: result.expectedValue,
          matchReasons,
        })
      }
    }

    // Sort by match score descending and take top results
    suggestions.sort((a, b) => b.matchScore - a.matchScore)
    return suggestions.slice(0, limit)
  } catch (err) {
    logger.error('Failed to compute opportunity matches', { error: err })
    return []
  }
}
