import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { demoApi, type DemoPoolPull } from '../demo/demoApi'

const errorText = (err: unknown): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'That did not work. Please try again.'

const WATCH_MS = 5000

function progressText(progress: DemoPoolPull['progress']): string {
  if (!progress) return 'No on-demand pull has run yet.'
  if (progress.finishedAt) return `Every open notice from the last 30 days has been fetched (${progress.total?.toLocaleString() ?? 0} on SAM.gov).`
  if (progress.total === null) return 'The last pull stopped before SAM.gov answered, so the next one starts from the beginning.'
  return `Fetched ${progress.nextPage ?? 0} of ${progress.totalPages ?? '?'} pages. ${progress.total.toLocaleString()} open notices on SAM.gov.`
}

function lastPullText(last: DemoPoolPull['lastPull']): string {
  if (!last || last.ok === null) return ''
  const when = last.at ? new Date(last.at).toLocaleString() : ''
  if (!last.ok) return `The last pull failed (${when}): ${last.error}`
  return `Last pull (${when}): ${last.requests ?? 0} ${last.requests === 1 ? 'request' : 'requests'}, ${(last.found ?? 0).toLocaleString()} notices fetched, ${(last.added ?? 0).toLocaleString()} new to the pool.`
}

/** The pool administrator fetches more from SAM.gov on demand. */
export default function DemoPoolPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['demo-pool'],
    queryFn: demoApi.pool,
    retry: false,
    refetchInterval: (query) => (query.state.data?.running ? WATCH_MS : false),
  })
  const [requests, setRequests] = useState(1)
  const [message, setMessage] = useState('')

  const pull = useMutation({
    mutationFn: () => demoApi.pullPool(requests),
    onSuccess: () => {
      setMessage('')
      void queryClient.invalidateQueries({ queryKey: ['demo-pool'] })
    },
    onError: (err) => setMessage(errorText(err)),
  })

  if (error) return <p className="text-sm text-slate-400">Only the pool administrator can use this page.</p>
  if (isLoading || !data) return <p className="text-sm text-slate-400">Loading…</p>

  const choices = Array.from({ length: Math.min(data.maxPerPull, data.requestsAvailable) }, (_, i) => i + 1)
  const chosen = choices.includes(requests) ? requests : choices[choices.length - 1] ?? 1
  const finished = Boolean(data.progress?.finishedAt)
  const lastPull = lastPullText(data.lastPull)

  return (
    <div className="space-y-5 max-w-2xl">
      <div>
        <h1 className="text-xl font-semibold">SAM.gov pool</h1>
        <p className="text-sm text-slate-400">Fetches more notices for every demo account. Each request brings up to 1,000.</p>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
        <div className="rounded-lg border border-slate-700 p-3"><dt className="text-slate-400">Open in the pool</dt><dd className="text-lg font-semibold tabular-nums">{data.openNotices.toLocaleString()}</dd></div>
        <div className="rounded-lg border border-slate-700 p-3"><dt className="text-slate-400">Total in the pool</dt><dd className="text-lg font-semibold tabular-nums">{data.totalNotices.toLocaleString()}</dd></div>
        <div className="rounded-lg border border-slate-700 p-3"><dt className="text-slate-400">Requests used today (UTC)</dt><dd className="text-lg font-semibold tabular-nums">{data.requestsUsedToday} of {data.dailyRequests}</dd></div>
      </dl>

      <p className="text-sm text-slate-300">{data.running ? 'A pull is running. This page updates when it finishes.' : progressText(data.progress)}</p>
      {lastPull && <p role={data.lastPull?.ok === false ? 'alert' : undefined} className={`text-sm ${data.lastPull?.ok === false ? 'text-red-400' : 'text-slate-400'}`}>{lastPull}</p>}

      <div className="flex flex-wrap items-center gap-3">
        <label className="text-sm text-slate-300">
          Requests
          <select
            value={chosen}
            onChange={(e) => setRequests(Number(e.target.value))}
            disabled={choices.length === 0 || data.running}
            className="ml-2 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-100"
          >
            {choices.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button
          type="button"
          onClick={() => { setRequests(chosen); pull.mutate() }}
          disabled={pull.isPending || data.running || choices.length === 0 || finished}
          className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-60"
        >
          {data.running ? 'Pulling…' : 'Pull from SAM.gov'}
        </button>
      </div>

      {choices.length === 0 && <p className="text-sm text-slate-400">Today's requests are used up, apart from {data.keptSpare} kept for the daily pull.</p>}
      {message && <p role="alert" className="text-sm text-red-400">{message}</p>}
      <p className="text-xs text-slate-500">{data.keptSpare} requests a day are kept for the automatic pull. The count covers pulls made by this app only, and SAM.gov doesn't report what's really left.</p>
    </div>
  )
}
