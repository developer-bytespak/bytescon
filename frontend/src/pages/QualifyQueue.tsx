// =============================================================
// To qualify — open notices the bidding company hasn't decided on yet, best
// fit first, so a person can go through them quickly:
//   Qualify   open the notice at its qualify panel
//   No-bid    pass with a reason, without scoring every criterion
//   Watch     star it (pinned in the sidebar) to come back to
// Keyboard, on a notice title: ↑/↓ or j/k move, Enter or q opens, n passes, w stars.
// Plus "why we pass": the decisions and no-bid reasons of the last 90 days.
// Data: GET /api/qualification/queue and /insights (backend services/qualificationQueue.ts).
// =============================================================
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ListChecks, Star } from 'lucide-react'
import { clientsApi, qualificationApi } from '../services/api'
import { useAuth, useIsContractor } from '../hooks/useAuth'
import { useFavorites } from '../hooks/useFavorites'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import { label, recTone, type NoBidReason } from '../components/qualify/QualifyScorecard'

interface QueueItem {
  opportunityId: string; title: string; agency: string; naicsCode: string | null; setAsideType: string | null
  responseDeadline: string; daysLeft: number; estimatedValue: number | null; pursuitId: string | null; pipelineStage: string | null
  winProbability: number | null
  readiness: { verdict: 'READY' | 'FIX_FIRST' | 'NOT_ELIGIBLE'; problems: string[] }
  scorecard: { status: string; finalDecision: string | null; totalScore: number; recommendation: string | null; noBidReason: string | null } | null
}
interface Insights { days: number; decided: number; byDecision: Record<string, number>; noBidReasons: { reason: string; label: string; count: number }[]; quickNoBids: number }
interface ClientOption { id: string; name: string; isSelf?: boolean; isActive?: boolean }

const VERDICT = {
  READY: { text: 'Ready to bid', chip: 'chip-success' },
  FIX_FIRST: { text: 'Fix first', chip: 'chip-gold' },
  NOT_ELIGIBLE: { text: 'Not eligible', chip: 'chip-danger' },
} as const
const money = (n: number | null) => (n == null ? null : `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
const errorText = (e: unknown) => (e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Something went wrong'

export function QualifyQueuePage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const isContractor = useIsContractor()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { toast } = useToast()
  const { isFavorite, toggleFavorite } = useFavorites()

  const clientsQuery = useQuery({ queryKey: ['clients-list'], queryFn: () => clientsApi.list({ limit: 200 }), enabled: !isContractor })
  const clients = useMemo<ClientOption[]>(() => ((clientsQuery.data?.data ?? []) as ClientOption[]).filter((c) => !c.isSelf && c.isActive !== false), [clientsQuery.data])
  const [clientId, setClientId] = useState<string | null>(null)
  useEffect(() => { if (!isContractor && !clientId && clients.length > 0) setClientId(clients[0].id) }, [isContractor, clientId, clients])
  const forClient = isContractor ? null : clientId

  const [sort, setSort] = useState<'fit' | 'deadline'>('fit')
  const [includeDecided, setIncludeDecided] = useState(false)
  const ready = isContractor || !!clientId
  const queue = useQuery<{ data: { items: QueueItem[]; noBidReasons: NoBidReason[] } }>({
    queryKey: ['qualify-queue', forClient, sort, includeDecided],
    queryFn: () => qualificationApi.queue({ clientCompanyId: forClient, sort, includeDecided, limit: 100 }),
    enabled: ready,
  })
  const insights = useQuery<{ data: Insights }>({
    queryKey: ['qualify-insights', forClient],
    queryFn: () => qualificationApi.insights({ days: 90, clientCompanyId: forClient }),
    enabled: ready,
  })
  const items = queue.data?.data.items ?? []
  const reasons = queue.data?.data.noBidReasons ?? []

  // The no-bid form open on one row.
  const [passing, setPassing] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const openPass = (id: string) => { setPassing(id); setReason(''); setNote('') }
  const pass = useMutation({
    mutationFn: (opportunityId: string) => qualificationApi.quickNoBid(opportunityId, { reason, note: note.trim() || undefined }, forClient),
    onSuccess: () => {
      setPassing(null)
      void qc.invalidateQueries({ queryKey: ['qualify-queue'] })
      void qc.invalidateQueries({ queryKey: ['qualify-insights'] })
      void qc.invalidateQueries({ queryKey: ['qualification'] })
      toast('Marked as no-bid', 'success')
    },
    onError: (e) => toast(errorText(e), 'error'),
  })

  const openHref = (i: QueueItem) => `/opportunities/${i.opportunityId}${forClient ? `?client=${forClient}` : ''}#qualify`
  const watch = (i: QueueItem) => {
    toggleFavorite({ id: i.opportunityId, title: i.title, agency: i.agency, deadline: i.responseDeadline, naicsCode: i.naicsCode ?? undefined })
  }

  // Keyboard, on each row's title link: move between rows and act on one.
  // Enter follows the link as usual.
  const titleRefs = useRef<Array<HTMLAnchorElement | null>>([])
  const onTitleKey = (e: KeyboardEvent<HTMLAnchorElement>, index: number, item: QueueItem) => {
    const move = (to: number) => { e.preventDefault(); titleRefs.current[Math.max(0, Math.min(items.length - 1, to))]?.focus() }
    if (e.key === 'ArrowDown' || e.key === 'j') move(index + 1)
    else if (e.key === 'ArrowUp' || e.key === 'k') move(index - 1)
    else if (e.key === 'q') { e.preventDefault(); navigate(openHref(item)) }
    else if (e.key === 'n' && isAdmin && !item.scorecard?.finalDecision) { e.preventDefault(); openPass(item.opportunityId) }
    else if (e.key === 'w') { e.preventDefault(); watch(item) }
  }
  // Opening a no-bid form moves focus to its reason picker.
  const reasonRef = useRef<HTMLSelectElement | null>(null)
  useEffect(() => { if (passing) reasonRef.current?.focus() }, [passing])

  const ins = insights.data?.data
  const topReason = ins?.noBidReasons[0]

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <PageHeader title="To qualify" subtitle="Open notices you haven't decided on yet. Bid, pass, or look closer — one after another." icon={<ListChecks />} />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        {!isContractor && clients.length > 0 && (
          <label className="text-xs text-gray-500 flex items-center gap-2">Client
            <select className="input !py-1 !text-sm !w-auto" value={clientId ?? ''} onChange={(e) => setClientId(e.target.value || null)}>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <div className="flex gap-1" role="group" aria-label="Sort">
          {(['fit', 'deadline'] as const).map((s) => (
            <button key={s} type="button" aria-pressed={sort === s} onClick={() => setSort(s)} className={sort === s ? 'chip chip-accent !px-3 !py-1' : 'btn-secondary btn-sm'}>
              {s === 'fit' ? 'Best fit first' : 'Deadline first'}
            </button>
          ))}
        </div>
        <label className="text-xs text-gray-500 flex items-center gap-1.5 cursor-pointer"><input type="checkbox" checked={includeDecided} onChange={(e) => setIncludeDecided(e.target.checked)} /> Show decided</label>
        <span className="text-[11px] text-gray-500 ml-auto hidden md:inline">On a notice title: ↑↓ move · Enter open · n no-bid · w watch</span>
      </div>

      {ins && ins.decided > 0 && (
        <section className="card !py-3" aria-label="Why we pass">
          <p className="text-xs text-gray-400">
            Last {ins.days} days: <strong className="text-gray-200">{ins.decided}</strong> decided
            {' '}({ins.byDecision.BID ?? 0} bid, {ins.byDecision.NO_BID ?? 0} no-bid{ins.byDecision.CONDITIONAL ? `, ${ins.byDecision.CONDITIONAL} conditional` : ''}).
            {topReason && <> Most common reason to pass: <strong className="text-gray-200">{topReason.label}</strong> ({topReason.count}).</>}
          </p>
          {ins.noBidReasons.length > 1 && (
            <ul className="mt-2 space-y-1">
              {ins.noBidReasons.map((r) => {
                const max = ins.noBidReasons[0].count
                return (
                  <li key={r.reason} className="flex items-center gap-2 text-[11px] text-gray-400">
                    <span className="w-56 truncate">{r.label}</span>
                    <span className="h-1.5 rounded-full" style={{ width: `${Math.max(6, (r.count / max) * 160)}px`, background: 'var(--accent)' }} aria-hidden="true" />
                    <span className="tabular-nums">{r.count}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {!isContractor && clientsQuery.isSuccess && clients.length === 0 ? (
        <p className="text-sm text-gray-400">Add a client first: notices are qualified for each client. <Link to="/clients" className="text-blue-400 hover:text-blue-300">Go to Clients →</Link></p>
      ) : queue.isLoading ? (
        <p className="text-sm text-gray-500">Loading notices…</p>
      ) : queue.isError ? (
        <p className="text-sm text-red-400">{errorText(queue.error)}</p>
      ) : items.length === 0 ? (
        <p className="card text-sm text-gray-400">Nothing waiting. Every open notice has a decision. New notices appear here after the next sync.</p>
      ) : (
        <ul className="space-y-2" aria-label="Notices to qualify">
          {items.map((i, index) => {
            const verdict = VERDICT[i.readiness.verdict]
            const pct = i.winProbability == null ? null : Math.round(i.winProbability * 100)
            const decided = i.scorecard?.finalDecision
            return (
              <li key={i.opportunityId} className="card !p-3 focus-within:ring-1 focus-within:ring-blue-500/60">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Link to={openHref(i)} ref={(el) => { titleRefs.current[index] = el }} onKeyDown={(e) => onTitleKey(e, index, i)}
                      className="text-sm font-medium text-gray-100 hover:text-blue-300">{i.title}</Link>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[i.agency, i.naicsCode && `NAICS ${i.naicsCode}`, i.setAsideType && i.setAsideType !== 'NONE' && i.setAsideType, money(i.estimatedValue)].filter(Boolean).join(' · ')}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 mt-2">
                      <span className={`chip ${i.daysLeft <= 7 ? 'chip-danger' : i.daysLeft <= 14 ? 'chip-gold' : 'chip-neutral'}`}>{i.daysLeft} day{i.daysLeft === 1 ? '' : 's'} left</span>
                      <span className={`chip ${verdict.chip}`} title={i.readiness.problems.length ? `Problems: ${i.readiness.problems.join(', ')}` : undefined}>{verdict.text}</span>
                      <span className="chip chip-neutral">{pct == null ? 'Not scored yet' : `AI ${pct}%`}</span>
                      {i.scorecard && <span className={`chip ${recTone[decided ?? i.scorecard.status] ?? 'chip-neutral'}`}>{decided ? `Decided: ${label(decided)}` : `Scorecard ${i.scorecard.totalScore}/100`}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Link to={openHref(i)} className="btn-primary btn-sm">Qualify</Link>
                    {isAdmin && !decided && <button type="button" onClick={() => openPass(i.opportunityId)} className="btn-secondary btn-sm">No-bid</button>}
                    <button type="button" onClick={() => watch(i)} aria-pressed={isFavorite(i.opportunityId)} title={isFavorite(i.opportunityId) ? 'Stop watching' : 'Watch (pin in the sidebar)'}
                      className="btn-secondary btn-sm" aria-label={isFavorite(i.opportunityId) ? `Stop watching ${i.title}` : `Watch ${i.title}`}>
                      <Star className={`w-3.5 h-3.5 ${isFavorite(i.opportunityId) ? 'fill-current text-amber-400' : ''}`} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {passing === i.opportunityId && (
                  <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] items-end" onSubmit={(e) => { e.preventDefault(); if (reason) pass.mutate(i.opportunityId) }}>
                    <label className="text-[11px] text-gray-400">Why not bid?
                      <select ref={reasonRef} value={reason} onChange={(e) => setReason(e.target.value)} className="input !py-1.5 !text-xs mt-1 w-full" required>
                        <option value="">Choose a reason…</option>
                        {reasons.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                      </select>
                    </label>
                    <label className="text-[11px] text-gray-400">Note (optional)
                      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} className="input !py-1.5 !text-xs mt-1 w-full" />
                    </label>
                    <button type="submit" disabled={!reason || pass.isPending} className="btn-danger btn-sm disabled:opacity-50">{pass.isPending ? 'Saving…' : 'Confirm no-bid'}</button>
                    <button type="button" onClick={() => setPassing(null)} className="btn-secondary btn-sm">Cancel</button>
                  </form>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export default QualifyQueuePage
