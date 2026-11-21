import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { monitoringProfilesApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from './Toast'
import { Spinner } from './ui'
import { Bookmark, Plus, Copy, Archive, ArchiveRestore, Power, Pencil, Check, X, RefreshCw } from 'lucide-react'

// Page filter state is all strings; profile filters are typed JSON. These two
// helpers keep the mapping in one place (used by the page for restore/save too).
export type PageFilters = Record<string, string | number>
export type ProfileFilters = Record<string, string | number | boolean>

const STRING_KEYS = ['naicsCode', 'agency', 'setAsideType', 'status', 'keywords', 'placeOfPerformance', 'contractVehicle', 'vehicleType', 'postedAfter', 'postedBefore', 'dueBefore']
const NUMBER_KEYS = ['estimatedValueMin', 'estimatedValueMax', 'daysUntilDeadline']
const BOOL_KEYS = ['recompeteOnly', 'enrichedOnly', 'hasVehicle']
// Deadline: 'expired' or 'all'; blank means open. Older profiles saved showExpired: true (= all).
const DEADLINES = ['expired', 'all']

export function profileFiltersToPage(pf: ProfileFilters | null | undefined): PageFilters {
  const out: PageFilters = {}
  if (!pf) return out
  for (const k of STRING_KEYS) if (pf[k] != null && pf[k] !== '') out[k] = String(pf[k])
  for (const k of NUMBER_KEYS) if (pf[k] != null) out[k] = String(pf[k])
  for (const k of BOOL_KEYS) out[k] = pf[k] ? 'true' : ''
  out.deadline = DEADLINES.includes(String(pf.deadline)) ? String(pf.deadline) : pf.showExpired ? 'all' : ''
  return out
}
export function pageFiltersToProfile(page: PageFilters): ProfileFilters {
  const out: ProfileFilters = {}
  for (const k of STRING_KEYS) { const v = page[k]; if (v != null && String(v).trim() !== '') out[k] = String(v) }
  for (const k of NUMBER_KEYS) { const v = page[k]; if (v != null && String(v).trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v) }
  for (const k of BOOL_KEYS) { if (page[k] === 'true') out[k] = true }
  if (DEADLINES.includes(String(page.deadline))) out.deadline = String(page.deadline)
  return out
}

const FREQS = ['DISABLED', 'INSTANT', 'DAILY', 'WEEKLY'] as const
const freqTone: Record<string, string> = {
  INSTANT: 'chip-neutral',
  DAILY: 'chip-neutral',
  WEEKLY: 'chip-neutral',
  DISABLED: 'chip-neutral text-gray-500',
}

interface Profile { id: string; name: string; description: string | null; filters: ProfileFilters; alertFrequency: string; isActive: boolean; isArchived: boolean; lastResultCount: number | null }

interface Props {
  pageFilters: PageFilters
  activeProfileId: string | null
  onApply: (profileId: string, pagePartial: PageFilters) => void
}

export function MonitoringProfiles({ pageFilters, activeProfileId, onApply }: Props) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const q = useQuery<{ data: Profile[] }>({ queryKey: ['monitoring-profiles', includeArchived], queryFn: () => monitoringProfilesApi.list({ includeArchived: includeArchived ? 'true' : undefined }) })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['monitoring-profiles'] })
  const onError = (e: unknown) => toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Action failed', 'error')

  const create = useMutation({ mutationFn: (p: Record<string, unknown>) => monitoringProfilesApi.create(p), onSuccess: () => { invalidate(); setCreating(false); toast('Profile saved', 'success') }, onError })
  const update = useMutation({ mutationFn: ({ id, p }: { id: string; p: Record<string, unknown> }) => monitoringProfilesApi.update(id, p), onSuccess: () => { invalidate(); setEditingId(null); toast('Profile updated', 'success') }, onError })
  const duplicate = useMutation({ mutationFn: (id: string) => monitoringProfilesApi.duplicate(id), onSuccess: () => { invalidate(); toast('Profile duplicated', 'success') }, onError })
  const setActive = useMutation({ mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => monitoringProfilesApi.setActive(id, isActive), onSuccess: invalidate, onError })
  const archive = useMutation({ mutationFn: (id: string) => monitoringProfilesApi.archive(id), onSuccess: () => { invalidate(); toast('Archived', 'success') }, onError })
  const restore = useMutation({ mutationFn: (id: string) => monitoringProfilesApi.restore(id), onSuccess: () => { invalidate(); toast('Restored', 'success') }, onError })
  const refreshCount = useMutation({ mutationFn: (id: string) => monitoringProfilesApi.count(id), onSuccess: invalidate, onError })

  const profiles = q.data?.data ?? []
  const busy = create.isPending || update.isPending || duplicate.isPending || archive.isPending || restore.isPending

  return (
    <div className="card mb-4" data-testid="monitoring-profiles">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 text-left">
        <Bookmark className="w-4 h-4 text-gray-400" />
        <span className="font-semibold text-gray-200 text-sm">Saved monitoring profiles</span>
        {profiles.length > 0 && <span className="text-xs text-gray-500 tabular-nums">{profiles.filter((p) => !p.isArchived).length}</span>}
        <span className="ml-auto btn-secondary btn-sm">{open ? 'Hide' : 'Show'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          {isAdmin && (
            <div className="flex items-center gap-2">
              <button onClick={() => setCreating((v) => !v)} className="btn-secondary btn-sm"><Plus className="w-3.5 h-3.5" /> Save current filters</button>
              <label className="text-[11px] text-gray-500 flex items-center gap-1 ml-auto"><input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} /> Show archived</label>
            </div>
          )}

          {creating && isAdmin && <ProfileForm submitting={create.isPending} onCancel={() => setCreating(false)} onSubmit={(vals) => create.mutate({ ...vals, filters: pageFiltersToProfile(pageFilters) })} />}

          {q.isLoading ? (
            <div className="py-4 flex justify-center"><Spinner size="sm" /></div>
          ) : q.error ? (
            <p className="text-xs text-red-400">Could not load profiles.</p>
          ) : profiles.length === 0 ? (
            <p className="text-sm text-gray-500">No saved profiles yet. Set some filters below, then “Save current filters”.</p>
          ) : (
            <ul className="space-y-1.5">
              {profiles.map((p) => editingId === p.id && isAdmin ? (
                <li key={p.id}><ProfileForm initial={p} submitting={update.isPending} onCancel={() => setEditingId(null)} onSubmit={(vals, useCurrent) => update.mutate({ id: p.id, p: { ...vals, ...(useCurrent ? { filters: pageFiltersToProfile(pageFilters) } : {}) } })} /></li>
              ) : (
                <li key={p.id} className={`panel p-3 ${p.id === activeProfileId ? '!border-[color:var(--accent-line)]' : ''} ${p.isArchived ? 'opacity-60' : ''}`}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-gray-200">{p.name}</span>
                    <span className={`chip ${freqTone[p.alertFrequency]}`}>{p.alertFrequency === 'DISABLED' ? 'No alerts' : p.alertFrequency.charAt(0) + p.alertFrequency.slice(1).toLowerCase()}</span>
                    {!p.isActive && !p.isArchived && <span className="chip text-gray-500">Inactive</span>}
                    {p.isArchived && <span className="chip text-gray-500">Archived</span>}
                    {p.lastResultCount != null && <span className="text-[10px] text-gray-500">{p.lastResultCount} match{p.lastResultCount === 1 ? '' : 'es'}</span>}
                  </div>
                  {p.description && <p className="text-[11px] text-gray-500 mt-0.5">{p.description}</p>}
                  <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                    {!p.isArchived && <button onClick={() => onApply(p.id, profileFiltersToPage(p.filters))} className="btn-primary btn-sm">Apply</button>}
                    {!p.isArchived && <button disabled={refreshCount.isPending} onClick={() => refreshCount.mutate(p.id)} className="btn-ghost btn-sm !min-h-[28px] !px-2.5 !text-xs" title="Refresh match count"><RefreshCw className="w-3 h-3" /> Count</button>}
                    {isAdmin && !p.isArchived && <>
                      <button onClick={() => setEditingId(p.id)} className="btn-ghost btn-sm !min-h-[28px] !px-2.5 !text-xs"><Pencil className="w-3 h-3" /> Edit</button>
                      <button disabled={busy} onClick={() => duplicate.mutate(p.id)} className="btn-ghost btn-sm !min-h-[28px] !px-2.5 !text-xs"><Copy className="w-3 h-3" /> Duplicate</button>
                      <button disabled={busy} onClick={() => setActive.mutate({ id: p.id, isActive: !p.isActive })} className="btn-ghost btn-sm !min-h-[28px] !px-2.5 !text-xs"><Power className="w-3 h-3" /> {p.isActive ? 'Deactivate' : 'Activate'}</button>
                      <button disabled={busy} onClick={() => archive.mutate(p.id)} className="btn-ghost btn-sm !min-h-[28px] !px-2.5 !text-xs"><Archive className="w-3 h-3" /> Archive</button>
                    </>}
                    {isAdmin && p.isArchived && <button disabled={busy} onClick={() => restore.mutate(p.id)} className="btn-ghost btn-sm !min-h-[28px] !px-2.5 !text-xs"><ArchiveRestore className="w-3 h-3" /> Restore</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function ProfileForm({ initial, submitting, onSubmit, onCancel }: { initial?: Profile; submitting: boolean; onSubmit: (vals: Record<string, unknown>, useCurrentFilters: boolean) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial?.name ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [alertFrequency, setAlertFrequency] = useState(initial?.alertFrequency ?? 'DISABLED')
  const [useCurrent, setUseCurrent] = useState(!initial) // create always uses current; edit optional
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!name.trim()) return; onSubmit({ name: name.trim(), description: description.trim() || null, alertFrequency }, useCurrent) }} className="bg-gray-900/50 border border-gray-800 rounded-lg p-3 space-y-2">
      <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Profile name *" className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200" aria-label="Profile name" />
      <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200" />
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-gray-500">Alert</span>
        <select aria-label="Alert frequency" value={alertFrequency} onChange={(e) => setAlertFrequency(e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200">
          {FREQS.map((f) => <option key={f} value={f}>{f === 'DISABLED' ? 'No alerts' : f.charAt(0) + f.slice(1).toLowerCase()}</option>)}
        </select>
        {initial && <label className="text-[11px] text-gray-500 flex items-center gap-1"><input type="checkbox" checked={useCurrent} onChange={(e) => setUseCurrent(e.target.checked)} /> Save current page filters</label>}
      </div>
      <div className="flex gap-2">
        <button type="submit" disabled={submitting || !name.trim()} className="btn-primary text-xs disabled:opacity-60 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> {submitting ? 'Saving…' : 'Save'}</button>
        <button type="button" onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"><X className="w-3.5 h-3.5" /> Cancel</button>
      </div>
    </form>
  )
}

export default MonitoringProfiles
