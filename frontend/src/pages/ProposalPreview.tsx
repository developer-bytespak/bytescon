// =============================================================
// Proposal preview — the whole proposal as the agency would read it, before it
// is submitted: a cover, the contents, every section in order, then the price.
// A summary at the top says what still needs doing: sections not approved, the
// price not approved, and the "[… REQUIRED]" placeholders the AI left where a
// fact was missing. Read-only; the work is done on the Proposal and Pricing pages.
// =============================================================
import { Fragment, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, FileText } from 'lucide-react'
import { clientReviewApi, opportunitiesApi, pricingApi, proposalApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { Spinner } from '../components/ui'
import { isDemoSite } from '../demo/demoMode'

interface Section { id: string; title: string; sectionNumber: string | null; draft: string | null; status: string; sortOrder: number; isArchived?: boolean }
interface LaborLine { id: string; categoryName: string; hours: string; baseRate: string | null; directLaborAmount: string | null }
interface IndirectRate { id: string; name: string; percent: string | null }
interface OtherCost { id: string; costCategory: string; description: string; quantity: string; unitCost: string | null; totalAmount: string | null }
interface Scenario {
  id: string; name: string; isPreferred: boolean; sensitiveRedacted?: boolean
  totalDirectLabor: string | null; totalFringe: string | null; totalOverhead: string | null; totalGA: string | null
  totalOdc: string | null; totalSubcontractor: string | null; totalFee: string | null; totalPrice: string | null
  laborLines: LaborLine[]; indirectRates: IndirectRate[]; otherCosts: OtherCost[]
}

/** The placeholders the AI leaves where a fact was missing, e.g. "[SECTION M — FULL TEXT REQUIRED]". */
const PLACEHOLDER = /\[[^\]\n]*REQUIRED[^\]\n]*\]/g
export const placeholdersIn = (text: string | null | undefined): number => (text ?? '').match(PLACEHOLDER)?.length ?? 0

const money = (v: string | null | undefined) => (v == null || v === '' ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const day = (v: string | null | undefined) => (v ? new Date(v).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '—')

/** Section text as written, with each placeholder marked so it can't be missed. */
function SectionText({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(PLACEHOLDER)) {
    parts.push(text.slice(last, m.index))
    parts.push(<mark key={m.index} className="rounded px-0.5" style={{ background: 'var(--warning-bg, #fef3c7)', color: 'var(--warning-text, #92400e)' }}>{m[0]}</mark>)
    last = (m.index ?? 0) + m[0].length
  }
  parts.push(text.slice(last))
  return <div className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</div>
}

export default function ProposalPreview() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { firm } = useAuth()
  const opp = useQuery({ queryKey: ['opportunity', id], queryFn: () => opportunitiesApi.getById(id!), enabled: !!id })
  const ws = useQuery({ queryKey: ['proposal-workspace', id], queryFn: () => proposalApi.getWorkspace(id!), enabled: !!id })
  const price = useQuery({ queryKey: ['pricing-workspace', id], queryFn: () => pricingApi.getWorkspace(id!), enabled: !!id })

  if (opp.isLoading || ws.isLoading || price.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>

  const o = opp.data?.data ?? opp.data
  const proposal = ws.data?.data?.exists ? ws.data.data.proposal as { id: string; title: string; sections: Section[] } : null
  const sections = (proposal?.sections ?? []).filter((s) => !s.isArchived).sort((a, b) => a.sortOrder - b.sortOrder)
  const pw = price.data?.data?.exists ? price.data.data.workspace as { status: string; preferredScenarioId: string | null; scenarios: Scenario[] } : null
  const scenario = pw ? pw.scenarios.find((s) => s.id === pw.preferredScenarioId) ?? pw.scenarios.find((s) => s.isPreferred) ?? pw.scenarios[0] ?? null : null

  const approved = sections.filter((s) => s.status === 'APPROVED').length
  const placeholders = sections.reduce((n, s) => n + placeholdersIn(s.draft), 0)
  const priceApproved = pw?.status === 'APPROVED'
  const ready = sections.length > 0 && approved === sections.length && priceApproved && placeholders === 0
  const fileName = `${(proposal?.title ?? 'proposal').replace(/[^\w.-]+/g, '_')}.pdf`
  const todo: { text: string; to: string }[] = [
    ...(sections.length === 0 ? [{ text: 'The proposal has no sections yet.', to: `/opportunities/${id}/proposal` }] : []),
    ...(sections.length > 0 && approved < sections.length ? [{ text: `${sections.length - approved} of ${sections.length} sections are not approved yet.`, to: `/opportunities/${id}/proposal` }] : []),
    ...(placeholders > 0 ? [{ text: `${placeholders} placeholder${placeholders === 1 ? '' : 's'} marked "REQUIRED" still need the real facts (highlighted below).`, to: `/opportunities/${id}/proposal` }] : []),
    ...(!pw ? [{ text: 'There is no price yet.', to: `/opportunities/${id}/pricing` }] : !priceApproved ? [{ text: 'The price is not approved yet.', to: `/opportunities/${id}/pricing` }] : []),
  ]

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <button onClick={() => navigate(`/opportunities/${id}/proposal`)} className="btn-ghost btn-sm -ml-2 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Back to the proposal</button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="overline">Proposal preview</p>
          <h1 className="page-title mt-1">{o?.title ?? 'Opportunity'}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {proposal && !isDemoSite && (
            <button onClick={() => void clientReviewApi.downloadPdf('proposal', proposal.id, fileName)} className="btn-secondary btn-sm flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> Download PDF</button>
          )}
          <Link to={`/opportunities/${id}/submission`} className="btn-primary btn-sm flex items-center gap-1.5">Prepare the submission <ArrowRight className="w-3.5 h-3.5" /></Link>
        </div>
      </div>

      {/* What's left before it can be submitted. */}
      <section className="card !border-2" style={{ borderColor: ready ? 'var(--success, #22c55e)' : 'var(--warning, #f59e0b)' }} aria-label="Ready to submit?">
        {ready ? (
          <p className="text-sm flex items-center gap-2" style={{ color: 'var(--text)' }}><CheckCircle2 className="w-4 h-4" style={{ color: 'var(--success, #22c55e)' }} /> Every section and the price are approved, with no placeholders left. It's ready to submit.</p>
        ) : (
          <>
            <p className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text)' }}><AlertTriangle className="w-4 h-4" style={{ color: 'var(--warning, #f59e0b)' }} /> Before you submit:</p>
            <ul className="mt-2 space-y-1 text-sm">
              {todo.map((t) => <li key={t.text} style={{ color: 'var(--text-2)' }}>• {t.text} <Link to={t.to} className="whitespace-nowrap" style={{ color: 'var(--accent)' }}>Fix it</Link></li>)}
            </ul>
          </>
        )}
      </section>

      {/* The proposal as the agency reads it. */}
      <article className="card space-y-8" aria-label="The proposal">
        <header className="text-center space-y-1.5 pb-6" style={{ borderBottom: '1px solid var(--line)' }}>
          <p className="text-xs uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>Proposal</p>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text)' }}>{proposal?.title ?? o?.title}</h2>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>Submitted to: {o?.agency ?? '—'}</p>
          {o?.solicitationNumber && <p className="text-sm" style={{ color: 'var(--text-2)' }}>Solicitation: {o.solicitationNumber}</p>}
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>Responses due: {day(o?.responseDeadline)}</p>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>Prepared by: {firm?.name ?? '—'}</p>
        </header>

        {sections.length > 0 && (
          <nav aria-label="Contents">
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--text)' }}>Contents</h3>
            <ol className="text-sm space-y-1 list-decimal pl-5">
              {sections.map((s) => <li key={s.id}><a href={`#preview-${s.id}`} style={{ color: 'var(--accent)' }}>{s.title}</a></li>)}
              {pw && <li><a href="#preview-price" style={{ color: 'var(--accent)' }}>Price</a></li>}
            </ol>
          </nav>
        )}

        {sections.length === 0 && (
          <p className="text-sm text-center" style={{ color: 'var(--text-muted)' }}><FileText className="w-4 h-4 inline mr-1" />No sections yet. <Link to={`/opportunities/${id}/proposal`} style={{ color: 'var(--accent)' }}>Write the proposal</Link></p>
        )}

        {sections.map((s, i) => (
          <section key={s.id} id={`preview-${s.id}`} className="scroll-mt-24 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>{s.sectionNumber ?? i + 1}. {s.title}</h3>
              <span className={`chip ${s.status === 'APPROVED' ? 'chip-success' : 'chip-neutral'} !text-[10px]`}>{s.status === 'APPROVED' ? 'Approved' : 'Not approved yet'}</span>
            </div>
            {(s.draft ?? '').trim() ? <SectionText text={s.draft!} /> : <p className="text-sm italic" style={{ color: 'var(--text-muted)' }}>Not written yet.</p>}
          </section>
        ))}

        <section id="preview-price" className="scroll-mt-24 space-y-3 pt-6" style={{ borderTop: '1px solid var(--line)' }}>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold" style={{ color: 'var(--text)' }}>Price{scenario ? `: ${scenario.name}` : ''}</h3>
            {pw && <span className={`chip ${priceApproved ? 'chip-success' : 'chip-neutral'} !text-[10px]`}>{priceApproved ? 'Approved' : 'Not approved yet'}</span>}
          </div>
          {!scenario ? (
            <p className="text-sm italic" style={{ color: 'var(--text-muted)' }}>No price yet. <Link to={`/opportunities/${id}/pricing`} style={{ color: 'var(--accent)' }}>Build the price</Link></p>
          ) : (
            <>
              {!scenario.sensitiveRedacted && scenario.laborLines.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="data-table text-sm">
                    <thead><tr><th className="text-left">Labour category</th><th className="text-right">Hours</th><th className="text-right">Rate</th><th className="text-right">Amount</th></tr></thead>
                    <tbody>{scenario.laborLines.map((l) => <tr key={l.id}><td>{l.categoryName}</td><td className="text-right tabular-nums">{Number(l.hours).toLocaleString('en-US')}</td><td className="text-right tabular-nums">{money(l.baseRate)}</td><td className="text-right tabular-nums">{money(l.directLaborAmount)}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              {!scenario.sensitiveRedacted && scenario.otherCosts.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="data-table text-sm">
                    <thead><tr><th className="text-left">Other costs</th><th className="text-right">Qty</th><th className="text-right">Unit</th><th className="text-right">Amount</th></tr></thead>
                    <tbody>{scenario.otherCosts.map((c) => <tr key={c.id}><td>{c.description} <span style={{ color: 'var(--text-muted)' }}>({c.costCategory.toLowerCase().replace(/_/g, ' ')})</span></td><td className="text-right tabular-nums">{c.quantity}</td><td className="text-right tabular-nums">{money(c.unitCost)}</td><td className="text-right tabular-nums">{money(c.totalAmount)}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm max-w-md ml-auto">
                {!scenario.sensitiveRedacted && ([
                  ['Direct labour', scenario.totalDirectLabor], ['Fringe', scenario.totalFringe], ['Overhead', scenario.totalOverhead],
                  ['Other direct costs', scenario.totalOdc], ['Subcontractors', scenario.totalSubcontractor], ['G&A', scenario.totalGA], ['Fee', scenario.totalFee],
                ] as const).filter(([, v]) => v != null && Number(v) !== 0).map(([k, v]) => (
                  <Fragment key={k}><dt style={{ color: 'var(--text-2)' }}>{k}</dt><dd className="text-right tabular-nums" style={{ color: 'var(--text)' }}>{money(v)}</dd></Fragment>
                ))}
                <dt className="font-semibold pt-1" style={{ color: 'var(--text)', borderTop: '1px solid var(--line)' }}>Total price</dt>
                <dd className="text-right font-semibold tabular-nums pt-1" style={{ color: 'var(--text)', borderTop: '1px solid var(--line)' }}>{money(scenario.totalPrice)}</dd>
              </dl>
              {scenario.sensitiveRedacted && <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Rates and the cost build-up are visible to admins only.</p>}
            </>
          )}
        </section>
      </article>
    </div>
  )
}
