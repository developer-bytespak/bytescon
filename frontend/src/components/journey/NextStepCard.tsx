// =============================================================
// The step guide, shown on every step's page: which step this bid is on (and
// where that is in the journey), one simple line on what finishing it means,
// a button that finishes it, and a button to the step after it. When the step
// is done on the page the person is already on, its button scrolls there.
// Data: GET /api/opportunities/:id/journey (backend services/opportunityJourney.ts).
// =============================================================
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowRight, ArrowUp, Compass } from 'lucide-react'
import { opportunitiesApi } from '../../services/api'
import { journeyKey, type Journey } from '../../hooks/journey'

interface Props {
  opportunityId: string
  clientCompanyId?: string | null
  /** Changes whenever the page's own data changes (e.g. a query's dataUpdatedAt), so the advice stays current. */
  watch?: unknown
  /** Whether a link points at the page this card is on (then the button goes to the step here). */
  isHere?: (to: string) => boolean
  /** Button text when the step is on this page and the server gives no step guide. */
  hereLabel?: string
  onHere?: () => void
}

export function NextStepCard({ opportunityId, clientCompanyId = null, watch, isHere, hereLabel = 'Do it here', onHere }: Props) {
  const { data, refetch } = useQuery<{ data: Journey }>({
    queryKey: journeyKey(opportunityId, clientCompanyId),
    queryFn: () => opportunitiesApi.journey(opportunityId, clientCompanyId),
  })
  useEffect(() => { if (watch !== undefined) void refetch() }, [watch, refetch])
  if (!data?.data) return null
  const j = data.data
  const here = isHere ?? (() => false)
  const alsoHere = !!j.also && here(j.also.action.to)
  const c = j.current
  // The step to finish: the server's plain-words guide, or (from an older
  // server) the next-step sentence.
  const action = c ? c.action : j.next?.action ?? null
  const actionHere = !!action && here(action.to)
  const actionLabel = c ? action?.label : actionHere ? hereLabel : action?.label
  const thenAction = j.then?.action ?? null

  return (
    <section className="card !border-2 !border-blue-500/50" style={{ background: 'var(--surface-2)' }} aria-labelledby="next-step-heading">
      <div className="flex flex-wrap items-center gap-2.5 mb-3">
        <span className="tile tile-sm tile-accent"><Compass className="w-4 h-4" /></span>
        <h2 id="next-step-heading" className="font-semibold text-gray-100 text-base">
          {c ? <>Step {c.number} of {c.of}: {c.step}</> : 'What to do next'}
        </h2>
        {c && (
          <div className="ml-auto flex items-center gap-1" aria-hidden="true">
            {Array.from({ length: c.of }, (_, i) => (
              <span key={i} className="h-1.5 w-5 rounded-full" style={{ background: i < c.number - 1 ? 'var(--success, #22c55e)' : i === c.number - 1 ? 'var(--accent, #3b82f6)' : 'var(--line-strong)' }} />
            ))}
          </div>
        )}
      </div>

      <p className="text-sm text-gray-100">{c ? c.what : j.next ? j.next.text : 'Nothing left to do.'}</p>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        {action && (actionHere
          ? (onHere && <button type="button" onClick={onHere} className="btn-primary flex items-center gap-1.5">{actionLabel} <ArrowUp className="w-4 h-4" aria-hidden="true" /></button>)
          : <Link to={action.to} className="btn-primary flex items-center gap-1.5">{actionLabel} <ArrowRight className="w-4 h-4" aria-hidden="true" /></Link>)}
        {j.then && (thenAction && !here(thenAction.to)
          ? <Link to={thenAction.to} className="btn-secondary flex items-center gap-1.5">Next step: {j.then.step} <ArrowRight className="w-4 h-4" aria-hidden="true" /></Link>
          : <span className="text-xs text-gray-500">Then: {j.then.step}{thenAction ? ' (this page)' : ''}</span>)}
      </div>

      {j.also && <p className="text-xs text-gray-400 mt-3">Also: {j.also.text}{!alsoHere && <> <Link to={j.also.action.to} className="text-blue-400 hover:text-blue-300 whitespace-nowrap">{j.also.action.label}</Link></>}</p>}
      {j.warning && (
        <p className="text-xs mt-3 flex items-center gap-1.5" style={{ color: 'var(--danger)' }}>
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {j.warning}
        </p>
      )}
    </section>
  )
}
