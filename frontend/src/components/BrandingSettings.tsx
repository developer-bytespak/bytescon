import { useState, useEffect } from 'react'
import { useAuth } from '../hooks/useAuth'
import axios from 'axios'
import { AlertCircle, Loader } from 'lucide-react'

function getAuthToken(): string {
  try {
    const raw = localStorage.getItem('bytescon_auth')
    return raw ? (JSON.parse(raw).token ?? '') : ''
  } catch { return '' }
}

interface BrandingForm {
  displayName: string
  tagline: string
  primaryColor: string
  secondaryColor: string
  logoUrl: string
  faviconUrl: string
}

export function BrandingSettings() {
  const { firm, user } = useAuth()
  const [form, setForm] = useState<BrandingForm>({
    displayName: firm?.name || '',
    tagline: 'Federal contracting intelligence.',
    primaryColor: '#22d3ee',
    secondaryColor: '#06b6d4',
    logoUrl: '',
    faviconUrl: '',
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // Load current branding
  useEffect(() => {
    const loadBranding = async () => {
      if (!firm?.id) return
      try {
        const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'
        const res = await axios.get(`${API_BASE}/api/branding/${firm.id}`)
        if (res.data.success) {
          const b = res.data.data
          setForm({
            displayName: b.displayName || firm.name,
            tagline: b.tagline || '',
            primaryColor: b.primaryColor || '#22d3ee',
            secondaryColor: b.secondaryColor || '#06b6d4',
            logoUrl: b.logoUrl || '',
            faviconUrl: b.faviconUrl || '',
          })
        }
      } catch {
        // Non-fatal — component renders with empty form fields if branding load fails
      }
    }
    loadBranding()
  }, [firm?.id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setSuccess('')

    try {
      const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'
      const res = await axios.put(
        `${API_BASE}/api/branding/admin/update`,
        form,
        {
          headers: {
            Authorization: `Bearer ${getAuthToken()}`,
          },
        }
      )

      if (res.data.success) {
        setSuccess('Branding settings updated successfully!')
        setTimeout(() => setSuccess(''), 3000)
      }
    } catch (err: any) {
      setError(err.response?.data?.error || 'Failed to update branding settings')
    } finally {
      setLoading(false)
    }
  }

  if (user?.role !== 'ADMIN') {
    return (
      <div className="rounded-lg border border-red-700 bg-red-950/30 p-4 text-red-300">
        <div className="flex gap-2">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <p>Only admin users can configure branding settings.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-gray-100 mb-2">White-Label Configuration</h2>
        <p className="text-gray-400 text-sm">Customize your firm's branding appearance throughout the portal</p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-700 bg-red-950/30 p-3 text-red-300 text-sm">
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg border border-green-700 bg-green-950/30 p-3 text-green-300 text-sm">
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
        {/* Display Name */}
        <div>
          <label className="block text-sm font-medium text-gray-200 mb-2">
            Display Name
          </label>
          <input
            type="text"
            value={form.displayName}
            onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 text-sm outline-none focus:border-blue-500"
            placeholder="e.g., Apex Federal Advisory"
          />
          <p className="text-xs text-gray-500 mt-1">How your firm name appears in the portal</p>
        </div>

        {/* Tagline */}
        <div>
          <label className="block text-sm font-medium text-gray-200 mb-2">
            Tagline
          </label>
          <input
            type="text"
            value={form.tagline}
            onChange={(e) => setForm({ ...form, tagline: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 text-sm outline-none focus:border-blue-500"
            placeholder="e.g., Government Contracting Intelligence"
          />
          <p className="text-xs text-gray-500 mt-1">Subtitle shown below your firm name</p>
        </div>

        {/* Colors */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-2">
              Primary Color
            </label>
            <div className="flex gap-2">
              <input
                type="color"
                value={form.primaryColor}
                onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                className="h-10 w-16 rounded cursor-pointer"
              />
              <input
                type="text"
                value={form.primaryColor}
                onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 text-sm outline-none focus:border-blue-500 font-mono"
                placeholder="#22d3ee"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-200 mb-2">
              Secondary Color
            </label>
            <div className="flex gap-2">
              <input
                type="color"
                value={form.secondaryColor}
                onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })}
                className="h-10 w-16 rounded cursor-pointer"
              />
              <input
                type="text"
                value={form.secondaryColor}
                onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })}
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 text-sm outline-none focus:border-blue-500 font-mono"
                placeholder="#06b6d4"
              />
            </div>
          </div>
        </div>

        {/* URLs */}
        <div>
          <label className="block text-sm font-medium text-gray-200 mb-2">
            Logo URL (optional)
          </label>
          <input
            type="url"
            value={form.logoUrl}
            onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 text-sm outline-none focus:border-blue-500"
            placeholder="https://example.com/logo.png"
          />
          <p className="text-xs text-gray-500 mt-1">Upload your logo to cloud storage and paste the URL</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-200 mb-2">
            Favicon URL (optional)
          </label>
          <input
            type="url"
            value={form.faviconUrl}
            onChange={(e) => setForm({ ...form, faviconUrl: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-200 text-sm outline-none focus:border-blue-500"
            placeholder="https://example.com/favicon.ico"
          />
          <p className="text-xs text-gray-500 mt-1">32x32 icon for browser tab (ico, png, svg)</p>
        </div>

        {/* Preview */}
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Preview</p>
          <div className="flex items-center gap-2">
            <div
              className="w-8 h-8 rounded"
              style={{ background: `linear-gradient(135deg, ${form.primaryColor}, ${form.secondaryColor})` }}
            />
            <div>
              <p
                className="font-bold text-sm"
                style={{
                  color: form.secondaryColor,
                }}
              >
                {form.displayName}
              </p>
              <p className="text-xs text-gray-500">{form.tagline}</p>
            </div>
          </div>
        </div>

        {/* Submit */}
        <button
          type="submit"
          disabled={loading}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-medium px-4 py-2 rounded flex items-center gap-2"
        >
          {loading && <Loader className="w-4 h-4 animate-spin" />}
          Save Branding Settings
        </button>
      </form>
    </div>
  )
}
