import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { analyticsApi, firmApi } from '../services/api'

// Map an audit entity to a clickable route where one exists (best-effort — some
// entities have no standalone page and render as plain text).
function entityLink(entityType: string, entityId: string | null): string | null {
  if (!entityId) return null
  switch (entityType) {
    case 'Contract': return `/contracts/${entityId}`
    case 'ClientCompany': return `/clients/${entityId}`
    case 'Partner': case 'TeamingArrangement': return '/teaming'
    case 'Certification': case 'InsurancePolicy': case 'RegistrationProfile': return '/registration'
    case 'SubmissionRecord': return '/submissions'
    case 'SavedMonitoringProfile': return '/opportunities'
    default: return null
  }
}
import {
  PageHeader,
  ErrorBanner,
  StatusPill,
  SkeletonRows,
  EmptyState,
} from '../components/ui'
import { ShieldCheck, ArrowRight, FileText, GitBranch, Clock, Info, Download } from 'lucide-react'

// Tone word handed to StatusPill (the raw status is what gets displayed).
const statusColor: Record<string, string> = {
  APPROVED: 'approved',
  PENDING: 'pending',
  BLOCKED: 'blocked',
  REJECTED: 'neutral',
}

export function ComplianceLogsPage() {
  const [entityType, setEntityType] = useState<string>('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  const handleExportCsv = async () => {
    setExportError('')
    setExporting(true)
    try {
      await firmApi.exportAuditLog()
    } catch {
      setExportError('Audit export failed — try again, or narrow the window if the log is very large.')
    } finally {
      setExporting(false)
    }
  }

  const { data, isLoading, error } = useQuery({
    queryKey: ['compliance-logs', entityType, from, to, page],
    queryFn: () =>
      analyticsApi.complianceLogs({
        entityType: entityType || undefined,
        from: from ? new Date(from).toISOString() : undefined,
        to: to ? new Date(to + 'T23:59:59').toISOString() : undefined,
        page,
        limit: 25,
      }),
  })

  if (error) return <ErrorBanner message="Failed to load compliance logs" />

  const logs = data?.data?.logs || []
  const pagination = data?.data?.pagination

  return (
    <div>
      <PageHeader
        title="Compliance Audit Log"
        subtitle="Full history of every compliance status change across your firm"
      >
        <div className="flex flex-col items-end gap-1">
          <button
            onClick={handleExportCsv}
            disabled={exporting}
            className="btn-secondary disabled:opacity-50"
          >
            <Download className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export audit CSV'}
          </button>
          {exportError && <p className="text-xs text-red-400">{exportError}</p>}
        </div>
      </PageHeader>

      {/* Explanation cards */}
      <div className="stagger grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <div className="card flex gap-3">
          <span className="tile tile-sm tile-accent"><ShieldCheck className="w-3.5 h-3.5" /></span>
          <div>
            <p className="text-sm font-medium text-gray-200 mb-1">What is this page?</p>
            <p className="text-xs text-gray-500">
              Every time a bid decision or submission changes compliance status — automatically or manually —
              an immutable log entry is created. This gives you a full audit trail for regulatory review.
            </p>
          </div>
        </div>
        <div className="card flex gap-3">
          <span className="tile tile-sm tile-accent"><GitBranch className="w-3.5 h-3.5" /></span>
          <div>
            <p className="text-sm font-medium text-gray-200 mb-1">Status transitions</p>
            <p className="text-xs text-gray-500">
              Entries show the <span className="text-yellow-300">from → to</span> status transition.
              System-triggered transitions happen automatically (e.g. when a decision is evaluated).
              Manual transitions require ADMIN role.
            </p>
          </div>
        </div>
        <div className="card flex gap-3">
          <span className="tile tile-sm tile-success"><Clock className="w-3.5 h-3.5" /></span>
          <div>
            <p className="text-sm font-medium text-gray-200 mb-1">When does it populate?</p>
            <p className="text-xs text-gray-500">
              Log entries are created when you run the Decision Engine on an opportunity, manually change
              a bid decision status, or when a submission record status changes. Run decisions to start
              generating audit history.
            </p>
          </div>
        </div>
      </div>

      {/* Status key */}
      <div className="panel flex flex-wrap items-center gap-2.5 mb-5 px-3.5 py-3">
        <span className="text-xs text-gray-500 flex items-center gap-1"><Info className="w-3 h-3" /> Status key:</span>
        {Object.entries(statusColor).map(([s, cls]) => (
          <StatusPill key={s} status={cls}>{s}</StatusPill>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <select
          value={entityType}
          onChange={(e) => { setEntityType(e.target.value); setPage(1) }}
          className="input text-sm w-full sm:w-52"
        >
          <option value="">All entity types</option>
          {['BidDecision', 'SubmissionRecord', 'Proposal', 'ProposalSection', 'Contract', 'ClientCompany', 'Partner', 'RegistrationProfile', 'Certification', 'InsurancePolicy', 'User'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="text-xs text-gray-500 flex items-center gap-1.5">From
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} className="input text-sm" />
        </label>
        <label className="text-xs text-gray-500 flex items-center gap-1.5">To
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} className="input text-sm" />
        </label>
        {(from || to || entityType) && <button onClick={() => { setFrom(''); setTo(''); setEntityType(''); setPage(1) }} className="btn-ghost btn-sm">Clear</button>}

        {pagination && (
          <span className="text-xs text-gray-500 ml-auto tabular-nums">
            Page {pagination.page} of {pagination.pages} ({pagination.total} total entries)
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="card">
          <span className="sr-only">Loading…</span>
          <SkeletonRows rows={6} cols={5} />
        </div>
      ) : logs.length === 0 ? (
        <div className="card">
          <EmptyState
            message="No audit entries yet"
            icon={<ShieldCheck className="w-5 h-5" />}
            hint="Compliance log entries are created when you run the Decision Engine on opportunities (Opportunities → select an opp → Run Decision) or when submission statuses are updated. Once activity begins, all state transitions appear here with full timestamps and reasons."
          />
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Entity Type</th>
                  <th>Transition</th>
                  <th>Reason</th>
                  <th>Triggered By</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log: any) => (
                  <tr key={log.id}>
                    <td className="text-xs text-gray-400 whitespace-nowrap tabular-nums">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td>
                      {(() => {
                        const href = entityLink(log.entityType, log.entityId)
                        const inner = (
                          <span className={`chip w-fit ${href ? 'chip-accent' : 'chip-neutral'}`}>
                            {log.entityType === 'BidDecision' ? <FileText className="w-3 h-3" /> : <GitBranch className="w-3 h-3" />}
                            {log.entityType}{href && ' ↗'}
                          </span>
                        )
                        return href ? <Link to={href}>{inner}</Link> : inner
                      })()}
                    </td>
                    <td>
                      <div className="flex items-center gap-2">
                        {log.fromStatus && (
                          <StatusPill status={statusColor[log.fromStatus] || 'neutral'}>
                            {log.fromStatus}
                          </StatusPill>
                        )}
                        <ArrowRight className="w-3 h-3 text-gray-500 flex-shrink-0" />
                        <StatusPill status={statusColor[log.toStatus] || 'neutral'}>
                          {log.toStatus}
                        </StatusPill>
                      </div>
                    </td>
                    <td className="text-xs text-gray-400 max-w-xs truncate">
                      {log.reason || <span className="text-gray-600 italic">—</span>}
                    </td>
                    <td className="text-xs text-gray-400">
                      {log.triggeredBy ? (
                        <span className="chip chip-accent" title={log.actorRole || ''}>{log.actorName || log.triggeredBy}</span>
                      ) : (
                        <span className="text-gray-600 italic">System</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {pagination && pagination.pages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="btn-secondary btn-sm disabled:opacity-50"
              >
                Previous
              </button>
              <span className="text-xs text-gray-400 tabular-nums">
                {page} / {pagination.pages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                disabled={page >= pagination.pages}
                className="btn-secondary btn-sm disabled:opacity-50"
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default ComplianceLogsPage
