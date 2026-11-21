// =============================================================
// The step guide, shown on every step's page: which step this bid is on (and
// where that is in the journey), one simple line on what finishing it means,
// and a button that finishes it. When the step is done on the page the person
// is already on, that button scrolls there and a second one opens the step
// after it; otherwise the one button goes to where the step is done.
// Data: GET /api/opportunities/:id/journey (backend services/opportunityJourney.ts).
// =============================================================
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Check, Compass, Loader } from 'lucide-react'
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
  /**
   * The step's own action, when this page can do it in one click (e.g. submit
   * the price for review, approve it). The button runs it; then, if what comes
   * next is on another page, the card takes the person there.
   */
  doHere?: { label: string; run: () => Promise<unknown> } | null
}

export function NextStepCard({ opportunityId, clientCompanyId = null, watch, isHere, hereLabel = 'Do it here', onHere, doHere }: Props) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
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
  // The "Next step" button shows only when this step is done on this page.
  const showsThen = !!j.then && (!action || actionHere) && !!thenAction && !here(thenAction.to)
  // An "Also" link to the page "Next step" already opens would only repeat it.
  const alsoRepeats = !!j.also && showsThen && j.also.action.to === thenAction?.to
  /** Runs this page's action; `moveOn` then goes to the step left to do when it's on another page. */
  const runHere = async (moveOn = true) => {
    if (!doHere) return
    setBusy(true)
    try {
      await doHere.run()
      const after = (await refetch()).data?.data
      const go = after?.current?.action
      if (moveOn && go && !here(go.to)) navigate(go.to)
    } catch {
      // The page's own action reports its error.
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card" aria-labelledby="next-step-heading">
      <div className="flex flex-wrap items-center gap-2.5 mb-3">
        <span className="tile tile-sm"><Compass className="w-4 h-4" /></span>
        <h2 id="next-step-heading" className="font-semibold text-gray-100 text-base">
          {c ? <>Step {c.number} of {c.of}: {c.step}</> : 'What to do next'}
        </h2>
        {c && (
          <div className="ml-auto flex items-center gap-1" aria-hidden="true">
            {Array.from({ length: c.of }, (_, i) => (
              <span key={i} className="h-1.5 w-5 rounded-full" style={{ background: i < c.number - 1 ? 'var(--text)' : i === c.number - 1 ? 'var(--accent)' : 'var(--line-strong)' }} />
            ))}
          </div>
        )}
      </div>

      <p className="text-sm text-gray-100">{c ? c.what : j.next ? j.next.text : 'Nothing left to do.'}</p>

      <div className="flex flex-wrap items-center gap-2 mt-4">
        {action && (actionHere
          ? (doHere
            ? <button type="button" onClick={() => void runHere(true)} disabled={busy} className="btn-primary flex items-center gap-1.5 disabled:opacity-60">{busy ? <Loader className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />} {doHere.label}</button>
            : onHere && <button type="button" onClick={onHere} className="btn-primary flex items-center gap-1.5">{actionLabel}</button>)
          : <Link to={action.to} className="btn-primary flex items-center gap-1.5">{actionLabel}</Link>)}
        {/* The step after only when this step is done on this page; when it is done
            elsewhere, its own button is the one way forward. */}
        {j.then && (!action || actionHere) && (thenAction && !here(thenAction.to)
          ? <Link to={thenAction.to} className="btn-secondary flex items-center gap-1.5">Next step: {j.then.step}</Link>
          : <span className="text-xs text-gray-500">Then: {j.then.step}{thenAction ? ' (this page)' : ''}</span>)}
      </div>

      {/* Work that can go on alongside the step (e.g. pricing while writing): a
          link to its page, or, on that page, its own button. */}
      {j.also && !alsoHere && !alsoRepeats && <p className="text-xs text-gray-400 mt-3">Also: {j.also.text} <Link to={j.also.action.to} className="v2-link !text-xs whitespace-nowrap">{j.also.action.label}</Link></p>}
      {j.also && alsoHere && !actionHere && (doHere || onHere) && (
        <div className="mt-4 pt-3 flex flex-wrap items-center gap-2" style={{ borderTop: '1px solid var(--line)' }}>
          <p className="text-sm text-gray-200 w-full">On this page: {j.also.text}</p>
          {doHere
            ? <button type="button" onClick={() => void runHere(false)} disabled={busy} className="btn-primary btn-sm flex items-center gap-1.5 disabled:opacity-60">{busy ? <Loader className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />} {doHere.label}</button>
            : <button type="button" onClick={onHere} className="btn-secondary btn-sm flex items-center gap-1.5">{j.also.action.label}</button>}
        </div>
      )}
      {j.warning && (
        <p className="text-xs mt-3 flex items-center gap-1.5" style={{ color: 'var(--danger)' }}>
          <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" /> {j.warning}
        </p>
      )}
    </section>
  )
}
