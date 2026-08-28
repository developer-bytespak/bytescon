// =============================================================
// §7.3 — Compliance Agent surfaces.
//
//   ComplianceRegistrationPanel  → /registration
//   BondingCapacityManager       → /registration (ADMIN writes)
//   ComplianceLibraryPanel       → /document-library
//   OpportunityCompliancePanel   → opportunity / proposal
//
// Every state below is rendered from the backend's COMPLIANCE_STATUS. Nothing
// here decides whether something is blocked, computes an expiry, derives
// bonding headroom or resolves a flow-down — and no control lets a user mark a
// requirement verified or clear a legal review from an agent surface.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, FileWarning, Landmark, RefreshCw, ShieldCheck } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { useToast } from '../Toast'
import {
  Badge, Disclaimer, EmptyPanel, ErrorPanel, LoadingPanel, PartialDataNotice, formatDate,
} from '../section6/Section6Ui'
import {
  complianceAgentApi,
  type BondingRecord,
  type ComplianceAgentLatest,
  type ComplianceOverallStatus,
  type OpportunityComplianceView,
} from '../../services/complianceAgentApi'

const STATUS_TONE: Record<ComplianceOverallStatus, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  COMPLIANT_CURRENT: 'success',
  ATTENTION_REQUIRED: 'warning',
  HUMAN_REVIEW_REQUIRED: 'info',
  BLOCKED: 'danger',
  INSUFFICIENT_DATA: 'neutral',
}

const STATUS_LABEL: Record<ComplianceOverallStatus, string> = {
  COMPLIANT_CURRENT: 'COMPLIANT — CURRENT',
  ATTENTION_REQUIRED: 'ATTENTION REQUIRED',
  HUMAN_REVIEW_REQUIRED: 'HUMAN REVIEW REQUIRED',
  BLOCKED: 'BLOCKED',
  INSUFFICIENT_DATA: 'INSUFFICIENT DATA',
}

const EXPIRY_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  ACTIVE: 'success', EXPIRING_SOON: 'warning', EXPIRED: 'danger', MISSING: 'neutral',
}

function useLatest() {
  const [data, setData] = useState<ComplianceAgentLatest | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await complianceAgentApi.getLatest())
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load the Compliance Agent status.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  return { data, loading, error, reload: load }
}

function RunLine({ data }: { data: ComplianceAgentLatest }) {
  return (
    <dl className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
      <div>
        <dt className="text-gray-500">Last run</dt>
        <dd className="text-gray-300" data-testid="compliance-last-run">
          {data.lastRun ? `${data.lastRun.status} · ${formatDate(data.lastRun.createdAt)}` : 'Never run'}
        </dd>
      </div>
      <div>
        <dt className="text-gray-500">Last success</dt>
        <dd className="text-gray-300">{data.lastSuccessfulRun ? formatDate(data.lastSuccessfulRun.finishedAt) : '—'}</dd>
      </div>
      <div>
        <dt className="text-gray-500">Next run</dt>
        <dd className="text-gray-300">{data.schedule?.isEnabled ? formatDate(data.schedule.nextRunAt) : '—'}</dd>
      </div>
      <div>
        <dt className="text-gray-500">Autonomy</dt>
        <dd className="text-gray-300 font-mono">{data.schedule?.autonomyLevel ?? 'PROPOSE'}</dd>
      </div>
    </dl>
  )
}

// -------------------------------------------------------------
// /registration
// -------------------------------------------------------------

export function ComplianceRegistrationPanel() {
  const { data, loading, error, reload } = useLatest()

  if (loading) return <LoadingPanel label="Loading Compliance Agent status…" />
  if (error) return <ErrorPanel message={error} onRetry={() => void reload()} />
  if (!data) return <EmptyPanel message="No Compliance Agent data." />

  const { registration, status, schedule, escalations, policy } = data

  return (
    <div className="space-y-4" data-testid="compliance-registration-panel">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-gray-400" />
            <div>
              <h3 className="text-sm font-medium text-gray-200">Compliance Agent</h3>
              <p className="text-xs text-gray-500">Deterministic checks. AI-assisted extraction is optional.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone="success">IMPLEMENTED</Badge>
            {schedule?.isEnabled ? <Badge tone="success">ENABLED</Badge> : <Badge tone="neutral">DISABLED</Badge>}
            {status && (
              <Badge tone={STATUS_TONE[status.overallStatus]}>{STATUS_LABEL[status.overallStatus]}</Badge>
            )}
            <button
              onClick={() => void reload()}
              className="text-gray-500 hover:text-gray-300 transition-colors"
              aria-label="Refresh Compliance Agent status"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
        <RunLine data={data} />
        {data.lastRun && (
          <p className="mt-3 text-[11px] text-gray-500">
            Run <Link to={`/agents/runs/${data.lastRun.id}`} className="text-blue-400 hover:underline">{data.lastRun.id.slice(0, 8)}</Link>
            {data.lastRun.outputSummary ? ` · ${data.lastRun.outputSummary}` : ''}
          </p>
        )}
      </div>

      {/* --- SAM ------------------------------------------------- */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="compliance-sam">
        <div className="flex items-center justify-between gap-3 mb-2">
          <h3 className="text-sm font-medium text-gray-200">SAM.gov registration</h3>
          <Badge tone={EXPIRY_TONE[registration.sam.expiryStatus] ?? 'neutral'}>{registration.sam.expiryStatus}</Badge>
        </div>
        <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
          <div><dt className="text-gray-500">Recorded status</dt><dd className="text-gray-300 font-mono">{registration.sam.status}</dd></div>
          <div><dt className="text-gray-500">Expiry</dt><dd className="text-gray-300">{formatDate(registration.sam.expiryDate)}</dd></div>
          <div>
            <dt className="text-gray-500">Days remaining</dt>
            <dd className={registration.sam.withinEscalationWindow ? 'text-yellow-400 font-mono' : 'text-gray-300 font-mono'}>
              {registration.sam.daysUntilExpiry ?? '—'}
            </dd>
          </div>
          <div><dt className="text-gray-500">Escalation window</dt><dd className="text-gray-300">{policy.samExpiryEscalationDays} days</dd></div>
        </dl>
        {/* Provider honesty, verbatim from the backend. */}
        <p className="mt-2 text-[11px] text-gray-500" data-testid="sam-freshness">{registration.sam.dataFreshness}</p>
      </div>

      {/* --- certifications + insurance --------------------------- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ExpiryList
          title="Certifications"
          testId="compliance-certifications"
          empty="No certifications are recorded."
          items={registration.certifications.map((c) => ({ id: c.id, label: c.name, expiryDate: c.expiryDate, expiryStatus: c.expiryStatus, daysUntilExpiry: c.daysUntilExpiry }))}
        />
        <ExpiryList
          title="Insurance"
          testId="compliance-insurance"
          empty="No insurance policies are recorded."
          items={registration.insurance.map((p) => ({ id: p.id, label: p.policyType, expiryDate: p.expiryDate, expiryStatus: p.expiryStatus, daysUntilExpiry: p.daysUntilExpiry }))}
        />
      </div>

      {/* --- bonding ---------------------------------------------- */}
      <BondingCapacityManager />

      {registration.blockers.length > 0 && (
        <div className="bg-red-950/40 border border-red-800 rounded-xl p-3 text-xs text-red-300" data-testid="compliance-blockers">
          <AlertTriangle className="w-4 h-4 inline mr-1" />
          <ul className="list-disc list-inside mt-1 space-y-0.5">
            {registration.blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}
      {registration.insufficient.length > 0 && <PartialDataNotice limitations={registration.insufficient} />}

      {escalations.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="compliance-escalations">
          <h3 className="text-sm font-medium text-gray-200 mb-2">Open compliance escalations ({escalations.length})</h3>
          <ul className="space-y-2">
            {escalations.map((e) => (
              <li key={e.id} className="border border-gray-800 rounded-lg p-2 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-200">{e.title}</span>
                  <Badge tone={e.severity === 'CRITICAL' || e.severity === 'HIGH' ? 'danger' : 'warning'}>{e.severity}</Badge>
                </div>
                <p className="text-gray-500 mt-1">{e.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Disclaimer>
        The Compliance Agent proposes; it never decides. It does not verify a requirement, approve a clause,
        clear a legal review, acknowledge an amendment, renew a certification, or change registration,
        insurance or bonding records.
      </Disclaimer>
    </div>
  )
}

function ExpiryList({ title, testId, empty, items }: {
  title: string
  testId: string
  empty: string
  items: Array<{ id: string; label: string; expiryDate: string | null; expiryStatus: string; daysUntilExpiry: number | null }>
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid={testId}>
      <h3 className="text-sm font-medium text-gray-200 mb-2">{title}</h3>
      {items.length === 0 ? <EmptyPanel message={empty} /> : (
        <ul className="space-y-2">
          {items.map((i) => (
            <li key={i.id} className="flex items-start justify-between gap-3 text-xs border border-gray-800 rounded-lg p-2">
              <div>
                <p className="text-gray-300">{i.label}</p>
                <p className="text-gray-500">
                  expires {formatDate(i.expiryDate)}
                  {i.daysUntilExpiry !== null && ` · ${i.daysUntilExpiry < 0 ? `${-i.daysUntilExpiry}d overdue` : `${i.daysUntilExpiry}d`}`}
                </p>
              </div>
              <Badge tone={EXPIRY_TONE[i.expiryStatus] ?? 'neutral'}>{i.expiryStatus}</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// -------------------------------------------------------------
// Bonding capacity — human-maintained, ADMIN-only writes
// -------------------------------------------------------------

const EMPTY_FORM = {
  suretyName: '', singleProjectLimit: '', aggregateLimit: '', committedAmount: '',
  effectiveDate: '', expiryDate: '', evidenceReference: '', notes: '',
}

export function BondingCapacityManager() {
  const { user } = useAuth()
  const { toast } = useToast()
  const isAdmin = user?.role === 'ADMIN'

  const [records, setRecords] = useState<BondingRecord[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const result = await complianceAgentApi.listBonding()
      setRecords(result.records)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load bonding capacity.')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await complianceAgentApi.createBonding({
        suretyName: form.suretyName || null,
        singleProjectLimit: form.singleProjectLimit || null,
        aggregateLimit: form.aggregateLimit || null,
        committedAmount: form.committedAmount || null,
        effectiveDate: form.effectiveDate ? new Date(form.effectiveDate).toISOString() : null,
        expiryDate: form.expiryDate ? new Date(form.expiryDate).toISOString() : null,
        evidenceReference: form.evidenceReference || null,
        notes: form.notes || null,
      })
      toast('Bonding capacity recorded.', 'success')
      setForm({ ...EMPTY_FORM })
      setOpen(false)
      await load()
    } catch (err) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the bonding record.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const archive = async (id: string) => {
    if (!window.confirm('Archive this bonding capacity record? It stays as evidence but stops counting as current.')) return
    try {
      await complianceAgentApi.archiveBonding(id)
      toast('Bonding record archived.', 'success')
      await load()
    } catch (err) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not archive the record.', 'error')
    }
  }

  const active = records?.filter((r) => r.status !== 'ARCHIVED') ?? []

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="bonding-capacity">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Landmark className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm font-medium text-gray-200">Surety bonding capacity</h3>
        </div>
        <button
          data-testid="add-bonding"
          disabled={!isAdmin}
          onClick={() => setOpen((v) => !v)}
          title={isAdmin ? 'Record a capacity letter' : 'Only an administrator can record bonding capacity.'}
          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40 transition-colors"
        >
          {open ? 'Cancel' : 'Record capacity'}
        </button>
      </div>

      {error && <ErrorPanel message={error} onRetry={() => void load()} />}

      {open && isAdmin && (
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3" data-testid="bonding-form">
          {([
            ['suretyName', 'Surety / broker', 'text'],
            ['singleProjectLimit', 'Single project limit', 'text'],
            ['aggregateLimit', 'Aggregate limit', 'text'],
            ['committedAmount', 'Currently committed', 'text'],
            ['effectiveDate', 'Effective date', 'date'],
            ['expiryDate', 'Expiry date', 'date'],
            ['evidenceReference', 'Evidence reference', 'text'],
          ] as const).map(([key, label, type]) => (
            <label key={key} className="text-xs text-gray-400">
              {label}
              <input
                type={type}
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 mt-1"
              />
            </label>
          ))}
          <div className="md:col-span-2">
            <button
              type="submit"
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save bonding record'}
            </button>
          </div>
        </form>
      )}

      {records === null ? <LoadingPanel label="Loading bonding capacity…" />
        : active.length === 0 ? (
          <EmptyPanel
            message="No surety bonding capacity is recorded."
            hint="Bonding requirements cannot be assessed until a capacity letter is recorded here."
          />
        ) : (
          <ul className="space-y-2" data-testid="bonding-list">
            {active.map((r) => (
              <li key={r.id} className="border border-gray-800 rounded-lg p-3 text-xs space-y-1">
                <div className="flex items-start justify-between gap-3">
                  <span className="text-gray-200">{r.suretyName ?? 'Surety not recorded'}</span>
                  <div className="flex items-center gap-2">
                    <Badge tone={
                      r.assessment.state === 'SUFFICIENT' ? 'success'
                        : r.assessment.state === 'EXPIRED' || r.assessment.state === 'INSUFFICIENT' ? 'danger' : 'neutral'
                    }>
                      {r.assessment.state === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : r.assessment.state}
                    </Badge>
                    {isAdmin && (
                      <button
                        onClick={() => void archive(r.id)}
                        className="text-gray-500 hover:text-red-400 transition-colors"
                        data-testid={`archive-bonding-${r.id}`}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </div>
                <dl className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <div><dt className="text-gray-500">Single project</dt><dd className="text-gray-300 font-mono">{r.assessment.singleProjectLimit ?? '—'}</dd></div>
                  <div><dt className="text-gray-500">Aggregate</dt><dd className="text-gray-300 font-mono">{r.assessment.aggregateLimit ?? '—'}</dd></div>
                  <div><dt className="text-gray-500">Committed</dt><dd className="text-gray-300 font-mono">{r.assessment.committedAmount ?? '—'}</dd></div>
                  <div>
                    <dt className="text-gray-500">Available</dt>
                    <dd className="text-gray-300 font-mono" data-testid={`bonding-available-${r.id}`}>
                      {r.assessment.availableCapacity ?? '—'}
                    </dd>
                  </div>
                </dl>
                <p className="text-gray-500">Expires {formatDate(r.expiryDate)}</p>
                {/* Honest reasons, verbatim — never a manufactured headroom figure. */}
                {r.assessment.reasons.map((reason) => <p key={reason} className="text-yellow-400">{reason}</p>)}
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

// -------------------------------------------------------------
// /document-library
// -------------------------------------------------------------

export function ComplianceLibraryPanel() {
  const { data, loading, error, reload } = useLatest()

  if (loading) return <LoadingPanel label="Loading Compliance Agent status…" />
  if (error) return <ErrorPanel message={error} onRetry={() => void reload()} />
  if (!data) return <EmptyPanel message="No Compliance Agent data." />
  if (!data.status) {
    return (
      <EmptyPanel
        message="The Compliance Agent has not produced a status yet."
        hint="Enable it on the Agent Operations page, or trigger a run there."
      />
    )
  }

  const { documents, opportunities } = data.status

  return (
    <div className="space-y-4" data-testid="compliance-library-panel">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <RunLine data={data} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Kpi label="Approved for reuse" value={documents.reusable} />
        <Kpi label="Expiring" value={documents.expiring} />
        <Kpi label="Expired" value={documents.expired} />
        <Kpi label="No expiry data" value={documents.missing} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="library-documents">
        <h3 className="text-sm font-medium text-gray-200 mb-2">Standing document health</h3>
        {documents.items.length === 0 ? <EmptyPanel message="No standing documents are recorded." /> : (
          <ul className="space-y-2">
            {documents.items.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-3 text-xs border border-gray-800 rounded-lg p-2">
                <div>
                  <p className="text-gray-300">{d.name}</p>
                  <p className="text-gray-500">{d.category} · {d.expiryMessage}</p>
                </div>
                <Badge tone={d.expiryState === 'EXPIRED' ? 'danger' : d.expiryState === 'VALID' || d.expiryState === 'NO_EXPIRY' ? 'success' : 'warning'}>
                  {d.expiryState}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4" data-testid="library-blockers">
        <h3 className="text-sm font-medium text-gray-200 mb-2">Submission blockers on active pursuits</h3>
        {opportunities.every((o) => o.submission.blockers.length === 0) ? (
          <EmptyPanel message="No submission blockers are recorded on active pursuits." />
        ) : (
          <ul className="space-y-2">
            {opportunities.filter((o) => o.submission.blockers.length > 0).map((o) => (
              <li key={o.opportunityId} className="border border-gray-800 rounded-lg p-2 text-xs">
                <Link to={`/opportunities/${o.opportunityId}`} className="text-gray-200 hover:underline">{o.title}</Link>
                <ul className="list-disc list-inside text-red-400 mt-1">
                  {o.submission.blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// Opportunity / proposal
// -------------------------------------------------------------

export function OpportunityCompliancePanel({ opportunityId }: { opportunityId: string }) {
  const [data, setData] = useState<OpportunityComplianceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await complianceAgentApi.getOpportunity(opportunityId))
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load compliance status.')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading compliance status…" />
  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />
  if (!data) return <EmptyPanel message="No compliance data." />

  const row = data.compliance
  if (!row) {
    return (
      <EmptyPanel
        message="The Compliance Agent has not assessed this opportunity yet."
        hint="It is assessed on the agent's schedule, and immediately when a document or amendment is added."
      />
    )
  }

  return (
    <div className="space-y-3 text-xs" data-testid="opportunity-compliance-panel">
      <div className="flex items-center justify-between gap-3">
        <Badge tone={STATUS_TONE[row.overallStatus]}>{STATUS_LABEL[row.overallStatus]}</Badge>
        <span className="text-gray-500">assessed {formatDate(data.generatedAt)}</span>
      </div>

      <ul className="text-gray-400 list-disc list-inside space-y-0.5" data-testid="compliance-reasons">
        {row.statusReasons.slice(0, 6).map((r) => <li key={r}>{r}</li>)}
      </ul>

      <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Requirements" value={`${row.matrix.totalRequirements}`} />
        <Stat label="Verified" value={`${row.matrix.verifiedRequirements}`} testId="verified-count" />
        <Stat label="Coverage" value={`${row.matrix.coveragePercent}%`} />
        <Stat label="Mandatory" value={`${row.matrix.mandatoryRequirements}`} />
        <Stat label="L instructions" value={`${row.lmCoverage.instructions}`} />
        <Stat label="M criteria" value={`${row.lmCoverage.evaluationCriteria}`} />
        <Stat label="Mapping review" value={`${row.lmCoverage.reviewRequired}`} testId="mapping-review" />
        <Stat label="Legal review" value={`${row.clauses.unresolvedFlowDowns}`} testId="legal-review" />
      </dl>

      {row.certificationWarnings.map((w) => (
        <p key={w} className="text-red-400" data-testid="cert-warning">{w}</p>
      ))}

      {row.amendment?.latestRevisionId && (
        <div className="border border-gray-800 rounded-lg p-2" data-testid="amendment-summary">
          <p className="text-gray-300">
            Amendment {row.amendment.latestRevisionNo} · {row.amendment.changedRequirements} requirement change(s) ·
            {' '}{row.amendment.unresolvedImpacts} unacknowledged impact(s)
          </p>
          {row.amendment.conflictsWithVerified > 0 && (
            <p className="text-yellow-400 mt-1" data-testid="amendment-conflicts">
              {row.amendment.conflictsWithVerified} human-verified record(s) conflict with this amendment.
              Every verified value was preserved unchanged.
            </p>
          )}
          <p className="text-gray-500 mt-1">{row.amendment.analysisBasis}</p>
        </div>
      )}

      {row.submission.blockers.length > 0 && (
        <div className="bg-red-950/40 border border-red-800 rounded-lg p-2" data-testid="submission-blockers">
          <FileWarning className="w-3 h-3 inline mr-1 text-red-400" />
          <ul className="list-disc list-inside text-red-300">
            {row.submission.blockers.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}
      {row.submission.manualRequired > 0 && (
        <p className="text-gray-500">
          {row.submission.manualRequired} submission check(s) require a human — the platform cannot verify them automatically.
        </p>
      )}

      <p className="text-gray-500" data-testid="extraction-note">{row.extraction.note}</p>

      {data.lastRun && (
        <p className="text-[11px] text-gray-600">
          <Link to={`/agents/runs/${data.lastRun.id}`} className="text-blue-400 hover:underline">View the Compliance Agent run</Link>
        </p>
      )}
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <p className="text-[10px] text-gray-500 tracking-widest uppercase">{label}</p>
      <p className="text-2xl font-bold text-gray-100 font-mono">{value}</p>
    </div>
  )
}

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-300 font-mono" data-testid={testId}>{value}</dd>
    </div>
  )
}
