import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchHistoryApi, type Counted, type FetchRow } from '../services/fetchHistoryApi'

const DAY_CHOICES = [7, 30, 90]
const FIRMS_SHOWN = 100

const TRIGGER_LABEL: Record<string, string> = {
  SCHEDULE: 'Scheduled',
  RESTART: 'Server restart',
  SYNC_BUTTON: 'Sync button',
  ON_DEMAND: 'On-demand pull',
}
const triggerText = (row: FetchRow) => {
  const label = row.trigger ? TRIGGER_LABEL[row.trigger] ?? row.trigger : 'Not recorded'
  return row.triggerDetail ? `${label} (${row.triggerDetail})` : label
}
const ok = (status: string) => status === 'COMPLETE' || status === 'SUCCEEDED'
const n = (value: number | null) => (value === null ? '—' : value.toLocaleString())
const utcDay = (iso: string | null) => (iso ? iso.slice(0, 10) : 'Unknown')
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—')
const seconds = (ms: number | null) => (ms === null ? '—' : ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`)

/** Why a source ran more than once in a day, in one sentence. */
export function sameDayNote(source: string, rows: FetchRow[]): string {
  const reasons = new Map<string, number>()
  for (const row of rows) reasons.set(triggerText(row), (reasons.get(triggerText(row)) ?? 0) + 1)
  const parts = [...reasons].map(([reason, count]) => `${count} × ${reason}`)
  const failed = rows.filter((r) => !ok(r.status) && r.status !== 'RUNNING')
  const failure = failed.length ? ` ${failed.length} did not finish${failed[0].error ? `: ${failed[0].error.slice(0, 120)}` : ''}.` : ''
  return `${source} ran ${rows.length} times this day: ${parts.join(', ')}.${failure}`
}

function Bars({ title, rows, limit = 12 }: { title: string; rows: Counted[]; limit?: number }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <section className="rounded-lg border border-slate-700 p-4">
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      {rows.length === 0 && <p className="text-sm text-slate-400">None.</p>}
      <ul className="space-y-1.5">
        {rows.slice(0, limit).map((r) => (
          <li key={r.key} className="text-sm">
            <div className="flex justify-between gap-3"><span className="truncate">{r.key}</span><span className="tabular-nums">{r.count.toLocaleString()}</span></div>
            <div className="h-1.5 rounded bg-slate-700/40"><div className="h-1.5 rounded bg-cyan-600" style={{ width: `${(r.count / max) * 100}%` }} /></div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-700 p-3">
      <dt className="text-xs text-slate-400">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</dd>
    </div>
  )
}

function Notices({ run, firmId, showFirm, onClose }: { run: FetchRow | null; firmId?: string; showFirm: boolean; onClose: () => void }) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const { data, isLoading } = useQuery({
    queryKey: ['fetch-notices', firmId ?? 'all', run?.id ?? 'all', search, page],
    queryFn: () => fetchHistoryApi.notices({ firmId, runKind: run?.kind, runId: run?.id, search: search || undefined, page }),
  })
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  return (
    <section className="rounded-lg border border-slate-700 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">
          {run ? `Notices added by the ${run.source} fetch at ${time(run.startedAt)} on ${utcDay(run.startedAt)}` : 'All notices'}
          {data && <span className="ml-2 text-sm font-normal text-slate-400">{data.total.toLocaleString()}</span>}
        </h2>
        <div className="flex gap-2">
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1) }}
            placeholder="Search title, agency or notice ID"
            className="rounded border border-slate-700 bg-transparent px-3 py-1.5 text-sm"
          />
          {run && <button type="button" onClick={onClose} className="btn-secondary text-sm">Show all notices</button>}
        </div>
      </div>
      {run && <p className="text-xs text-slate-400">Notices saved while this fetch ran. Ones it found that were already held aren't listed.</p>}
      {isLoading ? <p className="text-sm text-slate-400">Loading…</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-400">
              <tr><th className="py-1 pr-3">Title</th>{showFirm && <th className="pr-3">Firm</th>}<th className="pr-3">Agency</th><th className="pr-3">Business type</th><th className="pr-3">Source</th><th className="pr-3">Deadline</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data?.notices.map((o) => (
                <tr key={o.id} className="border-t border-slate-700/50">
                  <td className="py-1.5 pr-3">{o.sourceUrl ? <a href={o.sourceUrl} target="_blank" rel="noreferrer" className="hover:underline">{o.title}</a> : o.title}</td>
                  {showFirm && <td className="pr-3">{o.firm}</td>}
                  <td className="pr-3">{o.agency}</td>
                  <td className="pr-3">{o.businessType ?? (o.naicsCode ? `NAICS ${o.naicsCode}` : '—')}</td>
                  <td className="pr-3">{o.source}</td>
                  <td className="pr-3 tabular-nums">{o.responseDeadline.slice(0, 10)}</td>
                  <td>{o.open ? 'Open' : 'Closed'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.notices.length === 0 && <p className="py-3 text-sm text-slate-400">No notices.</p>}
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center gap-3 text-sm">
          <button type="button" className="btn-secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="tabular-nums">Page {page} of {pages}</span>
          <button type="button" className="btn-secondary" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </section>
  )
}

/** For the one developer account: every fetch of opportunities, why each ran, and what is held. */
export default function FetchHistoryPage() {
  const [days, setDays] = useState(30)
  const [firmId, setFirmId] = useState<string | undefined>(undefined)
  const [run, setRun] = useState<FetchRow | null>(null)
  const history = useQuery({ queryKey: ['fetch-history', days, firmId ?? 'all'], queryFn: () => fetchHistoryApi.history(days, firmId), retry: false })
  const breakdown = useQuery({ queryKey: ['fetch-breakdown', firmId ?? 'all'], queryFn: () => fetchHistoryApi.breakdown(firmId), retry: false })
  const allFirms = useQuery({ queryKey: ['fetch-breakdown', 'all'], queryFn: () => fetchHistoryApi.breakdown(), retry: false, enabled: Boolean(firmId) })
  const firms = (firmId ? allFirms.data?.firms : breakdown.data?.firms) ?? null
  const chooseFirm = (id?: string) => { setFirmId(id); setRun(null) }

  const byDay = useMemo(() => {
    const groups = new Map<string, FetchRow[]>()
    for (const row of history.data?.fetches ?? []) {
      const day = utcDay(row.startedAt)
      groups.set(day, [...(groups.get(day) ?? []), row])
    }
    return [...groups]
  }, [history.data])

  if (history.error || breakdown.error) return <p className="text-sm text-slate-400">This page isn't available.</p>
  const pool = history.data?.scope === 'pool'
  const showFirm = history.data?.scope === 'all'
  const firmName = firms?.find((f) => f.id === firmId)?.name
  const h = breakdown.data?.holdings

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-xl font-semibold">{pool ? 'SAM.gov pool: fetch history' : firmName ? `Fetch history: ${firmName}` : 'Fetch history: all firms'}</h1>
        <p className="text-sm text-slate-400">
          {pool ? 'Every fetch into the shared pool that demo accounts are filled from, and what the pool holds now.' : 'Every fetch of opportunities on this installation, from SAM.gov and Discovery sources, and what each firm holds. Only the developer account can see this page.'}
        </p>
        {firms && (
          <label className="mt-3 inline-block text-sm text-slate-300">
            Firm
            <select value={firmId ?? ''} onChange={(e) => chooseFirm(e.target.value || undefined)} className="ml-2 rounded border border-slate-700 bg-transparent px-2 py-1 text-sm">
              <option value="">All firms</option>
              {firms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </label>
        )}
      </div>

      {!firmId && firms && (
        <section className="rounded-lg border border-slate-700 p-4">
          <h2 className="text-base font-semibold mb-1">Firms</h2>
          <p className="text-xs text-slate-400 mb-3">Most notices first. Last 30 days for fetch counts. Click a firm to see only its data.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-400">
                <tr><th className="py-1 pr-3">Firm</th><th className="pr-3">Notices</th><th className="pr-3">Open</th><th className="pr-3">Own SAM key</th><th className="pr-3">SAM.gov fetches (failed)</th><th className="pr-3">Source runs (failed)</th><th>Last SAM.gov fetch</th></tr>
              </thead>
              <tbody>
                {firms.slice(0, FIRMS_SHOWN).map((f) => (
                  <tr key={f.id} className="border-t border-slate-700/50 align-top">
                    <td className="py-1.5 pr-3"><button type="button" className="underline text-left" onClick={() => chooseFirm(f.id)}>{f.name}</button>{!f.active && <span className="ml-1 text-xs text-slate-400">(inactive)</span>}</td>
                    <td className="pr-3 tabular-nums">{f.total.toLocaleString()}</td>
                    <td className="pr-3 tabular-nums">{f.open.toLocaleString()}</td>
                    <td className="pr-3">{f.ownSamKey ? 'Yes' : 'No'}</td>
                    <td className="pr-3 tabular-nums">{f.samFetches30d} ({f.samFailures30d})</td>
                    <td className="pr-3 tabular-nums">{f.sourceRuns30d} ({f.sourceFailures30d})</td>
                    <td>{f.lastSamFetch ? <span className={f.lastSamFetch.ok ? '' : 'text-red-400'}>{f.lastSamFetch.at ? new Date(f.lastSamFetch.at).toLocaleString() : '—'}{f.lastSamFetch.ok ? '' : ` · failed${f.lastSamFetch.error ? `: ${f.lastSamFetch.error.slice(0, 80)}` : ''}`}</span> : 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {firms.length > FIRMS_SHOWN && <p className="pt-2 text-xs text-slate-400">Showing {FIRMS_SHOWN} of {firms.length}. Pick any firm from the list above.</p>}
          </div>
        </section>
      )}

      {h && (
        <>
          <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <Tile label="Total" value={h.total} />
            <Tile label="Open" value={h.open} />
            <Tile label="Closed (deadline passed)" value={h.closed} />
            <Tile label="Due in 7 days" value={h.dueWithin.days7} />
            <Tile label="Due in 30 days" value={h.dueWithin.days30} />
            <Tile label="Due in 90 days" value={h.dueWithin.days90} />
            <Tile label="Due later" value={h.dueWithin.later} />
          </dl>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Bars title="Open by business type" rows={h.byBusinessType} />
            <Bars title="Open by notice type" rows={h.byNoticeType} />
            <Bars title="Open by set-aside" rows={h.bySetAside.map((r) => (r.key === 'NONE' ? { ...r, key: 'No set-aside' } : r))} />
            <Bars title="Open: top agencies" rows={h.topAgencies} />
            <Bars title="All by source" rows={h.bySource} />
            <Bars title="All by status" rows={h.byStatus} />
            <Bars title="Posted per week (last 8)" rows={h.postedByWeek.map((w) => ({ key: `Week of ${w.week.slice(0, 10)}`, count: w.count }))} />
          </div>
        </>
      )}

      {breakdown.data?.accounts && (
        <section className="rounded-lg border border-slate-700 p-4">
          <h2 className="text-base font-semibold mb-3">Demo accounts</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-slate-400"><tr><th className="py-1 pr-3">Account</th><th className="pr-3">Business type</th><th className="pr-3">Real open</th><th>Invented open</th></tr></thead>
              <tbody>
                {breakdown.data.accounts.map((a) => (
                  <tr key={a.name} className="border-t border-slate-700/50"><td className="py-1.5 pr-3">{a.name}</td><td className="pr-3">{a.businessType}</td><td className="pr-3 tabular-nums">{a.realOpen.toLocaleString()}</td><td className="tabular-nums">{a.inventedOpen.toLocaleString()}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Fetches (days in UTC)</h2>
          <label className="text-sm text-slate-300">
            Last
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-2 rounded border border-slate-700 bg-transparent px-2 py-1 text-sm">
              {DAY_CHOICES.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
        </div>
        {history.isLoading && <p className="text-sm text-slate-400">Loading…</p>}
        {!history.isLoading && byDay.length === 0 && <p className="text-sm text-slate-400">No fetches in this period.</p>}
        {history.data?.capped && <p className="text-xs text-amber-500">Only the most recent fetches are listed. Choose a firm or a shorter period to see them all.</p>}
        {byDay.map(([day, rows]) => {
          const bySource = new Map<string, FetchRow[]>()
          for (const r of rows) {
            const key = showFirm ? `${r.source} for ${r.firm}` : r.source
            bySource.set(key, [...(bySource.get(key) ?? []), r])
          }
          const repeated = [...bySource].filter(([, list]) => list.length > 1)
          return (
            <div key={day} className="rounded-lg border border-slate-700 p-4 space-y-2">
              <h3 className="text-sm font-semibold">{day} <span className="font-normal text-slate-400">· {rows.length} {rows.length === 1 ? 'fetch' : 'fetches'}</span></h3>
              {repeated.map(([source, list]) => <p key={source} className="text-xs text-amber-500">{sameDayNote(source, list)}</p>)}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-slate-400">
                    <tr><th className="py-1 pr-3">Time</th>{showFirm && <th className="pr-3">Firm</th>}<th className="pr-3">Source</th><th className="pr-3">Why</th><th className="pr-3">Result</th><th className="pr-3">Requests / pages</th><th className="pr-3">Fetched</th><th className="pr-3">New</th><th className="pr-3">Took</th><th /></tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-t border-slate-700/50 align-top">
                        <td className="py-1.5 pr-3 tabular-nums">{time(r.startedAt)}</td>
                        {showFirm && <td className="pr-3">{r.firm}</td>}
                        <td className="pr-3">{r.source}</td>
                        <td className="pr-3">{triggerText(r)}</td>
                        <td className="pr-3">
                          <span className={ok(r.status) ? 'text-emerald-500' : r.status === 'RUNNING' ? 'text-slate-400' : 'text-red-400'}>{ok(r.status) ? 'Done' : r.status === 'RUNNING' ? 'Running' : 'Failed'}</span>
                          {r.error && <div className="text-xs text-slate-400 max-w-xs">{r.error.slice(0, 160)}</div>}
                        </td>
                        <td className="pr-3 tabular-nums">{r.kind === 'sam' ? n(r.requests) : n(r.pages)}</td>
                        <td className="pr-3 tabular-nums">{n(r.fetched)}</td>
                        <td className="pr-3 tabular-nums">{n(r.added)}</td>
                        <td className="pr-3 tabular-nums">{seconds(r.durationMs)}</td>
                        <td><button type="button" className="text-xs underline" onClick={() => setRun(r)}>View notices</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}
      </section>

      <Notices key={`${firmId ?? 'all'}-${run?.id ?? 'all'}`} run={run} firmId={firmId} showFirm={showFirm} onClose={() => setRun(null)} />
    </div>
  )
}
