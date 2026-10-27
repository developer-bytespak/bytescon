import { useState, useEffect, useRef } from 'react'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { billingApi, addonsApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useEntitlements } from '../hooks/useEntitlements'
import { StripeCheckout } from '../components/StripeCheckout'
import { PageHeader, StatusPill, SkeletonRows, Skeleton, SkeletonStats, SkeletonCards, EmptyState } from '../components/ui'
import { motion } from 'framer-motion'
import {
  CreditCard,
  CheckCircle2,
  XCircle,
  Zap,
  Users,
  Building2,
  FileText,
  Package,
  Lock,
} from 'lucide-react'

// ─── helpers ────────────────────────────────────────────────
function fmt(n: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n)
}
function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function StatusBadge({ status }: { status: string }) {
  // Tone word for StatusPill; the label below is what gets displayed.
  const map: Record<string, string> = {
    ACTIVE:        'active',
    TRIALING:      'info',
    PAST_DUE:      'overdue',
    CANCELED:      'neutral',
    PAUSED:        'on hold',
  }
  const labels: Record<string, string> = {
    ACTIVE: 'Active', TRIALING: 'Trial', PAST_DUE: 'Past Due', CANCELED: 'Canceled', PAUSED: 'Paused',
  }
  return (
    <StatusPill status={map[status] ?? map.CANCELED}>
      {labels[status] ?? status}
    </StatusPill>
  )
}

function InvoiceStatusBadge({ status }: { status: string }) {
  // Tone word for StatusPill; the raw status is what gets displayed.
  const map: Record<string, string> = {
    OPEN:          'pending',
    PAID:          'paid',
    DRAFT:         'neutral',
    VOID:          'neutral',
    UNCOLLECTIBLE: 'failed',
  }
  return (
    <StatusPill status={map[status] ?? map.DRAFT}>
      {status}
    </StatusPill>
  )
}

function UsageMeter({
  label, used, limit, icon: Icon,
}: {
  label: string; used: number; limit: number; icon: React.ElementType
}) {
  const pct = limit === -1 ? 0 : Math.min(100, Math.round((used / limit) * 100))
  const barColor = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-amber-400'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-slate-400">
          <Icon className="w-3.5 h-3.5" />
          {label}
        </span>
        <span className="text-slate-300 font-medium tabular-nums">
          {used.toLocaleString()} / {limit === -1 ? '∞' : limit.toLocaleString()}
        </span>
      </div>
      <div className="progress-track" style={{ height: 6 }}>
        {limit === -1
          ? <div className="h-full rounded-full bg-amber-400/30 w-full" />
          : <div className={`h-full rounded-full transition-all bar-grow ${barColor}`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  )
}

// ─── main component ─────────────────────────────────────────
export default function BillingPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const { entitlements } = useEntitlements()
  const qc = useQueryClient()
  const tutorial = useTutorial()
  const [showTutorial, setShowTutorial] = useState(() => !tutorial.hasSeen('billing'))
  function handleTutorialClose() { tutorial.markSeen('billing'); setShowTutorial(false) }

  const [selectedCycle, setSelectedCycle] = useState<'MONTHLY' | 'ANNUAL'>('MONTHLY')
  const [invoiceNotes, setInvoiceNotes] = useState('')
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)

  const { data: subData, isLoading: subLoading } = useQuery({
    queryKey: ['billing-subscription'],
    queryFn: () => billingApi.getSubscription(),
    staleTime: 30_000,
  })
  const { data: plansData } = useQuery({
    queryKey: ['billing-plans'],
    queryFn: () => billingApi.getPlans(),
    staleTime: 600_000,
  })
  const { data: invoicesData, isLoading: invLoading } = useQuery({
    queryKey: ['billing-invoices'],
    queryFn: () => billingApi.getInvoices({ limit: 20 }),
    staleTime: 30_000,
  })
  const { data: addonsData } = useQuery({
    queryKey: ['addons'],
    queryFn: () => addonsApi.list(),
    staleTime: 30_000,
  })

  const subscription    = subData?.subscription
  const usage           = subData?.usage
  const plan            = subscription?.plan
  const veteranDiscount = subData?.veteranDiscount ?? 0
  const effectivePrice  = subData?.effectivePrice ?? Number(plan?.monthlyPriceUsd ?? 0)
  const isVeteranOwned  = subData?.isVeteranOwned ?? false
  const hasLifetimeAccess = subData?.hasLifetimeAccess ?? false
  const plans        = (plansData?.plans ?? []) as any[]
  const invoices     = (invoicesData?.invoices ?? []) as any[]
  const addons       = (addonsData?.data ?? []) as any[]
  const tokenPacks   = (addonsData?.tokenPacks ?? []) as any[]
  const proposalTokenBalance = (addonsData?.proposalTokenBalance ?? 0) as number
  const purchasedAddons = (subData?.subscription?.consultingFirm?.purchasedAddons ?? []) as string[]

  // Stripe checkout return banner (?checkout=success|canceled)
  const [searchParams, setSearchParams] = useSearchParams()
  const checkoutResult = searchParams.get('checkout')
  useEffect(() => {
    if (checkoutResult === 'success') {
      flash('ok', 'Payment received — your access has been activated.')
      qc.invalidateQueries({ queryKey: ['billing-subscription'] })
      qc.invalidateQueries({ queryKey: ['addons'] })
      qc.invalidateQueries({ queryKey: ['entitlements'] })
      setSearchParams({}, { replace: true })
    } else if (checkoutResult === 'canceled') {
      flash('err', 'Checkout canceled — no charge was made.')
      setSearchParams({}, { replace: true })
    }
  }, [checkoutResult])

  // Lifetime deep-link (?offer=lifetime): scroll the $2,500 Founders card into
  // view and pulse it so a newly-arrived buyer can claim a slot in one click.
  const lifetimeRef = useRef<HTMLDivElement | null>(null)
  const [highlightLifetime, setHighlightLifetime] = useState(false)
  const offerParam = searchParams.get('offer')
  useEffect(() => {
    if (offerParam !== 'lifetime' || subLoading) return
    const clearOffer = () => setSearchParams((prev) => {
      const p = new URLSearchParams(prev); p.delete('offer'); return p
    }, { replace: true })
    if (!isAdmin || hasLifetimeAccess) { clearOffer(); return }
    setHighlightLifetime(true)
    const scrollT = setTimeout(() => {
      lifetimeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 200)
    const offT = setTimeout(() => setHighlightLifetime(false), 2800)
    clearOffer()
    return () => { clearTimeout(scrollT); clearTimeout(offT) }
  }, [offerParam, subLoading, isAdmin, hasLifetimeAccess])

  const flash = (type: 'ok' | 'err', text: string) => {
    setMsg({ type, text })
    setTimeout(() => setMsg(null), 4000)
  }

  const invalidateSub = () => qc.invalidateQueries({ queryKey: ['billing-subscription'] })
  const invalidateInv = () => qc.invalidateQueries({ queryKey: ['billing-invoices'] })

  const subscribeMut = useMutation({
    mutationFn: async ({ slug }: { slug: string }) => {
      const stripeTiers = ['base', 'all_access'] as const
      if (!stripeTiers.includes(slug as any)) {
        throw new Error(`Plan '${slug}' is not available for self-service checkout`)
      }
      const origin = window.location.origin
      const session = await billingApi.startSubscriptionCheckout(
        slug as 'base' | 'all_access',
        `${origin}/billing?checkout=success&tier=${slug}`,
        `${origin}/billing?checkout=canceled`,
        selectedCycle,
      )
      if (session?.url) {
        window.location.href = session.url
      } else {
        throw new Error('No checkout URL returned')
      }
    },
    onError: (err: any) => flash('err', err?.response?.data?.error ?? err?.message ?? 'Failed to start checkout'),
  })
  const cancelMut = useMutation({
    mutationFn: () => billingApi.cancel(),
    onSuccess: () => { invalidateSub(); flash('ok', 'Subscription will cancel at period end') },
    onError: () => flash('err', 'Failed to cancel subscription'),
  })
  const reactivateMut = useMutation({
    mutationFn: () => billingApi.reactivate(),
    onSuccess: () => { invalidateSub(); flash('ok', 'Subscription reactivated') },
    onError: () => flash('err', 'Failed to reactivate'),
  })
  const generateMut = useMutation({
    mutationFn: ({ notes, force }: { notes: string; force?: boolean }) => billingApi.generateInvoice(notes, force),
    onSuccess: () => {
      invalidateInv()
      setShowGenerateModal(false)
      setInvoiceNotes('')
      flash('ok', 'Invoice generated')
    },
    onError: (err: any) => {
      const code = err?.response?.data?.code
      const errorMsg = err?.response?.data?.error ?? err?.message ?? 'Failed to generate invoice'
      if (code === 'INVOICE_PERIOD_DUPLICATE') {
        if (window.confirm(errorMsg + '\n\nCreate another anyway?')) {
          generateMut.mutate({ notes: invoiceNotes, force: true })
          return
        }
        flash('err', 'Generation cancelled')
        return
      }
      flash('err', errorMsg)
    },
  })

  const downloadInvoicePdf = async (invoice: { id: string; invoiceNumber: string }) => {
    try {
      const blob = await billingApi.downloadInvoicePdf(invoice.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${invoice.invoiceNumber}.pdf`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err: any) {
      flash('err', err?.response?.data?.error ?? 'Failed to download PDF')
    }
  }
  const markStatusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      billingApi.updateInvoiceStatus(id, status),
    onSuccess: () => { invalidateInv(); flash('ok', 'Invoice updated') },
    onError: () => flash('err', 'Failed to update invoice'),
  })

  const invalidateAddons = () => qc.invalidateQueries({ queryKey: ['addons'] })
  // Add-on purchase now goes through Stripe hosted checkout (real card charge),
  // the same flow token packs use. The webhook marks the add-on owned on success.
  const purchaseMut = useMutation({
    mutationFn: async (slug: string) => {
      const origin = window.location.origin
      const session = await billingApi.startAddonCheckout(
        slug,
        `${origin}/billing?checkout=success&addon=${slug}`,
        `${origin}/billing?checkout=canceled`,
        selectedCycle,
      )
      if (session?.url) {
        window.location.href = session.url
      } else {
        throw new Error('No checkout URL returned')
      }
    },
    onError: (err: any) => flash('err', err?.response?.data?.error ?? err?.message ?? 'Failed to start checkout'),
  })
  const cancelAddonMut = useMutation({
    mutationFn: (slug: string) => addonsApi.cancel(slug),
    onSuccess: () => {
      invalidateAddons()
      qc.invalidateQueries({ queryKey: ['entitlements'] })
      flash('ok', 'Add-on cancelled')
    },
    onError: () => flash('err', 'Failed to cancel add-on'),
  })
  const tokenPackMut = useMutation({
    mutationFn: async (slug: string) => {
      const origin = window.location.origin
      const session = await billingApi.startTokenPackCheckout(
        slug,
        `${origin}/billing?checkout=success&pack=${slug}`,
        `${origin}/billing?checkout=canceled`,
      )
      if (session?.url) {
        window.location.href = session.url
      } else {
        throw new Error('No checkout URL returned')
      }
    },
    onError: (err: any) => flash('err', err?.response?.data?.error ?? err?.message ?? 'Failed to start checkout'),
  })

  // ── plan cards (single-plan model: base + all-access bundle) ──
  const PLAN_RANK: Record<string, number> = { base: 0, all_access: 1 }
  const currentRank = PLAN_RANK[plan?.slug ?? ''] ?? -1
  const selfServePlans = plans.filter((p) => p.slug === 'base' || p.slug === 'all_access')

  const trialActive = entitlements?.source === 'trial'
  const trialDaysLeft = entitlements?.trialEndsAt
    ? Math.max(0, Math.ceil((new Date(entitlements.trialEndsAt).getTime() - Date.now()) / 86_400_000))
    : 0
  const needsSubscription =
    entitlements != null && !entitlements.baseActive && entitlements.source === 'none'

  if (subLoading) {
    return (
      <div className="space-y-6">
        <span className="sr-only">Loading…</span>
        <Skeleton className="h-8 w-64" />
        <SkeletonStats count={2} />
        <div className="card"><SkeletonRows rows={4} cols={4} /></div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {showTutorial && <TutorialOverlay sectionKey="billing" onClose={handleTutorialClose} />}
      {/* Header */}
      <PageHeader title="Billing & Subscription" subtitle="Manage your plan, usage, and invoices">
        {isAdmin && (
          <button
            onClick={() => setShowGenerateModal(true)}
            className="btn-primary"
          >
            <FileText className="w-4 h-4" />
            Generate Invoice
          </button>
        )}
      </PageHeader>

      {/* Flash */}
      {msg && (
        <div className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium border animate-fade-up ${
          msg.type === 'ok'
            ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
            : 'bg-red-500/10 border-red-500/30 text-red-400'
        }`}>
          {msg.type === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
          {msg.text}
        </div>
      )}

      {/* Trial / lapsed banners */}
      {trialActive && (
        <div className="flex items-start gap-2 px-4 py-3 rounded-xl text-sm font-medium border bg-blue-500/10 border-blue-500/30 text-blue-300">
          <Zap className="w-4 h-4 flex-shrink-0 mt-0.5" />
          All-access trial — every module is unlocked. {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left.
          Subscribe below to keep access after it ends.
        </div>
      )}
      {needsSubscription && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-4 rounded-xl border bg-amber-500/10 border-amber-500/30">
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-300">Your subscription is inactive</p>
            <p className="text-xs text-slate-400 mt-0.5">
              Subscribe to Bytescon Core ($99/mo) to keep searching contracts and scoring your win probability.
            </p>
          </div>
          {isAdmin && (
            <button
              onClick={() => subscribeMut.mutate({ slug: 'base' })}
              disabled={subscribeMut.isPending}
              className="btn-primary disabled:opacity-50"
            >
              {subscribeMut.isPending ? 'Redirecting…' : 'Subscribe — $99/mo'}
            </button>
          )}
        </div>
      )}

      {/* Stripe Checkout (Lifetime card only) — available to firm admins. */}
      {isAdmin && (
        <div
          ref={lifetimeRef}
          className={`rounded-2xl transition-all duration-500 ${
            highlightLifetime ? 'ring-2 ring-amber-400/80 ring-offset-2 ring-offset-gray-950' : ''
          }`}
        >
          <StripeCheckout
            hasLifetimeAccess={hasLifetimeAccess}
          />
        </div>
      )}

      {/* Top row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Current Plan */}
        <div className="card space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="overline mb-1.5">Current Plan</p>
              <h2 className="text-xl font-semibold tracking-tight text-slate-100">{plan?.name ?? '—'}</h2>
            </div>
            <div className="flex flex-col items-end gap-2">
              {subscription && <StatusBadge status={subscription.status} />}
              {subscription?.cancelAtPeriodEnd && (
                <span className="chip chip-danger">
                  Cancels at period end
                </span>
              )}
            </div>
          </div>

          <div className="panel grid grid-cols-2 gap-4 p-4 text-sm">
            <div>
              <p className="overline">Billing Cycle</p>
              <p className="text-slate-200 font-medium mt-0.5">
                {subscription?.billingCycle === 'ANNUAL' ? 'Annual' : 'Monthly'}
              </p>
            </div>
            <div>
              <p className="overline">Monthly Rate</p>
              {isVeteranOwned && veteranDiscount > 0 ? (
                <div className="mt-0.5">
                  <span className="text-slate-500 line-through text-sm mr-1.5">
                    {plan ? fmt(Number(subscription?.billingCycle === 'ANNUAL' ? plan.annualPriceUsd : plan.monthlyPriceUsd)) : '—'}
                  </span>
                  <span className="text-green-400 font-semibold tabular-nums">{fmt(effectivePrice)}</span>
                  <span className="text-slate-500 font-normal text-xs">/mo</span>
                  <span className="ml-2 chip chip-gold">★ Veteran 10% off</span>
                </div>
              ) : (
                <p className="text-amber-400 font-semibold tabular-nums mt-0.5">
                  {plan
                    ? fmt(Number(subscription?.billingCycle === 'ANNUAL' ? plan.annualPriceUsd : plan.monthlyPriceUsd))
                    : '—'}
                  <span className="text-slate-500 font-normal text-xs">/mo</span>
                </p>
              )}
            </div>
            <div>
              <p className="overline">Period Start</p>
              <p className="text-slate-300 font-medium mt-0.5">{fmtDate(subscription?.currentPeriodStart)}</p>
            </div>
            <div>
              <p className="overline">
                {subscription?.status === 'TRIALING' ? 'Trial Ends' : 'Next Renewal'}
              </p>
              <p className="text-slate-300 font-medium mt-0.5">{fmtDate(subscription?.currentPeriodEnd)}</p>
            </div>
          </div>

          {isAdmin && subscription && (
            <div className="pt-1 flex gap-2 flex-wrap">
              {subscription.cancelAtPeriodEnd ? (
                <button
                  onClick={() => reactivateMut.mutate()}
                  disabled={reactivateMut.isPending}
                  className="btn-secondary btn-sm disabled:opacity-50"
                >
                  Reactivate Subscription
                </button>
              ) : subscription.status !== 'CANCELED' ? (
                <button
                  onClick={() => { if (confirm('Cancel subscription at period end?')) cancelMut.mutate() }}
                  disabled={cancelMut.isPending}
                  className="btn-danger btn-sm disabled:opacity-50"
                >
                  Cancel at Period End
                </button>
              ) : null}
            </div>
          )}
        </div>

        {/* Usage */}
        <div className="card space-y-5">
          <div>
            <p className="overline mb-1.5">Usage This Month</p>
            <h2 className="text-xl font-semibold tracking-tight text-slate-100">Resource Utilization</h2>
          </div>

          {usage && plan ? (
            <div className="space-y-4">
              <UsageMeter label="Active Clients"  used={usage.clients}  limit={plan.maxClients}      icon={Building2} />
              <UsageMeter label="Active Users"    used={usage.users}    limit={plan.maxUsers}        icon={Users} />
              <UsageMeter label="AI Calls (live)" used={usage.aiCalls}  limit={plan.aiCallsPerMonth} icon={Zap} />
            </div>
          ) : (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-8" />
              ))}
            </div>
          )}

          <p className="text-[11px] text-slate-600">AI calls exclude cache hits · Resets on the 1st of each month</p>
        </div>
      </div>

      {/* Plan comparison */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="text-base font-semibold text-slate-200">Available Plans</h3>
          {isAdmin && (
            <div className="segmented">
              {(['MONTHLY', 'ANNUAL'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setSelectedCycle(c)}
                  data-active={selectedCycle === c}
                >
                  {selectedCycle === c && <motion.span layoutId="billing-cycle" className="segmented-thumb" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                  {c === 'MONTHLY' ? 'Monthly' : 'Annual (save 15%)'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="stagger grid grid-cols-1 md:grid-cols-2 gap-5 max-w-4xl">
          {selfServePlans.map((p) => {
            const isCurrent = p.id === subscription?.planId && subscription?.status === 'ACTIVE'
            const price = selectedCycle === 'ANNUAL' ? Number(p.annualPriceUsd) : Number(p.monthlyPriceUsd)
            const features: string[] = Array.isArray(p.features) ? p.features : []
            const isBundle = p.slug === 'all_access'
            return (
              <div
                key={p.id}
                className={`card flex flex-col gap-4 ${isBundle && !isCurrent ? 'card-accent' : ''}`}
                style={isCurrent ? { borderColor: 'var(--success-border)', boxShadow: 'var(--shadow-2)' } : undefined}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="overline">
                      {isBundle ? 'bundle' : 'base plan'}
                    </p>
                    <h4 className="text-lg font-semibold tracking-tight text-slate-100 mt-1">{p.name}</h4>
                  </div>
                  {isCurrent ? (
                    <span className="chip chip-success mt-1">
                      Current Plan
                    </span>
                  ) : isBundle ? (
                    <span className="chip chip-accent mt-1">
                      Best value
                    </span>
                  ) : null}
                </div>

                <div>
                  <span className="kpi-value">{fmt(price)}</span>
                  <span className="text-slate-500 text-xs">/mo</span>
                  {selectedCycle === 'ANNUAL' && (
                    <p className="text-[11px] text-emerald-400 mt-1.5 tabular-nums">Billed as {fmt(price * 12)}/yr</p>
                  )}
                </div>

                <ul className="space-y-1.5 flex-1">
                  {features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-xs text-slate-400">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>

                {isAdmin && !isCurrent && (
                  <button
                    onClick={() => subscribeMut.mutate({ slug: p.slug })}
                    disabled={subscribeMut.isPending || p.purchasable === false}
                    className={`${(PLAN_RANK[p.slug] ?? 0) > currentRank ? 'btn-primary' : 'btn-secondary'} w-full disabled:opacity-50`}
                  >
                    {subscribeMut.isPending
                      ? 'Redirecting to Stripe…'
                      : (PLAN_RANK[p.slug] ?? 0) > currentRank
                        ? `Upgrade to ${p.name} →`
                        : `Subscribe to ${p.name} →`}
                  </button>
                )}
                {isCurrent && (
                  <div className="w-full py-2 rounded-lg text-sm font-semibold text-center"
                    style={{ color: 'var(--success)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
                    Current Plan
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Add-On Modules */}
      <div id="addons">
        <div className="mb-4">
          <h3 className="text-base font-semibold text-slate-200 flex items-center gap-2.5">
            <span className="tile tile-sm tile-gold"><Package className="w-3.5 h-3.5" /></span>
            Add-On Modules
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            Pay only for what you use — add or cancel any module, anytime
          </p>
        </div>

        {addons.length === 0 ? (
          <div>
            <span className="sr-only">Loading add-ons...</span>
            <SkeletonCards count={3} />
          </div>
        ) : (
          <>
            {/* Available add-ons */}
            <div className="stagger grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
              {addons.filter((a: any) => a.status === 'available').map((addon: any) => (
                <div
                  key={addon.slug}
                  className="card flex flex-col gap-3"
                  style={addon.purchased ? { borderColor: 'var(--success-border)' } : undefined}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-2xl">{addon.icon}</span>
                      <div>
                        <p className="text-sm font-semibold text-slate-100">{addon.name}</p>
                        <p className="text-[11px] text-slate-500">{addon.tagline}</p>
                      </div>
                    </div>
                    {addon.purchased && (
                      <StatusPill status="active">
                        {addon.includedInPlan ? 'Included' : 'Active'}
                      </StatusPill>
                    )}
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed flex-1">{addon.description}</p>

                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-base font-semibold tabular-nums text-slate-200">${addon.priceMonthly}</span>
                      <span className="text-slate-500 text-xs">/mo</span>
                      <span className="text-emerald-400 text-[11px] ml-2 tabular-nums">(${addon.priceAnnual}/mo annual)</span>
                    </div>
                  </div>

                  {addon.purchased ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 py-1.5 rounded-lg text-xs font-semibold text-center"
                        style={{ color: 'var(--success)', background: 'var(--success-bg)', border: '1px solid var(--success-border)' }}>
                        <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />
                        {addon.includedInPlan ? 'Included in Plan' : 'Active'}
                      </div>
                      {isAdmin && !addon.includedInPlan && (
                        <button
                          onClick={() => { if (confirm(`Cancel ${addon.name}?`)) cancelAddonMut.mutate(addon.slug) }}
                          disabled={cancelAddonMut.isPending}
                          className="btn-danger btn-sm disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  ) : isAdmin ? (
                    <button
                      onClick={() => purchaseMut.mutate(addon.slug)}
                      disabled={purchaseMut.isPending}
                      className="btn-secondary btn-sm w-full disabled:opacity-50"
                    >
                      {purchaseMut.isPending ? 'Redirecting to Stripe…' : `Add $${addon.priceMonthly}/mo →`}
                    </button>
                  ) : (
                    <div className="w-full py-1.5 rounded-lg text-xs text-center text-slate-600"
                      style={{ background: 'rgb(var(--ink) / 0.02)', border: '1px solid rgb(var(--ink) / 0.05)' }}>
                      Contact admin to activate
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Coming soon add-ons */}
            {addons.some((a: any) => a.status === 'coming_soon') && (
              <div>
                <p className="overline mb-3 flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5" /> Coming Soon
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 opacity-60">
                  {addons.filter((a: any) => a.status === 'coming_soon').map((addon: any) => (
                    <div
                      key={addon.slug}
                      className="card flex flex-col gap-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-2xl">{addon.icon}</span>
                        <div>
                          <p className="text-sm font-semibold text-slate-300">{addon.name}</p>
                          <p className="text-[11px] text-slate-600">{addon.tagline}</p>
                        </div>
                      </div>
                      <p className="text-xs text-slate-500 leading-relaxed flex-1">{addon.description}</p>
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="text-base font-bold text-slate-400">${addon.priceMonthly}</span>
                          <span className="text-slate-600 text-xs">/mo</span>
                        </div>
                        <button
                          className="btn-ghost btn-sm"
                        >
                          Notify Me
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Proposal Token Packs */}
      {tokenPacks.length > 0 && (
        <div id="proposal-tokens">
          <div className="mb-4">
            <h3 className="text-base font-semibold text-slate-200 flex items-center gap-2">
              <span className="text-lg">🪙</span>
              Proposal Token Packs
            </h3>
            <p className="text-sm text-slate-500 mt-0.5">
              One-time credit purchases — tokens never expire
            </p>
          </div>

          {/* Balance indicator */}
          <div
            className="flex flex-wrap items-center gap-3 px-4 py-3 rounded-xl mb-5 w-fit max-w-full"
            style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
          >
            <span className="text-xl">🪙</span>
            <div>
              <p className="overline">Current Balance</p>
              <p className="text-lg font-semibold tabular-nums text-amber-400">
                {proposalTokenBalance} proposal token{proposalTokenBalance !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="ml-4 text-xs text-slate-500 space-y-0.5">
              <p>Outline = <span className="text-slate-300 font-medium">1 token</span></p>
              <p>Full Draft PDF = <span className="text-slate-300 font-medium">5 tokens</span></p>
            </div>
          </div>

          <div className="stagger grid grid-cols-1 md:grid-cols-3 gap-4">
            {tokenPacks.map((pack: any) => (
              <div
                key={pack.slug}
                className="card flex flex-col gap-3"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-2xl">{pack.icon}</span>
                    <div>
                      <p className="text-sm font-semibold text-slate-100">{pack.name}</p>
                      <p className="text-[11px] text-slate-500">{pack.tagline}</p>
                    </div>
                  </div>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed flex-1">{pack.description}</p>

                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xl font-semibold tabular-nums text-amber-400">${pack.priceMonthly}</span>
                    <span className="text-slate-500 text-xs ml-1">one-time</span>
                  </div>
                  <span className="chip chip-success tabular-nums">
                    {pack.tokenAmount} tokens
                  </span>
                </div>

                {isAdmin ? (
                  <button
                    onClick={() => tokenPackMut.mutate(pack.slug)}
                    disabled={tokenPackMut.isPending}
                    className="btn-secondary btn-sm w-full disabled:opacity-50"
                  >
                    {tokenPackMut.isPending ? 'Redirecting to Stripe…' : `Buy ${pack.tokenAmount} Tokens — $${pack.priceMonthly}`}
                  </button>
                ) : (
                  <div className="w-full py-1.5 rounded-lg text-xs text-center text-slate-600"
                    style={{ background: 'rgb(var(--ink) / 0.02)', border: '1px solid rgb(var(--ink) / 0.05)' }}>
                    Contact admin to purchase
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Invoice history */}
      <div>
        <h3 className="text-base font-semibold text-slate-200 mb-4">Invoice History</h3>
        <div className="table-wrap">
          {invLoading ? (
            <div className="px-4">
              <span className="sr-only">Loading invoices…</span>
              <SkeletonRows rows={4} cols={5} />
            </div>
          ) : invoices.length === 0 ? (
            <EmptyState
              message="No invoices yet"
              icon={<FileText className="w-5 h-5" />}
              hint={isAdmin ? 'Use "Generate Invoice" above to create your first invoice' : null}
            />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  {['Invoice #', 'Period', 'Amount', 'Due', 'Status', ...(isAdmin ? ['Actions'] : [])].map((h) => (
                    <th key={h} className={h === 'Amount' ? 'text-right' : undefined}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv: any) => (
                  <tr
                    key={inv.id}
                  >
                    <td className="font-mono text-xs text-amber-400">{inv.invoiceNumber}</td>
                    <td className="text-slate-400 text-xs whitespace-nowrap tabular-nums">
                      {fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}
                    </td>
                    <td className="text-slate-200 font-semibold text-right tabular-nums">{fmt(Number(inv.totalUsd))}</td>
                    <td className="text-slate-400 text-xs whitespace-nowrap tabular-nums">{fmtDate(inv.dueAt)}</td>
                    <td><InvoiceStatusBadge status={inv.status} /></td>
                    {isAdmin && (
                      <td>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => downloadInvoicePdf(inv)}
                            className="btn-secondary btn-sm"
                            title="Download PDF"
                          >
                            PDF
                          </button>
                          {inv.status === 'OPEN' && (
                            <>
                              <button
                                onClick={() => markStatusMut.mutate({ id: inv.id, status: 'PAID' })}
                                disabled={markStatusMut.isPending}
                                className="btn-secondary btn-sm disabled:opacity-50"
                              >
                                Mark Paid
                              </button>
                              <button
                                onClick={() => markStatusMut.mutate({ id: inv.id, status: 'VOID' })}
                                disabled={markStatusMut.isPending}
                                className="btn-ghost btn-sm disabled:opacity-50"
                              >
                                Void
                              </button>
                            </>
                          )}
                          {inv.status === 'PAID' && inv.paidAt && (
                            <span className="text-[11px] text-slate-600">Paid {fmtDate(inv.paidAt)}</span>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Generate Invoice Modal */}
      {showGenerateModal && (
        <div
          className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowGenerateModal(false)}
        >
          <div
            className="modal-panel rounded-2xl p-6 w-full max-w-md space-y-4"
            style={{ background: 'var(--surface)', border: '1px solid var(--line)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-slate-100">Generate Invoice</h3>
            <p className="text-sm text-slate-400">
              Creates an invoice for the current subscription period at the active plan rate.
            </p>
            <div>
              <label className="label">Notes (optional)</label>
              <textarea
                value={invoiceNotes}
                onChange={(e) => setInvoiceNotes(e.target.value)}
                rows={3}
                placeholder="Add any notes to appear on the invoice…"
                className="input resize-none"
              />
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowGenerateModal(false)}
                className="btn-ghost"
              >
                Cancel
              </button>
              <button
                onClick={() => generateMut.mutate({ notes: invoiceNotes })}
                disabled={generateMut.isPending}
                className="btn-primary disabled:opacity-50"
              >
                {generateMut.isPending ? 'Generating…' : 'Generate Invoice'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
