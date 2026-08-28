import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { billingApi } from '../services/api'
import {
  Search, BarChart3, Shield, Users, FileText, Zap,
  CheckCircle, ArrowRight, Star, Activity,
} from 'lucide-react'

function BrandMark({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="landCanopy" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#22d3ee" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>
        <filter id="landGlow">
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill="url(#landCanopy)" filter="url(#landGlow)" />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#22d3ee" opacity="0.5" />
    </svg>
  )
}

const features = [
  { icon: Search,    title: 'SAM.gov Pipeline',      desc: 'Auto-ingest and track federal opportunities with real-time sync' },
  { icon: BarChart3, title: 'AI Win Scoring',         desc: '8-factor probability engine with Bayesian calibration per client' },
  { icon: Activity,  title: 'Revenue Forecasting',    desc: 'Monte Carlo simulation across your entire portfolio' },
  { icon: Shield,    title: 'Compliance Matrix',      desc: 'AI-generated document requirements for every solicitation' },
  { icon: Users,     title: 'Client Intelligence',    desc: 'Multi-client management with enrichment and portal access' },
  { icon: FileText,  title: 'Proposal Assistant',     desc: 'AI-guided Q&A flow to generate winning proposal drafts' },
]

// Marketing taglines for the two-plan model (base + all_access).
const PLAN_TAGLINES: Record<string, string> = {
  base: 'Everything you need to find & qualify contracts',
  all_access: 'Core + every add-on module, one price',
}

export function LandingPage() {
  // Public plan catalogue — the backend now returns exactly two plans:
  // Bytescon Core (base, $99/mo) and All Access ($199/mo). Prices come from
  // the API so there is no Stripe Dashboard pricing table to maintain.
  const { data: plansData } = useQuery({
    queryKey: ['public-plans'],
    queryFn: () => billingApi.getPublicPlans(),
    staleTime: 600_000,
  })
  const publicPlans = (plansData?.plans ?? []) as any[]
  const orderedPlans = [...publicPlans].sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0),
  )

  // Public add-on marketing catalog (no auth) — drives the "Modular add-ons"
  // strip beneath the plan cards.
  const { data: addonsData } = useQuery({
    queryKey: ['public-addons'],
    queryFn: () => billingApi.getPublicAddons(),
    staleTime: 600_000,
  })
  const publicAddons = (addonsData?.data ?? []) as any[]

  return (
    <div className="min-h-screen" style={{ background: '#061019' }}>

      {/* ---- Top bar ---- */}
      <header className="flex items-center justify-between px-6 py-4 max-w-6xl mx-auto">
        <div className="flex items-center gap-2.5">
          <BrandMark size={32} />
          <div>
            <p className="text-xs font-black tracking-[0.1em] text-gradient-gold leading-none"
              style={{
                background: 'linear-gradient(90deg, #22d3ee, #06b6d4)',
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
              }}>
              MR GOVCON
            </p>
            <p className="text-[8px] text-slate-600 tracking-[0.2em] uppercase">Advisory Intelligence</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link to="/login" className="text-sm text-slate-400 hover:text-slate-200 transition-colors font-medium">
            Sign In
          </Link>
          <Link to="/register" className="btn-primary text-xs py-2 px-4">
            Start Free Trial <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </header>

      {/* ---- Hero — full-bleed black-and-gold treatment ----
          The hero section now extends edge-to-edge (no max-width on the
          outer wrapper) so the eagle photo + gold accents fill the entire
          page width. Inner content stays constrained to max-w-5xl so the
          wordmark + CTA stay readable on wide monitors. */}
      <section className="relative px-6 pt-20 pb-24 text-center overflow-hidden">
        {/* Background eagle — full-bleed, cinematic ken-burns animation.
            Wrapped so the animate-ken-burns transform applies to the image
            without breaking the absolute positioning. Opacity bumped to 0.38
            so the eagle has presence; the dark scrim below still keeps text
            legible. */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <img
            src="/eagle-hero.webp"
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full select-none animate-ken-burns"
            style={{
              objectFit: 'cover',
              // 'center 38%' shifts the framing slightly lower so the
              // eagle's head + outstretched wings sit centered in the
              // visible band of the hero rather than getting cropped.
              objectPosition: 'center 38%',
              opacity: 0.42,
              maskImage: 'radial-gradient(ellipse 118% 115% at center, black 72%, transparent 100%)',
              WebkitMaskImage: 'radial-gradient(ellipse 118% 115% at center, black 72%, transparent 100%)',
            }}
            loading="eager"
            decoding="async"
          />
        </div>

        {/* Warm gold sunburst — mimics light radiating from behind the eagle
            in the reference. Subtle (15% peak) but adds the golden-hour feel
            even when the photo is more neutrally lit. */}
        <div
          className="absolute pointer-events-none"
          style={{
            top: '15%',
            left: '50%',
            width: '800px',
            height: '800px',
            transform: 'translateX(-50%)',
            background:
              'radial-gradient(circle, rgba(34,211,238,0.20) 0%, rgba(217,119,6,0.08) 30%, transparent 65%)',
          }}
        />

        {/* Dark legibility scrim — ensures the wordmark + CTA remain crisp
            over the busiest parts of the photo. */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'linear-gradient(180deg, rgba(4,13,26,0.55) 0%, rgba(4,13,26,0.30) 40%, rgba(4,13,26,0.75) 100%)',
          }}
        />

        {/* Gold trim — top horizontal band, mirrors the abstract gold/black
            reference (the thin gold rule running across the top of luxury
            tech backgrounds). */}
        <div
          className="absolute left-0 right-0 top-0 h-[3px] pointer-events-none"
          style={{
            background:
              'linear-gradient(90deg, transparent 0%, rgba(196,154,26,0.15) 10%, #c49a1a 35%, #22d3ee 50%, #c49a1a 65%, rgba(196,154,26,0.15) 90%, transparent 100%)',
            boxShadow: '0 0 18px rgba(6,182,212,0.4)',
          }}
        />

        {/* Gold trim — bottom horizontal band (mirror of the top). */}
        <div
          className="absolute left-0 right-0 bottom-0 h-[3px] pointer-events-none"
          style={{
            background:
              'linear-gradient(90deg, transparent 0%, rgba(196,154,26,0.15) 10%, #c49a1a 35%, #22d3ee 50%, #c49a1a 65%, rgba(196,154,26,0.15) 90%, transparent 100%)',
            boxShadow: '0 0 18px rgba(6,182,212,0.4)',
          }}
        />

        {/* Corner accents — small angled gold pieces at the 4 corners,
            echoing the angled gold trim in the first abstract reference.
            SVG so the corners stay crisp at any DPR. */}
        <div className="absolute top-4 left-4 pointer-events-none" aria-hidden="true">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <path d="M 4 4 L 30 4 L 28 8 L 8 8 L 8 28 L 4 30 Z" fill="#c49a1a" opacity="0.85" />
            <path d="M 14 4 L 20 4 L 20 6 L 14 6 Z" fill="#22d3ee" />
          </svg>
        </div>
        <div className="absolute top-4 right-4 pointer-events-none" aria-hidden="true">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <path d="M 52 4 L 26 4 L 28 8 L 48 8 L 48 28 L 52 30 Z" fill="#c49a1a" opacity="0.85" />
            <path d="M 36 4 L 42 4 L 42 6 L 36 6 Z" fill="#22d3ee" />
          </svg>
        </div>
        <div className="absolute bottom-4 left-4 pointer-events-none" aria-hidden="true">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <path d="M 4 52 L 30 52 L 28 48 L 8 48 L 8 28 L 4 26 Z" fill="#c49a1a" opacity="0.85" />
            <path d="M 14 52 L 20 52 L 20 50 L 14 50 Z" fill="#22d3ee" />
          </svg>
        </div>
        <div className="absolute bottom-4 right-4 pointer-events-none" aria-hidden="true">
          <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
            <path d="M 52 52 L 26 52 L 28 48 L 48 48 L 48 28 L 52 26 Z" fill="#c49a1a" opacity="0.85" />
            <path d="M 36 52 L 42 52 L 42 50 L 36 50 Z" fill="#22d3ee" />
          </svg>
        </div>

        {/* Ambient gold glow centered on the wordmark */}
        <div
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[820px] h-[520px] pointer-events-none"
          style={{ background: 'radial-gradient(ellipse, rgba(6,182,212,0.18) 0%, transparent 65%)' }}
        />

        {/* Inner content — constrained width so wordmark + CTA stay
            readable on wide monitors despite the full-bleed background. */}
        <div className="relative z-10 max-w-5xl mx-auto">
          {/* "Bytescon" elegant calligraphy — Great Vibes, positioned just
              above the umbrella so it reads as a script arc over the
              central brand element (mirrors the Bytes Platform signature
              over the umbrella in the source mockup). */}
          <p
            className="mb-1"
            style={{
              fontFamily: '"Great Vibes", cursive',
              fontWeight: 400,
              fontSize: 'clamp(2.2rem, 4.8vw, 3.4rem)',
              color: '#fef3c7',
              lineHeight: 1,
              textShadow: '0 2px 16px rgba(0,0,0,0.9), 0 0 32px rgba(6,182,212,0.35)',
              letterSpacing: '0.01em',
            }}
          >
            Bytescon
          </p>

          {/* Gold umbrella — the central brand element from the photo. */}
          <div className="flex justify-center mb-6 animate-float -mt-1">
            <BrandMark size={100} />
          </div>

          {/* Brand wordmark — large serif uppercase (Playfair Display) with
              gold shimmer + a deep drop-shadow stack for the chiseled,
              "stands off the page" feel that grabs visitors. */}
          <h1
            className="leading-none mb-3 animate-text-shimmer"
            style={{
              fontFamily: '"Playfair Display", Georgia, serif',
              fontWeight: 900,
              fontSize: 'clamp(2.6rem, 7vw, 5rem)',
              letterSpacing: '0.06em',
              // The shimmer class drives the foreground color via gradient.
              // filter:drop-shadow stacks add depth without disturbing the
              // gradient fill (text-shadow would compete with the clipped
              // background-fill).
              filter:
                'drop-shadow(0 2px 0 rgba(0,0,0,0.4)) drop-shadow(0 6px 20px rgba(6,182,212,0.35)) drop-shadow(0 12px 40px rgba(0,0,0,0.6))',
            }}
          >
            MR GOVCON
          </h1>

          {/* Stacked gold trim under the wordmark — three lines of varying
              weight + a small diamond accent, echoing the layered metallic
              borders in the abstract gold/black reference. */}
          <div className="flex flex-col items-center gap-1 mb-5">
            <div
              style={{
                width: '220px',
                height: '2px',
                background: 'linear-gradient(90deg, transparent 0%, #c49a1a 25%, #22d3ee 50%, #c49a1a 75%, transparent 100%)',
                boxShadow: '0 0 8px rgba(6,182,212,0.5)',
              }}
            />
            <div className="flex items-center gap-2">
              <div style={{ width: '70px', height: '1px', background: 'linear-gradient(90deg, transparent, #c49a1a)' }} />
              <div
                style={{
                  width: '6px',
                  height: '6px',
                  transform: 'rotate(45deg)',
                  background: 'linear-gradient(135deg, #22d3ee, #c49a1a)',
                  boxShadow: '0 0 6px rgba(6,182,212,0.6)',
                }}
              />
              <div style={{ width: '70px', height: '1px', background: 'linear-gradient(90deg, #c49a1a, transparent)' }} />
            </div>
          </div>

          {/* Pillar tagline — Bytes Platform family voice, spaced caps with bullets. */}
          <p className="text-[11px] md:text-xs font-bold tracking-[0.45em] text-cyan-500/85 mb-6">
            EXCELLENCE · INTEGRITY · IMPACT
          </p>

          <span className="veteran-badge mb-8 inline-flex">★ All Rights Reserved</span>

          {/* Secondary headline — supporting copy beneath the brand block. */}
          <h2
            className="text-3xl md:text-5xl font-black text-slate-100 leading-tight mb-5 mt-4"
            style={{ letterSpacing: '-0.03em' }}
          >
            Win More.{' '}
            <span className="animate-text-shimmer">Bid Smarter.</span>
          </h2>

          <p className="text-lg text-slate-400 max-w-xl mx-auto mb-10 leading-relaxed">
            The AI-powered intelligence platform that helps GovCon advisory firms
            find, score, and win federal contracts — systematically.
          </p>

          {/* Single dominant CTA — bigger, glowier than the standard
              btn-primary so it acts as the obvious visual target. The
              animate-gold-pulse glow makes it the clear focal point
              for prospects. */}
          <div className="flex flex-col items-center gap-3 mb-8">
            <Link
              to="/register"
              className="btn-primary text-lg font-bold py-5 px-14 tracking-wider animate-gold-pulse"
              style={{
                minWidth: '300px',
                boxShadow:
                  '0 0 0 1px rgba(6,182,212,0.6) inset, 0 8px 32px rgba(6,182,212,0.35), 0 4px 16px rgba(0,0,0,0.5)',
              }}
            >
              GET STARTED <ArrowRight className="w-5 h-5" />
            </Link>
            <Link to="/login" className="text-xs text-slate-500 hover:text-cyan-400 transition-colors tracking-wider uppercase">
              Already a member? Sign in
            </Link>
          </div>
        </div>
      </section>

      {/* ---- Divider ---- */}
      <div className="max-w-6xl mx-auto px-6">
        <div className="divider-gold" />
      </div>

      {/* ---- Features Grid ---- */}
      <section className="px-6 py-20 max-w-6xl mx-auto">
        <div className="text-center mb-14">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-500 mb-3">Platform Capabilities</p>
          <h2 className="text-3xl font-black text-slate-100" style={{ letterSpacing: '-0.02em' }}>
            Everything your advisory firm needs
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f) => (
            <div key={f.title} className="card-interactive group">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center mb-4"
                style={{
                  background: 'rgba(6,182,212,0.08)',
                  border: '1px solid rgba(6,182,212,0.15)',
                }}
              >
                <f.icon className="w-5 h-5 text-cyan-400 group-hover:scale-110 transition-transform" />
              </div>
              <h3 className="text-sm font-bold text-slate-200 mb-1.5">{f.title}</h3>
              <p className="text-xs text-slate-500 leading-relaxed">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Pricing Banner ---- */}
      <>
          <section className="px-6 py-16 max-w-4xl mx-auto">
            <div
              className="card-gold text-center py-12 px-8"
              style={{ borderRadius: '16px' }}
            >
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-400 mb-3">
                Founders Lifetime
              </p>
              <h2 className="text-3xl font-black text-slate-100 mb-2" style={{ letterSpacing: '-0.02em' }}>
                Lifetime Access —{' '}
                <span
                  style={{
                    background: 'linear-gradient(90deg, #22d3ee, #06b6d4)',
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                  }}
                >
                  $2,500
                </span>
              </h2>
              <p className="text-sm text-slate-500 mb-1">
                One-time payment. The Core plan + <span className="text-cyan-400 font-semibold">every add-on module</span>, forever.
              </p>
              <p className="text-xs text-slate-600 mb-8">
                Over $470/mo of modules à la carte · 200 proposal tokens up front + 50/month · Founding Member badge · Priority support
              </p>

              <div className="flex flex-col items-center gap-4">
                <Link to="/register?offer=lifetime" className="btn-primary text-sm py-3 px-8">
                  Claim Your Spot <ArrowRight className="w-4 h-4" />
                </Link>
                <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><CheckCircle className="w-3 h-3 text-emerald-500" /> 14-day free trial</span>
                  <span className="flex items-center gap-1"><CheckCircle className="w-3 h-3 text-emerald-500" /> No credit card to start</span>
                  <span className="flex items-center gap-1"><CheckCircle className="w-3 h-3 text-emerald-500" /> Cancel anytime during trial</span>
                </div>
              </div>
            </div>
          </section>

          {/* ---- Monthly Subscription Plans (code-driven from DEFAULT_PLANS) ----
              Prices come from the backend catalogue, so the $99 Personal tier and
              any future plan appear here automatically — no Stripe Dashboard pricing
              table to maintain. */}
          {orderedPlans.length > 0 && (
            <section className="px-6 py-16 max-w-6xl mx-auto">
              <div className="text-center mb-6">
                <p className="text-xs font-bold uppercase tracking-[0.2em] text-cyan-400 mb-3">
                  Simple Pricing
                </p>
                <h2 className="text-3xl font-black text-slate-100 mb-2" style={{ letterSpacing: '-0.02em' }}>
                  One plan. Add only what you need.
                </h2>
                <p className="text-sm text-slate-500 max-w-xl mx-auto">
                  Core gets you searching and scoring contracts. Add feature modules from $29/mo —
                  or take everything with All Access.
                </p>
              </div>

              {/* First-time-bidder nudge */}
              <div
                className="max-w-2xl mx-auto mb-10 rounded-xl px-5 py-4 text-center"
                style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.25)' }}
              >
                <p className="text-sm font-semibold text-emerald-300">New to federal contracting?</p>
                <p className="text-xs text-slate-400 mt-1">
                  Start with <span className="font-semibold text-emerald-300">Core — $99/mo</span> and add only the
                  modules you need, from $29/mo. No forced bundles, no enterprise tiers.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 max-w-3xl mx-auto">
                {orderedPlans.map((p) => {
                  const highlight = p.slug === 'all_access'
                  const features: string[] = Array.isArray(p.features) ? p.features : []
                  return (
                    <div
                      key={p.slug}
                      className="rounded-xl p-5 flex flex-col gap-4"
                      style={{
                        background: highlight ? 'rgba(168,85,247,0.05)' : 'rgba(255,255,255,0.03)',
                        border: `1px solid ${highlight ? 'rgba(168,85,247,0.40)' : 'rgba(6,182,212,0.30)'}`,
                      }}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-lg font-bold text-slate-100">{p.name}</h3>
                          {highlight && (
                            <span
                              className="text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap"
                              style={{ background: 'rgba(168,85,247,0.15)', color: '#d8b4fe', border: '1px solid rgba(168,85,247,0.35)' }}
                            >
                              Best value
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-slate-500 mt-0.5">{PLAN_TAGLINES[p.slug] ?? ''}</p>
                        <div className="mt-2">
                          <span className="text-3xl font-black text-slate-100">${p.monthlyPriceUsd}</span>
                          <span className="text-slate-500 text-sm">/mo</span>
                          <span className="text-[11px] text-emerald-400 ml-2">${p.annualPriceUsd}/mo billed annually</span>
                        </div>
                      </div>
                      <ul className="space-y-1.5 flex-1">
                        {features.slice(0, 6).map((f) => (
                          <li key={f} className="flex items-start gap-2 text-xs text-slate-400">
                            <CheckCircle className="w-3.5 h-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />
                            {f}
                          </li>
                        ))}
                      </ul>
                      <Link
                        to={`/register?plan=${p.slug}`}
                        className={
                          highlight
                            ? 'btn-primary text-sm py-2.5 flex items-center justify-center gap-1'
                            : 'text-sm py-2.5 rounded-lg flex items-center justify-center gap-1 transition-colors'
                        }
                        style={highlight ? undefined : { background: 'rgba(6,182,212,0.10)', border: '1px solid rgba(6,182,212,0.30)', color: '#06b6d4' }}
                      >
                        Start free trial <ArrowRight className="w-4 h-4" />
                      </Link>
                    </div>
                  )
                })}
              </div>

              {/* Modular add-ons strip */}
              {publicAddons.length > 0 && (
                <div className="mt-12">
                  <div className="text-center mb-6">
                    <h3 className="text-xl font-black text-slate-100" style={{ letterSpacing: '-0.02em' }}>
                      Modular add-ons
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">
                      Every module works with Core — add or cancel anytime from your billing page.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {publicAddons.map((a) => (
                      <div
                        key={a.slug}
                        className="rounded-xl px-4 py-3.5 flex items-start gap-3"
                        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)' }}
                      >
                        <span className="text-xl leading-none mt-0.5">{a.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-semibold text-slate-200 truncate">{a.name}</p>
                            {a.status === 'coming_soon' ? (
                              <span className="text-[10px] text-slate-500 whitespace-nowrap px-1.5 py-0.5 rounded border border-white/10">
                                Coming soon
                              </span>
                            ) : (
                              <span className="text-sm font-bold text-cyan-400 whitespace-nowrap">
                                ${a.priceMonthly}<span className="text-[10px] text-slate-500 font-normal">/mo</span>
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-500 mt-0.5">{a.tagline}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <p className="text-center text-xs text-slate-600 mt-8">
                14-day free trial of everything · no credit card to start · cancel anytime
              </p>
            </section>
          )}
      </>

      {/* ---- Trust Footer ---- */}
      <section className="px-6 py-12 max-w-6xl mx-auto text-center">
        <div className="flex items-center justify-center gap-6 mb-6 flex-wrap">
          <Link
            to="/trust"
            className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-cyan-400 transition-colors"
            title="Read our Trust & Security page"
          >
            <Shield className="w-3.5 h-3.5 text-amber-600" />
            <span>Trust &amp; Security</span>
          </Link>
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <Star className="w-3.5 h-3.5 text-amber-600" />
            <span>All Rights Reserved</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <Zap className="w-3.5 h-3.5 text-amber-600" />
            <span>AI-Powered Intelligence</span>
          </div>
        </div>
        <p className="text-[10px] text-slate-800 tracking-widest">
          © {new Date().getFullYear()} BYTES PLATFORM · Bytescon · All Rights Reserved
        </p>
      </section>
    </div>
  )
}
