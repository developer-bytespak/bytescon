import { useState } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { Shield, Loader, FileCheck2, UploadCloud, Briefcase } from 'lucide-react'
import axios from 'axios'
import { useBranding } from '../hooks/useBranding'

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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await axios.post(`${API_BASE}/api/client-portal/auth/login`, { email, password })
      localStorage.setItem('bytescon_client_auth', JSON.stringify(res.data.data))
      navigate('/client-portal')
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Invalid credentials')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--bg)' }}>
      {/* Brand panel (desktop) */}
      <aside className="client-login-panel hidden lg:flex relative isolate overflow-hidden w-[46%] max-w-[640px] flex-col justify-between p-12">
        <div className="hero-orb hero-orb-a" aria-hidden="true" />
        <div className="hero-orb hero-orb-b" aria-hidden="true" />
        <div className="hero-grid" aria-hidden="true" />
        <div className="flex items-center gap-3">
          <span className="grid place-items-center w-11 h-11 rounded-xl" style={{ background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-2)' }}>
            {branding.logoUrl
              ? <img src={branding.logoUrl} alt="" className="w-7 h-7 object-contain" />
              : <Shield className="w-5 h-5" style={{ color: branding.secondaryColor }} />}
          </span>
          <span className="font-display text-xl" style={{ color: 'var(--text)' }}>{branding.displayName}</span>
        </div>
        <div className="animate-fade-up">
          <p className="font-display text-[2.6rem] leading-[1.08] tracking-tight" style={{ color: 'var(--text)' }}>
            Your contracts,<br />
            <span className="italic" style={{ color: 'var(--gold)' }}>without the paperwork chase.</span>
          </p>
          <ul className="mt-8 space-y-4">
            {[
              { icon: FileCheck2, text: 'See every document due and its deadline' },
              { icon: UploadCloud, text: 'Send files straight to your consultant' },
              { icon: Briefcase, text: 'Track contracts matched to your business' },
            ].map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-[15px]" style={{ color: 'var(--text-2)' }}>
                <span className="tile tile-accent"><Icon /></span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs" style={{ color: 'var(--text-faint)' }}>{branding.tagline}</p>
      </aside>

      {/* Form side */}
      <div className="relative isolate flex-1 flex items-center justify-center p-4 sm:p-8 overflow-hidden">
      <div className="app-ambient lg:hidden" aria-hidden="true" />
      <div className="relative w-full max-w-[400px] animate-fade-up">
        <div className="text-center lg:text-left mb-8">
          <div className="flex items-center justify-center mb-4 lg:hidden">
            <span
              className="grid place-items-center w-14 h-14 rounded-2xl"
              style={{ background: 'var(--surface)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-2)' }}
            >
              {branding.logoUrl ? (
                <img src={branding.logoUrl} alt={branding.displayName} className="w-10 h-10 object-contain" />
              ) : (
                <Shield className="w-7 h-7" style={{ color: branding.secondaryColor }} />
              )}
            </span>
          </div>
          <h1
            className="font-display text-[1.75rem] leading-tight lg:hidden"
            style={{
              background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            {branding.displayName}
          </h1>
          <p className="text-sm mt-1.5 lg:hidden" style={{ color: 'var(--text-muted)' }}>{branding.tagline}</p>
          <p className="hidden lg:block text-2xl font-semibold tracking-tight" style={{ color: 'var(--text)' }}>Client sign in</p>
          <p className="text-sm mt-3 lg:mt-1.5" style={{ color: 'var(--text-2)' }}>Log in to view your documents and deadlines</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-2xl p-6 sm:p-7 space-y-5"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadow-3)',
          }}
        >
          <div>
            <label htmlFor="cp-email" className="label !text-[13px]">Email</label>
            <input
              id="cp-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="input !py-2.5"
            />
          </div>
          <div>
            <label htmlFor="cp-password" className="label !text-[13px]">Password</label>
            <input
              id="cp-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="input !py-2.5"
            />
          </div>

          {error && (
            <div role="alert" className="rounded-lg px-3 py-2.5 text-sm animate-fade-up" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger-text)' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full disabled:opacity-50 font-semibold py-2.5 rounded-[10px] text-sm flex items-center justify-center gap-2 transition-transform duration-150 hover:-translate-y-px active:translate-y-0 active:scale-[0.99]"
            style={{
              background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})`,
              color: '#0b0f1a',
              boxShadow: 'var(--shadow-2)',
            }}
          >
            {loading && <Loader className="w-4 h-4 animate-spin" />}
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        {branding.isVeteranOwned && (
          <p className="text-center text-[10px] tracking-widest uppercase mt-5" style={{ color: 'var(--gold)' }}>
            ★ Veteran Owned · Patriot Operated
          </p>
        )}

        <p className="text-center text-xs mt-5" style={{ color: 'var(--text-faint)' }}>
          Are you a consultant?{' '}
          <Link to="/login" className="font-medium hover:underline" style={{ color: branding.secondaryColor }}>
            Sign in here
          </Link>
        </p>
      </div>
      </div>
    </div>
  )
}
