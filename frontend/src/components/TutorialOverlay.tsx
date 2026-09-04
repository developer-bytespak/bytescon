import { useState, useEffect } from 'react'
import { X, Coins, LayoutDashboard, Target, Users, BarChart3, CreditCard, CheckCircle } from 'lucide-react'
import { useTutorial, TutorialKey } from '../hooks/useTutorial'

interface Section {
  icon: React.ReactNode
  title: string
  body: string
}

const SECTION_CONTENT: Record<TutorialKey, { heading: string; description: string }> = {
  dashboard: {
    heading: 'Your Command Center',
    description:
      'The Dashboard shows your live pipeline at a glance: top-scored opportunities, upcoming deadlines, recent bid decisions, and your firm\'s win-rate trend. Everything that needs your attention today is surfaced here.',
  },
  opportunities: {
    heading: 'Contract Opportunities',
    description:
      'Browse every active federal contract from SAM.gov, pre-scored against your firm\'s NAICS codes, set-aside status, and past performance. Filter by score, deadline, agency, or value. Click any row to run a full Bid/No-Bid analysis.',
  },
  clients: {
    heading: 'Your Client Companies',
    description:
      'Each client company is a separate contractor profile with its own NAICS codes, certifications, and bid history. Add clients here, then run scoring and decision analysis specifically tailored to each firm\'s capabilities.',
  },
  decisions: {
    heading: 'Bid / No-Bid Engine',
    description:
      'For each opportunity, the Bytescon Engine runs a 9-factor logistic model and outputs a Pursue, Conditional, or Do Not Pursue recommendation — with a full breakdown of every score and the reasoning behind it. Every decision is logged to your audit trail.',
  },
  analytics: {
    heading: 'Market Intelligence',
    description:
      'Deep analytics sourced from SAM.gov and USAspending: win-rate trends by NAICS, agency set-aside utilization, competitor patterns, revenue forecasts, and portfolio health. Use this to focus your BD effort where the odds are actually in your favor.',
  },
  billing: {
    heading: 'Tokens & Subscription',
    description:
      'Proposal tokens power the AI features: compliance outlines cost 1 token, full proposal draft PDFs cost 5 tokens. During your free trial you receive 70 tokens every Monday — roughly 10 contracts per week. You can purchase additional token packs here at any time.',
  },
}

const PLATFORM_SECTIONS: Section[] = [
  { icon: <LayoutDashboard className="w-4 h-4" />, title: 'Dashboard',     body: 'Live pipeline, deadlines, and win-rate at a glance.' },
  { icon: <Target className="w-4 h-4" />,          title: 'Opportunities', body: 'SAM.gov contracts scored against your profile.' },
  { icon: <Users className="w-4 h-4" />,           title: 'Clients',       body: 'Manage multiple contractor profiles independently.' },
  { icon: <CheckCircle className="w-4 h-4" />,     title: 'Decisions',     body: '9-factor Bid/No-Bid engine with full audit trail.' },
  { icon: <BarChart3 className="w-4 h-4" />,       title: 'Analytics',     body: 'Market intelligence and revenue forecasting.' },
  { icon: <CreditCard className="w-4 h-4" />,      title: 'Billing',       body: 'Token packs and subscription management.' },
]

interface Props {
  sectionKey: TutorialKey
  onClose: () => void
}

export function TutorialOverlay({ sectionKey, onClose }: Props) {
  const [step, setStep] = useState<'welcome' | 'section'>('welcome')
  const content = SECTION_CONTENT[sectionKey]

  // Dashboard shows the full platform welcome. All other sections go straight
  // to the section-specific content (skip the welcome step).
  useEffect(() => {
    if (sectionKey !== 'dashboard') setStep('section')
  }, [sectionKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // Backdrop click and Escape both dismiss; the card scrolls on short
    // viewports so the confirm button is always reachable.
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto px-4 py-6">
      <button
        type="button"
        className="fixed inset-0 bg-black/70 backdrop-blur-sm cursor-default"
        aria-label="Dismiss guide"
        onClick={onClose}
      />
      <div
        className="relative w-full max-w-xl max-h-[calc(100vh-3rem)] overflow-y-auto bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Section guide"
      >
        {/* Accent bar */}
        <div className="h-px w-full bg-gray-700" />

        <div className="p-6">
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Close tutorial"
          >
            <X className="w-5 h-5" />
          </button>

          {step === 'welcome' ? (
            <>
              <p className="text-xs text-amber-400 uppercase tracking-widest mb-1 font-mono">Welcome to</p>
              <h2 className="text-2xl font-bold text-white mb-1">Bytescon</h2>
              <p className="text-gray-400 text-sm mb-5">
                The pursuit-to-proposal operating system for federal contractors. Every score is explainable.
                Every decision is auditable. Every recommendation is built on real procurement data.
              </p>

              {/* Token callout */}
              <div className="bg-amber-950/30 border border-amber-700/50 rounded-xl p-4 mb-5">
                <div className="flex items-center gap-2 mb-2">
                  <Coins className="w-4 h-4 text-amber-400" />
                  <span className="text-amber-300 font-semibold text-sm">Your Trial Tokens</span>
                </div>
                <p className="text-gray-300 text-sm">
                  During your free trial you receive <strong className="text-amber-400">70 tokens every Monday</strong> — enough
                  to run compliance analysis on roughly 10 contracts per week (1 token per outline,
                  5 tokens per full proposal draft). Need more? You can purchase additional packs
                  anytime in <span className="text-amber-400">Billing → Token Packs</span>.
                </p>
              </div>

              {/* Section map */}
              <p className="text-gray-400 text-xs uppercase tracking-widest mb-3">What's inside</p>
              <div className="grid grid-cols-2 gap-2 mb-6">
                {PLATFORM_SECTIONS.map((s) => (
                  <div key={s.title} className="bg-gray-800 rounded-lg p-3 flex gap-2">
                    <span className="text-amber-400 mt-0.5 shrink-0">{s.icon}</span>
                    <div>
                      <p className="text-white text-xs font-semibold">{s.title}</p>
                      <p className="text-gray-400 text-[11px] leading-snug">{s.body}</p>
                    </div>
                  </div>
                ))}
              </div>

              <button
                onClick={() => setStep('section')}
                className="btn-primary w-full py-2.5 text-sm"
              >
                Show me the Dashboard →
              </button>
            </>
          ) : (
            <>
              <p className="text-xs text-amber-400 uppercase tracking-widest mb-1 font-mono">Quick overview</p>
              <h2 className="text-xl font-bold text-white mb-3">{content.heading}</h2>
              <p className="text-gray-300 text-sm leading-relaxed mb-6">{content.description}</p>

              {sectionKey !== 'dashboard' && (
                <div className="bg-gray-800 rounded-lg p-3 mb-5 text-xs text-gray-400">
                  <span className="text-amber-400 font-semibold">Tip: </span>
                  You can rewatch all section guides anytime from{' '}
                  <span className="text-white">Settings → Rerun Tutorials</span>.
                </div>
              )}

              <button
                onClick={onClose}
                className="btn-primary w-full py-2.5 text-sm"
              >
                Got it — let me explore
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
