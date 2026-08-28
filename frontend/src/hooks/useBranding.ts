import { useState, useEffect } from 'react'
import axios from 'axios'

export interface BrandingConfig {
  firmId: string
  firmName: string
  displayName: string
  tagline: string
  logoUrl: string | null
  primaryColor: string
  secondaryColor: string
  faviconUrl: string | null
  isVeteranOwned: boolean
}

const DEFAULT_BRANDING: BrandingConfig = {
  firmId: 'default',
  firmName: 'Bytescon',
  displayName: 'Bytescon',
  tagline: 'Federal contracting intelligence.',
  logoUrl: null,
  primaryColor: '#22d3ee',
  secondaryColor: '#06b6d4',
  faviconUrl: null,
  isVeteranOwned: false,
}

export function useBranding(firmId?: string) {
  const [branding, setBranding] = useState<BrandingConfig>(DEFAULT_BRANDING)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

    const fetchBranding = async () => {
      try {
        setLoading(true)

        // 1. Prefer firmId when known (consultant logged in, client logged in)
        if (firmId) {
          const res = await axios.get(`${API_BASE}/api/branding/${firmId}`)
          if (res.data.success && res.data.data) {
            setBranding(res.data.data)
            setError(null)
            return
          }
        }

        // 2. Fall back to host-based resolution (subdomain or custom domain)
        // Skip on localhost/dev when running on different port from API
        const host = window.location.hostname
        if (host && host !== 'localhost' && host !== '127.0.0.1') {
          const res = await axios.get(`${API_BASE}/api/branding/by-host/${encodeURIComponent(host)}`)
          if (res.data.success && res.data.data) {
            setBranding(res.data.data)
            setError(null)
            return
          }
        }

        // 3. Defaults
        setBranding(DEFAULT_BRANDING)
        setError(null)
      } catch (err: any) {
        // Branding fetch failure is non-fatal; log for visibility without crashing the app
        setError(err.message)
        setBranding(DEFAULT_BRANDING)
      } finally {
        setLoading(false)
      }
    }

    fetchBranding()
  }, [firmId])

  return { branding, loading, error }
}
