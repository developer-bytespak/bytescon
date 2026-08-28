// =============================================================
// Section 4 #7 — the Billing page must never show internal/config text to
// customers. When Stripe isn't configured, StripeCheckout shows polished copy,
// not env-var names.
// =============================================================
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ firm: { id: 'firm-1' } }) }))
vi.mock('../hooks/useBranding', () => ({
  useBranding: () => ({ branding: { primaryColor: '#22d3ee', secondaryColor: '#06b6d4' }, loading: false }),
}))
vi.mock('../services/api', () => ({
  billingApi: {
    getStripeCatalog: () => Promise.resolve({ configured: false, lifetime: { name: 'Lifetime', priceCents: 0, priceUsd: 0 } }),
    startLifetimeCheckout: vi.fn(),
  },
}))

import { StripeCheckout } from './StripeCheckout'

function renderWithClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <StripeCheckout hasLifetimeAccess={false} />
    </QueryClientProvider>,
  )
}

describe('StripeCheckout — unconfigured billing copy (Section 4 #7)', () => {
  it('shows polished user-facing copy, not backend config variable names', async () => {
    renderWithClient()

    expect(await screen.findByText(/checkout is temporarily unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/contact support/i)).toBeInTheDocument()

    // The old developer text must be gone.
    expect(screen.queryByText(/STRIPE_SECRET_KEY/)).not.toBeInTheDocument()
    expect(screen.queryByText(/STRIPE_WEBHOOK_SECRET/)).not.toBeInTheDocument()
    expect(screen.queryByText(/not configured on this server/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/backend env/i)).not.toBeInTheDocument()
  })
})
