// =============================================================
// Market Insights — turns raw BQ snapshot/profile data into
// plain-English recommendations for federal contracting consultants.
// =============================================================
import { MarketSnapshot, AgencyProfile, getCompetitionProfile, getAgencyProfile } from './analyticsService'

export interface MarketInsight {
  level: 'OPPORTUNITY' | 'RISK' | 'NEUTRAL'
  title: string
  body: string
}

export interface InsightContext {
  snapshot: MarketSnapshot
  firmCertifications: { sdvosb: boolean; wosb: boolean; hubzone: boolean; smallBiz: boolean }
  firmActivePipelineValue?: number  // probability-weighted, optional
  firmActiveOppCount?: number
}

/**
 * Generate 3–5 plain-English insights for the firm's market position.
 * Pure heuristics — no LLM, no external calls.
 */
export async function getMarketInsights(ctx: InsightContext): Promise<MarketInsight[]> {
  const out: MarketInsight[] = []
  const { snapshot, firmCertifications: cert } = ctx

  // 1. Market sizing relative to firm's pipeline
  if (ctx.firmActivePipelineValue != null && snapshot.totalOpportunityVolume > 0) {
    const sharePct = (ctx.firmActivePipelineValue / snapshot.totalOpportunityVolume) * 100
    if (sharePct < 0.01) {
      out.push({
        level: 'OPPORTUNITY',
        title: 'Massive untapped market',
        body: `Your active pipeline is less than 0.01% of the ${formatBigDollars(snapshot.totalOpportunityVolume)} addressable market in your tracked NAICS codes. Even a small expansion in opportunity intake could meaningfully grow your pipeline.`,
      })
    } else if (sharePct > 5) {
      out.push({
        level: 'NEUTRAL',
        title: 'Mature market position',
        body: `Your firm is targeting ~${sharePct.toFixed(2)}% of the addressable market in tracked NAICS — a sizeable share. Focus shifts from volume to win-rate optimization.`,
      })
    }
  }

  // 2. Concentration analysis — find the most fragmented (best for new entrants) NAICS
  if (snapshot.heatmap.length > 0) {
    const fragmented = [...snapshot.heatmap]
      .filter((h) => h.uniqueWinners != null && h.awards >= 20)
      .sort((a: any, b: any) => (b.uniqueWinners ?? 0) - (a.uniqueWinners ?? 0))[0] as any
    const dominated = [...snapshot.heatmap]
      .filter((h) => h.uniqueWinners != null && h.awards >= 20)
      .sort((a: any, b: any) => (a.uniqueWinners ?? 999) - (b.uniqueWinners ?? 999))[0] as any

    if (fragmented && fragmented.uniqueWinners >= 25) {
      out.push({
        level: 'OPPORTUNITY',
        title: `NAICS ${fragmented.naicsCode} — fragmented market`,
        body: `${fragmented.uniqueWinners} unique winners across ${fragmented.awards} contracts. No incumbent dominates — favorable conditions for new entrants and aggressive bidders.`,
      })
    }

    if (dominated && dominated.uniqueWinners <= 5 && dominated.awards >= 20) {
      out.push({
        level: 'RISK',
        title: `NAICS ${dominated.naicsCode} — incumbent dominated`,
        body: `Only ${dominated.uniqueWinners} firms split ${dominated.awards} contracts. Hard to break in without prior relationships, teaming, or a clear differentiator.`,
      })
    }
  }

  // 3. Agency-fit insight — pick a top agency and check set-aside affinity for the firm's certifications
  if (snapshot.topAgencies.length > 0 && (cert.sdvosb || cert.wosb || cert.hubzone || cert.smallBiz)) {
    const topAgency = snapshot.topAgencies[0].agency
    const profile = await getAgencyProfile(topAgency).catch(() => null)
    if (profile) {
      const insight = bestSetAsideMatch(profile, cert)
      if (insight) out.push(insight)
    }
  }

  // 4. Top NAICS by volume — quick "where is the money"
  if (snapshot.heatmap.length > 0) {
    const sorted = [...snapshot.heatmap]
      .map((h: any) => ({ ...h, totalDollars: (h.awards ?? 0) * (h.avgAmount ?? 0) }))
      .sort((a, b) => b.totalDollars - a.totalDollars)
    const top = sorted[0]
    if (top && top.totalDollars > 0) {
      out.push({
        level: 'NEUTRAL',
        title: `Largest market by dollars: NAICS ${top.naicsCode}`,
        body: `${formatBigDollars(top.totalDollars)} across ${top.awards} contracts (avg ${formatBigDollars(top.avgAmount)}). Worth prioritizing for client portfolio expansion.`,
      })
    }
  }

  // 5. Pipeline activity context — if firm has zero active opps in tracked NAICS, flag it
  if (ctx.firmActiveOppCount === 0) {
    out.push({
      level: 'RISK',
      title: 'No active opportunities matched',
      body: `Your firm has zero active opportunities scored against the tracked NAICS portfolio. Either ingest more SAM.gov data or expand client NAICS coverage to surface live bids.`,
    })
  }

  return out.slice(0, 5)
}

function bestSetAsideMatch(
  agency: AgencyProfile,
  cert: { sdvosb: boolean; wosb: boolean; hubzone: boolean; smallBiz: boolean },
): MarketInsight | null {
  const matches: Array<{ name: string; rate: number; firmHas: boolean }> = [
    { name: 'SDVOSB', rate: agency.sdvosbRate, firmHas: cert.sdvosb },
    { name: 'WOSB', rate: agency.wosbRate, firmHas: cert.wosb },
    { name: 'HUBZone', rate: agency.hubzoneRate, firmHas: cert.hubzone },
    { name: 'Small Business', rate: agency.smallBizRate, firmHas: cert.smallBiz },
  ]
  // Prefer specific socioeconomic certs over generic small-business
  const fit = matches
    .filter((m) => m.firmHas && m.rate >= 0.15)
    .sort((a, b) => b.rate - a.rate)[0]
  if (!fit) return null
  return {
    level: 'OPPORTUNITY',
    title: `${agency.agency} favors ${fit.name}`,
    body: `${(fit.rate * 100).toFixed(0)}% of this agency's awards go to ${fit.name}. Your firm has at least one client with this designation — strong agency-set-aside fit.`,
  }
}

function formatBigDollars(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${Math.round(n)}`
}

// Re-export for convenience in route layer
export { getCompetitionProfile }
