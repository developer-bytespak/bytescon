import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { evidenceApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from './Toast'
import { Spinner } from './ui'
import { Building2, Users, RefreshCw, ShieldCheck, Pencil, AlertTriangle } from 'lucide-react'
import { humanize } from '../lib/humanize'

// §5.1 Stage 3 — Incumbent + Competitor evidence, derived from ingested award
// history. All competitor evidence is HISTORICAL, never a prediction.

interface Incumbent {
  id: string; name: string; uei: string | null; confidence: string; evidenceSource: string | null; whyShown: string | null
  agency: string | null; awardReference: string | null; awardValue: string | null; periodOfPerformance: string | null
  sourceRecordDate: string | null; verification: string; correctionReason: string | null; originalName: string | null; notes: string | null
}
interface Competitor {
  id: string; name: string; uei: string | null; confidence: string; whyShown: string | null; evidenceSource: string | null
  relevantAwardCount: number | null; relevantAwardValue: string | null; agencyRelevant: boolean; naicsRelevant: boolean
  pscRelevant: boolean; isIncumbent: boolean; sourceRecordDate: string | null; notes: string | null
}
interface EvidenceResp { data: { incumbent: Incumbent | null; competitors: Competitor[]; lastRefreshedAt: string | null } }

const confTone: Record<string, string> = {
  CONFIRMED: 'chip-success',
  PROBABLE: 'chip-neutral',
  AMBIGUOUS: 'badge-yellow',
  NOT_AVAILABLE: 'chip-neutral',
}
const money = (v?: string | null) => (v != null ? `$${Number(v).toLocaleString()}` : '—')
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')

export function CaptureEvidence({ opportunityId }: { opportunityId: string }) {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const [correcting, setCorrecting] = useState(false)
  const [cName, setCName] = useState('')
  const [cUei, setCUei] = useState('')
  const [cReason, setCReason] = useState('')

  const q = useQuery<EvidenceResp>({ queryKey: ['evidence', opportunityId], queryFn: () => evidenceApi.get(opportunityId) })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['evidence', opportunityId] })
  const onError = (e: unknown) => toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Action failed', 'error')

  const refresh = useMutation({ mutationFn: () => evidenceApi.refresh(opportunityId), onSuccess: () => { invalidate(); toast('Evidence refreshed', 'success') }, onError })
  const verify = useMutation({ mutationFn: (id: string) => evidenceApi.verifyIncumbent(id), onSuccess: () => { invalidate(); toast('Incumbent verified', 'success') }, onError })
  const correct = useMutation({ mutationFn: ({ id, payload }: { id: string; payload: Record<string, unknown> }) => evidenceApi.correctIncumbent(id, payload), onSuccess: () => { invalidate(); setCorrecting(false); setCName(''); setCUei(''); setCReason(''); toast('Incumbent corrected', 'success') }, onError })

  if (q.isLoading) return <div className="card flex justify-center py-6"><Spinner size="sm" /></div>
  if (q.error) return <div className="card"><p className="text-xs text-red-400">Could not load evidence. Please retry.</p></div>

  const { incumbent, competitors, lastRefreshedAt } = q.data!.data
  const busy = refresh.isPending || verify.isPending || correct.isPending

  return (
    <div className="space-y-4">
      {/* Incumbent */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Building2 className="w-5 h-5 text-gray-400" />
          <h2 className="v3-h3 text-gray-100">Incumbent evidence</h2>
          <span className="text-xs text-gray-500 ml-auto">Refreshed {fmtDate(lastRefreshedAt)}</span>
          {isAdmin && <button disabled={busy} onClick={() => refresh.mutate()} className="btn-ghost btn-sm"><RefreshCw className="w-3 h-3" /> Refresh</button>}
        </div>

        {!incumbent || incumbent.confidence === 'NOT_AVAILABLE' ? (
          <p className="text-sm text-gray-500">No incumbent identified — no reliable award evidence available for this opportunity.</p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm text-gray-200 font-medium">{incumbent.name}</span>
              {incumbent.uei && <span className="text-[10px] font-mono text-gray-500">UEI {incumbent.uei}</span>}
              <span className={`chip ${confTone[incumbent.confidence]}`}>{humanize(incumbent.confidence)}</span>
              {incumbent.verification === 'VERIFIED' && <span className="chip chip-success">Verified</span>}
              {incumbent.verification === 'CORRECTED' && <span className="chip">Corrected</span>}
            </div>
            {incumbent.confidence === 'AMBIGUOUS' && (
              <p className="text-xs text-amber-400 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Ambiguous evidence — multiple candidates; verify before relying on it.</p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <Field label="Agency" value={incumbent.agency} />
              <Field label="Award ref" value={incumbent.awardReference} mono />
              <Field label="Award value" value={money(incumbent.awardValue)} />
              <Field label="Period of perf." value={incumbent.periodOfPerformance} />
            </div>
            <p className="text-[11px] text-gray-500">{incumbent.whyShown}</p>
            <p className="text-[11px] text-gray-500">Source: {incumbent.evidenceSource || '—'} · record date {fmtDate(incumbent.sourceRecordDate)}</p>
            {incumbent.verification === 'CORRECTED' && (
              <p className="text-[11px] text-gray-500">Corrected from “{incumbent.originalName}”. Reason: {incumbent.correctionReason}</p>
            )}

            {isAdmin && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {incumbent.verification !== 'VERIFIED' && incumbent.confidence !== 'NOT_AVAILABLE' && (
                  <button disabled={busy} onClick={() => verify.mutate(incumbent.id)} className="btn-secondary btn-sm"><ShieldCheck className="w-3 h-3" /> Verify</button>
                )}
                <button onClick={() => { setCorrecting((v) => !v); setCName(incumbent.name); setCUei(incumbent.uei ?? '') }} className="btn-ghost btn-sm"><Pencil className="w-3 h-3" /> Correct identity</button>
              </div>
            )}

            {isAdmin && correcting && (
              <form onSubmit={(e) => { e.preventDefault(); if (!cName.trim() || !cReason.trim()) return; correct.mutate({ id: incumbent.id, payload: { name: cName.trim(), uei: cUei.trim() || null, reason: cReason.trim() } }) }} className="bg-gray-900/50 border border-gray-800 rounded-lg p-2.5 space-y-1.5 mt-1">
                <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Corrected company name *" className="input w-full text-sm" aria-label="Corrected company name" />
                <input value={cUei} onChange={(e) => setCUei(e.target.value)} placeholder="UEI (optional)" className="input w-full text-sm" />
                <textarea value={cReason} onChange={(e) => setCReason(e.target.value)} rows={2} placeholder="Reason for correction (required)" className="input w-full text-sm" aria-label="Correction reason" />
                <div className="flex gap-2">
                  <button type="submit" disabled={busy || !cName.trim() || !cReason.trim()} className="btn-primary btn-sm disabled:opacity-50">Save correction</button>
                  <button type="button" onClick={() => setCorrecting(false)} className="btn-secondary btn-sm">Cancel</button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>

      {/* Competitors */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-5 h-5 text-gray-400" />
          <h2 className="v3-h3 text-gray-100">Competitor evidence</h2>
          <span className="text-xs text-gray-500 ml-auto">Historical award evidence — not a prediction</span>
        </div>
        {competitors.length === 0 ? (
          <p className="text-sm text-gray-500">No reliable competitor evidence available for this opportunity.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2 pr-3">Company</th><th>Awards</th><th>Value</th><th>Relevance</th><th>Why shown</th></tr></thead>
              <tbody>
                {competitors.map((c) => (
                  <tr key={c.id} className="border-b border-gray-900 align-top">
                    <td className="py-2 pr-3">
                      <span className="text-gray-200">{c.name}</span>{c.isIncumbent && <span className="chip ml-1.5">Incumbent</span>}
                      {c.uei && <span className="block text-[11px] text-gray-500">UEI {c.uei}</span>}
                    </td>
                    <td className="text-gray-300 text-xs">{c.relevantAwardCount ?? '—'}</td>
                    <td className="text-gray-400 text-xs">{money(c.relevantAwardValue)}</td>
                    <td className="text-xs text-gray-300 space-x-1">
                      {c.agencyRelevant && <span>Agency</span>}
                      {c.naicsRelevant && <span>NAICS</span>}
                      {c.pscRelevant && <span>PSC</span>}
                      {!c.agencyRelevant && !c.naicsRelevant && !c.pscRelevant && <span className="text-gray-600">—</span>}
                    </td>
                    <td className="text-xs text-gray-500">{c.whyShown}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-600 mt-2">Source: {competitors[0]?.evidenceSource || 'Award history'} · deterministic ranking by relevant award count, then value.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function Field({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-gray-600">{label}</p>
      <p className={`text-gray-300 ${mono ? 'font-mono text-[11px]' : ''}`}>{value || '—'}</p>
    </div>
  )
}

export default CaptureEvidence
