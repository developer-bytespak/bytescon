// =============================================================
// State & Municipal — state, county and municipal bids tracked beside
// the federal pipeline. Three ways in: a live sync of public portals
// (with an honest per-source report), a file import of any portal export,
// and manual entries. Backed by /api/state-municipal.
// =============================================================
import { useMemo, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MapPin, RefreshCw, Upload, Plus, Search, ExternalLink, Trash2, Building2, Landmark, Flag, Layers, X, Check,
} from 'lucide-react'
import { stateMunicipalApi } from '../services/api'
import { AddonGate } from '../components/AddonGate'
import { useToast } from '../components/Toast'
import { PageHeader, StatCard, EmptyState, Chip, Tile, Spinner, formatCurrency, type Tone } from '../components/ui'

type Level = 'STATE' | 'COUNTY' | 'MUNICIPAL' | 'FEDERAL'

interface Opp {
  id: string
  title: string
  agency: string
  state: string
  contractLevel: Level
  naicsCode: string | null
  estimatedValue: string | number | null
  responseDeadline: string | null
  solicitationNumber: string | null
  sourceUrl: string | null
  postedAt: string | null
}

interface Stats {
  total: number
  byLevel: Array<{ contractLevel: Level; _count: { _all: number } }>
  byState: Array<{ state: string; _count: { _all: number } }>
}

interface SyncStatus {
  running: boolean
  startedAt?: string
  finishedAt?: string
  fetched?: number
  created?: number
  skipped?: number
  bySource?: Record<string, number | 'failed'>
  error?: string
}

const SOURCE_LABELS: Record<string, string> = {
  nyscr: 'NY Contract Reporter', tx: 'TX ESBD', fl: 'FL VBS', va: 'VA eVA', ga: 'GA GPR', nc: 'NC eProcurement',
  oh: 'OH Procure', il: 'IL BidBuy', ca: 'CA eProcure', md: 'MD eMMA', pa: 'PA eMarketplace', sam: 'SAM.gov', usaspending: 'USAspending',
}

const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC']

const LEVELS: Array<{ value: Level; label: string; tone: Tone }> = [
  { value: 'STATE', label: 'State', tone: 'accent' },
  { value: 'COUNTY', label: 'County', tone: 'gold' },
  { value: 'MUNICIPAL', label: 'Municipal', tone: 'success' },
  { value: 'FEDERAL', label: 'Federal award in state', tone: 'neutral' },
]
const levelMeta = (l: Level) => LEVELS.find((x) => x.value === l) ?? LEVELS[0]

function daysLeft(iso: string | null): { label: string; tone: Tone } | null {
  if (!iso) return null
  const d = Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000)
  if (Number.isNaN(d)) return null
  if (d < 0) return { label: 'closed', tone: 'neutral' }
  if (d === 0) return { label: 'due today', tone: 'danger' }
  return { label: `${d}d left`, tone: d <= 7 ? 'danger' : d <= 20 ? 'gold' : 'success' }
}

const PAGE = 50

export function StateMunicipalPage() {
  return (
    <AddonGate addon="state_municipal">
      <StateMunicipalInner />
    </AddonGate>
  )
}

function StateMunicipalInner() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [state, setState] = useState('')
  const [level, setLevel] = useState('NON_FEDERAL')
  const [pages, setPages] = useState(1)
  const [panel, setPanel] = useState<'none' | 'import' | 'add'>('none')

  const stats = useQuery({ queryKey: ['sm-stats'], queryFn: () => stateMunicipalApi.stats() })
  const status = useQuery({
    queryKey: ['sm-sync-status'],
    queryFn: () => stateMunicipalApi.syncStatus(),
    refetchInterval: (q) => ((q.state.data as { data?: SyncStatus } | undefined)?.data?.running ? 4_000 : false),
  })
  const list = useQuery({
    queryKey: ['sm-list', search, state, level, pages],
    queryFn: () => stateMunicipalApi.list({ search: search || undefined, state: state || undefined, level: level || undefined, limit: PAGE * pages, offset: 0 }),
    placeholderData: (prev) => prev,
  })

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['sm-stats'] })
    qc.invalidateQueries({ queryKey: ['sm-list'] })
  }

  const sync = useMutation({
    mutationFn: () => stateMunicipalApi.sync(),
    onSuccess: () => { toast('Sync started. Sources are being pulled in the background.', 'success'); qc.invalidateQueries({ queryKey: ['sm-sync-status'] }) },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not start the sync.', 'error'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => stateMunicipalApi.delete(id),
    onSuccess: () => { toast('Removed.', 'success'); refreshAll() },
    onError: () => toast('Could not remove that bid.', 'error'),
  })

  const s: Stats | undefined = stats.data?.data
  const st: SyncStatus | undefined = status.data?.data
  const opps: Opp[] = list.data?.data?.opportunities ?? []
  const total: number = list.data?.data?.total ?? 0
  const levelCount = (l: Level) => s?.byLevel?.find((x) => x.contractLevel === l)?._count._all ?? 0
  const stateOptions = useMemo(() => {
    const seen = new Set((s?.byState ?? []).map((x) => x.state))
    return [...(s?.byState ?? []).map((x) => x.state), ...STATES.filter((x) => !seen.has(x))]
  }, [s])

  const sources = Object.entries(st?.bySource ?? {})
  const okSources = sources.filter(([, v]) => typeof v === 'number' && v > 0).length

  return (
    <div>
      <PageHeader
        title="State & Municipal"
        subtitle="State, county and municipal bids, tracked beside your federal pipeline."
        icon={<MapPin />}
      >
        <button type="button" className="btn-secondary text-xs" onClick={() => setPanel(panel === 'import' ? 'none' : 'import')}>
          <Upload className="w-3.5 h-3.5" /> Import file
        </button>
        <button type="button" className="btn-secondary text-xs" onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}>
          <Plus className="w-3.5 h-3.5" /> Add manually
        </button>
        <button type="button" className="btn-primary text-xs" onClick={() => sync.mutate()} disabled={sync.isPending || !!st?.running}>
          {st?.running ? <Spinner size="sm" /> : <RefreshCw className="w-3.5 h-3.5" />}
          {st?.running ? 'Syncing…' : 'Sync sources'}
        </button>
      </PageHeader>

      {/* ---- Sources report ---- */}
      <div className="card mb-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex items-start gap-3 min-w-0">
            <Tile tone={st?.running ? 'accent' : okSources > 0 ? 'success' : 'neutral'}><Layers /></Tile>
            <div className="min-w-0">
              <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
                {st?.running ? 'Pulling public portals now' : st?.finishedAt ? `Last sync ${new Date(st.finishedAt).toLocaleString()}` : 'No sync yet'}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>
                {st?.finishedAt && !st.running
                  ? `${st.fetched ?? 0} rows fetched · ${st.created ?? 0} new · ${st.skipped ?? 0} already tracked`
                  : 'Portals that block automated pulls report zero rows. Import their export files instead; the import understands most column layouts.'}
              </p>
              {st?.error && <p className="text-xs mt-1" style={{ color: 'var(--danger)' }}>{st.error}</p>}
            </div>
          </div>
          {sources.length > 0 && (
            <div className="flex flex-wrap gap-1.5 md:justify-end md:max-w-[60%]" data-testid="source-chips">
              {sources.map(([key, v]) => (
                <Chip key={key} tone={v === 'failed' ? 'danger' : typeof v === 'number' && v > 0 ? 'success' : 'neutral'} dot>
                  {SOURCE_LABELS[key] ?? key} · {v === 'failed' ? 'failed' : v}
                </Chip>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ---- Stats ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Tracked bids" value={s?.total ?? 0} sub={`${s?.byState?.length ?? 0} states`} tone="accent" featured icon={<MapPin />} />
        <StatCard label="State level" value={levelCount('STATE')} sub="Statewide solicitations" tone="accent" icon={<Landmark />} />
        <StatCard label="County & municipal" value={levelCount('COUNTY') + levelCount('MUNICIPAL')} sub="Local government" tone="gold" icon={<Building2 />} />
        <StatCard label="Federal awards in state" value={levelCount('FEDERAL')} sub="From USAspending, often re-bid" tone="neutral" icon={<Flag />} />
      </div>

      {panel === 'import' && <ImportPanel onClose={() => setPanel('none')} onDone={refreshAll} stateOptions={STATES} />}
      {panel === 'add' && <AddPanel onClose={() => setPanel('none')} onDone={refreshAll} />}

      {/* ---- Filters ---- */}
      <div className="card mb-4 !py-3">
        <div className="grid gap-3 md:grid-cols-[1fr_160px_220px]">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-faint)' }} />
            <input className="input !pl-9" placeholder="Search titles…" value={search} onChange={(e) => { setSearch(e.target.value); setPages(1) }} aria-label="Search titles" />
          </div>
          <select className="input" value={state} onChange={(e) => { setState(e.target.value); setPages(1) }} aria-label="Filter by state">
            <option value="">All states</option>
            {stateOptions.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
          <select className="input" value={level} onChange={(e) => { setLevel(e.target.value); setPages(1) }} aria-label="Filter by level">
            <option value="NON_FEDERAL">State, county & municipal</option>
            <option value="">Everything, incl. federal awards</option>
            {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </div>
      </div>

      {/* ---- List ---- */}
      {list.isLoading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : opps.length === 0 ? (
        <div className="card"><EmptyState message={level === 'NON_FEDERAL' && (s?.total ?? 0) > 0 ? 'No state, county or municipal bids match. Switch the level filter to include federal awards in state.' : 'No state or municipal bids yet. Run a sync, import a portal export, or add one manually.'} /></div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                  <th className="text-left font-medium px-5 py-3">Solicitation</th>
                  <th className="text-left font-medium px-3 py-3">Agency</th>
                  <th className="text-left font-medium px-3 py-3">Where</th>
                  <th className="text-left font-medium px-3 py-3">Deadline</th>
                  <th className="text-right font-medium px-3 py-3">Value</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {opps.map((o) => {
                  const lm = levelMeta(o.contractLevel)
                  const dl = daysLeft(o.responseDeadline)
                  return (
                    <tr key={o.id} className="table-row align-top">
                      <td className="px-5 py-3 max-w-[28rem]">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <p className="font-medium truncate" style={{ color: 'var(--text)' }}>{o.title}</p>
                            <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-faint)' }}>{o.solicitationNumber ?? '—'}{o.naicsCode ? ` · NAICS ${o.naicsCode}` : ''}</p>
                          </div>
                          {o.sourceUrl && (
                            <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="icon-btn !w-7 !h-7 flex-shrink-0" aria-label="Open source" title="Open source">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 max-w-[16rem]"><p className="truncate" style={{ color: 'var(--text-2)' }}>{o.agency}</p></td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Chip tone="neutral">{o.state}</Chip>
                          <Chip tone={lm.tone}>{lm.label}</Chip>
                        </div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {o.responseDeadline ? (
                          <div>
                            <p style={{ color: 'var(--text-2)' }}>{new Date(o.responseDeadline).toLocaleDateString()}</p>
                            {dl && <Chip tone={dl.tone} dot className="mt-1">{dl.label}</Chip>}
                          </div>
                        ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--text-2)' }}>
                        {o.estimatedValue != null ? formatCurrency(o.estimatedValue) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right"><DeleteButton onConfirm={() => remove.mutate(o.id)} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-5 py-3 text-xs" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-faint)' }}>
            <span>Showing {opps.length} of {total}</span>
            {opps.length < total && (
              <button type="button" className="btn-secondary !py-1.5 text-xs" onClick={() => setPages((p) => p + 1)} disabled={list.isFetching}>
                {list.isFetching ? 'Loading…' : 'Load more'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function DeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [arm, setArm] = useState(false)
  if (!arm) {
    return (
      <button type="button" className="icon-btn !w-7 !h-7" aria-label="Remove" title="Remove" onClick={() => setArm(true)}>
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className="btn-danger !py-1 !px-2 text-[11px]" onClick={onConfirm}><Check className="w-3 h-3" /> Remove</button>
      <button type="button" className="icon-btn !w-7 !h-7" aria-label="Cancel" onClick={() => setArm(false)}><X className="w-3.5 h-3.5" /></button>
    </span>
  )
}

/* ---------- Import panel ---------- */
interface Preview { totalRows: number; mappableRows: number; columnMapping: Record<string, string>; detectedColumns: string[]; sample: Array<Record<string, string>> }

function ImportPanel({ onClose, onDone, stateOptions }: { onClose: () => void; onDone: () => void; stateOptions: string[] }) {
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [defaultState, setDefaultState] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)

  const previewMut = useMutation({
    mutationFn: () => stateMunicipalApi.previewImport(file as File, defaultState || undefined),
    onSuccess: (data: Preview) => setPreview(data),
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not read that file.', 'error'),
  })
  const importMut = useMutation({
    mutationFn: () => stateMunicipalApi.bulkImport(file as File, defaultState || undefined),
    onSuccess: (data: { imported: number; skipped: number; errors: string[] }) => {
      toast(`Imported ${data.imported} bids, ${data.skipped} already tracked.`, 'success')
      onDone(); onClose()
    },
    onError: (e: any) => toast(e?.response?.data?.error || 'Import failed.', 'error'),
  })

  return (
    <div className="card mb-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Tile tone="gold"><Upload /></Tile>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Import a portal export</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>CSV or Excel from any state or city procurement site. Columns are matched automatically; duplicates are skipped.</p>
          </div>
        </div>
        <button type="button" className="icon-btn" aria-label="Close import" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_180px_auto_auto] md:items-end">
        <div>
          <label className="label" htmlFor="sm-file">File</label>
          <input id="sm-file" type="file" accept=".csv,.txt,.xlsx,.xls" className="input" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null) }} />
        </div>
        <div>
          <label className="label" htmlFor="sm-default-state">Default state</label>
          <select id="sm-default-state" className="input" value={defaultState} onChange={(e) => setDefaultState(e.target.value)}>
            <option value="">From file</option>
            {stateOptions.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <button type="button" className="btn-secondary" disabled={!file || previewMut.isPending} onClick={() => previewMut.mutate()}>
          {previewMut.isPending ? <Spinner size="sm" /> : null} Preview
        </button>
        <button type="button" className="btn-primary" disabled={!file || !preview || importMut.isPending} onClick={() => importMut.mutate()}>
          {importMut.isPending ? <Spinner size="sm" /> : <Check className="w-3.5 h-3.5" />} Import {preview ? preview.mappableRows : ''}
        </button>
      </div>
      {preview && (
        <div className="mt-4 rounded-xl p-4" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
          <p className="text-xs" style={{ color: 'var(--text-2)' }}>
            <span className="font-semibold" style={{ color: 'var(--text)' }}>{preview.mappableRows}</span> of {preview.totalRows} rows can be imported.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.entries(preview.columnMapping).map(([from, to]) => <Chip key={from} tone="accent">{from} → {to}</Chip>)}
            {preview.detectedColumns.filter((c) => !preview.columnMapping[c]).map((c) => <Chip key={c} tone="neutral">{c} · ignored</Chip>)}
          </div>
          {preview.sample.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs" style={{ color: 'var(--text-2)' }}>
              {preview.sample.map((r, i) => <li key={i} className="truncate">• {r.title}{r.agency ? ` — ${r.agency}` : ''}{r.state ? ` (${r.state})` : ''}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- Manual add panel ---------- */
function AddPanel({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useToast()
  const [form, setForm] = useState({ title: '', agency: '', state: '', contractLevel: 'STATE' as Level, responseDeadline: '', estimatedValue: '', solicitationNumber: '', sourceUrl: '' })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const create = useMutation({
    mutationFn: () => stateMunicipalApi.create({ ...form, estimatedValue: form.estimatedValue || undefined, responseDeadline: form.responseDeadline || undefined, solicitationNumber: form.solicitationNumber || undefined, sourceUrl: form.sourceUrl || undefined }),
    onSuccess: () => { toast('Bid added.', 'success'); onDone(); onClose() },
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not add that bid.', 'error'),
  })
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate() }

  return (
    <form className="card mb-6" onSubmit={submit}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <Tile tone="accent"><Plus /></Tile>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Add a bid manually</h3>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>For portals without an export. Title, agency and state are required.</p>
          </div>
        </div>
        <button type="button" className="icon-btn" aria-label="Close add form" onClick={onClose}><X className="w-4 h-4" /></button>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <div className="md:col-span-2"><label className="label" htmlFor="sm-title">Title</label><input id="sm-title" className="input" required value={form.title} onChange={set('title')} /></div>
        <div><label className="label" htmlFor="sm-agency">Agency</label><input id="sm-agency" className="input" required value={form.agency} onChange={set('agency')} /></div>
        <div>
          <label className="label" htmlFor="sm-state">State</label>
          <select id="sm-state" className="input" required value={form.state} onChange={set('state')}>
            <option value="">Select…</option>
            {STATES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sm-level">Level</label>
          <select id="sm-level" className="input" value={form.contractLevel} onChange={set('contractLevel')}>
            {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
          </select>
        </div>
        <div><label className="label" htmlFor="sm-deadline">Deadline</label><input id="sm-deadline" type="date" className="input" value={form.responseDeadline} onChange={set('responseDeadline')} /></div>
        <div><label className="label" htmlFor="sm-value">Estimated value (USD)</label><input id="sm-value" type="number" min="0" className="input" value={form.estimatedValue} onChange={set('estimatedValue')} /></div>
        <div><label className="label" htmlFor="sm-sol">Solicitation #</label><input id="sm-sol" className="input" value={form.solicitationNumber} onChange={set('solicitationNumber')} /></div>
        <div><label className="label" htmlFor="sm-url">Source URL</label><input id="sm-url" type="url" className="input" value={form.sourceUrl} onChange={set('sourceUrl')} /></div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={create.isPending}>{create.isPending ? <Spinner size="sm" /> : <Check className="w-3.5 h-3.5" />} Add bid</button>
      </div>
    </form>
  )
}

export default StateMunicipalPage
