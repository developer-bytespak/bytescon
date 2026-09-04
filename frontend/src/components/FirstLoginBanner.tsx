import { useState } from 'react'
import { X, Megaphone } from 'lucide-react'

// One-time product announcement: SAM.gov data is now built in — no API key
// required. Shows in the app shell through END_DATE, is dismissible (remembered
// per-browser in localStorage), and auto-hides after the window closes even if
// never dismissed. Bump the version suffix on DISMISS_KEY to run a future
// announcement without colliding with this one's dismissals.
const DISMISS_KEY = 'bytescon_announce_samless_v1'
const END_DATE = '2026-06-30' // inclusive last day to show (YYYY-MM-DD)

function withinWindow(): boolean {
  // Lexical compare is valid for zero-padded YYYY-MM-DD strings.
  const today = new Date().toISOString().slice(0, 10)
  return today <= END_DATE
}

export function FirstLoginBanner() {
  const [visible, setVisible] = useState(
    () => withinWindow() && localStorage.getItem(DISMISS_KEY) !== '1'
  )

  if (!visible) return null

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1')
    setVisible(false)
  }

  return (
    <div
      role="status"
      className="relative mb-6 rounded-xl p-4 pr-12 flex items-start gap-3"
      style={{
        background:
          'linear-gradient(135deg, rgba(91,116,255,0.1) 0%, rgba(91,116,255,0.03) 60%, transparent 100%)',
        border: '1px solid rgba(91,116,255,0.25)',
        boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
      }}
    >
      <div
        className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: 'rgba(91,116,255,0.12)', border: '1px solid rgba(91,116,255,0.25)' }}
      >
        <Megaphone className="w-5 h-5 text-cyan-400" />
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-amber-200">
          New: SAM.gov data is now built in — no API key required
        </h3>
        <p className="text-xs text-slate-300 leading-relaxed mt-1">
          You no longer need to connect your own SAM.gov API key to see opportunities. Bytescon pulls
          federal contract data for you automatically and refreshes it daily — your opportunity board fills
          in on its own, no setup required. Adding your own key is still available under{' '}
          <span className="text-slate-200 font-medium">Settings → SAM.gov API Key</span> if you want your own
          higher rate-limit quota — but it's completely optional.
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="absolute top-3 right-3 text-slate-500 hover:text-slate-200 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
