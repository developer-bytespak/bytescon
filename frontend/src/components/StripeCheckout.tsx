import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CreditCard, CheckCircle2, Loader, AlertCircle, Lock, Star } from 'lucide-react'
import { billingApi } from '../services/api'
import { useIsContractor } from '../hooks/useAuth'
import { contractorPlanFeature } from '../lib/contractorWording'

interface Catalog {
  configured: boolean
  lifetime: { name: string; priceCents: number; priceUsd: number }
}

// Add-ons live in a single place on the Billing page (the main add-ons grid),
// so this component renders only the Lifetime card.
interface Props {
  hasLifetimeAccess: boolean
}

export function StripeCheckout({ hasLifetimeAccess }: Props) {
  const isContractor = useIsContractor()
  const planText = (text: string) => (isContractor ? contractorPlanFeature(text) : text)
  const [loadingItem, setLoadingItem] = useState<string | null>(null)
  const [error, setError] = useState('')

  const { data, isLoading } = useQuery<Catalog>({
    queryKey: ['stripe-catalog'],
    queryFn: () => billingApi.getStripeCatalog(),
  })

  const handleLifetimeCheckout = async () => {
    setError('')
    setLoadingItem('lifetime')
    try {
      const origin = window.location.origin
      const session = await billingApi.startLifetimeCheckout(
        `${origin}/billing?checkout=success`,
        `${origin}/billing?checkout=canceled`
      )
      if (session?.url) {
        window.location.href = session.url
      } else {
        throw new Error('No checkout URL returned')
      }
    } catch (err: any) {
      setError(err?.response?.data?.error || err.message || 'Failed to start checkout')
      setLoadingItem(null)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader className="w-5 h-5 animate-spin text-gray-500" />
      </div>
    )
  }

  if (!data?.configured) {
    return (
      <div className="bg-[var(--warning-bg)] rounded-2xl p-4 text-sm text-[color:var(--warning)] flex gap-2">
        <AlertCircle className="w-5 h-5 flex-shrink-0" />
        <div>
          <p className="font-medium">Online checkout is temporarily unavailable</p>
          <p className="text-[color:var(--warning)] text-xs mt-1">
            We can’t start a subscription right now. Please try again shortly, or contact support and we’ll get you set up.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-[var(--danger-bg)] rounded-2xl p-3 text-sm text-[color:var(--danger-text)] flex gap-2">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      {/* Lifetime access card */}
      <div className="card relative">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            <span className="tile w-10 h-10 flex items-center justify-center">
              <Star className="w-5 h-5" />
            </span>
            <div>
              <h3 className="text-xl font-semibold text-gray-100">{data.lifetime.name}</h3>
              <p className="text-[13px] text-gray-400 mt-0.5">One-time payment · lifetime access</p>
            </div>
          </div>
          {hasLifetimeAccess && (
            <span className="chip chip-success">
              <CheckCircle2 className="w-3.5 h-3.5" /> Owned
            </span>
          )}
        </div>

        <div className="flex items-baseline gap-2 mb-4">
          <span className="v3-figure text-gray-100">
            ${data.lifetime.priceUsd.toLocaleString()}
          </span>
          <span className="text-sm text-gray-500">USD · one-time</span>
        </div>

        <ul className="text-sm text-gray-300 space-y-1.5 mb-5">
          <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} /> The Core plan and all add-on modules, forever</li>
          <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} /> {planText('Set-Aside Intel · Teaming · Contract Analysis · Proposal Studio · Market Intel · Auto-Sync · API/MCP · Client Portal')}</li>
          <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} /> 200 proposal tokens up front, then 50 every month</li>
          <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} /> {planText('10 seats · unlimited client companies')}</li>
          <li className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} /> Founding Member badge & priority support</li>
        </ul>

        <button
          onClick={handleLifetimeCheckout}
          disabled={hasLifetimeAccess || loadingItem === 'lifetime'}
          className="btn-primary w-full"
        >
          {loadingItem === 'lifetime' ? (
            <><Loader className="w-4 h-4 animate-spin" /> Redirecting to Stripe...</>
          ) : hasLifetimeAccess ? (
            <><Lock className="w-4 h-4" /> Lifetime access active</>
          ) : (
            <><CreditCard className="w-4 h-4" /> Get lifetime access</>
          )}
        </button>
      </div>

      <p className="text-xs text-gray-500 text-center">
        Secure checkout powered by Stripe
      </p>
    </div>
  )
}
