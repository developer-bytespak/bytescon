// =============================================================
// Commercial — US bids any commercial company can bid on, outside SAM.gov.
// Fed by the hourly source sync of the COMMERCIAL adapters: LA RAMP,
// Delaware Bids, Montgomery County MD, TxDOT lettings and USAC (E-Rate
// Form 470, Rural Health Care). Each row is
// a normal Opportunity, so "Open in Bytescon" leads to the full pipeline
// (Bid / No-Bid, proposal, pricing, client review).
// =============================================================
import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Globe2, ExternalLink, Mail, ChevronDown, ChevronRight, ArrowRight } from 'lucide-react'
import { commercialApi } from '../services/api'
import { PageHeader, StatCard, EmptyState, Chip, SkeletonRows, type Tone } from '../components/ui'

interface CommercialOpp {
  id: string
  title: string
  agency: string
  noticeType: string | null
  solicitationNumber: string | null
  responseDeadline: string | null
  placeOfPerformance: string | null
  sourceUrl: string | null
  description: string | null
  sourceMetadata?: {
    provider?: string
    value?: number | null
    currency?: string | null
    cpv?: { code?: string | null; description?: string | null } | string | null
    procurementMethod?: string | null
    category?: string | null
    unspsc?: string | null
    contact?: { name?: string | null; email?: string | null; phone?: string | null }
  } | null
}

const PROVIDERS: Record<string, string> = {
  'rampla.org': 'Los Angeles RAMP',
  'mmp.delaware.gov': 'Delaware Bids',
  'montgomerycountymd.gov': 'Montgomery County, MD',
  'txdot.gov': 'TxDOT',
  'usac.org/e-rate': 'USAC E-Rate',
  'usac.org/rural-health-care': 'USAC Rural Health Care',
}

function providerLabel(o: CommercialOpp): string {
  return PROVIDERS[o.sourceMetadata?.provider ?? ''] ?? 'Commercial'
}

function valueText(o: CommercialOpp): string | null {
  const m = o.sourceMetadata
  if (m?.value == null) return null
  return `${Number(m.value).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${m.currency ?? ''}`.trim()
}

function detailFacts(o: CommercialOpp): Array<[string, string]> {
  const m = o.sourceMetadata ?? {}
  const cpv = typeof m.cpv === 'string' ? m.cpv : m.cpv ? [m.cpv.code, m.cpv.description].filter(Boolean).join(' — ') : null
  const facts: Array<[string, string | null | undefined]> = [
    ['Source', providerLabel(o)],
    ['Estimated value', valueText(o)],
    ['Category (CPV)', cpv],
    ['Category', m.category],
    ['Commodity (UNSPSC)', m.unspsc],
    ['Procurement method', m.procurementMethod],
    ['Reference', o.solicitationNumber],
  ]
  return facts.filter((f): f is [string, string] => Boolean(f[1] && String(f[1]).trim()))
}

function daysLeft(deadline: string | null): { label: string; tone: Tone } | null {
  if (!deadline) return null
  const d = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000)
  if (d < 0) return { label: 'Closed', tone: 'neutral' }
  if (d <= 7) return { label: `${d}d left`, tone: 'danger' }
  if (d <= 30) return { label: `${d}d left`, tone: 'gold' }
  return { label: `${d}d left`, tone: 'success' }
}

export function CommercialOpportunitiesPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['commercial-opps', search, page],
    queryFn: () => commercialApi.list({ search: search || undefined, status: 'ACTIVE', page, limit: 25, sortBy: 'deadline', sortOrder: 'asc' }),
  })
  const opps: CommercialOpp[] = data?.data ?? []
  const total: number = data?.meta?.total ?? 0

  return (
    <div>
      <PageHeader
        title="Commercial"
        subtitle="US bids any company can respond to — city, county and state buyers, TxDOT, and schools, libraries and rural hospitals via USAC. No SAM.gov registration required."
        icon={<Globe2 />}
      />

      <div className="stagger grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatCard label="Open tenders" value={String(total)} tone="accent" />
        <StatCard label="Sources" value="6 US feeds" sub="LA · Delaware · Montgomery Co. · TxDOT · USAC (2) — refreshed hourly" />
        <StatCard label="Coverage" value="United States" sub="All values in USD" />
      </div>

      <div className="mb-4">
        <input
          className="input w-full sm:w-80"
          placeholder="Search tenders, buyers or countries…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          aria-label="Search commercial tenders"
        />
      </div>

      {isLoading ? (
        <div className="card !p-0"><span className="sr-only">Loading…</span><SkeletonRows rows={8} cols={5} /></div>
      ) : opps.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={<Globe2 />}
            message="No commercial bids yet. Add Los Angeles RAMP, Delaware Bids, Montgomery County MD, TxDOT Lettings, USAC E-Rate or USAC Rural Health Care under Discovery → Sources and run a sync."
          />
        </div>
      ) : (
        <div className="card !p-0 overflow-hidden animate-fade-in">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                  <th className="text-left font-medium px-5 py-3">Tender</th>
                  <th className="text-left font-medium px-3 py-3">Buyer</th>
                  <th className="text-left font-medium px-3 py-3">Where</th>
                  <th className="text-left font-medium px-3 py-3">Deadline</th>
                  <th className="text-left font-medium px-3 py-3">Value</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {opps.map((o) => {
                  const dl = daysLeft(o.responseDeadline)
                  const expanded = open === o.id
                  const contact = o.sourceMetadata?.contact ?? {}
                  const value = valueText(o)
                  return (
                    <Fragment key={o.id}>
                      <tr className="table-row align-top cursor-pointer" style={expanded ? { background: 'var(--surface-2)' } : undefined} onClick={() => setOpen(expanded ? null : o.id)}>
                        <td className="px-5 py-3 max-w-[30rem]">
                          <div className="flex items-start gap-1.5">
                            {expanded
                              ? <ChevronDown className="w-3.5 h-3.5 mt-1 flex-shrink-0" style={{ color: 'var(--accent-3)' }} />
                              : <ChevronRight className="w-3.5 h-3.5 mt-1 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />}
                            <div className="min-w-0">
                              <p className="font-medium truncate" style={{ color: 'var(--text)' }} title={o.title}>{o.title}</p>
                              <p className="text-[11px] mt-0.5 flex flex-wrap items-center gap-1.5" style={{ color: 'var(--text-faint)' }}>
                                <Chip tone="accent">{providerLabel(o)}</Chip>
                                <span className="font-mono">{o.noticeType ?? '—'}</span>
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3 max-w-[16rem]"><p className="truncate" style={{ color: 'var(--text-2)' }}>{o.agency}</p></td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {o.placeOfPerformance ? <Chip tone="neutral">{o.placeOfPerformance}</Chip> : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap">
                          {o.responseDeadline ? (
                            <div>
                              <p className="tabular-nums" style={{ color: 'var(--text-2)' }}>{new Date(o.responseDeadline).toLocaleDateString()}</p>
                              {dl && <Chip tone={dl.tone} dot className="mt-1">{dl.label}</Chip>}
                            </div>
                          ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                        </td>
                        <td className="px-3 py-3 whitespace-nowrap tabular-nums" style={{ color: 'var(--text-2)' }}>{value ?? <span style={{ color: 'var(--text-dim)' }}>—</span>}</td>
                        <td className="px-3 py-3 text-right">
                          {o.sourceUrl && (
                            <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="icon-btn !w-7 !h-7" aria-label="Open source" title="Open source" onClick={(e) => e.stopPropagation()}>
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={6} className="px-5 pb-4 pt-0" style={{ background: 'var(--surface-2)' }}>
                            <div className="pt-3 grid gap-4 md:grid-cols-3 animate-fade-in">
                              <div className="md:col-span-2">
                                <p className="overline mb-1.5">Scope</p>
                                <p className="text-sm whitespace-pre-line leading-relaxed max-h-64 overflow-y-auto" style={{ color: 'var(--text-2)' }}>
                                  {o.description || 'No description in the notice — open the source for the full tender documents.'}
                                </p>
                              </div>
                              <div>
                                <p className="overline mb-1.5">Details</p>
                                <dl className="space-y-1 text-xs">
                                  {detailFacts(o).map(([k, v]) => (
                                    <div key={k} className="flex gap-2">
                                      <dt className="flex-shrink-0" style={{ color: 'var(--text-faint)' }}>{k}:</dt>
                                      <dd style={{ color: 'var(--text-2)' }}>{v.slice(0, 120)}</dd>
                                    </div>
                                  ))}
                                </dl>
                                {contact.email && (
                                  <a href={`mailto:${contact.email}`} className="inline-flex items-center gap-1.5 text-xs mt-3" style={{ color: 'var(--accent-3)' }}>
                                    <Mail className="w-3.5 h-3.5" /> {contact.name || contact.email}
                                  </a>
                                )}
                                <Link to={`/opportunities/${o.id}`} className="btn-primary btn-sm mt-4 inline-flex items-center gap-1.5">
                                  Open in Bytescon <ArrowRight className="w-3.5 h-3.5" />
                                </Link>
                                <p className="text-[11px] mt-1.5" style={{ color: 'var(--text-faint)' }}>Bid / No-Bid, proposal, pricing and client review.</p>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-faint)' }}>
            <span className="tabular-nums">Page {page} · {total} open tenders</span>
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
