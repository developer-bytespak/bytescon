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
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
    >
      <div
        className="rounded-xl p-6 w-full max-w-md space-y-4"
        style={{ background: '#131318', border: '1px solid rgba(91,116,255,0.3)' }}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg" style={{ background: 'rgba(91,116,255,0.1)', border: '1px solid rgba(91,116,255,0.25)' }}>
              <Lock className="w-5 h-5 text-amber-400" />
            </div>
            <h3 className="text-base font-bold text-slate-100">
              {isPlan ? 'Your subscription is inactive' : `${detail.addonName ?? 'Add-on'} required`}
            </h3>
          </div>
          <button onClick={close} className="text-slate-500 hover:text-slate-300 transition-colors" aria-label="Dismiss">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-slate-400">
          {detail.error ??
            (isPlan
              ? 'An active Bytescon base plan ($99/mo) is required to use this feature.'
              : 'This feature is part of a paid add-on module.')}
        </p>
        {!isPlan && detail.addonPriceMonthly != null && (
          <p className="text-sm text-slate-300">
            <span className="font-bold text-amber-400">${detail.addonPriceMonthly}/mo</span> — add or cancel anytime.
          </p>
        )}

        <div className="flex gap-3 justify-end pt-1">
          <button
            onClick={close}
            className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 transition-colors"
          >
            Not now
          </button>
          <button
            onClick={go}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
            style={{ background: 'rgba(91,116,255,0.15)', border: '1px solid rgba(91,116,255,0.3)', color: '#5b74ff' }}
          >
            {isPlan ? 'Go to Billing →' : 'Add it from Billing →'}
          </button>
        </div>
      </div>
    </div>
  )
}
