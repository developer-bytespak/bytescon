// =============================================================
// Dashboard building blocks (UI v3): the greeting with today's summary and
// the best match, the four figure cards, the best opportunities, where win
// probabilities sit, the agents' insights, and the rarer charts behind tabs.
// Everything reads the same data the Dashboard already loads.
// =============================================================
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { count, daysUntil, money, plainText, RECOMMENDATION } from './format'
import { RevenueForecast } from '../charts/RevenueForecast'
import { PenaltyTrendLine } from '../charts/PenaltyTrendLine'
import { SubmissionVelocity } from '../charts/SubmissionVelocity'
import { ClientPortfolioPie } from '../charts/ClientPortfolioPie'

/** A page section: a hairline, then a plain heading and its content. */
export function Section({ id, title, aside, children }: { id: string; title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="pt-6 mt-14" style={{ borderTop: '1px solid var(--line-strong)' }}>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <h2 id={id} className="v3-h2" style={{ color: 'var(--text)' }}>{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------- greeting
interface TopOpp {
  id: string; title: string; agency: string; probabilityScore: number; expectedValue: number; responseDeadline: string
  naicsCode?: string | null
  bidDecisions?: { recommendation: string; clientCompany?: { name: string } }[]
}

export function Greeting({ name, decisionsWaiting, closingThisWeek, best, actions }: {
  name: string; decisionsWaiting: number; closingThisWeek: number; best: TopOpp | undefined; actions: ReactNode
}) {
  const h = new Date().getHours()
  const hello = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const parts = [
    decisionsWaiting ? `${count(decisionsWaiting)} bid${decisionsWaiting === 1 ? '' : 's'} need${decisionsWaiting === 1 ? 's' : ''} a decision` : null,
    closingThisWeek ? `${count(closingThisWeek)} notice${closingThisWeek === 1 ? '' : 's'} close this week` : null,
  ].filter(Boolean)
  const summary = parts.length ? `${parts.join(' and ')}.` : 'Nothing is waiting on you today.'
  const pct = best ? Math.round((best.probabilityScore || 0) * 100) : 0
  const left = best ? daysUntil(best.responseDeadline) : 0

  return (
    <section aria-label="Today" className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-end pt-6">
      <div className="min-w-0">
        <h1 className="v3-h1" style={{ color: 'var(--text)' }}>{hello}, {name}</h1>
        <p className="v3-lede mt-4" style={{ color: 'var(--text)' }}>
          {summary} <span style={{ color: 'var(--text-dim)' }}>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.</span>
        </p>
        <div className="mt-7 flex flex-wrap gap-2">{actions}</div>
      </div>

      <aside className="v3-surface" aria-labelledby="best-match">
        <h2 id="best-match" className="text-[14px] font-medium" style={{ color: 'var(--text-muted)' }}>Best match today</h2>
        {best ? (
          <>
            <p className="v3-h3 mt-3 line-clamp-2" style={{ color: 'var(--text)' }}>{plainText(best.title)}</p>
            <p className="text-[14px] mt-1 truncate" style={{ color: 'var(--text-muted)' }}>
              {best.agency}{best.naicsCode ? `, NAICS ${best.naicsCode}` : ''}{left > 0 ? `, due in ${left} day${left === 1 ? '' : 's'}` : ''}
            </p>
            <div className="mt-5 pt-4 flex items-center justify-between gap-3" style={{ borderTop: '1px solid var(--line)' }}>
              <p className="v3-figure" style={{ color: 'var(--text)' }}>{pct}<small>%</small><span className="sr-only"> win probability</span></p>
              <Link to={`/opportunities/${best.id}`} className="v3-pill v3-pill-dark v3-pill-sm">Open the bid</Link>
            </div>
            <p className="text-[13px] mt-1" style={{ color: 'var(--text-dim)' }} aria-hidden="true">win probability</p>
          </>
        ) : (
          <p className="text-[15px] mt-3" style={{ color: 'var(--text-muted)' }}>
            Scored opportunities show here. <Link to="/opportunities" className="underline underline-offset-4" style={{ color: 'var(--text)' }}>Browse opportunities</Link>
          </p>
        )}
      </aside>
    </section>
  )
}

// ---------------------------------------------------------------- figures
interface Stage { label: string; count: number }

function Figure({ value, label, rows, to, blue = false }: { value: ReactNode; label: string; rows: { k: string; v: ReactNode; urgent?: boolean }[]; to?: string; blue?: boolean }) {
  const body = (
    <>
      <p className="v3-figure">{value}</p>
      <p className="text-[16px] font-semibold mt-2 tracking-[-0.01em]">{label}</p>
      <ul className="mt-4 v3-rule-list text-[14px]">
        {rows.map((r) => (
          <li key={r.k} className="flex items-center justify-between gap-3 py-2.5">
            <span className="v3-muted">{r.k}</span>
            <b className="font-semibold tabular-nums" style={r.urgent ? { color: 'var(--danger-text)' } : undefined}>{r.v}</b>
          </li>
        ))}
      </ul>
    </>
  )
  const cls = `v3-surface flex flex-col justify-end min-h-[248px] ${blue ? 'v3-surface-blue' : ''}`
  return to
    ? <Link to={to} className={`${cls} transition-shadow hover:shadow-[inset_0_0_0_1px_var(--line-strong)]`} style={blue ? undefined : { color: 'var(--text)' }}>{body}</Link>
    : <div className={cls} style={blue ? undefined : { color: 'var(--text)' }}>{body}</div>
}

export function Figures({ pipeline, stages, winProbability, decided, onTimeRate, submitted, penalties, decisionsWaiting, criticalRisks, clients, closingThisWeek, closing30, yourBidsDue }: {
  pipeline: { totalExpected: number; totalNet: number }
  stages: Stage[]
  winProbability: number
  decided: number
  onTimeRate: number
  submitted: number
  penalties: number
  decisionsWaiting: number
  criticalRisks: number
  clients: number | null
  closingThisWeek: number
  closing30: number
  yourBidsDue: number
}) {
  const scored = stages.find((s) => s.label === 'Scored')?.count ?? 0
  return (
    <section aria-label="Key figures" className="mt-10 grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
      <Figure blue value={money(pipeline.totalExpected)} label="Expected pipeline value" to="/portfolio"
        rows={[{ k: 'Net of bid costs', v: money(pipeline.totalNet) }, { k: 'Notices scored', v: count(scored) }]} />
      <Figure value={<>{Math.round(winProbability * 100)}<small>%</small></>} label="Average win probability" to="/decisions"
        rows={[
          { k: 'Bid decisions', v: count(decided) },
          { k: 'Submitted on time', v: submitted ? `${Math.round(onTimeRate * 100)}%` : 'None yet' },
          { k: 'Penalties, 30 days', v: money(penalties), urgent: penalties > 0 },
        ]} />
      <Figure value={count(decisionsWaiting)} label="Waiting for a decision" to="/pipeline"
        rows={[
          { k: 'Critical risks', v: count(criticalRisks), urgent: criticalRisks > 0 },
          ...(clients != null ? [{ k: 'Active clients', v: count(clients) }] : []),
        ]} />
      <Figure value={count(closingThisWeek)} label="Notices closing this week" to="/opportunities?sortBy=deadline"
        rows={[{ k: 'In the next 30 days', v: count(closing30) }, { k: 'Your bids due', v: count(yourBidsDue) }]} />
    </section>
  )
}

// ---------------------------------------------------------------- best opportunities
export function TopOpportunities({ items }: { items: TopOpp[] }) {
  if (items.length === 0) {
    return (
      <div className="v3-surface flex flex-wrap items-center justify-between gap-4">
        <p className="text-[15px]" style={{ color: 'var(--text-muted)' }}>No scored opportunities yet. They appear here once notices are matched to your companies.</p>
        <Link to="/opportunities" className="v3-pill v3-pill-light">Browse opportunities</Link>
      </div>
    )
  }
  return (
    <div className="v3-surface !py-2 overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <caption className="sr-only">Best opportunities by expected value</caption>
        <thead>
          <tr className="text-left text-[13px]" style={{ color: 'var(--text-muted)' }}>
            <th className="font-medium py-3" style={{ borderBottom: '1px solid var(--line-strong)' }}>Opportunity</th>
            <th className="font-medium py-3" style={{ borderBottom: '1px solid var(--line-strong)' }}>Recommendation</th>
            <th className="font-medium py-3 text-right" style={{ borderBottom: '1px solid var(--line-strong)' }}>Win</th>
            <th className="font-medium py-3 text-right" style={{ borderBottom: '1px solid var(--line-strong)' }}>Due</th>
          </tr>
        </thead>
        <tbody>
          {items.slice(0, 6).map((o) => {
            const rec = o.bidDecisions?.[0]
            const pct = Math.round((o.probabilityScore || 0) * 100)
            const left = daysUntil(o.responseDeadline)
            return (
              <tr key={o.id} className="v3-rule-list">
                <td className="py-4 pr-6" style={{ borderBottom: '1px solid var(--line)' }}>
                  <Link to={`/opportunities/${o.id}`} className="text-[16px] font-semibold tracking-[-0.01em] hover:underline underline-offset-4 line-clamp-1" style={{ color: 'var(--text)' }}>{plainText(o.title)}</Link>
                  <p className="text-[13px] truncate" style={{ color: 'var(--text-muted)' }}>{o.agency}</p>
                </td>
                <td className="py-4 pr-6 text-[14px]" style={{ borderBottom: '1px solid var(--line)', color: 'var(--text-2)' }}>
                  {rec ? <>{RECOMMENDATION[rec.recommendation] ?? rec.recommendation}{rec.clientCompany?.name ? <span style={{ color: 'var(--text-muted)' }}> for {rec.clientCompany.name}</span> : null}</> : <span style={{ color: 'var(--text-dim)' }}>Not decided</span>}
                </td>
                <td className="py-4 text-right text-[20px] font-semibold tabular-nums tracking-[-0.02em]" style={{ borderBottom: '1px solid var(--line)', color: 'var(--text)' }}>{pct}%</td>
                <td className="py-4 pl-6 text-right text-[14px] tabular-nums whitespace-nowrap" style={{ borderBottom: '1px solid var(--line)', color: left <= 3 ? 'var(--danger-text)' : 'var(--text-2)' }}>
                  {left <= 0 ? 'Today' : left === 1 ? 'Tomorrow' : new Date(o.responseDeadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ---------------------------------------------------------------- win spread
export function WinSpread({ buckets }: { buckets: { range: string; count: number }[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.count))
  const total = buckets.reduce((a, b) => a + b.count, 0)
  const high = buckets.slice(6).reduce((a, b) => a + b.count, 0)
  return (
    <div className="v3-surface h-full" aria-labelledby="spread-title">
      <h3 id="spread-title" className="v3-h3" style={{ color: 'var(--text)' }}>Where win probabilities sit</h3>
      <p className="text-[14px] mt-1" style={{ color: 'var(--text-muted)' }}>{count(high)} of {count(total)} scored notices are above 60%.</p>
      <ol className="mt-6 grid h-36 grid-cols-10 items-end gap-1.5" aria-label="Scored notices by win probability">
        {buckets.map((b, i) => (
          <li key={b.range} className="flex h-full flex-col justify-end" aria-label={`${b.range}: ${b.count} notices`} title={`${b.range}: ${count(b.count)}`}>
            <span className="block w-full rounded-t-full rounded-b-[2px]" style={{ height: `${b.count ? Math.max(4, (b.count / max) * 100) : 2}%`, background: i >= 6 ? 'var(--text)' : 'var(--surface-3)' }} />
          </li>
        ))}
      </ol>
      <div className="mt-2 flex justify-between text-[12px]" style={{ color: 'var(--text-dim)' }} aria-hidden="true">
        <span>0%</span><span>50%</span><span>100%</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- insights
interface Risk { title: string; description: string; severity: string; entityType: string }
interface Decision { id: string; recommendation: string; winProbability: number; opportunity: { id: string; title: string; agency: string }; clientCompany?: { name: string } }
interface Match { opportunityId?: string; id?: string; title: string; agency?: string; score?: number; reason?: string }

/** The tab switch shared by the insight and analytics panels. */
function Switch<T extends string>({ label, tabs, value, onChange }: { label: string; tabs: readonly { key: T; label: string; n?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.key} type="button" role="tab" aria-selected={value === t.key} className="v3-tag !h-8 !px-3.5 !text-[13px]" onClick={() => onChange(t.key)}>
          {t.label}{t.n ? <span className="ml-1.5 tabular-nums opacity-70">{t.n}</span> : null}
        </button>
      ))}
    </div>
  )
}

export function InsightsCard({ risks, decisions, matches }: { risks: Risk[]; decisions: Decision[]; matches: Match[] }) {
  const tabs = [
    { key: 'risks', label: 'Risks', n: risks.length },
    { key: 'decisions', label: 'Recent decisions', n: decisions.length },
    { key: 'matches', label: 'New matches', n: matches.length },
  ] as const
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('risks')
  const row = 'flex items-center gap-4 py-3.5'

  return (
    <div id="insights" className="v3-surface h-full scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="v3-h3" style={{ color: 'var(--text)' }}>From your agents</h3>
        <Switch label="Insights" tabs={tabs} value={tab} onChange={setTab} />
      </div>
      <div role="tabpanel" className="mt-3">
        {tab === 'risks' && (risks.length === 0
          ? <p className="py-6 text-[14px]" style={{ color: 'var(--text-muted)' }}>No risks flagged. The agents check deadlines, compliance and penalties every hour.</p>
          : <ul className="v3-rule-list">{risks.slice(0, 5).map((r, i) => (
              <li key={i} className={row}>
                <span className="text-[13px] font-semibold w-16 flex-none" style={{ color: r.severity === 'CRITICAL' ? 'var(--danger-text)' : r.severity === 'HIGH' ? 'var(--warning)' : 'var(--text-muted)' }}>
                  {r.severity.charAt(0) + r.severity.slice(1).toLowerCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium" style={{ color: 'var(--text)' }}>{plainText(r.title)}</span>
                  <span className="block truncate text-[13px]" style={{ color: 'var(--text-muted)' }}>{r.description}</span>
                </span>
              </li>
            ))}</ul>)}
        {tab === 'decisions' && (decisions.length === 0
          ? <p className="py-6 text-[14px]" style={{ color: 'var(--text-muted)' }}>No bid decisions yet. They appear as notices are scored for your companies.</p>
          : <ul className="v3-rule-list">{decisions.slice(0, 5).map((d) => (
              <li key={d.id}>
                <Link to={`/opportunities/${d.opportunity.id}`} className={`${row} group`}>
                  <span className="text-[13px] font-semibold w-24 flex-none" style={{ color: d.recommendation === 'NO_BID' ? 'var(--text-muted)' : 'var(--text)' }}>{RECOMMENDATION[d.recommendation] ?? d.recommendation}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium group-hover:underline underline-offset-4" style={{ color: 'var(--text)' }}>{plainText(d.opportunity.title)}</span>
                    <span className="block truncate text-[13px]" style={{ color: 'var(--text-muted)' }}>{d.clientCompany?.name ?? d.opportunity.agency}</span>
                  </span>
                  <span className="text-[15px] font-semibold tabular-nums flex-none" style={{ color: 'var(--text)' }}>{Math.round(d.winProbability * 100)}%</span>
                </Link>
              </li>
            ))}</ul>)}
        {tab === 'matches' && (matches.length === 0
          ? <p className="py-6 text-[14px]" style={{ color: 'var(--text-muted)' }}>No new matches right now.</p>
          : <ul className="v3-rule-list">{matches.slice(0, 5).map((m, i) => (
              <li key={i}>
                <Link to={`/opportunities/${m.opportunityId ?? m.id}`} className={`${row} group`}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] font-medium group-hover:underline underline-offset-4" style={{ color: 'var(--text)' }}>{plainText(m.title)}</span>
                    <span className="block truncate text-[13px]" style={{ color: 'var(--text-muted)' }}>{m.reason ?? m.agency}</span>
                  </span>
                </Link>
              </li>
            ))}</ul>)}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- more analytics
export function MoreAnalytics({ forecast, submissions, penalties, clients }: { forecast: unknown; submissions: unknown; penalties: unknown; clients: unknown[] | null }) {
  const tabs = [
    { key: 'forecast', label: 'Revenue forecast' },
    { key: 'submissions', label: 'Submissions' },
    { key: 'penalties', label: 'Penalties' },
    ...(clients ? [{ key: 'clients', label: 'Clients' }] : []),
  ] as { key: string; label: string }[]
  const [tab, setTab] = useState('forecast')
  return (
    <Section id="more-title" title="More analytics" aside={<Switch label="More analytics" tabs={tabs} value={tab} onChange={setTab} />}>
      <div role="tabpanel">
        {tab === 'forecast' && <RevenueForecast data={forecast as never} />}
        {tab === 'submissions' && <SubmissionVelocity data={submissions as never} />}
        {tab === 'penalties' && <PenaltyTrendLine data={penalties as never} />}
        {tab === 'clients' && clients && <ClientPortfolioPie clients={clients as never} />}
      </div>
    </Section>
  )
}
