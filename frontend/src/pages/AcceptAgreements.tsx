import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { FileText, Loader, ArrowLeft } from 'lucide-react'
import { AuthShell, AuthHeading, AuthNotice } from '../components/auth/AuthShell'
import { authApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'

interface LegalDoc {
  version: string
  title: string
  contentHash: string
  body: string
  effectiveAt: string
}

interface LegalPayload {
  tos: LegalDoc
}

/**
 * Login gate-2 — accept current ToS. Reached when login
 * returns code='AGREEMENT_REQUIRED' with a scoped completionToken.
 *
 * Loads the current docs from /api/auth/legal/current, displays each
 * with its version pinned, and on submit calls /complete-agreements.
 * On success the endpoint returns a full session ({ token, user, firm }).
 */
export function AcceptAgreementsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login } = useAuth()
  const { toast } = useToast()

  const navState = (location.state ?? {}) as {
    completionToken?: string
    email?: string
  }
  const completionToken = navState.completionToken

  const [docs, setDocs] = useState<LegalPayload | null>(null)
  const [tosOk, setTosOk] = useState(false)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!completionToken) {
      setError('Missing completion token. Please sign in again.')
      setLoading(false)
      return
    }
    let cancelled = false
    authApi
      .legalCurrent()
      .then((res) => {
        if (cancelled) return
        if (res?.success && res?.data) {
          setDocs(res.data)
        } else {
          setError('Could not load the current legal documents.')
        }
      })
      .catch(() => {
        if (!cancelled) setError('Could not load the current legal documents.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [completionToken])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!docs || !completionToken) return
    if (!tosOk) {
      setError('Please accept the Terms of Service before continuing.')
      return
    }
    setError('')
    setSubmitting(true)
    try {
      const res = await authApi.completeAgreements(docs.tos.version, completionToken)
      if (res?.success && res?.data?.token) {
        login(res.data.token, res.data.user, res.data.firm)
        toast('Agreements recorded — welcome.', 'success')
        navigate('/dashboard')
        return
      }
      setError(res?.error || 'Could not complete agreement acceptance.')
    } catch (err: any) {
      const code = err?.response?.data?.code
      const data = err?.response?.data
      if (code === 'TOS_VERSION_MISMATCH' || code === 'NDA_VERSION_MISMATCH') {
        setError('The legal documents were updated again while this page was open. Reloading…')
        setTimeout(() => window.location.reload(), 1200)
        return
      }
      if (code === 'MFA_REQUIRED') {
        // ToS accepted, but this account has 2FA enabled — forward to the challenge.
        navigate('/mfa-challenge', { state: { mfaChallengeToken: data?.mfaChallengeToken } })
        return
      }
      setError(data?.error || err?.message || 'Submission failed.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AuthShell wide>
        <AuthHeading title="Updated agreements">
          Our Terms of Service have been updated since you last signed in.
          Review and accept the current version to continue.
        </AuthHeading>

        {loading && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <Loader className="w-4 h-4 animate-spin" aria-hidden="true" /> Loading documents…
          </div>
        )}

        {!loading && error && !docs && (
          <AuthNotice>
            <p>{error}</p>
            <button
              onClick={() => navigate('/login')}
              className="mt-2 text-[13px] font-semibold underline inline-flex items-center gap-1"
            >
              <ArrowLeft className="w-3 h-3" aria-hidden="true" /> Back to sign in
            </button>
          </AuthNotice>
        )}

        {!loading && docs && (
          <form onSubmit={handleSubmit} className="space-y-6">
            <DocumentBlock
              icon={<FileText className="w-4 h-4" style={{ color: 'var(--text-muted)' }} aria-hidden="true" />}
              title={docs.tos.title}
              version={docs.tos.version}
              effectiveAt={docs.tos.effectiveAt}
              body={docs.tos.body}
              checked={tosOk}
              onChange={setTosOk}
              ariaLabel="Accept Terms of Service"
              checkboxLabel={`I have read and accept the Terms of Service v${docs.tos.version}.`}
            />

            {error && <AuthNotice>{error}</AuthNotice>}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => navigate('/login')}
                className="btn-ghost"
                disabled={submitting}
              >
                <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to sign in
              </button>
              <button
                type="submit"
                disabled={submitting || !tosOk}
                className="btn-primary flex items-center gap-2"
              >
                {submitting ? (
                  <>
                    <Loader className="w-4 h-4 animate-spin" aria-hidden="true" /> Recording…
                  </>
                ) : (
                  <>Accept and continue</>
                )}
              </button>
            </div>
          </form>
        )}
    </AuthShell>
  )
}

interface DocumentBlockProps {
  icon: React.ReactNode
  title: string
  version: string
  effectiveAt: string
  body: string
  checked: boolean
  onChange: (next: boolean) => void
  ariaLabel: string
  checkboxLabel: string
}

function DocumentBlock({ icon, title, version, effectiveAt, body, checked, onChange, ariaLabel, checkboxLabel }: DocumentBlockProps) {
  return (
    <section
      className="rounded-2xl overflow-hidden"
      style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
        <div className="flex items-center gap-2">
          {icon}
          <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{title}</h2>
        </div>
        <div className="text-[12px] tabular-nums" style={{ color: 'var(--text-muted)' }}>
          Version {version}, effective {new Date(effectiveAt).toLocaleDateString()}
        </div>
      </header>
      <div
        className="px-4 py-3 text-[13px] whitespace-pre-wrap leading-relaxed overflow-y-auto"
        style={{ maxHeight: '14rem', color: 'var(--text-2)' }}
      >
        {body}
      </div>
      <label className="flex items-start gap-3 px-4 py-3 cursor-pointer" style={{ background: 'var(--surface)', borderTop: '1px solid var(--line)' }}>
        <input
          type="checkbox"
          aria-label={ariaLabel}
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 cursor-pointer"
        />
        <span className="text-[13px]" style={{ color: 'var(--text-2)' }}>{checkboxLabel}</span>
      </label>
    </section>
  )
}

export default AcceptAgreementsPage
