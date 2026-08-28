// =============================================================
// §8.3 — Knowledge hub.
//
// A navigation surface, not a new store. Capabilities, past performance,
// templates and standing documents keep their existing pages and their existing
// backend owners; this page links to them so the reusable assets are findable
// in one place. Only Personnel is new, so only Personnel is rendered here.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Award, FileText, FolderOpen, Layers, UserRound } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { ErrorPanel, LoadingPanel } from '../components/section6/Section6Ui'
import { KnowledgeSearch } from '../components/knowledge/KnowledgeSearch'
import { PersonnelSection } from '../components/knowledge/PersonnelSection'
import { personnelApi, type PersonnelSummary } from '../services/knowledgeApi'
import { useTabParam } from '../hooks/useTabParam'

type TabKey = 'overview' | 'search' | 'personnel'

const EXISTING_AREAS = [
  { to: '/discovery?tab=capabilities', icon: Layers, label: 'Capabilities', blurb: 'The capability library that drives opportunity matching.' },
  { to: '/past-performance-library', icon: Award, label: 'Past performance', blurb: 'Prior contracts, references and CPARS evidence.' },
  { to: '/templates', icon: FileText, label: 'Templates & forms', blurb: 'Capability statements, teaming agreements, NDAs and subcontracting plans.' },
  { to: '/document-library', icon: FolderOpen, label: 'Standing documents', blurb: 'Certifications, insurance and registration evidence.' },
]

export default function KnowledgePage() {
  const [tab, setTab] = useTabParam(['overview', 'search', 'personnel'] as const, 'overview')
  const [people, setPeople] = useState<PersonnelSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setPeople(await personnelApi.list()) }
    catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load personnel.')
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Knowledge"
        subtitle="The reusable assets a proposal is built from — capabilities, past performance, people, templates and standing documents."
      />

      <div className="border-b border-gray-800 flex gap-1 flex-wrap">
        {([['overview', 'Overview'], ['search', 'Search'], ['personnel', 'Personnel']] as Array<[TabKey, string]>).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-3 py-2 text-sm border-b-2 transition-colors ${
              tab === k ? 'border-amber-500 text-amber-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Link to="#" onClick={(e) => { e.preventDefault(); setTab('personnel') }}
              className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition-colors">
              <div className="flex items-center gap-2 mb-1">
                <UserRound className="w-4 h-4 text-gray-500" />
                <span className="text-sm font-medium text-gray-100">Personnel &amp; resumes</span>
              </div>
              <p className="text-[11px] text-gray-500">
                {loading ? 'Loading…' : `${people.length} person(s) · ${people.filter((p) => p.resumes.length > 0).length} with an approved resume`}
              </p>
            </Link>

            {EXISTING_AREAS.map((a) => (
              <Link key={a.to} to={a.to}
                className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition-colors">
                <div className="flex items-center gap-2 mb-1">
                  <a.icon className="w-4 h-4 text-gray-500" />
                  <span className="text-sm font-medium text-gray-100">{a.label}</span>
                </div>
                <p className="text-[11px] text-gray-500">{a.blurb}</p>
              </Link>
            ))}
          </div>
          <p className="text-[11px] text-gray-600">
            Capabilities, past performance, templates and standing documents keep their own pages. This hub links to
            them rather than holding a second copy of anything.
          </p>
        </div>
      )}

      {tab === 'search' && <KnowledgeSearch />}

      {/* The section renders even with nobody recorded — it carries the only
          controls for adding the first person, so hiding it behind a non-empty
          list made the library impossible to start. */}
      {tab === 'personnel' && (
        loading ? <LoadingPanel label="Loading personnel…" />
          : error ? <ErrorPanel message={error} onRetry={load} />
          : <PersonnelSection people={people} onChanged={load} />
      )}
    </div>
  )
}
