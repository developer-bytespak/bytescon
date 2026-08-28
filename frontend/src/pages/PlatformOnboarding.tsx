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
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
      <div className="flex items-center gap-2">
        <Compass className="w-5 h-5 text-amber-400" />
        <h1 className="text-2xl font-bold text-gray-100">Platform &amp; Vehicle Onboarding</h1>
      </div>
      <p className="text-sm text-gray-400">
        How to get onto the federal platforms, contract vehicles, and registrations that matter,
        sequenced by prerequisite and ranked by fit. Items whose timing is unconfirmed are flagged
        for source verification rather than shown as current.
      </p>
      {PLATFORM_ONBOARDING_ENABLED ? (
        <OnboardingPanel api={onboardingApi} editable={isAdmin} />
      ) : (
        <p className="text-sm text-gray-500 border border-gray-800 rounded-lg p-4 bg-gray-900">
          This module isn’t enabled for your workspace yet. Contact your administrator to turn it on.
        </p>
      )}
    </div>
  )
}
