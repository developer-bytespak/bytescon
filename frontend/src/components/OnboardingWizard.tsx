import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ChevronRight, ChevronLeft, Search, Users, Brain, BarChart3, Sparkles, ClipboardCheck } from 'lucide-react'
import { ConnectClaudeWizard } from './ConnectClaudeWizard'
import { isDemoSite } from '../demo/demoMode'
import { useIsContractor } from '../hooks/useAuth'

const STORAGE_KEY = 'bytesgov_onboarded'

export function useOnboarding() {
  const [dismissed, setDismissed] = useState(() => isDemoSite || localStorage.getItem(STORAGE_KEY) === '1')
  function dismiss() {
    localStorage.setItem(STORAGE_KEY, '1')
    setDismissed(true)
  }
  function replay() {
    localStorage.removeItem(STORAGE_KEY)
    setDismissed(false)
  }
  return { showWizard: !dismissed, dismiss, replay }
}

interface Step {
  icon: React.ReactNode
  title: string
  body: string
  action?: { label: string; to: string }
  /** Opens the Connect-to-Claude wizard instead of navigating. */
  connectClaude?: boolean
  /** Renders a "Skip this step" affordance — the step isn't required. */
  optional?: boolean
}

const STEPS: Step[] = [
  {
    icon: <Brain className="w-7 h-7" />,
    title: 'Welcome to Bytesgov',
    body: 'This platform helps small businesses find, analyze, and win federal contracts. In the next few steps we\'ll walk you through the key features.',
  },
  {
    icon: <Sparkles className="w-7 h-7" />,
    title: 'Connect to Claude (optional)',
    body: 'Use Bytesgov right inside Claude — ask about opportunities, pipelines, and market data in plain English. Generate your connection and add it to Claude once; one connector gives Claude all 27 Bytesgov tools. Optional — you can skip this and set it up later from Settings anytime.',
    connectClaude: true,
    optional: true,
  },
  {
    icon: <Search className="w-7 h-7" />,
    title: 'Your opportunities are ready',
    body: 'No SAM.gov API key needed — we already pull federal contract data for you and refresh it daily. We\'ve loaded a starter set of recent opportunities so your board is ready on day one. Add a client and the platform automatically scores every opportunity against their NAICS codes and capability profile. Open the Opportunities page to refresh anytime.',
    action: { label: 'View opportunities', to: '/opportunities' },
  },
  {
    icon: <Users className="w-7 h-7" />,
    title: 'Add your clients',
    body: 'Add the small businesses you advise as clients. Each client gets their own portal login, document vault, and compliance tracking dashboard.',
    action: { label: 'Add a client', to: '/clients' },
  },
  {
    icon: <BarChart3 className="w-7 h-7" />,
    title: 'Run an AI analysis',
    body: 'Open any opportunity to generate an AI-powered compliance matrix and bid decision. The Analytics page shows your full market intelligence powered by historical federal award data.',
    action: { label: 'View analytics', to: '/analytics' },
  },
]

// A contractor account bids for its own company: there are no clients to add,
// and opportunities are scored against the firm's own registration details.
const CONTRACTOR_STEPS: Step[] = STEPS.map((st) => {
  if (st.title === 'Your opportunities are ready') {
    return {
      ...st,
      body: 'No SAM.gov API key needed — we already pull federal contract data for you and refresh it daily. We\'ve loaded a starter set of recent opportunities so your board is ready on day one. Every opportunity is scored against your company\'s NAICS codes and certifications. Open the Opportunities page to refresh anytime.',
    }
  }
  if (st.title === 'Add your clients') {
    return {
      icon: <ClipboardCheck className="w-7 h-7" />,
      title: 'Complete your company profile',
      body: 'Add your SAM.gov registration, NAICS codes, set-asides and capabilities on My profile. Bytesgov uses them to score every opportunity for your company.',
      action: { label: 'Open My profile', to: '/my-company' },
    }
  }
  return st
})

export function OnboardingWizard({ onDismiss }: { onDismiss: () => void }) {
  const steps = useIsContractor() ? CONTRACTOR_STEPS : STEPS
  const [step, setStep] = useState(0)
  const [showConnectClaude, setShowConnectClaude] = useState(false)
  const navigate = useNavigate()
  const current = steps[step]
  const isLast = step === steps.length - 1

  function handleAction() {
    if (current.connectClaude) {
      setShowConnectClaude(true)
      return
    }
    if (current.action) {
      onDismiss()
      navigate(current.action.to)
    }
  }

  if (showConnectClaude) {
    return <ConnectClaudeWizard onClose={() => setShowConnectClaude(false)} />
  }

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(17,17,17,0.4)' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="onboarding-title" className="modal-panel relative w-full max-w-md p-8"
        style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-3)' }}>

        {/* Close */}
        <button
          onClick={onDismiss}
          aria-label="Close"
          className="btn-ghost btn-sm !px-2 absolute top-4 right-4"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Progress through the steps (a real sequence) */}
        <p className="text-[13px] tabular-nums mb-3" style={{ color: 'var(--text-muted)' }}>Step {step + 1} of {steps.length}</p>
        <div className="flex gap-1.5 mb-8" aria-hidden="true">
          {steps.map((_, i) => (
            <div key={i} className="h-1 flex-1 rounded-full transition-colors"
              style={{ background: i <= step ? 'var(--text)' : 'var(--surface-3)' }} />
          ))}
        </div>

        {/* Icon + content */}
        <div className="flex flex-col items-start gap-4 mb-8">
          <span className="grid place-items-center w-14 h-14 rounded-2xl" style={{ background: 'var(--surface-3)', color: 'var(--text)' }} aria-hidden="true">
            {current.icon}
          </span>
          <h2 id="onboarding-title" className="text-[24px] leading-[30px] font-semibold tracking-[-0.025em]" style={{ color: 'var(--text)' }}>{current.title}</h2>
          <p className="text-[15px] leading-[23px]" style={{ color: 'var(--text-muted)' }}>{current.body}</p>
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {step > 0 && (
            <button onClick={() => setStep(s => s - 1)} className="btn-ghost">
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
          )}
          <div className="flex-1" />
          {current.optional && !isLast && (
            <button onClick={() => setStep(s => s + 1)} className="btn-ghost btn-sm">
              Skip this step
            </button>
          )}
          {current.connectClaude && (
            <button onClick={handleAction} className="btn-secondary flex items-center gap-1.5">
              <Sparkles className="w-4 h-4" /> Connect Claude
            </button>
          )}
          {current.action && !current.connectClaude && (
            <button onClick={handleAction} className="btn-secondary">
              {current.action.label}
            </button>
          )}
          {isLast ? (
            <button onClick={onDismiss} className="btn-primary">
              Get started
            </button>
          ) : (
            <button onClick={() => setStep(s => s + 1)} className="btn-primary flex items-center gap-1">
              Next <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Skip */}
        <p className="mt-6 pt-5 text-center" style={{ borderTop: '1px solid var(--line)' }}>
          <button onClick={onDismiss} className="text-[13px] underline underline-offset-2" style={{ color: 'var(--text-muted)' }}>
            Skip setup guide
          </button>
        </p>
      </div>
    </div>
  )
}
