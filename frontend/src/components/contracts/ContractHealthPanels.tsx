// =============================================================
// §7.1 — Contract Administration health surfaces.
//
// Two panels mounted into the EXISTING contract pages rather than a separate
// application: a portfolio roll-up for /contracts and a detail panel for
// /contracts/:id.
//
// Every number rendered here comes from the backend artifact. Nothing is
// recalculated client-side, an unassessed contract is shown as "not assessed"
// rather than healthy, and a derived option date is always labelled as an
// internal recommendation.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Bot, CalendarClock, RefreshCw } from 'lucide-react'
import { Badge, Disclaimer, EmptyPanel, ErrorPanel, LoadingPanel, formatDate } from '../section6/Section6Ui'
import {
  contractHealthApi,
  type ContractHealthDetail,
  type ContractHealthPortfolio,
  type ContractHealthState,
} from '../../services/contractHealthApi'
import { humanize } from '../../lib/humanize'

const HEALTH_TONE: Record<ContractHealthState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  HEALTHY: 'success',
  ATTENTION: 'warning',
  CRITICAL: 'danger',
  INSUFFICIENT_DATA: 'neutral',
}

function errorMessage(err: unknown, fallback: string): string {
  const e = err as { response?: { data?: { error?: string } } }
  return e?.response?.data?.error || fallback
}

function HealthBadge({ health }: { health: ContractHealthState | null }) {
  if (!health) return <Badge tone="neutral">Not assessed</Badge>
  return <Badge tone={HEALTH_TONE[health]}>{humanize(health)}</Badge>
}

// -------------------------------------------------------------
// Portfolio roll-up — mounted on /contracts
// -------------------------------------------------------------

export function ContractPortfolioHealth() {
  const [data, setData] = useState<ContractHealthPortfolio | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await contractHealthApi.getPortfolio())
    } catch (err) {
      setError(errorMessage(err, 'Could not load contract health.'))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!data) return <LoadingPanel label="Loading contract health…" />

  const t = data.totals
  const notConfigured = !data.schedule?.isEnabled

  return (
    <section data-testid="contract-portfolio-health" className="v3-surface space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-gray-500" />
          <h2 className="v3-h3 text-gray-100">Contract Administration Agent</h2>
          <Badge tone={data.schedule?.isEnabled ? 'success' : 'neutral'}>
            {data.schedule?.isEnabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          {data.lastRun && (
            <Link to={`/agents/runs/${data.lastRun.id}`} className="hover:text-gray-300 transition-colors">
              Last run {formatDate(data.lastRun.createdAt)} · {humanize(data.lastRun.status)}
            </Link>
          )}
          <button
            type="button" onClick={() => void refresh()} disabled={refreshing}
            className="btn-secondary btn-sm"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {notConfigured && (
        <Disclaimer>
          The Contract Administration Agent is not enabled for this firm. Health below reflects the last
          run, if any. A firm admin can enable a daily schedule from Agent operations.
        </Disclaimer>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        <Kpi label="Monitored" value={t.monitoredContracts} />
        <Kpi label="Healthy" value={t.HEALTHY} />
        <Kpi label="Attention" value={t.ATTENTION} tone={t.ATTENTION ? 'text-amber-300' : undefined} />
        <Kpi label="Critical" value={t.CRITICAL} tone={t.CRITICAL ? 'text-red-400' : undefined} />
        <Kpi label="Overdue deliverables" value={t.overdueDeliverables} tone={t.overdueDeliverables ? 'text-red-400' : undefined} />
        <Kpi label="Option decisions" value={t.openOptionWindows} tone={t.openOptionWindows ? 'text-amber-300' : undefined} />
        <Kpi label="Open escalations" value={t.openEscalations} tone={t.openEscalations ? 'text-amber-300' : undefined} />
      </div>

      {t.monitoredContracts === 0 ? (
        <EmptyPanel message="No active contracts are being monitored." hint="Contracts with status Active or On hold are monitored by this agent." />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table w-full text-[13px]">
            <thead>
              <tr>
                {['Contract', 'Health', 'Deliverables', 'Funding', 'Options', 'Period of performance', 'Assessed'].map((h) => (
                  <th key={h} className="text-left px-3 py-2 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.contracts.map((c) => (
                <tr key={c.contractId} data-testid={`health-row-${c.contractId}`} >
                  <td className="px-3 py-2">
                    <Link to={`/contracts/${c.contractId}`} className="text-gray-100 font-medium hover:underline">
                      {c.contractNumber}
                    </Link>
                    <div className="text-gray-500 truncate max-w-[16rem]">{c.title}</div>
                  </td>
                  <td className="px-3 py-2"><HealthBadge health={c.health} /></td>
                  <td className="px-3 py-2 text-gray-400">
                    {c.overdueDeliverables > 0 && <span className="text-red-400">{c.overdueDeliverables} overdue</span>}
                    {c.overdueDeliverables > 0 && c.dueSoonDeliverables > 0 && ' · '}
                    {c.dueSoonDeliverables > 0 && <span className="text-amber-300">{c.dueSoonDeliverables} due soon</span>}
                    {c.overdueDeliverables === 0 && c.dueSoonDeliverables === 0 && <span className="text-gray-500">—</span>}
                  </td>
                  <td className="px-3 py-2 tabular-nums text-gray-400">
                    {c.fundedRemaining ? `$${c.fundedRemaining} funded left` : <span className="text-gray-500">—</span>}
                    {c.fundingThresholdState && c.fundingThresholdState !== 'OK' && c.fundingThresholdState !== 'INSUFFICIENT_DATA' && (
                      <div className="text-xs text-amber-300">{humanize(c.fundingThresholdState)}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-gray-400">{c.openOptionWindows > 0 ? `${c.openOptionWindows} open` : <span className="text-gray-500">—</span>}</td>
                  <td className="px-3 py-2 text-gray-400">
                    {c.popState ? humanize(c.popState) : <span className="text-gray-500">—</span>}
                    {c.popDaysRemaining != null && <span className="text-gray-500"> · {c.popDaysRemaining}d</span>}
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                    {c.assessedAt ? formatDate(c.assessedAt) : <span className="text-gray-500">not assessed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="panel p-4">
      <div className={`text-[28px] leading-8 font-semibold tabular-nums ${tone ?? 'text-gray-100'}`}>{value}</div>
      <div className="text-[13px] text-gray-400 mt-1">{label}</div>
    </div>
  )
}

// -------------------------------------------------------------
// Detail panel — mounted on /contracts/:id
// -------------------------------------------------------------

export function ContractHealthPanel({ contractId }: { contractId: string }) {
  const [data, setData] = useState<ContractHealthDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await contractHealthApi.getContract(contractId))
    } catch (err) {
      setError(errorMessage(err, 'Could not load contract health.'))
    }
  }, [contractId])

  useEffect(() => { void load() }, [load])

  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!data) return <LoadingPanel label="Loading contract health…" />

  if (!data.health) {
    return (
      <section data-testid="contract-health-panel" className="space-y-3">
        <EmptyPanel
          message="This contract has not been assessed yet."
          hint="Enable the Contract Administration Agent, or trigger a run for this contract from Agent operations."
        />
      </section>
    )
  }

  const h = data.health
  const f = h.funding

  return (
    <section data-testid="contract-health-panel" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-gray-500" />
          <h2 className="v3-h3 text-gray-100">Contract health</h2>
          <HealthBadge health={h.overallHealth} />
        </div>
        <div className="text-xs text-gray-400">
          Assessed {formatDate(h.assessedAt)}
          {data.lastRun && (
            <>
              {' · '}
              <Link to={`/agents/runs/${data.lastRun.id}`} className="text-gray-100 underline">
                view agent run
              </Link>
            </>
          )}
        </div>
      </div>

      {h.summary && <p className="text-xs text-gray-400">{h.summary}</p>}

      {/* Funding — funded remaining and ceiling remaining are always distinct. */}
      <div className="panel p-4 space-y-3">
        <h3 className="text-[15px] font-semibold text-gray-100">Funding &amp; burn</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <Figure label="Funded (obligated)" value={`$${f.funded}`} />
          <Figure label="Expended (approved)" value={`$${f.expended}`} />
          <Figure label="Funded remaining" value={`$${f.fundedRemaining}`} highlight />
          <Figure label="Ceiling remaining" value={f.ceilingRemaining ? `$${f.ceilingRemaining}` : 'Not recorded'} highlight />
          <Figure label="Contract ceiling" value={f.ceiling ? `$${f.ceiling}` : 'Not recorded'} />
          <Figure label="Burn / day" value={f.burnRatePerDay ? `$${f.burnRatePerDay}` : 'Not available'} />
          <Figure label="Observation window" value={f.observationDays != null ? `${f.observationDays} day(s)` : '—'} />
          <Figure
            label="Projected funding exhaustion"
            value={f.projectedFundingExhaustion ? formatDate(f.projectedFundingExhaustion) : 'Not available'}
          />
        </div>

        {f.thresholdState !== 'OK' && f.thresholdState !== 'INSUFFICIENT_DATA' && (
          <p className="text-xs text-amber-300 rounded-xl p-2" style={{ background: 'var(--warning-bg)' }}>
            {f.thresholdState.replace(/_/g, ' ')}
          </p>
        )}

        {f.insufficientData && f.reasons.length > 0 && (
          <div data-testid="burn-insufficient-data" className="text-xs text-gray-400 bg-gray-900 rounded-xl p-3 space-y-1">
            <p className="text-gray-400">No burn projection is shown, because:</p>
            <ul className="list-disc list-inside">
              {f.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          </div>
        )}
      </div>

      {/* Deliverables */}
      <div className="panel p-4 space-y-3">
        <h3 className="text-[15px] font-semibold text-gray-100">
          Deliverables · {h.deliverables.overdue} overdue · {h.deliverables.dueSoon} due soon · {h.deliverables.awaitingReview} awaiting review
        </h3>
        {h.deliverables.openItems.length === 0 ? (
          <p className="text-xs text-gray-400">No deliverables need attention.</p>
        ) : (
          <ul className="space-y-1.5">
            {h.deliverables.openItems.map((d) => (
              <li key={d.id} data-testid={`health-deliverable-${d.id}`} className="flex items-center justify-between gap-3 text-xs">
                <span className="text-gray-300 truncate">
                  {d.name}
                  {d.cdrlNumber && <span className="text-gray-500"> · {d.cdrlNumber}</span>}
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  <span className="text-gray-500">{formatDate(d.dueDate)}</span>
                  <Badge tone={d.isOverdue ? 'danger' : 'warning'}>{humanize(d.derivedStatus)}</Badge>
                  {d.reminderLevel && <Badge tone="neutral">{humanize(d.reminderLevel)}</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Options */}
      {h.options.upcomingDecisionWindows.length > 0 && (
        <div className="panel p-4 space-y-2">
          <h3 className="text-[15px] font-semibold text-gray-100 flex items-center gap-2">
            <CalendarClock className="w-3.5 h-3.5 text-gray-500" /> Option decisions
          </h3>
          {h.options.upcomingDecisionWindows.map((o) => (
            <div key={o.optionPeriodId} data-testid={`option-window-${o.optionPeriodId}`} className="text-xs space-y-1 border-t pt-2 first:border-0 first:pt-0" style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-300">{o.label}</span>
                <div className="flex items-center gap-2">
                  <Badge tone={o.state === 'OPEN' || o.state === 'PAST' ? 'warning' : 'neutral'}>{humanize(o.state)}</Badge>
                  {!o.ownerUserId && (o.state === 'OPEN' || o.state === 'PAST') && <Badge tone="danger">No owner</Badge>}
                </div>
              </div>
              <p className="text-gray-500">
                {o.effectiveDecisionDate ? formatDate(o.effectiveDecisionDate) : 'No usable decision date'}
                {o.workingDaysUntilDecision != null && ` · ${o.workingDaysUntilDecision} working day(s)`}
              </p>
              {o.isInternalRecommendation && (
                <p className="text-xs text-amber-300">
                  Internal recommendation, derived from the option start date. This is not a government or
                  contractual deadline.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Period of performance */}
      <div className="panel p-4">
        <h3 className="text-[15px] font-semibold text-gray-100 mb-2">Period of performance</h3>
        <div className="flex items-center gap-3 text-xs">
          <Badge tone={h.periodOfPerformance.state === 'ACTIVE' ? 'success' : h.periodOfPerformance.state === 'EXPIRED' ? 'danger' : 'warning'}>
            {humanize(h.periodOfPerformance.state)}
          </Badge>
          <span className="text-gray-500">
            {formatDate(h.periodOfPerformance.startDate)} to {formatDate(h.periodOfPerformance.endDate)}
            {h.periodOfPerformance.daysRemaining != null && ` · ${h.periodOfPerformance.daysRemaining} day(s) remaining`}
          </span>
        </div>
      </div>

      {/* Modification impacts */}
      {h.modifications.unresolvedImpacts.length > 0 && (
        <div className="panel p-4 space-y-2">
          <h3 className="text-[15px] font-semibold text-gray-100">Unapplied modifications</h3>
          <p className="text-xs text-gray-400">
            The agent reports the impact these would have. It never applies a modification — that stays a
            human action.
          </p>
          {h.modifications.recent.filter((m) => m.isUnresolved).map((m) => (
            <div key={m.modificationId} className="text-xs text-gray-400 border-t pt-2 first:border-0 first:pt-0" style={{ borderColor: 'var(--line)' }}>
              <span className="text-gray-200 font-medium">{m.modNumber}</span> · {humanize(m.status)}
              {m.fundingChange && <span className="text-gray-500"> · funding {m.fundingChange}</span>}
              {m.projectedFundedValue && <span className="text-gray-500"> · projected funded ${m.projectedFundedValue}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Escalations */}
      {data.escalations.length > 0 && (
        <div className="panel p-4 space-y-2">
          <h3 className="text-[15px] font-semibold text-gray-100 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-300" /> Open escalations
          </h3>
          {data.escalations.map((e) => (
            <div key={e.id} data-testid={`health-escalation-${e.id}`} className="text-xs border-t pt-2 first:border-0 first:pt-0" style={{ borderColor: 'var(--line)' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-gray-300">{e.title}</span>
                <Badge tone="warning">{humanize(e.severity)}</Badge>
              </div>
              <p className="text-xs text-gray-400 mt-0.5">{e.reason}</p>
            </div>
          ))}
          <Link to="/agents" className="inline-block text-[11px] text-blue-400 hover:text-blue-300">
            Manage in Agent operations
          </Link>
        </div>
      )}

      {h.dataLimitations.length > 0 && (
        <div className="text-xs text-gray-400 panel p-3">
          <p className="text-gray-400 mb-1">What this assessment could not determine:</p>
          <ul className="list-disc list-inside space-y-0.5">
            {h.dataLimitations.map((l, i) => <li key={i}>{l}</li>)}
          </ul>
        </div>
      )}
    </section>
  )
}

function Figure({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div>
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`tabular-nums font-medium ${highlight ? 'text-gray-100' : 'text-gray-300'}`}>{value}</div>
    </div>
  )
}
