// =============================================================
// §8.4 — Cross-asset knowledge search.
//
// The panel states what the search is: a text match over the existing
// libraries. It does not call itself intelligent, and it renders each result's
// approval state as the server reported it, so "found" is never mistaken for
// "approved and usable in a proposal".
// =============================================================
import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search } from 'lucide-react'
import { humanize } from '../../lib/humanize'
import {
  knowledgeApi, KNOWLEDGE_RESULT_TYPES,
  type KnowledgeResult, type KnowledgeResultType, type KnowledgeSearchResponse,
} from '../../services/knowledgeApi'

const PAGE_SIZE = 25

const TYPE_LABELS: Record<KnowledgeResultType, string> = {
  CAPABILITY: 'Capability',
  CAPABILITY_NARRATIVE: 'Narrative',
  PAST_PERFORMANCE: 'Past performance',
  PERSONNEL: 'Person',
  PERSONNEL_RESUME: 'Resume',
  TEMPLATE: 'Template',
  STANDING_DOCUMENT: 'Standing document',
}

/** Green only where the state genuinely means approved evidence. */
function stateClass(state: string): string {
  if (/APPROVED|VERIFIED|ACTIVE|CPARS_(EXCEPTIONAL|VERY_GOOD)/.test(state) && !/NO_APPROVED|UNVERIFIED/.test(state)) {
    return 'chip-success'
  }
  if (/NO_APPROVED|UNVERIFIED|NO_CPARS|DRAFT/.test(state)) return 'badge-yellow'
  return 'chip-neutral'
}

export function KnowledgeSearch() {
  const [query, setQuery] = useState('')
  const [types, setTypes] = useState<KnowledgeResultType[]>([])
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<KnowledgeSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (nextOffset: number, nextTypes: KnowledgeResultType[]) => {
    if (query.trim().length === 0) return
    setLoading(true); setError(null)
    try {
      setData(await knowledgeApi.search({
        q: query.trim(),
        limit: PAGE_SIZE,
        offset: nextOffset,
        ...(nextTypes.length > 0 ? { types: nextTypes.join(',') } : {}),
      }))
      setOffset(nextOffset)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Search failed.')
    } finally { setLoading(false) }
  }, [query])

  const toggleType = (t: KnowledgeResultType) => {
    const next = types.includes(t) ? types.filter((x) => x !== t) : [...types, t]
    setTypes(next)
    void run(0, next)
  }

  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); void run(0, types) }} className="flex gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px] relative">
          <Search className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input aria-label="Search knowledge" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search capabilities, past performance, people, templates and documents"
            className="input w-full !pl-9" />
        </div>
        <button type="submit" disabled={loading || query.trim().length === 0}
          className="btn-primary disabled:opacity-50">
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      <div className="flex gap-2 flex-wrap">
        {KNOWLEDGE_RESULT_TYPES.map((t) => (
          <button key={t} onClick={() => toggleType(t)} aria-pressed={types.includes(t)}
            className="v3-tag">
            {TYPE_LABELS[t]}
            {data?.totalByType[t] !== undefined && ` ${data.totalByType[t]}`}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {data && (
        <>
          <p className="text-xs text-gray-500">{data.method}</p>

          {data.total === 0 ? (
            <div className="card text-center">
              <p className="text-sm text-gray-300">Nothing matched “{data.query}”.</p>
              <p className="text-xs text-gray-500 mt-1">
                This is a text search, so a record worded differently will not appear. Try a shorter or different term.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {data.results.map((r: KnowledgeResult) => (
                <Link key={`${r.type}:${r.id}`} to={r.sourceRoute}
                  className="card-interactive block !p-5">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-sm font-semibold text-gray-100">{r.title}</span>
                    <div className="flex gap-1.5 items-center">
                      <span className="chip chip-neutral">
                        {TYPE_LABELS[r.type]}
                      </span>
                      <span className={`chip ${stateClass(r.evidenceState)}`}>
                        {humanize(r.evidenceState)}
                      </span>
                    </div>
                  </div>
                  {r.summary && <p className="text-xs text-gray-500 mt-1">{r.summary}</p>}
                </Link>
              ))}
            </div>
          )}

          {data.total > PAGE_SIZE && (
            <div className="flex items-center justify-between text-sm text-gray-500">
              <button disabled={offset === 0 || loading} onClick={() => void run(Math.max(0, offset - PAGE_SIZE), types)}
                className="btn-secondary btn-sm disabled:opacity-40">
                Previous
              </button>
              <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} of {data.total}</span>
              <button disabled={offset + PAGE_SIZE >= data.total || loading} onClick={() => void run(offset + PAGE_SIZE, types)}
                className="btn-secondary btn-sm disabled:opacity-40">
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
