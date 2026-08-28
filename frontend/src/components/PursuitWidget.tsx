import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { pursuitsApi, clientsApi } from '../services/api'
import { CheckCircle, XCircle, Clock, Trophy, ClipboardCheck } from 'lucide-react'

/**
 * "Pending bid decisions" — the standing dashboard prompt of the bid
 * pursuit tracker. Every solicitation the firm opens becomes a REVIEWING
 * pursuit; the firm declares Submitted / Passed / Later here. Submitted
 * pursuits create a SubmissionRecord whose WON/LOST outcome labels the
 * probability engine's calibration data, and award notices for submitted
 * solicitations surface on top as outcome prompts.
 */
export function PursuitWidget() {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [clientPickerFor, setClientPickerFor] = useState<string | null>(null)
  const [errText, setErrText] = useState('')

  const { data: pursuitsData, isLoading } = useQuery({
    queryKey: ['pursuits', 'REVIEWING'],
    queryFn: () => pursuitsApi.list('REVIEWING'),
    refetchInterval: 300_000,
  })
  const { data: promptsData } = useQuery({
    queryKey: ['pursuit-award-prompts'],
    queryFn: () => pursuitsApi.awardPrompts(),
    refetchInterval: 300_000,
  })
  // Loaded lazily — only when a 'Submitted' declaration needs a client picker.
  const { data: clientsData } = useQuery({
    queryKey: ['clients-list'],
    queryFn: () => clientsApi.list({ limit: 200 }),
    enabled: clientPickerFor !== null,
  })

  const pursuits = (pursuitsData?.data ?? []) as any[]
  const prompts = (promptsData?.data ?? []) as any[]
  const clients = (clientsData?.data ?? []) as any[]

  const updateMut = useMutation({
    mutationFn: ({ id, body }: {
      id: string
      body: { action: 'submitted' | 'passed' | 'snooze'; clientCompanyId?: string; snoozeDays?: number }
    }) => pursuitsApi.update(id, body),
    onSuccess: () => {
      setErrText('')
      setClientPickerFor(null)
      qc.invalidateQueries({ queryKey: ['pursuits', 'REVIEWING'] })
      qc.invalidateQueries({ queryKey: ['pursuit-award-prompts'] })
    },
    onError: (err: any, vars) => {
      if (err?.response?.data?.code === 'CLIENT_REQUIRED') {
        // Firm has several clients — ask which one the bid was for.
        setClientPickerFor(vars.id)
        return
      }
      setErrText(err?.response?.data?.error ?? 'Update failed — try again')
    },
  })

  if (isLoading) return null

  const shown = expanded ? pursuits : pursuits.slice(0, 8)
  const daysLeft = (deadline: string) =>
    Math.ceil((new Date(deadline).getTime() - Date.now()) / 86_400_000)

  return (
    <div
      className="rounded-xl p-5 mb-8"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(6,182,212,0.20)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-amber-400" />
          Pending Bid Decisions
          {pursuits.length > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30">
              {pursuits.length}
            </span>
          )}
        </h3>
        <p className="text-[11px] text-slate-600">Declaring submitted / passed tunes your win-probability scoring</p>
      </div>

      {errText && <p className="text-xs text-red-400 mb-2">{errText}</p>}

      {/* Award prompts — solicitations you bid on that now show an award */}
      {prompts.length > 0 && (
        <div className="space-y-2 mb-3">
          {prompts.map((p) => (
            <div
              key={p.pursuit.id}
              className="flex items-center gap-3 rounded-lg px-3 py-2.5"
              style={{ background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.3)' }}
            >
              <Trophy className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-amber-300">
                  An award was posted for {p.pursuit.opportunity.solicitationNumber} — did you win?
                </p>
                <p className="text-[11px] text-slate-500 truncate">
                  {p.pursuit.opportunity.title}
                  {p.awardNotice?.historicalWinner ? ` · awardee: ${p.awardNotice.historicalWinner}` : ''}
                </p>
              </div>
              <Link to="/submissions" className="text-[11px] font-semibold text-amber-400 hover:text-amber-300 whitespace-nowrap">
                Record outcome →
              </Link>
            </div>
          ))}
        </div>
      )}

      {pursuits.length === 0 && prompts.length === 0 ? (
        <p className="text-xs text-slate-600 py-1">
          No pending bid decisions — open a solicitation to start tracking.
        </p>
      ) : (
        <div className="space-y-1.5">
          {shown.map((p) => {
            const dl = p.opportunity.responseDeadline ? daysLeft(p.opportunity.responseDeadline) : null
            return (
              <div key={p.id} className="rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="flex-1 min-w-[220px]">
                    <Link
                      to={`/opportunities/${p.opportunity.id}`}
                      className="text-xs font-medium text-slate-200 hover:text-amber-400 line-clamp-1"
                    >
                      {p.opportunity.title}
                    </Link>
                    <p className="text-[11px] text-slate-600 truncate">
                      {p.opportunity.agency}
                      {dl != null && (
                        <span className={`ml-2 font-semibold ${dl <= 7 ? 'text-red-400' : 'text-slate-500'}`}>
                          {dl <= 0 ? 'deadline passed' : `${dl}d left`}
                        </span>
                      )}
                      <span className="ml-2 text-amber-500/80 font-semibold">
                        {Math.round((p.opportunity.probabilityScore ?? 0) * 100)}% win
                      </span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => updateMut.mutate({ id: p.id, body: { action: 'submitted' } })}
                      disabled={updateMut.isPending}
                      className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all disabled:opacity-50"
                    >
                      <CheckCircle className="w-3 h-3" /> Submitted
                    </button>
                    <button
                      onClick={() => updateMut.mutate({ id: p.id, body: { action: 'passed' } })}
                      disabled={updateMut.isPending}
                      className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 transition-all disabled:opacity-50"
                    >
                      <XCircle className="w-3 h-3" /> Passed
                    </button>
                    <button
                      onClick={() => updateMut.mutate({ id: p.id, body: { action: 'snooze' } })}
                      disabled={updateMut.isPending}
                      className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-white/[0.04] border border-white/10 text-slate-500 hover:text-slate-300 transition-all disabled:opacity-50"
                    >
                      <Clock className="w-3 h-3" /> Later
                    </button>
                  </div>
                </div>

                {/* Client picker — shown when 'Submitted' needs to know which client bid */}
                {clientPickerFor === p.id && (
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <span className="text-[11px] text-slate-500">Which client submitted this bid?</span>
                    {clients.map((c: any) => (
                      <button
                        key={c.id}
                        onClick={() => updateMut.mutate({ id: p.id, body: { action: 'submitted', clientCompanyId: c.id } })}
                        disabled={updateMut.isPending}
                        className="text-[11px] font-semibold px-2 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-all disabled:opacity-50"
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {pursuits.length > 8 && (
            <button
              onClick={() => setExpanded((e) => !e)}
              className="text-[11px] text-amber-500 hover:text-amber-400 font-semibold pt-1"
            >
              {expanded ? 'Show fewer' : `View all ${pursuits.length} →`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
