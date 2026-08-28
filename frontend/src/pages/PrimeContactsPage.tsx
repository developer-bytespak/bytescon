import { useState } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { Users, Mail, Trash2, RefreshCw, Search, X } from 'lucide-react'
import { subcontractingApi } from '../services/api'
import { PageHeader, Spinner } from '../components/ui'

/** Display names for SubcontractContact.source; unknown keys render raw. */
const SOURCE_LABELS: Record<string, string> = {
  sba_subnet: 'SBA SUBNet',
  sam_setaside: 'SAM.gov',
  manual: 'Added manually',
  dla_captains_of_industry: 'DLA directory',
  dod_csp_prime_directory: 'DoD CSP directory',
}

export function PrimeContactsPage() {
  const [search, setSearch] = useState('')
  const [agency, setAgency] = useState('')
  const [naicsCode, setNaicsCode] = useState('')
  const [pruneMsg, setPruneMsg] = useState('')

  const statsQuery = useQuery({
    queryKey: ['prime-contact-stats'],
    queryFn: () => subcontractingApi.contactStats(),
  })

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['prime-contacts', search, agency, naicsCode],
    queryFn: () => subcontractingApi.contacts({
      search: search || undefined,
      agency: agency || undefined,
      naicsCode: naicsCode || undefined,
      limit: 200,
    }),
  })

  const contacts: any[] = data?.data?.contacts ?? []
  const total: number = data?.data?.total ?? 0

  const stats = statsQuery.data?.data
  const distinctPrimes: number | undefined = stats?.distinctPrimes
  const statsTotal: number | undefined = stats?.total
  const subtitle =
    statsTotal != null && distinctPrimes != null
      ? `${statsTotal} contacts across ${distinctPrimes} primes`
      : `${total} prime contractor contacts`

  const clearFilters = () => { setSearch(''); setAgency(''); setNaicsCode('') }
  const anyFilter = !!(search || agency || naicsCode)

  const pruneMutation = useMutation({
    mutationFn: () => subcontractingApi.pruneContacts(),
    onSuccess: (res) => {
      const junk = res?.data?.junkDeleted ?? 0
      const stale = res?.data?.staleDeleted ?? 0
      setPruneMsg(`Removed ${junk} junk + ${stale} stale contacts.`)
      refetch()
      statsQuery.refetch()
      setTimeout(() => setPruneMsg(''), 8000)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => subcontractingApi.deleteContact(id),
    onSuccess: () => {
      refetch()
      statsQuery.refetch()
    },
  })

  const handleDelete = (c: any) => {
    const label = c.contactName || c.contactEmail || c.primeContractor || 'this contact'
    if (window.confirm(`Delete ${label}?`)) {
      deleteMutation.mutate(c.id)
    }
  }

  return (
    <div>
      <PageHeader title="Prime Contacts" subtitle={subtitle} />

      {/* Filters */}
      <div className="card mb-4 p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Users className="w-4 h-4" /><span>Filters</span>
          </div>
          <div className="flex items-center gap-3">
            {anyFilter && (
              <button onClick={clearFilters} className="text-sm text-gray-400 hover:text-red-400 flex items-center gap-1.5 font-medium transition-colors">
                <X className="w-3.5 h-3.5" /> Clear
              </button>
            )}
            <button
              onClick={() => pruneMutation.mutate()}
              disabled={pruneMutation.isPending}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-gray-800 border border-gray-700 text-sm text-gray-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${pruneMutation.isPending ? 'animate-spin' : ''}`} />
              {pruneMutation.isPending ? 'Cleaning...' : 'Run cleanup'}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          <div className="relative col-span-2">
            <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              className="input pl-9 w-full"
              placeholder="Search prime, contact, or email..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <input
            className="input"
            placeholder="Agency"
            value={agency}
            onChange={(e) => setAgency(e.target.value)}
          />
          <input
            className="input font-mono"
            placeholder="NAICS code"
            value={naicsCode}
            onChange={(e) => setNaicsCode(e.target.value)}
          />
        </div>
      </div>

      {pruneMsg && (
        <div className="mb-3 flex items-center gap-2 text-sm text-green-400">
          <RefreshCw className="w-3.5 h-3.5" />
          {pruneMsg}
        </div>
      )}

      {/* Info banner */}
      <div className="mb-4 px-4 py-2.5 rounded-lg bg-blue-900/20 border border-blue-700/40 text-xs text-blue-300">
        <strong>Auto-captured:</strong> Prime contractor contacts are collected automatically from subcontracting syncs.
        Use <strong>Run cleanup</strong> to drop junk entries and stale contacts.
      </div>

      {/* Loading bar for refetches */}
      {isFetching && !isLoading && (
        <div className="mb-4 w-full h-1 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full bg-amber-500 rounded-full animate-pulse" style={{ width: '60%' }} />
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : contacts.length === 0 ? (
        <div className="card text-center py-12">
          <Users className="w-10 h-10 text-gray-600 mx-auto mb-3" />
          <p className="text-gray-400 font-medium">No prime contacts yet.</p>
          <p className="text-sm text-gray-600 mt-1">
            Contacts are captured automatically each time you sync subcontracting opportunities.
          </p>
        </div>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Prime</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Contact</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Agency</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">NAICS</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Set-Aside</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Source</th>
                <th className="text-left px-4 py-3 text-gray-400 font-medium">Last seen</th>
                <th className="text-right px-4 py-3 text-gray-400 font-medium">Seen</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c: any) => (
                <tr key={c.id} className="border-b border-gray-800/60 hover:bg-gray-800/30 transition-colors">
                  <td className="px-4 py-3 max-w-48">
                    <p className="text-gray-200 font-medium truncate">{c.primeContractor}</p>
                    {c.primeContractorUei && (
                      <p className="text-xs font-mono text-gray-600 mt-0.5">UEI: {c.primeContractorUei}</p>
                    )}
                  </td>
                  <td className="px-4 py-3 max-w-56">
                    {c.contactName && <p className="text-gray-300 truncate">{c.contactName}</p>}
                    {c.contactEmail && (
                      <a href={`mailto:${c.contactEmail}`} className="text-blue-400 hover:text-blue-300 flex items-center gap-1.5 text-xs truncate">
                        <Mail className="w-3.5 h-3.5 flex-shrink-0" /> {c.contactEmail}
                      </a>
                    )}
                    {c.contactPhone && <p className="text-xs text-gray-500 mt-0.5">{c.contactPhone}</p>}
                    {!c.contactName && !c.contactEmail && !c.contactPhone && (
                      <span className="text-xs text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 max-w-36 truncate">{c.agency || '—'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-400">{c.naicsCode || '—'}</td>
                  <td className="px-4 py-3 text-gray-400">{c.setAside || '—'}</td>
                  <td className="px-4 py-3">
                    {c.source ? (
                      <span
                        className="inline-block px-2 py-0.5 rounded text-xs bg-gray-800 text-gray-300 border border-gray-700 whitespace-nowrap"
                        title={c.sourceUrl || undefined}
                      >
                        {SOURCE_LABELS[c.source] ?? c.source}
                      </span>
                    ) : (
                      <span className="text-xs text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-xs">
                    {c.lastSeenAt ? new Date(c.lastSeenAt).toLocaleDateString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300 tabular-nums">
                    {c.timesSeen != null ? `${c.timesSeen}x` : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => handleDelete(c)}
                      disabled={deleteMutation.isPending}
                      title="Delete contact"
                      className="text-gray-500 hover:text-red-400 transition-colors disabled:opacity-50"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
