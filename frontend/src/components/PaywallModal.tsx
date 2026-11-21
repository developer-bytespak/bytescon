import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Lock, X } from 'lucide-react'

interface PaywallDetail {
  code: 'PLAN_REQUIRED' | 'ADDON_REQUIRED'
  addon?: string
  addonName?: string
  addonPriceMonthly?: number | null
  error?: string
}

/**
 * Global paywall listener. The axios interceptor dispatches 'mrgc:paywall'
 * whenever the backend rejects a request with 402 PLAN_REQUIRED or 403
 * ADDON_REQUIRED; this modal turns that rejection into an upgrade path.
 * Deduped: a burst of gated requests (one page firing several queries)
 * shows a single modal until dismissed.
 */
export function PaywallModal() {
  const navigate = useNavigate()
  const [detail, setDetail] = useState<PaywallDetail | null>(null)

  useEffect(() => {
    const onPaywall = (e: Event) => {
      const d = (e as CustomEvent).detail as PaywallDetail | undefined
      if (!d?.code) return
      // Dedupe bursts — first event wins until the user dismisses.
      setDetail((prev) => prev ?? d)
    }
    window.addEventListener('mrgc:paywall', onPaywall)
    return () => window.removeEventListener('mrgc:paywall', onPaywall)
  }, [])

  if (!detail) return null

  const isPlan = detail.code === 'PLAN_REQUIRED'
  const close = () => setDetail(null)
  const go = () => {
    close()
    navigate(isPlan ? '/billing' : '/billing#addons')
  }

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(17,17,17,0.4)' }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="paywall-title"
        className="modal-panel p-7 w-full max-w-md space-y-5"
        style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-3)' }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="grid place-items-center w-10 h-10 rounded-full flex-shrink-0" style={{ background: 'var(--surface-3)', color: 'var(--text)' }} aria-hidden="true">
              <Lock className="w-5 h-5" />
            </span>
            <h3 id="paywall-title" className="text-[20px] leading-[28px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text)' }}>
              {isPlan ? 'Your subscription is inactive' : `${detail.addonName ?? 'Add-on'} required`}
            </h3>
          </div>
          <button onClick={close} className="btn-ghost btn-sm !px-2 flex-shrink-0" aria-label="Dismiss">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-[15px] leading-[22px]" style={{ color: 'var(--text-muted)' }}>
          {detail.error ??
            (isPlan
              ? 'An active Bytesgov base plan ($99/mo) is required to use this feature.'
              : 'This feature is part of a paid add-on module.')}
        </p>
        {!isPlan && detail.addonPriceMonthly != null && (
          <p className="text-[15px]" style={{ color: 'var(--text-2)' }}>
            <span className="font-semibold tabular-nums" style={{ color: 'var(--text)' }}>${detail.addonPriceMonthly}/mo</span>. Add or cancel anytime.
          </p>
        )}

        <div className="flex gap-3 justify-end pt-1">
          <button onClick={close} className="btn-secondary">
            Not now
          </button>
          <button onClick={go} className="btn-primary">
            {isPlan ? 'Go to billing' : 'Add it from billing'}
          </button>
        </div>
      </div>
    </div>
  )
}
