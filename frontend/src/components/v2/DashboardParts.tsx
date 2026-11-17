// =============================================================
// The v2 Dashboard's building blocks: what needs attention today, the KPI
// bento, the top opportunities, where win probabilities sit, the agents'
// insights, and the rarer charts behind tabs (shown on request, not all at
// once). Everything reads the same data the Dashboard already loads.
// =============================================================
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { AlertTriangle, ArrowUpRight, Briefcase, ClipboardCheck, Gauge, ShieldAlert, ShieldCheck, Sparkles, Timer, Users } from 'lucide-react'
import { CountUp } from '../kit'
import { count, daysUntil, money, plainText, RECOMMENDATION } from './format'
import { RevenueForecast } from '../charts/RevenueForecast'
import { PenaltyTrendLine } from '../charts/PenaltyTrendLine'
import { SubmissionVelocity } from '../charts/SubmissionVelocity'
import { ClientPortfolioPie } from '../charts/ClientPortfolioPie'

// ---------------------------------------------------------------- attention
interface AttentionItem { value: number; label: string; to: string; tone: 'danger' | 'warning' | 'accent'; icon: ReactNode }

/** Up to three things to act on today; each opens the page where they're handled. */
export function AttentionStrip({ closingThisWeek, decisionsWaiting, criticalRisks }: { closingThisWeek: number; decisionsWaiting: number; criticalRisks: number }) {
  const items: AttentionItem[] = [
    { value: decisionsWaiting, label: decisionsWaiting === 1 ? 'bid waiting for your decision' : 'bids waiting for your decision', to: '/pipeline', tone: 'accent', icon: <ClipboardCheck /> },
    { value: criticalRisks, label: criticalRisks === 1 ? 'critical risk flagged' : 'critical risks flagged', to: '#insights', tone: 'danger', icon: <ShieldAlert /> },
    { value: closingThisWeek, label: 'notices close in the next 7 days', to: '/opportunities?sortBy=deadline', tone: 'warning', icon: <AlertTriangle /> },
  ]
  return (
    <section aria-label="Needs your attention" className="v2-glass grid grid-cols-1 sm:grid-cols-3 overflow-hidden">
      {items.map((it, i) => {
        const inner = (
          <>
            <span className={`v2-chip-icon v2-chip-${it.tone}`} aria-hidden="true">{it.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block num text-xl font-semibold leading-tight text-white">{count(it.value)}</span>
              <span className="block text-[13px] truncate" style={{ color: 'rgba(255,255,255,0.82)' }}>{it.label}</span>
            </span>
            <ArrowUpRight className="h-4 w-4 flex-none opacity-0 transition-opacity group-hover:opacity-100 text-white" aria-hidden="true" />
          </>
        )
        const cls = `group flex items-center gap-3 px-5 py-4 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white ${i > 0 ? 'border-t sm:border-t-0 sm:border-l' : ''}`
        return it.to.startsWith('#')
          ? <a key={it.label} href={it.to} className={cls} style={{ borderColor: 'rgba(255,255,255,0.18)' }}>{inner}</a>
          : <Link key={it.label} to={it.to} className={cls} style={{ borderColor: 'rgba(255,255,255,0.18)' }}>{inner}</Link>
      })}
    </section>
  )
}

// ---------------------------------------------------------------- KPI bento
interface Stage { label: string; count: number }

function Tile({ label, children, note, className = '', to, icon, tone = 'accent' }: { label: string; children: ReactNode; note?: ReactNode; className?: string; to?: string; icon?: ReactNode; tone?: 'accent' | 'success' | 'warning' | 'danger' }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="v2-kpi-label">{label}</p>
        {icon && <span className={`v2-chip-icon v2-chip-${tone}`} aria-hidden="true">{icon}</span>}
      </div>
      <div className="mt-1">{children}</div>
      {note && <p className="v2-kpi-note mt-2">{note}</p>}
    </>
  )
  return to
    ? <Link to={to} className={`v2-card v2-card-pad block v2-tint-${tone} ${className}`}>{body}</Link>
    : <div className={`v2-card v2-card-pad v2-tint-${tone} ${className}`}>{body}</div>
}

export function KpiBento({
  pipeline, stages, winProbability, decided, onTimeRate, submitted, penalties, penaltyEvents, clients,
}: {
  pipeline: { totalExpected: number; totalNet: number }
  stages: Stage[]
  winProbability: number
  decided: number
  onTimeRate: number
  submitted: number
  penalties: number
  penaltyEvents: number
  clients: number | null
}) {
  const winPct = Math.round(winProbability * 100)
  const maxStage = Math.max(1, ...stages.map((s) => s.count))
  const smalls = clients == null ? 3 : 4
  return (
    <section aria-label="Key figures" className="grid grid-cols-2 xl:grid-cols-4 gap-3 sm:gap-4">
      {/* The hero tile: what the pipeline is worth and how bids move through it. */}
      <div className="v2-card v2-card-pad v2-tint-accent col-span-2 xl:row-span-2 relative overflow-hidden">
        <div className="flex items-start justify-between gap-3">
          <p className="v2-kpi-label">Expected pipeline value</p>
          <span className="v2-chip-icon v2-chip-accent" aria-hidden="true"><Briefcase /></span>
        </div>
        <p className="v2-kpi-value v2-kpi-hero v2-grad-text mt-3"><CountUp value={money(pipeline.totalExpected)} /></p>
        <p className="v2-kpi-note mt-1">Net of bid costs: <span className="num font-medium" style={{ color: 'var(--text)' }}>{money(pipeline.totalNet)}</span></p>
        <ol className="mt-6 space-y-2.5" aria-label="How notices move through your pipeline">
          {stages.map((s, i) => (
            <li key={s.label} className="grid grid-cols-[88px_1fr_56px] items-center gap-3 text-[13px]">
              <span style={{ color: 'var(--text-muted)' }}>{s.label}</span>
              <span className="h-2 rounded-full" style={{ background: 'var(--surface-3)' }}>
                <motion.span
                  className="block h-full rounded-full"
                  style={{ background: i === stages.length - 1 ? 'var(--teal)' : 'var(--v2-grad)', opacity: 1 - i * 0.1, transformOrigin: 'left' }}
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: s.count / maxStage }}
                  transition={{ duration: 0.7, delay: 0.1 + i * 0.06, ease: [0.22, 1, 0.36, 1] }}
                />
              </span>
              <span className="num text-right font-medium" style={{ color: 'var(--text)' }}>{count(s.count)}</span>
            </li>
          ))}
        </ol>
      </div>

      <Tile label="Average win probability" note={`Across ${count(decided)} bid decisions`} to="/decisions" icon={<Gauge />}>
        <p className="v2-kpi-value num"><CountUp value={`${winPct}%`} /></p>
        <div className="v2-meter mt-3" aria-hidden="true"><span style={{ width: `${winPct}%` }} /></div>
      </Tile>

      <Tile label="On-time submissions" note={submitted ? `${count(submitted)} submitted` : 'Shows once bids are submitted'} icon={<Timer />} tone={submitted && onTimeRate < 0.8 ? 'warning' : 'success'}>
        <p className="v2-kpi-value num" style={{ color: submitted ? undefined : 'var(--text-dim)' }}>{submitted ? <CountUp value={`${Math.round(onTimeRate * 100)}%`} /> : '—'}</p>
      </Tile>

      <Tile label="Penalties, last 30 days" note={penaltyEvents ? `${count(penaltyEvents)} event${penaltyEvents === 1 ? '' : 's'}` : 'None recorded'} className={smalls === 3 ? 'col-span-2' : ''} icon={<ShieldCheck />} tone={penalties > 0 ? 'danger' : 'success'}>
        <p className="v2-kpi-value num" style={{ color: penalties > 0 ? 'var(--danger)' : undefined }}><CountUp value={money(penalties)} /></p>
      </Tile>

      {clients != null && (
        <Tile label="Active clients" note="Companies you bid for" to="/clients" icon={<Users />} tone="warning">
          <p className="v2-kpi-value num"><CountUp value={clients} /></p>
        </Tile>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- top opportunities
interface TopOpp {
  id: string; title: string; agency: string; probabilityScore: number; expectedValue: number; responseDeadline: string
  bidDecisions?: { recommendation: string; clientCompany?: { name: string } }[]
}

export function TopOpportunities({ items }: { items: TopOpp[] }) {
  return (
    <section className="v2-card v2-card-pad" aria-labelledby="top-title">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="top-title" className="v2-card-title">Best opportunities</h2>
          <p className="v2-card-sub">Ranked by expected value</p>
        </div>
        <Link to="/opportunities" className="v2-link">View all</Link>
      </div>
      {items.length === 0 ? (
        <p className="mt-6 text-sm" style={{ color: 'var(--text-muted)' }}>
          No scored opportunities yet. <Link to="/opportunities" className="v2-link">Browse opportunities</Link> to start matching.
        </p>
      ) : (
        <ul className="mt-3 v2-divide">
          {items.slice(0, 6).map((o) => {
            const rec = o.bidDecisions?.[0]
            const pct = Math.round((o.probabilityScore || 0) * 100)
            const left = daysUntil(o.responseDeadline)
            return (
              <li key={o.id}>
                <Link to={`/opportunities/${o.id}`} className="v2-row">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" style={{ color: 'var(--text)' }}>{plainText(o.title)}</span>
                    <span className="block truncate text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>
                      {o.agency}{rec ? <> · {RECOMMENDATION[rec.recommendation] ?? rec.recommendation}{rec.clientCompany?.name ? ` for ${rec.clientCompany.name}` : ''}</> : null}
                    </span>
                  </span>
                  <span className="hidden md:flex w-28 flex-none items-center gap-2" aria-label={`Win probability ${pct}%`}>
                    <span className="v2-meter flex-1"><span style={{ width: `${pct}%` }} /></span>
                    <span className="num text-xs font-medium w-8 text-right" style={{ color: 'var(--text-2)' }}>{pct}%</span>
                  </span>
                  <span className={`v2-pill num flex-none ${left <= 7 ? 'v2-pill-warning' : ''}`}>{left <= 0 ? 'Today' : `${left}d`}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------- win spread
export function WinSpread({ buckets }: { buckets: { range: string; count: number }[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const total = buckets.reduce((a, b) => a + b.count, 0)
  const high = buckets.slice(6).reduce((a, b) => a + b.count, 0)
  return (
    <section className="v2-card v2-card-pad" aria-labelledby="spread-title">
      <h2 id="spread-title" className="v2-card-title">Where win probabilities sit</h2>
      <p className="v2-card-sub"><span className="num">{count(high)}</span> of {count(total)} scored notices are above 60%</p>
      <ol className="mt-5 grid h-32 grid-cols-10 items-end gap-1.5" aria-label="Scored notices by win probability">
        {buckets.map((b, i) => (
          <li key={b.range} className="flex h-full flex-col justify-end" aria-label={`${b.range}: ${b.count} notices`} title={`${b.range}: ${count(b.count)}`}>
            <motion.span
              className="block w-full rounded-[4px]"
              style={{ height: `${b.count ? Math.max(4, (b.count / max) * 100) : 2}%`, background: i >= 6 ? 'var(--v2-bar-strong)' : 'var(--v2-bar)', transformOrigin: 'bottom' }}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ duration: 0.5, delay: 0.2 + i * 0.03, ease: [0.22, 1, 0.36, 1] }}
            />
          </li>
        ))}
      </ol>
      <div className="mt-2 flex justify-between text-[11px]" style={{ color: 'var(--text-faint)' }} aria-hidden="true">
        <span>0%</span><span>50%</span><span>100%</span>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- insights
interface Risk { title: string; description: string; severity: string; entityType: string }
interface Decision { id: string; recommendation: string; winProbability: number; opportunity: { id: string; title: string; agency: string }; clientCompany?: { name: string } }
interface Match { opportunityId?: string; id?: string; title: string; agency?: string; score?: number; reason?: string }

export function InsightsCard({ risks, decisions, matches }: { risks: Risk[]; decisions: Decision[]; matches: Match[] }) {
  const tabs = [
    { key: 'risks', label: 'Risks', n: risks.length },
    { key: 'decisions', label: 'Recent decisions', n: decisions.length },
    { key: 'matches', label: 'Matches', n: matches.length },
  ] as const
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('risks')
  const sev = (s: string) => (s === 'CRITICAL' ? 'v2-pill-danger' : s === 'HIGH' ? 'v2-pill-warning' : '')

  return (
    <section id="insights" className="v2-card v2-card-pad scroll-mt-24" aria-labelledby="insights-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="insights-title" className="v2-card-title flex items-center gap-2">
          <Sparkles className="w-4 h-4" style={{ color: 'var(--accent)' }} aria-hidden="true" /> From your agents
        </h2>
        <div className="v2-tabs" role="tablist" aria-label="Insights">
          {tabs.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} aria-controls={`insights-${t.key}`} className="v2-tab" onClick={() => setTab(t.key)}>
              {t.label}{t.n ? <span className="num ml-1.5" style={{ color: 'var(--text-faint)' }}>{t.n}</span> : null}
            </button>
          ))}
        </div>
      </div>

      <div id={`insights-${tab}`} role="tabpanel" className="mt-3">
        {tab === 'risks' && (risks.length === 0
          ? <p className="py-6 text-sm" style={{ color: 'var(--text-muted)' }}>No risks flagged. The agents check deadlines, compliance and penalties every hour.</p>
          : <ul className="v2-divide">{risks.slice(0, 5).map((r, i) => (
              <li key={i} className="v2-row !cursor-default">
                <span className={`v2-pill flex-none ${sev(r.severity)}`}><span className="v2-dot" />{r.severity.charAt(0) + r.severity.slice(1).toLowerCase()}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium" style={{ color: 'var(--text)' }}>{plainText(r.title)}</span>
                  <span className="block truncate text-xs" style={{ color: 'var(--text-faint)' }}>{r.description}</span>
                </span>
              </li>
            ))}</ul>)}
        {tab === 'decisions' && (decisions.length === 0
          ? <p className="py-6 text-sm" style={{ color: 'var(--text-muted)' }}>No bid decisions yet. They appear as notices are scored for your companies.</p>
          : <ul className="v2-divide">{decisions.slice(0, 5).map((d) => (
              <li key={d.id}>
                <Link to={`/opportunities/${d.opportunity.id}`} className="v2-row">
                  <span className={`v2-pill flex-none ${d.recommendation === 'NO_BID' ? '' : 'v2-pill-accent'}`}>{RECOMMENDATION[d.recommendation] ?? d.recommendation}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" style={{ color: 'var(--text)' }}>{plainText(d.opportunity.title)}</span>
                    <span className="block truncate text-xs" style={{ color: 'var(--text-faint)' }}>{d.clientCompany?.name ?? d.opportunity.agency}</span>
                  </span>
                  <span className="num text-xs font-medium flex-none" style={{ color: 'var(--text-2)' }}>{Math.round(d.winProbability * 100)}%</span>
                </Link>
              </li>
            ))}</ul>)}
        {tab === 'matches' && (matches.length === 0
          ? <p className="py-6 text-sm" style={{ color: 'var(--text-muted)' }}>No new matches right now. <Link to="/opportunities" className="v2-link">Browse opportunities</Link></p>
          : <ul className="v2-divide">{matches.slice(0, 5).map((m, i) => (
              <li key={i}>
                <Link to={`/opportunities/${m.opportunityId ?? m.id}`} className="v2-row">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium" style={{ color: 'var(--text)' }}>{plainText(m.title)}</span>
                    <span className="block truncate text-xs" style={{ color: 'var(--text-faint)' }}>{m.reason ?? m.agency}</span>
                  </span>
                </Link>
              </li>
            ))}</ul>)}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- more analytics
export function MoreAnalytics({ forecast, submissions, penalties, clients }: { forecast: unknown; submissions: unknown; penalties: unknown; clients: unknown[] | null }) {
  const tabs = [
    { key: 'forecast', label: 'Revenue forecast' },
    { key: 'submissions', label: 'Submissions' },
    { key: 'penalties', label: 'Penalties' },
    ...(clients ? [{ key: 'clients', label: 'Clients' }] : []),
  ]
  const [tab, setTab] = useState('forecast')
  return (
    <section aria-labelledby="more-title">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 id="more-title" className="v2-card-title">More analytics</h2>
        <div className="v2-tabs" role="tablist" aria-label="More analytics">
          {tabs.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className="v2-tab" onClick={() => setTab(t.key)}>{t.label}</button>
          ))}
        </div>
      </div>
      <div role="tabpanel">
        {tab === 'forecast' && <RevenueForecast data={forecast as never} />}
        {tab === 'submissions' && <SubmissionVelocity data={submissions as never} />}
        {tab === 'penalties' && <PenaltyTrendLine data={penalties as never} />}
        {tab === 'clients' && clients && <ClientPortfolioPie clients={clients as never} />}
      </div>
    </section>
  )
}
