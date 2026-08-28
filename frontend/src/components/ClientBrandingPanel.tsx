import { useState, useEffect, useRef } from 'react'
import { AlertCircle, Loader, Upload, ImageOff, Eraser } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useClientBranding } from '../hooks/useClientBranding'

interface Props {
  clientId: string
}

interface FormState {
  displayName: string
  tagline: string
  primaryColor: string
  secondaryColor: string
  footerAddress: string
  preparedByLine: string
}

const HEX = /^#[0-9A-Fa-f]{6}$/

function emptyForm(): FormState {
  return {
    displayName: '',
    tagline: '',
    primaryColor: '#0A1F44',
    secondaryColor: '#C9A227',
    footerAddress: '',
    preparedByLine: '',
  }
}

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

function fullLogoUrl(url: string | null): string | null {
  if (!url) return null
  if (url.startsWith('http://') || url.startsWith('https://')) return url
  return `${API_BASE}${url}`
}

export function ClientBrandingPanel({ clientId }: Props) {
  const { user } = useAuth()
  const { branding, loading, error, update, uploadLogo, refresh } = useClientBranding(clientId)

  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [formError, setFormError] = useState('')
  const [formSuccess, setFormSuccess] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!branding) return
    setForm({
      displayName: branding.displayName ?? '',
      tagline: branding.tagline ?? '',
      primaryColor: branding.primaryColor ?? '#0A1F44',
      secondaryColor: branding.secondaryColor ?? '#C9A227',
      footerAddress: branding.footerAddress ?? '',
      preparedByLine: branding.preparedByLine ?? '',
    })
  }, [branding])

  if (user?.role !== 'ADMIN') {
    return (
      <div className="rounded-lg border border-red-700 bg-red-950/30 p-4 text-red-300">
        <div className="flex gap-2">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <p className="text-sm">Only firm admins can configure client branding.</p>
        </div>
      </div>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setFormError('')
    setFormSuccess('')

    if (form.primaryColor && !HEX.test(form.primaryColor)) {
      setFormError('Primary color must be in #RRGGBB format')
      setSaving(false)
      return
    }
    if (form.secondaryColor && !HEX.test(form.secondaryColor)) {
      setFormError('Secondary color must be in #RRGGBB format')
      setSaving(false)
      return
    }

    try {
      await update({
        displayName: form.displayName.trim() || null,
        tagline: form.tagline.trim() || null,
        primaryColor: form.primaryColor.trim() || null,
        secondaryColor: form.secondaryColor.trim() || null,
        footerAddress: form.footerAddress.trim() || null,
        preparedByLine: form.preparedByLine.trim() || null,
      })
      setFormSuccess('Client branding saved.')
      setTimeout(() => setFormSuccess(''), 3000)
    } catch (err: any) {
      setFormError(err?.response?.data?.error || err?.message || 'Save failed.')
    } finally {
      setSaving(false)
    }
  }

  const handleLogoUpload = async (file: File) => {
    setUploadingLogo(true)
    setFormError('')
    setFormSuccess('')
    try {
      await uploadLogo(file)
      await refresh()
      setFormSuccess('Logo uploaded.')
      setTimeout(() => setFormSuccess(''), 3000)
    } catch (err: any) {
      setFormError(err?.response?.data?.error || err?.message || 'Upload failed.')
    } finally {
      setUploadingLogo(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleClearLogo = async () => {
    setSaving(true)
    setFormError('')
    setFormSuccess('')
    try {
      await update({ logoUrl: null })
      setFormSuccess('Logo cleared. Firm default will apply.')
      setTimeout(() => setFormSuccess(''), 3000)
    } catch (err: any) {
      setFormError(err?.response?.data?.error || err?.message || 'Clear failed.')
    } finally {
      setSaving(false)
    }
  }

  if (loading && !branding) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-center gap-2 text-gray-400 text-sm">
        <Loader className="w-4 h-4 animate-spin" /> Loading client branding…
      </div>
    )
  }

  if (error && !branding) {
    return (
      <div className="rounded-lg border border-red-700 bg-red-950/30 p-3 text-red-300 text-sm">
        {error}
      </div>
    )
  }

  const logoSrc = fullLogoUrl(branding?.logoUrl ?? null)

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 space-y-5">
      <div>
        <h3 className="text-lg font-semibold text-gray-100">Proposal Branding</h3>
        <p className="text-xs text-gray-500 mt-1">
          Identity applied to proposal PDFs generated for this client. Empty fields fall back to the firm's default branding.
        </p>
      </div>

      {formError && (
        <div className="rounded-lg border border-red-700 bg-red-950/30 p-3 text-red-300 text-sm">
          {formError}
        </div>
      )}
      {formSuccess && (
        <div className="rounded-lg border border-green-700 bg-green-950/30 p-3 text-green-300 text-sm">
          {formSuccess}
        </div>
      )}

      {/* Logo */}
      <div className="grid grid-cols-1 md:grid-cols-[140px_1fr] gap-4 items-start">
        <div className="flex items-center justify-center w-32 h-32 rounded border border-gray-700 bg-gray-950 overflow-hidden">
          {logoSrc ? (
            <img src={logoSrc} alt="Client logo" className="max-w-full max-h-full object-contain" />
          ) : (
            <div className="flex flex-col items-center text-gray-600 text-xs">
              <ImageOff className="w-6 h-6 mb-1" /> No logo
            </div>
          )}
        </div>
        <div className="space-y-2">
          <label className="block text-sm font-medium text-gray-200">Logo image</label>
          <p className="text-xs text-gray-500">PNG, JPEG, SVG, or WebP. Maximum 2MB.</p>
          <div className="flex gap-2 flex-wrap">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleLogoUpload(file)
              }}
              className="hidden"
              id={`client-logo-${clientId}`}
            />
            <label
              htmlFor={`client-logo-${clientId}`}
              className="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm px-3 py-1.5 rounded cursor-pointer"
            >
              {uploadingLogo ? <Loader className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {uploadingLogo ? 'Uploading…' : (logoSrc ? 'Replace logo' : 'Upload logo')}
            </label>
            {logoSrc && (
              <button
                type="button"
                onClick={handleClearLogo}
                disabled={saving}
                className="inline-flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm px-3 py-1.5 rounded disabled:opacity-50"
              >
                <Eraser className="w-4 h-4" /> Clear
              </button>
            )}
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Display name + tagline */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">Display name</label>
            <input
              type="text"
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              maxLength={120}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
              placeholder="e.g., Apex Federal Solutions"
            />
            <p className="text-xs text-gray-500 mt-1">Appears on the proposal cover.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">Tagline</label>
            <input
              type="text"
              value={form.tagline}
              onChange={(e) => setForm({ ...form, tagline: e.target.value })}
              maxLength={200}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
              placeholder="Optional subtitle"
            />
          </div>
        </div>

        {/* Colors */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">Primary color</label>
            <div className="flex gap-2">
              <input
                type="color"
                value={HEX.test(form.primaryColor) ? form.primaryColor : '#0A1F44'}
                onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                className="h-10 w-12 rounded cursor-pointer bg-gray-800 border border-gray-700"
              />
              <input
                type="text"
                value={form.primaryColor}
                onChange={(e) => setForm({ ...form, primaryColor: e.target.value })}
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 font-mono outline-none focus:border-blue-500"
                placeholder="#0A1F44"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">Cover-page header band on proposal PDFs.</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-200 mb-1">Secondary color</label>
            <div className="flex gap-2">
              <input
                type="color"
                value={HEX.test(form.secondaryColor) ? form.secondaryColor : '#C9A227'}
                onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })}
                className="h-10 w-12 rounded cursor-pointer bg-gray-800 border border-gray-700"
              />
              <input
                type="text"
                value={form.secondaryColor}
                onChange={(e) => setForm({ ...form, secondaryColor: e.target.value })}
                className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 font-mono outline-none focus:border-blue-500"
                placeholder="#C9A227"
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">Divider lines + section accents.</p>
          </div>
        </div>

        {/* Prepared-by + footer */}
        <div>
          <label className="block text-sm font-medium text-gray-200 mb-1">"Prepared By" line</label>
          <input
            type="text"
            value={form.preparedByLine}
            onChange={(e) => setForm({ ...form, preparedByLine: e.target.value })}
            maxLength={150}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
            placeholder="e.g., Apex Federal Solutions, LLC · UEI ABC123 · CAGE 1A2B3"
          />
          <p className="text-xs text-gray-500 mt-1">Single line under the "PREPARED BY" header on the proposal cover.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-200 mb-1">Footer address</label>
          <input
            type="text"
            value={form.footerAddress}
            onChange={(e) => setForm({ ...form, footerAddress: e.target.value })}
            maxLength={200}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
            placeholder="e.g., 1234 K St NW, Suite 500, Washington, DC 20005"
          />
          <p className="text-xs text-gray-500 mt-1">Rendered on every page footer.</p>
        </div>

        {/* Preview */}
        <div className="bg-gray-950 border border-gray-800 rounded-lg p-4">
          <p className="text-[10px] font-semibold text-gray-500 uppercase tracking-widest mb-3">Cover preview</p>
          <div
            className="rounded p-4 text-white"
            style={{
              background: HEX.test(form.primaryColor) ? form.primaryColor : '#0A1F44',
              borderBottom: `4px solid ${HEX.test(form.secondaryColor) ? form.secondaryColor : '#C9A227'}`,
            }}
          >
            <p className="text-[10px] tracking-widest opacity-70">PROPOSAL RESPONSE</p>
            <p className="text-lg font-bold mt-1">[Opportunity title appears here]</p>
            {(form.displayName || form.tagline) && (
              <p className="text-xs opacity-80 mt-2">
                {form.displayName}
                {form.tagline ? ` · ${form.tagline}` : ''}
              </p>
            )}
          </div>
          {form.preparedByLine && (
            <p className="text-xs text-gray-400 mt-2">PREPARED BY: <span className="text-gray-300">{form.preparedByLine}</span></p>
          )}
          {form.footerAddress && (
            <p className="text-[10px] text-gray-500 mt-1 text-center">{form.footerAddress}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={saving}
          className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium px-4 py-2 rounded flex items-center gap-2"
        >
          {saving && <Loader className="w-4 h-4 animate-spin" />}
          Save branding
        </button>
      </form>
    </div>
  )
}
