import { useState, useEffect, useRef } from 'react'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { billingApi, addonsApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useEntitlements } from '../hooks/useEntitlements'
import { StripeCheckout } from '../components/StripeCheckout'
import {
  CreditCard,
  CheckCircle2,
  XCircle,
  Zap,
  Users,
  Building2,
  FileText,
  RefreshCw,
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
  const map: Record<string, string> = {
    ACTIVE:        'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    TRIALING:      'bg-blue-500/15 text-blue-400 border-blue-500/30',
    PAST_DUE:      'bg-red-500/15 text-red-400 border-red-500/30',
    CANCELED:      'bg-slate-500/15 text-slate-400 border-slate-500/30',
    PAUSED:        'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  }
  const labels: Record<string, string> = {
    ACTIVE: 'Active', TRIALING: 'Trial', PAST_DUE: 'Past Due', CANCELED: 'Canceled', PAUSED: 'Paused',
  }
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${map[status] ?? map.CANCELED}`}>
      {labels[status] ?? status}
    </span>
  )
}

function InvoiceStatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    OPEN:          'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    PAID:          'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    DRAFT:         'bg-slate-500/15 text-slate-400 border-slate-500/30',
    VOID:          'bg-slate-500/10 text-slate-600 border-slate-500/20',
    UNCOLLECTIBLE: 'bg-red-500/15 text-red-400 border-red-500/30',
  }
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${map[status] ?? map.DRAFT}`}>
      {status}
    </span>
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
        <span className="text-slate-300 font-medium">
          {used.toLocaleString()} / {limit === -1 ? '∞' : limit.toLocaleString()}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
        {limit === -1
          ? <div className="h-full rounded-full bg-amber-400/30 w-full" />
          : <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />}
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
  const planBorder: Record<string, string> = {
    base: 'rgba(91,116,255,0.35)',
    all_access: 'rgba(168,85,247,0.35)',
  }
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
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-6 h-6 text-amber-400 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {showTutorial && <TutorialOverlay sectionKey="billing" onClose={handleTutorialClose} />}
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-100">Billing & Subscription</h1>
          <p className="text-sm text-slate-500 mt-0.5">Manage your plan, usage, and invoices</p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowGenerateModal(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all"
            style={{ background: 'rgba(91,116,255,0.15)', border: '1px solid rgba(91,116,255,0.3)', color: '#5b74ff' }}
          >
            <FileText className="w-4 h-4" />
            Generate Invoice
          </button>
        )}
      </div>

      {/* Flash */}
      {msg && (
        <div className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium border ${
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
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg text-sm font-medium border bg-blue-500/10 border-blue-500/30 text-blue-300">
          <Zap className="w-4 h-4" />
          All-access trial — every module is unlocked. {trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left.
          Subscribe below to keep access after it ends.
        </div>
      )}
      {needsSubscription && (
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 px-4 py-4 rounded-lg border bg-amber-500/10 border-amber-500/30">
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
              className="px-4 py-2 rounded-lg text-sm font-bold transition-all disabled:opacity-50"
              style={{ background: '#5b74ff', color: '#131318' }}
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
            highlightLifetime ? 'ring-2 ring-amber-400/80 ring-offset-2 ring-offset-[#0b0b0f]' : ''
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
        <div className="rounded-xl p-6 space-y-4"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1">Current Plan</p>
              <h2 className="text-xl font-bold text-slate-100">{plan?.name ?? '—'}</h2>
            </div>
            <div className="flex flex-col items-end gap-2">
              {subscription && <StatusBadge status={subscription.status} />}
              {subscription?.cancelAtPeriodEnd && (
                <span className="text-[10px] text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-full">
                  Cancels at period end
                </span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-slate-600 text-[11px] uppercase tracking-wide">Billing Cycle</p>
              <p className="text-slate-200 font-medium mt-0.5">
                {subscription?.billingCycle === 'ANNUAL' ? 'Annual' : 'Monthly'}
              </p>
            </div>
            <div>
              <p className="text-slate-600 text-[11px] uppercase tracking-wide">Monthly Rate</p>
              {isVeteranOwned && veteranDiscount > 0 ? (
                <div className="mt-0.5">
                  <span className="text-slate-500 line-through text-sm mr-1.5">
                    {plan ? fmt(Number(subscription?.billingCycle === 'ANNUAL' ? plan.annualPriceUsd : plan.monthlyPriceUsd)) : '—'}
                  </span>
                  <span className="text-green-400 font-bold">{fmt(effectivePrice)}</span>
                  <span className="text-slate-500 font-normal text-xs">/mo</span>
                  <span className="ml-2 text-[10px] bg-amber-900/30 text-amber-400 border border-amber-700/40 rounded-full px-2 py-0.5">★ Veteran 10% off</span>
                </div>
              ) : (
                <p className="text-amber-400 font-bold mt-0.5">
                  {plan
                    ? fmt(Number(subscription?.billingCycle === 'ANNUAL' ? plan.annualPriceUsd : plan.monthlyPriceUsd))
                    : '—'}
                  <span className="text-slate-500 font-normal text-xs">/mo</span>
                </p>
              )}
            </div>
            <div>
              <p className="text-slate-600 text-[11px] uppercase tracking-wide">Period Start</p>
              <p className="text-slate-300 font-medium mt-0.5">{fmtDate(subscription?.currentPeriodStart)}</p>
            </div>
            <div>
              <p className="text-slate-600 text-[11px] uppercase tracking-wide">
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
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all disabled:opacity-50"
                >
                  Reactivate Subscription
                </button>
              ) : subscription.status !== 'CANCELED' ? (
                <button
                  onClick={() => { if (confirm('Cancel subscription at period end?')) cancelMut.mutate() }}
                  disabled={cancelMut.isPending}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-all disabled:opacity-50"
                >
                  Cancel at Period End
                </button>
              ) : null}
            </div>
          )}
        </div>

        {/* Usage */}
        <div className="rounded-xl p-6 space-y-5"
          style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
          <div>
            <p className="text-[11px] text-slate-500 uppercase tracking-widest mb-1">Usage This Month</p>
            <h2 className="text-xl font-bold text-slate-100">Resource Utilization</h2>
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
                <div key={i} className="h-8 rounded bg-white/5 animate-pulse" />
              ))}
            </div>
          )}

          <p className="text-[11px] text-slate-600">AI calls exclude cache hits · Resets on the 1st of each month</p>
        </div>
      </div>

      {/* Plan comparison */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-bold text-slate-200">Available Plans</h3>
          {isAdmin && (
            <div className="flex items-center gap-1 p-1 rounded-lg"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
              {(['MONTHLY', 'ANNUAL'] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setSelectedCycle(c)}
                  className={`px-3 py-1 rounded text-xs font-semibold transition-all ${
                    selectedCycle === c ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {c === 'MONTHLY' ? 'Monthly' : 'Annual (save 15%)'}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 max-w-4xl">
          {selfServePlans.map((p) => {
            const isCurrent = p.id === subscription?.planId && subscription?.status === 'ACTIVE'
            const price = selectedCycle === 'ANNUAL' ? Number(p.annualPriceUsd) : Number(p.monthlyPriceUsd)
            const features: string[] = Array.isArray(p.features) ? p.features : []
            const isBundle = p.slug === 'all_access'
            return (
              <div
                key={p.id}
                className="rounded-xl p-5 flex flex-col gap-4 transition-all"
                style={{
                  background: isCurrent ? 'rgba(34,197,94,0.04)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${isCurrent ? 'rgba(34,197,94,0.45)' : (planBorder[p.slug] ?? 'rgba(255,255,255,0.07)')}`,
                  boxShadow: isCurrent ? '0 0 20px rgba(34,197,94,0.08)' : isBundle ? '0 0 20px rgba(168,85,247,0.08)' : undefined,
                }}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-[11px] text-slate-500 uppercase tracking-widest">
                      {isBundle ? 'bundle' : 'base plan'}
                    </p>
                    <h4 className="text-lg font-bold text-slate-100 mt-0.5">{p.name}</h4>
                  </div>
                  {isCurrent ? (
                    <span className="text-[10px] font-semibold px-2 py-0.5 mt-1 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                      Current Plan
                    </span>
                  ) : isBundle ? (
                    <span className="text-[10px] font-semibold px-2 py-0.5 mt-1 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30">
                      Best value
                    </span>
                  ) : null}
                </div>

                <div>
                  <span className="text-2xl font-bold text-slate-100">{fmt(price)}</span>
                  <span className="text-slate-500 text-xs">/mo</span>
                  {selectedCycle === 'ANNUAL' && (
                    <p className="text-[11px] text-emerald-400 mt-0.5">Billed as {fmt(price * 12)}/yr</p>
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
                    className="w-full py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-50"
                    style={{
                      background: (PLAN_RANK[p.slug] ?? 0) > currentRank ? 'rgba(91,116,255,0.15)' : 'rgba(255,255,255,0.04)',
                      border: (PLAN_RANK[p.slug] ?? 0) > currentRank ? '1px solid rgba(91,116,255,0.35)' : '1px solid rgba(255,255,255,0.08)',
                      color: (PLAN_RANK[p.slug] ?? 0) > currentRank ? '#5b74ff' : '#b3aebb',
                    }}
                  >
                    {subscribeMut.isPending
                      ? 'Redirecting to Stripe…'
                      : (PLAN_RANK[p.slug] ?? 0) > currentRank
                        ? `Upgrade to ${p.name} →`
                        : `Subscribe to ${p.name} →`}
                  </button>
                )}
                {isCurrent && (
                  <div className="w-full py-2 rounded-lg text-sm font-semibold text-center text-emerald-500"
                    style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.25)' }}>
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
          <h3 className="text-base font-bold text-slate-200 flex items-center gap-2">
            <Package className="w-4 h-4 text-amber-400" />
            Add-On Modules
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            Pay only for what you use — add or cancel any module, anytime
          </p>
        </div>

        {addons.length === 0 ? (
          <div className="flex items-center gap-2 py-4 text-slate-600 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" /> Loading add-ons...
          </div>
        ) : (
          <>
            {/* Available add-ons */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
              {addons.filter((a: any) => a.status === 'available').map((addon: any) => (
                <div
                  key={addon.slug}
                  className="rounded-xl p-5 flex flex-col gap-3 transition-all"
                  style={{
                    background: addon.purchased ? 'rgba(34,197,94,0.04)' : 'rgba(255,255,255,0.03)',
                    border: `1px solid ${addon.purchased ? 'rgba(34,197,94,0.35)' : 'rgba(255,255,255,0.08)'}`,
                  }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{addon.icon}</span>
                      <div>
                        <p className="text-sm font-semibold text-slate-100">{addon.name}</p>
                        <p className="text-[11px] text-slate-500">{addon.tagline}</p>
                      </div>
                    </div>
                    {addon.purchased && (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 whitespace-nowrap">
                        {addon.includedInPlan ? 'Included' : 'Active'}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed flex-1">{addon.description}</p>

                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-base font-bold text-slate-200">${addon.priceMonthly}</span>
                      <span className="text-slate-500 text-xs">/mo</span>
                      <span className="text-emerald-400 text-[11px] ml-2">(${addon.priceAnnual}/mo annual)</span>
                    </div>
                  </div>

                  {addon.purchased ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 py-1.5 rounded-lg text-xs font-semibold text-center text-emerald-500"
                        style={{ background: 'rgba(34,197,94,0.05)', border: '1px solid rgba(34,197,94,0.25)' }}>
                        <CheckCircle2 className="w-3.5 h-3.5 inline mr-1" />
                        {addon.includedInPlan ? 'Included in Plan' : 'Active'}
                      </div>
                      {isAdmin && !addon.includedInPlan && (
                        <button
                          onClick={() => { if (confirm(`Cancel ${addon.name}?`)) cancelAddonMut.mutate(addon.slug) }}
                          disabled={cancelAddonMut.isPending}
                          className="text-[11px] px-2 py-1.5 rounded-lg transition-all disabled:opacity-50"
                          style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', color: '#f87171' }}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  ) : isAdmin ? (
                    <button
                      onClick={() => purchaseMut.mutate(addon.slug)}
                      disabled={purchaseMut.isPending}
                      className="w-full py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50"
                      style={{ background: 'rgba(91,116,255,0.12)', border: '1px solid rgba(91,116,255,0.3)', color: '#5b74ff' }}
                    >
                      {purchaseMut.isPending ? 'Redirecting to Stripe…' : `Add $${addon.priceMonthly}/mo →`}
                    </button>
                  ) : (
                    <div className="w-full py-1.5 rounded-lg text-xs text-center text-slate-600"
                      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                      Contact admin to activate
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Coming soon add-ons */}
            {addons.some((a: any) => a.status === 'coming_soon') && (
              <div>
                <p className="text-xs text-slate-600 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5" /> Coming Soon
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 opacity-60">
                  {addons.filter((a: any) => a.status === 'coming_soon').map((addon: any) => (
                    <div
                      key={addon.slug}
                      className="rounded-xl p-5 flex flex-col gap-3"
                      style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}
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
                          className="text-xs px-3 py-1.5 rounded-lg"
                          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: '#8f8a99' }}
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
            <h3 className="text-base font-bold text-slate-200 flex items-center gap-2">
              <span className="text-lg">🪙</span>
              Proposal Token Packs
            </h3>
            <p className="text-sm text-slate-500 mt-0.5">
              One-time credit purchases — tokens never expire
            </p>
          </div>

          {/* Balance indicator */}
          <div
            className="flex items-center gap-3 px-4 py-3 rounded-xl mb-5 w-fit"
            style={{ background: 'rgba(91,116,255,0.08)', border: '1px solid rgba(91,116,255,0.2)' }}
          >
            <span className="text-xl">🪙</span>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wide">Current Balance</p>
              <p className="text-lg font-bold text-amber-400">
                {proposalTokenBalance} proposal token{proposalTokenBalance !== 1 ? 's' : ''}
              </p>
            </div>
            <div className="ml-4 text-xs text-slate-500 space-y-0.5">
              <p>Outline = <span className="text-slate-300 font-medium">1 token</span></p>
              <p>Full Draft PDF = <span className="text-slate-300 font-medium">5 tokens</span></p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {tokenPacks.map((pack: any) => (
              <div
                key={pack.slug}
                className="rounded-xl p-5 flex flex-col gap-3 transition-all"
                style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(91,116,255,0.15)' }}
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
                    <span className="text-xl font-bold text-amber-400">${pack.priceMonthly}</span>
                    <span className="text-slate-500 text-xs ml-1">one-time</span>
                  </div>
                  <span className="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                    {pack.tokenAmount} tokens
                  </span>
                </div>

                {isAdmin ? (
                  <button
                    onClick={() => tokenPackMut.mutate(pack.slug)}
                    disabled={tokenPackMut.isPending}
                    className="w-full py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-50"
                    style={{ background: 'rgba(91,116,255,0.12)', border: '1px solid rgba(91,116,255,0.3)', color: '#5b74ff' }}
                  >
                    {tokenPackMut.isPending ? 'Redirecting to Stripe…' : `Buy ${pack.tokenAmount} Tokens — $${pack.priceMonthly}`}
                  </button>
                ) : (
                  <div className="w-full py-1.5 rounded-lg text-xs text-center text-slate-600"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
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
        <h3 className="text-base font-bold text-slate-200 mb-4">Invoice History</h3>
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          {invLoading ? (
            <div className="p-8 text-center text-slate-600 text-sm">Loading invoices…</div>
          ) : invoices.length === 0 ? (
            <div className="p-8 text-center">
              <FileText className="w-8 h-8 text-slate-700 mx-auto mb-2" />
              <p className="text-slate-600 text-sm">No invoices yet</p>
              {isAdmin && (
                <p className="text-slate-700 text-xs mt-1">Use "Generate Invoice" above to create your first invoice</p>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Invoice #', 'Period', 'Amount', 'Due', 'Status', ...(isAdmin ? ['Actions'] : [])].map((h) => (
                    <th key={h} className="text-left px-4 py-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv: any, i: number) => (
                  <tr
                    key={inv.id}
                    style={{ borderBottom: i < invoices.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}
                    className="hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-amber-400">{inv.invoiceNumber}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                      {fmtDate(inv.periodStart)} – {fmtDate(inv.periodEnd)}
                    </td>
                    <td className="px-4 py-3 text-slate-200 font-semibold">{fmt(Number(inv.totalUsd))}</td>
                    <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">{fmtDate(inv.dueAt)}</td>
                    <td className="px-4 py-3"><InvoiceStatusBadge status={inv.status} /></td>
                    {isAdmin && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => downloadInvoicePdf(inv)}
                            className="text-[11px] px-2 py-1 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 hover:bg-amber-500/20 transition-all"
                            title="Download PDF"
                          >
                            PDF
                          </button>
                          {inv.status === 'OPEN' && (
                            <>
                              <button
                                onClick={() => markStatusMut.mutate({ id: inv.id, status: 'PAID' })}
                                disabled={markStatusMut.isPending}
                                className="text-[11px] px-2 py-1 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-all disabled:opacity-50"
                              >
                                Mark Paid
                              </button>
                              <button
                                onClick={() => markStatusMut.mutate({ id: inv.id, status: 'VOID' })}
                                disabled={markStatusMut.isPending}
                                className="text-[11px] px-2 py-1 rounded bg-slate-500/10 border border-slate-500/30 text-slate-500 hover:bg-slate-500/20 transition-all disabled:opacity-50"
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
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
          onClick={() => setShowGenerateModal(false)}
        >
          <div
            className="rounded-xl p-6 w-full max-w-md space-y-4"
            style={{ background: '#131318', border: '1px solid rgba(255,255,255,0.1)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-bold text-slate-100">Generate Invoice</h3>
            <p className="text-sm text-slate-400">
              Creates an invoice for the current subscription period at the active plan rate.
            </p>
            <div>
              <label className="text-xs text-slate-500 block mb-1">Notes (optional)</label>
              <textarea
                value={invoiceNotes}
                onChange={(e) => setInvoiceNotes(e.target.value)}
                rows={3}
                placeholder="Add any notes to appear on the invoice…"
                className="w-full rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 resize-none"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}
              />
            </div>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowGenerateModal(false)}
                className="px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => generateMut.mutate({ notes: invoiceNotes })}
                disabled={generateMut.isPending}
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-50"
                style={{ background: 'rgba(91,116,255,0.15)', border: '1px solid rgba(91,116,255,0.3)', color: '#5b74ff' }}
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
