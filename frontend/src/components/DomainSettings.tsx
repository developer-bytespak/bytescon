import { useState, useEffect } from 'react'
import { Globe, CheckCircle2, AlertCircle, Loader, Copy, ExternalLink } from 'lucide-react'
import axios from 'axios'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../hooks/useBranding'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

function getAuthToken(): string {
  try {
    const raw = localStorage.getItem('bytescon_auth')
    return raw ? (JSON.parse(raw).token ?? '') : ''
  } catch { return '' }
}

interface DnsInstructions {
  type: string
  host: string
  target: string
  ttl: number
}

interface DomainConfig {
  subdomain: string | null
  customDomain: string | null
  customDomainVerified: boolean
  customDomainVerifiedAt: string | null
  platformRootDomain: string
  currentPortalUrl: string
  dnsInstructions: DnsInstructions | null
}

export function DomainSettings() {
  const { user, firm } = useAuth()
  const { branding } = useBranding(firm?.id)
  const [config, setConfig] = useState<DomainConfig | null>(null)
  const [subdomainInput, setSubdomainInput] = useState('')
  const [customDomainInput, setCustomDomainInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [copied, setCopied] = useState(false)

  const flash = (type: 'ok' | 'err', text: string) => {
    if (type === 'ok') {
      setSuccess(text)
      setError('')
    } else {
      setError(text)
      setSuccess('')
    }
    setTimeout(() => { setSuccess(''); setError('') }, 5000)
  }

  const loadConfig = async () => {
    try {
      setLoading(true)
      const res = await axios.get(`${API_BASE}/api/branding/admin/domain-config`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      })
      if (res.data.success) {
        setConfig(res.data.data)
        setSubdomainInput(res.data.data.subdomain || '')
        setCustomDomainInput(res.data.data.customDomain || '')
      }
    } catch (err: any) {
      flash('err', err?.response?.data?.error || 'Failed to load domain config')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadConfig() }, [])

  const saveSubdomain = async () => {
    setSaving('subdomain')
    try {
      const res = await axios.put(
        `${API_BASE}/api/branding/admin/subdomain`,
        { subdomain: subdomainInput.trim() || null },
        { headers: { Authorization: `Bearer ${getAuthToken()}` } }
      )
      if (res.data.success) {
        flash('ok', res.data.message || 'Subdomain saved')
        await loadConfig()
      }
    } catch (err: any) {
      flash('err', err?.response?.data?.error || 'Failed to save subdomain')
    } finally {
      setSaving(null)
    }
  }

  const saveCustomDomain = async () => {
    setSaving('customDomain')
    try {
      const res = await axios.put(
        `${API_BASE}/api/branding/admin/custom-domain`,
        { customDomain: customDomainInput.trim() || null },
        { headers: { Authorization: `Bearer ${getAuthToken()}` } }
      )
      if (res.data.success) {
        flash('ok', res.data.message || 'Domain saved')
        await loadConfig()
      }
    } catch (err: any) {
      flash('err', err?.response?.data?.error || 'Failed to save custom domain')
    } finally {
      setSaving(null)
    }
  }

  const verifyDomain = async () => {
    setVerifying(true)
    try {
      const res = await axios.post(
        `${API_BASE}/api/branding/admin/custom-domain/verify`,
        {},
        { headers: { Authorization: `Bearer ${getAuthToken()}` } }
      )
      if (res.data.success) {
        const { verified, message } = res.data.data
        flash(verified ? 'ok' : 'err', message)
        if (verified) await loadConfig()
      }
    } catch (err: any) {
      flash('err', err?.response?.data?.error || 'Verification failed')
    } finally {
      setVerifying(false)
    }
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  if (user?.role !== 'ADMIN') {
    return (
      <div className="rounded-lg border border-red-700 bg-red-950/30 p-4 text-red-300 text-sm flex gap-2">
        <AlertCircle className="w-5 h-5 flex-shrink-0" />
        <p>Only admin users can configure domain settings.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader className="w-5 h-5 animate-spin text-gray-500" />
      </div>
    )
  }

  if (!config) return null

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Globe className="w-5 h-5" style={{ color: branding.secondaryColor }} />
        <h2 className="text-lg font-semibold text-gray-100">Domain Settings</h2>
      </div>

      {error && (
        <div className="rounded-lg border border-red-700 bg-red-950/30 p-3 text-red-300 text-sm flex gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg border border-green-700 bg-green-950/30 p-3 text-green-300 text-sm flex gap-2">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {success}
        </div>
      )}

      {/* Current portal URL */}
      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4">
        <p className="text-xs uppercase tracking-widest text-gray-500 mb-2">Your client portal is live at</p>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <code className="text-sm font-mono text-gray-200 break-all">{config.currentPortalUrl}</code>
          <a
            href={config.currentPortalUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors hover:bg-gray-800"
            style={{ color: branding.secondaryColor }}
          >
            Open <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>

      {/* Subdomain */}
      <div className="rounded-lg border border-gray-800 p-4 space-y-3">
        <div>
          <h3 className="text-sm font-medium text-gray-200">Subdomain on {config.platformRootDomain}</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Free instant subdomain — no DNS setup required.
            Example: <code className="text-gray-400">acme.{config.platformRootDomain}</code>
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <div className="flex-1 min-w-0 flex items-stretch border border-gray-700 rounded overflow-hidden bg-gray-800">
            <input
              type="text"
              value={subdomainInput}
              onChange={(e) => setSubdomainInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="acme-federal"
              className="flex-1 bg-transparent px-3 py-2 text-sm text-gray-200 outline-none font-mono"
            />
            <span className="px-3 py-2 text-sm text-gray-500 bg-gray-900 font-mono border-l border-gray-700">
              .{config.platformRootDomain}
            </span>
          </div>
          <button
            onClick={saveSubdomain}
            disabled={saving === 'subdomain'}
            className="px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            style={{
              background: branding.secondaryColor,
              color: '#0b0f1a',
            }}
          >
            {saving === 'subdomain' && <Loader className="w-4 h-4 animate-spin" />}
            Save
          </button>
        </div>
      </div>

      {/* Custom Domain */}
      <div className="rounded-lg border border-gray-800 p-4 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-sm font-medium text-gray-200">Custom Domain (Bring Your Own)</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Use your own domain for the client portal. Requires DNS CNAME setup.
            </p>
          </div>
          {config.customDomain && (
            config.customDomainVerified ? (
              <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-green-900/40 text-green-300 border border-green-700">
                <CheckCircle2 className="w-3 h-3" /> Verified
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-yellow-900/40 text-yellow-300 border border-yellow-700">
                <AlertCircle className="w-3 h-3" /> Pending DNS
              </span>
            )
          )}
        </div>

        <div className="flex gap-2 flex-wrap">
          <input
            type="text"
            value={customDomainInput}
            onChange={(e) => setCustomDomainInput(e.target.value.toLowerCase())}
            placeholder="portal.yourcompany.com"
            className="flex-1 min-w-0 bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none font-mono"
          />
          <button
            onClick={saveCustomDomain}
            disabled={saving === 'customDomain'}
            className="px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            style={{
              background: branding.secondaryColor,
              color: '#0b0f1a',
            }}
          >
            {saving === 'customDomain' && <Loader className="w-4 h-4 animate-spin" />}
            Save
          </button>
        </div>

        {/* DNS Instructions */}
        {config.dnsInstructions && (
          <div className="bg-gray-950 border border-gray-800 rounded p-3 mt-2 space-y-2">
            <p className="text-xs uppercase tracking-widest text-gray-500">DNS Configuration Required</p>
            <p className="text-xs text-gray-400">
              Add this CNAME record at your DNS provider (Cloudflare, GoDaddy, Route53, etc.):
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs font-mono">
              <div>
                <p className="text-gray-600 text-[10px] uppercase tracking-wider mb-0.5">Type</p>
                <p className="text-gray-200">{config.dnsInstructions.type}</p>
              </div>
              <div>
                <p className="text-gray-600 text-[10px] uppercase tracking-wider mb-0.5">Host</p>
                <p className="text-gray-200 break-all">{config.dnsInstructions.host}</p>
              </div>
              <div className="md:col-span-1 col-span-2">
                <p className="text-gray-600 text-[10px] uppercase tracking-wider mb-0.5">Target</p>
                <div className="flex items-center gap-1">
                  <code className="text-gray-200 break-all">{config.dnsInstructions.target}</code>
                  <button
                    onClick={() => copyToClipboard(config.dnsInstructions!.target)}
                    className="p-1 hover:bg-gray-800 rounded"
                    title="Copy target"
                  >
                    <Copy className="w-3 h-3 text-gray-500" />
                  </button>
                </div>
              </div>
              <div>
                <p className="text-gray-600 text-[10px] uppercase tracking-wider mb-0.5">TTL</p>
                <p className="text-gray-200">{config.dnsInstructions.ttl}</p>
              </div>
            </div>
            {copied && (
              <p className="text-xs text-green-400">Copied to clipboard</p>
            )}
            <div className="pt-2 border-t border-gray-800">
              <button
                onClick={verifyDomain}
                disabled={verifying}
                className="text-xs px-3 py-1.5 rounded border transition-colors disabled:opacity-50 flex items-center gap-2"
                style={{
                  borderColor: `${branding.secondaryColor}66`,
                  color: branding.secondaryColor,
                  background: `${branding.secondaryColor}14`,
                }}
              >
                {verifying ? <Loader className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                {config.customDomainVerified ? 'Re-verify DNS' : 'Verify DNS'}
              </button>
              <p className="text-[10px] text-gray-600 mt-1">
                DNS propagation can take up to 48 hours. If verification fails, wait and retry.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
