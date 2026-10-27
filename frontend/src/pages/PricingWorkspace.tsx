import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader, Plus, Trash2, DollarSign, Layers, GitBranch, Archive, AlertTriangle, CheckCircle2, ShieldAlert } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../hooks/useBranding'
import { useToast } from '../components/Toast'
import { opportunitiesApi, pricingApi } from '../services/api'
import { PricingAgentPanel } from '../components/section7/PricingAgentPanel'
import { StatusPill, TabIndicator } from '../components/ui'

interface Scenario {
  id: string; name: string; description: string | null; isPreferred: boolean
  totalDirectLabor: string | null; totalFringe: string | null; totalOverhead: string | null; totalOdc: string | null
  totalSubcontractor: string | null; totalGA: string | null; subtotalBeforeFee: string | null; totalFee: string | null; totalPrice: string | null
  sensitiveRedacted?: boolean
  laborLines: LaborLine[]; indirectRates: IndirectRate[]; otherCosts: OtherCost[]
}
interface LaborLine { id: string; categoryName: string; hours: string; baseRate: string | null; escalationPct: string | null; directLaborAmount: string | null; personnelCount: number | null }
interface IndirectRate { id: string; name: string; rateType: string; percent: string | null; costBase: string }
interface OtherCost { id: string; costCategory: string; description: string; quantity: string; unitCost: string | null; totalAmount: string | null }
interface Workspace { id: string; title: string; status: string; version: number; preferredScenarioId: string | null; scenarios: Scenario[] }

const RATE_TYPES = ['FRINGE', 'OVERHEAD', 'GA', 'MATERIAL_HANDLING', 'SUBCONTRACT_HANDLING', 'FEE', 'OTHER']
const COST_BASES = ['DIRECT_LABOUR', 'LABOUR_PLUS_FRINGE', 'TOTAL_DIRECT_COST', 'SUBCONTRACTOR_COST', 'MATERIAL_COST', 'CUSTOM_SUPPORTED_BASE']
const OTHER_CATEGORIES = ['TRAVEL', 'MATERIALS', 'EQUIPMENT', 'SUPPLIES', 'ODC', 'SUBCONTRACTOR', 'CONSULTANT', 'OTHER']
// Numeric columns in the line tables are right-aligned.
const NUMERIC_COLS = new Set(['Hrs', 'Rate', 'Esc%', 'Direct $', '%', 'Qty', 'Unit $', 'Total $'])
const money = (v: string | null | undefined) => v == null ? '—' : `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

export default function PricingWorkspace() {
  const { id: opportunityId } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user, firm } = useAuth()
  const { branding } = useBranding(firm?.id)
  const { toast } = useToast()
  const qc = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const [newTitle, setNewTitle] = useState('')
  const [activeScenarioId, setActiveScenarioId] = useState<string | null>(null)

  const oppQuery = useQuery({ queryKey: ['opportunity', opportunityId], queryFn: () => opportunitiesApi.getById(opportunityId!), enabled: !!opportunityId })
  const wsQuery = useQuery({ queryKey: ['pricing-workspace', opportunityId], queryFn: () => pricingApi.getWorkspace(opportunityId!), enabled: !!opportunityId })
  const benchQuery = useQuery({ queryKey: ['pricing-benchmark', opportunityId], queryFn: () => pricingApi.benchmark(opportunityId!), enabled: !!opportunityId })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['pricing-workspace', opportunityId] })

  const ws: Workspace | null = wsQuery.data?.data?.exists ? wsQuery.data.data.workspace : null
  const versions = wsQuery.data?.data?.versions ?? []
  const opp = oppQuery.data?.data ?? oppQuery.data
  const gradient = { background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})` }
  const editable = ws?.status === 'DRAFT'
  const scenario = ws?.scenarios.find((s) => s.id === (activeScenarioId ?? ws.preferredScenarioId)) ?? ws?.scenarios[0]

  const createMutation = useMutation({ mutationFn: () => pricingApi.create(opportunityId!, { title: newTitle.trim() }), onSuccess: () => { setNewTitle(''); invalidate(); toast('Pricing created', 'success') }, onError: (e: any) => toast(e?.response?.data?.error || 'Could not create', 'error') })
  const act = (fn: () => Promise<any>, msg: string) => async () => { try { await fn(); invalidate(); toast(msg, 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Action failed', 'error') } }

  if (wsQuery.isLoading || oppQuery.isLoading) return <div className="flex justify-center py-24"><Loader className="w-6 h-6 animate-spin text-gray-500" /></div>

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
      <button onClick={() => navigate(`/opportunities/${opportunityId}`)} className="btn-ghost btn-sm -ml-2 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Back to opportunity</button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="overline">Pricing & Rate Build-Up</p>
          <h1 className="page-title mt-1">{opp?.title ?? 'Opportunity'}</h1>
        </div>
        {ws && <StatusPill status={ws.status} size="lg"><span className="tabular-nums">{ws.status} · v{ws.version}</span></StatusPill>}
      </div>

      {wsQuery.isError && <div className="rounded-xl p-4 text-sm flex items-center gap-2" style={{ background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger-text)' }}><AlertTriangle className="w-4 h-4" /> Could not load pricing. <button onClick={() => wsQuery.refetch()} className="underline underline-offset-2 font-medium">Retry</button></div>}

      {!ws ? (
        <div className="card !py-12 text-center space-y-4 animate-fade-in">
          <div className="empty-ring mx-auto"><span className="tile tile-accent"><DollarSign /></span></div>
          <p className="text-gray-200 font-semibold">No active pricing workspace</p>
          {isAdmin ? (
            <div className="max-w-md mx-auto flex flex-col sm:flex-row gap-2">
              <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Pricing title (e.g. Volume III — Cost)" className="input flex-1 min-w-0" />
              <button onClick={() => createMutation.mutate()} disabled={!newTitle.trim() || createMutation.isPending} style={gradient} className="btn-primary justify-center flex items-center gap-1.5 disabled:opacity-50">{createMutation.isPending ? <Loader className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create</button>
            </div>
          ) : <p className="text-xs text-gray-600">Read-only access — ask an administrator to create pricing.</p>}
          {versions.length > 0 && <p className="text-xs text-gray-600">{versions.length} historical version(s) exist for this opportunity.</p>}
        </div>
      ) : (
        <>
          {/* header actions */}
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin && ws.status === 'DRAFT' && <button onClick={act(() => pricingApi.submit(ws.id), 'Submitted for review')} className="btn-primary btn-sm">Submit for review</button>}
            {isAdmin && ws.status === 'IN_REVIEW' && <>
              <button onClick={act(() => pricingApi.approve(ws.id), 'Approved')} className="btn-primary btn-sm">Approve</button>
              <button onClick={() => { const c = prompt('Reason for rejection?'); if (c?.trim()) act(() => pricingApi.reject(ws.id, c.trim()), 'Rejected')() }} className="btn-danger btn-sm">Reject</button>
              <button onClick={() => { const c = prompt('What changes are needed?'); if (c?.trim()) act(() => pricingApi.requestChanges(ws.id, c.trim()), 'Changes requested')() }} className="btn-secondary btn-sm text-amber-400">Request changes</button>
            </>}
            {isAdmin && (ws.status === 'APPROVED' || ws.status === 'REJECTED') && <button onClick={act(() => pricingApi.newVersion(ws.id), 'New version created')} className="btn-primary btn-sm flex items-center gap-1.5"><GitBranch className="w-3.5 h-3.5" /> New version</button>}
            {isAdmin && <button onClick={() => { const t = prompt('Rename pricing workspace', ws.title); if (t?.trim()) act(() => pricingApi.rename(ws.id, t.trim()), 'Renamed')() }} className="btn-secondary btn-sm">Rename</button>}
            {isAdmin && ws.status !== 'ARCHIVED' && <button onClick={() => { if (confirm('Archive this pricing?')) act(() => pricingApi.archive(ws.id), 'Archived')() }} className="btn-danger btn-sm flex items-center gap-1.5"><Archive className="w-3.5 h-3.5" /> Archive</button>}
            {isAdmin && ws.status === 'ARCHIVED' && <button onClick={act(() => pricingApi.restore(ws.id), 'Restored')} className="btn-secondary btn-sm text-green-400">Restore</button>}
            {ws.status === 'APPROVED' && <span className="chip chip-success !whitespace-normal"><CheckCircle2 className="w-3.5 h-3.5" /> Approved & locked — create a new version to change</span>}
          </div>

          {/* scenario tabs */}
          <div className="tabs">
            {ws.scenarios.map((s) => (
              <button key={s.id} onClick={() => setActiveScenarioId(s.id)} className="tab" data-active={scenario?.id === s.id}>
                <Layers className="w-3.5 h-3.5" /> {s.name}{s.isPreferred && <span className="text-[9px] text-amber-400">★</span>}
                {scenario?.id === s.id && <TabIndicator id="pricing-scenarios" />}
              </button>
            ))}
            {isAdmin && editable && <button onClick={() => { const n = prompt('Scenario name?'); if (n?.trim()) act(() => pricingApi.addScenario(ws.id, { name: n.trim() }), 'Scenario added')() }} className="btn-ghost btn-sm ml-1"><Plus className="w-3.5 h-3.5 inline" /> scenario</button>}
          </div>

          {/* §7.6 — Pricing Agent competitive benchmark. Read-only: the
              backend owns every figure, and the agent changes no input. */}
          <PricingAgentPanel workspaceId={ws.id} />

          {scenario && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 space-y-4">
                <ScenarioEditor scenario={scenario} isAdmin={isAdmin} editable={editable} onChanged={invalidate} />
              </div>
              <div className="space-y-4">
                <SummaryCard scenario={scenario} />
                {isAdmin && <div className="flex flex-wrap gap-2">
                  {editable && <button onClick={act(() => pricingApi.duplicateScenario(scenario.id), 'Scenario duplicated')} className="btn-secondary btn-sm">Duplicate scenario</button>}
                  {!scenario.isPreferred && <button onClick={act(() => pricingApi.selectScenario(ws.id, scenario.id), 'Preferred set')} className="btn-secondary btn-sm">Set preferred</button>}
                </div>}
                <CompareCard workspaceId={ws.id} />
                <BenchmarkCard data={benchQuery.data?.data} />
                <ReviewsCard workspaceId={ws.id} />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ScenarioEditor({ scenario, isAdmin, editable, onChanged }: { scenario: Scenario; isAdmin: boolean; editable: boolean; onChanged: () => void }) {
  const { toast } = useToast()
  const redacted = scenario.sensitiveRedacted
  const act = (fn: () => Promise<any>, msg: string) => async () => { try { await fn(); onChanged(); toast(msg, 'success') } catch (e: any) { toast(e?.response?.data?.error || 'Action failed', 'error') } }
  const canEdit = isAdmin && editable

  return (
    <div className="space-y-4">
      {redacted && <div className="panel p-3 text-xs text-gray-500 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> Sensitive cost rates are hidden for your role. Total price is shown.</div>}
      {/* Labour */}
      <Panel title="Labour categories & hours">
        <LineTable
          rows={scenario.laborLines}
          cols={redacted ? ['Category', 'Hrs'] : ['Category', 'Hrs', 'Rate', 'Esc%', 'Direct $']}
          render={(l: LaborLine) => redacted ? [l.categoryName, l.hours] : [l.categoryName, l.hours, money(l.baseRate), `${Number(l.escalationPct ?? 0)}%`, money(l.directLaborAmount)]}
          onDelete={canEdit ? (id) => act(() => pricingApi.deleteLabor(id), 'Line removed')() : undefined}
          idOf={(l: LaborLine) => l.id}
        />
        {canEdit && <AddLaborForm scenarioId={scenario.id} onAdded={onChanged} />}
      </Panel>
      {/* Indirect */}
      <Panel title="Indirect rate build-up">
        <LineTable
          rows={scenario.indirectRates}
          cols={redacted ? ['Name', 'Type', 'Base'] : ['Name', 'Type', '%', 'Base']}
          render={(r: IndirectRate) => redacted ? [r.name, r.rateType, r.costBase] : [r.name, r.rateType, `${Number(r.percent ?? 0)}%`, r.costBase]}
          onDelete={canEdit ? (id) => act(() => pricingApi.deleteIndirect(id), 'Rate removed')() : undefined}
          idOf={(r: IndirectRate) => r.id}
        />
        {canEdit && <AddIndirectForm scenarioId={scenario.id} onAdded={onChanged} />}
      </Panel>
      {/* Other / subcontractor */}
      <Panel title="Other direct costs & subcontractors">
        <LineTable
          rows={scenario.otherCosts}
          cols={redacted ? ['Category', 'Description', 'Qty'] : ['Category', 'Description', 'Qty', 'Unit $', 'Total $']}
          render={(o: OtherCost) => redacted ? [o.costCategory, o.description, o.quantity] : [o.costCategory, o.description, o.quantity, money(o.unitCost), money(o.totalAmount)]}
          onDelete={canEdit ? (id) => act(() => pricingApi.deleteOther(id), 'Cost removed')() : undefined}
          idOf={(o: OtherCost) => o.id}
        />
        {canEdit && <AddOtherForm scenarioId={scenario.id} onAdded={onChanged} />}
      </Panel>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="card"><p className="overline mb-3">{title}</p>{children}</div>
}

function LineTable<T>({ rows, cols, render, onDelete, idOf }: { rows: T[]; cols: string[]; render: (r: T) => (string | null)[]; onDelete?: (id: string) => void; idOf: (r: T) => string }) {
  if (rows.length === 0) return <p className="text-xs text-gray-500 py-2">No lines yet.</p>
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead><tr>{cols.map((c) => <th key={c} className={NUMERIC_COLS.has(c) ? '!text-right' : ''}>{c}</th>)}{onDelete && <th />}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={idOf(r)}>{render(r).map((cell, i) => <td key={i} className={`text-gray-300 tabular-nums ${NUMERIC_COLS.has(cols[i]) ? 'text-right whitespace-nowrap' : ''}`}>{cell}</td>)}{onDelete && <td className="text-right"><button onClick={() => onDelete(idOf(r))} aria-label="Remove line" className="btn-ghost btn-sm !px-1.5 text-gray-500 hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button></td>}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function AddLaborForm({ scenarioId, onAdded }: { scenarioId: string; onAdded: () => void }) {
  const { toast } = useToast()
  const [f, setF] = useState({ categoryName: '', categoryCode: '', description: '', personnelCount: '', periodLabel: '', hours: '', baseRate: '', escalationPct: '' })
  const submit = async () => {
    try {
      await pricingApi.addLabor(scenarioId, {
        categoryName: f.categoryName.trim(), categoryCode: f.categoryCode.trim() || undefined, description: f.description.trim() || undefined,
        personnelCount: f.personnelCount ? Number(f.personnelCount) : undefined, periodLabel: f.periodLabel.trim() || undefined,
        hours: Number(f.hours), baseRate: Number(f.baseRate), escalationPct: f.escalationPct ? Number(f.escalationPct) : 0,
      })
      setF({ categoryName: '', categoryCode: '', description: '', personnelCount: '', periodLabel: '', hours: '', baseRate: '', escalationPct: '' }); onAdded(); toast('Labour line added', 'success')
    }
    catch (e: any) { toast(e?.response?.data?.error || 'Invalid line', 'error') }
  }
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      <input value={f.categoryName} onChange={(e) => setF({ ...f, categoryName: e.target.value })} placeholder="Category *" className="input !py-1.5 !text-xs sm:!w-32" />
      <input value={f.categoryCode} onChange={(e) => setF({ ...f, categoryCode: e.target.value })} placeholder="Code" className="input !py-1.5 !text-xs sm:!w-20" />
      <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Description" className="input !py-1.5 !text-xs sm:!w-40" />
      <input value={f.personnelCount} onChange={(e) => setF({ ...f, personnelCount: e.target.value })} placeholder="# ppl" type="number" className="input !py-1.5 !text-xs sm:!w-16" />
      <input value={f.periodLabel} onChange={(e) => setF({ ...f, periodLabel: e.target.value })} placeholder="Period" className="input !py-1.5 !text-xs sm:!w-24" />
      <input value={f.hours} onChange={(e) => setF({ ...f, hours: e.target.value })} placeholder="Hours" type="number" className="input !py-1.5 !text-xs sm:!w-20" />
      <input value={f.baseRate} onChange={(e) => setF({ ...f, baseRate: e.target.value })} placeholder="Rate" type="number" className="input !py-1.5 !text-xs sm:!w-20" />
      <input value={f.escalationPct} onChange={(e) => setF({ ...f, escalationPct: e.target.value })} placeholder="Esc%" type="number" className="input !py-1.5 !text-xs sm:!w-16" />
      <button onClick={submit} disabled={!f.categoryName.trim() || !f.hours || !f.baseRate} className="btn-primary btn-sm disabled:opacity-40">Add</button>
    </div>
  )
}

function AddIndirectForm({ scenarioId, onAdded }: { scenarioId: string; onAdded: () => void }) {
  const { toast } = useToast()
  const [f, setF] = useState({ name: '', rateType: 'FRINGE', percent: '', costBase: 'DIRECT_LABOUR' })
  const submit = async () => {
    try { await pricingApi.addIndirect(scenarioId, { name: f.name.trim(), rateType: f.rateType, percent: Number(f.percent), costBase: f.costBase }); setF({ name: '', rateType: 'FRINGE', percent: '', costBase: 'DIRECT_LABOUR' }); onAdded(); toast('Rate added', 'success') }
    catch (e: any) { toast(e?.response?.data?.error || 'Invalid rate', 'error') }
  }
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name" className="input !py-1.5 !text-xs sm:!w-28" />
      <select value={f.rateType} onChange={(e) => setF({ ...f, rateType: e.target.value })} className="input !w-auto !py-1.5 !text-xs">{RATE_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
      <input value={f.percent} onChange={(e) => setF({ ...f, percent: e.target.value })} placeholder="%" type="number" className="input !py-1.5 !text-xs sm:!w-16" />
      <select value={f.costBase} onChange={(e) => setF({ ...f, costBase: e.target.value })} className="input !w-auto !py-1.5 !text-xs">{COST_BASES.map((b) => <option key={b}>{b}</option>)}</select>
      <button onClick={submit} disabled={!f.name.trim() || !f.percent} className="btn-primary btn-sm disabled:opacity-40">Add</button>
    </div>
  )
}

function AddOtherForm({ scenarioId, onAdded }: { scenarioId: string; onAdded: () => void }) {
  const { toast } = useToast()
  const [f, setF] = useState({ costCategory: 'TRAVEL', description: '', quantity: '1', unitCost: '' })
  const submit = async () => {
    try { await pricingApi.addOther(scenarioId, { costCategory: f.costCategory, description: f.description.trim(), quantity: Number(f.quantity), unitCost: Number(f.unitCost) }); setF({ costCategory: 'TRAVEL', description: '', quantity: '1', unitCost: '' }); onAdded(); toast('Cost line added', 'success') }
    catch (e: any) { toast(e?.response?.data?.error || 'Invalid cost', 'error') }
  }
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      <select value={f.costCategory} onChange={(e) => setF({ ...f, costCategory: e.target.value })} className="input !w-auto !py-1.5 !text-xs">{OTHER_CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
      <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Description" className="input !py-1.5 !text-xs sm:!w-40" />
      <input value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} placeholder="Qty" type="number" className="input !py-1.5 !text-xs sm:!w-16" />
      <input value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} placeholder="Unit $" type="number" className="input !py-1.5 !text-xs sm:!w-20" />
      <button onClick={submit} disabled={!f.description.trim() || !f.unitCost} className="btn-primary btn-sm disabled:opacity-40">Add</button>
    </div>
  )
}

function SummaryCard({ scenario }: { scenario: Scenario }) {
  const rows: [string, string | null][] = scenario.sensitiveRedacted
    ? [['Total proposed price', scenario.totalPrice]]
    : [['Direct labour', scenario.totalDirectLabor], ['Fringe', scenario.totalFringe], ['Overhead', scenario.totalOverhead], ['ODC', scenario.totalOdc], ['Subcontractor', scenario.totalSubcontractor], ['G&A', scenario.totalGA], ['Subtotal before fee', scenario.subtotalBeforeFee], ['Fee', scenario.totalFee], ['Total proposed price', scenario.totalPrice]]
  return (
    <div className="card">
      <p className="overline mb-3">Calculation breakdown</p>
      <table className="w-full text-sm">
        <tbody>{rows.map(([label, val], i) => (
          <tr key={label} className={i === rows.length - 1 ? 'border-t border-gray-700 font-semibold' : ''}>
            <td className={`py-1.5 text-gray-400 ${i === rows.length - 1 ? 'pt-2.5 text-gray-200' : ''}`}>{label}</td><td className={`py-1.5 text-right text-gray-200 tabular-nums whitespace-nowrap ${i === rows.length - 1 ? 'pt-2.5 text-base' : ''}`}>{money(val)}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="text-[10px] text-gray-600 mt-3">Backend-computed (decimal-safe). Not a guarantee of award.</p>
    </div>
  )
}

function CompareCard({ workspaceId }: { workspaceId: string }) {
  const { data } = useQuery({ queryKey: ['pricing-compare', workspaceId], queryFn: () => pricingApi.compare(workspaceId) })
  const scenarios = data?.data?.scenarios ?? []
  if (scenarios.length < 2) return null
  return (
    <div className="card">
      <p className="overline mb-3">Scenario comparison</p>
      {scenarios.map((s: { id: string; name: string; isPreferred: boolean; totalPrice: string }) => (
        <div key={s.id} className="flex justify-between gap-3 text-sm py-1.5 border-b border-gray-800/60 last:border-0"><span className="text-gray-400 min-w-0">{s.name}{s.isPreferred && <span className="text-amber-400"> ★</span>}</span><span className="text-gray-200 tabular-nums whitespace-nowrap">{money(s.totalPrice)}</span></div>
      ))}
    </div>
  )
}

function BenchmarkCard({ data }: { data: any }) {
  if (!data) return null
  return (
    <div className="card">
      <p className="overline mb-3">Competitive benchmark</p>
      {!data.available ? <p className="text-xs text-gray-500">{data.message}</p> : (
        <div className="text-xs text-gray-400 space-y-1.5">
          <p>Comparable awards: <span className="text-gray-200 tabular-nums">{data.comparableAwardCount}</span></p>
          <p>Average award value: <span className="text-gray-200 tabular-nums">{money(String(data.averageAwardValue))}</span></p>
          <p className="text-[10px] text-gray-600">{data.limitations}</p>
          <p className="text-[10px] text-gray-600">Source: {data.source}</p>
        </div>
      )}
    </div>
  )
}

function ReviewsCard({ workspaceId }: { workspaceId: string }) {
  const { data } = useQuery({ queryKey: ['pricing-reviews', workspaceId], queryFn: () => pricingApi.reviews(workspaceId) })
  const reviews = data?.data?.reviews ?? []
  if (reviews.length === 0) return null
  return (
    <div className="card">
      <p className="overline mb-3">Review history</p>
      {reviews.map((r: { id: string; action: string; toStatus: string | null; createdAt: string; comment: string | null }) => (
        <div key={r.id} className="text-xs text-gray-400 py-1.5 border-b border-gray-800/60 last:border-0"><span className="text-gray-300">{r.action}</span>{r.toStatus && <span className="text-gray-600"> → {r.toStatus}</span>}{r.comment && <span className="block text-gray-500 italic">"{r.comment}"</span>}</div>
      ))}
    </div>
  )
}
