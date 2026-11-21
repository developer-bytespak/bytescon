import { useState } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { Loader } from 'lucide-react'
import axios from 'axios'
import { useBranding } from '../hooks/useBranding'
import { AuthShell, AuthHeading, AuthNotice, Wordmark } from '../components/auth/AuthShell'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

export default function ClientPortalLogin() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const firmIdFromQuery = searchParams.get('firm') || undefined
  const { branding } = useBranding(firmIdFromQuery)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showForgot, setShowForgot] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await axios.post(`${API_BASE}/api/client-portal/auth/login`, { email, password })
      localStorage.setItem('bytesgov_client_auth', JSON.stringify(res.data.data))
      navigate('/client-portal')
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  // A firm with its own logo shows it; otherwise the "B." wordmark with the firm's display name.
  const brand = branding.logoUrl ? (
    <div className="flex items-center gap-3">
      <span className="grid place-items-center w-10 h-10 rounded-xl" style={{ background: 'var(--surface)' }}>
        <img src={branding.logoUrl} alt="" className="w-7 h-7 object-contain" />
      </span>
      <span className="text-base font-semibold tracking-[-0.01em]" style={{ color: 'var(--text)' }}>{branding.displayName}</span>
    </div>
  ) : <Wordmark to="/client-login" name={branding.displayName} />

  const aside = (
    <>
      <h2 className="v3-h1" style={{ color: '#f0f1fa' }}>Your contracts, without the paperwork chase.</h2>
      <div>
        <ul style={{ borderTop: '1px solid rgba(240, 241, 250, 0.12)' }}>
          {[
            'See every document due and its deadline',
            'Send files straight to your consultant',
            'Track contracts matched to your business',
          ].map((text) => (
            <li key={text} className="py-3 text-[15px]" style={{ color: '#f0f1fa', borderBottom: '1px solid rgba(240, 241, 250, 0.08)' }}>
              {text}
            </li>
          ))}
        </ul>
        {branding.tagline && <p className="mt-5 text-[13px]" style={{ color: 'rgba(240, 241, 250, 0.6)' }}>{branding.tagline}</p>}
      </div>
    </>
  )

  return (
    <AuthShell
      brand={brand}
      aside={aside}
      footer={
        <>
          {branding.isVeteranOwned && <span>Veteran owned and operated. </span>}
          Are you a consultant?{' '}
          <Link to="/login" className="font-semibold underline underline-offset-2" style={{ color: 'var(--text-2)' }}>
            Sign in here
          </Link>
        </>
      }
    >
        <AuthHeading title="Client sign in">Log in to view your documents and deadlines.</AuthHeading>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div>
            <label htmlFor="cp-email" className="label">Email</label>
            <input
              id="cp-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="input"
            />
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="cp-password" className="label">Password</label>
              {/* Portal accounts have no self-service reset — the consultant resets them from the client page. */}
              <button
                type="button"
                onClick={() => setShowForgot((v) => !v)}
                aria-expanded={showForgot}
                className="text-[13px] underline underline-offset-2"
                style={{ color: 'var(--text-muted)' }}
              >
                Forgot password?
              </button>
            </div>
            <input
              id="cp-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="input"
            />
            {showForgot && (
              <p className="text-[13px] mt-2" style={{ color: 'var(--text-muted)' }}>
                Contact your consultant. They can reset your portal password from your client profile.
              </p>
            )}
          </div>

          {error && <AuthNotice>{error}</AuthNotice>}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {loading && <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {loading ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
    </AuthShell>
  )
}
