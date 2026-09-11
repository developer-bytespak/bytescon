// =============================================================
// Civilian Programs — public buying programs open to any commercial
// vendor, no SAM.gov registration or federal contractor status
// required. Fed by the hourly civilian_feed source sync: USAC E-Rate
// (FCC Form 470s — schools & libraries buying internet/IT services)
// and Rural Health Care service requests.
// =============================================================
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { School, ExternalLink } from 'lucide-react'
import { civilianApi } from '../services/api'
import { PageHeader, StatCard, EmptyState, Chip, Spinner, type Tone } from '../components/ui'

interface CivilianOpp {
  id: string
  title: string
  agency: string
  noticeType: string | null
  solicitationNumber: string | null
  responseDeadline: string | null
  placeOfPerformance: string | null
  sourceUrl: string | null
}

function daysLeft(deadline: string | null): { label: string; tone: Tone } | null {
  if (!deadline) return null
  const d = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000)
  if (d < 0) return { label: 'Closed', tone: 'neutral' }
  if (d <= 7) return { label: `${d}d left`, tone: 'danger' }
  if (d <= 30) return { label: `${d}d left`, tone: 'gold' }
  return { label: `${d}d left`, tone: 'success' }
}

export function CivilianProgramsPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['civilian-opps', search, page],
    queryFn: () => civilianApi.list({ search: search || undefined, page, limit: 25, sortBy: 'deadline', sortOrder: 'asc' }),
  })
  const opps: CivilianOpp[] = data?.data ?? []
  const total: number = data?.meta?.total ?? 0

  return (
    <div>
      <PageHeader
        title="Civilian Programs"
        subtitle="Public buying programs any commercial vendor can answer — no SAM.gov registration required."
        icon={<School />}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="Open requests" value={String(total)} />
        <StatCard label="Programs" value="E-Rate · RHC" sub="Schools, libraries & rural health buyers" />
        <StatCard label="Entry barrier" value="None" sub="Bid directly — no federal registration" />
      </div>

      <div className="mb-3">
        <input
          className="input w-full sm:w-80"
          placeholder="Search buyers or services…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          aria-label="Search civilian programs"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : opps.length === 0 ? (
        <div className="card"><EmptyState message="No open program requests match. The feeds refresh hourly." /></div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                  <th className="text-left font-medium px-5 py-3">Request</th>
                  <th className="text-left font-medium px-3 py-3">Buyer</th>
                  <th className="text-left font-medium px-3 py-3">Where</th>
                  <th className="text-left font-medium px-3 py-3">Bid window closes</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {opps.map((o) => {
                  const dl = daysLeft(o.responseDeadline)
                  return (
                    <tr key={o.id} className="table-row align-top">
                      <td className="px-5 py-3 max-w-[30rem]">
                        <p className="font-medium truncate" style={{ color: 'var(--text)' }}>{o.title}</p>
                        <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-faint)' }}>
                          {o.noticeType ?? '—'}{o.solicitationNumber ? ` · ${o.solicitationNumber}` : ''}
                        </p>
                      </td>
                      <td className="px-3 py-3 max-w-[16rem]"><p className="truncate" style={{ color: 'var(--text-2)' }}>{o.agency}</p></td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {o.placeOfPerformance ? <Chip tone="neutral">{o.placeOfPerformance}</Chip> : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {o.responseDeadline ? (
                          <div>
                            <p style={{ color: 'var(--text-2)' }}>{new Date(o.responseDeadline).toLocaleDateString()}</p>
                            {dl && <Chip tone={dl.tone} dot className="mt-1">{dl.label}</Chip>}
                          </div>
                        ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {o.sourceUrl && (
                          <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="icon-btn !w-7 !h-7" aria-label="Open source" title="Open source">
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-5 py-3 text-xs" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-faint)' }}>
            <span>Page {page} · {total} open requests</span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary !py-1.5 text-xs" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <button type="button" className="btn-secondary !py-1.5 text-xs" disabled={page * 25 >= total || isFetching} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
