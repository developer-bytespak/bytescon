import { Compass } from 'lucide-react'
import { OnboardingPanel } from '../gb106/components/OnboardingPanel'
import { onboardingApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'

// GB-106 frontend flag — prod default OFF, enable last in the staged rollout.
const PLATFORM_ONBOARDING_ENABLED =
  (import.meta as any).env?.VITE_PLATFORM_ONBOARDING_ENABLED === 'true'

export default function PlatformOnboarding() {
  // Read-only team members (CONSULTANT) may view the checklist but not edit
  // progress — the PUT /onboarding/progress write is admin-only (and the
  // backend now 403s consultant writes), so hide the edit affordance for them.
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start gap-3">
        <span className="tile tile-accent mt-0.5"><Compass className="w-5 h-5" /></span>
        <div className="min-w-0">
          <h1 className="page-title">Platform &amp; Vehicle Onboarding</h1>
          <p className="page-subtitle max-w-2xl">
            How to get onto the federal platforms, contract vehicles, and registrations that matter,
            sequenced by prerequisite and ranked by fit. Items whose timing is unconfirmed are flagged
            for source verification rather than shown as current.
          </p>
        </div>
      </div>
      {PLATFORM_ONBOARDING_ENABLED ? (
        <OnboardingPanel api={onboardingApi} editable={isAdmin} />
      ) : (
        <p className="card text-sm" style={{ color: 'var(--text-muted)' }}>
          This module isn’t enabled for your workspace yet. Contact your administrator to turn it on.
        </p>
      )}
    </div>
  )
}
