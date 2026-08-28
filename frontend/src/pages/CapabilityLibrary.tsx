// =============================================================
// §8.3 — Capability library: reusable narratives, differentiators and
// approved boilerplate.
//
// The distinction the whole screen is built around: a DRAFT is words somebody
// typed; an APPROVED version is a claim the firm stands behind and the only
// text an agent is allowed to quote. Approving is therefore a deliberate act
// with its own button and its own warning, never a side effect of saving.
//
// Approving a new version supersedes the previous one rather than replacing
// it. Old wording stays readable, because a proposal submitted last year was
// written against the text as it stood then.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Plus, ShieldCheck } from 'lucide-react'
import { PageHeader, Spinner } from '../components/ui'
import { Badge, EmptyPanel, ErrorPanel } from '../components/section6/Section6Ui'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import {
  proposalAgentApi,
  type CapabilityNarrative, type CapabilityNarrativeVersion,
} from '../services/proposalAgentApi'

const CATEGORIES = [
  'TECHNICAL_NARRATIVE', 'DIFFERENTIATOR', 'MANAGEMENT_APPROACH',
  'QUALITY_APPROACH', 'BOILERPLATE', 'OTHER',
] as const
type Category = (typeof CATEGORIES)[number]

const CATEGORY_LABEL: Record<Category, string> = {
  TECHNICAL_NARRATIVE: 'Technical narrative',
  DIFFERENTIATOR: 'Differentiator',
  MANAGEMENT_APPROACH: 'Management approach',
  QUALITY_APPROACH: 'Quality approach',
  BOILERPLATE: 'Boilerplate',
  OTHER: 'Other',
}

const VERSION_TONE: Record<CapabilityNarrativeVersion['status'], 'success' | 'warning' | 'neutral'> = {
  APPROVED: 'success',
  DRAFT: 'warning',
  ARCHIVED: 'neutral',
}

const PANEL = 'bg-gray-900 border border-gray-800 rounded-xl p-4'
const INPUT = 'w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500'

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

function TagRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null
  return (
    <div className="flex gap-1.5 flex-wrap items-baseline">
      <span className="text-[10px] uppercase tracking-widest text-gray-600">{label}</span>
      {values.map((v) => (
        <span key={v} className="text-[11px] px-1.5 py-0.5 rounded bg-gray-800 border border-gray-700 text-gray-400 font-mono">{v}</span>
      ))}
    </div>
  )
}

/** One narrative, with its version history on demand. */
function NarrativeCard({ n, isAdmin, onChanged }: {
  n: CapabilityNarrative
  isAdmin: boolean
  onChanged: () => Promise<void> | void
}) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ content: '', sourceReferences: '' })

  const approved = n.versions.find((v) => v.id === n.currentApprovedVersionId)
  const latest = n.versions[0]

  const addVersion = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await proposalAgentApi.addVersion(n.id, {
        content: draft.content,
        sourceReferences: csv(draft.sourceReferences),
      })
      toast('Draft version saved. It is not quotable until approved.', 'success')
      setDraft({ content: '', sourceReferences: '' })
      setDrafting(false)
      setOpen(true)
      await onChanged()
    } catch (err) {
      toast(readError(err, 'Could not save that version.'), 'error')
    } finally { setBusy(false) }
  }

  const approve = async (versionId: string, versionNumber: number) => {
    if (!window.confirm(
      `Approve version ${versionNumber}?\n\nThis becomes the wording the firm stands behind and the only text an agent may quote. The previous approved version is superseded, not deleted.`,
    )) return
    setBusy(true)
    try {
      await proposalAgentApi.approveVersion(versionId)
      toast(`Version ${versionNumber} approved.`, 'success')
      await onChanged()
    } catch (err) {
      toast(readError(err, 'Could not approve that version.'), 'error')
    } finally { setBusy(false) }
  }

  const archive = async () => {
    if (!window.confirm(`Archive "${n.title}"? Its versions stay readable.`)) return
    setBusy(true)
    try {
      await proposalAgentApi.archiveNarrative(n.id)
      toast('Narrative archived.', 'success')
      await onChanged()
    } catch (err) {
      toast(readError(err, 'Could not archive that narrative.'), 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className={PANEL}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
            className="flex items-center gap-1.5 text-left text-sm font-semibold text-gray-100 hover:text-blue-300">
            {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            {n.title}
          </button>
          <div className="flex items-center gap-2 flex-wrap mt-1.5">
            <Badge tone="neutral">{CATEGORY_LABEL[n.category as Category] ?? n.category}</Badge>
            {approved
              ? <Badge tone="success">APPROVED v{approved.versionNumber}</Badge>
              : <Badge tone="warning">NOT YET APPROVED</Badge>}
            {n.status !== 'ACTIVE' && <Badge tone="neutral">{n.status}</Badge>}
            <span className="text-[11px] text-gray-600">{n.versions.length} version(s) · updated {fmtDate(n.updatedAt)}</span>
          </div>
        </div>
        {isAdmin && n.status === 'ACTIVE' && (
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={() => setDrafting((v) => !v)} disabled={busy}
              className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
              {drafting ? 'Cancel' : 'New version'}
            </button>
            <button onClick={() => void archive()} disabled={busy}
              className="text-[11px] px-2 py-1 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-800 disabled:opacity-50">
              Archive
            </button>
          </div>
        )}
      </div>

      <div className="mt-2 space-y-1">
        <TagRow label="Capabilities" values={n.capabilityKeys} />
        <TagRow label="NAICS" values={n.naicsCodes} />
        <TagRow label="Agencies" values={n.agencyTags} />
        <TagRow label="Tags" values={n.tags} />
      </div>

      {!approved && latest && (
        <p className="text-[11px] text-amber-500/80 mt-2">
          The most recent wording is a draft. Until a version is approved, nothing here may be quoted as a firm claim.
        </p>
      )}

      {drafting && isAdmin && (
        <form onSubmit={addVersion} className="mt-3 space-y-2">
          <textarea required aria-label="Version content" rows={8} value={draft.content}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            placeholder="The narrative text as it should appear in a proposal…"
            className={INPUT} />
          <input aria-label="Source references" value={draft.sourceReferences}
            onChange={(e) => setDraft({ ...draft, sourceReferences: e.target.value })}
            placeholder="Where these claims come from, comma separated (e.g. CPARS 2025, ISO 27001 cert)"
            className={INPUT} />
          <div className="flex items-center gap-3">
            <button type="submit" disabled={busy}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50">
              {busy ? 'Saving…' : 'Save as draft'}
            </button>
            <p className="text-[11px] text-gray-600">Saving never approves. Approval is a separate act.</p>
          </div>
        </form>
      )}

      {open && (
        <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
          {n.versions.length === 0 ? (
            <p className="text-[12px] text-gray-500">No wording has been written yet.</p>
          ) : n.versions.map((v) => (
            <div key={v.id} className="bg-gray-950/50 border border-gray-800 rounded-lg p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12px] font-mono text-gray-300">v{v.versionNumber}</span>
                <Badge tone={VERSION_TONE[v.status]}>{v.status}</Badge>
                <span className="text-[11px] text-gray-600">{fmtDate(v.createdAt)}</span>
                {v.approvedAt && <span className="text-[11px] text-gray-600">approved {fmtDate(v.approvedAt)}</span>}
                {isAdmin && v.status === 'DRAFT' && (
                  <button onClick={() => void approve(v.id, v.versionNumber)} disabled={busy}
                    className="ml-auto text-[11px] px-2 py-1 rounded bg-green-900/40 hover:bg-green-900/60 text-green-300 border border-green-800 disabled:opacity-50 flex items-center gap-1">
                    <Check className="w-3 h-3" /> Approve
                  </button>
                )}
              </div>
              <p className="text-[12px] text-gray-300 mt-2 whitespace-pre-wrap">{v.content}</p>
              {v.sourceReferences.length > 0 && (
                <p className="text-[11px] text-gray-600 mt-2">Sources: {v.sourceReferences.join(' · ')}</p>
              )}
              <p className="text-[10px] text-gray-700 mt-1 font-mono">hash {v.contentHash.slice(0, 16)}…</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function CapabilityLibrary() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const { toast } = useToast()

  const [narratives, setNarratives] = useState<CapabilityNarrative[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [f, setF] = useState({
    title: '', category: 'TECHNICAL_NARRATIVE' as Category,
    capabilityKeys: '', naicsCodes: '', agencyTags: '', tags: '',
  })

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await proposalAgentApi.library(includeArchived)
      setNarratives(res.narratives)
    } catch (err) {
      setError(readError(err, 'Could not load the capability library.'))
    } finally { setLoading(false) }
  }, [includeArchived])
  useEffect(() => { void load() }, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      await proposalAgentApi.createNarrative({
        title: f.title, category: f.category,
        capabilityKeys: csv(f.capabilityKeys), naicsCodes: csv(f.naicsCodes),
        agencyTags: csv(f.agencyTags), tags: csv(f.tags),
      })
      toast('Narrative created. Add wording, then approve it.', 'success')
      setCreating(false)
      setF({ title: '', category: 'TECHNICAL_NARRATIVE', capabilityKeys: '', naicsCodes: '', agencyTags: '', tags: '' })
      await load()
    } catch (err) {
      toast(readError(err, 'Could not create that narrative.'), 'error')
    }
  }

  const unapproved = narratives.filter((n) => !n.currentApprovedVersionId && n.status === 'ACTIVE').length

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
      <PageHeader
        title="Capability library"
        subtitle="Reusable technical narratives, differentiators and approved boilerplate — with the approved wording kept apart from the drafts."
      />

      <div className="flex items-center gap-3 flex-wrap">
        {isAdmin && (
          <button onClick={() => setCreating((v) => !v)}
            className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> {creating ? 'Cancel' : 'New narrative'}
          </button>
        )}
        <label className="flex items-center gap-2 text-[12px] text-gray-400">
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          Show archived
        </label>
        {unapproved > 0 && (
          <span className="text-[11px] text-amber-500/80">
            {unapproved} narrative{unapproved === 1 ? '' : 's'} ha{unapproved === 1 ? 's' : 've'} no approved wording yet.
          </span>
        )}
      </div>

      {isAdmin && creating && (
        <form onSubmit={create} className={`${PANEL} space-y-3`}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input required aria-label="Title" placeholder="Title *" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} className={INPUT} />
            <select aria-label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value as Category })} className={INPUT}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
            <input aria-label="Capability keys" placeholder="Capabilities, comma separated" value={f.capabilityKeys} onChange={(e) => setF({ ...f, capabilityKeys: e.target.value })} className={INPUT} />
            <input aria-label="NAICS codes" placeholder="NAICS codes, comma separated" value={f.naicsCodes} onChange={(e) => setF({ ...f, naicsCodes: e.target.value })} className={INPUT} />
            <input aria-label="Agency tags" placeholder="Agencies, comma separated" value={f.agencyTags} onChange={(e) => setF({ ...f, agencyTags: e.target.value })} className={INPUT} />
            <input aria-label="Tags" placeholder="Tags, comma separated" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} className={INPUT} />
          </div>
          <div className="flex items-center gap-3">
            <button type="submit" className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700">
              Create narrative
            </button>
            <p className="text-[11px] text-gray-600">
              These tags are how the right narrative is found for an opportunity, so they are worth filling in.
            </p>
          </div>
        </form>
      )}

      {loading ? <Spinner /> : error ? <ErrorPanel message={error} onRetry={load} /> : narratives.length === 0 ? (
        <EmptyPanel
          message="The capability library is empty."
          hint="Start with the narratives you already reuse — your technical approach, your differentiators, your standard boilerplate."
        />
      ) : (
        <div className="space-y-3">
          {narratives.map((n) => <NarrativeCard key={n.id} n={n} isAdmin={isAdmin} onChanged={load} />)}
        </div>
      )}

      <div className={PANEL}>
        <p className="text-[11px] uppercase tracking-widest text-gray-500 mb-2 flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5" /> How this library is used
        </p>
        <ul className="space-y-1.5 text-[12px] text-gray-400">
          <li>· Only an APPROVED version may be quoted as something the firm claims. A draft never is.</li>
          <li>· Approving a new version supersedes the previous one rather than deleting it, so wording used in an earlier proposal stays readable.</li>
          <li>· Every version stores a content hash, so text that was quoted can be matched back to the exact version it came from.</li>
          <li>· Source references travel with the wording, which is what makes a claim traceable rather than merely well written.</li>
        </ul>
      </div>
    </div>
  )
}
