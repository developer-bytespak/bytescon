// =============================================================
// Bid Decisions → Scorecard criteria: how much each criterion counts in the
// qualification scorecard, whether it must be scored before deciding, and
// whether it's used at all. Admins edit; everyone else reads.
//
// Backend: GET/PUT /api/qualification/criteria/config (routes/qualification.ts)
// — active weights must total exactly 100; past scorecards keep their own
// copy, so a change applies to scorecards started from now on.
// =============================================================
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader, RotateCcw, Save, SlidersHorizontal } from 'lucide-react'
import { qualificationApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'

interface Criterion { key: string; name: string; description: string | null; weight: number; required: boolean; displayOrder: number; isActive: boolean }

export function ScorecardCriteriaPage() {
  const isAdmin = useAuth().user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const query = useQuery<{ data: { criteria: Criterion[] } }>({ queryKey: ['scorecard-criteria'], queryFn: () => qualificationApi.getConfig() })
  const saved = useMemo(() => query.data?.data.criteria ?? [], [query.data])
  const [rows, setRows] = useState<Criterion[]>([])
  useEffect(() => { setRows(saved) }, [saved])

  const total = rows.filter((r) => r.isActive).reduce((s, r) => s + (Number.isFinite(r.weight) ? r.weight : 0), 0)
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved)
  const valid = total === 100 && rows.every((r) => Number.isInteger(r.weight) && r.weight >= 0 && r.weight <= 100)
  const set = (key: string, patch: Partial<Criterion>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  const save = useMutation({
    mutationFn: () => qualificationApi.saveConfig(rows.map((r, i) => ({ key: r.key, name: r.name, description: r.description ?? undefined, weight: r.weight, required: r.required, displayOrder: i + 1, isActive: r.isActive }))),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['scorecard-criteria'] }); toast('Scorecard criteria saved. New scorecards use them; past ones keep theirs.', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not save the criteria', 'error'),
  })

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      <PageHeader title="Scorecard criteria" subtitle="How much each criterion counts when qualifying a bid. Changes apply to scorecards started from now on; past scorecards keep their own." />
      {query.isLoading && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader className="w-4 h-4 animate-spin" /> Loading…</p>}
      {query.isError && <p className="text-sm text-red-400">Could not load the criteria.</p>}
      {rows.length > 0 && (
        <div className="card !p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500">
                <th className="px-4 py-2.5">Criterion</th>
                <th className="px-4 py-2.5 w-28">Weight</th>
                <th className="px-4 py-2.5 w-28" title="Must be scored before a decision can be recorded">Required</th>
                <th className="px-4 py-2.5 w-24">In use</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={`border-t border-gray-800 ${r.isActive ? '' : 'opacity-50'}`}>
                  <td className="px-4 py-2.5">
                    <p className="text-gray-200">{r.name}</p>
                    {r.description && <p className="text-xs text-gray-500 mt-0.5">{r.description}</p>}
                  </td>
                  <td className="px-4 py-2.5">
                    {isAdmin
                      ? <input type="number" min={0} max={100} step={1} value={Number.isFinite(r.weight) ? r.weight : ''} disabled={!r.isActive}
                          onChange={(e) => set(r.key, { weight: e.target.value === '' ? NaN : Number(e.target.value) })}
                          className="input !py-1 !w-20 tabular-nums" aria-label={`Weight for ${r.name}`} />
                      : <span className="tabular-nums text-gray-300">{r.weight}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <input type="checkbox" checked={r.required} disabled={!isAdmin || !r.isActive} onChange={(e) => set(r.key, { required: e.target.checked })} aria-label={`${r.name} is required`} />
                  </td>
                  <td className="px-4 py-2.5">
                    <input type="checkbox" checked={r.isActive} disabled={!isAdmin} onChange={(e) => set(r.key, { isActive: e.target.checked })} aria-label={`${r.name} is in use`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-gray-800 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
            <p className={`text-sm tabular-nums ${total === 100 ? 'text-green-400' : 'text-amber-400'}`} role="status">
              Total of weights in use: {total} / 100{total !== 100 && ` — ${total < 100 ? `add ${100 - total}` : `remove ${total - 100}`} to save`}
            </p>
            {isAdmin ? (
              <div className="flex gap-2">
                <button onClick={() => setRows(saved)} disabled={!dirty || save.isPending} className="btn-secondary btn-sm flex items-center gap-1.5 disabled:opacity-50"><RotateCcw className="w-3.5 h-3.5" /> Undo changes</button>
                <button onClick={() => save.mutate()} disabled={!dirty || !valid || save.isPending} className="btn-primary btn-sm flex items-center gap-1.5 disabled:opacity-50">
                  {save.isPending ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save criteria
                </button>
              </div>
            ) : <p className="text-xs text-gray-500 flex items-center gap-1.5"><SlidersHorizontal className="w-3.5 h-3.5" /> Only administrators can change these.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
