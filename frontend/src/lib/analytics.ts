import posthog from 'posthog-js'

const POSTHOG_KEY = (import.meta as any).env?.VITE_POSTHOG_KEY
// api_host is the ingest endpoint — in prod this is our own /ingest reverse
// proxy (set via build arg) so ad/tracker blockers can't drop analytics.
const POSTHOG_HOST = (import.meta as any).env?.VITE_POSTHOG_HOST || 'https://us.i.posthog.com'
// ui_host is the PostHog dashboard origin, used only for "view in PostHog" links.
const POSTHOG_UI_HOST = (import.meta as any).env?.VITE_POSTHOG_UI_HOST || 'https://us.posthog.com'

export const analyticsEnabled = !!POSTHOG_KEY

export function initAnalytics() {
  if (!POSTHOG_KEY) return
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    ui_host: POSTHOG_UI_HOST,
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: true,
    person_profiles: 'identified_only',
  })
}

interface IdentifiedUser {
  id: string
  email: string
  role: string
}

interface IdentifiedFirm {
  id: string
  name: string
}

export function identifyUser(user: IdentifiedUser, firm: IdentifiedFirm | null) {
  if (!POSTHOG_KEY) return
  posthog.identify(user.id, {
    email: user.email,
    role: user.role,
    firmId: firm?.id,
    firmName: firm?.name,
  })
  if (firm?.id) posthog.group('firm', firm.id, { name: firm.name })
}

export function resetAnalytics() {
  if (!POSTHOG_KEY) return
  posthog.reset()
}

export function trackEvent(event: string, properties?: Record<string, unknown>) {
  if (!POSTHOG_KEY) return
  posthog.capture(event, properties)
}
