// =============================================================
// Pricing — two plans as columns divided by a hairline, a one-line
// founders offer, and the add-on catalogue as a sentence. Data comes
// from the public billing endpoints; the fallbacks mirror
// backend/src/services/billingService.ts and backend/src/config/addons.ts.
// =============================================================
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { billingApi } from '../../services/api'
import { Reveal, SectionHeading } from './shared'

interface PublicPlan { slug: string; name: string; monthlyPriceUsd: number; annualPriceUsd: number; features: string[]; sortOrder?: number }
interface PublicAddon { slug: string; name: string; priceMonthly: number; priceAnnual: number; status: 'available' | 'coming_soon' }

const FALLBACK_PLANS: PublicPlan[] = [
  { slug: 'base', name: 'Bytescon Core', monthlyPriceUsd: 99, annualPriceUsd: 84, sortOrder: 1, features: [
    'SAM.gov contract search across your NAICS codes',
    'Win-probability scoring on every opportunity',
    'Score breakdowns + bid / no-bid decision engine',
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
    <section id="pricing" className="lp-dark py-24 lg:py-36">
      <div className="lp-container">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
          <SectionHeading
            eyebrow="Pricing"
            title={<>One plan. <span className="lp-italic">Add only what you need.</span></>}
            sub="No enterprise tiers and no sales call. Fourteen days free with every module unlocked."
          />
          <Reveal delay={200}>
            <div className="lp-toggle" data-annual={annual} role="group" aria-label="Billing period">
              <span className="lp-toggle-thumb" aria-hidden="true" />
              <button type="button" className="lp-toggle-btn" aria-pressed={!annual} onClick={() => setAnnual(false)}>Monthly</button>
              <button type="button" className="lp-toggle-btn" aria-pressed={annual} onClick={() => setAnnual(true)}>Annual · save 15%</button>
            </div>
          </Reveal>
        </div>

        <div className="mt-14 grid border-t border-[var(--lp-line-dark)] lg:grid-cols-2 lg:py-10">
          {plans.map((p, i) => {
            const highlight = p.slug === 'all_access'
            const price = annual ? p.annualPriceUsd : p.monthlyPriceUsd
            const features = Array.isArray(p.features) ? p.features.slice(0, 5) : []
            return (
              <Reveal key={p.slug} delay={i * 120} className="lp-plan">
                <div data-testid={`plan-${p.slug}`}>
                  <div className="flex items-baseline justify-between gap-4">
                    <h3 className="lp-display text-3xl">{p.name}</h3>
                    {highlight && <span className="lp-mono" style={{ color: 'var(--lp-gold-2)' }}>Best value</span>}
                  </div>
                  <p className="lp-muted mt-2 text-sm">{TAGLINE[p.slug] ?? ''}</p>
                  <p className="lp-price mt-8">${price}<small> / month{annual ? ', billed annually' : ''}</small></p>
                  <ul className="mt-8 space-y-3">
                    {features.map((f) => (
                      <li key={f} className="flex gap-3 text-[15px]" style={{ color: 'var(--lp-fog)' }}>
                        <span aria-hidden="true" className="mt-[0.7rem] h-px w-4 flex-shrink-0" style={{ background: 'var(--lp-gold-2)' }} />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link to={`/register?plan=${p.slug}`} className={`lp-btn mt-10 ${highlight ? 'lp-btn-primary' : 'lp-btn-ghost lp-beam'}`} style={highlight ? undefined : { borderColor: 'var(--lp-line-dark)' }}>
                    Start free trial <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </Reveal>
            )
          })}
        </div>

        <Reveal delay={100} className="grid gap-6 border-y border-[var(--lp-line-dark)] py-8 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <p className="lp-eyebrow">Founders lifetime · 20 slots</p>
            <p className="mt-3 max-w-2xl text-[15px] leading-relaxed" style={{ color: 'var(--lp-fog)' }}>
              <span className="lp-display text-2xl" style={{ color: 'var(--lp-bone)' }}>$2,500 once, everything forever.</span>{' '}
              Core plus every module, ten seats, unlimited clients, 200 proposal tokens up front and 50 a month.
            </p>
          </div>
          <Link to="/register?offer=lifetime" className="lp-link">Claim a founder slot <ArrowRight className="h-4 w-4" /></Link>
        </Reveal>

        <Reveal delay={160} className="pt-8">
          <p className="lp-mono" style={{ color: 'var(--lp-dim)' }}>Add-on modules from ${Number.isFinite(fromPrice) ? fromPrice : 29}/mo</p>
          <ul className="lp-addons mt-4">
            {addons.map((a) => (
              <li key={a.slug}>
                <span>{a.name}</span>
                <span className="lp-mono" style={{ color: 'var(--lp-dim)' }}>${annual ? a.priceAnnual : a.priceMonthly}</span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  )
}
