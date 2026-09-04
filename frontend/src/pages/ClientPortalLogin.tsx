import { useState } from 'react'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import { Shield, Loader } from 'lucide-react'
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
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: '#0b0b0f' }}
    >
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-3">
            {branding.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.displayName} className="w-12 h-12 object-contain" />
            ) : (
              <Shield className="w-8 h-8" style={{ color: branding.secondaryColor }} />
            )}
          </div>
          <h1
            className="text-2xl font-bold tracking-wide"
            style={{
              background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}
          >
            {branding.displayName}
          </h1>
          <p className="text-gray-500 text-sm mt-1">{branding.tagline}</p>
          <p className="text-gray-600 text-xs mt-2">Log in to view your documents and deadlines</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded-xl p-6 space-y-4"
          style={{
            background: 'rgba(11,11,15,0.7)',
            border: `1px solid ${branding.secondaryColor}33`,
          }}
        >
          <div>
            <label className="block text-sm text-gray-400 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none"
              style={{
                borderColor: email ? `${branding.secondaryColor}99` : undefined,
              }}
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none"
              style={{
                borderColor: password ? `${branding.secondaryColor}99` : undefined,
              }}
            />
          </div>

          {error && (
            <div className="bg-red-900/30 border border-red-700 text-red-300 rounded-lg px-3 py-2 text-sm">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full disabled:opacity-50 font-medium py-2 rounded-lg text-sm transition-colors flex items-center justify-center gap-2"
            style={{
              background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})`,
              color: '#0b0f1a',
            }}
          >
            {loading && <Loader className="w-4 h-4 animate-spin" />}
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        {branding.isVeteranOwned && (
          <p className="text-center text-[10px] text-cyan-500/70 tracking-widest uppercase mt-4">
            ★ Veteran Owned · Patriot Operated
          </p>
        )}

        <p className="text-center text-xs text-gray-600 mt-4">
          Are you a consultant?{' '}
          <Link to="/login" className="hover:underline" style={{ color: branding.secondaryColor }}>
            Sign in here
          </Link>
        </p>
      </div>
    </div>
  )
}
