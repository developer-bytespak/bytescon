import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft, BarChart3, FileText, Gauge, KanbanSquare, Network,
  ListChecks, PenLine, Receipt, Scale, Search, Truck, type LucideIcon,
} from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { demoApi } from './demoApi'
import { isDemoSite, onboardingSeenKey } from './demoMode'
import { startDemoTour } from './demoTour'

// The Find card names the account's business, so it reads as built for them.
const steps = (businessType: string | null): Array<{ title: string; what: string; how: string; icon: LucideIcon }> => [
  {
    title: 'Find',
    what: `Find ${businessType ? `${businessType} ` : ''}opportunities matched to your profile.`,
    how: 'Every opportunity is scored against your NAICS codes, set-asides and past performance, so you only see work that fits your business.',
    icon: Search,
  },
  { title: 'Decide', what: 'Know whether to bid before you spend on it.', how: 'You get a recommendation with the reasons behind it. People make the call.', icon: Scale },
  { title: 'Write', what: 'Get to a strong proposal faster.', how: 'AI drafts from your approved content, and a person reviews every word.', icon: PenLine },
  { title: 'Deliver', what: 'Stay on top of the work after the award.', how: 'Contracts, deliverables, time and invoices live in one place.', icon: Truck },
]

const FEATURES: Array<{ title: string; body: string; icon: LucideIcon }> = [
  { title: 'Win probability scoring', body: 'A score for each opportunity, with the factors behind it.', icon: Gauge },
  { title: 'Bid and no-bid decisions', body: 'Recommendations ranked by fit, value and deadline.', icon: Scale },
  { title: 'Capture pipeline', body: 'Every pursuit by stage, with owners and next steps.', icon: KanbanSquare },
  { title: 'Compliance matrix', body: 'Requirements tracked from solicitation to submission.', icon: ListChecks },
  { title: 'Proposal workspace', body: 'Sections, reviews and AI-assisted drafts together.', icon: FileText },
  { title: 'Teaming and CRM', body: 'Partners, agency contacts and follow-ups.', icon: Network },
  { title: 'Contract and finance tracking', body: 'Deliverables, time, invoices and receivables.', icon: Receipt },
  { title: 'Analytics and reporting', body: 'Pipeline value, win rates and forecasts.', icon: BarChart3 },
]

// The v3 look, from the app's theme variables, so light and dark mode both follow.
const TILE = { background: 'var(--surface-3)', color: 'var(--text)' }

function readSeen(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

/** An illustration of a scored opportunity. Not anyone's real data. */
function ExampleCard() {
  const factors = [['Industry match', 92], ['Set-aside fit', 100], ['Past performance', 64]] as const
  return (
    <div aria-hidden="true" className="v3-surface v3-surface-blue w-full max-w-md" style={{ padding: 32 }}>
      <div className="flex flex-wrap gap-2">
        <span className="inline-flex items-center h-7 px-3 rounded-full text-[12px] font-medium" style={{ border: '1px solid rgba(255,255,255,0.35)' }}>Example opportunity</span>
        <span className="inline-flex items-center h-7 px-3 rounded-full text-[12px] font-medium" style={{ border: '1px solid rgba(255,255,255,0.35)' }}>Due in 34 days</span>
      </div>
      <div className="mt-6 text-[20px] leading-[28px] font-semibold tracking-[-0.02em]">Regional Program Support Services</div>
      <p className="v3-figure mt-6" style={{ fontSize: 72, lineHeight: '72px' }}>84<small>%</small></p>
      <p className="mt-2 text-[15px] v3-muted">Win probability</p>
      <div className="mt-6">
        {factors.map(([name, pct]) => (
          <div key={name} className="py-2.5" style={{ borderTop: '1px solid rgba(255,255,255,0.22)' }}>
            <div className="flex justify-between text-sm"><span>{name}</span><span className="tabular-nums v3-muted">{pct}%</span></div>
            <div className="mt-1.5 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.24)' }}>
              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: '#fff' }} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-5 text-sm font-semibold">Recommendation: bid as prime</p>
    </div>
  )
}

/** What the product is, what it does and its features, at each sign-in, then the tour. */
export function DemoOnboarding() {
  const { user } = useAuth()
  const key = onboardingSeenKey(user?.id)
  const [done, setDone] = useState(() => readSeen(key))
  const [step, setStep] = useState(0)
  const [businessType, setBusinessType] = useState<string | null>(null)
  const showing = isDemoSite && !done && Boolean(user)

  useEffect(() => {
    if (!showing) return
    let cancelled = false
    Promise.resolve(demoApi.status())
      .then((status) => {
        if (!cancelled && status?.businessType) setBusinessType(status.businessType)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [showing])

  // The page behind shouldn't scroll while this covers it.
  useEffect(() => {
    if (!showing) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [showing])

  if (!showing || !user) return null

  function finish(takeTour: boolean) {
    try {
      localStorage.setItem(key, '1')
    } catch {
      // The onboarding may show again next time. Nothing else depends on this.
    }
    setDone(true)
    if (takeTour) window.setTimeout(startDemoTour, 300)
  }

  // On the page body, or the chat button's separate layer would still cover Next.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="demo-onboarding-title"
      className="fixed inset-0 flex flex-col overflow-y-auto"
      style={{ zIndex: 2147483000, color: 'var(--text)', background: 'var(--bg)' }}
    >
      <style>{`
        @keyframes demo-onboarding-in { from { opacity: 0; } to { opacity: 1; } }
        .demo-onboarding-step { animation: demo-onboarding-in 0.25s ease-out; }
        @media (prefers-reduced-motion: reduce) { .demo-onboarding-step { animation: none; } }
      `}</style>

      <header className="flex items-center justify-between gap-4 px-5 py-5 sm:px-10">
        <div className="flex items-center gap-2.5" aria-hidden="true">
          <span style={{ fontSize: 24, lineHeight: 1, fontWeight: 800, letterSpacing: '-0.06em', color: 'var(--text)' }}>
            B<i style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: 'var(--v3-blue)', marginLeft: 1 }} />
          </span>
          <span className="text-base font-semibold" style={{ color: 'var(--text)' }}>Bytesgov</span>
        </div>
        <button type="button" onClick={() => finish(false)} className="v3-pill v3-pill-light v3-pill-sm">
          Skip for now
        </button>
      </header>

      <main key={step} className="demo-onboarding-step flex-1 flex items-center px-4 py-6 sm:px-10">
        <div className="w-full max-w-6xl mx-auto">
          {step === 0 && (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] items-stretch">
              <div className="v3-surface flex flex-col justify-center" style={{ padding: 'clamp(28px, 4vw, 48px)' }}>
                <h1 id="demo-onboarding-title" className="v3-h1" style={{ fontSize: 'clamp(40px, 6vw, 64px)', lineHeight: 1.02 }}>
                  Know your odds before you bid.
                </h1>
                <p className="mt-6 text-[20px] leading-[28px] font-semibold tracking-[-0.015em]">Welcome to Bytesgov, {user.firstName}</p>
                <p className="mt-3 text-[17px] leading-[26px] max-w-xl v3-muted">
                  Bytesgov is a platform for winning and delivering federal contracts. It helps government contractors, and the firms that advise them, see which opportunities are worth pursuing and carry the work from first sighting to final invoice.
                </p>
              </div>
              <div className="flex"><ExampleCard /></div>
            </div>
          )}

          {step === 1 && (
            <>
              <div className="pt-6" style={{ borderTop: '1px solid var(--line-strong)' }}>
                <h1 id="demo-onboarding-title" className="v3-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>What it does and how</h1>
                <p className="v3-lede v3-muted mt-3">From first sighting to final invoice.</p>
              </div>
              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {steps(businessType).map(({ title, what, how, icon: Icon }, index) => (
                  <div key={title} className="v3-surface" style={{ padding: 24 }}>
                    <div className="flex items-center justify-between">
                      <span className="inline-flex w-11 h-11 items-center justify-center rounded-xl" style={TILE}><Icon className="w-5 h-5" /></span>
                      <span className="text-sm tabular-nums v3-muted">Step {index + 1}</span>
                    </div>
                    <div className="mt-5 text-[20px] font-semibold tracking-[-0.02em]">{title}</div>
                    <p className="mt-2 text-[15px] font-medium">{what}</p>
                    <p className="mt-2 text-sm leading-relaxed v3-muted">{how}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="pt-6" style={{ borderTop: '1px solid var(--line-strong)' }}>
                <h1 id="demo-onboarding-title" className="v3-h1" style={{ fontSize: 'clamp(32px, 5vw, 48px)' }}>Key features</h1>
                <p className="v3-lede v3-muted mt-3">Everything in one place.</p>
              </div>
              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {FEATURES.map(({ title, body, icon: Icon }) => (
                  <div key={title} className="v3-surface" style={{ padding: 22 }}>
                    <span className="inline-flex w-9 h-9 items-center justify-center rounded-xl" style={TILE}><Icon className="w-4 h-4" /></span>
                    <div className="mt-4 text-[15px] font-semibold">{title}</div>
                    <p className="mt-1 text-[13px] leading-relaxed v3-muted">{body}</p>
                  </div>
                ))}
              </div>
              <p className="mt-6 text-sm v3-muted">
                In this demo, the client companies and contracts are invented, and the opportunities come from SAM.gov where available. Uploading and downloading files and payments are turned off, and AI features have a usage limit.
              </p>
            </>
          )}
        </div>
      </main>

      <footer className="sticky bottom-0 flex items-center justify-between gap-4 px-5 py-5 sm:px-10" style={{ background: 'var(--bg)' }}>
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0" role="img" aria-label={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map((index) => (
            <span key={index} className="h-1.5 w-4 sm:w-10 rounded-full" style={{ background: index <= step ? 'var(--text)' : 'var(--surface-3)' }} />
          ))}
        </div>
        <div className="flex gap-2 sm:gap-3">
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className="v3-pill v3-pill-light">
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
          )}
          {step < 2 ? (
            <button type="button" onClick={() => setStep(step + 1)} className="v3-pill v3-pill-dark">
              Next
            </button>
          ) : (
            <button type="button" onClick={() => finish(true)} className="v3-pill v3-pill-dark">
              Start the tour
            </button>
          )}
        </div>
      </footer>
    </div>,
    document.body,
  )
}
