// =============================================================
// Pricing — two plans on white surfaces, a one-line founders offer, and
// the add-on catalogue as a plain list. Data comes
// from the public billing endpoints; the fallbacks mirror
// backend/src/services/billingService.ts and backend/src/config/addons.ts.
// =============================================================
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { billingApi } from '../../services/api'
import { SectionHeading } from './shared'
import { Rise, Roll } from './motion'

interface PublicPlan { slug: string; name: string; monthlyPriceUsd: number; annualPriceUsd: number; features: string[]; sortOrder?: number }
interface PublicAddon { slug: string; name: string; priceMonthly: number; priceAnnual: number; status: 'available' | 'coming_soon' }

const FALLBACK_PLANS: PublicPlan[] = [
  { slug: 'base', name: 'Bytesgov Core', monthlyPriceUsd: 99, annualPriceUsd: 84, sortOrder: 1, features: [
    'SAM.gov contract search across your NAICS codes',
    'Win-probability scoring on every opportunity',
    'Score breakdowns and a bid or no-bid decision engine',
    'Up to 5 client companies, 3 seats',
    'Add feature modules anytime, from $29/mo',
  ] },
  { slug: 'all_access', name: 'All Access', monthlyPriceUsd: 199, annualPriceUsd: 169, sortOrder: 2, features: [
    'Everything in Core',
    'All eight add-on modules included',
    '50 proposal tokens every month',
    '10 seats, unlimited client companies',
    'Priority support',
  ] },
]

const FALLBACK_ADDONS: PublicAddon[] = [
  { slug: 'setaside_intel', name: 'Set-Aside Intelligence', priceMonthly: 29, priceAnnual: 25, status: 'available' },
  { slug: 'teaming_suite', name: 'Teaming & Subcontracting', priceMonthly: 49, priceAnnual: 42, status: 'available' },
  { slug: 'contract_analysis', name: 'Contract Analysis & Compliance', priceMonthly: 59, priceAnnual: 50, status: 'available' },
  { slug: 'proposal_studio', name: 'Proposal Studio', priceMonthly: 79, priceAnnual: 67, status: 'available' },
  { slug: 'market_intel', name: 'Market & Competitor Intelligence', priceMonthly: 39, priceAnnual: 33, status: 'available' },
  { slug: 'auto_sync', name: 'Automated Daily Sync', priceMonthly: 29, priceAnnual: 25, status: 'available' },
  { slug: 'api_access', name: 'API & MCP Access', priceMonthly: 49, priceAnnual: 42, status: 'available' },
  { slug: 'client_portal', name: 'Client Portal & Branded Reports', priceMonthly: 39, priceAnnual: 33, status: 'available' },
]

const TAGLINE: Record<string, string> = {
  base: 'Find, score and track. Add modules as you grow.',
  all_access: 'Every module, every seat you need.',
}

export function Pricing() {
  const [annual, setAnnual] = useState(false)
  const { data: plansData } = useQuery({ queryKey: ['public-plans'], queryFn: () => billingApi.getPublicPlans(), staleTime: 600_000, retry: false })
  const { data: addonsData } = useQuery({ queryKey: ['public-addons'], queryFn: () => billingApi.getPublicAddons(), staleTime: 600_000, retry: false })

  const apiPlans = (plansData?.plans ?? []) as PublicPlan[]
  const plans = [...(apiPlans.length ? apiPlans : FALLBACK_PLANS)].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  const apiAddons = (addonsData?.data ?? []) as PublicAddon[]
  const addons = (apiAddons.length ? apiAddons : FALLBACK_ADDONS).filter((a) => a.status === 'available')
  const fromPrice = Math.min(...addons.map((a) => (annual ? a.priceAnnual : a.priceMonthly)))

  return (
    <section id="pricing" className="lp-container pt-4 pb-20 lg:pb-28">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <SectionHeading
          title="One plan. Add only what you need."
          sub="No enterprise tiers and no sales call. Fourteen days free with every module unlocked."
        />
        <Rise delay={120}>
          <div className="lp-toggle" role="group" aria-label="Billing period">
            <button type="button" className="lp-toggle-btn" aria-pressed={!annual} onClick={() => setAnnual(false)}>Monthly</button>
            <button type="button" className="lp-toggle-btn" aria-pressed={annual} onClick={() => setAnnual(true)}>Annual, save 15%</button>
          </div>
        </Rise>
      </div>

      <div className="mt-12 grid gap-4 lg:grid-cols-2">
        {plans.map((p, i) => {
          const highlight = p.slug === 'all_access'
          const price = annual ? p.annualPriceUsd : p.monthlyPriceUsd
          const features = Array.isArray(p.features) ? p.features.slice(0, 5) : []
          return (
            <Rise key={p.slug} delay={i * 80} className="lp-surface h-full">
              <div data-testid={`plan-${p.slug}`} className="flex h-full flex-col">
                <div className="flex items-start justify-between gap-4">
                  <h3 className="lp-h3 !text-[24px] !leading-[30px]">{p.name}</h3>
                  {highlight && <span className="lp-tag">Best value</span>}
                </div>
                <p className="lp-muted mt-2 text-[15px]">{TAGLINE[p.slug] ?? ''}</p>
                <p className="lp-price mt-8">$<Roll value={price} /><small> / month{annual ? ', billed annually' : ''}</small></p>
                <ul className="lp-rule-list mt-8">
                  {features.map((f) => (
                    <li key={f} className="py-3 text-[15px]" style={{ color: 'var(--text-2)' }}>{f}</li>
                  ))}
                </ul>
                <div className="mt-auto pt-8">
                  <Link to={`/register?plan=${p.slug}`} className={`lp-btn ${highlight ? 'lp-btn-dark' : 'lp-btn-light'}`}>
                    Start free trial
                  </Link>
                </div>
              </div>
            </Rise>
          )
        })}
      </div>

      <Rise delay={80} className="mt-4">
        <div className="lp-surface lp-surface-blue grid gap-6 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <h3 className="text-[28px] leading-[34px] font-semibold tracking-[-0.03em]">$2,500 once, everything forever.</h3>
            <p className="mt-3 max-w-2xl text-[15px] leading-[23px]" style={{ color: 'rgba(255, 255, 255, 0.82)' }}>
              Founders lifetime, 20 slots. Core plus every module, ten seats, unlimited clients, 200 proposal tokens up front and 50 a month.
            </p>
          </div>
          <Link to="/register?offer=lifetime" className="lp-btn lp-btn-white">Claim a founder slot</Link>
        </div>
      </Rise>

      <Rise delay={120} className="mt-4">
        <div className="lp-surface">
          <h3 className="lp-h3">Add-on modules from ${Number.isFinite(fromPrice) ? fromPrice : 29}/mo</h3>
          <ul className="lp-addons mt-5">
            {addons.map((a) => (
              <li key={a.slug}>
                <span>{a.name}</span>
                <span className="lp-num" style={{ color: 'var(--text-muted)' }}>${annual ? a.priceAnnual : a.priceMonthly}</span>
              </li>
            ))}
          </ul>
        </div>
      </Rise>
    </section>
  )
}
