import { useState } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { authApi } from '../services/api'
import { ArrowLeft, Lock, CheckCircle, Eye, EyeOff } from 'lucide-react'

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const token = searchParams.get('token') || ''
  const isInvite = searchParams.get('invite') === '1'

  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }

    if (!token) {
      setError('Invalid reset link. Please request a new one.')
      return
    }

    setLoading(true)
    try {
      await authApi.resetPassword(token, password)
      setSuccess(true)
      setTimeout(() => navigate('/login'), 3000)
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Reset failed. The link may have expired.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-8" style={{ background: '#061019' }}>
      <div className="w-full max-w-sm">
        <Link to="/login" className="flex items-center gap-1 text-xs text-slate-500 hover:text-amber-400 transition-colors mb-8">
          <ArrowLeft className="w-3 h-3" /> Back to Sign In
        </Link>

        {success ? (
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
              style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)' }}>
              <CheckCircle className="w-8 h-8 text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-slate-100 mb-2">{isInvite ? "You're all set" : 'Password Reset'}</h2>
            <p className="text-sm text-slate-400 mb-6">
              {isInvite ? 'Your account is ready. Redirecting to sign in...' : 'Your password has been updated. Redirecting to sign in...'}
            </p>
            <Link to="/login" className="btn-primary text-sm py-2.5 px-6 inline-flex">
              Sign In Now
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-8">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                style={{ background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.2)' }}>
                <Lock className="w-6 h-6 text-amber-400" />
              </div>
              <h2 className="text-2xl font-bold text-slate-100 mb-1">{isInvite ? 'Set Your Password' : 'Set New Password'}</h2>
              <p className="text-sm text-slate-500">
                {isInvite ? 'Welcome! Choose a password to activate your team account. ' : ''}
                Must be at least 12 characters with uppercase, lowercase, number, and symbol.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="label">New Password</label>
                <div className="relative">
                  <input
                    type={showPw ? 'text' : 'password'}
                    className="input pr-10"
                    placeholder="New password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={12}
                  />
                  <button type="button" onClick={() => setShowPw(!showPw)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-amber-400 transition-colors">
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="label">Confirm Password</label>
                <input
                  type={showPw ? 'text' : 'password'}
                  className="input"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div className="text-sm rounded-lg px-4 py-3"
                  style={{ background: 'rgba(127,29,29,0.4)', border: '1px solid rgba(185,28,28,0.5)', color: '#fca5a5' }}>
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading} className="btn-primary w-full py-3 text-sm">
                {loading ? 'Saving...' : (isInvite ? 'Set Password & Continue' : 'Reset Password')}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

export default ResetPasswordPage
