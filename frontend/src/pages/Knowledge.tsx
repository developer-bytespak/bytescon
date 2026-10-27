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
import { PageHeader, SkeletonRows, TabIndicator } from '../components/ui'
import { ErrorPanel } from '../components/section6/Section6Ui'
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

      <div className="tabs">
        {([['overview', 'Overview'], ['search', 'Search'], ['personnel', 'Personnel']] as Array<[TabKey, string]>).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className="tab" data-active={tab === k}>
            {label}
            {tab === k && <TabIndicator id="knowledge" />}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-4">
          <div className="stagger grid grid-cols-1 md:grid-cols-2 gap-4">
            <Link to="#" onClick={(e) => { e.preventDefault(); setTab('personnel') }}
              className="card-interactive block">
              <div className="flex items-center gap-3 mb-2">
                <span className="tile tile-sm tile-accent"><UserRound className="w-4 h-4" /></span>
                <span className="text-sm font-medium text-gray-100">Personnel &amp; resumes</span>
              </div>
              <p className="text-xs text-gray-500 tabular-nums">
                {loading ? 'Loading…' : `${people.length} person(s) · ${people.filter((p) => p.resumes.length > 0).length} with an approved resume`}
              </p>
            </Link>

            {EXISTING_AREAS.map((a) => (
              <Link key={a.to} to={a.to}
                className="card-interactive block">
                <div className="flex items-center gap-3 mb-2">
                  <span className="tile tile-sm tile-neutral"><a.icon className="w-4 h-4" /></span>
                  <span className="text-sm font-medium text-gray-100">{a.label}</span>
                </div>
                <p className="text-xs text-gray-500">{a.blurb}</p>
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
        loading ? <div className="card"><span className="sr-only">Loading personnel…</span><SkeletonRows rows={4} cols={3} /></div>
          : error ? <ErrorPanel message={error} onRetry={load} />
          : <PersonnelSection people={people} onChanged={load} />
      )}
    </div>
  )
}
