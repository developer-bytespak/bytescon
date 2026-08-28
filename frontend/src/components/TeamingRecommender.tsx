// Teaming partner recommender (FIX-2). Pick an opportunity → get an
// explainable ranking of the firm's active partners by fit (NAICS,
// set-aside, capability, and prior-teaming track record). Turns the
// passive teaming graph into an actionable "team with X for this bid".
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { teamingApi, opportunitiesApi } from '../services/api'
import { Spinner, EmptyState } from './ui'
import { Search, Award } from 'lucide-react'

interface Factor {
  factor: string
  points: number
  detail: string
}
interface Recommendation {
  partnerId: string
  name: string
  uei: string | null
  cmmcLevel: number | null
  score: number
  factors: Factor[]
  matchedCapabilities: string[]
  matchingCapabilities?: string[]
  missingRequirements?: string[]
  certificationFit?: { required: string | null; met: boolean; detail: string }
  geographyFit?: { level: string; detail: string }
  whyRecommended?: string
  dataLimitations?: string[]
  insufficientData?: boolean
}
interface OppLite {
  id: string
  title: string
  agency: string
  naicsCode?: string
  setAsideType?: string
}

function ScoreBar({ score }: { score: number }) {
  const color = score >= 65 ? 'bg-emerald-500' : score >= 35 ? 'bg-amber-500' : 'bg-gray-600'
  return (
    <div className="w-full h-1.5 bg-gray-800 rounded overflow-hidden">
      <div className={`h-full ${color}`} style={{ width: `${Math.min(100, score)}%` }} />
    </div>
  )
}

export function TeamingRecommender() {
  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [selected, setSelected] = useState<OppLite | null>(null)

  const { data: searchData, isFetching: searching } = useQuery({
    queryKey: ['teaming-opp-search', submitted],
    queryFn: () => opportunitiesApi.search({ search: submitted, limit: 8 }),
    enabled: submitted.trim().length >= 2,
  })

  const { data: recData, isFetching: loadingRecs } = useQuery({
    queryKey: ['teaming-recommend', selected?.id],
    queryFn: () => teamingApi.recommend(selected!.id),
    enabled: !!selected,
  })

  const opps: OppLite[] = searchData?.data?.opportunities ?? searchData?.data ?? []
  const recs: Recommendation[] = recData?.data?.recommendations ?? []

  return (
    <div className="card mb-6">
      <div className="flex items-center gap-2 mb-3">
        <Award className="w-4 h-4 text-amber-400" />
        <h2 className="text-sm font-semibold text-gray-200">Recommend partners for a bid</h2>
      </div>

      <form
        className="flex gap-2 mb-3"
        onSubmit={(e) => {
          e.preventDefault()
          setSelected(null)
          setSubmitted(query)
        }}
      >
        <input
          className="input flex-1"
          placeholder="Search an opportunity by title or agency…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="btn-secondary flex items-center gap-2">
          <Search className="w-4 h-4" /> Search
        </button>
      </form>

      {/* Opportunity picker */}
      {!selected && submitted.trim().length >= 2 && (
        <div className="mb-2">
          {searching ? (
            <Spinner size="sm" />
          ) : opps.length === 0 ? (
            <p className="text-xs text-gray-500">No opportunities match “{submitted}”.</p>
          ) : (
            <ul className="divide-y divide-gray-800 border border-gray-800 rounded">
              {opps.map((o) => (
                <li key={o.id}>
                  <button
                    className="w-full text-left px-3 py-2 hover:bg-gray-800/50"
                    onClick={() => setSelected(o)}
                  >
                    <div className="text-sm text-gray-100">{o.title}</div>
                    <div className="text-xs text-gray-500">
                      {o.agency}
                      {o.naicsCode ? ` · NAICS ${o.naicsCode}` : ''}
                      {o.setAsideType && o.setAsideType !== 'NONE' ? ` · ${o.setAsideType}` : ''}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Recommendations */}
      {selected && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-gray-400">
              Ranking partners for <span className="text-gray-200">{selected.title}</span>
            </div>
            <button className="text-xs text-gray-500 hover:text-gray-300" onClick={() => setSelected(null)}>
              Change opportunity
            </button>
          </div>
          {loadingRecs ? (
            <Spinner />
          ) : recs.length === 0 ? (
            <EmptyState message="No active partners to rank. Add partners first." />
          ) : (
            <div className="space-y-3">
              {recs.map((r) => (
                <div key={r.partnerId} className="border border-gray-800 rounded p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-sm text-gray-100">
                      {r.name}
                      {r.cmmcLevel ? <span className="text-xs text-gray-500 ml-2">CMMC L{r.cmmcLevel}</span> : null}
                    </div>
                    <div className="text-sm font-mono text-gray-200">{r.score}/100</div>
                  </div>
                  <ScoreBar score={r.score} />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-2">
                    {r.factors.map((f) => (
                      <div key={f.factor} className="text-xs">
                        <div className="flex justify-between text-gray-400">
                          <span>{f.factor}</span>
                          <span className="font-mono">{f.points}</span>
                        </div>
                        <div className="text-gray-600">{f.detail}</div>
                      </div>
                    ))}
                  </div>
                  {r.insufficientData && (
                    <p className="text-[11px] text-yellow-400 mt-2">⚠ Insufficient partner data to assess fit — add NAICS, capabilities, or certifications.</p>
                  )}
                  {r.whyRecommended && !r.insufficientData && <p className="text-[11px] text-gray-400 mt-2">{r.whyRecommended}</p>}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2 text-[11px]">
                    {(r.matchingCapabilities ?? r.matchedCapabilities)?.length ? (
                      <div><span className="text-gray-500">Matching capabilities:</span> <span className="text-green-400">{(r.matchingCapabilities ?? r.matchedCapabilities).join(', ')}</span></div>
                    ) : null}
                    {r.missingRequirements?.length ? (
                      <div><span className="text-gray-500">Missing requirements:</span> <span className="text-orange-400">{r.missingRequirements.join('; ')}</span></div>
                    ) : null}
                    {r.certificationFit && (
                      <div><span className="text-gray-500">Certification fit:</span> <span className={r.certificationFit.met ? 'text-green-400' : 'text-orange-400'}>{r.certificationFit.detail}</span></div>
                    )}
                    {r.geographyFit && (
                      <div><span className="text-gray-500">Geography fit:</span> <span className="text-gray-400">{r.geographyFit.level} — {r.geographyFit.detail}</span></div>
                    )}
                  </div>
                  {r.dataLimitations?.length ? (
                    <p className="text-[10px] text-gray-600 mt-1.5">Data limitations: {r.dataLimitations.join(' ')}</p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default TeamingRecommender
