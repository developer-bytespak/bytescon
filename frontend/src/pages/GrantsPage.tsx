// =============================================================
// Grants — federal grant opportunities (Grants.gov) and the firm's
// application pipeline. Discovery is fed by the hourly Grants.gov
// source sync; preparation is tracked here through an SF-424 document
// checklist and status stages. The actual filing happens in
// Grants.gov Workspace — READY_TO_SUBMIT links straight to it.
// =============================================================
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Landmark, ExternalLink, Plus, ChevronDown, ChevronRight, Trash2, Check, X } from 'lucide-react'
import { grantsApi } from '../services/api'
import { useToast } from '../components/Toast'
import { PageHeader, StatCard, EmptyState, Chip, Spinner, formatCurrency, type Tone } from '../components/ui'

interface GrantOpp {
  id: string
  title: string
  agency: string
  solicitationNumber: string | null
  responseDeadline: string | null
  estimatedValue: string | number | null
  estimatedValueMin: string | number | null
  sourceUrl: string | null
  sourceMetadata?: { oppStatus?: string | null; assistanceListings?: string[] } | null
}

interface ChecklistItem { key: string; label: string; required: boolean; done: boolean }

interface Application {
  id: string
  status: string
  eligibilityNotes: string | null
  checklist: ChecklistItem[]
  submittedAt: string | null
  awardAmount: string | number | null
  outcomeNotes: string | null
  createdAt: string
  opportunity: GrantOpp
  clientCompany: { id: string; name: string } | null
}

const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  RESEARCHING: { label: 'Researching', tone: 'neutral' },
  ELIGIBILITY_CONFIRMED: { label: 'Eligibility confirmed', tone: 'accent' },
  PREPARING: { label: 'Preparing', tone: 'accent' },
  INTERNAL_REVIEW: { label: 'Internal review', tone: 'gold' },
  READY_TO_SUBMIT: { label: 'Ready to submit', tone: 'gold' },
  SUBMITTED: { label: 'Submitted', tone: 'success' },
  AWARDED: { label: 'Awarded', tone: 'success' },
  NOT_AWARDED: { label: 'Not awarded', tone: 'danger' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral' },
}
const STATUS_ORDER = Object.keys(STATUS_META)

function daysLeft(deadline: string | null): { label: string; tone: Tone } | null {
  if (!deadline) return null
  const d = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000)
  if (d < 0) return { label: 'Closed', tone: 'neutral' }
  if (d <= 7) return { label: `${d}d left`, tone: 'danger' }
  if (d <= 30) return { label: `${d}d left`, tone: 'gold' }
  return { label: `${d}d left`, tone: 'success' }
}

export function GrantsPage() {
  const [tab, setTab] = useState<'opportunities' | 'applications'>('opportunities')
  const qc = useQueryClient()
  const apps = useQuery({ queryKey: ['grant-applications'], queryFn: () => grantsApi.listApplications() })
  const applications: Application[] = apps.data?.data?.applications ?? []
  const activeCount = applications.filter((a) => !['NOT_AWARDED', 'WITHDRAWN', 'AWARDED'].includes(a.status)).length
  const awardedCount = applications.filter((a) => a.status === 'AWARDED').length

  return (
    <div>
      <PageHeader
        title="Grants"
        subtitle="Federal grant opportunities from Grants.gov, with application preparation tracked to the Workspace door."
        icon={<Landmark />}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="Active applications" value={String(activeCount)} />
        <StatCard label="Awarded" value={String(awardedCount)} />
        <StatCard label="Filing" value="Workspace" sub="Bytescon prepares; you submit on Grants.gov" />
      </div>

      <div className="flex items-center gap-1 mb-4">
        <button type="button" className={tab === 'opportunities' ? 'btn-primary text-xs' : 'btn-secondary text-xs'} onClick={() => setTab('opportunities')}>
          Grant opportunities
        </button>
        <button type="button" className={tab === 'applications' ? 'btn-primary text-xs' : 'btn-secondary text-xs'} onClick={() => setTab('applications')}>
          My applications{applications.length > 0 ? ` (${applications.length})` : ''}
        </button>
      </div>

      {tab === 'opportunities'
        ? <OpportunitiesTab onStarted={() => { qc.invalidateQueries({ queryKey: ['grant-applications'] }); setTab('applications') }} applications={applications} />
        : <ApplicationsTab applications={applications} loading={apps.isLoading} />}
    </div>
  )
}

// -------------------------------------------------------------
// Tab 1 — the Grants.gov stream
// -------------------------------------------------------------
function OpportunitiesTab({ onStarted, applications }: { onStarted: () => void; applications: Application[] }) {
  const { toast } = useToast()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const list = useQuery({
    queryKey: ['grant-opps', search, page],
    queryFn: () => grantsApi.listOpportunities({ search: search || undefined, page, limit: 25, sortBy: 'deadline', sortOrder: 'asc' }),
  })
  const opps: GrantOpp[] = list.data?.data ?? []
  const total: number = list.data?.meta?.total ?? 0
  const appliedIds = useMemo(() => new Set(applications.map((a) => a.opportunity.id)), [applications])

  const start = useMutation({
    mutationFn: (opportunityId: string) => grantsApi.createApplication({ opportunityId }),
    onSuccess: () => { toast('Application started — checklist created.', 'success'); onStarted() },
    onError: (e: any) => toast(e?.response?.data?.error ?? 'Could not start the application.', 'error'),
  })

  return (
    <div>
      <div className="mb-3">
        <input
          className="input w-full sm:w-80"
          placeholder="Search grants…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          aria-label="Search grants"
        />
      </div>
      {list.isLoading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : opps.length === 0 ? (
        <div className="card"><EmptyState message="No open grants match. The Grants.gov stream refreshes hourly." /></div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
                  <th className="text-left font-medium px-5 py-3">Grant</th>
                  <th className="text-left font-medium px-3 py-3">Agency</th>
                  <th className="text-left font-medium px-3 py-3">Deadline</th>
                  <th className="text-right font-medium px-3 py-3">Ceiling</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {opps.map((o) => {
                  const dl = daysLeft(o.responseDeadline)
                  const status = o.sourceMetadata?.oppStatus ?? null
                  return (
                    <tr key={o.id} className="table-row align-top">
                      <td className="px-5 py-3 max-w-[30rem]">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0">
                            <p className="font-medium truncate" style={{ color: 'var(--text)' }}>{o.title}</p>
                            <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-faint)' }}>
                              {o.solicitationNumber ?? '—'}{status ? ` · ${status}` : ''}
                            </p>
                          </div>
                          {o.sourceUrl && (
                            <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="icon-btn !w-7 !h-7 flex-shrink-0" aria-label="Open on Grants.gov" title="Open on Grants.gov">
                              <ExternalLink className="w-3.5 h-3.5" />
                            </a>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-3 max-w-[16rem]"><p className="truncate" style={{ color: 'var(--text-2)' }}>{o.agency}</p></td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {o.responseDeadline ? (
                          <div>
                            <p style={{ color: 'var(--text-2)' }}>{new Date(o.responseDeadline).toLocaleDateString()}</p>
                            {dl && <Chip tone={dl.tone} dot className="mt-1">{dl.label}</Chip>}
                          </div>
                        ) : <Chip tone="neutral">Forecasted</Chip>}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums whitespace-nowrap" style={{ color: 'var(--text-2)' }}>
                        {o.estimatedValue != null ? formatCurrency(o.estimatedValue) : '—'}
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        {appliedIds.has(o.id) ? (
                          <Chip tone="success">Tracking</Chip>
                        ) : (
                          <button type="button" className="btn-secondary !py-1.5 text-xs" disabled={start.isPending} onClick={() => start.mutate(o.id)}>
                            <Plus className="w-3.5 h-3.5" /> Apply
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-5 py-3 text-xs" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-faint)' }}>
            <span>Page {page} · {total} open grants</span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary !py-1.5 text-xs" disabled={page <= 1 || list.isFetching} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <button type="button" className="btn-secondary !py-1.5 text-xs" disabled={page * 25 >= total || list.isFetching} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------
// Tab 2 — the application pipeline
// -------------------------------------------------------------
function ApplicationsTab({ applications, loading }: { applications: Application[]; loading: boolean }) {
  const { toast } = useToast()
  const qc = useQueryClient()
  const [open, setOpen] = useState<string | null>(null)

  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => grantsApi.updateApplication(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['grant-applications'] }),
    onError: () => toast('Could not update the application.', 'error'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => grantsApi.deleteApplication(id),
    onSuccess: () => { toast('Application removed.', 'success'); qc.invalidateQueries({ queryKey: ['grant-applications'] }) },
    onError: () => toast('Could not remove the application.', 'error'),
  })

  if (loading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>
  if (applications.length === 0) {
    return <div className="card"><EmptyState message="No applications yet. Pick a grant from the opportunities tab and hit Apply to start the checklist." /></div>
  }

  return (
    <div className="space-y-3">
      {applications.map((a) => {
        const meta = STATUS_META[a.status] ?? { label: a.status, tone: 'neutral' as Tone }
        const doneCount = a.checklist.filter((c) => c.done).length
        const requiredLeft = a.checklist.filter((c) => c.required && !c.done).length
        const dl = daysLeft(a.opportunity.responseDeadline)
        const expanded = open === a.id
        return (
          <div key={a.id} className="card !p-0 overflow-hidden">
            <button
              type="button"
              className="w-full text-left px-5 py-3.5 flex items-center gap-3"
              onClick={() => setOpen(expanded ? null : a.id)}
              aria-expanded={expanded}
            >
              {expanded ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-faint)' }} /> : <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />}
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate" style={{ color: 'var(--text)' }}>{a.opportunity.title}</p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  {a.opportunity.agency}{a.clientCompany ? ` · for ${a.clientCompany.name}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {dl && <Chip tone={dl.tone} dot>{dl.label}</Chip>}
                <Chip tone="neutral">{doneCount}/{a.checklist.length} docs</Chip>
                <Chip tone={meta.tone}>{meta.label}</Chip>
              </div>
            </button>

            {expanded && (
              <div className="px-5 pb-4" style={{ borderTop: '1px solid var(--line)' }}>
                <div className="grid gap-5 md:grid-cols-2 pt-4">
                  {/* Checklist */}
                  <div>
                    <p className="text-[11px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-faint)' }}>SF-424 document checklist</p>
                    <ul className="space-y-1.5">
                      {a.checklist.map((c) => (
                        <li key={c.key}>
                          <label className="flex items-start gap-2 cursor-pointer text-sm">
                            <input
                              type="checkbox"
                              checked={c.done}
                              className="mt-0.5"
                              onChange={() => update.mutate({
                                id: a.id,
                                data: { checklist: a.checklist.map((x) => x.key === c.key ? { ...x, done: !x.done } : x) },
                              })}
                            />
                            <span style={{ color: c.done ? 'var(--text-faint)' : 'var(--text-2)', textDecoration: c.done ? 'line-through' : 'none' }}>
                              {c.label}{c.required ? '' : ' (if applicable)'}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Status + notes */}
                  <div className="space-y-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-faint)' }}>Stage</p>
                      <select
                        className="input"
                        value={a.status}
                        onChange={(e) => update.mutate({ id: a.id, data: { status: e.target.value } })}
                        aria-label="Application stage"
                      >
                        {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS_META[s].label}</option>)}
                      </select>
                      {a.status === 'READY_TO_SUBMIT' && (
                        <p className="text-xs mt-2" style={{ color: 'var(--text-2)' }}>
                          {requiredLeft > 0
                            ? `${requiredLeft} required item${requiredLeft === 1 ? '' : 's'} still open — finish the checklist before filing.`
                            : 'Checklist complete. File the application in Grants.gov Workspace, then mark it Submitted here.'}
                          {' '}
                          <a href="https://www.grants.gov/applicants/workspace-overview" target="_blank" rel="noopener noreferrer" className="underline inline-flex items-center gap-1">
                            Open Workspace <ExternalLink className="w-3 h-3" />
                          </a>
                        </p>
                      )}
                      {a.submittedAt && (
                        <p className="text-xs mt-2" style={{ color: 'var(--text-faint)' }}>Submitted {new Date(a.submittedAt).toLocaleDateString()}</p>
                      )}
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-faint)' }}>Eligibility notes</p>
                      <EligibilityNotes
                        value={a.eligibilityNotes ?? ''}
                        onSave={(v) => update.mutate({ id: a.id, data: { eligibilityNotes: v || null } })}
                        saving={update.isPending}
                      />
                    </div>
                    <div className="flex justify-end">
                      <RemoveButton onConfirm={() => remove.mutate(a.id)} />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function EligibilityNotes({ value, onSave, saving }: { value: string; onSave: (v: string) => void; saving: boolean }) {
  const [draft, setDraft] = useState(value)
  const dirty = draft !== value
  return (
    <div>
      <textarea
        className="input w-full min-h-[5rem] text-sm"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Who is eligible per the NOFO, which criteria apply, open questions…"
        aria-label="Eligibility notes"
      />
      {dirty && (
        <button type="button" className="btn-secondary !py-1 text-xs mt-1.5" disabled={saving} onClick={() => onSave(draft)}>
          {saving ? 'Saving…' : 'Save notes'}
        </button>
      )}
    </div>
  )
}

function RemoveButton({ onConfirm }: { onConfirm: () => void }) {
  const [arm, setArm] = useState(false)
  if (!arm) {
    return (
      <button type="button" className="icon-btn !w-7 !h-7" aria-label="Remove application" title="Remove application" onClick={() => setArm(true)}>
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" className="btn-danger !py-1 !px-2 text-[11px]" onClick={onConfirm}><Check className="w-3 h-3" /> Remove</button>
      <button type="button" className="btn-secondary !py-1 !px-2 text-[11px]" onClick={() => setArm(false)}><X className="w-3 h-3" /></button>
    </span>
  )
}
