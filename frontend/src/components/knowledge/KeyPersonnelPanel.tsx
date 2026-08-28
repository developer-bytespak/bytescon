// =============================================================
// §8.3 — Key personnel named on a proposal.
//
// Only an APPROVED resume version may be attached. That rule lives in the
// backend, but the picker enforces it too: offering a draft and then failing
// the save teaches people that the rule is arbitrary, when in fact it is the
// point — a proposal names a person against wording the firm stands behind.
//
// Each selection keeps both a snapshot and a live link to the exact resume
// version used, so what was submitted stays readable even after the person's
// resume moves on.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Plus, UserRound, X } from 'lucide-react'
import { Badge, EmptyPanel, ErrorPanel, LoadingPanel } from '../section6/Section6Ui'
import { useToast } from '../Toast'
import { personnelApi, type PersonnelSummary } from '../../services/knowledgeApi'

interface Selection {
  id: string
  proposalRole: string | null
  laborCategory: string | null
  personnel: { id: string; firstName: string; lastName: string; jobTitle: string | null; isArchived: boolean }
  resume: { id: string; versionNumber: number; status: string; approvedAt: string | null } | null
}

interface ResumeOption { id: string; versionNumber: number; status: string }

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const PANEL = 'bg-gray-900 border border-gray-800 rounded-xl p-4'
const INPUT = 'bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-[12px] text-gray-200 outline-none focus:border-blue-500'

export function KeyPersonnelPanel({ proposalId, canEdit }: { proposalId: string; canEdit: boolean }) {
  const { toast } = useToast()
  const [items, setItems] = useState<Selection[]>([])
  const [note, setNote] = useState('')
  const [people, setPeople] = useState<PersonnelSummary[]>([])
  const [resumes, setResumes] = useState<ResumeOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({ personnelId: '', resumeId: '', proposalRole: '', laborCategory: '' })

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await personnelApi.listKeyPersonnel(proposalId)
      setItems((res.items ?? []) as unknown as Selection[])
      setNote(res.provenanceNote ?? '')
    } catch (err) {
      setError(readError(err, 'Could not load key personnel.'))
    } finally { setLoading(false) }
  }, [proposalId])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!adding || people.length > 0) return
    void personnelApi.list().then(setPeople).catch(() => setPeople([]))
  }, [adding, people.length])

  // Resumes belong to the chosen person, so they are fetched per selection.
  useEffect(() => {
    if (!f.personnelId) { setResumes([]); return }
    let alive = true
    void personnelApi.get(f.personnelId)
      .then((d) => { if (alive) setResumes((d.resumes ?? []) as unknown as ResumeOption[]) })
      .catch(() => { if (alive) setResumes([]) })
    return () => { alive = false }
  }, [f.personnelId])

  const approvedResumes = resumes.filter((r) => r.status === 'APPROVED')

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await personnelApi.addKeyPersonnel(proposalId, {
        personnelId: f.personnelId,
        resumeId: f.resumeId || null,
        proposalRole: f.proposalRole || null,
        laborCategory: f.laborCategory || null,
      })
      toast('Person added to the proposal.', 'success')
      setF({ personnelId: '', resumeId: '', proposalRole: '', laborCategory: '' })
      setAdding(false)
      await load()
    } catch (err) {
      toast(readError(err, 'Could not add that person.'), 'error')
    } finally { setBusy(false) }
  }

  const remove = async (id: string, name: string) => {
    if (!window.confirm(`Remove ${name} from this proposal?`)) return
    setBusy(true)
    try {
      await personnelApi.removeKeyPersonnel(id)
      toast('Removed from the proposal.', 'success')
      await load()
    } catch (err) {
      toast(readError(err, 'Could not remove that person.'), 'error')
    } finally { setBusy(false) }
  }

  if (loading) return <LoadingPanel label="Loading key personnel…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-1.5">
          <UserRound className="w-4 h-4" /> Key personnel ({items.length})
        </h3>
        {canEdit && (
          <button onClick={() => setAdding((v) => !v)}
            className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 flex items-center gap-1">
            <Plus className="w-3 h-3" /> {adding ? 'Cancel' : 'Add person'}
          </button>
        )}
      </div>

      {canEdit && adding && (
        <form onSubmit={add} className={`${PANEL} grid grid-cols-1 md:grid-cols-2 gap-2`}>
          <select required aria-label="Person" value={f.personnelId}
            onChange={(e) => setF({ ...f, personnelId: e.target.value, resumeId: '' })} className={INPUT}>
            <option value="">Person *</option>
            {people.filter((p) => !p.isArchived).map((p) => (
              <option key={p.id} value={p.id}>{p.firstName} {p.lastName}{p.jobTitle ? ` — ${p.jobTitle}` : ''}</option>
            ))}
          </select>

          <select aria-label="Resume version" value={f.resumeId}
            onChange={(e) => setF({ ...f, resumeId: e.target.value })}
            disabled={!f.personnelId} className={INPUT}>
            <option value="">
              {!f.personnelId ? 'Choose a person first' : approvedResumes.length === 0 ? 'No approved resume' : 'Resume version (optional)'}
            </option>
            {approvedResumes.map((r) => <option key={r.id} value={r.id}>v{r.versionNumber} — approved</option>)}
          </select>

          <input aria-label="Proposal role" placeholder="Role on this proposal" value={f.proposalRole}
            onChange={(e) => setF({ ...f, proposalRole: e.target.value })} className={INPUT} />
          <input aria-label="Labour category" placeholder="Labour category" value={f.laborCategory}
            onChange={(e) => setF({ ...f, laborCategory: e.target.value })} className={INPUT} />

          {f.personnelId && approvedResumes.length === 0 && (
            <p className="md:col-span-2 text-[11px] text-amber-500/80">
              This person has no approved resume version. You can still name them, but nothing can be cited until a
              version is approved in the personnel library.
            </p>
          )}

          <button type="submit" disabled={busy || !f.personnelId}
            className="md:col-span-2 justify-self-start text-[11px] px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50">
            {busy ? 'Adding…' : 'Add to proposal'}
          </button>
        </form>
      )}

      {items.length === 0 ? (
        <EmptyPanel message="Nobody is named on this proposal yet." hint="Key personnel come from the personnel library, with the exact resume version recorded." />
      ) : (
        <div className="space-y-2">
          {items.map((k) => (
            <div key={k.id} className={`${PANEL} flex items-start justify-between gap-3 flex-wrap`}>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-gray-100">{k.personnel.firstName} {k.personnel.lastName}</span>
                  {k.resume
                    ? <Badge tone="success">RESUME v{k.resume.versionNumber}</Badge>
                    : <Badge tone="warning">NO RESUME CITED</Badge>}
                  {k.personnel.isArchived && <Badge tone="neutral">ARCHIVED</Badge>}
                </div>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {k.proposalRole ?? 'No role recorded'}
                  {k.laborCategory ? ` · ${k.laborCategory}` : ''}
                  {k.personnel.jobTitle ? ` · ${k.personnel.jobTitle}` : ''}
                </p>
              </div>
              {canEdit && (
                <button disabled={busy} onClick={() => void remove(k.id, `${k.personnel.firstName} ${k.personnel.lastName}`)}
                  aria-label={`Remove ${k.personnel.firstName} ${k.personnel.lastName}`}
                  className="text-gray-500 hover:text-red-300 disabled:opacity-50">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {note && <p className="text-[10px] text-gray-600">{note}</p>}
    </div>
  )
}
