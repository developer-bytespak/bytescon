// =============================================================
// §7.8 — Finance Agent panels.
//
// Three panels, hosted on the pages that already own their subject rather than
// in a new finance dashboard:
//   · DcaaReadinessPanel   → /timekeeping
//   · CashFlowPanel        → /analytics
//   · RateVariancePanel    → /analytics
//
// THE RULES THIS UI ENFORCES
//   · Readiness is never described as DCAA compliance, certification or a
//     predicted audit outcome. The disclaimer is always visible.
//   · An UNSUPPORTED or INSUFFICIENT_DATA rule is shown as excluded from the
//     score, never as a pass.
//   · A critical failure is shown even when the score is high.
//   · Cash flow reports NET FLOW. No cash position, because no opening balance
//     exists anywhere in the platform.
//   · Pipeline expected value is visually separated from contracted receipts.
//   · There is no "apply this rate" control, and no control that moves money.
//
// All amounts are backend-computed Decimal strings, formatted not calculated.
// =============================================================
import { humanize } from '../../lib/humanize'
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, HelpCircle, Info, RefreshCw, TrendingUp, XCircle } from 'lucide-react'
import {
  financeAgentApi,
  formatMoney,
  type CashFlowProjectionRow,
  type FinancePolicy,
  type RateVariance,
  type ReadinessCheckRow,
  type ReadinessVerdict,
  type FinanceAgentView,
} from '../../services/financeAgentApi'

const VERDICT_STYLE: Record<ReadinessVerdict, { tone: string; icon: typeof CheckCircle2; label: string }> = {
  PASS: { tone: 'text-[color:var(--success-text)]', icon: CheckCircle2, label: 'Pass' },
  FAIL: { tone: 'text-[color:var(--danger-text)]', icon: XCircle, label: 'Fail' },
  WARNING: { tone: 'text-[color:var(--warning)]', icon: AlertTriangle, label: 'Warning' },
  MANUAL_REVIEW: { tone: 'text-[color:var(--warning)]', icon: Clock, label: 'Manual review' },
  INSUFFICIENT_DATA: { tone: 'text-gray-500', icon: HelpCircle, label: 'Insufficient data' },
  UNSUPPORTED: { tone: 'text-gray-500', icon: HelpCircle, label: 'Not supported by the data model' },
}

/** Verdicts that are excluded from the score rather than counted as passing. */
const EXCLUDED_FROM_SCORE: ReadinessVerdict[] = ['UNSUPPORTED', 'INSUFFICIENT_DATA']

const READINESS_STATE_TONE: Record<string, string> = {
  CRITICAL_GAP: 'bg-[var(--danger-bg)] border-transparent text-[color:var(--danger-text)]',
  GAPS_PRESENT: 'bg-[var(--warning-bg)] border-transparent text-[color:var(--warning)]',
  REVIEW_REQUIRED: 'bg-[var(--warning-bg)] border-transparent text-[color:var(--warning)]',
  NO_GAPS_DETECTED: 'bg-[var(--success-bg)] border-transparent text-[color:var(--success-text)]',
  INSUFFICIENT_DATA: 'bg-transparent border-gray-700 text-gray-400',
}

const VARIANCE_TONE: Record<string, string> = {
  MATERIAL_VARIANCE: 'bg-[var(--danger-bg)] border-transparent text-[color:var(--danger-text)]',
  REVIEW_RECOMMENDED: 'bg-[var(--warning-bg)] border-transparent text-[color:var(--warning)]',
  WITHIN_MONITORING_RANGE: 'bg-[var(--success-bg)] border-transparent text-[color:var(--success-text)]',
  INSUFFICIENT_DATA: 'bg-transparent border-gray-700 text-gray-400',
}

function Panel({ title, icon: Icon, children, testId, onRefresh }: {
  title: string
  icon: typeof TrendingUp
  children: React.ReactNode
  testId: string
  onRefresh?: () => void
}) {
  return (
    <section className="card" data-testid={testId}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-gray-500" />
          <h2 className="text-base font-semibold text-gray-100">{title}</h2>
        </div>
        {onRefresh && (
          <button onClick={onRefresh} className="text-gray-500 hover:text-gray-300 transition-colors" aria-label={`Refresh ${title}`}>
            <RefreshCw className="w-4 h-4" />
          </button>
        )}
      </div>
      {children}
    </section>
  )
}

function Disclaimer({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-gray-500 mb-3" data-testid={testId}>
      <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </p>
  )
}

// =============================================================
// Timekeeping readiness
// =============================================================

export function DcaaReadinessPanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof financeAgentApi.readiness>> | null>(null)
  const [status, setStatus] = useState<FinanceAgentView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [readiness, agent] = await Promise.all([financeAgentApi.readiness(), financeAgentApi.status()])
      setData(readiness)
      setStatus(agent)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load the timekeeping readiness check.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Panel title="Timekeeping readiness" icon={CheckCircle2} testId="dcaa-readiness-panel"><p className="text-xs text-gray-500">Loading…</p></Panel>
  if (error) return <Panel title="Timekeeping readiness" icon={CheckCircle2} testId="dcaa-readiness-panel" onRefresh={() => void load()}><p className="text-xs text-[color:var(--danger-text)]">{error}</p></Panel>

  const tk = status?.status?.timekeeping ?? null
  const checks = data?.checks ?? []

  return (
    <Panel title="Timekeeping readiness" icon={CheckCircle2} testId="dcaa-readiness-panel" onRefresh={() => void load()}>
      <Disclaimer testId="readiness-disclaimer">{data?.disclaimer}</Disclaimer>

      {checks.length === 0 ? (
        <p className="text-xs text-gray-500">
          The Finance Agent has not run a readiness check yet. Enable it on the Agent operations page.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span
              className={`text-xs px-2.5 py-1 rounded-full border ${READINESS_STATE_TONE[tk?.readinessState ?? 'INSUFFICIENT_DATA']}`}
              data-testid="readiness-state"
            >
              {humanize(tk?.readinessState ?? 'INSUFFICIENT_DATA')}
            </span>
            {tk?.readinessScore != null && (
              <span className="text-[11px] text-gray-400" data-testid="readiness-score">
                {tk.readinessScore}% of {tk.scorableRules} scorable rule(s)
              </span>
            )}
            {tk != null && tk.criticalFailures > 0 && (
              <span className="text-xs px-2.5 py-1 rounded-full border bg-[var(--danger-bg)] border-transparent text-[color:var(--danger-text)]" data-testid="readiness-critical">
                {tk.criticalFailures} critical failure(s); a high score does not clear these
              </span>
            )}
            {tk != null && tk.unsupportedRules + tk.insufficientDataRules > 0 && (
              <span className="text-[11px] text-gray-500" data-testid="readiness-excluded">
                {tk.unsupportedRules + tk.insufficientDataRules} rule(s) excluded from the score, not counted as passing
              </span>
            )}
          </div>

          <ul className="space-y-2">
            {checks.map((c) => <ReadinessRuleRow key={c.id} check={c} critical={data!.criticalRuleKeys.includes(c.ruleKey)} />)}
          </ul>

          <p className="text-xs text-gray-500 mt-3" data-testid="readiness-meta">
            Rule set {data?.ruleVersion} · last checked {data?.checkedAt ? new Date(data.checkedAt).toLocaleString() : '—'}
            {checks[0]?.agentRunId ? ` · run ${checks[0].agentRunId.slice(0, 8)}` : ''}
          </p>
        </>
      )}
    </Panel>
  )
}

function ReadinessRuleRow({ check, critical }: { check: ReadinessCheckRow; critical: boolean }) {
  const [open, setOpen] = useState(false)
  const style = VERDICT_STYLE[check.verdict]
  const Icon = style.icon
  const excluded = EXCLUDED_FROM_SCORE.includes(check.verdict)

  return (
    <li className="panel p-3 text-xs" data-testid={`readiness-rule-${check.ruleKey}`}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start justify-between gap-2 text-left"
      >
        <span className="flex items-start gap-2">
          <Icon className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${style.tone}`} />
          <span>
            <span className="text-gray-300">{check.ruleKey.replace(/_/g, ' ').toLowerCase()}</span>
            <span className="block text-gray-500">{check.summary}</span>
          </span>
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {critical && <span className="text-xs px-2 py-0.5 rounded-full border bg-[var(--danger-bg)] border-transparent text-[color:var(--danger-text)]">Critical</span>}
          {excluded && <span className="text-xs px-2 py-0.5 rounded-full border border-gray-700 text-gray-400">Excluded</span>}
          <span className={`text-xs font-medium ${style.tone}`}>{style.label}</span>
        </span>
      </button>

      {open && (
        <div className="mt-2 pl-5 space-y-1" data-testid={`readiness-evidence-${check.ruleKey}`}>
          {check.evidence.length > 0
            ? check.evidence.map((e) => <p key={e} className="text-gray-400">{e}</p>)
            : <p className="text-gray-600">No individual findings recorded for this rule.</p>}
          {check.limitations.map((l) => <p key={l} className="text-[color:var(--warning)]">{l}</p>)}
          {check.sourceRecordIds.length > 0 && (
            <p className="text-gray-500 text-xs">
              Records: {check.sourceRecordIds.slice(0, 8).join(', ')}
              {check.sourceRecordIds.length > 8 ? ` +${check.sourceRecordIds.length - 8} more` : ''}
            </p>
          )}
          <p className="text-gray-500 text-xs">
            {check.recordsFailing} of {check.recordsChecked} record(s) failing · data {check.dataSufficiency}
          </p>
        </div>
      )}
    </li>
  )
}

// =============================================================
// Cash flow
// =============================================================

export function CashFlowPanel() {
  const [data, setData] = useState<Awaited<ReturnType<typeof financeAgentApi.cashFlow>> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await financeAgentApi.cashFlow())
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load the cash-flow projection.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Panel title="Cash flow projection" icon={TrendingUp} testId="cash-flow-panel"><p className="text-xs text-gray-500">Loading…</p></Panel>
  if (error) return <Panel title="Cash flow projection" icon={TrendingUp} testId="cash-flow-panel" onRefresh={() => void load()}><p className="text-xs text-[color:var(--danger-text)]">{error}</p></Panel>

  const projection: CashFlowProjectionRow | undefined = data?.projections[0]

  return (
    <Panel title="Cash flow projection" icon={TrendingUp} testId="cash-flow-panel" onRefresh={() => void load()}>
      <Disclaimer testId="cash-flow-disclaimer">{data?.noOpeningBalanceNote}</Disclaimer>

      {!projection ? (
        <p className="text-xs text-gray-500">
          The Finance Agent has not produced a projection yet. Enable it on the Agent operations page.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
            <Figure label="Projected receipts" value={formatMoney(projection.projectedReceipts)} testId="cf-receipts" hint="Contracted only" />
            <Figure label="Projected disbursements" value={formatMoney(projection.projectedDisbursements)} testId="cf-disbursements" />
            <Figure
              label="Projected net cash flow"
              value={formatMoney(projection.netCashFlow)}
              testId="cf-net"
              tone={projection.netCashFlow.startsWith('-') ? 'text-[color:var(--danger-text)]' : 'text-gray-100'}
              hint="Not a cash position"
            />
          </div>

          <div className="text-xs text-gray-400 space-y-1 mb-3" data-testid="cf-confidence">
            <p>
              Horizon {projection.horizonMonths} month(s) · {projection.confidenceState.replace(/_/g, ' ').toLowerCase()}
            </p>
            {projection.confidenceState === 'BANDED' && projection.confidenceLower && projection.confidenceUpper ? (
              <p>Range {formatMoney(projection.confidenceLower)} to {formatMoney(projection.confidenceUpper)}</p>
            ) : (
              <p className="text-gray-500">No confidence range — there is not enough settled-invoice history to measure one.</p>
            )}
          </div>

          <div className="border-t border-gray-800 pt-2" data-testid="cf-breakdown">
            <p className="text-[13px] text-gray-400 mb-1">Source breakdown</p>
            <ul className="space-y-1 text-xs">
              {Object.entries(projection.sourceBreakdown).map(([cls, b]) => (
                <li key={cls} className="flex items-center justify-between gap-2" data-testid={`cf-source-${cls}`}>
                  <span className={cls === 'PIPELINE_EXPECTED_VALUE' ? 'text-gray-500 italic' : 'text-gray-300'}>
                    {cls.replace(/_/g, ' ').toLowerCase()}
                    {cls === 'PIPELINE_EXPECTED_VALUE' && ' — not contracted, excluded from net'}
                  </span>
                  <span className="font-mono text-gray-400">
                    {b.receipts !== '0.00' ? formatMoney(b.receipts) : formatMoney(b.disbursements)} ({b.count})
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {projection.limitations.map((l) => (
            <p key={l} className="text-xs text-[color:var(--warning)] mt-2">{l}</p>
          ))}
        </>
      )}
    </Panel>
  )
}

function Figure({ label, value, testId, tone, hint }: { label: string; value: string; testId: string; tone?: string; hint?: string }) {
  return (
    <div className="panel p-3" data-testid={testId}>
      <p className="text-[13px] text-gray-400">{label}</p>
      <p className={`text-base font-bold mt-0.5 ${tone ?? 'text-gray-100'}`}>{value}</p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  )
}

// =============================================================
// Rate variance
// =============================================================

export function RateVariancePanel() {
  const [data, setData] = useState<FinanceAgentView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await financeAgentApi.status())
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load indirect rate variance.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <Panel title="Indirect rate variance" icon={TrendingUp} testId="rate-variance-panel"><p className="text-xs text-gray-500">Loading…</p></Panel>
  if (error) return <Panel title="Indirect rate variance" icon={TrendingUp} testId="rate-variance-panel" onRefresh={() => void load()}><p className="text-xs text-[color:var(--danger-text)]">{error}</p></Panel>

  const variances: RateVariance[] = data?.status?.indirectRates.variances ?? []
  const policy: FinancePolicy | undefined = data?.policy

  return (
    <Panel title="Indirect rate variance" icon={TrendingUp} testId="rate-variance-panel" onRefresh={() => void load()}>
      <Disclaimer testId="rate-variance-disclaimer">{policy?.rateSemanticNote}</Disclaimer>

      {variances.length === 0 ? (
        <p className="text-xs text-gray-500">
          No actual indirect rate has been recorded, so there is nothing to compare. The agent never derives an actual rate
          from a pricing assumption.
        </p>
      ) : (
        <ul className="space-y-2">
          {variances.map((v) => (
            <li key={`${v.rateType}-${v.period.start}`} className="panel p-3 text-xs" data-testid={`rate-variance-${v.rateType}`}>
              <div className="flex items-start justify-between gap-2 mb-1">
                <div>
                  <span className="text-gray-100 font-medium">{humanize(v.rateType)}</span>
                  {v.poolName && <span className="text-gray-500"> · {v.poolName}</span>}
                  <span className="block text-gray-500 text-xs">
                    FY{v.period.fiscalYear} · {v.period.start.slice(0, 10)} to {v.period.end.slice(0, 10)}
                  </span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full border shrink-0 ${VARIANCE_TONE[v.state]}`}>
                  {humanize(v.state)}
                </span>
              </div>
              <dl className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                <div><dt className="text-gray-500">Pricing rate</dt><dd className="text-gray-300 font-mono">{v.provisionalRate ?? '—'}%</dd></div>
                <div><dt className="text-gray-500">Actual rate</dt><dd className="text-gray-300 font-mono">{v.actualRate ?? '—'}%</dd></div>
                <div><dt className="text-gray-500">Difference</dt><dd className="text-gray-300 font-mono">{v.absoluteVariance ?? '—'}</dd></div>
                <div><dt className="text-gray-500">Relative</dt><dd className="text-gray-300 font-mono">{v.relativeVariancePct ?? '—'}%</dd></div>
              </dl>
              {!v.actualIsHumanVerified && (
                <p className="text-[color:var(--warning)] mt-1" data-testid={`rate-unverified-${v.rateType}`}>
                  The actual rate has not been verified by a person.
                </p>
              )}
              {v.limitations.map((l) => <p key={l} className="text-[color:var(--warning)] mt-1">{l}</p>)}
            </li>
          ))}
        </ul>
      )}

      {policy && (
        <p className="text-xs text-gray-500 mt-3" data-testid="rate-variance-policy">
          Bytesgov monitoring thresholds: review at {policy.varianceReviewPct}%, material at {policy.varianceMaterialPct}%.
          These decide when the product asks a person to look — they are not a DCAA or FAR threshold.
        </p>
      )}
    </Panel>
  )
}
