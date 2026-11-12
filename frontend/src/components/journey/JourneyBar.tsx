// =============================================================
// Status and next step — at the top of the opportunity page. Always shows:
//   the journey (Identified → Qualify → Capture → Proposal → Submitted → Award)
//   what was done last
//   where it stands now, and where to check it
//   what to do next, with a button to the page where it's done
// Once a bid is submitted, the outcome (won / lost) is recorded from here.
// Data: GET /api/opportunities/:id/journey (backend services/opportunityJourney.ts).
// =============================================================
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, Check, CircleDot, Flag, Trophy, XCircle } from 'lucide-react'
import { opportunitiesApi, pipelineApi } from '../../services/api'
import { useAuth } from '../../hooks/useAuth'
import { useToast } from '../Toast'
import { journeyKey, useNextStep, type Journey } from '../../hooks/useNextStep'

const errorText = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Something went wrong'

export function JourneyBar({ opportunityId, clientCompanyId }: { opportunityId: string; clientCompanyId?: string | null }) {
  const { user } = useAuth()
  const { toast } = useToast()
  const nextStep = useNextStep()
  const { data, isLoading } = useQuery<{ data: Journey }>({
    queryKey: journeyKey(opportunityId, clientCompanyId),
    queryFn: () => opportunitiesApi.journey(opportunityId, clientCompanyId),
  })
  const outcome = useMutation({
    mutationFn: (stage: 'AWARDED' | 'LOST') => pipelineApi.setStage(data!.data.pursuitId!, stage),
    onSuccess: (_r, stage) => void nextStep(opportunityId, { clientCompanyId, done: stage === 'AWARDED' ? 'Recorded as won.' : 'Recorded as lost.' }),
    onError: (e) => toast(errorText(e), 'error'),
  })

  if (isLoading || !data) return null
  const j = data.data

  return (
    <section className="card !py-4" aria-labelledby="journey-heading">
      <h2 id="journey-heading" className="sr-only">Status and next step</h2>
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-2 mb-3" aria-label="Bid journey">
        {j.steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1" aria-current={s.state === 'current' ? 'step' : undefined}>
            {i > 0 && <span className="w-4 h-px" style={{ background: 'var(--line-strong)' }} aria-hidden="true" />}
            <span className={`chip ${s.state === 'done' ? 'chip-success' : s.state === 'current' ? 'chip-accent' : 'chip-neutral'} ${s.state === 'skipped' ? 'opacity-50 line-through' : ''}`}>
              {s.state === 'done' ? <Check className="w-3 h-3" aria-hidden="true" /> : s.state === 'current' ? <CircleDot className="w-3 h-3" aria-hidden="true" /> : null}
              {s.label}
              <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (current step)' : s.state === 'skipped' ? ' (skipped)' : ''}</span>
            </span>
          </li>
        ))}
      </ol>

      <dl className="grid gap-3 sm:grid-cols-3 text-sm">
        <div>
          <dt className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Done</dt>
          <dd style={{ color: 'var(--text)' }}>{j.lastDone ?? 'Nothing yet.'}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Status now</dt>
          <dd style={{ color: 'var(--text)' }}>
            {j.status.text}{' '}
            <Link to={j.status.where.to} className="text-xs whitespace-nowrap" style={{ color: 'var(--accent)' }}>See it in {j.status.where.label}</Link>
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Next step</dt>
          <dd style={{ color: 'var(--text)' }}>
            {j.next ? j.next.text : 'Nothing left to do.'}
            {j.next?.action && (
              <Link to={j.next.action.to} className="btn-primary btn-sm mt-2 flex w-fit items-center gap-1">
                {j.next.action.label} <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
              </Link>
            )}
            {j.outcomeActions && j.pursuitId && user?.role === 'ADMIN' && (
              <span className="flex flex-wrap gap-2 mt-2">
                <button type="button" disabled={outcome.isPending} onClick={() => outcome.mutate('AWARDED')} className="btn-primary btn-sm inline-flex items-center gap-1 disabled:opacity-60">
                  <Trophy className="w-3.5 h-3.5" aria-hidden="true" /> Mark as won
                </button>
                <button type="button" disabled={outcome.isPending} onClick={() => outcome.mutate('LOST')} className="btn-secondary btn-sm inline-flex items-center gap-1 disabled:opacity-60">
                  <XCircle className="w-3.5 h-3.5" aria-hidden="true" /> Mark as lost
                </button>
              </span>
            )}
          </dd>
        </div>
      </dl>

      {j.warning && (
        <p className="text-xs mt-3 flex items-center gap-1.5" style={{ color: 'var(--danger)' }}>
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {j.warning}
        </p>
      )}
      {!j.stage && (
        <p className="text-xs mt-3 flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
          <Flag className="w-3.5 h-3.5" aria-hidden="true" /> It joins your pipeline when you start qualifying it.
        </p>
      )}
    </section>
  )
}
