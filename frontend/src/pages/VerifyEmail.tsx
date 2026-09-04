import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CheckCircle, XCircle, MailQuestion } from 'lucide-react'
import { authApi } from '../services/api'

type Status = 'verifying' | 'success' | 'invalid' | 'no-token'

// Freshly-verified users just sign in and land on their dashboard. The Founders
// Lifetime offer is discoverable on the landing/billing pages — we don't push
// every new user toward it post-verification now that monthly plans are live.
const SIGN_IN_HREF = '/login'

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

  return (
    <main
      className="min-h-screen flex items-center justify-center p-8"
      style={{ background: '#0b0b0f' }}
    >
      <div
        className="w-full max-w-md rounded-xl p-8 text-center"
        style={{ background: 'rgba(19,19,24,0.6)', border: '1px solid rgba(91,116,255,0.25)' }}
      >
        {status === 'verifying' && (
          <>
            <h1 className="text-xl font-bold text-slate-100 mb-2">Verifying your email…</h1>
            <p className="text-sm text-slate-400">One moment.</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-3" aria-hidden="true" />
            <h1 className="text-xl font-bold text-slate-100 mb-2">Email verified</h1>
            <p className="text-sm text-slate-400 mb-5">Your account is ready. Sign in to continue.</p>
            <Link to={SIGN_IN_HREF} className="btn-primary inline-block px-6 py-2.5 text-sm">Sign in →</Link>
          </>
        )}

        {status === 'invalid' && (
          <>
            <XCircle className="w-12 h-12 text-red-400 mx-auto mb-3" aria-hidden="true" />
            <h1 className="text-xl font-bold text-slate-100 mb-2">Verification failed</h1>
            <p className="text-sm text-slate-400 mb-5">{errorMsg}</p>
            <Link to="/login" className="btn-secondary inline-block px-6 py-2.5 text-sm mr-2">Back to sign in</Link>
            <Link to="/register" className="btn-primary inline-block px-6 py-2.5 text-sm">Re-register</Link>
          </>
        )}

        {status === 'no-token' && (
          <>
            <MailQuestion className="w-12 h-12 text-amber-400 mx-auto mb-3" aria-hidden="true" />
            <h1 className="text-xl font-bold text-slate-100 mb-2">Missing verification token</h1>
            <p className="text-sm text-slate-400 mb-5">Open the link from your verification email to confirm your address.</p>
            <Link to="/login" className="btn-primary inline-block px-6 py-2.5 text-sm">Go to sign in</Link>
          </>
        )}
      </div>
    </main>
  )
}

export default VerifyEmailPage
