import { useState } from 'react'
import { Link } from 'react-router-dom'
import { authApi } from '../services/api'
import { ArrowLeft, Mail, CheckCircle } from 'lucide-react'

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
    <div className="min-h-screen flex items-center justify-center p-8" style={{ background: '#061019' }}>
      <div className="w-full max-w-sm">
        <Link to="/login" className="flex items-center gap-1 text-xs text-slate-500 hover:text-amber-400 transition-colors mb-8">
          <ArrowLeft className="w-3 h-3" /> Back to Sign In
        </Link>

        {sent ? (
          <div className="text-center">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6"
              style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.25)' }}>
              <CheckCircle className="w-8 h-8 text-emerald-400" />
            </div>
            <h2 className="text-2xl font-bold text-slate-100 mb-2">Check Your Email</h2>
            <p className="text-sm text-slate-400 leading-relaxed mb-6">
              If an account with <span className="text-slate-200 font-medium">{email}</span> exists,
              we've sent password reset instructions. Check your inbox and spam folder.
            </p>
            <Link to="/login" className="btn-primary text-sm py-2.5 px-6 inline-flex">
              Return to Sign In
            </Link>
          </div>
        ) : (
          <>
            <div className="mb-8">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-4"
                style={{ background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.2)' }}>
                <Mail className="w-6 h-6 text-amber-400" />
              </div>
              <h2 className="text-2xl font-bold text-slate-100 mb-1">Reset Your Password</h2>
              <p className="text-sm text-slate-500">
                Enter your email address and we'll send you instructions to reset your password.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="label">Email Address</label>
                <input
                  type="email"
                  className="input"
                  placeholder="you@firm.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
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
                {loading ? 'Sending...' : 'Send Reset Instructions'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

export default ForgotPasswordPage
