// =============================================================
// The next 30 days of bidding (Dashboard). Left: one bar per day for the
// notices closing that day (square-root scale, so one busy day doesn't
// flatten the rest); ink for this week, blue where one of your own bids is
// due, light for later. Right: your bids coming up, by day. Hover or focus a
// day for its count. Data: GET /api/firm/dashboard → calendar.
// =============================================================
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { count, daysUntil, plainText, STAGE } from './format'

export interface Calendar {
  closingByDay: { day: string; count: number }[]
  bidsDue: { pursuitId: string; stage: string; opportunityId: string; title: string; agency: string; deadline: string }[]
}

const DAYS = 31
const WEEK = 8 // today plus 7 days, matching "closing this week"
const on = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return d }
const fmt = (offset: number, opts: Intl.DateTimeFormatOptions) => on(offset).toLocaleDateString('en-US', opts)

export function DeadlineTimeline({ calendar }: { calendar: Calendar | undefined }) {
  const [active, setActive] = useState<number | null>(null)

  const { days, max, total } = useMemo(() => {
    const days = Array.from({ length: DAYS }, () => ({ count: 0, bids: [] as Calendar['bidsDue'] }))
    for (const r of calendar?.closingByDay ?? []) {
      const i = daysUntil(`${r.day}T12:00:00`)
      if (i >= 0 && i < DAYS) days[i].count += r.count
    }
    for (const b of calendar?.bidsDue ?? []) {
      const i = daysUntil(b.deadline)
      if (i >= 0 && i < DAYS) days[i].bids.push(b)
    }
    return { days, max: Math.max(1, ...days.map((d) => d.count)), total: days.reduce((a, d) => a + d.count, 0) }
  }, [calendar])

  const bids = [...(calendar?.bidsDue ?? [])].sort((a, b) => +new Date(a.deadline) - +new Date(b.deadline))
  const shown = active == null ? null : days[active]

  return (
    <div className="grid gap-3.5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <div className="v3-surface min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="v3-h3" style={{ color: 'var(--text)' }}>Notices closing each day</h3>
            <p className="text-[14px] mt-1" style={{ color: 'var(--text-muted)' }}>{count(total)} notices across your NAICS codes in the next 30 days.</p>
          </div>
          <ul className="flex flex-wrap gap-4 text-[13px]" style={{ color: 'var(--text-muted)' }} aria-label="Legend">
            <li className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full" style={{ background: 'var(--v3-blue)' }} />Your bid due</li>
            <li className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full" style={{ background: 'var(--text)' }} />This week</li>
            <li className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full" style={{ background: 'var(--surface-3)' }} />Later</li>
          </ul>
        </div>

        <div className="relative mt-8" onMouseLeave={() => setActive(null)}>
          {shown && active != null && (
            <div role="status" className="absolute -top-3 z-10 pointer-events-none rounded-xl px-3 py-2 text-[13px] whitespace-nowrap"
              style={{
                left: `${((active + 0.5) / DAYS) * 100}%`, transform: `translate(${active > DAYS - 5 ? '-100%' : active < 4 ? '0' : '-50%'}, -100%)`,
                background: 'var(--text)', color: 'var(--surface)',
              }}>
              <b>{active === 0 ? 'Today' : fmt(active, { weekday: 'short', month: 'short', day: 'numeric' })}</b>
              {', '}{count(shown.count)} notice{shown.count === 1 ? '' : 's'} close{shown.bids.length > 0 && <>, {shown.bids.length} of yours</>}
            </div>
          )}
          <ol className="grid h-[220px] items-end gap-[5px]" style={{ gridTemplateColumns: `repeat(${DAYS}, minmax(0, 1fr))`, borderBottom: '1px solid var(--line)' }} aria-label="Notices closing per day">
            {days.map((d, i) => {
              const h = d.count ? Math.max(3, Math.sqrt(d.count / max) * 100) : 1.5
              const color = d.bids.length ? 'var(--v3-blue)' : i < WEEK ? 'var(--text)' : 'var(--surface-3)'
              return (
                <li key={i} className="h-full">
                  <button type="button"
                    className="h-full w-full flex flex-col justify-end items-center rounded-md cursor-default focus-visible:outline-2"
                    aria-label={`${i === 0 ? 'Today' : fmt(i, { weekday: 'long', month: 'long', day: 'numeric' })}: ${d.count} notices close${d.bids.length ? `, ${d.bids.length} of your bids` : ''}`}
                    onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
                    <span className="block w-full rounded-t-full rounded-b-[2px]"
                      style={{ height: `${h}%`, background: color, opacity: active != null && active !== i ? 0.5 : 1, transition: 'opacity .15s ease' }} />
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="mt-2.5 flex justify-between text-[12px]" style={{ color: 'var(--text-dim)' }} aria-hidden="true">
            {[0, 7, 14, 21, 28].map((i) => <span key={i}>{i === 0 ? 'Today' : fmt(i, { month: 'short', day: 'numeric' })}</span>)}
          </div>
        </div>
      </div>

      <div className="v3-surface" aria-labelledby="coming-up">
        <h3 id="coming-up" className="v3-h3" style={{ color: 'var(--text)' }}>Coming up</h3>
        <p className="text-[14px] mt-1" style={{ color: 'var(--text-muted)' }}>Your bids due in the next 30 days.</p>
        {bids.length === 0 ? (
          <p className="mt-6 text-[14px]" style={{ color: 'var(--text-muted)' }}>
            None of your bids are due soon. <Link to="/opportunities?sortBy=deadline" className="underline underline-offset-4" style={{ color: 'var(--text)' }}>Find one closing soon</Link>
          </p>
        ) : (
          <ul className="mt-4 v3-rule-list">
            {bids.slice(0, 4).map((b) => {
              const left = daysUntil(b.deadline)
              const d = new Date(b.deadline)
              return (
                <li key={b.pursuitId}>
                  <Link to={`/opportunities/${b.opportunityId}`} className="grid grid-cols-[56px_1fr] gap-3 py-3.5 group">
                    <span className="text-[28px] leading-8 font-semibold tracking-[-0.04em] tabular-nums" style={{ color: 'var(--text)' }}>
                      {d.getDate()}
                      <small className="block text-[12px] leading-4 font-medium tracking-normal mt-1" style={{ color: 'var(--text-muted)' }}>{d.toLocaleDateString('en-US', { weekday: 'short' })}</small>
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[15px] font-semibold group-hover:underline underline-offset-4" style={{ color: 'var(--text)' }}>{plainText(b.title)}</span>
                      <span className="block truncate text-[13px]" style={{ color: left <= 2 ? 'var(--danger-text)' : 'var(--text-muted)' }}>
                        {STAGE[b.stage] ?? b.stage}, {left <= 0 ? 'due today' : left === 1 ? 'due tomorrow' : `due in ${left} days`}
                      </span>
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
