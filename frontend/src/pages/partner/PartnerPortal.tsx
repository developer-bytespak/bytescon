// =============================================================
// §8.3 / §8.4 — Partner / subcontractor portal (external).
//
// A deliberately small, task-focused surface. It renders no internal
// navigation, no analytics and no prime-side figures — an external user sees
// only the engagements they were granted and the work asked of them.
//
// Every screen that touches a prime record says what actually happens: a
// deliverable response is submitted for review, a profile edit is proposed
// rather than applied, and an invoice becomes a cost only when the prime
// approves it. The wording is part of the design, not decoration.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { useTabParam } from '../../hooks/useTabParam'
import {
  clearPartnerAuth, loadPartnerAuth, partnerPortalApi, savePartnerAuth,
  type Engagements, type PartnerAuth, type PartnerDeliverable, type PartnerDeliverableDetail,
  type PartnerPoDetail, type PartnerProfile,
} from '../../services/partnerPortalApi'

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const usd = (v: string) => `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')

const CTA = { background: 'linear-gradient(90deg,#7b8fff,#5b74ff)' }
const PANEL = 'bg-gray-900 border border-gray-800 rounded-xl p-4'

type PortalTab = 'engagements' | 'deliverables' | 'documents' | 'profile' | 'security'

const PORTAL_TABS: Array<[PortalTab, string]> = [
  ['engagements', 'Engagements'], ['deliverables', 'Deliverables'],
  ['documents', 'Documents'], ['profile', 'Profile'], ['security', 'Security'],
]

export function PartnerLoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [challengeToken, setChallengeToken] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [forgot, setForgot] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const result = await partnerPortalApi.login(email.trim(), password)
      if ('mfaRequired' in result) {
        setChallengeToken(result.mfaChallengeToken)
        setNotice('Enter the code from your authenticator app.')
        return
      }
      savePartnerAuth(result)
      window.location.href = '/partner'
    } catch (err) {
      setError(readError(err, 'Invalid credentials'))
    } finally { setBusy(false) }
  }

  const verify = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      savePartnerAuth(await partnerPortalApi.verifyMfa(challengeToken!, code.trim()))
      window.location.href = '/partner'
    } catch (err) {
      setError(readError(err, 'That code was not accepted.'))
    } finally { setBusy(false) }
  }

  const requestReset = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const res = await partnerPortalApi.forgotPassword(email.trim())
      setNotice(res.message)
    } catch {
      // The endpoint answers identically either way; a failure here is a
      // network problem, not a signal about the address.
      setNotice('If that email address has a portal account, a reset link has been sent to it.')
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      {challengeToken ? (
        <form onSubmit={verify} className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
          <h1 className="text-lg font-semibold text-gray-100">Two-factor code</h1>
          <p className="text-[12px] text-gray-500">Enter the six-digit code, or one of your recovery codes.</p>
          <input aria-label="Authentication code" className="input w-full" placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
          {error && <p className="text-[12px] text-red-400">{error}</p>}
          <button type="submit" disabled={busy || !code.trim()}
            className="w-full text-sm px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
        </form>
      ) : forgot ? (
        <form onSubmit={requestReset} className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
          <h1 className="text-lg font-semibold text-gray-100">Reset your password</h1>
          <p className="text-[12px] text-gray-500">We will email a link if the address has a portal account.</p>
          <input aria-label="Email" className="input w-full" placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          {notice && <p className="text-[12px] text-gray-400">{notice}</p>}
          <button type="submit" disabled={busy || !email.trim()}
            className="w-full text-sm px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
            {busy ? 'Sending…' : 'Send reset link'}
          </button>
          <button type="button" onClick={() => { setForgot(false); setNotice(null) }}
            className="w-full text-xs text-gray-500 hover:text-gray-300">Back to sign in</button>
        </form>
      ) : (
        <form onSubmit={submit} className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
          <h1 className="text-lg font-semibold text-gray-100">Subcontractor portal</h1>
          <p className="text-[12px] text-gray-500">Sign in with the account your prime contractor invited.</p>
          <input aria-label="Email" className="input w-full" placeholder="Email" value={email}
            onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          <input aria-label="Password" type="password" className="input w-full" placeholder="Password" value={password}
            onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          {error && <p className="text-[12px] text-red-400">{error}</p>}
          <button type="submit" disabled={busy || !email.trim() || !password}
            className="w-full text-sm px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <button type="button" onClick={() => setForgot(true)}
            className="w-full text-xs text-gray-500 hover:text-gray-300">Forgot your password?</button>
        </form>
      )}
    </div>
  )
}

/**
 * Where an invited subcontractor sets their password.
 *
 * The invite token in the URL is the credential, so this page is deliberately
 * signed out and asks for nothing else: a person who holds the link the prime
 * sent them can finish, and nobody else can. The token is single-use — the
 * server clears it on acceptance — so a forwarded link cannot be replayed.
 */
export function PartnerAcceptInvitePage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) { setError('Those passwords do not match.'); return }
    setBusy(true); setError(null)
    try {
      await partnerPortalApi.acceptInvite(token, password)
      setDone(true)
    } catch (err) {
      setError(readError(err, 'That invitation is invalid or has expired. Ask your prime contractor for a new one.'))
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
        <h1 className="text-lg font-semibold text-gray-100">Set up your portal account</h1>
        {done ? (
          <>
            <p className="text-[12px] text-gray-400">
              Your account is ready. Sign in to see the work your prime contractor has shared with you.
            </p>
            <a href="/partner/login" className="block text-center text-sm px-4 py-2 rounded text-gray-950 font-medium" style={CTA}>
              Sign in
            </a>
          </>
        ) : !token ? (
          <p className="text-[12px] text-red-400">
            This link is missing its invitation code. Use the full link your prime contractor sent you.
          </p>
        ) : (
          <>
            <p className="text-[12px] text-gray-500">Choose a password of at least 12 characters.</p>
            <input aria-label="Password" type="password" className="input w-full" placeholder="Password"
              value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <input aria-label="Confirm password" type="password" className="input w-full" placeholder="Confirm password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            {error && <p className="text-[12px] text-red-400">{error}</p>}
            <button type="submit" disabled={busy || password.length < 12}
              className="w-full text-sm px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
              {busy ? 'Setting up…' : 'Create my account'}
            </button>
          </>
        )}
      </form>
    </div>
  )
}

/** Consumes the emailed token. A separate page so the link works signed out. */
export function PartnerResetPasswordPage() {
  const token = new URLSearchParams(window.location.search).get('token') ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password !== confirm) { setError('Those passwords do not match.'); return }
    setBusy(true); setError(null)
    try {
      await partnerPortalApi.resetPassword(token, password)
      setDone(true)
    } catch (err) {
      setError(readError(err, 'That reset link is invalid or has expired.'))
    } finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-3">
        <h1 className="text-lg font-semibold text-gray-100">Choose a new password</h1>
        {done ? (
          <>
            <p className="text-[12px] text-gray-400">Your password has been changed. Any other sessions were signed out.</p>
            <a href="/partner/login" className="block text-center text-sm px-4 py-2 rounded text-gray-950 font-medium" style={CTA}>
              Sign in
            </a>
          </>
        ) : (
          <>
            <p className="text-[12px] text-gray-500">At least 12 characters.</p>
            <input aria-label="New password" type="password" className="input w-full" placeholder="New password"
              value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            <input aria-label="Confirm password" type="password" className="input w-full" placeholder="Confirm password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            {error && <p className="text-[12px] text-red-400">{error}</p>}
            <button type="submit" disabled={busy || password.length < 12 || !token}
              className="w-full text-sm px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
              {busy ? 'Saving…' : 'Set password'}
            </button>
          </>
        )}
      </form>
    </div>
  )
}

function DeliverablesTab() {
  const [items, setItems] = useState<PartnerDeliverable[]>([])
  const [open, setOpen] = useState<PartnerDeliverableDetail | null>(null)
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setItems(await partnerPortalApi.deliverables() as PartnerDeliverable[]) }
    catch (err) { setError(readError(err, 'Could not load your deliverables.')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const openOne = async (id: string) => {
    setError(null)
    try {
      const detail = await partnerPortalApi.deliverable(id)
      setOpen(detail)
      setNote(detail.submissions[0]?.note ?? '')
    } catch (err) { setError(readError(err, 'You do not have access to that deliverable.')) }
  }

  const saveDraft = async () => {
    if (!open) return
    setBusy(true); setError(null)
    try {
      await partnerPortalApi.saveDeliverableDraft(open.id, note, file)
      setFile(null)
      await openOne(open.id)
    } catch (err) { setError(readError(err, 'Could not save your draft.')) }
    finally { setBusy(false) }
  }

  const submit = async (submissionId: string) => {
    setBusy(true); setError(null)
    try {
      await partnerPortalApi.submitDeliverable(submissionId)
      if (open) await openOne(open.id)
    } catch (err) { setError(readError(err, 'Could not submit your response.')) }
    finally { setBusy(false) }
  }

  if (items.length === 0) {
    return <div className={`${PANEL} text-center`}>
      <p className="text-sm text-gray-300">No deliverables have been assigned to you.</p>
    </div>
  }

  const draft = open?.submissions.find((s) => s.status === 'DRAFT' || s.status === 'CHANGES_REQUESTED')

  return (
    <div className="space-y-3">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {items.map((d) => (
        <button key={d.id} onClick={() => void openOne(d.id)}
          className="w-full text-left bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm text-gray-100">{d.name}</span>
            <span className="text-[11px] font-mono text-gray-400">Due {fmt(d.dueDate)}</span>
          </div>
          {d.cdrlNumber && <p className="text-[11px] text-gray-500 mt-1">CDRL {d.cdrlNumber}</p>}
        </button>
      ))}

      {open && (
        <section className={PANEL}>
          <h2 className="text-sm font-semibold text-gray-300">{open.name}</h2>
          <p className="text-[11px] text-gray-500 mt-1">Prime status: {open.primeStatus}</p>
          {open.description && <p className="text-[12px] text-gray-400 mt-2">{open.description}</p>}

          <div className="mt-3 space-y-2">
            <textarea aria-label="Submission note" className="input w-full h-24" placeholder="What are you submitting?"
              value={note} onChange={(e) => setNote(e.target.value)} />
            <input aria-label="Response file" type="file"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-[12px] text-gray-400" />
            <div className="flex gap-2 flex-wrap">
              <button onClick={() => void saveDraft()} disabled={busy}
                className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
                Save draft
              </button>
              {draft && (
                <button onClick={() => void submit(draft.id)} disabled={busy}
                  className="text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
                  Submit for review
                </button>
              )}
            </div>
          </div>

          {open.submissions.length > 0 && (
            <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
              {open.submissions.map((s) => (
                <div key={s.id} className="text-[12px] text-gray-400">
                  <div className="flex gap-3 flex-wrap items-center">
                    <span className="font-mono text-gray-300">{s.status}</span>
                    <span className="text-gray-600">{fmt(s.submittedAt ?? s.createdAt)}</span>
                    {s.fileName && (
                      <button onClick={() => void partnerPortalApi.downloadSubmission(s.id, s.fileName!)}
                        className="text-gray-500 hover:text-gray-300 underline">{s.fileName}</button>
                    )}
                  </div>
                  {s.reviewNotes && <p className="text-gray-500 mt-0.5">Prime review: {s.reviewNotes}</p>}
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-gray-600 mt-3">{open.note}</p>
        </section>
      )}
    </div>
  )
}

const DOCUMENT_CATEGORIES = ['Insurance certificate', 'Signed subcontract', 'W-9', 'Certification', 'Technical response', 'Other']

/**
 * Upload against a granted engagement only. The scope list is built from the
 * grants themselves, so a partner cannot attach a file to work they were never
 * given — the picker offers nothing the server would accept.
 */
function DocumentUploadForm({ onUploaded }: { onUploaded: () => void }) {
  const [scopes, setScopes] = useState<Array<{ value: string; label: string }>>([])
  const [scope, setScope] = useState('')
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState(DOCUMENT_CATEGORIES[0])
  const [notes, setNotes] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const e = await partnerPortalApi.engagements()
        const opts = [
          ...e.contracts.map((c) => ({ value: `CONTRACT:${c.id}`, label: `Contract · ${c.contractNumber}` })),
          ...e.purchaseOrders.map((p) => ({ value: `PURCHASE_ORDER:${p.id}`, label: `Subcontract · ${p.poNumber}` })),
          ...e.opportunities.map((o) => ({ value: `OPPORTUNITY:${o.id}`, label: `Opportunity · ${o.title}` })),
        ]
        setScopes(opts)
        setScope(opts[0]?.value ?? '')
      } catch { setScopes([]) }
    })()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!file) { setError('Choose a file to upload.'); return }
    const [scopeType, scopeId] = scope.split(':')
    setBusy(true)
    try {
      await partnerPortalApi.uploadDocument({ scopeType, scopeId, category, title, notes: notes || undefined }, file)
      setTitle(''); setNotes(''); setFile(null)
      onUploaded()
    } catch (err) { setError(readError(err, 'Upload failed.')) }
    finally { setBusy(false) }
  }

  if (scopes.length === 0) {
    return (
      <div className={PANEL}>
        <p className="text-sm text-gray-300">Nothing has been shared with you yet, so there is nothing to upload against.</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className={`${PANEL} space-y-3`}>
      <p className="text-sm font-medium text-gray-200">Upload a document</p>
      <div className="grid md:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-[11px] text-gray-500">Engagement</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-yellow-600">
            {scopes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] text-gray-500">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-yellow-600">
            {DOCUMENT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>
      <label className="block">
        <span className="text-[11px] text-gray-500">Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-yellow-600" />
      </label>
      <label className="block">
        <span className="text-[11px] text-gray-500">Notes (optional)</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={2000}
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-yellow-600" />
      </label>
      <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-xs text-gray-400 file:mr-3 file:px-3 file:py-1.5 file:rounded file:border file:border-gray-700 file:bg-gray-800 file:text-gray-300" />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <button type="submit" disabled={busy} style={CTA}
        className="text-sm px-4 py-2 rounded-lg font-medium text-gray-900 disabled:opacity-50">
        {busy ? 'Uploading…' : 'Upload'}
      </button>
      <p className="text-[10px] text-gray-600">
        The prime contractor reviews what you send. It stays pending until someone there accepts it.
      </p>
    </form>
  )
}

function DocumentsTab() {
  const [docs, setDocs] = useState<Array<Record<string, unknown>>>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void (async () => {
      try { setDocs(await partnerPortalApi.documents() as Array<Record<string, unknown>>) }
      catch (err) { setError(readError(err, 'Could not load your documents.')) }
    })()
  }, [])

  useEffect(() => { load() }, [load])

  if (error) return <p className="text-sm text-red-400">{error}</p>

  return (
    <div className="space-y-3">
      <DocumentUploadForm onUploaded={load} />
      {docs.length === 0 && (
        <div className={`${PANEL} text-center`}><p className="text-sm text-gray-300">You have not uploaded any documents.</p></div>
      )}
      {docs.map((d) => (
        <div key={String(d.id)} className="bg-gray-900 border border-gray-800 rounded-lg p-3 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-sm text-gray-100">{String(d.title)}</p>
            <p className="text-[11px] text-gray-500">{String(d.category)} · {String(d.reviewStatus)}</p>
          </div>
          <button onClick={() => void partnerPortalApi.downloadDocument(String(d.id), String(d.fileName))}
            className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">
            Download
          </button>
        </div>
      ))}
    </div>
  )
}

function ProfileTab() {
  const [profile, setProfile] = useState<PartnerProfile | null>(null)
  const [form, setForm] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const p = await partnerPortalApi.profile()
      setProfile(p)
      setForm({
        website: p.partner.website ?? '', geography: p.partner.geography ?? '',
        contactName: p.partner.contactName ?? '', contactEmail: p.partner.contactEmail ?? '',
        contactPhone: p.partner.contactPhone ?? '',
      })
    } catch (err) { setError(readError(err, 'Could not load your profile.')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const propose = async () => {
    setBusy(true); setError(null); setSaved(false)
    try {
      const proposed: Record<string, string> = {}
      for (const [k, v] of Object.entries(form)) if (v.trim().length > 0) proposed[k] = v.trim()
      await partnerPortalApi.proposeProfileChange(proposed)
      setSaved(true)
      await load()
    } catch (err) { setError(readError(err, 'Could not submit your change.')) }
    finally { setBusy(false) }
  }

  if (!profile) return <p className="text-sm text-gray-500">Loading…</p>

  const pending = profile.changeRequests.find((r) => r.status === 'PENDING_REVIEW')

  return (
    <div className="space-y-3">
      <section className={PANEL}>
        <h2 className="text-sm font-semibold text-gray-300">{profile.partner.name}</h2>
        <p className="text-[11px] text-gray-500 mt-1">
          UEI {profile.partner.uei ?? '—'} · CAGE {profile.partner.cage ?? '—'}
        </p>
        <div className="mt-3 space-y-2">
          {(['website', 'geography', 'contactName', 'contactEmail', 'contactPhone'] as const).map((field) => (
            <label key={field} className="block">
              <span className="text-[11px] text-gray-500">{field}</span>
              <input aria-label={field} className="input w-full" value={form[field] ?? ''}
                onChange={(e) => setForm({ ...form, [field]: e.target.value })} />
            </label>
          ))}
        </div>
        {error && <p className="text-[12px] text-red-400 mt-2">{error}</p>}
        {saved && <p className="text-[12px] text-green-400 mt-2">Submitted for review.</p>}
        <button onClick={() => void propose()} disabled={busy || Boolean(pending)}
          className="mt-3 text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
          {pending ? 'A change is awaiting review' : 'Propose changes'}
        </button>
        <p className="text-[10px] text-gray-600 mt-3">{profile.note}</p>
      </section>

      {profile.changeRequests.length > 0 && (
        <section className={PANEL}>
          <h2 className="text-sm font-semibold text-gray-300 mb-2">Your change requests</h2>
          {profile.changeRequests.map((r) => (
            <div key={r.id} className="text-[12px] text-gray-400 flex gap-3 flex-wrap">
              <span className="font-mono text-gray-300">{r.status}</span>
              <span className="text-gray-600">{fmt(r.createdAt)}</span>
              {r.reviewNotes && <span>{r.reviewNotes}</span>}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

function SecurityTab() {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setEnabled((await partnerPortalApi.mfaStatus()).enabled) }
    catch (err) { setError(readError(err, 'Could not read your security settings.')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const start = async () => {
    setBusy(true); setError(null)
    try { setEnrollment(await partnerPortalApi.mfaEnroll()) }
    catch (err) { setError(readError(err, 'Could not start enrollment.')) }
    finally { setBusy(false) }
  }

  const confirm = async () => {
    setBusy(true); setError(null)
    try {
      const res = await partnerPortalApi.mfaConfirm(code.trim())
      setRecoveryCodes(res.recoveryCodes)
      setEnrollment(null); setCode('')
      await load()
    } catch (err) { setError(readError(err, 'That code was not accepted.')) }
    finally { setBusy(false) }
  }

  const disable = async () => {
    setBusy(true); setError(null)
    try { await partnerPortalApi.mfaDisable(code.trim()); setCode(''); await load() }
    catch (err) { setError(readError(err, 'That code was not accepted.')) }
    finally { setBusy(false) }
  }

  return (
    <section className={PANEL}>
      <h2 className="text-sm font-semibold text-gray-300">Two-factor authentication</h2>
      <p className="text-[12px] text-gray-500 mt-1">
        {enabled === null ? 'Loading…' : enabled ? 'On — a code is required at every sign-in.' : 'Off.'}
      </p>
      {error && <p className="text-[12px] text-red-400 mt-2">{error}</p>}

      {recoveryCodes && (
        <div className="mt-3 bg-gray-950 border border-amber-800 rounded-lg p-3">
          <p className="text-[12px] text-amber-300">Save these recovery codes now. They are not shown again.</p>
          <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-[12px] text-gray-300">
            {recoveryCodes.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
      )}

      {enabled === false && !enrollment && (
        <button onClick={() => void start()} disabled={busy}
          className="mt-3 text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
          Turn on two-factor
        </button>
      )}

      {enrollment && (
        <div className="mt-3 space-y-2">
          <p className="text-[12px] text-gray-400">Add this secret to your authenticator app, then enter the code it shows.</p>
          <p className="font-mono text-[12px] text-gray-300 break-all">{enrollment.secret}</p>
          <input aria-label="Authentication code" className="input w-full" placeholder="123456"
            value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={() => void confirm()} disabled={busy || !code.trim()}
            className="text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50" style={CTA}>
            Confirm
          </button>
        </div>
      )}

      {enabled === true && (
        <div className="mt-3 space-y-2">
          <input aria-label="Authentication code" className="input w-full" placeholder="Code to turn off"
            value={code} onChange={(e) => setCode(e.target.value)} />
          <button onClick={() => void disable()} disabled={busy || !code.trim()}
            className="text-xs px-3 py-1.5 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-700 disabled:opacity-50">
            Turn off two-factor
          </button>
        </div>
      )}
    </section>
  )
}

export default function PartnerPortalPage() {
  const [auth] = useState<PartnerAuth | null>(() => loadPartnerAuth())
  const [tab, setTab] = useTabParam(PORTAL_TABS.map(([key]) => key), 'engagements')
  const [data, setData] = useState<Engagements | null>(null)
  const [invoices, setInvoices] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [openPo, setOpenPo] = useState<PartnerPoDetail | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [e, inv] = await Promise.all([partnerPortalApi.engagements(), partnerPortalApi.invoices()])
      setData(e); setInvoices(inv as Array<Record<string, unknown>>)
    } catch (err) {
      setError(readError(err, 'Could not load your engagements.'))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { if (auth) void load() }, [auth, load])

  if (!auth) return <PartnerLoginPage />

  const brand = auth.branding?.brandingDisplayName ?? 'Prime contractor'

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between flex-wrap gap-2">
        <div>
          <p className="text-sm font-semibold text-gray-100">{brand}</p>
          <p className="text-[11px] text-gray-500">Subcontractor portal · {auth.user.firstName} {auth.user.lastName}</p>
        </div>
        <button onClick={() => { clearPartnerAuth(); window.location.href = '/partner/login' }}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">
          Sign out
        </button>
      </header>

      <nav className="max-w-4xl mx-auto px-6 pt-4 border-b border-gray-800 flex gap-1 flex-wrap">
        {PORTAL_TABS.map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm border-b-2 transition-colors ${
              tab === key ? 'border-amber-500 text-amber-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>
            {label}
          </button>
        ))}
      </nav>

      <main className="max-w-4xl mx-auto p-6 space-y-5">
        {tab === 'deliverables' && <DeliverablesTab />}
        {tab === 'documents' && <DocumentsTab />}
        {tab === 'profile' && <ProfileTab />}
        {tab === 'security' && <SecurityTab />}

        {tab === 'engagements' && (
          <>
            {loading && <p className="text-sm text-gray-500">Loading…</p>}
            {error && <p className="text-sm text-red-400">{error}</p>}

            {data && !loading && (
              <>
                {data.contracts.length === 0 && data.purchaseOrders.length === 0 && data.opportunities.length === 0 ? (
                  <div className={`${PANEL} text-center py-6`}>
                    <p className="text-sm text-gray-300">No engagements have been shared with you yet.</p>
                    <p className="text-[12px] text-gray-500 mt-1">
                      Your prime contractor grants access to each piece of work separately.
                    </p>
                  </div>
                ) : (
                  <>
                    {data.purchaseOrders.length > 0 && (
                      <section>
                        <h2 className="text-sm font-semibold text-gray-300 mb-2">Your subcontracts</h2>
                        <div className="space-y-2">
                          {data.purchaseOrders.map((po) => (
                            <button key={po.id}
                              onClick={async () => setOpenPo(await partnerPortalApi.purchaseOrder(po.id))}
                              className="w-full text-left bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4">
                              <div className="flex items-center justify-between gap-3 flex-wrap">
                                <span className="text-sm text-gray-100">{po.poNumber}</span>
                                <span className="text-[11px] font-mono text-gray-400">{po.status}</span>
                              </div>
                              <p className="text-[11px] text-gray-500 mt-1">Ceiling {usd(po.ceilingAmount)}</p>
                            </button>
                          ))}
                        </div>
                      </section>
                    )}

                    {data.contracts.length > 0 && (
                      <section>
                        <h2 className="text-sm font-semibold text-gray-300 mb-2">Contracts you support</h2>
                        {data.contracts.map((c) => (
                          <div key={c.id} className={PANEL}>
                            <p className="text-sm text-gray-100">{c.contractNumber}</p>
                            <p className="text-[11px] text-gray-500">{c.title}{c.agency ? ` · ${c.agency}` : ''}</p>
                          </div>
                        ))}
                      </section>
                    )}
                  </>
                )}

                <p className="text-[11px] text-gray-600">{data.note}</p>

                {openPo && (
                  <section className={PANEL}>
                    <h2 className="text-sm font-semibold text-gray-300 mb-2">{openPo.poNumber}</h2>
                    <div className="grid grid-cols-3 gap-3 text-[12px]">
                      <div><p className="text-gray-500">Ceiling</p><p className="font-mono">{usd(openPo.ceilingAmount)}</p></div>
                      <div><p className="text-gray-500">Invoiced</p><p className="font-mono">{usd(openPo.invoicedTotal)}</p></div>
                      <div><p className="text-gray-500">Remaining</p><p className="font-mono">{usd(openPo.remainingBalance)}</p></div>
                    </div>
                    {openPo.invoices.length > 0 && (
                      <div className="mt-3 pt-3 border-t border-gray-800 space-y-1">
                        {openPo.invoices.map((i) => (
                          <div key={i.id} className="text-[12px] text-gray-400 flex gap-3 flex-wrap">
                            <span>{i.invoiceNumber}</span>
                            <span className="font-mono">{usd(i.amount)}</span>
                            <span>{i.status}</span>
                            <span className="text-gray-600">{fmt(i.invoiceDate)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="text-[10px] text-gray-600 mt-3">
                      Invoices are reviewed and paid by the prime contractor. Submitting one here does not record a payment.
                    </p>
                  </section>
                )}

                {invoices.length > 0 && (
                  <section>
                    <h2 className="text-sm font-semibold text-gray-300 mb-2">Your invoices</h2>
                    <div className="space-y-1">
                      {invoices.map((i) => (
                        <div key={String(i.id)} className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-[12px] flex gap-3 flex-wrap">
                          <span className="text-gray-200">{String(i.invoiceNumber)}</span>
                          <span className="font-mono text-gray-400">{usd(String(i.amount))}</span>
                          <span className="text-gray-500">{String(i.status)}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
