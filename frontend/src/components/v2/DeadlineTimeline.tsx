// =============================================================
// The next 30 days of bidding (v2 Dashboard). One column per day: the bar
// is how many notices close that day (square-root scale, so a 120-notice
// day doesn't flatten the rest), the first week drawn in full blue because
// that is where decisions are due. The firm's own open bids are pinned
// above their day. Hover or focus a day for its count; the list below names
// the bids due next. Data: GET /api/firm/dashboard → calendar.
// =============================================================
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CalendarClock } from 'lucide-react'
import { count, daysUntil, plainText, STAGE } from './format'

export interface Calendar {
  closingByDay: { day: string; count: number }[]
  bidsDue: { pursuitId: string; stage: string; opportunityId: string; title: string; agency: string; deadline: string }[]
}

// Today plus the next 30 days; the first week (today to 7 days out) matches the
// dashboard's "close within 7 days" alert.
const DAYS = 31
const URGENT_DAYS = 8
const dayLabel = (offset: number, opts: Intl.DateTimeFormatOptions) => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('en-US', opts)
}

export function DeadlineTimeline({ calendar }: { calendar: Calendar | undefined }) {
  const [active, setActive] = useState<number | null>(null)

  const { days, max, total, urgent } = useMemo(() => {
    const days = Array.from({ length: DAYS }, () => ({ count: 0, bids: [] as Calendar['bidsDue'] }))
    for (const r of calendar?.closingByDay ?? []) {
      const i = daysUntil(`${r.day}T12:00:00`)
      if (i >= 0 && i < DAYS) days[i].count += r.count
    }
    for (const b of calendar?.bidsDue ?? []) {
      const i = daysUntil(b.deadline)
      if (i >= 0 && i < DAYS) days[i].bids.push(b)
    }
    const max = Math.max(1, ...days.map((d) => d.count))
    const total = days.reduce((a, d) => a + d.count, 0)
    const urgent = days.slice(0, URGENT_DAYS).reduce((a, d) => a + d.count, 0)
    return { days, max, total, urgent }
  }, [calendar])

  const bids = calendar?.bidsDue ?? []
  const shown = active == null ? null : days[active]

  return (
    <section className="v2-card v2-card-pad" aria-labelledby="timeline-title">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div>
          <h2 id="timeline-title" className="v2-card-title flex items-center gap-2">
            <CalendarClock className="w-4 h-4" style={{ color: 'var(--accent)' }} aria-hidden="true" />
            Next 30 days
          </h2>
          <p className="v2-card-sub">Notices closing each day, with your bids pinned above their deadline.</p>
        </div>
        <dl className="flex gap-6 text-right">
          <div>
            <dt className="v2-kpi-note">Next 7 days</dt>
            <dd className="num text-lg font-semibold" style={{ color: 'var(--text)' }}>{count(urgent)}</dd>
          </div>
          <div>
            <dt className="v2-kpi-note">30 days</dt>
            <dd className="num text-lg font-semibold" style={{ color: 'var(--text)' }}>{count(total)}</dd>
          </div>
          <div>
            <dt className="v2-kpi-note">Your bids</dt>
            <dd className="num text-lg font-semibold" style={{ color: 'var(--accent)' }}>{bids.length}</dd>
          </div>
        </dl>
      </div>

      {/* The chart: pins row, bars, then the date axis. */}
      <div className="relative mt-6" onMouseLeave={() => setActive(null)}>
        {shown && active != null && (
          <div
            role="status"
            className="absolute -top-2 z-10 pointer-events-none rounded-lg px-3 py-2 text-xs whitespace-nowrap"
            style={{
              left: `${((active + 0.5) / DAYS) * 100}%`, transform: `translate(${active > DAYS - 5 ? '-100%' : active < 4 ? '0' : '-50%'}, -100%)`,
              background: 'var(--text)', color: 'var(--surface)', boxShadow: 'var(--v2-shadow-raised)',
            }}
          >
            <span className="font-semibold">{active === 0 ? 'Today' : dayLabel(active, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            {' · '}{count(shown.count)} notice{shown.count === 1 ? '' : 's'} close
            {shown.bids.length > 0 && <> · {shown.bids.length} of yours</>}
          </div>
        )}
        <ol className="grid h-36 items-end gap-[3px]" style={{ gridTemplateColumns: `repeat(${DAYS}, minmax(0, 1fr))` }} aria-label="Notices closing per day">
          {days.map((d, i) => {
            const h = d.count ? Math.max(6, Math.sqrt(d.count / max) * 100) : 2
            const urgentDay = i < URGENT_DAYS
            return (
              <li key={i} className="h-full">
              <button
                type="button"
                className="relative h-full w-full flex flex-col justify-end items-center outline-none rounded-md focus-visible:ring-2 cursor-default"
                style={{ ['--tw-ring-color' as string]: 'var(--accent)' }}
                aria-label={`${i === 0 ? 'Today' : dayLabel(i, { weekday: 'long', month: 'long', day: 'numeric' })}: ${d.count} notices close${d.bids.length ? `, ${d.bids.length} of your bids` : ''}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
              >
                {d.bids.length > 0 && (
                  <span
                    className="mb-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold num"
                    style={{ background: 'var(--accent)', color: '#fff', boxShadow: '0 0 0 3px var(--surface)' }}
                    aria-hidden="true"
                  >
                    {d.bids.length}
                  </span>
                )}
                <motion.span
                  className="block w-full rounded-[4px]"
                  style={{
                    height: `${h}%`, transformOrigin: 'bottom',
                    background: active === i ? 'var(--accent-2)' : urgentDay ? 'var(--v2-bar-strong)' : 'var(--v2-bar)',
                    opacity: active != null && active !== i ? 0.55 : 1,
                    transition: 'opacity .15s ease, background-color .15s ease',
                  }}
                  initial={{ scaleY: 0 }}
                  animate={{ scaleY: 1 }}
                  transition={{ duration: 0.5, delay: 0.15 + i * 0.012, ease: [0.22, 1, 0.36, 1] }}
                />
              </button>
              </li>
            )
          })}
        </ol>
        <div className="grid mt-2 text-[11px]" style={{ gridTemplateColumns: `repeat(${DAYS}, minmax(0, 1fr))`, color: 'var(--text-faint)' }} aria-hidden="true">
          {days.map((_, i) => (
            <span key={i} className="whitespace-nowrap">
              {i === 0 ? 'Today' : i % 7 === 0 ? dayLabel(i, { month: 'short', day: 'numeric' }) : ''}
            </span>
          ))}
        </div>
      </div>

      {/* Your bids due next. */}
      <div className="mt-5 pt-4" style={{ borderTop: '1px solid var(--line)' }}>
        {bids.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            None of your bids close in the next 30 days. <Link to="/opportunities?sortBy=deadline" className="v2-link">Find one closing soon</Link>
          </p>
        ) : (
          <ul className="v2-divide">
            {bids.slice(0, 4).map((b) => {
              const left = daysUntil(b.deadline)
              return (
                <li key={b.pursuitId}>
                  <Link to={`/opportunities/${b.opportunityId}`} className="v2-row">
                    <span className={`v2-pill num ${left <= 3 ? 'v2-pill-danger' : left <= URGENT_DAYS ? 'v2-pill-warning' : ''}`} style={{ minWidth: 64, justifyContent: 'center' }}>
                      {left === 0 ? 'Today' : `${left} day${left === 1 ? '' : 's'}`}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium" style={{ color: 'var(--text)' }}>{plainText(b.title)}</span>
                      <span className="block truncate text-xs" style={{ color: 'var(--text-faint)' }}>{b.agency}</span>
                    </span>
                    <span className="v2-pill hidden sm:inline-flex">{STAGE[b.stage] ?? b.stage}</span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}
