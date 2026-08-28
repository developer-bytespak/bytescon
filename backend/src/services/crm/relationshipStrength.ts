// =============================================================
// §8.1 — Relationship strength.
//
// Deterministic and evidence-backed. No LLM is involved, and no score is ever
// stored: it is recomputed from CrmActivity, CrmFollowUp and pipeline records
// on every read, so it cannot go stale and no agent can write it.
//
// The honesty rules that shape this, in order of importance:
//
//  1. No interactions means NO_DATA — never WEAK. "Weak" is a judgement about a
//     relationship we have observed; absence of records is not evidence of a
//     poor relationship, it is absence of evidence, and a user who sees WEAK
//     for a contact they have never logged will stop trusting the number.
//  2. Recency alone cannot carry a score. One call yesterday is a start, not a
//     relationship, so the frequency and depth components are needed to climb.
//  3. Every result carries the evidence it was computed from, so a user can
//     see exactly which activities produced the state.
// =============================================================
import { CrmActivityType } from '@prisma/client'

export type RelationshipState = 'NO_DATA' | 'WEAK' | 'DEVELOPING' | 'ACTIVE' | 'STRONG'

/**
 * Activity types that represent a genuine two-way engagement. A logged NOTE is
 * a record the user made for themselves — it says nothing about the other side
 * — so it is counted as an interaction but never as a meaningful touchpoint.
 */
const MEANINGFUL_TYPES: ReadonlySet<CrmActivityType> = new Set([
  CrmActivityType.CALL,
  CrmActivityType.MEETING,
  CrmActivityType.INDUSTRY_DAY,
  CrmActivityType.SITE_VISIT,
  CrmActivityType.CAPABILITY_BRIEFING,
  CrmActivityType.CONFERENCE,
])

export const RECENCY_WINDOW_DAYS = 90
export const FREQUENCY_WINDOW_DAYS = 365

export interface StrengthActivityInput {
  activityType: CrmActivityType
  occurredAt: Date
}

export interface StrengthInput {
  activities: StrengthActivityInput[]
  /** Open pursuits/opportunities currently linked to this contact or partner. */
  activeOpportunityCount: number
  /** Follow-ups still open — evidence the relationship is being worked. */
  openFollowUpCount: number
  now?: Date
}

export interface StrengthEvidence {
  factor: string
  detail: string
  points: number
}

export interface RelationshipStrengthResult {
  state: RelationshipState
  /** 0-100. Null only when state is NO_DATA — we do not render 0 as a score. */
  score: number | null
  reason: string
  evidence: StrengthEvidence[]
  totalInteractions: number
  meaningfulInteractions: number
  lastInteractionAt: string | null
  daysSinceLastInteraction: number | null
}

const DAY_MS = 86_400_000

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS)
}

/**
 * Compute relationship strength from real records.
 *
 * Scoring is capped per factor so that no single dimension can carry a state on
 * its own — a flurry of activity in one week cannot reach STRONG without the
 * history to support it.
 */
export function computeRelationshipStrength(input: StrengthInput): RelationshipStrengthResult {
  const now = input.now ?? new Date()
  const activities = [...input.activities].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())

  const totalInteractions = activities.length
  const meaningful = activities.filter((a) => MEANINGFUL_TYPES.has(a.activityType))
  const meaningfulInteractions = meaningful.length

  if (totalInteractions === 0) {
    return {
      state: 'NO_DATA',
      score: null,
      reason:
        'No interactions have been logged with this contact yet, so relationship strength cannot be assessed. This is not a judgement that the relationship is weak.',
      evidence: [],
      totalInteractions: 0,
      meaningfulInteractions: 0,
      lastInteractionAt: null,
      daysSinceLastInteraction: null,
    }
  }

  const evidence: StrengthEvidence[] = []
  const last = activities[0].occurredAt
  const daysSince = Math.max(0, daysBetween(last, now))

  // --- Recency (max 30) ---
  let recency = 0
  if (daysSince <= 30) recency = 30
  else if (daysSince <= RECENCY_WINDOW_DAYS) recency = 20
  else if (daysSince <= 180) recency = 10
  else if (daysSince <= FREQUENCY_WINDOW_DAYS) recency = 5
  evidence.push({
    factor: 'Recency',
    detail:
      daysSince <= 30
        ? `Last interaction was ${daysSince} day(s) ago.`
        : `Last interaction was ${daysSince} day(s) ago, which is outside the ${RECENCY_WINDOW_DAYS}-day active window.`,
    points: recency,
  })

  // --- Frequency over the trailing year (max 25) ---
  const inYear = activities.filter((a) => daysBetween(a.occurredAt, now) <= FREQUENCY_WINDOW_DAYS).length
  const frequency = Math.min(25, inYear * 5)
  evidence.push({
    factor: 'Frequency',
    detail: `${inYear} interaction(s) logged in the last ${FREQUENCY_WINDOW_DAYS} days.`,
    points: frequency,
  })

  // --- Depth: meaningful two-way touchpoints (max 25) ---
  const depth = Math.min(25, meaningfulInteractions * 5)
  evidence.push({
    factor: 'Meaningful touchpoints',
    detail:
      meaningfulInteractions === 0
        ? 'Only notes or emails are recorded — no calls, meetings or events that show two-way engagement.'
        : `${meaningfulInteractions} call(s), meeting(s) or event(s) recorded.`,
    points: depth,
  })

  // --- Active pipeline (max 12) ---
  const pipeline = Math.min(12, input.activeOpportunityCount * 6)
  evidence.push({
    factor: 'Active pursuits',
    detail: `${input.activeOpportunityCount} open opportunity or pursuit linked.`,
    points: pipeline,
  })

  // --- Being actively worked (max 8) ---
  const worked = Math.min(8, input.openFollowUpCount * 4)
  evidence.push({
    factor: 'Follow-ups in flight',
    detail: `${input.openFollowUpCount} open follow-up(s).`,
    points: worked,
  })

  const score = recency + frequency + depth + pipeline + worked

  // A relationship with no two-way contact is capped below ACTIVE no matter how
  // many notes were filed against it.
  const capped = meaningfulInteractions === 0 ? Math.min(score, 39) : score

  let state: RelationshipState
  if (capped >= 75) state = 'STRONG'
  else if (capped >= 55) state = 'ACTIVE'
  else if (capped >= 30) state = 'DEVELOPING'
  else state = 'WEAK'

  const reason =
    meaningfulInteractions === 0
      ? `${totalInteractions} interaction(s) recorded, but none of them is a call, meeting or event, so this cannot be read as an established relationship.`
      : `${meaningfulInteractions} meaningful touchpoint(s) across ${totalInteractions} logged interaction(s), most recently ${daysSince} day(s) ago.`

  return {
    state,
    score: capped,
    reason,
    evidence,
    totalInteractions,
    meaningfulInteractions,
    lastInteractionAt: last.toISOString(),
    daysSinceLastInteraction: daysSince,
  }
}
