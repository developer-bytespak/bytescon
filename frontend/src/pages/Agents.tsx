// =============================================================
// §7.0 — Agent Operations.
//
// One shared surface for all nine agents rather than nine dashboards.
// Five tabs over the /api/agents backend: overview, run history, escalations,
// schedules and notification preferences.
//
// HONESTY RULE enforced throughout: an agent whose handler does not exist yet
// renders NOT IMPLEMENTED and its controls are disabled. Nothing here ever
// shows a "Healthy" state for an agent that cannot run.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Play, Settings2 } from 'lucide-react'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import { useAuth } from '../hooks/useAuth'
import {
  Badge, Disclaimer, EmptyPanel, ErrorPanel, LoadingPanel, TabBar, formatDate,
} from '../components/section6/Section6Ui'
import {
  agentsApi,
  type AgentEscalation, type AgentKey, type AgentNotificationPreferenceRow,
  type AgentOverviewRow, type AgentRunStatus, type AgentRunSummary, type AgentSchedule,
} from '../services/agentsApi'
import { useTabParam } from '../hooks/useTabParam'

type TabKey = 'overview' | 'runs' | 'escalations' | 'schedules' | 'notifications'

const RUN_STATUS_TONE: Record<AgentRunStatus, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  QUEUED: 'neutral',
  RUNNING: 'info',
  WAITING_FOR_REVIEW: 'warning',
  COMPLETED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  TIMED_OUT: 'danger',
  SKIPPED: 'neutral',
}

const SEVERITY_TONE = {
  INFO: 'neutral', LOW: 'info', MEDIUM: 'warning', HIGH: 'warning', CRITICAL: 'danger',
} as const

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } } }
  return e?.response?.data?.error || fallback
}

export default function Agents() {
  const [tab, setTab] = useTabParam(['overview', 'runs', 'escalations', 'schedules', 'notifications'] as const, 'overview')
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-6">
      <PageHeader
        title="Agent Operations"
        subtitle="Shared runtime for the nine Bytescon agents — schedules, runs, artifacts and escalations."
      />

      {!isAdmin && (
        <Disclaimer>
          Your team-member account has read-only access. You can review agent activity, but configuring
          schedules, triggering runs and resolving escalations require a firm admin.
        </Disclaimer>
      )}

      <TabBar
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
        tabs={[
          { key: 'overview', label: 'Overview' },
          { key: 'runs', label: 'Run history' },
          { key: 'escalations', label: 'Escalations' },
          { key: 'schedules', label: 'Schedules' },
          { key: 'notifications', label: 'Notifications' },
        ]}
      />

      {tab === 'overview' && <OverviewTab isAdmin={isAdmin} />}
      {tab === 'runs' && <RunsTab />}
      {tab === 'escalations' && <EscalationsTab isAdmin={isAdmin} />}
      {tab === 'schedules' && <SchedulesTab isAdmin={isAdmin} />}
      {tab === 'notifications' && <NotificationsTab isAdmin={isAdmin} />}
    </div>
  )
}

// -------------------------------------------------------------
// Overview
// -------------------------------------------------------------

function OverviewTab({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast()
  const [rows, setRows] = useState<AgentOverviewRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [triggering, setTriggering] = useState<AgentKey | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRows(await agentsApi.getOverview())
    } catch (err) {
      setError(errorMessage(err, 'Could not load agent overview.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const trigger = async (key: AgentKey) => {
    setTriggering(key)
    try {
      const res = await agentsApi.triggerRun({ agentKey: key })
      toast(res.created ? 'Agent run queued.' : (res.note ?? 'A matching run already exists.'), res.created ? 'success' : 'info')
      await load()
    } catch (err) {
      toast(errorMessage(err, 'Could not trigger this agent.'), 'error')
    } finally {
      setTriggering(null)
    }
  }

  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!rows) return <LoadingPanel label="Loading agents…" />
  if (rows.length === 0) return <EmptyPanel message="No agents are registered." />

  const implementedCount = rows.filter((r) => r.implemented).length

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-500" data-testid="agent-implementation-summary">
        {implementedCount} of {rows.length} agents implemented. The shared runtime is live; each agent
        arrives in its own slice.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {rows.map((row) => (
          <div
            key={row.key}
            data-testid={`agent-card-${row.key}`}
            className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-gray-100">{row.name}</h3>
                <p className="text-[11px] text-gray-500 mt-0.5 leading-snug">{row.description}</p>
              </div>
              {row.implemented ? (
                <Badge tone={row.isEnabled ? 'success' : 'neutral'}>{row.isEnabled ? 'ENABLED' : 'DISABLED'}</Badge>
              ) : (
                <Badge tone="warning" title={`Planned in slice ${row.plannedSlice}`}>NOT IMPLEMENTED</Badge>
              )}
            </div>

            {!row.implemented && (
              <p className="text-[11px] text-amber-500/80">
                Planned in slice {row.plannedSlice}. No handler exists in this build, so it cannot be
                scheduled or run.
              </p>
            )}

            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
              <dt className="text-gray-500">Autonomy</dt>
              <dd className="text-gray-300 font-mono">{row.autonomyLevel}</dd>
              <dt className="text-gray-500">Last run</dt>
              <dd className="text-gray-300">{row.lastRun ? formatDate(row.lastRun.createdAt) : '—'}</dd>
              <dt className="text-gray-500">Last success</dt>
              <dd className="text-gray-300">{formatDate(row.lastSuccessfulRunAt)}</dd>
              <dt className="text-gray-500">Last failure</dt>
              <dd className={row.lastFailureAt ? 'text-red-400' : 'text-gray-300'}>{formatDate(row.lastFailureAt)}</dd>
              <dt className="text-gray-500">Next run</dt>
              <dd className="text-gray-300">{row.implemented ? formatDate(row.nextRunAt) : '—'}</dd>
              <dt className="text-gray-500">Open escalations</dt>
              <dd className={row.openEscalations > 0 ? 'text-orange-300 font-semibold' : 'text-gray-300'}>
                {row.openEscalations}
              </dd>
            </dl>

            {row.lastFailureMessage && (
              <p className="text-[11px] text-red-400/90 bg-red-950/30 border border-red-900/50 rounded p-2">
                {row.lastFailureMessage}
              </p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => void trigger(row.key)}
                disabled={!row.implemented || !isAdmin || triggering === row.key}
                title={
                  !row.implemented ? 'This agent is not implemented yet.'
                    : !isAdmin ? 'Only a firm admin can trigger an agent run.'
                      : 'Run this agent now'
                }
                className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors inline-flex items-center gap-1.5"
              >
                <Play className="w-3 h-3" />
                {triggering === row.key ? 'Queueing…' : 'Run now'}
              </button>
              {row.lastRun && (
                <Link
                  to={`/agents/runs/${row.lastRun.id}`}
                  className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  View last run
                </Link>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// Runs
// -------------------------------------------------------------

function RunsTab() {
  const [data, setData] = useState<{ items: AgentRunSummary[]; total: number; totalPages: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [status, setStatus] = useState('')
  const [agentKey, setAgentKey] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await agentsApi.listRuns({
        page,
        pageSize: 25,
        ...(status ? { status } : {}),
        ...(agentKey ? { agentKey } : {}),
      })
      setData(res)
    } catch (err) {
      setError(errorMessage(err, 'Could not load run history.'))
    }
  }, [page, status, agentKey])

  useEffect(() => { void load() }, [load])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-gray-500">
          <span className="sr-only">Filter by status</span>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1) }}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500"
          >
            <option value="">All statuses</option>
            {(['QUEUED', 'RUNNING', 'WAITING_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'TIMED_OUT', 'SKIPPED'] as const).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-gray-500">
          <span className="sr-only">Filter by agent</span>
          <select
            aria-label="Filter by agent"
            value={agentKey}
            onChange={(e) => { setAgentKey(e.target.value); setPage(1) }}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500"
          >
            <option value="">All agents</option>
            {(['OPPORTUNITY', 'QUALIFICATION', 'COMPLIANCE', 'PROPOSAL', 'PRICING', 'TEAMING', 'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE'] as const).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        </label>
      </div>

      {error ? <ErrorPanel message={error} onRetry={load} />
        : !data ? <LoadingPanel label="Loading runs…" />
          : data.items.length === 0 ? (
            <EmptyPanel
              message="No agent runs yet."
              hint="Runs appear here once an agent is implemented, enabled and scheduled — or triggered manually."
            />
          ) : (
            <>
              <div className="overflow-x-auto border border-gray-800 rounded-xl">
                <table className="w-full text-xs">
                  <thead className="bg-gray-900 text-gray-500">
                    <tr>
                      {['Agent', 'Status', 'Trigger', 'Started', 'Duration', 'Attempt', 'Summary', ''].map((h) => (
                        <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((r) => (
                      <tr key={r.id} data-testid={`run-row-${r.id}`} className="border-t border-gray-800 hover:bg-gray-900/50">
                        <td className="px-3 py-2 text-gray-300 whitespace-nowrap">{r.agentKey}</td>
                        <td className="px-3 py-2"><Badge tone={RUN_STATUS_TONE[r.status]}>{r.status}</Badge></td>
                        <td className="px-3 py-2 text-gray-500">{r.triggerType}</td>
                        <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{formatDate(r.startedAt ?? r.createdAt)}</td>
                        <td className="px-3 py-2 text-gray-500 font-mono">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}</td>
                        <td className="px-3 py-2 text-gray-500 font-mono">{r.attempt}/{r.maxAttempts}</td>
                        <td className="px-3 py-2 text-gray-400 max-w-sm truncate">{r.outputSummary ?? '—'}</td>
                        <td className="px-3 py-2">
                          <Link to={`/agents/runs/${r.id}`} className="text-blue-400 hover:text-blue-300">Detail</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{data.total} run(s)</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                    className="px-3 py-1 rounded bg-gray-800 border border-gray-700 disabled:opacity-40"
                  >Previous</button>
                  <span>Page {page} of {data.totalPages}</span>
                  <button
                    type="button" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}
                    className="px-3 py-1 rounded bg-gray-800 border border-gray-700 disabled:opacity-40"
                  >Next</button>
                </div>
              </div>
            </>
          )}
    </div>
  )
}

// -------------------------------------------------------------
// Escalations
// -------------------------------------------------------------

function EscalationsTab({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast()
  const [items, setItems] = useState<AgentEscalation[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [resolution, setResolution] = useState('')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await agentsApi.listEscalations({ pageSize: 50 })
      setItems(res.items)
    } catch (err) {
      setError(errorMessage(err, 'Could not load escalations.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const acknowledge = async (id: string) => {
    setBusyId(id)
    try {
      await agentsApi.acknowledgeEscalation(id)
      toast('Escalation acknowledged.', 'success')
      await load()
    } catch (err) {
      toast(errorMessage(err, 'Could not acknowledge.'), 'error')
    } finally { setBusyId(null) }
  }

  const resolve = async (id: string) => {
    if (!resolution.trim()) { toast('A resolution note is required.', 'warning'); return }
    setBusyId(id)
    try {
      await agentsApi.resolveEscalation(id, resolution.trim())
      toast('Escalation resolved.', 'success')
      setResolvingId(null); setResolution('')
      await load()
    } catch (err) {
      toast(errorMessage(err, 'Could not resolve.'), 'error')
    } finally { setBusyId(null) }
  }

  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!items) return <LoadingPanel label="Loading escalations…" />
  if (items.length === 0) {
    return <EmptyPanel message="No escalations." hint="Agents raise an escalation when a decision needs human judgement." />
  }

  return (
    <div className="space-y-3">
      {items.map((e) => (
        <div key={e.id} data-testid={`escalation-${e.id}`} className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
              <h3 className="text-sm font-semibold text-gray-100">{e.title}</h3>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={SEVERITY_TONE[e.severity]}>{e.severity}</Badge>
              <Badge tone={e.status === 'OPEN' ? 'warning' : e.status === 'ACKNOWLEDGED' ? 'info' : 'success'}>{e.status}</Badge>
            </div>
          </div>

          <p className="text-xs text-gray-400">{e.reason}</p>
          {e.recommendedAction && (
            <p className="text-xs text-gray-500"><span className="text-gray-600">Recommended: </span>{e.recommendedAction}</p>
          )}
          <p className="text-[11px] text-gray-600 font-mono">{e.agentKey} · raised {formatDate(e.createdAt)}</p>
          {e.resolution && (
            <p className="text-xs text-green-400/90 bg-green-950/20 border border-green-900/40 rounded p-2">
              Resolved: {e.resolution}
            </p>
          )}

          {(e.status === 'OPEN' || e.status === 'ACKNOWLEDGED') && (
            <div className="pt-1 space-y-2">
              {resolvingId === e.id ? (
                <div className="space-y-2">
                  <label className="block">
                    <span className="text-[11px] text-gray-500">Resolution note</span>
                    <textarea
                      aria-label="Resolution note"
                      value={resolution}
                      onChange={(ev) => setResolution(ev.target.value)}
                      rows={2}
                      className="mt-1 w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-xs text-gray-200 outline-none focus:border-blue-500"
                      placeholder="What did you decide, and why?"
                    />
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button" disabled={busyId === e.id} onClick={() => void resolve(e.id)}
                      className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40"
                    >{busyId === e.id ? 'Saving…' : 'Confirm resolve'}</button>
                    <button
                      type="button" onClick={() => { setResolvingId(null); setResolution('') }}
                      className="text-xs text-gray-500 hover:text-gray-300"
                    >Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {e.status === 'OPEN' && (
                    <button
                      type="button" disabled={!isAdmin || busyId === e.id} onClick={() => void acknowledge(e.id)}
                      title={isAdmin ? 'Acknowledge' : 'Only a firm admin can act on escalations.'}
                      className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                    >Acknowledge</button>
                  )}
                  <button
                    type="button" disabled={!isAdmin} onClick={() => setResolvingId(e.id)}
                    title={isAdmin ? 'Resolve' : 'Only a firm admin can act on escalations.'}
                    className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >Resolve</button>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// -------------------------------------------------------------
// Schedules
// -------------------------------------------------------------

function SchedulesTab({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast()
  const [overview, setOverview] = useState<AgentOverviewRow[] | null>(null)
  const [schedules, setSchedules] = useState<AgentSchedule[]>([])
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<AgentKey | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [ov, sc] = await Promise.all([agentsApi.getOverview(), agentsApi.listSchedules()])
      setOverview(ov); setSchedules(sc)
    } catch (err) {
      setError(errorMessage(err, 'Could not load schedules.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async (key: AgentKey, patch: Partial<AgentSchedule>) => {
    setSavingKey(key)
    try {
      await agentsApi.saveSchedule(key, patch)
      toast('Schedule saved.', 'success')
      await load()
    } catch (err) {
      toast(errorMessage(err, 'Could not save the schedule.'), 'error')
    } finally { setSavingKey(null) }
  }

  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!overview) return <LoadingPanel label="Loading schedules…" />

  const byKey = new Map(schedules.map((s) => [s.agentKey, s]))

  return (
    <div className="space-y-3">
      <Disclaimer>
        Every agent defaults to <span className="font-mono">PROPOSE</span>: it may compute, save artifacts
        and raise escalations, but never silently changes verified business records.
      </Disclaimer>

      {overview.map((row) => {
        const s = byKey.get(row.key)
        const disabled = !row.implemented || !isAdmin || savingKey === row.key
        return (
          <div key={row.key} data-testid={`schedule-${row.key}`} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4 text-gray-500" />
                  <h3 className="text-sm font-semibold text-gray-100">{row.name}</h3>
                  {!row.implemented && <Badge tone="warning">NOT IMPLEMENTED</Badge>}
                </div>
                <p className="text-[11px] text-gray-500 mt-1 font-mono">
                  {s?.cronExpression ?? row.cronExpression ?? 'no schedule'} · {s?.timezone ?? 'UTC'} ·
                  autonomy {s?.autonomyLevel ?? row.autonomyLevel}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <select
                  aria-label={`Autonomy level for ${row.name}`}
                  value={s?.autonomyLevel ?? row.autonomyLevel}
                  disabled={disabled}
                  onChange={(e) => void save(row.key, { autonomyLevel: e.target.value as AgentSchedule['autonomyLevel'] })}
                  className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500 disabled:opacity-40"
                >
                  <option value="OBSERVE">OBSERVE</option>
                  <option value="PROPOSE">PROPOSE</option>
                  <option value="ACT_WITH_GUARDRAILS">ACT_WITH_GUARDRAILS</option>
                </select>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void save(row.key, { isEnabled: !(s?.isEnabled ?? false) })}
                  title={
                    !row.implemented ? `Planned in slice ${row.plannedSlice} — cannot be enabled.`
                      : !isAdmin ? 'Only a firm admin can change schedules.' : undefined
                  }
                  className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {savingKey === row.key ? 'Saving…' : s?.isEnabled ? 'Disable' : 'Enable'}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// -------------------------------------------------------------
// Notification preferences
// -------------------------------------------------------------

function NotificationsTab({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast()
  const [rows, setRows] = useState<AgentNotificationPreferenceRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savingKey, setSavingKey] = useState<AgentKey | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setRows(await agentsApi.getNotificationPreferences())
    } catch (err) {
      setError(errorMessage(err, 'Could not load notification preferences.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const save = async (key: AgentKey, patch: Partial<AgentNotificationPreferenceRow>) => {
    setSavingKey(key)
    try {
      await agentsApi.saveNotificationPreference(key, patch)
      toast('Preference saved.', 'success')
      await load()
    } catch (err) {
      toast(errorMessage(err, 'Could not save the preference.'), 'error')
    } finally { setSavingKey(null) }
  }

  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!rows) return <LoadingPanel label="Loading preferences…" />

  return (
    <div className="space-y-3">
      {!isAdmin && (
        <Disclaimer>
          Saving a preference is a write, and team-member accounts are read-only platform-wide. Your
          effective defaults are shown below; ask a firm admin to change them.
        </Disclaimer>
      )}

      <div className="overflow-x-auto border border-gray-800 rounded-xl">
        <table className="w-full text-xs">
          <thead className="bg-gray-900 text-gray-500">
            <tr>
              {['Agent', 'In-app', 'On success', 'On failure', 'On escalation', 'Min severity'].map((h) => (
                <th key={h} className="text-left font-medium px-3 py-2 whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.agentKey} data-testid={`pref-${r.agentKey}`} className="border-t border-gray-800">
                <td className="px-3 py-2 text-gray-300 whitespace-nowrap">
                  {r.agentName}
                  {!r.isExplicit && <span className="ml-2 text-[10px] text-gray-600">(default)</span>}
                </td>
                {([
                  ['inAppEnabled', 'In-app notifications'],
                  ['notifyOnSuccess', 'Notify on success'],
                  ['notifyOnFailure', 'Notify on failure'],
                  ['notifyOnEscalation', 'Notify on escalation'],
                ] as const).map(([field, label]) => (
                  <td key={field} className="px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={`${label} for ${r.agentName}`}
                      checked={r[field]}
                      disabled={!isAdmin || savingKey === r.agentKey}
                      onChange={(e) => void save(r.agentKey, { [field]: e.target.checked })}
                      className="accent-blue-500 disabled:opacity-40"
                    />
                  </td>
                ))}
                <td className="px-3 py-2">
                  <select
                    aria-label={`Minimum severity for ${r.agentName}`}
                    value={r.minimumSeverity}
                    disabled={!isAdmin || savingKey === r.agentKey}
                    onChange={(e) => void save(r.agentKey, { minimumSeverity: e.target.value as AgentNotificationPreferenceRow['minimumSeverity'] })}
                    className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-blue-500 disabled:opacity-40"
                  >
                    {(['INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
