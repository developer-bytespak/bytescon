import { useState, useEffect, FormEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { authApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { Shield, Loader } from 'lucide-react'

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
      navigate(state.next || '/', { replace: true })
    } catch (err: unknown) {
      const e2 = err as { response?: { data?: { error?: string } } }
      setError(e2?.response?.data?.error || 'Invalid code. Try again, or use a recovery code.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#061019' }}>
      <div className="w-full max-w-sm p-8">
        <div className="flex items-center gap-2 mb-2 text-blue-400">
          <Shield className="w-5 h-5" />
          <span className="font-semibold">Two-factor authentication</span>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          Enter the 6-digit code from your authenticator app
          {state.email ? ` for ${state.email}` : ''}. You can also enter a recovery code.
        </p>
        <form onSubmit={submit} className="space-y-4">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456 or recovery code"
            className="input w-full text-center tracking-widest"
            autoComplete="one-time-code"
          />
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || code.trim().length < 6}
            className="btn-primary w-full flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {loading ? <Loader className="w-4 h-4 animate-spin" /> : null} Verify
          </button>
        </form>
        <button onClick={() => navigate('/login')} className="text-xs text-gray-500 hover:text-gray-300 mt-4">
          Back to sign in
        </button>
      </div>
    </div>
  )
}

export default MfaChallengePage
