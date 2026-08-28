import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { firmApi, pipelineApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader, Spinner, EmptyState, ErrorBanner } from '../components/ui'
import { LayoutGrid, Table as TableIcon, Search, AlertTriangle, ExternalLink } from 'lucide-react'

interface FirmUser { id: string; firstName: string; lastName: string; email: string; role: string }
interface PipelineOpp {
  id: string; title: string; agency: string; responseDeadline: string | null
  solicitationNumber: string | null; estimatedValue: string | null; setAsideType: string
  status: string; isDemo: boolean; sourceUrl: string | null; samNoticeId: string | null
}
interface PipelineOwner { id: string; firstName: string; lastName: string; email: string }
interface BidDecisionRef { decision: string; recommendation: string | null; winProbability: number | null }
interface PipelineItem {
  id: string; pipelineStage: string; priority: string; ownerUserId: string | null
  nextAction: string | null; nextActionDueAt: string | null; notes: string | null
  closedAt: string | null; closeReason: string | null; closeNote: string | null
  isOverdue: boolean; opportunity: PipelineOpp; owner: PipelineOwner | null; bidDecision: BidDecisionRef | null
}

const CLOSE_REASONS = ['WON', 'LOST', 'NO_BID', 'DEFERRED', 'DUPLICATE'] as const
interface PipelineResponse {
  data: { items: PipelineItem[]; page: number; limit: number; total: number; totalPages: number; stageCounts: Record<string, number> }
}

// Board columns — active capture lifecycle. AWARDED/LOST/NO_BID/ARCHIVED are
// terminal outcomes shown in the table (includeArchived) rather than columns.
const BOARD_STAGES = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED'] as const
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const

// Mirrors backend services/pipelineStages.ts — used only to offer valid moves
// in the UI; the server re-validates every transition.
const ALLOWED: Record<string, string[]> = {
  IDENTIFIED: ['QUALIFICATION', 'NO_BID', 'ARCHIVED'],
  QUALIFICATION: ['CAPTURE', 'NO_BID', 'ARCHIVED'],
  CAPTURE: ['PROPOSAL', 'NO_BID', 'ARCHIVED'],
  PROPOSAL: ['SUBMITTED', 'NO_BID', 'ARCHIVED'],
  SUBMITTED: ['AWARDED', 'LOST', 'ARCHIVED'],
  AWARDED: ['ARCHIVED'],
  LOST: ['ARCHIVED'],
  NO_BID: ['QUALIFICATION', 'ARCHIVED'],
  ARCHIVED: ['IDENTIFIED'],
}

const priorityTone: Record<string, string> = {
  LOW: 'bg-blue-950/40 border-blue-800 text-blue-300',
  MEDIUM: 'bg-gray-800 border-gray-700 text-gray-300',
  HIGH: 'bg-orange-950/40 border-orange-800 text-orange-300',
  CRITICAL: 'bg-red-950/40 border-red-800 text-red-300',
}
const decisionTone: Record<string, string> = {
  GO: 'bg-green-950/40 border-green-800 text-green-300',
  NO_GO: 'bg-red-950/40 border-red-800 text-red-300',
  PENDING: 'bg-gray-800 border-gray-700 text-gray-400',
}

const money = (v?: string | null) => (v != null ? `$${Number(v).toLocaleString()}` : '—')
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')

export function PipelinePage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()

  const [view, setView] = useState<'board' | 'table'>('board')
  const [search, setSearch] = useState('')
  const [priority, setPriority] = useState('')
  const [owner, setOwner] = useState('')
  const [includeClosed, setIncludeClosed] = useState(false)
  const [editTarget, setEditTarget] = useState<PipelineItem | null>(null)
  const [closeTarget, setCloseTarget] = useState<PipelineItem | null>(null)

  const pipeline = useQuery<PipelineResponse>({
    queryKey: ['pipeline', search, priority, owner, includeClosed],
    queryFn: () => pipelineApi.list({
      q: search || undefined,
      priority: priority || undefined,
      ownerUserId: owner || undefined,
      includeClosed: includeClosed ? 'true' : undefined,
      includeArchived: includeClosed ? 'true' : undefined,
      limit: 200,
    }),
  })
  const users = useQuery<{ data: FirmUser[] }>({ queryKey: ['firm-users'], queryFn: () => firmApi.users() })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pipeline'] })
  const onError = (e: unknown) =>
    toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Action failed', 'error')

  const stageMut = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: string }) => pipelineApi.setStage(id, stage),
    onSuccess: () => { invalidate(); toast('Stage updated', 'success') },
    onError,
  })
  const assignMut = useMutation({
    mutationFn: ({ id, ownerUserId }: { id: string; ownerUserId: string | null }) => pipelineApi.assign(id, ownerUserId),
    onSuccess: () => { invalidate(); toast('Owner updated', 'success') },
    onError,
  })
  const nextActionMut = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) => pipelineApi.setNextAction(id, payload),
    onSuccess: () => { invalidate(); setEditTarget(null); toast('Pursuit updated', 'success') },
    onError,
  })
  const closeMut = useMutation({
    mutationFn: ({ id, reason, note }: { id: string; reason: string; note?: string }) => pipelineApi.close(id, reason, note),
    onSuccess: () => { invalidate(); setCloseTarget(null); toast('Pursuit closed', 'success') },
    onError,
  })
  const reopenMut = useMutation({
    mutationFn: (id: string) => pipelineApi.reopen(id),
    onSuccess: () => { invalidate(); toast('Pursuit reopened', 'success') },
    onError,
  })

  const busy = stageMut.isPending || assignMut.isPending || nextActionMut.isPending || closeMut.isPending || reopenMut.isPending
  const stageCounts = pipeline.data?.data.stageCounts ?? {}
  const items = pipeline.data?.data.items ?? []

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader title="Pipeline" subtitle="Opportunity capture pipeline — stages, owners & next actions">
        <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg p-0.5">
          <button onClick={() => setView('board')} className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded ${view === 'board' ? 'bg-gray-700 text-gray-100' : 'text-gray-400'}`}><LayoutGrid className="w-3.5 h-3.5" /> Board</button>
          <button onClick={() => setView('table')} className={`flex items-center gap-1 text-xs px-2.5 py-1.5 rounded ${view === 'table' ? 'bg-gray-700 text-gray-100' : 'text-gray-400'}`}><TableIcon className="w-3.5 h-3.5" /> Table</button>
        </div>
      </PageHeader>

      {!isAdmin && (
        <p className="text-xs text-gray-500 mb-3">Your team-member account has read-only access — stage, owner and next-action changes are available to firm admins.</p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title, agency, solicitation" className="w-full bg-gray-800 border border-gray-700 rounded pl-9 pr-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
        </div>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200">
          <option value="">All owners</option>
          <option value="unassigned">Unassigned</option>
          {(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs text-gray-400 px-1">
          <input type="checkbox" checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)} /> Include closed
        </label>
      </div>

      {pipeline.isLoading ? (
        <div className="flex justify-center mt-12"><Spinner size="lg" /></div>
      ) : pipeline.error ? (
        <ErrorBanner message="Could not load the pipeline. Please retry." />
      ) : items.length === 0 ? (
        <EmptyState message="No pursuits in the pipeline yet. Open a live opportunity to start tracking it." />
      ) : view === 'board' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3">
          {BOARD_STAGES.map((stage) => (
            <div key={stage} className="bg-gray-900/40 border border-gray-800 rounded-xl p-2">
              <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-xs font-semibold text-gray-300 tracking-wide">{stage}</span>
                <span className="text-[10px] font-mono text-gray-500">{stageCounts[stage] ?? 0}</span>
              </div>
              <div className="space-y-2">
                {items.filter((i) => i.pipelineStage === stage && !i.closedAt).map((item) => (
                  <PipelineCard key={item.id} item={item} isAdmin={isAdmin} busy={busy}
                    users={users.data?.data ?? []}
                    onStage={(s) => stageMut.mutate({ id: item.id, stage: s })}
                    onAssign={(o) => assignMut.mutate({ id: item.id, ownerUserId: o })}
                    onEdit={() => setEditTarget(item)}
                    onClose={() => setCloseTarget(item)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2.5 px-4">Opportunity</th><th>Agency</th><th>Stage</th><th>Priority</th><th>Owner</th><th>Next action</th><th>Decision</th><th>Value</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-gray-900 hover:bg-gray-900/40 align-top">
                  <td className="py-2.5 px-4">
                    <Link to={`/opportunities/${item.opportunity.id}`} className="text-blue-400 hover:text-blue-300">{item.opportunity.title}</Link>
                    <SourceBadge opp={item.opportunity} />
                    <Link to={`/pipeline/${item.id}`} className="ml-2 text-[11px] text-gray-500 hover:text-blue-300">Qualify →</Link>
                    {isAdmin && !item.closedAt && (
                      <span className="ml-2">
                        <button onClick={() => setEditTarget(item)} className="text-[11px] text-gray-500 hover:text-blue-300">Edit</button>
                        <button onClick={() => setCloseTarget(item)} className="ml-2 text-[11px] text-gray-500 hover:text-red-300">Close</button>
                      </span>
                    )}
                  </td>
                  <td className="text-gray-400">{item.opportunity.agency}</td>
                  <td>
                    {item.closedAt ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] px-1.5 py-0.5 rounded border bg-gray-800 border-gray-700 text-gray-400">Closed · {item.closeReason}</span>
                        {isAdmin && <button disabled={busy} onClick={() => reopenMut.mutate(item.id)} className="text-[11px] text-gray-500 hover:text-green-400 disabled:opacity-50">Reopen</button>}
                      </div>
                    ) : isAdmin ? (
                      <StageSelect stage={item.pipelineStage} busy={busy} onStage={(s) => stageMut.mutate({ id: item.id, stage: s })} />
                    ) : <span className="text-gray-300 text-xs">{item.pipelineStage}</span>}
                  </td>
                  <td><span className={`text-[10px] px-1.5 py-0.5 rounded border ${priorityTone[item.priority]}`}>{item.priority}</span></td>
                  <td className="text-gray-400 text-xs">{item.owner ? `${item.owner.firstName} ${item.owner.lastName}` : <span className="text-gray-600">Unassigned</span>}</td>
                  <td className="text-xs">
                    {item.nextAction ? (
                      <span className={item.isOverdue ? 'text-red-300' : 'text-gray-300'}>
                        {item.isOverdue && <AlertTriangle className="w-3 h-3 inline mr-1" />}{item.nextAction}
                        <span className="block text-gray-500">{fmtDate(item.nextActionDueAt)}</span>
                      </span>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                  <td>{item.bidDecision ? <span className={`text-[10px] px-1.5 py-0.5 rounded border ${decisionTone[item.bidDecision.decision] ?? decisionTone.PENDING}`}>{item.bidDecision.decision}</span> : <span className="text-gray-600 text-xs">—</span>}</td>
                  <td className="text-gray-400 text-xs">{money(item.opportunity.estimatedValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editTarget && (
        <PursuitEditModal
          item={editTarget}
          saving={nextActionMut.isPending}
          onSave={(p) => nextActionMut.mutate({ id: editTarget.id, payload: p })}
          onClose={() => setEditTarget(null)}
        />
      )}
      {closeTarget && (
        <ClosePursuitModal
          item={closeTarget}
          saving={closeMut.isPending}
          onConfirm={(reason, note) => closeMut.mutate({ id: closeTarget.id, reason, note })}
          onCancel={() => setCloseTarget(null)}
        />
      )}
    </div>
  )
}

// Full pursuit-edit modal — priority, next action, due date and notes in one place.
function PursuitEditModal({ item, saving, onSave, onClose }: {
  item: PipelineItem; saving: boolean; onSave: (p: Record<string, unknown>) => void; onClose: () => void
}) {
  const [prio, setPrio] = useState(item.priority)
  const [na, setNa] = useState(item.nextAction ?? '')
  const [due, setDue] = useState(item.nextActionDueAt ? item.nextActionDueAt.slice(0, 10) : '')
  const [notes, setNotes] = useState(item.notes ?? '')
  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={onClose}>
      <div className="rounded-xl p-6 w-full max-w-lg bg-gray-900 border border-gray-800" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-100">Edit pursuit</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300">✕</button>
        </div>
        <p className="text-xs text-gray-500 mb-4 truncate">{item.opportunity.title}</p>
        <div className="space-y-3">
          <label className="text-xs text-gray-500 block">Priority
            <select value={prio} onChange={(e) => setPrio(e.target.value)} className={`mt-1 ${inputCls}`}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-500 block">Next action
            <input value={na} onChange={(e) => setNa(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="e.g. Draft capture plan" />
          </label>
          <label className="text-xs text-gray-500 block">Next-action due date
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`mt-1 ${inputCls}`} />
          </label>
          <label className="text-xs text-gray-500 block">Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`mt-1 ${inputCls}`} />
          </label>
        </div>
        <div className="flex gap-2 mt-5">
          <button disabled={saving} onClick={() => onSave({ priority: prio, nextAction: na.trim() ? na.trim() : null, nextActionDueAt: due ? new Date(due).toISOString() : null, notes: notes.trim() ? notes.trim() : null })} className="btn-primary text-sm disabled:opacity-60">{saving ? 'Saving…' : 'Save changes'}</button>
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Close pursuit — requires a reason (WON/LOST/NO_BID/DEFERRED/DUPLICATE) + optional note.
function ClosePursuitModal({ item, saving, onConfirm, onCancel }: {
  item: PipelineItem; saving: boolean; onConfirm: (reason: string, note?: string) => void; onCancel: () => void
}) {
  const [reason, setReason] = useState<string>('WON')
  const [note, setNote] = useState('')
  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500'
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }} onClick={onCancel}>
      <div className="rounded-xl p-6 w-full max-w-md bg-gray-900 border border-gray-800" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-gray-100 mb-1">Close pursuit?</h2>
        <p className="text-xs text-gray-500 mb-4 truncate">{item.opportunity.title}</p>
        <label className="text-xs text-gray-500 block">Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={`mt-1 ${inputCls}`}>
            {CLOSE_REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
        <label className="text-xs text-gray-500 block mt-3">Note (optional)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`mt-1 ${inputCls}`} />
        </label>
        <div className="flex gap-2 mt-5">
          <button disabled={saving} onClick={() => onConfirm(reason, note.trim() || undefined)} className="bg-red-900/40 hover:bg-red-900/60 text-red-200 border border-red-700 text-sm px-4 py-2 rounded-lg disabled:opacity-60">{saving ? 'Closing…' : 'Close pursuit'}</button>
          <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function SourceBadge({ opp }: { opp: PipelineOpp }) {
  if (opp.isDemo) return <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded border bg-yellow-950/40 border-yellow-800 text-yellow-300">DEMO</span>
  // Only render a government link when a real source identifier exists.
  if (opp.sourceUrl) return <a href={opp.sourceUrl} target="_blank" rel="noopener noreferrer" className="ml-2 text-[9px] px-1.5 py-0.5 rounded border bg-green-950/30 border-green-800 text-green-300 inline-flex items-center gap-0.5">SAM.gov <ExternalLink className="w-2.5 h-2.5" /></a>
  return <span className="ml-2 text-[9px] px-1.5 py-0.5 rounded border bg-gray-800 border-gray-700 text-gray-500">MANUAL</span>
}

function StageSelect({ stage, busy, onStage }: { stage: string; busy: boolean; onStage: (s: string) => void }) {
  const targets = ALLOWED[stage] ?? []
  return (
    <select value="" disabled={busy || targets.length === 0} onChange={(e) => e.target.value && onStage(e.target.value)}
      className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-200 disabled:opacity-50">
      <option value="">{stage} →</option>
      {targets.map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  )
}

function PipelineCard({ item, isAdmin, busy, users, onStage, onAssign, onEdit, onClose }: {
  item: PipelineItem; isAdmin: boolean; busy: boolean; users: FirmUser[]
  onStage: (s: string) => void; onAssign: (o: string | null) => void; onEdit: () => void; onClose: () => void
}) {
  return (
    <div className={`bg-gray-900 border rounded-lg p-2.5 ${item.isOverdue ? 'border-red-800/70' : 'border-gray-800'}`}>
      <div className="flex items-start justify-between gap-2">
        <Link to={`/opportunities/${item.opportunity.id}`} className="text-xs text-gray-200 hover:text-blue-300 font-medium leading-tight">{item.opportunity.title}</Link>
        <span className={`text-[9px] px-1 py-0.5 rounded border flex-shrink-0 ${priorityTone[item.priority]}`}>{item.priority}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
        <span className="text-[10px] text-gray-500">{item.opportunity.agency}</span>
        <SourceBadge opp={item.opportunity} />
        {item.bidDecision && <span className={`text-[9px] px-1 py-0.5 rounded border ${decisionTone[item.bidDecision.decision] ?? decisionTone.PENDING}`}>{item.bidDecision.decision}</span>}
      </div>
      <div className="mt-1.5 text-[10px] text-gray-500 flex items-center justify-between gap-2">
        <span>Due {fmtDate(item.opportunity.responseDeadline)} · Owner {item.owner ? `${item.owner.firstName} ${item.owner.lastName}` : 'unassigned'}</span>
        <Link to={`/pipeline/${item.id}`} className="text-blue-400 hover:text-blue-300 flex-shrink-0">Qualify →</Link>
      </div>
      {item.nextAction && (
        <div className={`mt-1 text-[10px] ${item.isOverdue ? 'text-red-300' : 'text-gray-400'}`}>
          {item.isOverdue && <AlertTriangle className="w-2.5 h-2.5 inline mr-0.5" />}{item.nextAction} · {fmtDate(item.nextActionDueAt)}
        </div>
      )}

      {isAdmin && (
        <div className="mt-2 pt-2 border-t border-gray-800 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <StageSelect stage={item.pipelineStage} busy={busy} onStage={onStage} />
            <select value={item.ownerUserId ?? ''} disabled={busy} onChange={(e) => onAssign(e.target.value || null)}
              className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[11px] text-gray-200 flex-1">
              <option value="">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={onEdit} className="text-[10px] text-gray-500 hover:text-blue-300">Edit</button>
            <button onClick={onClose} className="text-[10px] text-gray-500 hover:text-red-300">Close pursuit</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default PipelinePage
