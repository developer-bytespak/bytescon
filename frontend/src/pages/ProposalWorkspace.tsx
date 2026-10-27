import { useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft, Loader, FileText, Plus, Sparkles, ChevronDown, ChevronRight, Archive, Pencil,
  ClipboardList, Users, CheckCircle2, AlertTriangle, ShieldCheck, Clock, Bot,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../hooks/useBranding'
import { useAiJobProgress } from '../hooks/useAiJobProgress'
import { useToast } from '../components/Toast'
import { complianceMatrixApi, firmApi, opportunitiesApi, proposalApi } from '../services/api'
import { AiProgressIndicator } from '../components/AiProgressIndicator'
import { ProposalAgentPanel } from '../components/section7/ProposalAgentPanel'
import { useTabParam } from '../hooks/useTabParam'
import { KeyPersonnelPanel } from '../components/knowledge/KeyPersonnelPanel'
import { PageSkeleton, SkeletonRows, StatCard, StatusPill, TabIndicator } from '../components/ui'

interface FirmUser { id: string; firstName: string | null; lastName: string | null; email: string; role: string }
interface Section {
  id: string; title: string; sectionNumber: string | null; outline: string | null; draft: string | null
  sortOrder: number; ownerUserId: string | null; reviewerUserId: string | null; status: string
  dueDate: string | null; reviewDate: string | null; notes: string | null; dependencies: string[]
  attachmentName: string | null; isAiGenerated: boolean; generationStatus: string; isOverdue?: boolean; wordCount: number; isArchived?: boolean
}
interface Proposal { id: string; title: string; status: string; opportunityId: string; sections: Section[] }
interface Requirement {
  id: string; section: string; sectionType: string; requirementText: string; isMandatory: boolean
  proposalSection: string | null; proposalSectionId: string | null; status: string; verificationStatus: string
  ownerUserId: string | null; evidenceText: string | null; extractionMethod: string; extractionConfidence: number
  sourcePageNumber: number | null
}

const STATUS_STYLES: Record<string, string> = {
  OUTLINE: 'bg-gray-800 border-gray-700 text-gray-300',
  DRAFTING: 'bg-blue-950/40 border-blue-800 text-blue-300',
  IN_REVIEW: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  CHANGES_REQUESTED: 'bg-orange-950/40 border-orange-800 text-orange-300',
  APPROVED: 'bg-green-950/40 border-green-800 text-green-300',
}
// Pill tone for section statuses whose word does not map directly; the raw status is always the text shown.
const SECTION_TONE_AS: Record<string, string> = { DRAFTING: 'in progress', CHANGES_REQUESTED: 'warning' }
const REQUIREMENT_TYPES = ['INSTRUCTION', 'EVALUATION', 'FORMAT', 'SUBMISSION', 'DOCUMENT', 'CERTIFICATION', 'DEADLINE', 'DELIVERABLE', 'OTHER']

function userLabel(u: FirmUser | undefined): string {
  if (!u) return 'Unknown'
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim()
  return name || u.email
}

export default function ProposalWorkspace() {
  const { id: opportunityId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, firm } = useAuth()
  const { branding } = useBranding(firm?.id)
  const { toast } = useToast()
  const qc = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const [tab, setTab] = useTabParam(['workspace', 'compliance', 'responsibility', 'personnel', 'agent'] as const, 'workspace')
  const [newTitle, setNewTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameTitle, setRenameTitle] = useState('')

  const oppQuery = useQuery({ queryKey: ['opportunity', opportunityId], queryFn: () => opportunitiesApi.getById(opportunityId!), enabled: !!opportunityId })
  const wsQuery = useQuery({ queryKey: ['proposal-workspace', opportunityId], queryFn: () => proposalApi.getWorkspace(opportunityId!), enabled: !!opportunityId })
  const usersQuery = useQuery({ queryKey: ['firm-users'], queryFn: () => firmApi.users() })

  const users: FirmUser[] = usersQuery.data?.data ?? []
  const ws = wsQuery.data?.data
  const proposal: Proposal | null = ws?.exists ? ws.proposal : null
  const progress = ws?.progress
  const opp = oppQuery.data?.data ?? oppQuery.data

  const createMutation = useMutation({
    mutationFn: () => proposalApi.create(opportunityId!, newTitle.trim()),
    onSuccess: () => { setNewTitle(''); qc.invalidateQueries({ queryKey: ['proposal-workspace', opportunityId] }); toast('Proposal created', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not create proposal', 'error'),
  })
  const archiveMutation = useMutation({
    mutationFn: () => proposalApi.archive(proposal!.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['proposal-workspace', opportunityId] }); qc.invalidateQueries({ queryKey: ['proposal-archived', opportunityId] }); toast('Proposal archived', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not archive', 'error'),
  })
  const renameMutation = useMutation({
    mutationFn: (title: string) => proposalApi.rename(proposal!.id, title),
    onSuccess: () => { setRenaming(false); qc.invalidateQueries({ queryKey: ['proposal-workspace', opportunityId] }); toast('Proposal renamed', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not rename', 'error'),
  })
  const restoreMutation = useMutation({
    mutationFn: (id: string) => proposalApi.restore(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['proposal-workspace', opportunityId] }); qc.invalidateQueries({ queryKey: ['proposal-archived', opportunityId] }); toast('Proposal restored', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not restore', 'error'),
  })
  const archivedQuery = useQuery({ queryKey: ['proposal-archived', opportunityId], queryFn: () => proposalApi.listArchived(opportunityId!), enabled: !!opportunityId })
  const archivedProposals: { id: string; title: string }[] = archivedQuery.data?.data?.proposals ?? []

  const gradient = { background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})` }

  if (wsQuery.isLoading || oppQuery.isLoading) {
    return <div className="max-w-7xl mx-auto px-6 py-6"><span className="sr-only">Loading…</span><PageSkeleton /></div>
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
      <div className="flex items-center gap-3 text-sm">
        <button onClick={() => navigate(`/opportunities/${opportunityId}`)} className="btn-ghost btn-sm -ml-2 flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to opportunity
        </button>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="overline">Proposal Workspace</p>
          <h1 className="page-title mt-1">{opp?.title ?? 'Opportunity'}</h1>
        </div>
        {proposal && isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            {renaming ? (
              <>
                <input value={renameTitle} onChange={(e) => setRenameTitle(e.target.value)} placeholder="Proposal title"
                  className="input !w-auto !py-1.5 !text-xs" />
                <button onClick={() => renameTitle.trim() && renameMutation.mutate(renameTitle.trim())} disabled={!renameTitle.trim() || renameMutation.isPending} className="btn-primary btn-sm disabled:opacity-50">Save</button>
                <button onClick={() => setRenaming(false)} className="btn-ghost btn-sm">Cancel</button>
              </>
            ) : (
              <>
                <span className="text-xs text-gray-400 min-w-0 truncate">{proposal.title}</span>
                <button onClick={() => { setRenameTitle(proposal.title); setRenaming(true) }} className="btn-secondary btn-sm flex items-center gap-1"><Pencil className="w-3.5 h-3.5" /> Rename</button>
                <button onClick={() => { if (confirm('Archive this proposal? A new one can be created afterward.')) archiveMutation.mutate() }}
                  disabled={archiveMutation.isPending}
                  className="btn-danger btn-sm flex items-center gap-1.5">
                  <Archive className="w-3.5 h-3.5" /> Archive
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {wsQuery.isError && <ErrorPanel message="Could not load the proposal workspace." onRetry={() => wsQuery.refetch()} />}

      {!proposal ? (
        <div className="card !py-12 text-center space-y-4 animate-fade-in">
          <div className="empty-ring mx-auto"><span className="tile tile-accent"><FileText /></span></div>
          <div>
            <p className="text-gray-200 font-semibold">No active proposal yet</p>
            <p className="text-sm text-gray-500 mt-1">Create a collaborative proposal workspace for this opportunity.</p>
          </div>
          {isAdmin ? (
            <div className="max-w-md mx-auto flex flex-col sm:flex-row gap-2">
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Proposal title (e.g. Volume I — Technical)"
                className="input flex-1 min-w-0" />
              <button onClick={() => createMutation.mutate()} disabled={!newTitle.trim() || createMutation.isPending}
                style={gradient} className="btn-primary justify-center flex items-center gap-1.5 disabled:opacity-50">
                {createMutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create
              </button>
            </div>
          ) : (
            <p className="text-xs text-gray-600">Read-only access — ask an administrator to create the proposal.</p>
          )}
          {isAdmin && archivedProposals.length > 0 && (
            <div className="max-w-md mx-auto pt-4 border-t border-gray-800 text-left">
              <p className="overline mb-2">Archived proposals</p>
              <ul className="space-y-1.5">
                {archivedProposals.map((ap) => (
                  <li key={ap.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-gray-400">{ap.title}</span>
                    <button onClick={() => restoreMutation.mutate(ap.id)} disabled={restoreMutation.isPending} className="btn-ghost btn-sm text-gray-500 hover:text-green-400 disabled:opacity-50">Restore</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <>
          {progress && (
            <div className="card">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm mb-3">
                <span className="text-gray-200 font-medium min-w-0">{proposal.title}</span>
                <span className="text-gray-400 tabular-nums">{progress.approved}/{progress.total} sections approved · {progress.percent}%</span>
              </div>
              <div className="progress-track">
                <div className="h-full rounded-full bar-grow transition-all" style={{ width: `${progress.percent}%`, ...gradient }} />
              </div>
            </div>
          )}

          <div className="tabs">
            <TabButton active={tab === 'workspace'} onClick={() => setTab('workspace')} icon={FileText} label="Sections" />
            <TabButton active={tab === 'compliance'} onClick={() => setTab('compliance')} icon={ShieldCheck} label="Compliance Matrix" />
            <TabButton active={tab === 'responsibility'} onClick={() => setTab('responsibility')} icon={Users} label="Responsibility Matrix" />
            <TabButton active={tab === 'personnel'} onClick={() => setTab('personnel')} icon={Users} label="Key Personnel" />
            <TabButton active={tab === 'agent'} onClick={() => setTab('agent')} icon={Bot} label="Proposal Agent" />
          </div>

          {tab === 'workspace' && <SectionsPanel proposal={proposal} users={users} isAdmin={isAdmin} opportunityId={opportunityId!} />}
          {tab === 'compliance' && <ComplianceMatrixPanel opportunityId={opportunityId!} proposal={proposal} users={users} isAdmin={isAdmin} />}
          {tab === 'responsibility' && <ResponsibilityPanel proposalId={proposal.id} users={users} isAdmin={isAdmin} opportunityId={opportunityId!} />}
          {tab === 'personnel' && <KeyPersonnelPanel proposalId={proposal.id} canEdit={isAdmin} />}
          {tab === 'agent' && <ProposalAgentPanel proposalId={proposal.id} />}
        </>
      )}
    </div>
  )
}

function TabButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: any; label: string }) {
  return (
    <button onClick={onClick}
      className="tab" data-active={active}>
      <Icon className="w-4 h-4" /> {label}
      {active && <TabIndicator id="proposal-workspace" />}
    </button>
  )
}

function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl p-4 flex items-center justify-between gap-3" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
      <p className="text-sm text-red-300 flex items-center gap-2"><AlertTriangle className="w-4 h-4 flex-shrink-0" /> {message}</p>
      <button onClick={onRetry} className="text-xs font-medium text-red-300 hover:text-red-100 underline underline-offset-2">Retry</button>
    </div>
  )
}

// =============================================================
// SECTIONS PANEL
// =============================================================
function SectionsPanel({ proposal, users, isAdmin, opportunityId }: { proposal: Proposal; users: FirmUser[]; isAdmin: boolean; opportunityId: string }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [secForm, setSecForm] = useState({ ownerUserId: '', reviewerUserId: '', dueDate: '', reviewDate: '', notes: '', dependencies: '' })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['proposal-workspace', opportunityId] })

  const addMutation = useMutation({
    mutationFn: () => proposalApi.addSection(proposal.id, {
      title: title.trim(),
      ownerUserId: secForm.ownerUserId || undefined,
      reviewerUserId: secForm.reviewerUserId || undefined,
      dueDate: secForm.dueDate ? new Date(secForm.dueDate).toISOString() : undefined,
      reviewDate: secForm.reviewDate ? new Date(secForm.reviewDate).toISOString() : undefined,
      notes: secForm.notes.trim() || undefined,
      dependencies: secForm.dependencies.split(',').map((s) => s.trim()).filter(Boolean),
    }),
    onSuccess: () => { setTitle(''); setSecForm({ ownerUserId: '', reviewerUserId: '', dueDate: '', reviewDate: '', notes: '', dependencies: '' }); setAdding(false); invalidate(); toast('Section added', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not add section', 'error'),
  })
  const outlineMutation = useMutation({
    mutationFn: () => proposalApi.generateOutline(proposal.id),
    onSuccess: (r: any) => { invalidate(); toast(`Outline created: ${r?.data?.sections?.length ?? 0} sections`, 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not generate outline', 'error'),
  })

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setAdding((v) => !v)} className="btn-secondary btn-sm flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Add section
          </button>
          <button onClick={() => outlineMutation.mutate()} disabled={outlineMutation.isPending}
            className="btn-secondary btn-sm flex items-center gap-1.5 disabled:opacity-50">
            {outlineMutation.isPending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <ClipboardList className="w-3.5 h-3.5" />} Generate outline from verified requirements
          </button>
        </div>
      )}
      {adding && (
        <div className="panel p-4 space-y-2.5 animate-fade-up">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Section title *"
            className="input w-full" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <select value={secForm.ownerUserId} onChange={(e) => setSecForm({ ...secForm, ownerUserId: e.target.value })} className="input !py-1.5 !text-xs"><option value="">Writer</option>{users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select>
            <select value={secForm.reviewerUserId} onChange={(e) => setSecForm({ ...secForm, reviewerUserId: e.target.value })} className="input !py-1.5 !text-xs"><option value="">Reviewer</option>{users.map((u) => <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>)}</select>
            <label className="text-[10px] text-gray-500">Due<input type="date" value={secForm.dueDate} onChange={(e) => setSecForm({ ...secForm, dueDate: e.target.value })} className="input mt-0.5 w-full !py-1.5 !text-xs" /></label>
            <label className="text-[10px] text-gray-500">Review<input type="date" value={secForm.reviewDate} onChange={(e) => setSecForm({ ...secForm, reviewDate: e.target.value })} className="input mt-0.5 w-full !py-1.5 !text-xs" /></label>
          </div>
          <input value={secForm.dependencies} onChange={(e) => setSecForm({ ...secForm, dependencies: e.target.value })} placeholder="Dependencies (comma-sep section titles)" className="input w-full !py-1.5 !text-xs" />
          <textarea value={secForm.notes} onChange={(e) => setSecForm({ ...secForm, notes: e.target.value })} placeholder="Notes" rows={2} className="input w-full !py-1.5 !text-xs" />
          <button onClick={() => addMutation.mutate()} disabled={!title.trim() || addMutation.isPending}
            className="btn-primary btn-sm disabled:opacity-50">Save section</button>
        </div>
      )}

      {proposal.sections.length === 0 ? (
        <div className="card !py-10 text-center animate-fade-in">
          <div className="empty-ring mx-auto mb-3"><span className="tile tile-accent"><FileText /></span></div>
          <p className="text-sm text-gray-500">No sections yet. Add one manually or generate an outline from verified compliance requirements.</p>
        </div>
      ) : (
        <div className="stagger space-y-3">
          {proposal.sections.map((s, i) => (
            <SectionCard key={s.id} section={s} users={users} isAdmin={isAdmin} opportunityId={opportunityId}
              proposalId={proposal.id} canMoveUp={i > 0} canMoveDown={i < proposal.sections.length - 1}
              siblingIds={proposal.sections.map((x) => x.id)} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

function SectionCard({ section, users, isAdmin, opportunityId, proposalId, canMoveUp, canMoveDown, siblingIds, index }: {
  section: Section; users: FirmUser[]; isAdmin: boolean; opportunityId: string; proposalId: string
  canMoveUp: boolean; canMoveDown: boolean; siblingIds: string[]; index: number
}) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [expanded, setExpanded] = useState(false)
  const [draft, setDraft] = useState(section.draft ?? '')
  const [showVersions, setShowVersions] = useState(false)
  const [showReviews, setShowReviews] = useState(false)
  const draftJob = useAiJobProgress({ expectedSec: 25 })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['proposal-workspace', opportunityId] })
  const isApproved = section.status === 'APPROVED'

  const mut = (fn: () => Promise<any>, okMsg: string) => async () => {
    try { await fn(); invalidate(); toast(okMsg, 'success') }
    catch (e: any) { toast(e?.response?.data?.error || 'Action failed', 'error') }
  }

  const saveContent = mut(() => proposalApi.saveContent(section.id, draft), 'Draft saved (new version)')
  const assignWriter = (v: string) => mut(() => proposalApi.assignWriter(section.id, v || null), 'Writer updated')()
  const setReviewer = (v: string) => mut(() => proposalApi.setReviewer(section.id, v || null), 'Reviewer updated')()
  const setDue = (v: string) => mut(() => proposalApi.updateSection(section.id, { dueDate: v ? new Date(v).toISOString() : null }), 'Due date updated')()
  const submit = mut(() => proposalApi.submit(section.id), 'Submitted for review')
  const approve = mut(() => proposalApi.approve(section.id), 'Section approved')
  const resubmit = mut(() => proposalApi.resubmit(section.id), 'Resubmitted for review')
  const reopen = mut(() => proposalApi.reopenSection(section.id), 'Section reopened for edits')
  const archiveSection = mut(() => proposalApi.deleteSection(section.id), 'Section archived')
  const restoreSection = mut(() => proposalApi.restoreSection(section.id), 'Section restored')
  const requestChanges = async () => {
    const comment = prompt('What changes are required? (a comment is required)')
    if (!comment || !comment.trim()) return
    await mut(() => proposalApi.requestChanges(section.id, comment.trim()), 'Changes requested')()
  }
  const move = (dir: -1 | 1) => {
    const ids = [...siblingIds]
    const j = index + dir
    ;[ids[index], ids[j]] = [ids[j], ids[index]]
    return mut(() => proposalApi.reorder(proposalId, ids), 'Reordered')()
  }

  const generateDraft = async () => {
    if (isApproved) { toast('Reopen the approved section before regenerating', 'error'); return }
    const r = await draftJob.run(
      (signal) => proposalApi.generateDraft(section.id, {}, signal),
      (err: any) => err?.response?.data?.error || 'Draft generation failed',
    )
    if (r) { invalidate(); toast(`AI draft generated (${r?.data?.source ?? 'AI'})`, 'success'); setExpanded(true) }
    else if (draftJob.error) toast(draftJob.error, 'error')
  }

  return (
    <div className="card !p-0">
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 p-4">
        <button onClick={() => setExpanded((v) => !v)} aria-label={expanded ? 'Collapse section' : 'Expand section'} aria-expanded={expanded} className="btn-ghost btn-sm !px-1.5">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {section.sectionNumber && <span className="text-xs font-mono text-gray-500">{section.sectionNumber}</span>}
            <span className="text-sm font-medium text-gray-100 truncate">{section.title}</span>
            {section.isAiGenerated && <span className="chip chip-accent !text-[9px] font-mono flex-shrink-0">AI DRAFT</span>}
            {section.isOverdue && <span className="chip chip-danger !text-[9px] font-mono flex-shrink-0"><Clock className="w-2.5 h-2.5" /> OVERDUE</span>}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[11px] text-gray-500 tabular-nums">
            <span>Writer: {userLabel(users.find((u) => u.id === section.ownerUserId))}</span>
            <span>Reviewer: {section.reviewerUserId ? userLabel(users.find((u) => u.id === section.reviewerUserId)) : '—'}</span>
            {section.dueDate && <span>Due {new Date(section.dueDate).toLocaleDateString()}</span>}
            <span>{section.wordCount} words</span>
          </div>
        </div>
        <StatusPill status={SECTION_TONE_AS[section.status] ?? section.status}>{section.status}</StatusPill>
        {isAdmin && (
          <div className="flex flex-col">
            <button disabled={!canMoveUp} onClick={() => move(-1)} aria-label="Move section up" className="text-gray-600 hover:text-gray-300 disabled:opacity-20 leading-none px-1">▲</button>
            <button disabled={!canMoveDown} onClick={() => move(1)} aria-label="Move section down" className="text-gray-600 hover:text-gray-300 disabled:opacity-20 leading-none px-1">▼</button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="border-t border-gray-800 p-4 space-y-4 animate-fade-in">
          {section.outline && (
            <div>
              <p className="overline mb-1.5">Outline</p>
              <pre className="text-xs leading-relaxed text-gray-400 whitespace-pre-wrap font-sans">{section.outline}</pre>
            </div>
          )}

          {isAdmin && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <label className="text-xs text-gray-500">Writer
                <select value={section.ownerUserId ?? ''} onChange={(e) => assignWriter(e.target.value)}
                  className="input mt-1 w-full !py-1.5">
                  <option value="">Unassigned</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-500">Reviewer
                <select value={section.reviewerUserId ?? ''} onChange={(e) => setReviewer(e.target.value)}
                  className="input mt-1 w-full !py-1.5">
                  <option value="">Unassigned</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-500">Internal due date
                <input type="date" defaultValue={section.dueDate ? section.dueDate.slice(0, 10) : ''} onChange={(e) => setDue(e.target.value)}
                  className="input mt-1 w-full !py-1.5" />
              </label>
            </div>
          )}

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <p className="overline">Draft content</p>
              {isApproved && <span className="text-[10px] text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Approved — request changes to edit</span>}
            </div>
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!isAdmin || isApproved} rows={8}
              className="input w-full font-mono disabled:opacity-60"
              placeholder="Section draft…" />
            <AiProgressIndicator job={draftJob} title="Generating AI draft…" />
            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button onClick={saveContent} disabled={isApproved || draft === (section.draft ?? '')}
                  className="btn-primary btn-sm disabled:opacity-40">Save version</button>
                <button onClick={generateDraft} disabled={isApproved || draftJob.running || section.generationStatus === 'PROCESSING'}
                  className="btn-secondary btn-sm flex items-center gap-1.5 disabled:opacity-40">
                  <Sparkles className="w-3.5 h-3.5" /> AI draft
                </button>
                <span className="text-[10px] text-gray-600 font-mono">gen: {section.generationStatus}</span>
                <button onClick={() => setShowVersions((v) => !v)} className="btn-ghost btn-sm">Versions</button>
                <button onClick={() => setShowReviews((v) => !v)} className="btn-ghost btn-sm">Review history</button>
              </div>
            )}
          </div>

          {isAdmin && (
            <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-gray-800">
              {['OUTLINE', 'DRAFTING', 'CHANGES_REQUESTED'].includes(section.status) && (
                <button onClick={submit} className="btn-primary btn-sm">Submit for review</button>
              )}
              {section.status === 'IN_REVIEW' && (
                <>
                  <button onClick={approve} className="btn-primary btn-sm">Approve</button>
                  <button onClick={requestChanges} className="btn-secondary btn-sm text-amber-400">Request changes</button>
                </>
              )}
              {section.status === 'CHANGES_REQUESTED' && (
                <button onClick={resubmit} className="btn-primary btn-sm">Resubmit</button>
              )}
              {isApproved && (
                <>
                  <button onClick={reopen} className="btn-secondary btn-sm">Reopen for edits</button>
                  <button onClick={requestChanges} className="btn-secondary btn-sm text-amber-400">Reopen (request changes)</button>
                </>
              )}
              {section.isArchived
                ? <button onClick={restoreSection} className="btn-ghost btn-sm text-gray-400 hover:text-green-400 ml-auto">Restore</button>
                : <button onClick={archiveSection} className="btn-ghost btn-sm text-gray-500 hover:text-red-400 ml-auto flex items-center gap-1"><Archive className="w-3.5 h-3.5" /> Archive</button>}
            </div>
          )}

          {showVersions && <VersionList sectionId={section.id} canEdit={!isApproved && !section.isArchived} />}
          {showReviews && <ReviewList sectionId={section.id} users={users} />}
        </div>
      )}
    </div>
  )
}

function VersionList({ sectionId, canEdit }: { sectionId: string; canEdit: boolean }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const { data, isLoading } = useQuery({ queryKey: ['section-versions', sectionId], queryFn: () => proposalApi.listVersions(sectionId) })
  const versions: any[] = data?.data?.versions ?? []
  const [aV, setAV] = useState<number | null>(null)
  const [bV, setBV] = useState<number | null>(null)
  const restore = useMutation({
    mutationFn: (version: number) => proposalApi.restoreVersion(sectionId, version),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['section-versions', sectionId] }); qc.invalidateQueries({ queryKey: ['proposal-workspace'] }); toast('Version restored into a new version', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not restore version', 'error'),
  })
  if (isLoading) return <p className="text-xs text-gray-500 animate-pulse">Loading versions…</p>
  if (versions.length === 0) return <p className="text-xs text-gray-600">No saved versions yet.</p>
  const byV = (v: number | null) => versions.find((x) => x.version === v)
  const a = byV(aV ?? versions[versions.length - 1]?.version)
  const b = byV(bV ?? versions[0]?.version)
  return (
    <div className="panel p-3.5 space-y-3">
      <p className="overline">Content versions (immutable — preserved)</p>
      {versions.length > 1 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-gray-500">
            <span>Compare</span>
            <select value={a?.version ?? ''} onChange={(e) => setAV(Number(e.target.value))} className="input !w-auto !py-0.5 !px-1.5 !text-[11px]">{versions.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}</select>
            <span>↔</span>
            <select value={b?.version ?? ''} onChange={(e) => setBV(Number(e.target.value))} className="input !w-auto !py-0.5 !px-1.5 !text-[11px]">{versions.map((v) => <option key={v.id} value={v.version}>v{v.version}</option>)}</select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <pre className="card !p-2.5 text-[11px] text-gray-500 whitespace-pre-wrap font-sans max-h-48 overflow-auto">{a?.content}</pre>
            <pre className="card !p-2.5 text-[11px] text-gray-500 whitespace-pre-wrap font-sans max-h-48 overflow-auto">{b?.content}</pre>
          </div>
        </div>
      )}
      {versions.map((v: any) => (
        <details key={v.id} className="text-xs">
          <summary className="cursor-pointer text-gray-400 flex flex-wrap items-center gap-2 tabular-nums hover:text-gray-200">
            v{v.version} · {v.source} · {new Date(v.createdAt).toLocaleString()}
            {canEdit && <button onClick={(e) => { e.preventDefault(); restore.mutate(v.version) }} className="text-[10px] font-medium text-gray-500 hover:text-blue-300">Restore this version</button>}
          </summary>
          <pre className="mt-1 text-gray-500 whitespace-pre-wrap font-sans max-h-48 overflow-auto">{v.content}</pre>
        </details>
      ))}
    </div>
  )
}

function ReviewList({ sectionId, users }: { sectionId: string; users: FirmUser[] }) {
  const { data, isLoading } = useQuery({ queryKey: ['section-reviews', sectionId], queryFn: () => proposalApi.listReviews(sectionId) })
  const reviews = data?.data?.reviews ?? []
  if (isLoading) return <p className="text-xs text-gray-500 animate-pulse">Loading history…</p>
  if (reviews.length === 0) return <p className="text-xs text-gray-600">No review history yet.</p>
  return (
    <div className="panel p-3.5 space-y-2">
      <p className="overline">Review history (retained)</p>
      {reviews.map((r: any) => (
        <div key={r.id} className="text-xs text-gray-400 flex items-start gap-2">
          <span className="font-mono tabular-nums text-gray-600 flex-shrink-0">{new Date(r.createdAt).toLocaleDateString()}</span>
          <span>
            <span className="text-gray-300">{r.action}</span>
            {r.fromStatus && r.toStatus && <span className="text-gray-600"> ({r.fromStatus} → {r.toStatus})</span>}
            {r.actorUserId && <span className="text-gray-600"> by {userLabel(users.find((u) => u.id === r.actorUserId))}</span>}
            {r.comment && <span className="block text-gray-500 italic">“{r.comment}”</span>}
          </span>
        </div>
      ))}
    </div>
  )
}

// =============================================================
// COMPLIANCE MATRIX PANEL
// =============================================================
function ComplianceMatrixPanel({ opportunityId, proposal, users, isAdmin }: { opportunityId: string; proposal: Proposal; users: FirmUser[]; isAdmin: boolean }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [filters, setFilters] = useState<{ mandatory: boolean; unverified: boolean; incomplete: boolean }>({ mandatory: false, unverified: false, incomplete: false })
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ requirementText: '', sectionType: 'INSTRUCTION', isMandatory: false, section: '', sourcePageNumber: '', evidenceText: '', proposalSection: '' })
  const reExtractJob = useAiJobProgress({ expectedSec: 40 })

  const params = useMemo(() => ({ mandatory: filters.mandatory || undefined, unverified: filters.unverified || undefined, incomplete: filters.incomplete || undefined }), [filters])
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['compliance-summary', opportunityId, params], queryFn: () => complianceMatrixApi.summary(opportunityId, params) })
  const summary = data?.data
  const requirements: Requirement[] = summary?.requirements ?? []
  const counts = summary?.counts
  const invalidate = () => qc.invalidateQueries({ queryKey: ['compliance-summary', opportunityId] })

  const act = (fn: () => Promise<any>, okMsg: string) => async () => {
    try { await fn(); invalidate(); toast(okMsg, 'success') }
    catch (e: any) { toast(e?.response?.data?.error || e?.response?.data?.message || 'Action failed', 'error') }
  }
  const addRequirement = act(() => complianceMatrixApi.addRequirement(opportunityId, {
    requirementText: form.requirementText.trim(), sectionType: form.sectionType, isMandatory: form.isMandatory,
    section: form.section.trim() || undefined,
    sourcePageNumber: form.sourcePageNumber ? parseInt(form.sourcePageNumber, 10) : undefined,
    evidenceText: form.evidenceText.trim() || undefined,
    proposalSection: form.proposalSection.trim() || undefined,
  }), 'Requirement added')
  const reExtract = async () => {
    const r = await reExtractJob.run(
      (signal) => complianceMatrixApi.reExtract(opportunityId, signal),
      (err: any) => err?.response?.data?.message || err?.response?.data?.error || 'Re-extraction failed',
    )
    if (r) { invalidate(); toast(`Re-extraction added ${r?.added ?? 0}, preserved ${r?.preserved ?? 0} verified`, 'success') }
    else if (reExtractJob.error) toast(reExtractJob.error, 'error')
  }

  if (isLoading) return <div className="card"><SkeletonRows rows={5} cols={4} /></div>
  if (isError) return <ErrorPanel message="Could not load the compliance matrix." onRetry={() => refetch()} />

  return (
    <div className="space-y-4">
      {counts && (
        <div className="stagger grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
          <Kpi label="Compliance" value={`${summary.compliancePercent}%`} />
          <Kpi label="Total" value={counts.total} />
          <Kpi label="Mandatory" value={counts.mandatory} />
          <Kpi label="Verified" value={counts.verified} />
          <Kpi label="Unverified" value={counts.unverified} />
          <Kpi label="Linked" value={counts.linked} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <FilterToggle label="Mandatory" active={filters.mandatory} onClick={() => setFilters((f) => ({ ...f, mandatory: !f.mandatory }))} />
        <FilterToggle label="Unverified" active={filters.unverified} onClick={() => setFilters((f) => ({ ...f, unverified: !f.unverified }))} />
        <FilterToggle label="Incomplete" active={filters.incomplete} onClick={() => setFilters((f) => ({ ...f, incomplete: !f.incomplete }))} />
        <div className="flex-1" />
        {isAdmin && (
          <>
            <button onClick={() => setAdding((v) => !v)} className="btn-secondary btn-sm flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add requirement
            </button>
            <button onClick={reExtract} disabled={reExtractJob.running}
              className="btn-primary btn-sm flex items-center gap-1.5 disabled:opacity-50">
              <Sparkles className="w-3.5 h-3.5" /> Re-extract (keeps verified)
            </button>
          </>
        )}
      </div>

      <AiProgressIndicator job={reExtractJob} title="Re-extracting requirements…" />

      {adding && isAdmin && (
        <div className="card space-y-2.5 animate-fade-up">
          <textarea value={form.requirementText} onChange={(e) => setForm({ ...form, requirementText: e.target.value })} rows={2} placeholder="Requirement text"
            className="input w-full" />
          <div className="flex flex-wrap items-center gap-3">
            <select value={form.sectionType} onChange={(e) => setForm({ ...form, sectionType: e.target.value })}
              className="input !w-auto !py-1.5">
              {REQUIREMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="text-xs text-gray-400 flex items-center gap-1.5">
              <input type="checkbox" checked={form.isMandatory} onChange={(e) => setForm({ ...form, isMandatory: e.target.checked })} /> Mandatory
            </label>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <input value={form.section} onChange={(e) => setForm({ ...form, section: e.target.value })} placeholder="Source section (e.g. L.1)" className="input !py-1.5 !text-xs" />
            <input value={form.sourcePageNumber} onChange={(e) => setForm({ ...form, sourcePageNumber: e.target.value.replace(/\D/g, '') })} placeholder="Source page" className="input !py-1.5 !text-xs" />
            <input value={form.proposalSection} onChange={(e) => setForm({ ...form, proposalSection: e.target.value })} placeholder="Suggested proposal section" className="input !py-1.5 !text-xs" />
            <button onClick={addRequirement} disabled={!form.requirementText.trim()}
              className="btn-primary btn-sm disabled:opacity-40">Add requirement</button>
          </div>
          <input value={form.evidenceText} onChange={(e) => setForm({ ...form, evidenceText: e.target.value })} placeholder="Evidence text (source excerpt)" className="input w-full !py-1.5 !text-xs" />
        </div>
      )}

      {requirements.length === 0 ? (
        <div className="card !py-10 text-center animate-fade-in">
          <div className="empty-ring mx-auto mb-3"><span className="tile tile-accent"><ShieldCheck /></span></div>
          <p className="text-sm text-gray-500">No requirements match. Add one manually or run re-extraction (requires an AI provider key).</p>
        </div>
      ) : (
        <div className="stagger space-y-2">
          {requirements.map((r) => (
            <RequirementRow key={r.id} req={r} proposal={proposal} users={users} isAdmin={isAdmin} onChanged={invalidate} />
          ))}
        </div>
      )}
    </div>
  )
}

function RequirementRow({ req, proposal, users, isAdmin, onChanged }: { req: Requirement; proposal: Proposal; users: FirmUser[]; isAdmin: boolean; onChanged: () => void }) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const act = (fn: () => Promise<any>, okMsg: string) => async () => {
    try { await fn(); onChanged(); toast(okMsg, 'success') }
    catch (e: any) { toast(e?.response?.data?.error || 'Action failed', 'error') }
  }
  const verify = act(() => complianceMatrixApi.verifyRequirement(req.id), 'Verified')
  const reject = async () => {
    const reason = prompt('Reason for rejecting this extracted requirement?')
    if (!reason || !reason.trim()) return
    await act(() => complianceMatrixApi.rejectRequirement(req.id, reason.trim()), 'Rejected')()
  }
  const assign = (v: string) => act(() => complianceMatrixApi.assignOwner(req.id, v || null), 'Owner updated')()
  const link = (v: string) => act(() => complianceMatrixApi.linkSection(req.id, v || null), 'Section link updated')()

  return (
    <div className="card !p-0">
      <div className="flex items-start gap-3 p-3.5">
        <button onClick={() => setOpen((v) => !v)} aria-label={open ? 'Collapse requirement' : 'Expand requirement'} aria-expanded={open} className="btn-ghost btn-sm !px-1.5 -mt-0.5">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm leading-relaxed text-gray-200">{req.requirementText}</p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="chip chip-neutral !text-[9px] font-mono">{req.sectionType}</span>
            {req.isMandatory && <span className="chip chip-danger !text-[9px] font-mono">MANDATORY</span>}
            <StatusPill status={req.verificationStatus} className="!text-[9px] font-mono" />
            {req.proposalSection && <span className="chip chip-accent !text-[9px] font-mono">→ {req.proposalSection}</span>}
            <span className="text-[9px] text-gray-600 font-mono">{req.extractionMethod}{req.sourcePageNumber ? ` · p.${req.sourcePageNumber}` : ''}</span>
          </div>
        </div>
      </div>
      {open && (
        <div className="border-t border-gray-800 p-3.5 space-y-3 animate-fade-in">
          {req.evidenceText && (
            <div>
              <p className="overline mb-1.5">Source evidence (preserved)</p>
              <p className="text-xs leading-relaxed text-gray-400 italic">“{req.evidenceText}”</p>
            </div>
          )}
          {isAdmin ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <button onClick={verify} disabled={req.verificationStatus === 'VERIFIED'}
                  className="btn-primary btn-sm disabled:opacity-40">Verify</button>
                <button onClick={reject} disabled={req.verificationStatus === 'REJECTED'}
                  className="btn-danger btn-sm disabled:opacity-40">Reject</button>
              </div>
              <label className="text-xs text-gray-500">Owner
                <select value={req.ownerUserId ?? ''} onChange={(e) => assign(e.target.value)}
                  className="input mt-1 w-full !py-1.5">
                  <option value="">Unassigned</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
                </select>
              </label>
              <label className="text-xs text-gray-500 md:col-span-2">Link to proposal section
                <select value={req.proposalSectionId ?? ''} onChange={(e) => link(e.target.value)}
                  className="input mt-1 w-full !py-1.5">
                  <option value="">Not linked</option>
                  {proposal.sections.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
              </label>
            </div>
          ) : (
            <p className="text-xs text-gray-600">Read-only access.</p>
          )}
        </div>
      )}
    </div>
  )
}

// =============================================================
// RESPONSIBILITY MATRIX PANEL
// =============================================================
function ResponsibilityPanel({ proposalId, users, isAdmin, opportunityId }: { proposalId: string; users: FirmUser[]; isAdmin: boolean; opportunityId: string }) {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [filters, setFilters] = useState<{ writerUserId: string; reviewerUserId: string; status: string; overdue: boolean }>({ writerUserId: '', reviewerUserId: '', status: '', overdue: false })
  const edit = (fn: () => Promise<any>) => async () => {
    // Edits the SAME ProposalSection records — reflected immediately in Sections tab.
    try { await fn(); qc.invalidateQueries({ queryKey: ['responsibility', proposalId] }); qc.invalidateQueries({ queryKey: ['proposal-workspace', opportunityId] }); toast('Updated', 'success') }
    catch (e: any) { toast(e?.response?.data?.error || 'Update failed', 'error') }
  }
  const params = useMemo(() => ({
    writerUserId: filters.writerUserId || undefined,
    reviewerUserId: filters.reviewerUserId || undefined,
    status: filters.status || undefined,
    overdue: filters.overdue || undefined,
  }), [filters])
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['responsibility', proposalId, params], queryFn: () => proposalApi.responsibility(proposalId, params) })
  const sections: Section[] = data?.data?.sections ?? []

  if (isLoading) return <div className="card"><SkeletonRows rows={5} cols={6} /></div>
  if (isError) return <ErrorPanel message="Could not load the responsibility matrix." onRetry={() => refetch()} />

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={filters.writerUserId} onChange={(e) => setFilters((f) => ({ ...f, writerUserId: e.target.value }))}
          className="input !w-auto !py-1.5 !text-xs">
          <option value="">All writers</option>
          {users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
        </select>
        <select value={filters.reviewerUserId} onChange={(e) => setFilters((f) => ({ ...f, reviewerUserId: e.target.value }))}
          className="input !w-auto !py-1.5 !text-xs">
          <option value="">All reviewers</option>
          {users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}
        </select>
        <select value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}
          className="input !w-auto !py-1.5 !text-xs">
          <option value="">All statuses</option>
          {Object.keys(STATUS_STYLES).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <FilterToggle label="Overdue only" active={filters.overdue} onClick={() => setFilters((f) => ({ ...f, overdue: !f.overdue }))} />
      </div>

      {sections.length === 0 ? (
        <div className="card !py-10 text-center animate-fade-in">
          <div className="empty-ring mx-auto mb-3"><span className="tile tile-accent"><Users /></span></div>
          <p className="text-sm text-gray-500">No sections match these filters.</p>
        </div>
      ) : (
        <div className="table-wrap max-h animate-fade-in">
          <table className="data-table">
            <thead>
              <tr>
                <th>Section</th><th>Writer</th><th>Reviewer</th>
                <th>Due</th><th>Review</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sections.map((s) => (
                <tr key={s.id}>
                  <td className="text-gray-200 font-medium min-w-[12rem]">{s.sectionNumber ? `${s.sectionNumber} · ` : ''}{s.title}</td>
                  <td>{isAdmin ? (
                    <select value={s.ownerUserId ?? ''} onChange={(e) => edit(() => proposalApi.assignWriter(s.id, e.target.value || null))()} className="input !w-auto !py-1 !px-2 !text-xs"><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}</select>
                  ) : <span className="text-gray-400 text-xs">{userLabel(users.find((u) => u.id === s.ownerUserId))}</span>}</td>
                  <td>{isAdmin ? (
                    <select value={s.reviewerUserId ?? ''} onChange={(e) => edit(() => proposalApi.setReviewer(s.id, e.target.value || null))()} className="input !w-auto !py-1 !px-2 !text-xs"><option value="">—</option>{users.map((u) => <option key={u.id} value={u.id}>{userLabel(u)}</option>)}</select>
                  ) : <span className="text-gray-400 text-xs">{s.reviewerUserId ? userLabel(users.find((u) => u.id === s.reviewerUserId)) : '—'}</span>}</td>
                  <td>{isAdmin ? (
                    <input type="date" value={s.dueDate ? s.dueDate.slice(0, 10) : ''} onChange={(e) => edit(() => proposalApi.updateSection(s.id, { dueDate: e.target.value ? new Date(e.target.value).toISOString() : null }))()} className={`input !w-auto !py-1 !px-2 !text-xs ${s.isOverdue ? '!text-red-300' : ''}`} />
                  ) : <span className={`text-xs ${s.isOverdue ? 'text-red-400' : 'text-gray-400'}`}>{s.dueDate ? new Date(s.dueDate).toLocaleDateString() : '—'}</span>}</td>
                  <td>{isAdmin ? (
                    <input type="date" value={s.reviewDate ? s.reviewDate.slice(0, 10) : ''} onChange={(e) => edit(() => proposalApi.updateSection(s.id, { reviewDate: e.target.value ? new Date(e.target.value).toISOString() : null }))()} className="input !w-auto !py-1 !px-2 !text-xs" />
                  ) : <span className="text-gray-400 text-xs">{s.reviewDate ? new Date(s.reviewDate).toLocaleDateString() : '—'}</span>}</td>
                  <td><StatusPill status={SECTION_TONE_AS[s.status] ?? s.status}>{s.status}</StatusPill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <StatCard label={label} value={value} />
  )
}

function FilterToggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={`chip chip-lg transition-colors ${active ? 'chip-accent' : 'chip-neutral hover:text-gray-200'}`}>
      {active ? '✓ ' : ''}{label}
    </button>
  )
}
