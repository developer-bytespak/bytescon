import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation } from '@tanstack/react-query'
import { GitBranch, RefreshCw, ExternalLink, X, Mail, Building2, Filter } from 'lucide-react'
import { subcontractingApi } from '../services/api'
import { PageHeader, Spinner } from '../components/ui'

const SET_ASIDE_COLORS: Record<string, string> = {
  SDVOSB:       'bg-green-900/60 text-green-300 border border-green-700',
  '8(a)':       'bg-blue-900/60 text-blue-300 border border-blue-700',
  HUBZone:      'bg-purple-900/60 text-purple-300 border border-purple-700',
  WOSB:         'bg-pink-900/60 text-pink-300 border border-pink-700',
  SB:           'bg-amber-900/60 text-amber-300 border border-amber-700',
}

const SET_ASIDE_OPTIONS = ['SDVOSB', '8(a)', 'HUBZone', 'WOSB', 'SB']
const STATUS_OPTIONS    = ['OPEN', 'CLOSED', 'AWARDED']

function SetAsideBadge({ type }: { type: string | null }) {
  if (!type) return <span className="text-xs text-gray-600">Full & Open</span>
  const cls = SET_ASIDE_COLORS[type] || 'bg-gray-800 text-gray-300 border border-gray-600'
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cls}`}>{type}</span>
}

type ExpiryState = 'active' | 'expiring_soon' | 'expired'

const stateOf = (o: any): ExpiryState =>
  o.expiryState ?? (() => {
    if (!o.responseDeadline) return 'active'
    const d = new Date(o.responseDeadline).getTime()
    const now = Date.now()
    if (d < now) return 'expired'
    if (d <= now + 7 * 864e5) return 'expiring_soon'
    return 'active'
  })()

function ExpiryPill({ state }: { state: ExpiryState }) {
  if (state === 'expired')
    return <span className="bg-red-900/60 text-red-300 border border-red-700 text-[10px] px-2 py-0.5 rounded-full">EXPIRED</span>
  if (state === 'expiring_soon')
    return <span className="bg-amber-900/60 text-amber-300 border border-amber-700 text-[10px] px-2 py-0.5 rounded-full">Closing soon</span>
  return null
}

export function SubcontractingPage() {
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState(searchParams.get('search') || '')
  const [naicsCode, setNaicsCode] = useState(searchParams.get('naicsCode') || '')
  const [setAside, setSetAside] = useState(searchParams.get('setAside') || '')
  const [agency, setAgency] = useState(searchParams.get('agency') || '')
  const [status, setStatus] = useState(searchParams.get('status') || '')
  const [selected, setSelected] = useState<any | null>(null)
  const [syncMsg, setSyncMsg] = useState('')

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['subcontracting', search, naicsCode, setAside, agency, status],
    queryFn: () => subcontractingApi.list({
      search: search || undefined,
      naicsCode: naicsCode || undefined,
      setAside: setAside || undefined,
      agency: agency || undefined,
      status: status || undefined,
      limit: 100,
    }),
  })

  const clearFilters = () => { setSearch(''); setNaicsCode(''); setSetAside(''); setAgency(''); setStatus('') }
  const anyFilter = !!(search || naicsCode || setAside || agency || status)

  const syncMutation = useMutation({
    mutationFn: () => subcontractingApi.sync(),
    onSuccess: () => {
      setSyncMsg('Sync started — pulling subcontracting opportunities from SBA SUBNet, SAM.gov set-asides, and USAspending, plus the DLA and DoD published prime small-business-liaison directories into Prime Contacts.')
      // Auto-refresh at 15s and 45s to catch results as they land
      setTimeout(() => refetch(), 15000)
      setTimeout(() => { refetch(); setSyncMsg('') }, 45000)
    },
  })

  const saveToPipeline = useMutation({
    mutationFn: (id: string) => subcontractingApi.saveToPipeline(id),
    onSuccess: () => { setSyncMsg('Saved to pipeline — a pursuit was created. Track it under Pipeline.'); refetch() },
    onError: (e: any) => setSyncMsg(e?.response?.data?.error || 'Could not save to pipeline'),
  })
  const dismissMutation = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => subcontractingApi.dismiss(id, reason),
    onSuccess: () => { setSelected(null); refetch() },
    onError: (e: any) => setSyncMsg(e?.response?.data?.error || 'Could not dismiss'),
  })

  const opps: any[] = data?.data?.opportunities ?? []
  const total: number = data?.data?.total ?? 0

  return (
    <div>
      <PageHeader
        title="Subcontracting Opportunities"
        subtitle={`${total} open subcontracting roles from prime contractors`}
      />

      {/* Filters */}
      <div className="card mb-4 p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Filter className="w-4 h-4" /><span>Filters</span>
          </div>
          <div className="flex items-center gap-3">
            {anyFilter && (
              <button onClick={clearFilters} className="text-sm text-gray-400 hover:text-red-400 flex items-center gap-1.5 font-medium transition-colors">
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            )}
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncMutation.isPending ? 'animate-spin' : ''}`} />
              {syncMutation.isPending ? 'Syncing...' : 'Sync from SUBNet'}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <input
            className="input col-span-2 lg:col-span-2"
            placeholder="Search title or prime contractor..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <input
            className="input font-mono"
            placeholder="NAICS code"
            value={naicsCode}
            onChange={(e) => setNaicsCode(e.target.value)}
          />
          <input
            className="input"
            placeholder="Agency"
            value={agency}
            onChange={(e) => setAgency(e.target.value)}
          />
          <select className="input" value={setAside} onChange={(e) => setSetAside(e.target.value)}>
            <option value="">All set-asides</option>
            {SET_ASIDE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {syncMsg && (
        <div className="mb-3 flex items-center gap-2 text-sm text-green-400">
          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          {syncMsg}
        </div>
      )}

      {/* Info banner */}
      <div className="mb-4 px-4 py-2.5 rounded-lg bg-blue-900/20 border border-blue-700/40 text-xs text-blue-300">
        <strong>Data sources:</strong> USAspending.gov set-aside contracts · SAM.gov small-business opportunities · SBA SUBNet listings.
        Syncs automatically pull the last 180 days of set-aside contract activity filtered to your client NAICS codes.
      </div>

      {/* Expiry legend */}
      <div className="mb-2 flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-red-600" /> Expired (kept 7 days)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-amber-500" /> Closing soon
        </span>
      </div>

      {/* Loading bar for refetches */}
      {isFetching && !isLoading && (
        <div className="mb-4 w-full h-1 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-amber-500 rounded-full animate-pulse" style={{ width: '60%' }} />
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : opps.length === 0 ? (
        <div className="card text-center py-12">
          <GitBranch className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No subcontracting opportunities found.</p>
          <p className="text-sm text-gray-600 mt-1">Click <strong>Sync from SUBNet</strong> to pull the latest listings.</p>
          <button onClick={() => syncMutation.mutate()} disabled={syncMutation.isPending} className="btn-primary mt-4 text-sm">
            Sync Now
          </button>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Opportunity</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Prime Contractor</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Agency</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">NAICS</th>
                <th className="text-right px-4 py-3 text-gray-400 font-medium">Est. Value</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Deadline</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Set-Aside</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {opps.map((opp: any) => {
                const state = stateOf(opp)
                const rowState =
                  state === 'expired' ? ' opacity-60 border-l-2 border-l-red-600'
                  : state === 'expiring_soon' ? ' border-l-2 border-l-amber-500'
                  : ''
                const dlMs = opp.responseDeadline ? new Date(opp.responseDeadline).getTime() : null
                const daysExpired = dlMs != null ? Math.floor((Date.now() - dlMs) / 864e5) : null
                const daysLeft = dlMs != null ? Math.ceil((dlMs - Date.now()) / 864e5) : null
                return (
                <tr
                  key={opp.id}
                  className={`border-b border-gray-800/60 hover:bg-gray-800/30 transition-colors cursor-pointer${rowState}`}
                  onClick={() => setSelected(opp)}
                >
                  <td className="px-4 py-3 max-w-xs">
                    <div className="flex items-center gap-2">
                      <p className="text-gray-200 font-medium line-clamp-1">{opp.title}</p>
                      <ExpiryPill state={state} />
                    </div>
                    {opp.scrapedAt && <p className="text-xs text-gray-600 mt-0.5">Scraped {new Date(opp.scrapedAt).toLocaleDateString()}</p>}
                  </td>
                  <td className="px-4 py-3 text-gray-300 max-w-36 truncate">{opp.primeContractor}</td>
                  <td className="px-4 py-3 text-gray-400 max-w-36 truncate">{opp.agency || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{opp.naicsCode || '—'}</td>
                  <td className="px-4 py-3 text-right text-gray-300">
                    {opp.estimatedValue != null ? `$${Number(opp.estimatedValue).toLocaleString()}` : 'TBD'}
                  </td>
                  <td className={`px-4 py-3 text-xs ${state === 'expired' ? 'text-red-400' : state === 'expiring_soon' ? 'text-amber-400' : 'text-gray-400'}`}>
                    {opp.responseDeadline ? new Date(opp.responseDeadline).toLocaleDateString() : '—'}
                    {state === 'expired' && daysExpired != null && (
                      <span className="ml-1 text-red-400">(expired {daysExpired}d ago)</span>
                    )}
                    {state === 'expiring_soon' && daysLeft != null && (
                      <span className="ml-1 text-amber-400">({daysLeft}d left)</span>
                    )}
                  </td>
                  <td className="px-4 py-3"><SetAsideBadge type={opp.setAside} /></td>
                  <td className="px-4 py-3 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2 justify-end">
                      {opp.sourceUrl && (
                        <a href={opp.sourceUrl} target="_blank" rel="noopener noreferrer" title="Source" className="text-blue-400 hover:text-blue-300">
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      )}
                      {opp.savedOpportunityId ? (
                        <span className="text-[10px] text-green-400">In pipeline</span>
                      ) : (
                        <button disabled={saveToPipeline.isPending} onClick={() => saveToPipeline.mutate(opp.id)} title="Save to pipeline" className="text-[11px] text-gray-400 hover:text-blue-300 disabled:opacity-50">Save</button>
                      )}
                      <button
                        onClick={() => { const r = window.prompt('Reason for dismissing this lead?'); if (r && r.trim()) dismissMutation.mutate({ id: opp.id, reason: r.trim() }) }}
                        title="Dismiss" className="text-[11px] text-gray-500 hover:text-red-300">Dismiss</button>
                    </div>
                  </td>
                </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail slide-over */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={() => setSelected(null)}>
          <div className="absolute inset-0 bg-black/50" />
          <div
            className="relative w-full max-w-lg bg-gray-900 border-l border-gray-800 h-full overflow-y-auto p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-100 pr-4 leading-snug">{selected.title}</h2>
              <button onClick={() => setSelected(null)} className="text-gray-500 hover:text-gray-300 flex-shrink-0">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              <div className="flex flex-wrap gap-2 items-center">
                <SetAsideBadge type={selected.setAside} />
                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-300">
                  {selected.status}
                </span>
                <ExpiryPill state={stateOf(selected)} />
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Prime Contractor</p>
                  <p className="text-gray-200">{selected.primeContractor}</p>
                  {selected.primeContractorUei && <p className="text-xs font-mono text-gray-500">UEI: {selected.primeContractorUei}</p>}
                </div>
                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Agency</p>
                  <p className="text-gray-200">{selected.agency || '—'}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">NAICS Code</p>
                  <p className="text-gray-200 font-mono">{selected.naicsCode || '—'}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Est. Value</p>
                  <p className="text-gray-200">{selected.estimatedValue != null ? `$${Number(selected.estimatedValue).toLocaleString()}` : 'TBD'}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Response Deadline</p>
                  <p className="text-gray-200">{selected.responseDeadline ? new Date(selected.responseDeadline).toLocaleDateString() : '—'}</p>
                </div>
                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-0.5">Scraped</p>
                  <p className="text-gray-200">{new Date(selected.scrapedAt).toLocaleDateString()}</p>
                </div>
              </div>

              {selected.description && (
                <div>
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-1.5">Description</p>
                  <p className="text-sm text-gray-300 leading-relaxed">{selected.description}</p>
                </div>
              )}

              {(selected.contactName || selected.contactEmail) && (
                <div className="bg-gray-800/60 rounded-lg p-3 border border-gray-700">
                  <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Point of Contact</p>
                  {selected.contactName && (
                    <div className="flex items-center gap-2 text-sm text-gray-300">
                      <Building2 className="w-4 h-4 text-gray-500" />
                      {selected.contactName}
                    </div>
                  )}
                  {selected.contactEmail && (
                    <div className="flex items-center gap-2 text-sm mt-1">
                      <Mail className="w-4 h-4 text-gray-500" />
                      <a href={`mailto:${selected.contactEmail}`} className="text-blue-400 hover:text-blue-300">
                        {selected.contactEmail}
                      </a>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-3 pt-2">
                {selected.sourceUrl && (
                  <a
                    href={selected.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary flex items-center gap-2 text-sm"
                  >
                    <ExternalLink className="w-4 h-4" /> View Source
                  </a>
                )}
                {selected.contactEmail && (
                  <a
                    href={`mailto:${selected.contactEmail}?subject=Subcontracting Inquiry — ${selected.title}`}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-700"
                  >
                    <Mail className="w-4 h-4" /> Contact
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
