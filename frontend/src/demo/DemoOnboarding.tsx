import { useState } from 'react'
import { useAuth } from '../hooks/useAuth'
import { isDemoSite, onboardingSeenKey } from './demoMode'
import { startDemoTour } from './demoTour'

const GOALS = [
  { title: 'Find the right contracts', body: 'See opportunities scored against your clients.' },
  { title: 'Decide what to bid', body: 'Get a recommendation, with the reasons behind it.' },
  { title: 'Write proposals faster', body: 'Draft from approved content, then review.' },
  { title: 'Manage awarded work', body: 'Follow contracts, deliverables and invoices.' },
]

// Set directly: the app's themes restyle the usual utility classes, which left
// this panel see-through in the light theme.
const PANEL = { background: '#ffffff', color: '#334155', border: '1px solid #e2e8f0' }
const HEADING = { color: '#0f172a' }
const BODY = { color: '#334155' }
const MUTED = { color: '#64748b' }
const OPTION = { background: '#ffffff', border: '1px solid #cbd5e1' }
const CHOSEN = { background: '#eef2ff', border: '1px solid #4f46e5' }
const PRIMARY = { background: '#4f46e5', color: '#ffffff' }
const SECONDARY = { background: '#ffffff', color: '#334155', border: '1px solid #cbd5e1' }

function readSeen(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** Three short steps at each sign-in, then the tour. */
export function DemoOnboarding() {
  const { user } = useAuth()
  const key = onboardingSeenKey(user?.id)
  const [done, setDone] = useState(() => readSeen(key))
  const [step, setStep] = useState(0)
  const [goal, setGoal] = useState<string | null>(null)

  if (!isDemoSite || done || !user) return null

  function finish(takeTour: boolean) {
    try {
      localStorage.setItem(key, '1')
    } catch {
      // The onboarding may show again next time. Nothing else depends on this.
    }
    setDone(true)
    if (takeTour) window.setTimeout(startDemoTour, 300)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(2, 6, 23, 0.72)' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="demo-onboarding-title" className="w-full max-w-lg rounded-xl p-6 shadow-2xl" style={PANEL}>
        <div className="text-xs mb-2" style={MUTED}>Step {step + 1} of 3</div>

        {step === 0 && (
          <>
            <h2 id="demo-onboarding-title" className="text-xl font-semibold" style={HEADING}>Welcome, {user.firstName}</h2>
            <p className="mt-3 text-sm" style={BODY}>
              Bytescon helps firms find, win and deliver federal contracts. This demo is set up for you, so you can try everything right away.
            </p>
          </>
        )}

        {step === 1 && (
          <>
            <h2 id="demo-onboarding-title" className="text-xl font-semibold" style={HEADING}>What matters most to you?</h2>
            <div className="mt-4 grid gap-2">
              {GOALS.map((option) => (
                <button
                  key={option.title}
                  type="button"
                  aria-pressed={goal === option.title}
                  onClick={() => setGoal(option.title)}
                  className="rounded-lg p-3 text-left transition-colors"
                  style={goal === option.title ? CHOSEN : OPTION}
                >
                  <div className="text-sm font-medium" style={HEADING}>{option.title}</div>
                  <div className="text-xs" style={MUTED}>{option.body}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2 id="demo-onboarding-title" className="text-xl font-semibold" style={HEADING}>About your demo</h2>
            <ul className="mt-3 space-y-2 text-sm list-disc pl-5" style={BODY}>
              <li>The clients, opportunities and contracts are sample data, and only you can see them.</li>
              <li>You can use every feature until your demo ends. AI features have a usage limit.</li>
              <li>Uploading and downloading files is turned off, and payments aren’t part of the demo.</li>
            </ul>
          </>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <button type="button" onClick={() => finish(false)} className="text-xs" style={MUTED}>
            Skip for now
          </button>
          <div className="flex gap-2">
            {step > 0 && (
              <button type="button" onClick={() => setStep(step - 1)} className="rounded-lg px-4 py-2 text-sm" style={SECONDARY}>
                Back
              </button>
            )}
            {step < 2 ? (
              <button type="button" onClick={() => setStep(step + 1)} className="rounded-lg px-4 py-2 text-sm font-medium" style={PRIMARY}>
                Next
              </button>
            ) : (
              <button type="button" onClick={() => finish(true)} className="rounded-lg px-4 py-2 text-sm font-medium" style={PRIMARY}>
                Start the tour
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
