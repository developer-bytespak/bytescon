import { useState } from 'react'
import { Link } from 'react-router-dom'
import { authApi } from '../services/api'
import { ArrowLeft, CheckCircle } from 'lucide-react'
import { AuthShell, AuthHeading, AuthNotice } from '../components/auth/AuthShell'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      await authApi.forgotPassword(email)
      setSent(true)
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Something went wrong. Please try again.')
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
        {sent ? (
          <div className="text-center flex flex-col items-center">
            <span className="inline-grid place-items-center w-14 h-14 rounded-full mb-5" style={{ background: 'var(--success-bg)', color: 'var(--success)' }}>
              <CheckCircle className="w-7 h-7" aria-hidden="true" />
            </span>
            <h1 className="text-[28px] leading-[34px] font-semibold tracking-[-0.03em] mb-2" style={{ color: 'var(--text)' }}>Check your email</h1>
            <p className="text-[15px] leading-[22px] mb-7" style={{ color: 'var(--text-muted)' }}>
              If an account with <span className="font-semibold [overflow-wrap:anywhere]" style={{ color: 'var(--text)' }}>{email}</span> exists,
              we've sent password reset instructions. Check your inbox and spam folder.
            </p>
            <Link to="/login" className="btn-primary">
              Return to sign in
            </Link>
          </div>
        ) : (
          <>
            <AuthHeading title="Reset your password">
              Enter your email address and we'll send you instructions to reset your password.
            </AuthHeading>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="label" htmlFor="forgot-email">Email address</label>
                <input
                  id="forgot-email"
                  type="email"
                  className="input"
                  placeholder="you@firm.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              {error && <AuthNotice>{error}</AuthNotice>}

              <button type="submit" disabled={loading} className="btn-primary w-full">
                {loading ? 'Sending...' : 'Send reset instructions'}
              </button>
            </form>
          </>
        )}
    </AuthShell>
  )
}

export default ForgotPasswordPage
