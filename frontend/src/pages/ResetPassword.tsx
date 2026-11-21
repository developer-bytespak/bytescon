import { useState } from 'react'
import { Link, useSearchParams, useNavigate } from 'react-router-dom'
import { authApi } from '../services/api'
import { ArrowLeft, CheckCircle, Eye, EyeOff } from 'lucide-react'
import { AuthShell, AuthHeading, AuthNotice } from '../components/auth/AuthShell'

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
    <AuthShell
      headerRight={
        <Link to="/login" className="v3-pill v3-pill-light v3-pill-sm">
          <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /> Back to sign in
        </Link>
      }
    >
        {success ? (
          <div className="text-center flex flex-col items-center">
            <span className="inline-grid place-items-center w-14 h-14 rounded-full mb-5" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
              <CheckCircle className="w-7 h-7" aria-hidden="true" />
            </span>
            <h1 className="text-[28px] leading-[34px] font-semibold tracking-[-0.03em] mb-2" style={{ color: 'var(--text)' }}>{isInvite ? "You're all set" : 'Password reset'}</h1>
            <p className="text-[15px] leading-[22px] mb-7" style={{ color: 'var(--text-muted)' }}>
              {isInvite ? 'Your account is ready. Redirecting to sign in...' : 'Your password has been updated. Redirecting to sign in...'}
            </p>
            <Link to="/login" className="btn-primary">
              Sign in now
            </Link>
          </div>
        ) : (
          <>
            <AuthHeading title={isInvite ? 'Set your password' : 'Set a new password'}>
              {isInvite ? 'Welcome. Choose a password to activate your team account. ' : ''}
              It must be at least 12 characters, with uppercase, lowercase, a number and a symbol.
            </AuthHeading>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="label" htmlFor="reset-password">New password</label>
                <div className="relative">
                  <input
                    id="reset-password"
                    type={showPw ? 'text' : 'password'}
                    className="input pr-10"
                    placeholder="New password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={12}
                  />
                  <button type="button" onClick={() => setShowPw(!showPw)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                    style={{ color: 'var(--text-muted)' }}>
                    {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="label" htmlFor="reset-confirm">Confirm password</label>
                <input
                  id="reset-confirm"
                  type={showPw ? 'text' : 'password'}
                  className="input"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              {error && <AuthNotice>{error}</AuthNotice>}

              <button type="submit" disabled={loading} className="btn-primary w-full">
                {loading ? 'Saving...' : (isInvite ? 'Set password and continue' : 'Reset password')}
              </button>
            </form>
          </>
        )}
    </AuthShell>
  )
}

export default ResetPasswordPage
