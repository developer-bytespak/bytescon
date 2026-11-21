// =============================================================
// §8.3 — Personnel list and detail.
//
// Two honesty rules carried into the UI: a person with no approved resume shows
// "no approved resume" rather than a blank that reads as fine, and an
// unverified labour qualification is visibly unverified rather than presented
// as a claim the firm stands behind.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { humanize } from '../../lib/humanize'
import { Badge, EmptyPanel, ErrorPanel, LoadingPanel } from '../section6/Section6Ui'
import { useToast } from '../Toast'
import { firmApi, teamingApi } from '../../services/api'
import {
  personnelApi, EMPLOYMENT_TYPES, EMPLOYMENT_LABELS,
  type EmploymentType, type PersonnelDetail, type PersonnelSummary,
} from '../../services/knowledgeApi'

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export function PersonnelSection({ people, onChanged }: { people: PersonnelSummary[]; onChanged: () => void }) {
  const { toast } = useToast()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState({ firstName: '', lastName: '', jobTitle: '', employmentType: 'EMPLOYEE' as EmploymentType, sourcePartnerId: '' })
  const [subs, setSubs] = useState<Array<{ id: string; name: string; partnerType?: string }>>([])
  const isSubStaff = form.employmentType === 'SUBCONTRACTOR_STAFF'
  // Subcontractors are loaded only when someone is recorded as their staff.
  useEffect(() => {
    if (!isSubStaff || subs.length > 0) return
    void teamingApi.listPartners({ activeOnly: true })
      .then((r: { data?: { partners?: Array<{ id: string; name: string; partnerType?: string }> } }) => setSubs((r.data?.partners ?? []).filter((p) => p.partnerType !== 'PRIME')))
      .catch(() => setSubs([]))
  }, [isSubStaff, subs.length])
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)
  const [accounts, setAccounts] = useState<Array<{ id: string; firstName?: string; lastName?: string; email: string }>>([])

  // Loaded only when someone opens the importer. Most visits never need it.
  useEffect(() => {
    if (!importing || accounts.length > 0) return
    void firmApi.users().then((r) => setAccounts(r.data ?? r ?? [])).catch(() => setAccounts([]))
  }, [importing, accounts.length])

  const importUser = async (userId: string) => {
    try {
      await personnelApi.importFromUser(userId)
      toast('Person imported from the application account.', 'success')
      setImporting(false)
      onChanged()
    } catch (err) { toast(readError(err, 'Could not import that account.'), 'error') }
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.firstName.trim() || !form.lastName.trim()) return
    setSaving(true)
    try {
      await personnelApi.create({
        firstName: form.firstName.trim(), lastName: form.lastName.trim(),
        jobTitle: form.jobTitle.trim() || null, employmentType: form.employmentType,
        ...(isSubStaff ? { sourcePartnerId: form.sourcePartnerId } : {}),
      })
      setForm({ firstName: '', lastName: '', jobTitle: '', employmentType: 'EMPLOYEE', sourcePartnerId: '' })
      toast('Personnel added.', 'success')
      onChanged()
    } catch (err) { toast(readError(err, 'Could not add the person.'), 'error') }
    finally { setSaving(false) }
  }

  if (selectedId) return <PersonnelDetailView id={selectedId} onBack={() => { setSelectedId(null); onChanged() }} />

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <h3 className="text-base font-semibold text-gray-100">Import from an application account</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              `User` is who signs in; `Personnel` is who appears in a proposal. Importing links the two rather than
              turning one into the other.
            </p>
          </div>
          <button onClick={() => setImporting((v) => !v)}
            className="btn-secondary btn-sm">
            {importing ? 'Cancel' : 'Import'}
          </button>
        </div>
        {importing && (
          <div className="mt-3 flex gap-2 flex-wrap items-center">
            <select aria-label="Application account" defaultValue=""
              onChange={(e) => { if (e.target.value) void importUser(e.target.value) }}
              className="input">
              <option value="">Choose an account…</option>
              {accounts.map((u) => (
                <option key={u.id} value={u.id}>{[u.firstName, u.lastName].filter(Boolean).join(' ') || u.email}</option>
              ))}
            </select>
            {accounts.length === 0 && <span className="text-xs text-gray-500">No accounts available.</span>}
          </div>
        )}
      </div>

      <form onSubmit={create} className="card">
        <h3 className="text-base font-semibold text-gray-100 mb-3">Add a person</h3>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input aria-label="First name" className="input" placeholder="First name"
            value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          <input aria-label="Last name" className="input" placeholder="Last name"
            value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          <input aria-label="Job title" className="input" placeholder="Job title"
            value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
          <select aria-label="Employment type" className="input" value={form.employmentType}
            onChange={(e) => setForm({ ...form, employmentType: e.target.value as EmploymentType })}>
            {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{EMPLOYMENT_LABELS[t]}</option>)}
          </select>
          {isSubStaff && (
            <select aria-label="Subcontractor they work for" className="input md:col-span-2" value={form.sourcePartnerId}
              onChange={(e) => setForm({ ...form, sourcePartnerId: e.target.value })}>
              <option value="">Which subcontractor do they work for? *</option>
              {subs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
        {isSubStaff && subs.length === 0 && (
          <p className="text-xs text-amber-400 mt-2">Add the subcontractor under Subs &amp; Primes first, then record their staff here.</p>
        )}
        <button type="submit" disabled={saving || !form.firstName.trim() || !form.lastName.trim() || (isSubStaff && !form.sourcePartnerId)}
          className="mt-4 btn-primary btn-sm disabled:opacity-50">
          {saving ? 'Adding…' : 'Add person'}
        </button>
        <p className="text-xs text-gray-500 mt-2">
          A login is not required. Outside consultants and a subcontractor's staff you propose belong here too; for subcontractor staff, choose their company.
        </p>
        <p className="text-xs text-gray-500 mt-1">
          This form records who the person is. Their resume, qualifications and document live on their own page:
          add someone, then open them from the list below.
        </p>
      </form>

      <div className="space-y-2">
        {people.length === 0 && (
          <EmptyPanel
            message="Nobody is in the personnel library yet."
            hint="Add someone above, or import an application account. A login is not required: consultants and subcontractor staff belong here too."
          />
        )}
        {people.map((p) => (
          <button key={p.id} onClick={() => setSelectedId(p.id)}
            className="card-interactive w-full text-left !p-5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-base font-semibold text-gray-100">{p.firstName} {p.lastName}</span>
              <Badge tone="neutral">{EMPLOYMENT_LABELS[p.employmentType] ?? p.employmentType}</Badge>
              {p.source === 'PARTNER_SUBMITTED' && <Badge tone="warning">Partner submitted</Badge>}
              {p.isArchived && <Badge tone="neutral">Archived</Badge>}
              {p.resumes.length > 0
                ? <Badge tone="success">Approved resume v{p.resumes[0].versionNumber}</Badge>
                : <Badge tone="neutral">No approved resume</Badge>}
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {p.jobTitle ?? 'No title recorded'}
              {p.user ? ` · account ${p.user.email}` : ' · no linked account'}
            </p>
            <div className="flex gap-3 text-xs text-gray-500 mt-1 tabular-nums">
              <span>{p.qualifications.length} labour category(ies)</span>
              <span>{p._count?.proposalUses ?? 0} proposal use(s)</span>
              <span>{p._count?.allocations ?? 0} allocation(s)</span>
            </div>
            <p className="text-xs font-medium text-gray-200 mt-2 underline underline-offset-4 decoration-[var(--line-strong)]">
              {p.resumes.length > 0 ? 'Open to manage resume versions' : 'Open to add a resume'}
            </p>
          </button>
        ))}
      </div>
    </div>
  )
}

function PersonnelDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<PersonnelDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [qual, setQual] = useState('')
  const [resumeSummary, setResumeSummary] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData(await personnelApi.get(id)) }
    catch (err) { setError(readError(err, 'Could not load this person.')) }
    finally { setLoading(false) }
  }, [id])
  useEffect(() => { void load() }, [load])

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok, 'success'); await load() }
    catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      toast(e?.response?.status === 422 ? e.response.data?.error ?? 'Refused.' : readError(err, 'Action failed.'), 'error')
    }
  }

  if (loading) return <LoadingPanel label="Loading person…" />
  if (error || !data) return <ErrorPanel message={error ?? 'Not found.'} onRetry={load} />

  const archivePerson = () => {
    if (!window.confirm(`Archive ${data.firstName} ${data.lastName}? Their resumes stay readable, and any proposal that already names them is unaffected.`)) return
    void act(() => personnelApi.archive(data.id).then(onBack), 'Person archived.')
  }

  const approved = data.resumes.find((r) => r.status === 'APPROVED')

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="btn-ghost btn-sm -ml-2 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Back to personnel</button>

      <div className="card">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-lg font-semibold text-gray-100">{data.firstName} {data.lastName}</span>
          <Badge tone="neutral">{EMPLOYMENT_LABELS[data.employmentType] ?? data.employmentType}</Badge>
          {data.source === 'PARTNER_SUBMITTED' && <Badge tone="warning">Partner submitted</Badge>}
          <button onClick={archivePerson}
            className="ml-auto btn-danger btn-sm">
            Archive
          </button>
        </div>
        <p className="text-sm text-gray-400 mt-1">{data.jobTitle ?? 'No title recorded'}</p>
        <p className="text-xs text-gray-500 mt-1">
          {data.user ? `Linked account: ${data.user.email}` : 'No linked application account'}
          {' · '}
          {data.yearsExperience !== null ? `${data.yearsExperience} years recorded` : 'Years of experience not recorded'}
        </p>
      </div>

      <div className="card">
        <h4 className="text-base font-semibold text-gray-100 mb-3">Labour qualifications</h4>
        {data.qualifications.length === 0 ? (
          <p className="text-sm text-gray-500">No labour categories recorded.</p>
        ) : (
          <div className="space-y-1.5">
            {data.qualifications.map((q) => (
              <div key={q.id} className="flex items-center gap-2 flex-wrap text-sm">
                <span className="text-gray-200">{q.laborCategory}</span>
                <Badge tone={q.verification === 'VERIFIED' ? 'success' : q.verification === 'REJECTED' ? 'danger' : 'warning'}>
                  {q.verification}
                </Badge>
                {q.verification === 'UNVERIFIED' && (
                  <button onClick={() => act(() => personnelApi.verifyQualification(q.id, 'VERIFIED'), 'Qualification verified.')}
                    className="btn-secondary btn-sm">
                    Verify
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800">
          <input aria-label="Labour category" className="input flex-1" placeholder="Labour category"
            value={qual} onChange={(e) => setQual(e.target.value)} />
          <button disabled={!qual.trim()}
            onClick={() => act(() => personnelApi.addQualification(data.id, { laborCategory: qual.trim() }).then(() => setQual('')), 'Qualification recorded as unverified.')}
            className="btn-secondary btn-sm disabled:opacity-50">
            Add
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          A recorded category always starts unverified. Matching a job title is not evidence that someone qualifies.
        </p>
      </div>

      <div className="card">
        <h4 className="text-base font-semibold text-gray-100 mb-3">Resume versions</h4>
        {data.resumes.length === 0 ? (
          <p className="text-sm text-gray-500">No resume versions yet.</p>
        ) : (
          <div className="space-y-1.5">
            {data.resumes.map((r) => (
              <div key={r.id} className="flex items-center gap-2 flex-wrap text-sm">
                <span className="font-semibold tabular-nums text-gray-200">v{r.versionNumber}</span>
                <Badge tone={r.status === 'APPROVED' ? 'success' : r.status === 'DRAFT' ? 'info' : 'neutral'}>{humanize(r.status)}</Badge>
                <span className="text-gray-500">{r.status === 'APPROVED' ? `approved ${fmt(r.approvedAt)}` : fmt(r.createdAt)}</span>
                {r.fileName
                  ? (
                    <button onClick={() => void personnelApi.downloadResumeFile(r.id, r.fileName!)}
                      className="text-gray-400 hover:text-gray-200 underline decoration-dotted">
                      · {r.fileName}
                    </button>
                  )
                  : <span className="text-gray-600">· no document</span>}
                {r.status === 'DRAFT' && (
                  <>
                    {/* The document belongs to this VERSION. An approved version
                        refuses a replacement, so the control is offered only on a draft. */}
                    <label className="btn-secondary btn-sm cursor-pointer">
                      {r.fileName ? 'Replace document' : 'Attach document'}
                      <input type="file" aria-label={`Resume document for version ${r.versionNumber}`} className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0]
                          if (file) void act(() => personnelApi.uploadResumeFile(r.id, file), 'Document attached.')
                        }} />
                    </label>
                    <button onClick={() => act(() => personnelApi.approveResume(r.id), 'Resume approved.')}
                      className="btn-secondary btn-sm">
                      Approve
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 mt-3 pt-3 border-t border-gray-800 flex-wrap">
          <input aria-label="Resume summary" className="input flex-1 min-w-[200px]" placeholder="Professional summary (optional)"
            value={resumeSummary} onChange={(e) => setResumeSummary(e.target.value)} />
          <button
            onClick={() => act(() => personnelApi.createResume(data.id, resumeSummary.trim() ? { content: { summary: resumeSummary.trim() } } : {}).then(() => setResumeSummary('')), 'Draft version created.')}
            className="btn-secondary btn-sm">
            New draft
          </button>

          {/* Most resumes arrive as a finished document, so uploading one
              creates the draft it belongs to rather than demanding the person
              write a summary first. */}
          <label className="btn-secondary btn-sm cursor-pointer">
            Upload a resume document
            <input type="file" aria-label="Upload a resume document" className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (!file) return
                e.target.value = ''
                void act(async () => {
                  const version = await personnelApi.createResume(data.id, resumeSummary.trim() ? { content: { summary: resumeSummary.trim() } } : {})
                  await personnelApi.uploadResumeFile(version.id, file)
                  setResumeSummary('')
                }, 'Draft version created with the document attached.')
              }} />
          </label>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          A summary is optional: a document on its own is a perfectly good version. An approved version can never be
          edited: create a new version instead, because the approved one is the evidence a proposal was built on.
        </p>
      </div>

      <div className="card">
        <h4 className="text-base font-semibold text-gray-100 mb-3">Proposal usage</h4>
        {data.proposalUses.length === 0 ? (
          <p className="text-sm text-gray-500">Not used on any proposal yet.</p>
        ) : (
          data.proposalUses.map((u) => (
            <div key={u.id} className="text-sm text-gray-400">
              {u.proposal.title}{u.proposalRole ? ` (${u.proposalRole})` : ''}
              {u.resumeId === approved?.id ? ' (current approved resume)' : ''}
            </div>
          ))
        )}
      </div>

      <div className="card">
        <h4 className="text-base font-semibold text-gray-100 mb-3">Contract allocations</h4>
        {data.allocations.length === 0 ? (
          <p className="text-sm text-gray-500">No allocations recorded.</p>
        ) : (
          data.allocations.map((a) => (
            <div key={a.id} className="text-sm text-gray-400">
              {a.contract.contractNumber}: {a.allocationPercent}% from {fmt(a.startDate)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
