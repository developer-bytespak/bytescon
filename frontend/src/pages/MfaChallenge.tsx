import { useState, useEffect, FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { authApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { Loader } from 'lucide-react'
import { AuthShell, AuthHeading, AuthNotice } from '../components/auth/AuthShell'

export function MfaChallengePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { login } = useAuth()
  const state = (location.state || {}) as { mfaChallengeToken?: string; email?: string; next?: string }
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // Reached without a challenge token (e.g. a direct visit) — back to sign in.
  useEffect(() => {
    if (!state.mfaChallengeToken) navigate('/login', { replace: true })
  }, [state.mfaChallengeToken, navigate])
  if (!state.mfaChallengeToken) return null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await authApi.mfaVerify(state.mfaChallengeToken!, code.trim())
      if (!res?.success || !res?.data?.token) {
        setError('Invalid code')
        setLoading(false)
        return
      }
      const { token, user, firm } = res.data
      login(token, user, firm)
      navigate(state.next || '/dashboard', { replace: true })
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { error?: string } } }
      setError(e2?.response?.data?.error || 'Invalid code. Try again, or use a recovery code.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell>
        <AuthHeading title="Two-factor authentication">
          Enter the 6-digit code from your authenticator app
          {state.email ? ` for ${state.email}` : ''}. You can also enter a recovery code.
        </AuthHeading>
        <form onSubmit={submit} className="space-y-5">
          <div>
            <label className="label" htmlFor="mfa-code">Code</label>
            <input
              id="mfa-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456 or recovery code"
              className="input w-full text-center tabular-nums"
              style={{ fontSize: 17, letterSpacing: '0.04em' }}
              autoComplete="one-time-code"
            />
          </div>
          {error && <AuthNotice>{error}</AuthNotice>}
          <button
            type="submit"
            disabled={loading || code.trim().length < 6}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading ? <Loader className="w-4 h-4 animate-spin" /> : null} Verify
          </button>
        </form>
        <p className="mt-7 pt-6 text-sm" style={{ borderTop: '1px solid var(--line)' }}>
          <button type="button" onClick={() => navigate('/login')} className="font-semibold underline underline-offset-2" style={{ color: 'var(--text)' }}>
            Back to sign in
          </button>
        </p>
    </AuthShell>
  )
}

export default MfaChallengePage
