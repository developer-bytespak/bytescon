import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { TutorialOverlay } from '../components/TutorialOverlay'
import { useTutorial } from '../hooks/useTutorial'
import { decisionsApi, clientsApi } from '../services/api'
import { useExportCsv } from '../hooks/useExportCsv'
import {
  PageHeader,
  PageSkeleton,
  ErrorBanner,
  EmptyState,
  StatCard,
  StatusPill,
  formatCurrency,
  ProbabilityBar,
} from '../components/ui'
import { Link } from 'react-router-dom'
import { useIsContractor } from '../hooks/useAuth'
import { ThumbsUp, ThumbsDown, Scale, Clock, Download } from 'lucide-react'
import { humanize } from '../lib/humanize'

const recStyles: Record<string, { bg: string; text: string; icon: any; label: string }> = {
  BID_PRIME: { bg: 'success', text: 'text-green-400', icon: ThumbsUp, label: 'Bid prime' },
  BID_SUB: { bg: 'neutral', text: 'text-gray-300', icon: Scale, label: 'Bid sub' },
  NO_BID: { bg: 'danger', text: 'text-red-400', icon: ThumbsDown, label: 'No bid' },
}

export function DecisionsPage() {
  const tutorial = useTutorial()
  const [showTutorial, setShowTutorial] = useState(() => !tutorial.hasSeen('decisions'))
  const isContractor = useIsContractor()
  function handleTutorialClose() { tutorial.markSeen('decisions'); setShowTutorial(false) }
  // ── Filters: client, NAICS, engine recommendation, go/no-go ───
  // The stat cards count the engine's recommendation (BID_PRIME/BID_SUB/NO_BID);
  // go/no-go is the separate human resolution, so each gets its own filter.
  const [filterClientId, setFilterClientId] = useState('')
  const [filterNaics, setFilterNaics] = useState('')
  const [filterRecommendation, setFilterRecommendation] = useState('')
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
    ...(filterRecommendation ? { recommendation: filterRecommendation } : {}),
    ...(filterDecision ? { decision: filterDecision } : {}),
  }
  const decisionParams = { ...filterParams, limit: PAGE_SIZE, offset: page * PAGE_SIZE }
  const hasActiveFilters = filterClientId !== '' || filterNaics.trim() !== '' || filterRecommendation !== '' || filterDecision !== ''

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
      <div>
        <span className="sr-only">Loading…</span>
        <PageSkeleton />
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
        title="Bid decisions"
        subtitle="The engine's bid/no-bid recommendations with compliance status. Record your own decision with Qualify."
      >
        {total > 0 && (
          <div className="flex flex-col items-end gap-1">
            <button
              onClick={handleExport}
              disabled={exporting}
              className="btn-secondary disabled:opacity-50"
            >
              <Download className="w-4 h-4" />
              {exporting
                ? 'Exporting…'
                : `Export CSV${total > PAGE_SIZE ? ` (${Math.min(total, 5000).toLocaleString()}${total > 5000 ? ` of ${total.toLocaleString()}` : ''})` : ''}`}
            </button>
            {exportNote && <p className="text-xs text-amber-500 max-w-xs text-right">{exportNote}</p>}
          </div>
        )}
      </PageHeader>

      {/* Decisions to review — ranked shortlist of pending GO / NO-GO calls */}
      {(queueData?.data?.length ?? 0) > 0 && (
        <div data-tour="decision-queue" className="v3-surface mb-8 animate-fade-up">
          <div className="flex flex-wrap items-center gap-2.5 mb-1">
            <h2 className="v3-h3 text-gray-100">Decisions to review</h2>
            <span className="chip tabular-nums">
              {queueData?.meta?.total ?? queueData?.data?.length} pending
            </span>
          </div>
          <p className="text-sm text-gray-400 mb-4 max-w-2xl">
            Top recommended bids awaiting your go or no-go, ranked by fit × value × deadline. A go moves it
            into the submission tracker so you can record the outcome.
          </p>
          <div className="stagger v3-rule-list">
            {queueData.data.map((q: any) => {
              const days = q.daysToDeadline
              const fitPct = Math.round((q.winProbability ?? (q.fitScore ?? 0) / 100) * 100)
              return (
                <div key={q.id} className="flex flex-wrap sm:flex-nowrap items-center gap-3 py-3.5">
                  <div className="flex-1 min-w-0">
                    <Link to={`/opportunities/${q.opportunity?.id}`} className="text-[15px] font-semibold text-gray-100 hover:underline underline-offset-2 line-clamp-1">
                      {q.opportunity?.title || 'Opportunity'}
                    </Link>
                    <p className="text-xs text-gray-500 line-clamp-1">
                      {q.clientCompany?.name} · {q.opportunity?.agency}{q.opportunity?.setAsideType && q.opportunity.setAsideType !== 'NONE' ? ` · ${humanize(q.opportunity.setAsideType)}` : ''}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs tabular-nums">
                      <span className="font-semibold text-gray-200">{fitPct}/100 fit</span>
                      <span className="text-gray-300">{formatCurrency(Number(q.expectedValue ?? q.opportunity?.estimatedValue ?? 0))}</span>
                      <span className={`inline-flex items-center gap-1 ${days <= 7 ? 'text-red-400' : days <= 21 ? 'text-amber-400' : 'text-gray-500'}`}>
                        <Clock className="w-3 h-3" />{days}d
                      </span>
                      {recStyles[q.recommendation] && <span className={`chip chip-${recStyles[q.recommendation].bg}`}>{recStyles[q.recommendation].label}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => resolveMut.mutate({ id: q.id, decision: 'GO' })} disabled={resolvingId === q.id}
                      className="btn-primary btn-sm disabled:opacity-50">
                      <ThumbsUp className="w-3.5 h-3.5" /> Go
                    </button>
                    <button onClick={() => resolveMut.mutate({ id: q.id, decision: 'NO_GO' })} disabled={resolvingId === q.id}
                      className="btn-secondary btn-sm disabled:opacity-50">
                      <ThumbsDown className="w-3.5 h-3.5" /> No-go
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Summary Cards */}
      <div className="stagger grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total decisions" value={totalDecisions} tone="neutral" icon={<Scale />} />
        <StatCard label="Bid prime" value={bidPrime} tone="success" icon={<ThumbsUp />} />
        <StatCard label="Bid sub" value={bidSub} tone="neutral" icon={<Scale />} />
        <StatCard label="No bid" value={noBid} tone="danger" icon={<ThumbsDown />} />
      </div>

      {/* Filters — client, NAICS, go/no-go */}
      <div className="card !py-4 mb-4">
        <div className="flex flex-wrap items-end gap-3">
          {/* A contractor account's only client is its own company: no filter. */}
          {!isContractor && (
          <div className="flex flex-col">
            <label className="label">Client</label>
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
          )}
          <div className="flex flex-col">
            <label className="label">NAICS</label>
            <input
              value={filterNaics}
              onChange={(e) => { setFilterNaics(e.target.value.replace(/[^0-9]/g, '')); resetPage() }}
              placeholder="e.g. 5415"
              inputMode="numeric"
              maxLength={6}
              className="input text-sm py-1.5 w-[140px] tabular-nums"
            />
          </div>
          <div className="flex flex-col">
            <label className="label">Recommendation</label>
            <select
              value={filterRecommendation}
              onChange={(e) => { setFilterRecommendation(e.target.value); resetPage() }}
              className="input text-sm py-1.5 min-w-[150px]"
            >
              <option value="">All</option>
              <option value="BID_PRIME">Bid prime</option>
              <option value="BID_SUB">Bid sub</option>
              <option value="NO_BID">No bid</option>
            </select>
          </div>
          <div className="flex flex-col">
            <label className="label">Your decision</label>
            <select
              value={filterDecision}
              onChange={(e) => { setFilterDecision(e.target.value); resetPage() }}
              className="input text-sm py-1.5 min-w-[150px]"
            >
              <option value="">All</option>
              <option value="GO">Go (approved)</option>
              <option value="NO_GO">No-go (declined)</option>
              <option value="PENDING">Awaiting decision</option>
            </select>
          </div>
          {hasActiveFilters && (
            <button
              onClick={() => { setFilterClientId(''); setFilterNaics(''); setFilterRecommendation(''); setFilterDecision(''); resetPage() }}
              className="text-xs text-gray-400 hover:text-gray-200 underline pb-2"
            >
              Clear filters
            </button>
          )}
          <span className="ml-auto text-xs text-gray-500 pb-2 tabular-nums">
            {total <= PAGE_SIZE
              ? `${total} result${total === 1 ? '' : 's'}`
              : `Showing ${showingFrom}–${showingTo} of ${total}`}
          </span>
        </div>
      </div>

      {/* Decision List */}
      <div className="stagger space-y-3">
        {decisions.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={<Scale />}
              hint={null}
              message={hasActiveFilters
                ? 'No decisions match your filters.'
                : 'No decisions yet. Run a portfolio evaluation to generate recommendations.'}
            />
          </div>
        ) : (
          decisions.map((d: any) => {
            const style = recStyles[d.recommendation] || recStyles.NO_BID
            const Icon = style.icon
            return (
              <div
                key={d.id}
                className="card !p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="tile tile-sm flex-shrink-0"><Icon className="w-4 h-4" /></span>
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1.5">
                      <span className={`chip chip-${style.bg}`}>
                        {style.label}
                      </span>
                      <StatusPill status={d.complianceStatus} />
                      {d.riskScore > 20 && (
                        <span className="chip chip-danger tabular-nums">
                          Risk: {d.riskScore}
                        </span>
                      )}
                    </div>

                    <Link
                      to={`/opportunities/${d.opportunity?.id}`}
                      className="text-[15px] font-semibold text-gray-100 hover:underline underline-offset-2 line-clamp-1 block mb-0.5"
                    >
                      {d.opportunity?.title || 'Unknown Opportunity'}
                    </Link>

                    <p className="text-xs text-gray-500">
                      {d.clientCompany?.name} · {d.opportunity?.agency}
                    </p>
                    {d.opportunity?.id && (
                      <Link to={`/opportunities/${d.opportunity.id}${d.clientCompany?.id ? `?client=${d.clientCompany.id}` : ''}#qualify`} className="v2-link !text-xs inline-block mt-1">
                        Qualify{d.clientCompany?.name ? ` for ${d.clientCompany.name}` : ''}
                      </Link>
                    )}

                    <div className="panel grid grid-cols-2 sm:grid-cols-4 gap-4 mt-3 px-3 py-2.5">
                      <div>
                        <p className="overline mb-1">Win probability</p>
                        <ProbabilityBar probability={d.winProbability || 0} />
                      </div>
                      <div>
                        <p className="overline mb-1">Expected value</p>
                        <p className="text-sm font-semibold tabular-nums text-gray-100">
                          {formatCurrency(Number(d.expectedValue || 0))}
                        </p>
                      </div>
                      <div>
                        <p className="overline mb-1">ROI ratio</p>
                        <p className={`text-sm font-semibold tabular-nums ${d.roiRatio > 1 ? 'text-gray-100' : 'text-red-400'}`}>
                          {(d.roiRatio || 0).toFixed(1)}x
                        </p>
                      </div>
                      <div>
                        <p className="overline mb-1">Proposal cost</p>
                        <p className="text-sm tabular-nums text-gray-300">
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
            Previous
          </button>
          <span className="text-xs text-gray-500 tabular-nums">
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="btn-secondary text-sm px-3 py-1.5 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

export default DecisionsPage
