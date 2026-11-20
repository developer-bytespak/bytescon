// =============================================================
// Proposal preview — the whole proposal laid out in a template, as the agency
// will read it, before it is submitted.
//   • Templates: the standard federal layouts (full proposal, commercial items,
//     RFQ quote, sources-sought response, GSA eBuy quote). Template 1 is the
//     default; choosing another keeps it on the proposal.
//   • Format: the template's standard format with the solicitation's own rules
//     on top (font, size, margins, spacing, page limits), each rule with the
//     requirement it came from.
//   • What's left before submitting: sections or the price not approved, the
//     "[… REQUIRED]" placeholders, and volumes over their page limit.
//   • Downloads: the same layout as a PDF or a Word file.
// The layout comes from the server (services/proposalTemplates.ts), so the
// preview, the PDF and the Word file always match.
// =============================================================
import { Fragment, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Download, FileText, Loader } from 'lucide-react'
import { opportunitiesApi, pricingApi, proposalApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from '../components/Toast'
import { Spinner } from '../components/ui'
import { isDemoSite } from '../demo/demoMode'

type DocBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'facts'; rows: Array<[string, string]> }
  | { kind: 'table'; head: string[]; rows: string[][]; numeric?: number[] }
interface DocPart { key: string; title: string; volume: string | null; blocks: DocBlock[] }
interface Template { key: string; name: string; use: string; form: { code: string; name: string; url: string } | null }
interface Format { font: string; fontSize: number; marginsIn: number; lineSpacing: number; pageLimits: Array<{ volume: string; pages: number }>; sources: Array<{ rule: string; text: string }> }
interface LimitCheck { part: string; title: string; pages: number; limit: number | null; over: boolean; source: string | null }
interface DocumentResponse {
  templates: Template[]; selected: string; saved: string
  document: { template: Template; format: Format; title: string; parts: DocPart[] }
  pageCounts: Record<string, number>; totalPages: number; limits: LimitCheck[]
}
interface Section { id: string; status: string; isArchived?: boolean }

/** The placeholders left where a fact was missing, e.g. "[SECTION M — FULL TEXT REQUIRED]". */
const PLACEHOLDER = /\[[^\]\n]*REQUIRED[^\]\n]*\]/g
export const placeholdersIn = (text: string | null | undefined): number => (text ?? '').match(PLACEHOLDER)?.length ?? 0
const blockText = (b: DocBlock): string => b.kind === 'facts' ? b.rows.flat().join(' ') : b.kind === 'table' ? b.rows.flat().join(' ') : b.text

/** Text as written, with each placeholder marked so it can't be missed. */
function Marked({ text }: { text: string }) {
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(PLACEHOLDER)) {
    parts.push(text.slice(last, m.index))
    parts.push(<mark key={m.index} className="rounded px-0.5" style={{ background: '#fef3c7', color: '#92400e' }}>{m[0]}</mark>)
    last = (m.index ?? 0) + m[0].length
  }
  parts.push(text.slice(last))
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>
}

const CSS_FONT: Record<string, string> = {
  'Times New Roman': '"Times New Roman", Times, serif', Garamond: 'Garamond, "Times New Roman", serif', Cambria: 'Cambria, Georgia, serif', Georgia: 'Georgia, serif',
  Arial: 'Arial, Helvetica, sans-serif', Calibri: 'Calibri, Arial, sans-serif', Helvetica: 'Helvetica, Arial, sans-serif', Verdana: 'Verdana, sans-serif', 'Courier New': '"Courier New", Courier, monospace',
}

/** One part of the proposal on white "paper", in the proposal's font and size. */
function Page({ part, format, pages, limit }: { part: DocPart; format: Format; pages: number; limit: LimitCheck | undefined }) {
  const cover = part.key === 'cover'
  return (
    <section id={`preview-${part.key}`} className="scroll-mt-24">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1.5">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{part.title}</h3>
        <span className={`text-xs tabular-nums ${limit?.over ? 'font-semibold' : ''}`} style={{ color: limit?.over ? 'var(--danger)' : 'var(--text-muted)' }}>
          {pages} page{pages === 1 ? '' : 's'}{limit?.limit ? ` of ${limit.limit} allowed` : ''}
        </span>
      </div>
      <div className="rounded-sm shadow-md mx-auto" style={{
        background: '#fff', color: '#111', maxWidth: '8.5in', minHeight: cover ? '5in' : undefined,
        padding: `${Math.min(format.marginsIn, 1.25)}in`, fontFamily: CSS_FONT[format.font] ?? 'serif',
        fontSize: `${format.fontSize}pt`, lineHeight: 1.25 * format.lineSpacing,
      }}>
        {!cover && <p style={{ fontWeight: 700, fontSize: `${format.fontSize + 4}pt`, marginBottom: '0.8em' }}>{part.title}</p>}
        {part.blocks.map((b, i) => {
          if (b.kind === 'heading') return <p key={i} style={cover ? { fontWeight: 700, fontSize: `${format.fontSize + 8}pt`, textAlign: 'center', margin: '1.5em 0' } : { fontWeight: 700, fontSize: `${format.fontSize + 1}pt`, margin: '1em 0 0.3em' }}>{b.text}</p>
          if (b.kind === 'para') return <p key={i} className="whitespace-pre-wrap" style={{ marginBottom: '0.7em' }}><Marked text={b.text} /></p>
          if (b.kind === 'facts') return <div key={i} style={{ marginBottom: '0.7em' }}>{b.rows.map(([k, v]) => <p key={k}><strong>{k}:</strong> <Marked text={v} /></p>)}</div>
          return (
            <div key={i} className="overflow-x-auto" style={{ marginBottom: '0.8em' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: `${format.fontSize - 1}pt` }}>
                {b.head.some(Boolean) && <thead><tr>{b.head.map((h, j) => <th key={j} style={{ borderBottom: '1px solid #999', textAlign: b.numeric?.includes(j) ? 'right' : 'left', padding: '3px 4px' }}>{h}</th>)}</tr></thead>}
                <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j} style={{ borderBottom: '1px solid #ddd', textAlign: b.numeric?.includes(j) ? 'right' : 'left', padding: '3px 4px', verticalAlign: 'top' }}><Marked text={c} /></td>)}</tr>)}</tbody>
              </table>
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default function ProposalPreview() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { toast } = useToast()
  const qc = useQueryClient()
  const isAdmin = user?.role === 'ADMIN'
  const [picked, setPicked] = useState<string | null>(null)
  const [downloading, setDownloading] = useState<'pdf' | 'docx' | null>(null)

  const opp = useQuery({ queryKey: ['opportunity', id], queryFn: () => opportunitiesApi.getById(id!), enabled: !!id })
  const ws = useQuery({ queryKey: ['proposal-workspace', id], queryFn: () => proposalApi.getWorkspace(id!), enabled: !!id })
  const price = useQuery({ queryKey: ['pricing-workspace', id], queryFn: () => pricingApi.getWorkspace(id!), enabled: !!id })
  const proposal = ws.data?.data?.exists ? ws.data.data.proposal as { id: string; title: string; sections: Section[] } : null
  const docQuery = useQuery<{ data: DocumentResponse }>({
    queryKey: ['proposal-document', proposal?.id, picked],
    queryFn: () => proposalApi.document(proposal!.id, picked ?? undefined),
    enabled: !!proposal,
  })
  const save = useMutation({
    mutationFn: (key: string) => proposalApi.setTemplate(proposal!.id, key),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['proposal-document', proposal?.id] }),
    onError: (e: any) => toast(e?.response?.data?.error || 'Could not keep the template', 'error'),
  })

  if (opp.isLoading || ws.isLoading || price.isLoading) return <div className="flex justify-center py-24"><Spinner /></div>

  const o = opp.data?.data ?? opp.data
  const d = docQuery.data?.data
  const template = d?.selected ?? picked
  const choose = (key: string) => { setPicked(key); if (isAdmin) save.mutate(key) }
  const download = async (format: 'pdf' | 'docx') => {
    if (!proposal || !template) return
    setDownloading(format)
    try { await proposalApi.exportFile(proposal.id, template, format, `${(proposal.title || 'proposal').replace(/[^\w.-]+/g, '_')}.${format}`) }
    catch (e: any) { toast(e?.response?.data?.error || 'Could not download the file', 'error') }
    finally { setDownloading(null) }
  }

  const sections = (proposal?.sections ?? []).filter((s) => !s.isArchived)
  const approved = sections.filter((s) => s.status === 'APPROVED').length
  const pw = price.data?.data?.exists ? price.data.data.workspace as { status: string } : null
  const placeholders = (d?.document.parts ?? []).reduce((n, p) => n + p.blocks.reduce((m, b) => m + placeholdersIn(blockText(b)), 0), 0)
  const over = (d?.limits ?? []).filter((l) => l.over)
  const todo: { text: string; to: string }[] = [
    ...(sections.length === 0 ? [{ text: 'The proposal has no sections yet.', to: `/opportunities/${id}/proposal` }] : []),
    ...(sections.length > 0 && approved < sections.length ? [{ text: `${sections.length - approved} of ${sections.length} sections are not approved yet.`, to: `/opportunities/${id}/proposal` }] : []),
    ...(placeholders > 0 ? [{ text: `${placeholders} placeholder${placeholders === 1 ? '' : 's'} marked "REQUIRED" still need the real facts (highlighted below).`, to: `/opportunities/${id}/proposal` }] : []),
    ...over.map((l) => ({ text: `${l.title} is ${l.pages} pages; the solicitation allows ${l.limit}.`, to: `/opportunities/${id}/proposal` })),
    ...(!pw ? [{ text: 'There is no price yet.', to: `/opportunities/${id}/pricing` }] : pw.status !== 'APPROVED' ? [{ text: 'The price is not approved yet.', to: `/opportunities/${id}/pricing` }] : []),
  ]
  const fmt = d?.document.format

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
      <button onClick={() => navigate(`/opportunities/${id}/proposal`)} className="btn-ghost btn-sm -ml-2 flex items-center gap-1"><ArrowLeft className="w-4 h-4" /> Back to the proposal</button>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="overline">Proposal preview</p>
          <h1 className="page-title mt-1">{o?.title ?? 'Opportunity'}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {proposal && !isDemoSite && (['pdf', 'docx'] as const).map((f) => (
            <button key={f} onClick={() => void download(f)} disabled={!!downloading || !d} className="btn-secondary btn-sm flex items-center gap-1.5 disabled:opacity-60">
              {downloading === f ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} {f === 'pdf' ? 'Download PDF' : 'Download Word'}
            </button>
          ))}
          <Link to={`/opportunities/${id}/submission`} className="btn-primary btn-sm flex items-center gap-1.5">Prepare the submission <ArrowRight className="w-3.5 h-3.5" /></Link>
        </div>
      </div>

      {!proposal ? (
        <div className="card text-sm text-center" style={{ color: 'var(--text-muted)' }}><FileText className="w-4 h-4 inline mr-1" />No proposal yet. <Link to={`/opportunities/${id}/proposal`} style={{ color: 'var(--accent)' }}>Write the proposal</Link></div>
      ) : (
        <>
          {/* Templates. */}
          <section className="card" aria-labelledby="template-heading">
            <h2 id="template-heading" className="text-sm font-semibold mb-1" style={{ color: 'var(--text)' }}>Template</h2>
            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>SAM.gov has no single template: each solicitation's Section L says what it wants. Pick the layout that matches it; its own format rules are applied on top.{!isAdmin && ' Only admins can change the saved template; you can preview any of them.'}</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Template">
              {(d?.templates ?? []).map((t, i) => {
                const on = t.key === template
                return (
                  <button key={t.key} type="button" role="radio" aria-checked={on} onClick={() => choose(t.key)}
                    className="text-left rounded-lg p-3 transition-colors" style={{ border: `2px solid ${on ? 'var(--accent)' : 'var(--line)'}`, background: on ? 'var(--surface-2)' : 'transparent' }}>
                    <span className="flex items-start justify-between gap-2">
                      <span className="text-sm font-medium" style={{ color: 'var(--text)' }}>{i + 1}. {t.name}</span>
                      {on && <Check className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--accent)' }} aria-hidden="true" />}
                    </span>
                    <span className="block text-xs mt-1" style={{ color: 'var(--text-2)' }}>{t.use}</span>
                    {t.form && <span className="block text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>With form {t.form.code}</span>}
                  </button>
                )
              })}
            </div>
            {d?.document.template.form && (
              <p className="text-xs mt-3" style={{ color: 'var(--text-2)' }}>
                This template goes with form <strong>{d.document.template.form.code}</strong> ({d.document.template.form.name}): fill in and sign the official form, and put it on top. <a href={d.document.template.form.url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>Get the blank form</a>
              </p>
            )}
          </section>

          {/* Format, and where each rule came from. */}
          {fmt && (
            <section className="card" aria-labelledby="format-heading">
              <h2 id="format-heading" className="text-sm font-semibold mb-1" style={{ color: 'var(--text)' }}>Format</h2>
              <p className="text-sm" style={{ color: 'var(--text)' }}>
                {fmt.font}, {fmt.fontSize} pt · {fmt.marginsIn}-inch margins · {fmt.lineSpacing === 2 ? 'double' : fmt.lineSpacing === 1.5 ? '1.5' : 'single'} spacing · US Letter
                {' · '}{d!.totalPages} pages in all
              </p>
              {fmt.sources.length ? (
                <ul className="mt-2 space-y-1 text-xs">
                  {fmt.sources.map((s) => <li key={s.rule} style={{ color: 'var(--text-2)' }}><strong>{s.rule}</strong>: from "{s.text}"</li>)}
                </ul>
              ) : (
                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>No format rules (font, margins, page limits) were found in this solicitation's requirements, so the template's standard format is used. Check Section L of the solicitation.</p>
              )}
              {d!.limits.some((l) => l.limit) && (
                <ul className="mt-2 flex flex-wrap gap-2 text-xs">
                  {d!.limits.filter((l) => l.limit).map((l) => (
                    <li key={l.part} className={`chip ${l.over ? 'chip-danger' : 'chip-success'}`}>{l.title}: {l.pages} of {l.limit} pages</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* What's left before it can be submitted. */}
          {d && (
            <section className="card !border-2" style={{ borderColor: todo.length ? 'var(--warning, #f59e0b)' : 'var(--success, #22c55e)' }} aria-label="Ready to submit?">
              {todo.length === 0 ? (
                <p className="text-sm flex items-center gap-2" style={{ color: 'var(--text)' }}><CheckCircle2 className="w-4 h-4" style={{ color: 'var(--success, #22c55e)' }} /> Every section and the price are approved, nothing is missing, and every volume is within its page limit. It's ready to submit.</p>
              ) : (
                <>
                  <p className="text-sm font-medium flex items-center gap-2" style={{ color: 'var(--text)' }}><AlertTriangle className="w-4 h-4" style={{ color: 'var(--warning, #f59e0b)' }} /> Before you submit:</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {todo.map((t) => <li key={t.text} style={{ color: 'var(--text-2)' }}>• {t.text} <Link to={t.to} className="whitespace-nowrap" style={{ color: 'var(--accent)' }}>Fix it</Link></li>)}
                  </ul>
                </>
              )}
            </section>
          )}

          {/* The proposal, part by part, in its format. */}
          {docQuery.isLoading || !d ? (
            <div className="flex justify-center py-12">{docQuery.isError ? <p className="text-sm" style={{ color: 'var(--danger)' }}>Could not lay out the proposal.</p> : <Spinner />}</div>
          ) : (
            <div className="space-y-8" aria-label="The proposal">
              <nav aria-label="Contents" className="card">
                <h2 className="text-sm font-semibold mb-2" style={{ color: 'var(--text)' }}>Contents: {d.document.template.name}</h2>
                <ol className="text-sm space-y-1 list-decimal pl-5">
                  {d.document.parts.map((p) => <li key={p.key}><a href={`#preview-${p.key}`} style={{ color: 'var(--accent)' }}>{p.title}</a> <span style={{ color: 'var(--text-muted)' }}>({d.pageCounts[p.key] ?? 0} p.)</span></li>)}
                </ol>
              </nav>
              {d.document.parts.map((p) => <Page key={p.key} part={p} format={d.document.format} pages={d.pageCounts[p.key] ?? 0} limit={d.limits.find((l) => l.part === p.key)} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
