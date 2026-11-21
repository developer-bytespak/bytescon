import { useState } from 'react'
import { X, Megaphone } from 'lucide-react'

// One-time product announcement: SAM.gov data is now built in — no API key
// required. Shows in the app shell through END_DATE, is dismissible (remembered
// per-browser in localStorage), and auto-hides after the window closes even if
// never dismissed. Bump the version suffix on DISMISS_KEY to run a future
// announcement without colliding with this one's dismissals.
const DISMISS_KEY = 'bytesgov_announce_samless_v1'
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
      className="relative mb-6 rounded-3xl p-5 pr-14 flex items-start gap-4"
      style={{ background: 'var(--surface)' }}
    >
      <span
        className="w-10 h-10 rounded-full grid place-items-center flex-shrink-0"
        style={{ background: 'var(--surface-3)', color: 'var(--text)' }}
        aria-hidden="true"
      >
        <Megaphone className="w-5 h-5" />
      </span>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text)' }}>
          SAM.gov data is now built in, with no API key required
        </h3>
        <p className="text-sm leading-[21px] mt-1" style={{ color: 'var(--text-muted)' }}>
          You no longer need to connect your own SAM.gov API key to see opportunities. Bytesgov pulls
          federal contract data for you automatically and refreshes it daily — your opportunity board fills
          in on its own, no setup required. Adding your own key is still available under{' '}
          <span className="font-medium" style={{ color: 'var(--text)' }}>Settings, SAM.gov API key</span> if you want your own
          higher rate-limit quota — but it's completely optional.
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss announcement"
        className="btn-ghost btn-sm !px-2 absolute top-3 right-3"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}
