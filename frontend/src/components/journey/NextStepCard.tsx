// =============================================================
// "What to do next": shown on every step's page, so whoever finishes a step is
// told what comes next and gets a button that takes them there. When the next
// step is done on the page they are already on, the button scrolls to it.
// Data: GET /api/opportunities/:id/journey (backend services/opportunityJourney.ts).
// =============================================================
import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Compass } from 'lucide-react'
import { opportunitiesApi } from '../../services/api'
import { journeyKey, type Journey } from '../../hooks/journey'

interface Props {
  opportunityId: string
  clientCompanyId?: string | null
  /** Changes whenever the page's own data changes (e.g. a query's dataUpdatedAt), so the advice stays current. */
  watch?: unknown
  /** Whether a link points at the page this card is on (then the button goes to the step here). */
  isHere?: (to: string) => boolean
  /** Button text and action when the next step is on this page. */
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
  const nextHere = !!j.next?.action && here(j.next.action.to)
  const alsoHere = !!j.also && here(j.also.action.to)

  return (
    <section className="card !border-blue-500/40" aria-labelledby="next-step-heading">
      <div className="flex items-center gap-2.5 mb-3"><span className="tile tile-sm tile-accent"><Compass className="w-4 h-4" /></span><h2 id="next-step-heading" className="font-semibold text-gray-200 text-sm">What to do next</h2></div>
      <p className="text-xs text-gray-500">Now: {j.status.text}</p>
      <p className="text-sm text-gray-200 mt-1.5">{j.next ? j.next.text : 'Nothing left to do.'}</p>
      {j.next?.action && (nextHere
        ? (onHere && <button type="button" onClick={onHere} className="btn-primary btn-sm mt-3 flex w-fit items-center gap-1">{hereLabel} <ArrowRight className="w-3.5 h-3.5 -rotate-90" aria-hidden="true" /></button>)
        : <Link to={j.next.action.to} className="btn-primary btn-sm mt-3 flex w-fit items-center gap-1">{j.next.action.label} <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" /></Link>)}
      {j.also && <p className="text-xs text-gray-500 mt-2">Also: {j.also.text}{!alsoHere && <> <Link to={j.also.action.to} className="text-blue-400 hover:text-blue-300 whitespace-nowrap">{j.also.action.label}</Link></>}</p>}    </section>
  )
}
