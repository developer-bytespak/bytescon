import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, ChevronRight, ChevronLeft, Search, Users, Brain, BarChart3, Sparkles } from 'lucide-react'
import { ConnectClaudeWizard } from './ConnectClaudeWizard'

const STORAGE_KEY = 'bytescon_onboarded'

export function useOnboarding() {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(STORAGE_KEY) === '1')
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
    icon: <Brain className="w-10 h-10 text-cyan-400" />,
    title: 'Welcome to Bytescon',
    body: 'This platform helps small businesses find, analyze, and win federal contracts. In the next few steps we\'ll walk you through the key features.',
  },
  {
    icon: <Sparkles className="w-10 h-10 text-cyan-400" />,
    title: 'Connect to Claude (optional)',
    body: 'Use Bytescon right inside Claude — ask about opportunities, pipelines, and market data in plain English. Generate your connection and add it to Claude once; one connector gives Claude all 27 Bytescon tools. Optional — you can skip this and set it up later from Settings anytime.',
    connectClaude: true,
    optional: true,
  },
  {
    icon: <Search className="w-10 h-10 text-cyan-400" />,
    title: 'Your Opportunities Are Ready',
    body: 'No SAM.gov API key needed — we already pull federal contract data for you and refresh it daily. We\'ve loaded a starter set of recent opportunities so your board is ready on day one. Add a client and the platform automatically scores every opportunity against their NAICS codes and capability profile. Open the Opportunities page to refresh anytime.',
    action: { label: 'View Opportunities', to: '/opportunities' },
  },
  {
    icon: <Users className="w-10 h-10 text-cyan-400" />,
    title: 'Add Your Clients',
    body: 'Add the small businesses you advise as clients. Each client gets their own portal login, document vault, and compliance tracking dashboard.',
    action: { label: 'Add a Client', to: '/clients' },
  },
  {
    icon: <BarChart3 className="w-10 h-10 text-cyan-400" />,
    title: 'Run AI Analysis',
    body: 'Open any opportunity to generate an AI-powered compliance matrix and bid decision. The Analytics page shows your full market intelligence powered by historical federal award data.',
    action: { label: 'View Analytics', to: '/analytics' },
  },
]

export function OnboardingWizard({ onDismiss }: { onDismiss: () => void }) {
  const [step, setStep] = useState(0)
  const [showConnectClaude, setShowConnectClaude] = useState(false)
  const navigate = useNavigate()
  const current = STEPS[step]
  const isLast = step === STEPS.length - 1

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
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}>
      <div className="relative w-full max-w-md rounded-2xl p-8"
        style={{
          background: 'linear-gradient(135deg, #0a1a26 0%, #0f1e35 100%)',
          border: '1px solid rgba(6,182,212,0.25)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
        }}>

        {/* Close */}
        <button
          onClick={onDismiss}
          className="absolute top-4 right-4 text-slate-600 hover:text-slate-300 transition-colors"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Step dots */}
        <div className="flex gap-1.5 mb-8">
          {STEPS.map((_, i) => (
            <div key={i} className="h-1 flex-1 rounded-full transition-all"
              style={{ background: i <= step ? '#06b6d4' : 'rgba(255,255,255,0.1)' }} />
          ))}
        </div>

        {/* Icon + content */}
        <div className="flex flex-col items-center text-center gap-4 mb-8">
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center"
            style={{ background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.2)' }}>
            {current.icon}
          </div>
          <h2 className="text-xl font-bold text-slate-100">{current.title}</h2>
          <p className="text-sm text-slate-400 leading-relaxed">{current.body}</p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3">
          {step > 0 && (
            <button
              onClick={() => setStep(s => s - 1)}
              className="flex items-center gap-1 px-4 py-2 text-sm text-slate-400 hover:text-slate-200 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </button>
          )}
          <div className="flex-1" />
          {current.optional && !isLast && (
            <button
              onClick={() => setStep(s => s + 1)}
              className="px-3 py-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
            >
              Skip this step
            </button>
          )}
          {current.connectClaude && (
            <button
              onClick={handleAction}
              className="px-4 py-2 text-sm font-semibold text-cyan-300 border border-amber-500/40 rounded-lg hover:bg-cyan-500/10 transition-colors flex items-center gap-1.5"
            >
              <Sparkles className="w-4 h-4" /> Connect Claude
            </button>
          )}
          {current.action && !current.connectClaude && (
            <button
              onClick={handleAction}
              className="px-4 py-2 text-sm text-cyan-400 border border-cyan-500/30 rounded-lg hover:bg-cyan-500/10 transition-colors"
            >
              {current.action.label}
            </button>
          )}
          {isLast ? (
            <button
              onClick={onDismiss}
              className="flex items-center gap-1 px-5 py-2 text-sm font-semibold text-black rounded-lg"
              style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}
            >
              Get Started
            </button>
          ) : (
            <button
              onClick={() => setStep(s => s + 1)}
              className="flex items-center gap-1 px-5 py-2 text-sm font-semibold text-black rounded-lg"
              style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}
            >
              Next <ChevronRight className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Skip */}
        <p className="text-center mt-4">
          <button onClick={onDismiss} className="text-xs text-slate-600 hover:text-slate-500 transition-colors">
            Skip setup guide
          </button>
        </p>
      </div>
    </div>
  )
}
