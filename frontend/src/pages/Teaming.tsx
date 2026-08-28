// Teaming Partner CRM + Graph (FIX-2 moat). Captures the firm's real
// teaming activity — partners, roles, teamed value, agency coverage, and
// win rate on teamed bids — a proprietary, compounding relationship graph.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { teamingApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { ConfirmModal } from '../components/ConfirmModal'
import { staleWriteMessage } from '../lib/staleWrite'
import { PageHeader, Spinner, ErrorBanner, EmptyState } from '../components/ui'
import { TeamingRecommender } from '../components/TeamingRecommender'
import { TeamingAgreements } from '../components/TeamingAgreements'
import { TeamingAgentPanel } from '../components/section7/TeamingAgentPanel'
import { Plus, Trash2, Pencil, Archive, Network, Building2, Target, TrendingUp } from 'lucide-react'

interface Partner {
  id: string
  name: string
  uei: string | null
  cage: string | null
  primarySetAsides: string[]
  primaryNaicsCodes: string[]
  capabilities: string[]
  certifications: string[]
  cmmcLevel: number | null
  geography: string | null
  website: string | null
  pastPerformanceLink: string | null
  pastRelationship: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  notes: string | null
  isActive: boolean
  updatedAt: string
  arrangementCount: number
}

interface GraphNode {
  partnerId: string
  name: string
  arrangements: number
  agencies: string[]
  teamedValue: number
  won: number
  lost: number
  winRatePct: number | null
}

interface GraphSummary {
  partners: number
  activePartners: number
  arrangements: number
  teamedOpportunities: number
  totalTeamedValue: number
  agencyCoverage: number
  roleMix: Record<string, number>
  teamedBidWinRatePct: number | null
  teamedBidsWon: number
  teamedBidsLost: number
}

const EMPTY_FORM = {
  name: '',
  uei: '',
  cage: '',
  primarySetAsides: '',
  primaryNaicsCodes: '',
  capabilities: '',
  certifications: '',
  cmmcLevel: '',
  geography: '',
  website: '',
  pastPerformanceLink: '',
  pastRelationship: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  notes: '',
}
function partnerToForm(p: Partner): typeof EMPTY_FORM {
  return {
    name: p.name, uei: p.uei ?? '', cage: p.cage ?? '',
    primarySetAsides: p.primarySetAsides.join(', '), primaryNaicsCodes: p.primaryNaicsCodes.join(', '), capabilities: p.capabilities.join(', '),
    certifications: p.certifications.join(', '), cmmcLevel: p.cmmcLevel != null ? String(p.cmmcLevel) : '',
    geography: p.geography ?? '', website: p.website ?? '', pastPerformanceLink: p.pastPerformanceLink ?? '',
    pastRelationship: p.pastRelationship ?? '', contactName: p.contactName ?? '', contactEmail: p.contactEmail ?? '', contactPhone: p.contactPhone ?? '', notes: p.notes ?? '',
  }
}

function Kpi({ label, value, sub, icon: Icon }: { label: string; value: string; sub?: string; icon: typeof Target }) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <Icon className="w-4 h-4" />
        {label}
      </div>
      <p className="text-2xl font-mono text-gray-100 mt-1">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  )
}

export default function TeamingPage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const [showCreate, setShowCreate] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [agentPursuitId, setAgentPursuitId] = useState(
    () => new URLSearchParams(window.location.search).get('pursuit') ?? '',
  )
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [archiveTarget, setArchiveTarget] = useState<Partner | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Partner | null>(null)

  const { data: partnersData, isLoading, error } = useQuery({
    queryKey: ['teaming-partners', showArchived],
    queryFn: () => teamingApi.listPartners({ includeArchived: showArchived || undefined }),
  })
  const { data: graphData } = useQuery({
    queryKey: ['teaming-graph'],
    queryFn: () => teamingApi.graph(),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['teaming-partners'] })
    qc.invalidateQueries({ queryKey: ['teaming-graph'] })
  }

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) => (editId ? teamingApi.updatePartner(editId, body) : teamingApi.createPartner(body)),
    onSuccess: () => { invalidate(); setShowCreate(false); setEditId(null); setForm(EMPTY_FORM) },
    onError: (err: unknown) =>
      setFormError(staleWriteMessage(err) || (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Save failed'),
  })

  const archiveMutation = useMutation({
    mutationFn: (id: string) => teamingApi.archivePartner(id),
    onSuccess: () => { invalidate(); setArchiveTarget(null); toast('Partner archived', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Archive failed', 'error'),
  })
  const restoreMutation = useMutation({
    mutationFn: (id: string) => teamingApi.restorePartner(id),
    onSuccess: () => { invalidate(); toast('Partner restored', 'success') },
  })
  const deleteMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => teamingApi.deletePartner(id, name),
    onSuccess: () => { invalidate(); setDeleteTarget(null); toast('Partner permanently deleted', 'success') },
    onError: (e: any) => toast(e?.response?.data?.error || 'Delete failed', 'error'),
  })

  const beginEdit = (p: Partner) => { setEditId(p.id); setForm(partnerToForm(p)); setFormError(''); setShowCreate(true) }

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    const toList = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)
    const p = partnersData?.data?.partners?.find((x: Partner) => x.id === editId)
    createMutation.mutate({
      name: form.name.trim(),
      uei: form.uei.trim() || undefined,
      cage: form.cage.trim() || undefined,
      primarySetAsides: toList(form.primarySetAsides),
      primaryNaicsCodes: toList(form.primaryNaicsCodes),
      capabilities: toList(form.capabilities),
      certifications: toList(form.certifications),
      cmmcLevel: form.cmmcLevel ? Number(form.cmmcLevel) : undefined,
      geography: form.geography.trim() || undefined,
      website: form.website.trim() || undefined,
      pastPerformanceLink: form.pastPerformanceLink.trim() || undefined,
      pastRelationship: form.pastRelationship.trim() || undefined,
      contactName: form.contactName.trim() || undefined,
      contactEmail: form.contactEmail.trim() || undefined,
      contactPhone: form.contactPhone.trim() || undefined,
      notes: form.notes.trim() || undefined,
      ...(editId && p ? { updatedAt: p.updatedAt } : {}),
    })
  }

  const partners: Partner[] = partnersData?.data?.partners ?? []
  const summary: GraphSummary | undefined = graphData?.data?.summary
  const nodes: GraphNode[] = graphData?.data?.partners ?? []
  const nodeById = new Map(nodes.map((n) => [n.partnerId, n]))
  const usd = (n: number) => `$${Number(n || 0).toLocaleString()}`

  if (isLoading) return <Spinner />
  if (error) return <ErrorBanner message="Failed to load teaming partners" />

  return (
    <div>
      <PageHeader title="Teaming" subtitle="Your proprietary partner graph — who you team with, and how it wins">
        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer mr-1">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
        {isAdmin && (
          <button className="btn-primary flex items-center gap-2" onClick={() => { setEditId(null); setForm(EMPTY_FORM); setFormError(''); setShowCreate((s) => !s) }}>
            <Plus className="w-4 h-4" /> Add Partner
          </button>
        )}
      </PageHeader>

      {/* Graph summary — the moat, at a glance */}
      {summary && summary.partners > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <Kpi icon={Network} label="Partners" value={String(summary.partners)} sub={`${summary.activePartners} active`} />
          <Kpi icon={Target} label="Teamed value" value={usd(summary.totalTeamedValue)} sub={`${summary.arrangements} arrangements`} />
          <Kpi icon={Building2} label="Agency coverage" value={String(summary.agencyCoverage)} sub="agencies teamed at" />
          <Kpi
            icon={TrendingUp}
            label="Teamed-bid win rate"
            value={summary.teamedBidWinRatePct == null ? '—' : `${summary.teamedBidWinRatePct}%`}
            sub={`${summary.teamedBidsWon}W / ${summary.teamedBidsLost}L`}
          />
        </div>
      )}

      {/* §7.5 — Agent-driven flow: gap → candidates → evidence → workshare → draft.
          Selected by pursuit; the page's existing tools are unchanged below. */}
      <div className="mt-6">
        <label className="block text-xs text-gray-500 mb-1" htmlFor="teaming-agent-pursuit">
          Teaming Agent — plan for a pursuit
        </label>
        <input
          id="teaming-agent-pursuit"
          data-testid="teaming-agent-pursuit-input"
          className="input font-mono"
          placeholder="Pursuit id"
          value={agentPursuitId}
          onChange={(e) => setAgentPursuitId(e.target.value.trim())}
        />
        {agentPursuitId && (
          <div className="mt-4">
            <TeamingAgentPanel pursuitId={agentPursuitId} />
          </div>
        )}
      </div>

      {/* Partner recommender for a specific bid */}
      {partners.length > 0 && <TeamingRecommender />}

      {/* Agreement / NDA / workshare tracker + reminders (§5.1 Stage 4) */}
      <div className="mt-6">
        <TeamingAgreements />
      </div>

      {/* Add / edit partner form */}
      {showCreate && isAdmin && (
        <form onSubmit={handleCreate} className="card mb-6 space-y-3">
          <p className="text-sm font-semibold text-gray-200">{editId ? 'Edit partner' : 'Add partner'}</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input className="input" placeholder="Partner name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            <input className="input font-mono" placeholder="UEI" value={form.uei} onChange={(e) => setForm({ ...form, uei: e.target.value })} />
            <input className="input font-mono" placeholder="CAGE" value={form.cage} onChange={(e) => setForm({ ...form, cage: e.target.value })} />
            <input className="input" placeholder="Set-asides (comma-sep)" value={form.primarySetAsides} onChange={(e) => setForm({ ...form, primarySetAsides: e.target.value })} />
            <input className="input" placeholder="NAICS (comma-sep)" value={form.primaryNaicsCodes} onChange={(e) => setForm({ ...form, primaryNaicsCodes: e.target.value })} />
            <input className="input" placeholder="Capabilities (comma-sep)" value={form.capabilities} onChange={(e) => setForm({ ...form, capabilities: e.target.value })} />
            <input className="input" placeholder="Certifications (comma-sep)" value={form.certifications} onChange={(e) => setForm({ ...form, certifications: e.target.value })} />
            <select className="input" value={form.cmmcLevel} onChange={(e) => setForm({ ...form, cmmcLevel: e.target.value })}>
              <option value="">CMMC Level</option>
              <option value="1">CMMC Level 1</option>
              <option value="2">CMMC Level 2</option>
              <option value="3">CMMC Level 3</option>
            </select>
            <input className="input" placeholder="Geography" value={form.geography} onChange={(e) => setForm({ ...form, geography: e.target.value })} />
            <input className="input" placeholder="Website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
            <input className="input" placeholder="Past performance link" value={form.pastPerformanceLink} onChange={(e) => setForm({ ...form, pastPerformanceLink: e.target.value })} />
            <input className="input" placeholder="Contact name" value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
            <input className="input" placeholder="Contact email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
            <input className="input" placeholder="Contact phone" value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
          </div>
          <input className="input w-full" placeholder="Past relationship" value={form.pastRelationship} onChange={(e) => setForm({ ...form, pastRelationship: e.target.value })} />
          <textarea className="input w-full" placeholder="Notes" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          {formError && <p className="text-sm text-red-400">{formError}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={createMutation.isPending || !form.name.trim()}>
              {createMutation.isPending ? 'Saving…' : editId ? 'Save changes' : 'Save partner'}
            </button>
            <button type="button" className="btn-secondary" onClick={() => { setShowCreate(false); setEditId(null); setFormError('') }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Partner roster */}
      {partners.length === 0 ? (
        <EmptyState message={isAdmin ? 'No teaming partners yet. Add one to start building your graph.' : 'No teaming partners yet.'} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-700">
                <th className="py-2 pr-4">Partner</th>
                <th className="py-2 pr-4">Set-asides</th>
                <th className="py-2 pr-4">Capabilities</th>
                <th className="py-2 pr-4 text-right">Arrangements</th>
                <th className="py-2 pr-4 text-right">Teamed value</th>
                <th className="py-2 pr-4 text-right">Win rate</th>
                {isAdmin && <th className="py-2" />}
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => {
                const node = nodeById.get(p.id)
                return (
                  <tr key={p.id} className={`border-b border-gray-800 hover:bg-gray-800/40 ${!p.isActive ? 'opacity-50' : ''}`}>
                    <td className="py-2 pr-4">
                      <div className="text-gray-100">{p.name}{!p.isActive && <span className="ml-2 text-[9px] uppercase tracking-wide text-gray-500 border border-gray-700 rounded px-1">archived</span>}</div>
                      <div className="text-xs text-gray-500 font-mono">{p.uei || '—'}{p.cmmcLevel ? ` · CMMC L${p.cmmcLevel}` : ''}</div>
                    </td>
                    <td className="py-2 pr-4 text-gray-400">{p.primarySetAsides.join(', ') || '—'}</td>
                    <td className="py-2 pr-4 text-gray-400">{p.capabilities.slice(0, 3).join(', ') || '—'}</td>
                    <td className="py-2 pr-4 text-right font-mono text-gray-200">{p.arrangementCount}</td>
                    <td className="py-2 pr-4 text-right font-mono text-gray-200">{node ? usd(node.teamedValue) : '—'}</td>
                    <td className="py-2 pr-4 text-right font-mono text-gray-200">{node?.winRatePct == null ? '—' : `${node.winRatePct}%`}</td>
                    {isAdmin && (
                      <td className="py-2 text-right whitespace-nowrap">
                        {p.isActive ? (
                          <span className="inline-flex items-center gap-2 justify-end">
                            <button className="text-gray-500 hover:text-blue-400" title="Edit partner" aria-label={`Edit ${p.name}`} onClick={() => beginEdit(p)}><Pencil className="w-4 h-4" /></button>
                            <button className="text-gray-500 hover:text-amber-400" title="Archive partner" aria-label={`Archive ${p.name}`} onClick={() => setArchiveTarget(p)}><Archive className="w-4 h-4" /></button>
                            <button className="text-gray-500 hover:text-red-400 disabled:opacity-30" title={p.arrangementCount > 0 ? 'Cannot delete — has linked arrangements' : 'Delete permanently'} aria-label={`Delete ${p.name}`} disabled={p.arrangementCount > 0} onClick={() => setDeleteTarget(p)}><Trash2 className="w-4 h-4" /></button>
                          </span>
                        ) : (
                          <button className="text-gray-500 hover:text-green-400 text-xs" onClick={() => restoreMutation.mutate(p.id)}>Restore</button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={!!archiveTarget}
        variant="archive"
        entityType="partner"
        entityName={archiveTarget?.name ?? ''}
        loading={archiveMutation.isPending}
        onConfirm={() => { if (archiveTarget) archiveMutation.mutate(archiveTarget.id) }}
        onCancel={() => setArchiveTarget(null)}
      />
      <ConfirmModal
        open={!!deleteTarget}
        variant="delete"
        entityType="partner"
        entityName={deleteTarget?.name ?? ''}
        loading={deleteMutation.isPending}
        onConfirm={() => { if (deleteTarget) deleteMutation.mutate({ id: deleteTarget.id, name: deleteTarget.name }) }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
