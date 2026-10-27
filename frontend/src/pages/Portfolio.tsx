// =============================================================
// §6.2G / §6.2B — Portfolio expected value + calibration status.
//
// Every number on this page is computed server-side. React renders what the
// backend returned and never re-derives an expected value, a rate or an
// interval — that is the §6 rule about authoritative calculations.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Download, RefreshCw, TrendingUp } from 'lucide-react'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import {
  Badge, Disclaimer, EligibilityBadge, EmptyPanel, ErrorPanel,
  LoadingPanel, TabBar, formatDate, formatMoney,
} from '../components/section6/Section6Ui'
import { scoringApi, type CalibrationStatus, type PortfolioSummary } from '../services/section6Api'
import { CaptureIntelligencePanel } from '../components/section7/IntelligenceAgentPanels'
import { useTabParam } from '../hooks/useTabParam'

type TabKey = 'value' | 'breakdown' | 'risk' | 'calibration' | 'intelligence'

export default function Portfolio() {
  const [tab, setTab] = useTabParam(['value', 'breakdown', 'risk', 'calibration', 'intelligence'] as const, 'value')
  const [portfolio, setPortfolio] = useState<PortfolioSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [agency, setAgency] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setPortfolio(await scoringApi.getPortfolio(agency ? { agency } : undefined))
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load the portfolio.')
    } finally {
      setLoading(false)
    }
  }, [agency])

  useEffect(() => { void load() }, [load])

  const exportCsv = () => {
    const base = import.meta.env.VITE_API_URL || 'http://localhost:3001'
    window.open(`${base}/api/scoring-intel/portfolio/export${agency ? `?agency=${encodeURIComponent(agency)}` : ''}`, '_blank')
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <PageHeader
        title="Portfolio Expected Value"
        subtitle="Weighted pipeline value across active pursuits, with the confidence interval and every exclusion stated."
      >
        <input
          value={agency}
          onChange={(e) => setAgency(e.target.value)}
          placeholder="Filter by agency"
          aria-label="Filter by agency"
          className="input !py-1.5 !text-xs !w-auto min-w-0 flex-1 sm:flex-none sm:w-48"
        />
        <button onClick={load} className="btn-secondary btn-sm inline-flex items-center gap-1.5">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
        <button onClick={exportCsv} className="btn-secondary btn-sm inline-flex items-center gap-1.5">
          <Download className="w-3 h-3" /> Export CSV
        </button>
      </PageHeader>

      <TabBar
        tabs={[
          { key: 'value', label: 'Expected value' },
          { key: 'breakdown', label: 'Breakdown' },
          { key: 'risk', label: 'Risk & capacity' },
          { key: 'calibration', label: 'Calibration' },
          { key: 'intelligence', label: 'Capture intelligence' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as TabKey)}
      />

      <div className="mt-6">
        {tab === 'intelligence' ? (
          <div data-testid="portfolio-intelligence-tab"><CaptureIntelligencePanel /></div>
        ) : tab === 'calibration' ? (
          <CalibrationPanel />
        ) : loading ? (
          <LoadingPanel label="Computing portfolio…" />
        ) : error ? (
          <ErrorPanel message={error} onRetry={load} />
        ) : !portfolio || portfolio.activeOpportunityCount === 0 ? (
          <EmptyPanel
            message="No active pursuits could be valued."
            hint="An opportunity needs both a value and a scored win probability to contribute to expected value."
          />
        ) : tab === 'value' ? (
          <ValuePanel portfolio={portfolio} />
        ) : tab === 'breakdown' ? (
          <BreakdownPanel portfolio={portfolio} />
        ) : (
          <RiskPanel portfolio={portfolio} />
        )}
      </div>
    </div>
  )
}

function ValuePanel({ portfolio }: { portfolio: PortfolioSummary }) {
  return (
    <div className="space-y-6">
      <div className="stagger grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label="Active opportunities" value={String(portfolio.activeOpportunityCount)} />
        <Kpi label="Total nominal value" value={formatMoney(portfolio.totalNominalValue)} />
        <Kpi label="Weighted expected value" value={formatMoney(portfolio.weightedExpectedValue)} highlight />
        <Kpi
          label="Expected value range"
          value={
            portfolio.lowerExpectedValue === null
              ? 'Not available'
              : `${formatMoney(portfolio.lowerExpectedValue)} – ${formatMoney(portfolio.upperExpectedValue)}`
          }
        />
      </div>

      {portfolio.intervalPartial && (
        <div className="rounded-xl p-3 animate-fade-in" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-gray-300">
              Some pursuits have too few verified outcomes to support a confidence interval, so the range above covers only
              those that do. It is not a range over the whole portfolio.
            </p>
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-gray-200 mb-3">Pursuits</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th className="text-left">Opportunity</th>
                <th className="text-left">Agency</th>
                <th className="!text-right">Value</th>
                <th className="text-left">Value source</th>
                <th className="!text-right">Win prob.</th>
                <th className="!text-right">Expected value</th>
                <th className="text-left">Eligibility</th>
                <th className="!text-right">Deadline</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.rows.map((row) => (
                <tr key={row.opportunityId}>
                  <td>
                    <Link to={`/opportunities/${row.opportunityId}`} className="font-medium text-gray-200 hover:text-blue-400">{row.title}</Link>
                  </td>
                  <td className="text-gray-400">{row.agency}</td>
                  <td className="text-right font-mono tabular-nums text-gray-200 whitespace-nowrap">{formatMoney(row.value)}</td>
                  <td>
                    <Badge tone="neutral" title={`Value type: ${row.valueType}`}>{row.valueSource.replace(/_/g, ' ')}</Badge>
                  </td>
                  <td className="text-right font-mono tabular-nums text-gray-200 whitespace-nowrap">
                    {Math.round(row.probability * 100)}%
                    {row.intervalAvailable && row.probabilityLower !== null && (
                      <span className="block text-[10px] text-gray-600">
                        {Math.round(row.probabilityLower * 100)}–{Math.round((row.probabilityUpper ?? 0) * 100)}%
                      </span>
                    )}
                  </td>
                  <td className="text-right font-mono tabular-nums text-gray-100 font-semibold whitespace-nowrap">{formatMoney(row.expectedValue)}</td>
                  <td>{row.eligibility ? <EligibilityBadge state={row.eligibility} /> : <Badge tone="neutral">—</Badge>}</td>
                  <td className="text-right text-gray-400 font-mono tabular-nums whitespace-nowrap">{formatDate(row.responseDeadline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {portfolio.exclusions.length > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-200 mb-3">
            Excluded from expected value ({portfolio.exclusions.length})
          </h3>
          <p className="text-[11px] text-gray-500 mb-2">
            These pursuits are excluded rather than counted as zero, so the totals above are not silently understated.
          </p>
          <ul className="space-y-1">
            {portfolio.exclusions.map((exclusion) => (
              <li key={exclusion.opportunityId} className="text-[11px] text-gray-400">
                <Link to={`/opportunities/${exclusion.opportunityId}`} className="text-gray-300 hover:text-blue-400">{exclusion.title}</Link>
                <span className="text-gray-600"> — {exclusion.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">How value is chosen</h3>
        <ol className="space-y-1">
          {portfolio.valueHierarchy.map((entry, index) => (
            <li key={entry.key} className="text-[11px] text-gray-500">
              {index + 1}. <span className="text-gray-300">{entry.description}</span>{' '}
              <Badge tone="neutral">{entry.type}</Badge>
            </li>
          ))}
        </ol>
        <Disclaimer>
          Expected value = opportunity value × final win probability. Value types are reported separately because ceiling,
          funded, estimated and forecast values are not interchangeable.
        </Disclaimer>
      </div>
    </div>
  )
}

function BreakdownPanel({ portfolio }: { portfolio: PortfolioSummary }) {
  const groups: Array<[string, PortfolioSummary['byAgency']]> = [
    ['By agency', portfolio.byAgency],
    ['By NAICS', portfolio.byNaics],
    ['By pipeline stage', portfolio.byPipelineStage],
    ['By owner', portfolio.byOwner],
    ['By quarter', portfolio.byPeriod],
  ]
  return (
    <div className="space-y-6">
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">By value type</h3>
        <div className="stagger grid grid-cols-2 md:grid-cols-4 gap-3">
          {Object.entries(portfolio.byValueType).map(([type, stats]) => (
            <div key={type} className="panel p-3">
              <div className="overline">{type}</div>
              <div className="text-sm font-mono tabular-nums text-gray-100 mt-1">{formatMoney(stats.expected)}</div>
              <div className="text-[11px] text-gray-600">{stats.count} pursuit(s) · {formatMoney(stats.nominal)} nominal</div>
            </div>
          ))}
        </div>
      </div>

      {groups.map(([title, rows]) => (
        <div key={title} className="card">
          <h3 className="text-sm font-semibold text-gray-200 mb-3">{title}</h3>
          {rows.length === 0 ? (
            <p className="text-[11px] text-gray-600">Nothing to group.</p>
          ) : (
            <div className="space-y-1.5">
              {rows.slice(0, 12).map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-3 text-xs py-1 border-b border-gray-800 last:border-0">
                  <span className="text-gray-300 truncate min-w-0">{row.key}</span>
                  <span className="flex items-center gap-3 flex-shrink-0">
                    <span className="text-gray-600 tabular-nums">{row.count}</span>
                    <span className="font-mono tabular-nums text-gray-100 w-20 text-right">{formatMoney(row.expected)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function RiskPanel({ portfolio }: { portfolio: PortfolioSummary }) {
  return (
    <div className="space-y-6">
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">Concentration</h3>
        <div className="stagger grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
          <Kpi label="Agency HHI" value={portfolio.concentration.agencyHhi === null ? 'N/A' : portfolio.concentration.agencyHhi.toFixed(3)} />
          <Kpi label="NAICS HHI" value={portfolio.concentration.naicsHhi === null ? 'N/A' : portfolio.concentration.naicsHhi.toFixed(3)} />
          <Kpi label="Largest agency share" value={portfolio.concentration.topAgencyShare === null ? 'N/A' : `${(portfolio.concentration.topAgencyShare * 100).toFixed(0)}%`} />
        </div>
        <p className="text-[11px] text-gray-500">{portfolio.concentration.interpretation}</p>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">High value, high uncertainty</h3>
        {portfolio.highValueHighUncertainty.length === 0 ? (
          <p className="text-[11px] text-gray-600">No high-value pursuit currently carries a wide or missing probability band.</p>
        ) : (
          <div className="space-y-2">
            {portfolio.highValueHighUncertainty.map((row) => (
              <div key={row.opportunityId} className="flex items-center justify-between gap-3">
                <Link to={`/opportunities/${row.opportunityId}`} className="text-xs text-gray-200 hover:text-blue-400 truncate">{row.title}</Link>
                <span className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-xs font-mono tabular-nums text-gray-300">{formatMoney(row.value)}</span>
                  {row.intervalAvailable ? (
                    <Badge tone="warning">
                      {Math.round((row.probabilityLower ?? 0) * 100)}–{Math.round((row.probabilityUpper ?? 0) * 100)}%
                    </Badge>
                  ) : (
                    <Badge tone="neutral">No interval</Badge>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">Capacity conflicts</h3>
        {portfolio.capacityConflicts.length === 0 ? (
          <p className="text-[11px] text-gray-600">No week has an unusual cluster of deadlines.</p>
        ) : (
          <div className="space-y-2">
            {portfolio.capacityConflicts.map((conflict) => (
              <div key={conflict.date} className="flex items-center gap-3 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-gray-300">Week of {conflict.date}</span>
                <span className="text-gray-500">{conflict.count} deadlines land in the same week</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">Upcoming deadlines</h3>
        {portfolio.upcomingDeadlines.length === 0 ? (
          <p className="text-[11px] text-gray-600">No upcoming deadlines in the valued pipeline.</p>
        ) : (
          <div className="space-y-1.5">
            {portfolio.upcomingDeadlines.map((deadline) => (
              <div key={deadline.opportunityId} className="flex items-center justify-between gap-3 text-xs">
                <Link to={`/opportunities/${deadline.opportunityId}`} className="text-gray-300 hover:text-blue-400 truncate">{deadline.title}</Link>
                <span className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-gray-500 font-mono tabular-nums">{formatDate(deadline.responseDeadline)}</span>
                  <Badge tone={deadline.daysRemaining <= 7 ? 'danger' : deadline.daysRemaining <= 21 ? 'warning' : 'neutral'}>
                    {deadline.daysRemaining}d
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function CalibrationPanel() {
  const { toast } = useToast()
  const [status, setStatus] = useState<CalibrationStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await scoringApi.getCalibration())
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load calibration status.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const fit = async () => {
    setWorking(true)
    try {
      const result = await scoringApi.fitCalibration()
      toast(result.reason, result.activated ? 'success' : 'warning')
      await load()
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      toast(e?.response?.status === 403 ? 'Only a firm admin can fit a calibration.' : e?.response?.data?.error || 'Fit failed.', 'error')
    } finally {
      setWorking(false)
    }
  }

  const rollback = async () => {
    setWorking(true)
    try {
      const result = await scoringApi.rollbackCalibration()
      toast(result.reason, 'success')
      await load()
    } catch {
      toast('Only a firm admin can roll back a calibration.', 'error')
    } finally {
      setWorking(false)
    }
  }

  if (loading) return <LoadingPanel label="Loading calibration status…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!status) return null

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex flex-wrap items-center gap-2.5 mb-2">
              <span className="tile tile-sm tile-accent"><TrendingUp className="w-4 h-4" /></span>
              <h3 className="text-sm font-semibold text-gray-200">Firm-specific calibration</h3>
              <Badge tone={status.featureEnabled ? 'success' : 'neutral'}>
                {status.featureEnabled ? 'Enabled' : 'Disabled platform-wide'}
              </Badge>
            </div>
            <p className="text-[11px] text-gray-500 max-w-2xl">{status.note}</p>
          </div>
          <div className="flex gap-2">
            <button onClick={fit} disabled={working}
              className="btn-primary btn-sm disabled:opacity-50">
              {working ? 'Working…' : 'Fit calibration'}
            </button>
            {status.active && (
              <button onClick={rollback} disabled={working}
                className="btn-secondary btn-sm disabled:opacity-50">
                Roll back
              </button>
            )}
          </div>
        </div>

        <div className="stagger grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <Kpi label="Verified outcomes" value={String(status.verifiedSampleCount)} />
          <Kpi label="Active version" value={status.active ? `v${status.active.version}` : 'None'} />
          <Kpi label="Brier (calibrated)" value={status.active?.brierScore?.toFixed(4) ?? 'N/A'} />
          <Kpi label="Brier (baseline)" value={status.active?.baselineBrierScore?.toFixed(4) ?? 'N/A'} />
        </div>

        {status.active?.isStale && (
          <div className="mt-3 rounded-lg p-3" style={{ background: 'var(--warning-bg)', border: '1px solid var(--warning-border)' }}>
            <p className="text-[11px] text-gray-300">
              This calibration is past its staleness window and is no longer being applied. Scores have reverted to
              uncalibrated until it is refitted.
            </p>
          </div>
        )}
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-200 mb-3">Version history</h3>
        {status.versions.length === 0 ? (
          <p className="text-[11px] text-gray-600">
            No calibration has been attempted yet. A firm-specific model needs verified win/loss outcomes on real pursuits.
          </p>
        ) : (
          <div className="space-y-2">
            {status.versions.map((version) => (
              <div key={version.id} className="panel p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-mono text-gray-200">v{version.version}</span>
                  <Badge tone={version.state === 'ACTIVE' ? 'success' : version.state === 'REJECTED' ? 'danger' : 'neutral'}>
                    {version.state}
                  </Badge>
                  <span className="text-[11px] text-gray-500">
                    n = {version.sampleSize} · holdout {version.holdoutSize}
                  </span>
                  {version.improvement !== null && (
                    <span className="text-[11px] text-gray-500">Δ Brier {version.improvement.toFixed(4)}</span>
                  )}
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  {version.activationReason ?? version.rejectionReason ?? 'Evaluated.'}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      <Disclaimer>
        A calibration is only activated when it beats the uncalibrated baseline on held-out data. Being able to fit a curve
        is not, on its own, a reason to apply one.
      </Disclaimer>
    </div>
  )
}

function Kpi({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`card stat-card !p-4 min-w-0${highlight ? ' card-accent' : ''}`}>
      <div className="text-[12px] font-medium" style={{ color: highlight ? 'var(--accent-3)' : 'var(--text-muted)' }}>{label}</div>
      <div className="text-lg sm:text-xl font-semibold tabular-nums mt-2 break-words" style={{ color: 'var(--text)' }}>{value}</div>
    </div>
  )
}
