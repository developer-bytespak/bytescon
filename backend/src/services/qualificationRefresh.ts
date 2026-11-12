// =============================================================
// Keep a scorecard's suggested scores current.
//
// Suggestions (services/qualificationSuggestions.ts) are worked out from the
// firm's records and the notice's award history, both of which change after a
// scorecard is started: award history arrives with the next sync, a profile
// gains past performance, a bid gets priced. So an undecided scorecard is
// refreshed when it is opened, when its notice's award history arrives, and
// from the "Refresh suggestions" button — all through this one function.
//
// The rule: every criterion's suggestion and reason are recomputed; its score
// takes the new suggestion only if nobody has changed it (still empty, or
// still equal to the previous suggestion). Decided scorecards and closed
// pursuits are never touched.
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { computeScorecard, RECOMMENDATION_VERSION, type ScoringResult } from './scorecardScoring'
import { loadSuggestionInput, suggestScores } from './qualificationSuggestions'

export interface RefreshOutcome {
  refreshed: boolean
  /** Criteria whose suggestion, reason or score changed. */
  changed: number
  result: ScoringResult | null
}

export async function refreshScorecardSuggestions(scorecardId: string): Promise<RefreshOutcome> {
  const sc = await prisma.scorecard.findUnique({
    where: { id: scorecardId },
    include: { criteria: true, bidPursuit: { select: { closedAt: true } } },
  })
  if (!sc || sc.finalDecision || sc.bidPursuit.closedAt) return { refreshed: false, changed: 0, result: null }

  const suggestions = suggestScores(sc.criteria.map((c) => c.key), await loadSuggestionInput(sc.consultingFirmId, sc.opportunityId, sc.clientCompanyId))
  const updates = sc.criteria.flatMap((c) => {
    const s = suggestions[c.key]
    const untouched = c.score === null || c.score === c.suggestedScore
    const next = {
      suggestedScore: s?.score ?? null,
      suggestionNote: s?.note ?? null,
      score: untouched ? (s?.score ?? null) : c.score,
    }
    const same = next.suggestedScore === c.suggestedScore && next.suggestionNote === c.suggestionNote && next.score === c.score
    return same ? [] : [{ id: c.id, data: next }]
  })

  const result = computeScorecard(sc.criteria.map((c) => {
    const u = updates.find((x) => x.id === c.id)
    return { key: c.key, weight: c.weight, required: c.required, score: u ? u.data.score : c.score }
  }))
  if (updates.length > 0) {
    await prisma.$transaction([
      ...updates.map((u) => prisma.scorecardCriterion.update({ where: { id: u.id }, data: u.data })),
      prisma.scorecard.update({ where: { id: sc.id }, data: { totalScore: result.totalScore, recommendation: result.recommendation, recommendationVersion: RECOMMENDATION_VERSION } }),
    ])
  }
  return { refreshed: true, changed: updates.length, result }
}

/**
 * Refresh every undecided scorecard on a notice — called when its award
 * history arrives. Never throws: a failure here must not fail enrichment.
 */
export async function refreshScorecardsForOpportunity(opportunityId: string): Promise<number> {
  try {
    const scorecards = await prisma.scorecard.findMany({ where: { opportunityId, finalDecision: null }, select: { id: true } })
    let changed = 0
    for (const s of scorecards) changed += (await refreshScorecardSuggestions(s.id)).changed > 0 ? 1 : 0
    return changed
  } catch (err) {
    logger.warn('Could not refresh scorecard suggestions after award history', { opportunityId, error: (err as Error).message })
    return 0
  }
}
