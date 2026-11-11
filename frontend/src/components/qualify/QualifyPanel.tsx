// =============================================================
// Qualify this opportunity — on the opportunity page, where the decision is
// made, instead of only from the pipeline.
//
//   1. Can I bid on this?  the readiness check (BidReadinessCard)
//   2. What we know        the engine's win probability and recommendation
//   3. Scorecard           pre-filled with suggested scores; a person adjusts
//   4. Your decision       Bid / No-bid (with a reason) / Conditional / Defer
//
// A consulting firm qualifies each client separately; a contractor qualifies
// its own company. Reviews, gate approvals and history stay on the full page
// (/pipeline/:id). Data: /api/qualification (backend routes/qualification.ts).
// =============================================================
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, ClipboardList, Target } from 'lucide-react'
import { clientsApi, qualificationApi } from '../../services/api'
import { useAuth, useIsContractor } from '../../hooks/useAuth'
import { useToast } from '../Toast'
import { BidReadinessCard } from '../BidReadinessCard'
import { DecisionPanel, EngineSignals, RecommendationPanel, ScorecardPanel, label, recTone, type ScorecardView } from './QualifyScorecard'

interface ClientOption { id: string; name: string; isSelf?: boolean; isActive?: boolean }

const errorText = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Something went wrong'

export function QualifyPanel({ opportunityId, pursuitId: givenPursuitId, initialClientId }: {
  opportunityId: string
  /** The notice's pursuit, when it already has one (opening a live notice creates it). */
  pursuitId?: string | null
  initialClientId?: string | null
}) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const isContractor = useIsContractor()
  const { toast } = useToast()
  const qc = useQueryClient()

  const clientsQuery = useQuery({ queryKey: ['clients-list'], queryFn: () => clientsApi.list({ limit: 200 }), enabled: !isContractor })
  const clients = useMemo<ClientOption[]>(
    () => ((clientsQuery.data?.data ?? []) as ClientOption[]).filter((c) => !c.isSelf && c.isActive !== false),
    [clientsQuery.data],
  )
  const [clientId, setClientId] = useState<string | null>(initialClientId ?? null)
  useEffect(() => {
    if (!isContractor && !clientId && clients.length > 0) setClientId(clients[0].id)
  }, [isContractor, clientId, clients])
  // A contractor sends no client: the backend uses its own company.
  const forClient = isContractor ? null : clientId

  const [pursuitId, setPursuitId] = useState<string | null>(givenPursuitId ?? null)
  useEffect(() => { if (givenPursuitId) setPursuitId(givenPursuitId) }, [givenPursuitId])

  const ready = !!pursuitId && (isContractor || !!clientId)
  const view = useQuery<{ data: ScorecardView }>({
    queryKey: ['qualification', pursuitId, forClient],
    queryFn: () => qualificationApi.get(pursuitId!, forClient),
    enabled: ready,
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['qualification', pursuitId] })
    void qc.invalidateQueries({ queryKey: ['qualify-queue'] })
  }
  const onError = (e: unknown) => toast(errorText(e), 'error')

  const start = useMutation({
    mutationFn: async () => {
      let id = pursuitId
      if (!id) {
        id = (await qualificationApi.pursuitFor(opportunityId)).data.pursuitId as string
        setPursuitId(id)
      }
      return qualificationApi.start(id, forClient)
    },
    onSuccess: () => { refresh(); toast('Scorecard started with suggested scores. Check each one.', 'success') },
    onError,
  })
  const save = useMutation({ mutationFn: (scores: { key: string; score: number | null; evidence?: string | null }[]) => qualificationApi.saveScorecard(pursuitId!, scores, forClient), onSuccess: () => { refresh(); toast('Scores saved', 'success') }, onError })
  const refreshSuggestions = useMutation({ mutationFn: () => qualificationApi.refreshSuggestions(pursuitId!, forClient), onSuccess: () => { refresh(); toast('Suggestions refreshed', 'success') }, onError })
  const decide = useMutation({ mutationFn: (p: Record<string, unknown>) => qualificationApi.decide(pursuitId!, p, forClient), onSuccess: () => { refresh(); toast('Decision recorded', 'success') }, onError })
  const reassess = useMutation({ mutationFn: () => qualificationApi.reassess(pursuitId!, undefined, forClient), onSuccess: () => { refresh(); toast('Reopened — record a new decision', 'success') }, onError })
  const busy = start.isPending || save.isPending || decide.isPending || reassess.isPending

  const data = view.data?.data
  const fullPage = pursuitId ? `/pipeline/${pursuitId}${forClient ? `?client=${forClient}` : ''}` : null
  const decision = data?.scorecard?.finalDecision ?? null
  const otherClients = (data?.clients ?? []).filter((c) => c.clientCompanyId && c.clientCompanyId !== clientId)

  return (
    <section id="qualify" className="card scroll-mt-20" aria-labelledby="qualify-heading">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <h2 id="qualify-heading" className="text-lg font-semibold text-gray-200 flex items-center gap-2">
          <Target className="w-5 h-5 text-blue-400" aria-hidden="true" /> Qualify this opportunity
        </h2>
        {!isContractor && clients.length > 0 && (
          <label className="ml-auto text-xs text-gray-500 flex items-center gap-2">For client
            <select className="input !py-1 !text-sm !w-auto" value={clientId ?? ''} onChange={(e) => setClientId(e.target.value || null)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {!isContractor && clientsQuery.isSuccess && clients.length === 0 ? (
        <p className="text-sm text-gray-400">Add a client first: qualifying is done for each client. <Link to="/clients" className="text-blue-400 hover:text-blue-300">Go to Clients →</Link></p>
      ) : (
        <div className="space-y-5">
          {otherClients.length > 0 && (
            <p className="text-xs text-gray-500 flex flex-wrap items-center gap-1.5">Other clients on this notice:
              {otherClients.map((c) => (
                <button key={c.clientCompanyId} type="button" onClick={() => setClientId(c.clientCompanyId)} className={`chip ${recTone[c.finalDecision ?? c.status] ?? 'chip-neutral'} cursor-pointer`}>
                  {c.clientName}: {label(c.finalDecision ?? c.status)}
                </button>
              ))}
            </p>
          )}

          <div className="rounded-lg p-4" style={{ border: '1px solid var(--line)' }}>
            <BidReadinessCard opportunityId={opportunityId} clientCompanyId={forClient} embedded />
          </div>

          {data && <EngineSignals signals={data.signals} />}

          {ready && view.isLoading && <p className="text-sm text-gray-500">Loading the scorecard…</p>}
          {view.isError && <p className="text-sm text-red-400">{errorText(view.error)}</p>}

          {(!pursuitId || (data && !data.exists)) && (
            <div className="rounded-lg p-4 text-sm" style={{ border: '1px dashed var(--line-strong)' }}>
              <p className="text-gray-300">Score this opportunity against your criteria. Bytescon fills in suggested scores from your records; you check them and decide.</p>
              {isAdmin
                ? <button type="button" disabled={busy || (!isContractor && !clientId)} onClick={() => start.mutate()} className="btn-primary text-sm mt-3 disabled:opacity-60">{start.isPending ? 'Starting…' : 'Start scorecard'}</button>
                : <p className="text-xs text-gray-500 mt-2">A firm admin starts the scorecard.</p>}
            </div>
          )}

          {data?.exists && data.scorecard && data.computed && (
            <>
              <ScorecardPanel
                key={data.scorecard.criteria.map((c) => `${c.key}:${c.score}:${c.evidence ?? ''}:${c.suggestedScore ?? ''}`).join('|')}
                scorecard={data.scorecard} computed={data.computed} isAdmin={isAdmin} closed={!!data.pursuit.closedAt}
                saving={save.isPending} refreshing={refreshSuggestions.isPending}
                onSave={(s) => save.mutate(s)} onRefresh={() => refreshSuggestions.mutate()} compact
              />
              <RecommendationPanel scorecard={data.scorecard} computed={data.computed} compact />
              <DecisionPanel
                key={`${data.scorecard.id}:${data.scorecard.status}`}
                scorecard={data.scorecard} computed={data.computed} isAdmin={isAdmin} busy={busy} users={[]}
                noBidReasons={data.noBidReasons} onDecide={(p) => decide.mutate(p)} onReassess={() => reassess.mutate()} compact
              />
              {decision === 'BID' && (
                <div className="rounded-lg p-3 flex flex-wrap items-center gap-3 text-sm" style={{ background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
                  <span className="text-gray-200">Bidding. Next steps:</span>
                  <Link to={`/opportunities/${opportunityId}/proposal`} className="btn-primary btn-sm inline-flex items-center gap-1"><ClipboardList className="w-3.5 h-3.5" aria-hidden="true" /> Open the proposal workspace</Link>
                  <Link to="/pipeline" className="text-blue-400 hover:text-blue-300 text-xs">See it in the pipeline (Capture) <ArrowRight className="w-3 h-3 inline" aria-hidden="true" /></Link>
                </div>
              )}
            </>
          )}

          {fullPage && data?.exists && (
            <Link to={fullPage} className="text-xs text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">Reviews, gate approvals and decision history <ArrowRight className="w-3 h-3" aria-hidden="true" /></Link>
          )}
        </div>
      )}
    </section>
  )
}
