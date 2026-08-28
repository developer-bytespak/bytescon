import { useState, useEffect, useCallback } from 'react'
import { clientsApi } from '../services/api'

/**
 * Per-client branding profile applied to outbound proposal PDFs.
 *
 * Mirrors the shape of useBranding but represents the END-CLIENT (the firm
 * the consulting firm is preparing a federal proposal FOR), not the consulting
 * firm itself. All string fields are nullable; null in any slot means "fall
 * back to the consulting firm default at PDF render time."
 */
export interface ClientBrandingConfig {
  clientId: string
  clientName: string
  displayName: string | null
  tagline: string | null
  logoUrl: string | null
  primaryColor: string | null
  secondaryColor: string | null
  footerAddress: string | null
  preparedByLine: string | null
}

const EMPTY_BRANDING = (id: string, name: string): ClientBrandingConfig => ({
  clientId: id,
  clientName: name,
  displayName: null,
  tagline: null,
  logoUrl: null,
  primaryColor: null,
  secondaryColor: null,
  footerAddress: null,
  preparedByLine: null,
})

export interface UseClientBrandingResult {
  branding: ClientBrandingConfig | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  update: (patch: Partial<Omit<ClientBrandingConfig, 'clientId' | 'clientName'>>) => Promise<void>
  uploadLogo: (file: File) => Promise<string>
}

export function useClientBranding(clientId?: string): UseClientBrandingResult {
  const [branding, setBranding] = useState<ClientBrandingConfig | null>(null)
  const [loading, setLoading] = useState<boolean>(Boolean(clientId))
  const [error, setError] = useState<string | null>(null)

  const fetchBranding = useCallback(async () => {
    if (!clientId) {
      setBranding(null)
      setLoading(false)
      return
    }
    try {
      setLoading(true)
      const res = await clientsApi.getById(clientId)
      const c = res?.data
      if (!c) {
        setBranding(null)
        setError('Client not found')
        return
      }
      setBranding({
        clientId: c.id,
        clientName: c.name,
        displayName:    c.brandingDisplayName    ?? null,
        tagline:        c.brandingTagline        ?? null,
        logoUrl:        c.brandingLogoUrl        ?? null,
        primaryColor:   c.brandingPrimaryColor   ?? null,
        secondaryColor: c.brandingSecondaryColor ?? null,
        footerAddress:  c.brandingFooterAddress  ?? null,
        preparedByLine: c.brandingPreparedByLine ?? null,
      })
      setError(null)
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load branding')
      setBranding((prev) => prev ?? EMPTY_BRANDING(clientId, ''))
    } finally {
      setLoading(false)
    }
  }, [clientId])

  useEffect(() => {
    fetchBranding()
  }, [fetchBranding])

  const update = useCallback(
    async (patch: Partial<Omit<ClientBrandingConfig, 'clientId' | 'clientName'>>) => {
      if (!clientId) throw new Error('No clientId')
      const res = await clientsApi.updateBranding(clientId, patch)
      const updated = res?.data
      if (updated) {
        setBranding((prev) =>
          prev
            ? {
                ...prev,
                displayName:    updated.brandingDisplayName    ?? null,
                tagline:        updated.brandingTagline        ?? null,
                logoUrl:        updated.brandingLogoUrl        ?? null,
                primaryColor:   updated.brandingPrimaryColor   ?? null,
                secondaryColor: updated.brandingSecondaryColor ?? null,
                footerAddress:  updated.brandingFooterAddress  ?? null,
                preparedByLine: updated.brandingPreparedByLine ?? null,
              }
            : prev,
        )
      }
    },
    [clientId],
  )

  const uploadLogo = useCallback(
    async (file: File): Promise<string> => {
      if (!clientId) throw new Error('No clientId')
      const res = await clientsApi.uploadLogo(clientId, file)
      const url: string | undefined = res?.data?.logoUrl
      if (!url) throw new Error('Upload succeeded but server returned no logoUrl')
      setBranding((prev) => (prev ? { ...prev, logoUrl: url } : prev))
      return url
    },
    [clientId],
  )

  return { branding, loading, error, refresh: fetchBranding, update, uploadLogo }
}
