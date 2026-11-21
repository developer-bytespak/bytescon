import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { firmApi, pipelineApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader, Spinner, EmptyState, ErrorBanner } from '../components/ui'
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion'
import { LayoutGrid, Table as TableIcon, Search, AlertTriangle, ExternalLink, X } from 'lucide-react'
import { ASSIGN } from '../components/AssignPicker'
import { humanize } from '../lib/humanize'

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

// Stages move forward by the work itself (decision, proposal, submission,
// outcome); closing only ends a bid early, so it never skips a step.
const CLOSE_REASONS = ['NO_BID', 'DEFERRED', 'DUPLICATE'] as const
interface PipelineResponse {
  data: { items: PipelineItem[]; page: number; limit: number; total: number; totalPages: number; stageCounts: Record<string, number> }
}

// Board columns — active capture lifecycle. AWARDED/LOST/NO_BID/ARCHIVED are
// terminal outcomes shown in the table (includeArchived) rather than columns.
const BOARD_STAGES = ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL', 'SUBMITTED'] as const
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const


const priorityTone: Record<string, string> = {
  LOW: 'chip-neutral',
  MEDIUM: 'chip-neutral',
  HIGH: 'badge-yellow',
  CRITICAL: 'chip-danger',
}
// Stage and decision words as people say them, not the API's enum values.
const STAGE_LABEL: Record<string, string> = { IDENTIFIED: 'Identified', QUALIFICATION: 'Qualification', CAPTURE: 'Capture', PROPOSAL: 'Proposal', SUBMITTED: 'Submitted' }
const stageLabel = (s: string) => STAGE_LABEL[s] ?? humanize(s)
const DECISION_LABEL: Record<string, string> = { GO: 'Go', NO_GO: 'No-go', PENDING: 'Pending' }
const decisionTone: Record<string, string> = {
  GO: 'chip-success',
  NO_GO: 'chip-danger',
  PENDING: 'chip-neutral',
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

  const busy = assignMut.isPending || nextActionMut.isPending || closeMut.isPending || reopenMut.isPending
  const stageCounts = pipeline.data?.data.stageCounts ?? {}
  const items = pipeline.data?.data.items ?? []

  return (
    <div className="max-w-7xl mx-auto">
      <PageHeader title="Pipeline" subtitle="Every bid you are pursuing, by stage, with its owner and next action.">
        <div className="segmented">
          <button onClick={() => setView('board')} data-active={view === 'board'} className="flex items-center gap-1.5">{view === 'board' && <motion.span layoutId="pipeline-view" className="segmented-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}<LayoutGrid className="w-3.5 h-3.5" /> Board</button>
          <button onClick={() => setView('table')} data-active={view === 'table'} className="flex items-center gap-1.5">{view === 'table' && <motion.span layoutId="pipeline-view" className="segmented-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}<TableIcon className="w-3.5 h-3.5" /> Table</button>
        </div>
      </PageHeader>

      {!isAdmin && (
        <p className="panel text-xs text-gray-500 px-3 py-2 mb-4">Your team-member account has read-only access. Stage, owner and next-action changes are available to firm admins.</p>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <div className="relative flex-1 min-w-[min(100%,220px)]">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title, agency, solicitation" className="input pl-9" />
        </div>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} className="input w-auto">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
        </select>
        <select value={owner} onChange={(e) => setOwner(e.target.value)} className="input w-auto">
          <option value="">All owners</option>
          <option value="unassigned">Unassigned</option>
          {(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
        </select>
        <label className="flex items-center gap-2 text-xs text-gray-400 px-1 cursor-pointer select-none">
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
        <LayoutGroup id="pipeline-board">
          {/* Columns keep a 220px floor and the board scrolls sideways, so cards stay readable on narrower screens. */}
          <div data-tour="pipeline-board" className="grid grid-cols-1 md:grid-cols-none md:grid-flow-col md:auto-cols-[minmax(220px,1fr)] md:overflow-x-auto md:pb-2 gap-4 items-start">
            {BOARD_STAGES.map((stage) => (
              <section key={stage} aria-label={stageLabel(stage)} className="pipeline-col p-2.5 min-w-0">
                <div className="flex items-center justify-between gap-2 px-1.5 pt-1 pb-2.5">
                  <h2 className="text-[15px] font-semibold truncate" style={{ color: 'var(--text)' }}>{stageLabel(stage)}</h2>
                  <span className="text-[13px] tabular-nums" style={{ color: 'var(--text-muted)' }}>{stageCounts[stage] ?? 0}</span>
                </div>
                <div className="space-y-2 min-h-[3rem]">
                  <AnimatePresence initial={false}>
                    {items.filter((i) => i.pipelineStage === stage && !i.closedAt).map((item) => (
                      <motion.div
                        key={item.id}
                        layout
                        layoutId={`pursuit-${item.id}`}
                        initial={{ opacity: 0, scale: 0.97 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.97 }}
                        transition={{ type: 'spring', stiffness: 420, damping: 38 }}
                      >
                        <PipelineCard item={item} isAdmin={isAdmin} busy={busy}
                          users={users.data?.data ?? []}
                          onAssign={(o) => assignMut.mutate({ id: item.id, ownerUserId: o })}
                          onEdit={() => setEditTarget(item)}
                          onClose={() => setCloseTarget(item)} />
                      </motion.div>
                    ))}
                  </AnimatePresence>
                </div>
              </section>
            ))}
          </div>
        </LayoutGroup>
      ) : (
        <div className="table-wrap animate-fade-in">
          <table className="data-table">
            <thead><tr><th>Opportunity</th><th>Agency</th><th>Stage</th><th>Priority</th><th>Owner</th><th>Next action</th><th>Decision</th><th className="!text-right">Value</th></tr></thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="align-top">
                  <td className="min-w-[16rem]">
                    <Link to={`/opportunities/${item.opportunity.id}/continue`} title="Open where this bid's current step is done" className="font-medium text-gray-100 hover:underline underline-offset-2">{item.opportunity.title}</Link>
                    <SourceBadge opp={item.opportunity} />
                    {isAdmin && !item.closedAt && (
                      <span className="ml-2">
                        <button onClick={() => setEditTarget(item)} className="text-xs text-gray-400 hover:text-gray-100 underline-offset-2 hover:underline">Edit</button>
                        <button onClick={() => setCloseTarget(item)} className="ml-2 text-xs text-gray-400 hover:text-red-400 underline-offset-2 hover:underline">Close</button>
                      </span>
                    )}
                  </td>
                  <td className="text-gray-400">{item.opportunity.agency}</td>
                  <td>
                    {item.closedAt ? (
                      <div className="flex items-center gap-1.5">
                        <span className="chip chip-neutral">Closed · {humanize(item.closeReason)}</span>
                        {isAdmin && <button disabled={busy} onClick={() => reopenMut.mutate(item.id)} className="text-xs text-gray-400 hover:text-gray-100 underline-offset-2 hover:underline disabled:opacity-50">Reopen</button>}
                      </div>
                    ) : <span className="text-gray-300 text-xs">{stageLabel(item.pipelineStage)}</span>}
                  </td>
                  <td><span className={`chip ${priorityTone[item.priority]}`}>{humanize(item.priority)}</span></td>
                  <td className="text-gray-400 text-xs whitespace-nowrap">{item.owner ? `${item.owner.firstName} ${item.owner.lastName}` : <span className="text-gray-600">Unassigned</span>}</td>
                  <td className="text-xs">
                    {item.nextAction ? (
                      <span className={item.isOverdue ? 'text-red-300' : 'text-gray-300'}>
                        {item.isOverdue && <AlertTriangle className="w-3 h-3 inline mr-1" />}{item.nextAction}
                        <span className="block text-gray-500">{fmtDate(item.nextActionDueAt)}</span>
                      </span>
                    ) : <span className="text-gray-600">—</span>}
                  </td>
                  <td>{item.bidDecision ? <span className={`chip ${decisionTone[item.bidDecision.decision] ?? decisionTone.PENDING}`}>{DECISION_LABEL[item.bidDecision.decision] ?? humanize(item.bidDecision.decision)}</span> : <span className="text-gray-600 text-xs">—</span>}</td>
                  <td className="text-gray-300 text-xs text-right tabular-nums whitespace-nowrap">{money(item.opportunity.estimatedValue)}</td>
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
  const inputCls = 'input'
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="modal-panel !p-7 w-full max-w-lg" role="dialog" aria-modal="true" aria-label="Edit pursuit" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="v3-h3 text-gray-100">Edit pursuit</h2>
          <button onClick={onClose} aria-label="Close" className="btn-ghost btn-sm !px-2"><X className="w-4 h-4" /></button>
        </div>
        <p className="text-sm text-gray-400 mb-5 truncate">{item.opportunity.title}</p>
        <div className="space-y-3">
          <label className="label block">Priority
            <select value={prio} onChange={(e) => setPrio(e.target.value)} className={`mt-1 ${inputCls}`}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}
            </select>
          </label>
          <label className="label block">Next action
            <input value={na} onChange={(e) => setNa(e.target.value)} className={`mt-1 ${inputCls}`} placeholder="e.g. Draft capture plan" />
          </label>
          <label className="label block">Next-action due date
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`mt-1 ${inputCls}`} />
          </label>
          <label className="label block">Notes
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={`mt-1 ${inputCls}`} />
          </label>
        </div>
        <div className="flex gap-2 mt-6">
          <button disabled={saving} onClick={() => onSave({ priority: prio, nextAction: na.trim() ? na.trim() : null, nextActionDueAt: due ? new Date(due).toISOString() : null, notes: notes.trim() ? notes.trim() : null })} className="btn-primary disabled:opacity-60">{saving ? 'Saving…' : 'Save changes'}</button>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Close pursuit — stops pursuing a bid early: a reason (No-bid, Deferred,
// Duplicate) + optional note. Won and lost are recorded once the bid is
// submitted (Mark as won / lost on the opportunity page).
function ClosePursuitModal({ item, saving, onConfirm, onCancel }: {
  item: PipelineItem; saving: boolean; onConfirm: (reason: string, note?: string) => void; onCancel: () => void
}) {
  const [reason, setReason] = useState<string>('NO_BID')
  const [note, setNote] = useState('')
  const inputCls = 'input'
  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="modal-panel !p-7 w-full max-w-md" role="dialog" aria-modal="true" aria-label="Close pursuit?" onClick={(e) => e.stopPropagation()}>
        <h2 className="v3-h3 text-gray-100 mb-1">Close pursuit?</h2>
        <p className="text-sm text-gray-400 mb-5 truncate">{item.opportunity.title}</p>
        <label className="label block">Reason
          <select value={reason} onChange={(e) => setReason(e.target.value)} className={`mt-1 ${inputCls}`}>
            {CLOSE_REASONS.map((r) => <option key={r} value={r}>{humanize(r)}</option>)}
          </select>
        </label>
        <label className="label block mt-3">Note (optional)
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`mt-1 ${inputCls}`} />
        </label>
        <div className="flex gap-2 mt-6">
          <button disabled={saving} onClick={() => onConfirm(reason, note.trim() || undefined)} className="btn-danger disabled:opacity-60">{saving ? 'Closing…' : 'Close pursuit'}</button>
          <button onClick={onCancel} className="btn-secondary">Cancel</button>
        </div>
      </div>
    </div>
  )
}

function SourceBadge({ opp }: { opp: PipelineOpp }) {
  if (opp.isDemo) return <span className="chip ml-2">Demo</span>
  // Only render a government link when a real source identifier exists.
  if (opp.sourceUrl) return <a href={opp.sourceUrl} target="_blank" rel="noopener noreferrer" className="chip ml-2 !gap-1 hover:opacity-80">SAM.gov <ExternalLink className="w-3 h-3" /></a>
  return <span className="chip chip-neutral ml-2">Manual</span>
}

function PipelineCard({ item, isAdmin, busy, users, onAssign, onEdit, onClose }: {
  item: PipelineItem; isAdmin: boolean; busy: boolean; users: FirmUser[]
  onAssign: (o: string | null) => void; onEdit: () => void; onClose: () => void
}) {
  return (
    <div className="rounded-2xl p-3.5" style={{ background: 'var(--surface)', boxShadow: item.isOverdue ? 'inset 0 0 0 1px var(--danger-border)' : undefined }}>
      <div className="flex items-start justify-between gap-2">
        <Link to={`/opportunities/${item.opportunity.id}/continue`} title="Open where this bid's current step is done" className="text-[14px] text-gray-100 hover:underline underline-offset-2 font-semibold leading-snug min-w-0 break-words">{item.opportunity.title}</Link>
        <span className={`chip ${priorityTone[item.priority]} flex-shrink-0`}>{humanize(item.priority)}</span>
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        <span className="text-[11px] text-gray-500 min-w-0 truncate">{item.opportunity.agency}</span>
        <SourceBadge opp={item.opportunity} />
        {item.bidDecision && <span className={`chip ${decisionTone[item.bidDecision.decision] ?? decisionTone.PENDING}`}>{DECISION_LABEL[item.bidDecision.decision] ?? humanize(item.bidDecision.decision)}</span>}
      </div>
      <div className="mt-2 text-[11px] text-gray-500 flex items-center justify-between gap-2">
        <span className="tabular-nums min-w-0">Due {fmtDate(item.opportunity.responseDeadline)} · Owner {item.owner ? `${item.owner.firstName} ${item.owner.lastName}` : 'unassigned'}</span>
      </div>
      {item.nextAction && (
        <div className={`mt-1.5 text-[11px] ${item.isOverdue ? 'text-red-400' : 'text-gray-400'}`}>
          {item.isOverdue && <AlertTriangle className="w-2.5 h-2.5 inline mr-0.5" />}{item.nextAction} · {fmtDate(item.nextActionDueAt)}
        </div>
      )}

      {isAdmin && (
        <div className="mt-2.5 pt-2.5 space-y-2" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] text-gray-500" title={ASSIGN.pursuit.hint}>{ASSIGN.pursuit.label} (optional)</span>
            <select value={item.ownerUserId ?? ''} disabled={busy} onChange={(e) => onAssign(e.target.value || null)}
              aria-label={`${ASSIGN.pursuit.label} (optional)`} title={ASSIGN.pursuit.hint}
              className="input !w-full !py-1 !px-2 !text-[11px] !rounded-md min-w-0">
              <option value="">Not assigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={onEdit} className="text-xs font-medium text-gray-400 hover:text-gray-100 underline-offset-2 hover:underline">Edit</button>
            <button onClick={onClose} className="text-xs font-medium text-gray-400 hover:text-red-400 underline-offset-2 hover:underline">Close pursuit</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default PipelinePage
