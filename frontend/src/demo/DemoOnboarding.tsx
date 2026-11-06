import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft, ArrowRight, BarChart3, ClipboardCheck, FileText, Gauge, KanbanSquare, Network,
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

// Colors are set directly: the app's themes restyle the usual utility classes.
const NAVY = '#0b1120'
const GOLD = '#e6c37a'
const INDIGO = '#8c9cff'
const TEXT = '#f8fafc'
const SOFT = '#cbd5e1'
const FAINT = '#94a3b8'
const CARD = { background: 'rgba(255, 255, 255, 0.05)', border: '1px solid rgba(255, 255, 255, 0.11)' }
const TILE = { background: 'rgba(230, 195, 122, 0.14)', color: GOLD }

function readSeen(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function Mark() {
  return (
    <svg width={30} height={30} viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill={GOLD} />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill={INDIGO} opacity="0.85" />
    </svg>
  )
}

/** An illustration of a scored opportunity. Not anyone's real data. */
function ExampleCard() {
  const score = 84
  const circumference = 2 * Math.PI * 42
  return (
    <div aria-hidden="true" className="rounded-2xl p-6 w-full max-w-md" style={{ ...CARD, boxShadow: '0 30px 80px rgba(0, 0, 0, 0.45)' }}>
      <div className="text-xs uppercase tracking-widest" style={{ color: FAINT }}>Example opportunity</div>
      <div className="mt-2 text-lg font-semibold" style={{ color: TEXT }}>Regional Program Support Services</div>
      <div className="text-sm" style={{ color: FAINT }}>Federal agency · Response due in 34 days</div>
      <div className="mt-5 flex items-center gap-5">
        <svg width={104} height={104} viewBox="0 0 104 104" className="shrink-0">
          <circle cx="52" cy="52" r="42" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="9" />
          <circle cx="52" cy="52" r="42" fill="none" stroke={GOLD} strokeWidth="9" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - score / 100)} transform="rotate(-90 52 52)" />
          <text x="52" y="52" textAnchor="middle" fontSize="23" fontWeight="600" fill={TEXT}>{score}%</text>
          <text x="52" y="69" textAnchor="middle" fontSize="10" fill={FAINT}>win odds</text>
        </svg>
        <div className="space-y-2 text-sm flex-1" style={{ color: SOFT }}>
          {['Industry match', 'Set-aside fit', 'Past performance'].map((factor) => (
            <div key={factor} className="flex items-center gap-2">
              <ClipboardCheck className="w-4 h-4 shrink-0" style={{ color: INDIGO }} />
              {factor}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-5 rounded-lg px-3 py-2 text-sm font-medium" style={{ background: 'rgba(140, 156, 255, 0.16)', color: TEXT }}>
        Recommendation: Bid as prime
      </div>
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
      style={{
        zIndex: 2147483000,
        color: SOFT,
        background: `radial-gradient(900px 600px at 85% 10%, rgba(140, 156, 255, 0.22), transparent 60%), radial-gradient(800px 600px at 5% 95%, rgba(230, 195, 122, 0.14), transparent 60%), ${NAVY}`,
      }}
    >
      <style>{`
        @keyframes demo-onboarding-in { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
        .demo-onboarding-step { animation: demo-onboarding-in 0.35s ease-out; }
        @media (prefers-reduced-motion: reduce) { .demo-onboarding-step { animation: none; } }
        @media (max-width: 1023px) { .demo-onboarding-footer { background: rgba(11, 17, 32, 0.92); backdrop-filter: blur(8px); } }
      `}</style>

      <header className="flex items-center justify-between gap-4 px-6 py-5 sm:px-10">
        <div className="flex items-center gap-2.5">
          <Mark />
          <span className="text-lg font-semibold" style={{ color: TEXT }}>Bytescon</span>
        </div>
        <button type="button" onClick={() => finish(false)} className="text-sm underline-offset-4 hover:underline" style={{ color: SOFT }}>
          Skip for now
        </button>
      </header>

      <main key={step} className="demo-onboarding-step flex-1 flex items-center px-6 py-6 sm:px-10">
        <div className="w-full max-w-6xl mx-auto">
          {step === 0 && (
            <div className="grid gap-10 lg:grid-cols-2 items-center">
              <div>
                <p className="text-sm font-medium uppercase tracking-widest" style={{ color: GOLD }}>Welcome to Bytescon, {user.firstName}</p>
                <h1 id="demo-onboarding-title" className="font-display mt-4 text-4xl sm:text-6xl leading-tight" style={{ color: TEXT, letterSpacing: '-0.02em' }}>
                  Know your odds <em className="font-light" style={{ color: GOLD }}>before you bid.</em>
                </h1>
                <p className="mt-6 text-lg leading-relaxed max-w-xl" style={{ color: SOFT }}>
                  Bytescon is a platform for winning and delivering federal contracts. It helps government contractors, and the firms that advise them, see which opportunities are worth pursuing and carry the work from first sighting to final invoice.
                </p>
              </div>
              <div className="flex justify-center lg:justify-end"><ExampleCard /></div>
            </div>
          )}

          {step === 1 && (
            <>
              <p className="text-sm font-medium uppercase tracking-widest" style={{ color: GOLD }}>From first sighting to final invoice</p>
              <h1 id="demo-onboarding-title" className="font-display mt-3 text-3xl sm:text-5xl" style={{ color: TEXT, letterSpacing: '-0.02em' }}>What it does and how</h1>
              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {steps(businessType).map(({ title, what, how, icon: Icon }, index) => (
                  <div key={title} className="rounded-2xl p-6" style={CARD}>
                    <div className="flex items-center justify-between">
                      <span className="inline-flex w-11 h-11 items-center justify-center rounded-xl" style={TILE}><Icon className="w-5 h-5" /></span>
                      <span className="text-sm" style={{ color: FAINT }}>Step {index + 1}</span>
                    </div>
                    <div className="mt-4 text-xl font-semibold" style={{ color: TEXT }}>{title}</div>
                    <p className="mt-2 text-sm font-medium" style={{ color: TEXT }}>{what}</p>
                    <p className="mt-2 text-sm leading-relaxed" style={{ color: SOFT }}>{how}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-sm font-medium uppercase tracking-widest" style={{ color: GOLD }}>Everything in one place</p>
              <h1 id="demo-onboarding-title" className="font-display mt-3 text-3xl sm:text-5xl" style={{ color: TEXT, letterSpacing: '-0.02em' }}>Key features</h1>
              <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {FEATURES.map(({ title, body, icon: Icon }) => (
                  <div key={title} className="rounded-xl p-4" style={CARD}>
                    <span className="inline-flex w-9 h-9 items-center justify-center rounded-lg" style={TILE}><Icon className="w-4 h-4" /></span>
                    <div className="mt-3 text-sm font-semibold" style={{ color: TEXT }}>{title}</div>
                    <p className="mt-1 text-xs leading-relaxed" style={{ color: SOFT }}>{body}</p>
                  </div>
                ))}
              </div>
              <p className="mt-6 text-sm" style={{ color: FAINT }}>
                In this demo, the client companies and contracts are invented, and the opportunities come from SAM.gov where available. Uploading and downloading files and payments are turned off, and AI features have a usage limit.
              </p>
            </>
          )}
        </div>
      </main>

      <footer className="demo-onboarding-footer sticky bottom-0 flex items-center justify-between gap-4 px-6 py-5 sm:px-10">
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0" role="img" aria-label={`Step ${step + 1} of 3`}>
          {[0, 1, 2].map((index) => (
            <span key={index} className="h-1.5 w-4 sm:w-10 rounded-full" style={{ background: index <= step ? GOLD : 'rgba(255, 255, 255, 0.18)' }} />
          ))}
        </div>
        <div className="flex gap-2 sm:gap-3">
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className="inline-flex items-center gap-2 rounded-xl px-3 sm:px-5 py-3 text-sm font-medium whitespace-nowrap" style={{ color: TEXT, border: '1px solid rgba(255, 255, 255, 0.25)' }}>
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
          )}
          {step < 2 ? (
            <button type="button" onClick={() => setStep(step + 1)} className="inline-flex items-center gap-2 rounded-xl px-4 sm:px-6 py-3 text-sm font-semibold whitespace-nowrap" style={{ background: GOLD, color: NAVY }}>
              Next <ArrowRight className="w-4 h-4" />
            </button>
          ) : (
            <button type="button" onClick={() => finish(true)} className="inline-flex items-center gap-2 rounded-xl px-4 sm:px-6 py-3 text-sm font-semibold whitespace-nowrap" style={{ background: GOLD, color: NAVY }}>
              Start the tour <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </footer>
    </div>,
    document.body,
  )
}
