import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader, Plus, Send, ClipboardCheck, AlertTriangle, CheckCircle2, ShieldAlert, Clock, Paperclip } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../hooks/useBranding'
import { useToast } from '../components/Toast'
import { opportunitiesApi, submissionApi } from '../services/api'

interface Item {
  id: string; title: string; itemType: string; isMandatory: boolean; status: string; isBlocker: boolean; blockerReason: string | null
  validationState: string; validationEvidence: string | null; dueDate: string | null; attachmentName: string | null
}
interface Submission { id: string; title: string; status: string; readinessPercent: number; finalDeadline: string | null; internalDeadline: string | null; confirmationReference: string | null; items: Item[] }
interface Readiness { overallPercent: number; mandatoryPercent: number; canBeReady: boolean; blockerCount: number; incompleteMandatoryCount: number; overdueCount: number; blockingReasons: string[] }

const ITEM_TYPES = ['PROPOSAL_SECTION', 'DOCUMENT', 'FORM', 'CERTIFICATION', 'SIGNATURE', 'ATTACHMENT', 'FILE_VALIDATION', 'SUBMISSION_CONFIRMATION', 'OTHER']
const ITEM_STATUSES = ['PENDING', 'IN_PROGRESS', 'COMPLETE', 'VALIDATED', 'BLOCKED', 'NA']
const STATUS_STYLES: Record<string, string> = {
  NOT_STARTED: 'bg-gray-800 border-gray-700 text-gray-300', IN_PROGRESS: 'bg-blue-950/40 border-blue-800 text-blue-300',
  READY_FOR_REVIEW: 'bg-yellow-950/40 border-yellow-800 text-yellow-300', READY_TO_SUBMIT: 'bg-green-950/40 border-green-800 text-green-300',
  SUBMITTED: 'bg-green-950/40 border-green-800 text-green-300', CONFIRMED: 'bg-green-950/40 border-green-800 text-green-300',
  REJECTED: 'bg-red-950/40 border-red-800 text-red-300', WITHDRAWN: 'bg-gray-900 border-gray-800 text-gray-500', MISSED: 'bg-red-950/40 border-red-800 text-red-300', ARCHIVED: 'bg-gray-900 border-gray-800 text-gray-500',
}
const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

export default function SubmissionWorkspace() {
  const { id: opportunityId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, firm } = useAuth()
  const { branding } = useBranding(firm?.id)
  const { toast } = useToast()
  const qc = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const [newTitle, setNewTitle] = useState('')

  const oppQuery = useQuery({ queryKey: ['opportunity', opportunityId], queryFn: () => opportunitiesApi.getById(opportunityId!), enabled: !!opportunityId })
  const subQuery = useQuery({ queryKey: ['submission', opportunityId], queryFn: () => submissionApi.getWorkspace(opportunityId!), enabled: !!opportunityId })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['submission', opportunityId] })

  const sub: Submission | null = subQuery.data?.data?.exists ? subQuery.data.data.submission : null
  const readiness: Readiness | null = subQuery.data?.data?.readiness ?? null
  const opp = oppQuery.data?.data ?? oppQuery.data
  const gradient = { background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})` }

  const createMutation = useMutation({ mutationFn: () => submissionApi.create(opportunityId!, { title: newTitle.trim() }), onSuccess: () => { setNewTitle(''); invalidate(); toast('Submission created', 'success') }, onError: (e: any) => toast(e?.response?.data?.error || 'Could not create', 'error') })
  const act = (fn: () => Promise<any>, msg: string) => async () => { try { await fn(); invalidate(); toast(msg, 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Action failed', 'error') } }

  if (subQuery.isLoading || oppQuery.isLoading) return <div className="flex justify-center py-24"><Loader className="w-6 h-6 animate-spin text-gray-500" /></div>

  return (
    <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
      <button onClick={() => navigate(`/opportunities/${opportunityId}`)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-300"><ArrowLeft className="w-4 h-4" /> Back to opportunity</button>
      <div className="flex items-start justify-between gap-4">
        <div><p className="text-[10px] tracking-widest uppercase text-gray-500">Submission Management</p><h1 className="text-2xl font-bold text-gray-100">{opp?.title ?? 'Opportunity'}</h1></div>
        {sub && <span className={`text-xs px-2 py-1 rounded border font-mono ${STATUS_STYLES[sub.status]}`}>{sub.status}</span>}
      </div>

      {subQuery.isError && <div className="bg-red-950/30 border border-red-900 rounded-lg p-4 text-sm text-red-300 flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> Could not load submission. <button onClick={() => subQuery.refetch()} className="underline">Retry</button></div>}

      {!sub ? (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center space-y-4">
          <ClipboardCheck className="w-12 h-12 mx-auto text-gray-600" />
          <p className="text-gray-200 font-medium">No submission workspace yet</p>
          {isAdmin ? (
            <div className="max-w-md mx-auto flex gap-2">
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Submission title (e.g. Final RFP Response)" className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
              <button onClick={() => createMutation.mutate()} disabled={!newTitle.trim() || createMutation.isPending} style={gradient} className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg text-gray-900 font-medium disabled:opacity-50">{createMutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create</button>
            </div>
          ) : <p className="text-xs text-gray-600">Read-only access.</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 space-y-4">
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <button onClick={act(() => submissionApi.generateChecklist(sub.id), 'Checklist generated from verified requirements')} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"><ClipboardCheck className="w-3.5 h-3.5" /> Generate checklist</button>
                <AddItemButton submissionId={sub.id} onAdded={invalidate} />
              </div>
            )}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-[10px] tracking-widest uppercase text-gray-500 mb-2">Checklist ({sub.items.length})</p>
              {sub.items.length === 0 ? <p className="text-xs text-gray-600">No items yet. Generate from verified compliance requirements or add manually.</p> : (
                <div className="space-y-2">{sub.items.map((it) => <ChecklistRow key={it.id} item={it} isAdmin={isAdmin} onChanged={invalidate} />)}</div>
              )}
            </div>
          </div>
          <div className="space-y-4">
            <ReadinessCard readiness={readiness} status={sub.status} />
            {isAdmin && <WorkflowCard sub={sub} readiness={readiness} onChanged={invalidate} />}
            <DeadlineCard sub={sub} />
            <HistoryCard submissionId={sub.id} />
          </div>
        </div>
      )}
    </div>
  )
}

function ReadinessCard({ readiness, status }: { readiness: Readiness | null; status: string }) {
  if (!readiness) return null
  // Green "Ready to submit" is withheld until the workspace is actually MARKED
  // ready (or submitted) — not merely eligible. A brand-new submission reads
  // "Not marked ready" instead of falsely showing green at 0% completion.
  const markedReady = ['READY_TO_SUBMIT', 'SUBMITTED', 'CONFIRMED'].includes(status)
  const eligible = readiness.canBeReady
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-[10px] tracking-widest uppercase text-gray-500 mb-2">Readiness</p>
      <div className="flex items-center justify-between text-sm mb-1"><span className="text-gray-400">Overall completion</span><span className="text-gray-200 font-mono">{readiness.overallPercent}%</span></div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden mb-2"><div className={`h-full ${markedReady ? 'bg-green-600' : 'bg-yellow-600'}`} style={{ width: `${readiness.overallPercent}%` }} /></div>
      <div className="flex items-center justify-between text-xs text-gray-500"><span>Mandatory</span><span className="font-mono">{readiness.mandatoryPercent}%</span></div>
      <div className={`mt-2 text-xs flex items-center gap-1.5 ${markedReady ? 'text-green-400' : eligible ? 'text-blue-400' : 'text-yellow-400'}`}>
        {markedReady ? <><CheckCircle2 className="w-3.5 h-3.5" /> Ready to submit</>
          : eligible ? <><ShieldAlert className="w-3.5 h-3.5" /> Eligible — not marked ready</>
          : <><ShieldAlert className="w-3.5 h-3.5" /> Not marked ready</>}
      </div>
      {!eligible && readiness.blockingReasons.length > 0 && <ul className="mt-1 text-[11px] text-gray-500 list-disc pl-4">{readiness.blockingReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
      {!markedReady && eligible && <p className="text-[10px] text-gray-600 mt-1">All mandatory items complete — mark ready below.</p>}
    </div>
  )
}

function WorkflowCard({ sub, onChanged }: { sub: Submission; readiness: Readiness | null; onChanged: () => void }) {
  const { toast } = useToast()
  const markReady = async () => {
    try { await submissionApi.markReady(sub.id); onChanged(); toast('Marked ready', 'success') }
    catch (e: any) {
      if (e?.response?.status === 409) { const reason = prompt(`Not ready. ${e?.response?.data?.error || ''}\nEnter an override reason to force READY_TO_SUBMIT:`); if (reason?.trim()) { await submissionApi.markReady(sub.id, reason.trim()); onChanged(); toast('Marked ready (override recorded)', 'warning') } }
      else toast(e?.response?.data?.error || 'Failed', 'error')
    }
  }
  const doSubmit = async () => {
    const ref = prompt('Confirmation/receipt reference (optional):') ?? ''
    const method = prompt('Submission method (EMAIL/PORTAL/PHYSICAL/SAM/OTHER):') ?? ''
    try { await submissionApi.submit(sub.id, { confirmationReference: ref, submissionMethod: method }); onChanged(); toast('Submission recorded', 'success') }
    catch (e: any) {
      if (e?.response?.status === 409 && /not ready/i.test(e?.response?.data?.error || '')) { const reason = prompt('Not ready. Enter override reason to record submission anyway:'); if (reason?.trim()) { await submissionApi.submit(sub.id, { confirmationReference: ref, submissionMethod: method, overrideReason: reason.trim() }); onChanged(); toast('Submission recorded (override)', 'warning') } }
      else toast(e?.response?.data?.error || 'Failed', 'error')
    }
  }
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
      <p className="text-[10px] tracking-widest uppercase text-gray-500">Workflow</p>
      {['NOT_STARTED', 'IN_PROGRESS', 'READY_FOR_REVIEW'].includes(sub.status) && <button onClick={markReady} className="w-full text-xs px-3 py-1.5 rounded bg-green-900/40 hover:bg-green-900/60 text-green-200 border border-green-700">Mark ready to submit</button>}
      {['READY_TO_SUBMIT', 'READY_FOR_REVIEW', 'IN_PROGRESS'].includes(sub.status) && <button onClick={doSubmit} className="w-full flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded bg-blue-900/40 hover:bg-blue-900/60 text-blue-200 border border-blue-700"><Send className="w-3.5 h-3.5" /> Record submission</button>}
      {sub.status === 'SUBMITTED' && <ConfirmForm submissionId={sub.id} onChanged={onChanged} />}
      <p className="text-[10px] text-gray-600">Status is user-recorded workflow state only — Bytescon does not submit to any government portal.</p>
    </div>
  )
}

function ConfirmForm({ submissionId, onChanged }: { submissionId: string; onChanged: () => void }) {
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [ref, setRef] = useState('')
  const submit = async () => {
    const fd = new FormData()
    if (file) fd.append('file', file)
    if (ref) fd.append('confirmationReference', ref)
    const res = await fetch(`${API_BASE}/api/submission/${submissionId}/confirm`, { method: 'POST', credentials: 'include', body: fd })
    if (res.ok) { onChanged(); toast('Confirmation recorded', 'success') } else toast('Confirmation failed', 'error')
  }
  return (
    <div className="space-y-1.5">
      <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Confirmation reference" className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200" />
      <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full text-[10px] text-gray-500" />
      <button onClick={submit} className="w-full text-xs px-3 py-1.5 rounded bg-green-900/40 hover:bg-green-900/60 text-green-200 border border-green-700">Confirm received</button>
    </div>
  )
}

function DeadlineCard({ sub }: { sub: Submission }) {
  const overdue = sub.finalDeadline && new Date(sub.finalDeadline).getTime() < Date.now() && !['SUBMITTED', 'CONFIRMED'].includes(sub.status)
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-[10px] tracking-widest uppercase text-gray-500 mb-2">Deadlines</p>
      <div className="text-xs text-gray-400 space-y-1">
        <p>Internal: <span className="text-gray-200">{sub.internalDeadline ? new Date(sub.internalDeadline).toLocaleDateString() : '—'}</span></p>
        <p className={overdue ? 'text-red-400' : ''}>Final: <span className={overdue ? 'text-red-300' : 'text-gray-200'}>{sub.finalDeadline ? new Date(sub.finalDeadline).toLocaleDateString() : '—'}</span>{overdue && <span className="ml-1"><Clock className="w-3 h-3 inline" /> passed</span>}</p>
      </div>
    </div>
  )
}

function ChecklistRow({ item, isAdmin, onChanged }: { item: Item; isAdmin: boolean; onChanged: () => void }) {
  const { toast } = useToast()
  const i = item as any
  const isGenerated = !!(i.sourceMatrixRequirementId || i.sourceProposalSectionId || i.sourceDocumentRequirementId)
  const act = (fn: () => Promise<any>, msg: string) => async () => { try { await fn(); onChanged(); toast(msg, 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Failed', 'error') } }
  const uploadRef = (el: HTMLInputElement | null) => { if (el) (item as any)._ref = el }
  const upload = async (file: File) => {
    const fd = new FormData(); fd.append('file', file)
    const res = await fetch(`${API_BASE}/api/submission/items/${item.id}/attachment`, { method: 'POST', credentials: 'include', body: fd })
    if (res.ok) { onChanged(); toast('Attached', 'success') } else toast('Upload failed', 'error')
  }
  return (
    <div className="border border-gray-800 rounded-lg p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm text-gray-200">{item.title}</span>
            <span className="text-[9px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-400 font-mono">{item.itemType}</span>
            {item.isMandatory && <span className="text-[9px] px-1.5 py-0.5 rounded border border-red-800 bg-red-950/40 text-red-300 font-mono">MANDATORY</span>}
            {item.isBlocker && <span className="text-[9px] px-1.5 py-0.5 rounded border border-orange-800 bg-orange-950/40 text-orange-300 font-mono">BLOCKER</span>}
            {item.validationState !== 'UNVALIDATED' && <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${item.validationState === 'PASSED' ? 'border-green-800 bg-green-950/40 text-green-300' : item.validationState === 'FAILED' ? 'border-red-800 bg-red-950/40 text-red-300' : 'border-yellow-800 bg-yellow-950/40 text-yellow-300'}`}>{item.validationState}</span>}
          </div>
          {item.attachmentName && <p className="text-[10px] text-gray-500 mt-0.5"><Paperclip className="w-3 h-3 inline" /> {item.attachmentName}</p>}
          {item.blockerReason && <p className="text-[10px] text-orange-400/80 mt-0.5">Blocker: {item.blockerReason}</p>}
          {item.validationEvidence && <p className="text-[10px] text-gray-600 mt-0.5">{item.validationEvidence}</p>}
        </div>
        {isAdmin && (
          <div className="flex items-center gap-1.5">
            <select value={item.status} onChange={(e) => act(() => submissionApi.updateItem(item.id, { status: e.target.value }), 'Updated')()} className="bg-gray-800 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200">{ITEM_STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
          </div>
        )}
      </div>
      {isAdmin && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          <input ref={uploadRef} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
          <button onClick={() => (item as any)._ref?.click()} className="text-[10px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700">Attach</button>
          <button onClick={act(() => submissionApi.validateItem(item.id, { expectedExtensions: ['pdf'] }), 'Validated')} className="text-[10px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700">Validate</button>
          {!item.isBlocker ? <button onClick={() => { const r = prompt('Blocker reason?'); if (r?.trim()) act(() => submissionApi.block(item.id, r.trim()), 'Blocked')() }} className="text-[10px] px-2 py-0.5 rounded bg-orange-900/30 hover:bg-orange-900/50 text-orange-300 border border-orange-800">Block</button>
            : <button onClick={act(() => submissionApi.resolveBlocker(item.id), 'Resolved')} className="text-[10px] px-2 py-0.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700">Resolve</button>}
          <button onClick={() => { if (confirm(isGenerated ? 'Archive this generated item?' : 'Delete this manual item?')) act(() => submissionApi.deleteItem(item.id), isGenerated ? 'Archived' : 'Deleted')() }} className="text-[10px] px-2 py-0.5 rounded text-gray-500 hover:text-red-400 ml-auto">{isGenerated ? 'Archive' : 'Delete'}</button>
        </div>
      )}
    </div>
  )
}

function AddItemButton({ submissionId, onAdded }: { submissionId: string; onAdded: () => void }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ title: '', itemType: 'OTHER', isMandatory: false })
  const submit = async () => { try { await submissionApi.addItem(submissionId, { title: f.title.trim(), itemType: f.itemType, isMandatory: f.isMandatory }); setF({ title: '', itemType: 'OTHER', isMandatory: false }); setOpen(false); onAdded(); toast('Item added', 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Failed', 'error') } }
  if (!open) return <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700"><Plus className="w-3.5 h-3.5" /> Add item</button>
  return (
    <div className="flex flex-wrap gap-2 items-center">
      <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Item title" className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 w-40" />
      <select value={f.itemType} onChange={(e) => setF({ ...f, itemType: e.target.value })} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200">{ITEM_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
      <label className="text-[10px] text-gray-400 flex items-center gap-1"><input type="checkbox" checked={f.isMandatory} onChange={(e) => setF({ ...f, isMandatory: e.target.checked })} /> Mandatory</label>
      <button onClick={submit} disabled={!f.title.trim()} className="text-xs px-3 py-1 rounded bg-blue-900/40 text-blue-200 border border-blue-700 disabled:opacity-40">Add</button>
    </div>
  )
}

function HistoryCard({ submissionId }: { submissionId: string }) {
  const { data } = useQuery({ queryKey: ['submission-history', submissionId], queryFn: () => submissionApi.history(submissionId) })
  const history = data?.data?.history ?? []
  if (history.length === 0) return null
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-[10px] tracking-widest uppercase text-gray-500 mb-2">Status history</p>
      {history.map((h: { id: string; action: string; toStatus: string | null; createdAt: string; comment: string | null }) => (
        <div key={h.id} className="text-xs text-gray-400 py-0.5"><span className="font-mono text-gray-600">{new Date(h.createdAt).toLocaleDateString()}</span> {h.action}{h.toStatus && <span className="text-gray-600"> → {h.toStatus}</span>}{h.comment && <span className="block text-gray-500 italic">"{h.comment}"</span>}</div>
      ))}
    </div>
  )
}
