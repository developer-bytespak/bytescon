import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import { decisionsApi, clientsApi } from '../services/api'
import { useExportCsv } from '../hooks/useExportCsv'
import {
  PageHeader,
  Spinner,
  ErrorBanner,
  formatCurrency,
  ProbabilityBar,
} from '../components/ui'
import { Link } from 'react-router-dom'
import { ThumbsUp, ThumbsDown, Scale, Rocket, Clock, Download } from 'lucide-react'

const recStyles: Record<string, { bg: string; text: string; icon: any; label: string }> = {
  BID_PRIME: { bg: 'bg-green-900/20', text: 'text-green-400', icon: ThumbsUp, label: 'BID PRIME' },
  BID_SUB: { bg: 'bg-blue-900/20', text: 'text-blue-400', icon: Scale, label: 'BID SUB' },
  NO_BID: { bg: 'bg-red-900/20', text: 'text-red-400', icon: ThumbsDown, label: 'NO BID' },
}

const complianceBadge: Record<string, string> = {
  APPROVED: 'bg-green-900 text-green-300',
  PENDING: 'bg-yellow-900 text-yellow-300',
  BLOCKED: 'bg-red-900 text-red-300',
  REJECTED: 'bg-gray-700 text-gray-400',
}

export function DecisionsPage() {
  const tutorial = useTutorial()
  const [showTutorial, setShowTutorial] = useState(() => !tutorial.hasSeen('decisions'))
  function handleTutorialClose() { tutorial.markSeen('decisions'); setShowTutorial(false) }
  // ── Filters: client, NAICS, go/no-go ──────────────────────────
  const [filterClientId, setFilterClientId] = useState('')
  const [filterNaics, setFilterNaics] = useState('')
  const [filterDecision, setFilterDecision] = useState('')
  // Server-side pagination — the API caps at 500 rows/page, and portfolio
  // evaluation writes one decision per opportunity × client, so large firms
  // exceed a single page. Filter changes reset to the first page.
  const PAGE_SIZE = 100
  const [page, setPage] = useState(0)
  const resetPage = () => setPage(0)
  const [exporting, setExporting] = useState(false)
  const [exportNote, setExportNote] = useState('')

  const { data: clientsResp } = useQuery({
    queryKey: ['clients', 'decisions-filter'],
    queryFn: () => clientsApi.list(),
    staleTime: 5 * 60 * 1000,
  })
  const clientOptions: any[] = clientsResp?.data ?? []

  const filterParams = {
    ...(filterClientId ? { clientCompanyId: filterClientId } : {}),
    ...(filterNaics.trim() ? { naics: filterNaics.trim() } : {}),
    ...(filterDecision ? { decision: filterDecision } : {}),
  }
  const decisionParams = { ...filterParams, limit: PAGE_SIZE, offset: page * PAGE_SIZE }
  const hasActiveFilters = filterClientId !== '' || filterNaics.trim() !== '' || filterDecision !== ''

  const { data, isLoading, error } = useQuery({
    queryKey: ['decisions', decisionParams],
    queryFn: () => decisionsApi.list(decisionParams),
  })

  const { data: metricsData } = useQuery({
    queryKey: ['decision-metrics'],
    queryFn: () => decisionsApi.metrics(),
  })

  const { exportCsv } = useExportCsv()
  const qc = useQueryClient()
  const { data: queueData } = useQuery({
    queryKey: ['decision-queue'],
    queryFn: () => decisionsApi.queue(50),
  })
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const resolveMut = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'GO' | 'NO_GO' }) =>
      decisionsApi.resolve(id, decision),
    onMutate: ({ id }) => setResolvingId(id),
    onSettled: () => {
      setResolvingId(null)
      qc.invalidateQueries({ queryKey: ['decision-queue'] })
      qc.invalidateQueries({ queryKey: ['decisions'] })
    },
  })

  if (isLoading) {
    return (
      <div className="flex justify-center mt-20">
        <Spinner size="lg" />
      </div>
    )
  }

  if (error) return <ErrorBanner message="Failed to load decisions" />

  const decisions = data?.data || []
  const metrics = metricsData?.data
  const total: number = data?.meta?.total ?? decisions.length
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1
  const showingTo = page * PAGE_SIZE + decisions.length

  // Export the FULL filtered set, not just the visible page — walk the
  // server pages (hard cap so a runaway firm can't hang the tab, but NEVER
  // silently: truncation and fallbacks are surfaced via exportNote).
  const EXPORT_CAP = 5000
  async function fetchAllForExport(): Promise<any[]> {
    const all: any[] = []
    const limit = 500
    for (let offset = 0; offset < EXPORT_CAP; offset += limit) {
      const resp = await decisionsApi.list({ ...filterParams, limit, offset })
      const rows = resp?.data ?? []
      all.push(...rows)
      const grandTotal = resp?.meta?.total ?? rows.length
      if (all.length >= grandTotal || rows.length < limit) break
    }
    return all
  }

  async function handleExport() {
    if (total === 0 || exporting) return
    setExporting(true)
    setExportNote('')
    try {
      const allRows = await fetchAllForExport()
      exportRows(allRows)
      if (total > allRows.length) {
        setExportNote(
          `Exported the first ${allRows.length.toLocaleString()} of ${total.toLocaleString()} decisions — apply filters to narrow the set for a complete export.`,
        )
      }
    } catch {
      // Fall back to exporting what's on screen rather than nothing — but say so.
      exportRows(decisions)
      setExportNote(`Full export failed — exported only the ${decisions.length} rows currently on screen.`)
    } finally {
      setExporting(false)
    }
  }

  function exportRows(source: any[]) {
    if (source.length === 0) return
    const rows = source.map((d: any) => ({
      opportunity: d.opportunity?.title ?? '',
      client: d.clientCompany?.name ?? '',
      agency: d.opportunity?.agency ?? '',
      naicsCode: d.opportunity?.naicsCode ?? '',
      setAside: d.opportunity?.setAsideType ?? '',
      recommendation: d.recommendation ?? '',
      decision: d.decision ?? '',
      winProbabilityPct: d.winProbability != null ? Math.round(Number(d.winProbability) * 100) : '',
      fitScore: d.fitScore ?? '',
      marketScore: d.marketScore ?? '',
      expectedValue: Math.round(Number(d.expectedValue ?? 0)),
      estimatedValue: Math.round(Number(d.opportunity?.estimatedValue ?? 0)),
      roiRatio: d.roiRatio != null ? Number(d.roiRatio).toFixed(2) : '',
      proposalCost: Math.round(Number(d.proposalCostEstimate ?? 0)),
      complianceStatus: d.complianceStatus ?? '',
      riskScore: d.riskScore ?? '',
      responseDeadline: d.opportunity?.responseDeadline
        ? new Date(d.opportunity.responseDeadline).toISOString().slice(0, 10)
        : '',
    }))
    exportCsv(rows, 'bid-decisions')
  }

  // Recommendation totals come from the DB-side /metrics aggregate — the
  // loaded page is capped, so counting the visible slice under-reports.
  const bidPrime = metrics?.totalPrime ?? decisions.filter((d: any) => d.recommendation === 'BID_PRIME').length
  const bidSub = metrics?.totalSub ?? decisions.filter((d: any) => d.recommendation === 'BID_SUB').length
  const noBid = metrics?.totalNoBid ?? decisions.filter((d: any) => d.recommendation === 'NO_BID').length
  const totalDecisions = metrics?.totalEvaluated ?? total

  return (
    <div>
      {showTutorial && <TutorialOverlay sectionKey="decisions" onClose={handleTutorialClose} />}
      <PageHeader
        title="Bid Decisions"
        subtitle="AI-powered bid/no-bid recommendations with compliance status"
      >
        {total > 0 && (
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={handleExport}
              disabled={exporting}
              className="btn-secondary flex items-center gap-2 text-sm disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              {exporting
                ? 'Exporting…'
                : `Export CSV${total > PAGE_SIZE ? ` (${Math.min(total, 5000).toLocaleString()}${total > 5000 ? ` of ${total.toLocaleString()}` : ''})` : ''}`}
            </button>
            {exportNote && <p className="text-xs text-amber-400 max-w-xs text-right">{exportNote}</p>}
          </div>
        )}
      </PageHeader>

      {/* Decisions to review — ranked shortlist of pending GO / NO-GO calls */}
      {(queueData?.data?.length ?? 0) > 0 && (
        <div className="card mb-8 border border-amber-800/40">
          <div className="flex items-center gap-2 mb-1">
            <Rocket className="w-4 h-4 text-amber-400" />
            <h2 className="font-semibold text-gray-100">Decisions to review</h2>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-900/40 text-amber-300">
              {queueData?.meta?.total ?? queueData?.data?.length} pending
            </span>
          </div>
          <p className="text-xs text-gray-500 mb-4">
            Top recommended bids awaiting your GO / NO-GO, ranked by fit × value × deadline. A GO moves it
            into the submission tracker so you can record the outcome.
          </p>
          <div className="space-y-2">
            {queueData.data.map((q: any) => {
              const days = q.daysToDeadline
              const fitPct = Math.round((q.winProbability ?? (q.fitScore ?? 0) / 100) * 100)
              return (
                <div key={q.id} className="flex items-center gap-3 py-2 border-b border-gray-800 last:border-0">
                  <div className="flex-1 min-w-0">
                    <Link to={`/opportunities/${q.opportunity?.id}`} className="text-sm text-blue-400 hover:text-blue-300 line-clamp-1">
                      {q.opportunity?.title || 'Opportunity'}
                    </Link>
                    <p className="text-xs text-gray-500 line-clamp-1">
                      {q.clientCompany?.name} · {q.opportunity?.agency} · {q.opportunity?.setAsideType || '—'}
                    </p>
                    <div className="flex items-center gap-3 mt-1 text-[11px]">
                      <span className="text-amber-300">{fitPct}/100 fit</span>
                      <span className="text-green-400 font-mono">{formatCurrency(Number(q.expectedValue ?? q.opportunity?.estimatedValue ?? 0))}</span>
                      <span className={`inline-flex items-center gap-1 ${days <= 7 ? 'text-red-400' : days <= 21 ? 'text-amber-400' : 'text-gray-500'}`}>
                        <Clock className="w-3 h-3" />{days}d
                      </span>
                      <span className={recStyles[q.recommendation]?.text}>{recStyles[q.recommendation]?.label}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => resolveMut.mutate({ id: q.id, decision: 'GO' })} disabled={resolvingId === q.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-green-900/50 border border-green-700 text-xs font-semibold text-green-300 hover:bg-green-900 disabled:opacity-50">
                      <ThumbsUp className="w-3.5 h-3.5" /> GO
                    </button>
                    <button onClick={() => resolveMut.mutate({ id: q.id, decision: 'NO_GO' })} disabled={resolvingId === q.id}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-red-900/40 border border-red-800 text-xs font-semibold text-red-300 hover:bg-red-900/70 disabled:opacity-50">
                      <ThumbsDown className="w-3.5 h-3.5" /> NO-GO
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 mb-8">
        <div className="card text-center">
          <p className="text-3xl font-bold text-gray-100">{totalDecisions}</p>
          <p className="text-xs text-gray-500">Total Decisions</p>
        </div>
        <div className="card text-center">
          <p className="text-3xl font-bold text-green-400">{bidPrime}</p>
          <p className="text-xs text-gray-500">Bid Prime</p>
        </div>
        <div className="card text-center">
          <p className="text-3xl font-bold text-blue-400">{bidSub}</p>
          <p className="text-xs text-gray-500">Bid Sub</p>
        </div>
        <div className="card text-center">
          <p className="text-3xl font-bold text-red-400">{noBid}</p>
          <p className="text-xs text-gray-500">No Bid</p>
        </div>
      </div>

      {/* Filters — client, NAICS, go/no-go */}
      <div className="card mb-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 mb-1">Client</label>
            <select
              value={filterClientId}
              onChange={(e) => { setFilterClientId(e.target.value); resetPage() }}
              className="input text-sm py-1.5 min-w-[180px]"
            >
              <option value="">All clients</option>
              {clientOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 mb-1">NAICS</label>
            <input
              value={filterNaics}
              onChange={(e) => { setFilterNaics(e.target.value.replace(/[^0-9]/g, '')); resetPage() }}
              placeholder="e.g. 5415"
              inputMode="numeric"
              maxLength={6}
              className="input text-sm py-1.5 w-[140px] font-mono"
            />
          </div>
          <div className="flex flex-col">
            <label className="text-xs text-gray-500 mb-1">Go / No-Go</label>
            <select
              value={filterDecision}
              onChange={(e) => { setFilterDecision(e.target.value); resetPage() }}
              className="input text-sm py-1.5 min-w-[150px]"
            >
              <option value="">All</option>
              <option value="GO">Go</option>
              <option value="NO_GO">No-Go</option>
              <option value="PENDING">Pending</option>
            </select>
          </div>
          {hasActiveFilters && (
            <button
              onClick={() => { setFilterClientId(''); setFilterNaics(''); setFilterDecision(''); resetPage() }}
              className="text-xs text-gray-400 hover:text-gray-200 underline pb-2"
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto text-xs text-gray-500 pb-2">
            {total <= PAGE_SIZE
              ? `${total} result${total === 1 ? '' : 's'}`
              : `Showing ${showingFrom}–${showingTo} of ${total}`}
          </span>
        </div>
      </div>

      {/* Decision List */}
      <div className="space-y-3">
        {decisions.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <p>
              {hasActiveFilters
                ? 'No decisions match your filters.'
                : 'No decisions yet. Run a portfolio evaluation to generate recommendations.'}
            </p>
          </div>
        ) : (
          decisions.map((d: any) => {
            const style = recStyles[d.recommendation] || recStyles.NO_BID
            const Icon = style.icon
            return (
              <div
                key={d.id}
                className={`rounded-lg p-4 ${style.bg} border border-gray-700`}
              >
                <div className="flex items-start gap-3">
                  <Icon className={`w-5 h-5 mt-0.5 ${style.text} flex-shrink-0`} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`text-sm font-bold ${style.text}`}>
                        {style.label}
                      </span>
                      <span
                        className={`text-[10px] px-2 py-0.5 rounded ${
                          complianceBadge[d.complianceStatus] || 'bg-gray-700 text-gray-400'
                        }`}
                      >
                        {d.complianceStatus}
                      </span>
                      {d.riskScore > 20 && (
                        <span className="text-[10px] px-2 py-0.5 rounded bg-red-900 text-red-300">
                          Risk: {d.riskScore}
                        </span>
                      )}
                    </div>

                    <Link
                      to={`/opportunities/${d.opportunity?.id}`}
                      className="text-sm text-blue-400 hover:text-blue-300 line-clamp-1 block mb-0.5"
                    >
                      {d.opportunity?.title || 'Unknown Opportunity'}
                    </Link>

                    <p className="text-xs text-gray-500">
                      {d.clientCompany?.name} · {d.opportunity?.agency}
                    </p>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3">
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase">Win Probability</p>
                        <ProbabilityBar probability={d.winProbability || 0} />
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase">Expected Value</p>
                        <p className="text-sm font-mono text-green-400">
                          {formatCurrency(Number(d.expectedValue || 0))}
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase">ROI Ratio</p>
                        <p className={`text-sm font-mono ${d.roiRatio > 3 ? 'text-green-400' : d.roiRatio > 1 ? 'text-yellow-400' : 'text-red-400'}`}>
                          {(d.roiRatio || 0).toFixed(1)}x
                        </p>
                      </div>
                      <div>
                        <p className="text-[10px] text-gray-500 uppercase">Proposal Cost</p>
                        <p className="text-sm font-mono text-gray-400">
                          {formatCurrency(Number(d.proposalCostEstimate || 0))}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Pagination — the API caps pages; without controls, rows past the cap were unreachable */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-4 mt-6">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="btn-secondary text-sm px-3 py-1.5 disabled:opacity-40"
          >
            ← Prev
          </button>
          <span className="text-xs text-gray-500">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="btn-secondary text-sm px-3 py-1.5 disabled:opacity-40"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

export default DecisionsPage
