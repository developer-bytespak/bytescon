import { useEffect, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle, XCircle, MailQuestion, Loader2 } from 'lucide-react'
import { authApi } from '../services/api'

type Status = 'verifying' | 'success' | 'invalid' | 'no-token'

// Freshly-verified users just sign in and land on their dashboard. The Founders
// Lifetime offer is discoverable on the landing/billing pages — we don't push
// every new user toward it post-verification now that monthly plans are live.
const SIGN_IN_HREF = '/login'

/** A status icon in a tinted circle, coloured from the theme (light and dark). */
function StatusIcon({ tone, children }: { tone: 'success' | 'danger' | 'warning' | 'accent'; children: ReactNode }) {
  const colours = {
    success: { background: 'var(--success-bg)', color: 'var(--success)' },
    danger: { background: 'var(--danger-bg)', color: 'var(--danger)' },
    warning: { background: 'var(--warning-bg)', color: 'var(--warning)' },
    accent: { background: 'var(--accent-soft)', color: 'var(--accent)' },
  }[tone]
  return (
    <span className="inline-grid place-items-center w-14 h-14 rounded-full mx-auto mb-4" style={colours}>
      {children}
    </span>
  )
}

export function VerifyEmailPage() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')
  const [status, setStatus] = useState<Status>(token ? 'verifying' : 'no-token')
  const [errorMsg, setErrorMsg] = useState('')

  useEffect(() => {
    if (!token) return
    let cancelled = false
    authApi
      .verifyEmail(token)
      .then(() => {
        if (!cancelled) setStatus('success')
      })
      .catch((err) => {
        if (cancelled) return
        setErrorMsg(err.response?.data?.error || 'Invalid or expired verification link.')
        setStatus('invalid')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const heading = 'text-xl font-bold mb-2'
  const body = 'text-sm mb-6'

  return (
    <main
      className="min-h-screen flex items-center justify-center p-4 sm:p-8"
      style={{ background: 'var(--bg)' }}
    >
      <div
        role="status"
        className="w-full max-w-md rounded-2xl p-6 sm:p-8 text-center animate-fade-up flex flex-col items-center"
        style={{ background: 'var(--surface)', border: '1px solid var(--accent-line)', boxShadow: '0 12px 32px rgba(0,0,0,0.08)' }}
      >
        {status === 'verifying' && (
          <>
            <StatusIcon tone="accent"><Loader2 className="w-7 h-7 animate-spin" aria-hidden="true" /></StatusIcon>
            <h1 className={heading} style={{ color: 'var(--text)' }}>Verifying your email…</h1>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>One moment.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <StatusIcon tone="success"><CheckCircle className="w-7 h-7" aria-hidden="true" /></StatusIcon>
            <h1 className={heading} style={{ color: 'var(--text)' }}>Email verified</h1>
            <p className={body} style={{ color: 'var(--text-2)' }}>Your account is ready. Sign in to continue.</p>
            <Link to={SIGN_IN_HREF} className="btn-primary inline-block px-6 py-2.5 text-sm">Sign in →</Link>
          </>
        )}

        {status === 'invalid' && (
          <>
            <StatusIcon tone="danger"><XCircle className="w-7 h-7" aria-hidden="true" /></StatusIcon>
            <h1 className={heading} style={{ color: 'var(--text)' }}>Verification failed</h1>
            <p className={body} style={{ color: 'var(--text-2)' }}>{errorMsg}</p>
            <div className="flex flex-wrap justify-center gap-3">
              <Link to="/login" className="btn-secondary inline-block px-6 py-2.5 text-sm">Back to sign in</Link>
              <Link to="/register" className="btn-primary inline-block px-6 py-2.5 text-sm">Re-register</Link>
            </div>
          </>
        )}

        {status === 'no-token' && (
          <>
            <StatusIcon tone="warning"><MailQuestion className="w-7 h-7" aria-hidden="true" /></StatusIcon>
            <h1 className={heading} style={{ color: 'var(--text)' }}>Missing verification token</h1>
            <p className={body} style={{ color: 'var(--text-2)' }}>Open the link from your verification email to confirm your address.</p>
            <Link to="/login" className="btn-primary inline-block px-6 py-2.5 text-sm">Go to sign in</Link>
          </>
        )}
      </div>
    </main>
  )
}

export default VerifyEmailPage
