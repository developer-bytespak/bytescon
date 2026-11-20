// The opportunity journey (GET /api/opportunities/:id/journey, backend
// services/opportunityJourney.ts): its shape and its cache key.

export interface JourneyLink { label: string; to: string }
export interface Journey {
  pursuitId: string | null
  stage: string | null
  stageLabel: string
  steps: Array<{ key: string; label: string; state: 'done' | 'current' | 'todo' | 'skipped' }>
  lastDone: string | null
  status: { text: string; where: JourneyLink }
  next: { text: string; action: JourneyLink | null } | null
  /** Something that can be done alongside the next step (e.g. pricing while writing). */
  also?: { text: string; action: JourneyLink } | null
  outcomeActions: boolean
  warning: string | null
  /** The step to finish now, in plain words, with the button that finishes it. */
  current?: { step: string; number: number; of: number; what: string; action: JourneyLink | null } | null
  /** The step after it, with a button to open it ahead (none at the end). */
  then?: { step: string; action: JourneyLink | null } | null
}

export const journeyKey = (opportunityId: string, clientCompanyId?: string | null) => ['journey', opportunityId, clientCompanyId ?? null]
