// =============================================================
// After an action on an opportunity, tell the person what was done, where it
// stands now and where to check it, and what to do next and where — as a
// pop-up with a link to the next step. Also refreshes the status bar.
// Data: GET /api/opportunities/:id/journey (backend services/opportunityJourney.ts).
// =============================================================
import { useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { opportunitiesApi } from '../services/api'
import { useToast } from '../components/Toast'

export interface JourneyLink { label: string; to: string }
export interface Journey {
  pursuitId: string | null
  stage: string | null
  stageLabel: string
  steps: Array<{ key: string; label: string; state: 'done' | 'current' | 'todo' | 'skipped' }>
  lastDone: string | null
  status: { text: string; where: JourneyLink }
  next: { text: string; action: JourneyLink | null } | null
  outcomeActions: boolean
  warning: string | null
}

export const journeyKey = (opportunityId: string, clientCompanyId?: string | null) => ['journey', opportunityId, clientCompanyId ?? null]

/** The text of the next-step pop-up for a journey. */
export function nextStepMessage(j: Journey, done?: string) {
  return {
    message: done ?? j.lastDone ?? 'Saved.',
    detail: [`Now: ${j.status.text}`, j.next ? `Next: ${j.next.text}` : null].filter(Boolean).join(' '),
    // Where to do the next step; if it's done on this page, where to check the status.
    action: j.next?.action ?? j.status.where,
  }
}

export function useNextStep() {
  const qc = useQueryClient()
  const { toast } = useToast()
  return useCallback(async (opportunityId: string, opts: { clientCompanyId?: string | null; done?: string } = {}) => {
    try {
      const j = (await opportunitiesApi.journey(opportunityId, opts.clientCompanyId)).data as Journey
      qc.setQueryData(journeyKey(opportunityId, opts.clientCompanyId), { data: j })
      void qc.invalidateQueries({ queryKey: ['journey', opportunityId] })
      const m = nextStepMessage(j, opts.done)
      toast(m.message, 'success', { detail: m.detail, action: m.action })
    } catch {
      // The action itself succeeded; without the journey, say only that.
      toast(opts.done ?? 'Saved.', 'success')
    }
  }, [qc, toast])
}
