import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { teamingApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useToast } from './Toast'
import { Spinner, EmptyState, ErrorBanner } from './ui'
import { Users, AlertTriangle, FileText, Paperclip, Bell } from 'lucide-react'

// §5.1 Stage 4 — agreement/NDA/workshare tracker + reminders + editable draft
// (draft is never an executed agreement — it carries the review disclaimer).

interface Arrangement {
  id: string; role: string; arrangementType: string; scopePercent: number | null; teamingStatus: string
  agreementStatus: string; ndaStatus: string; agreementDueDate: string | null; agreementDocumentName: string | null
  workshareDescription: string | null; capabilityContribution: string | null
  partner: { id: string; name: string }; opportunity: { id: string; title: string; agency: string | null }
}
interface Reminder { arrangement: { id: string; partner: { name: string }; opportunity: { title: string } }; overdue: boolean; reasons: string[] }

const AGREEMENT_STATUSES = ['NONE', 'DRAFT', 'SENT', 'SIGNED']
const statusTone: Record<string, string> = {
  NONE: 'bg-gray-800 border-gray-700 text-gray-400', DRAFT: 'bg-blue-950/40 border-blue-800 text-blue-300',
  SENT: 'bg-yellow-950/40 border-yellow-800 text-yellow-300', SIGNED: 'bg-green-950/40 border-green-800 text-green-300',
}
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')

export function TeamingAgreements() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()
  const { toast } = useToast()
  const [openDraft, setOpenDraft] = useState<string | null>(null)
  const [draftText, setDraftText] = useState<Record<string, string>>({})

  const arr = useQuery<{ data: { arrangements: Arrangement[] } }>({ queryKey: ['teaming-arrangements'], queryFn: () => teamingApi.listArrangements() })
  const rem = useQuery<{ data: { reminders: Reminder[]; total: number; overdue: number } }>({ queryKey: ['teaming-reminders'], queryFn: () => teamingApi.reminders() })
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['teaming-arrangements'] }); qc.invalidateQueries({ queryKey: ['teaming-reminders'] }) }
  const onError = (e: unknown) => toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Action failed', 'error')

  const update = useMutation({ mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => teamingApi.updateArrangement(id, data), onSuccess: () => { invalidate(); toast('Updated', 'success') }, onError })
  const dispatch = useMutation({ mutationFn: () => teamingApi.dispatchReminders(), onSuccess: (r: { data?: { dispatched?: number } }) => { invalidate(); toast(`${r?.data?.dispatched ?? 0} reminder(s) dispatched`, 'success') }, onError })
  const genDraft = useMutation({
    mutationFn: ({ id, draftType }: { id: string; draftType: string }) => teamingApi.generateDraft(id, { draftType }),
    onSuccess: (r: { data?: { draft?: { teamingArrangementId?: string; content?: string } } }) => { const d = r?.data?.draft; if (d?.teamingArrangementId) { setDraftText((s) => ({ ...s, [d.teamingArrangementId!]: d.content ?? '' })); setOpenDraft(d.teamingArrangementId!) } invalidate(); toast('Draft generated', 'success') },
    onError,
  })
  const attach = useMutation({ mutationFn: ({ id, file }: { id: string; file: File }) => teamingApi.uploadAttachment(id, file), onSuccess: () => { invalidate(); toast('Document attached', 'success') }, onError })

  const arrangements = arr.data?.data.arrangements ?? []
  const reminders = rem.data?.data.reminders ?? []

  return (
    <div className="space-y-4">
      {/* Reminders */}
      <div className="card">
        <div className="flex items-center gap-2 mb-2">
          <Bell className="w-4 h-4 text-yellow-400" />
          <h2 className="font-semibold text-gray-200 text-sm">Agreement reminders</h2>
          {rem.data && <span className="text-[10px] text-gray-500">{rem.data.data.overdue} overdue · {rem.data.data.total} need attention</span>}
          {isAdmin && reminders.length > 0 && <button disabled={dispatch.isPending} onClick={() => dispatch.mutate()} className="btn-secondary text-xs ml-auto disabled:opacity-60">Notify owners</button>}
        </div>
        {rem.isLoading ? <Spinner size="sm" /> : reminders.length === 0 ? (
          <p className="text-sm text-gray-500">No unsigned, incomplete, or overdue agreements.</p>
        ) : (
          <ul className="space-y-1.5">
            {reminders.map((r) => (
              <li key={r.arrangement.id} className={`text-xs flex items-center gap-2 border rounded p-2 ${r.overdue ? 'border-red-800/60 bg-red-950/10' : 'border-gray-800'}`}>
                {r.overdue && <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0" />}
                <span className="text-gray-300">{r.arrangement.partner.name}</span>
                <span className="text-gray-500">· {r.arrangement.opportunity.title}</span>
                <span className="text-gray-500 ml-auto">{r.reasons.join('; ')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Agreement + workshare tracker */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3"><Users className="w-4 h-4 text-blue-400" /><h2 className="font-semibold text-gray-200 text-sm">Agreements & workshare</h2></div>
        {arr.isLoading ? (
          <div className="flex justify-center py-4"><Spinner size="sm" /></div>
        ) : arr.error ? (
          <ErrorBanner message="Could not load teaming arrangements. Please retry." />
        ) : arrangements.length === 0 ? (
          <EmptyState message="No teaming arrangements yet. Link a partner to an opportunity to track agreements and workshare." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 text-xs border-b border-gray-800"><th className="py-2 pr-3">Partner</th><th>Opportunity</th><th>Role</th><th>Workshare</th><th>Agreement</th><th>NDA</th><th>Actions</th></tr></thead>
              <tbody>
                {arrangements.map((a) => (
                  <tr key={a.id} className="border-b border-gray-900 align-top">
                    <td className="py-2 pr-3 text-gray-200">{a.partner.name}</td>
                    <td className="text-gray-400 text-xs">{a.opportunity.title}</td>
                    <td className="text-gray-400 text-xs">{a.role}</td>
                    <td className="text-gray-300 text-xs">{a.scopePercent != null ? `${a.scopePercent}%` : '—'}</td>
                    <td>
                      {isAdmin ? (
                        <select value={a.agreementStatus} disabled={update.isPending} onChange={(e) => update.mutate({ id: a.id, data: { agreementStatus: e.target.value } })} className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                          {AGREEMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusTone[a.agreementStatus]}`}>{a.agreementStatus}</span>}
                      {a.agreementDueDate && a.agreementStatus !== 'SIGNED' && <span className="block text-[10px] text-gray-600">due {fmtDate(a.agreementDueDate)}</span>}
                    </td>
                    <td>
                      {isAdmin ? (
                        <select value={a.ndaStatus} disabled={update.isPending} onChange={(e) => update.mutate({ id: a.id, data: { ndaStatus: e.target.value } })} className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200">
                          {AGREEMENT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                      ) : <span className={`text-[10px] px-1.5 py-0.5 rounded border ${statusTone[a.ndaStatus]}`}>{a.ndaStatus}</span>}
                    </td>
                    <td className="text-[11px]">
                      {isAdmin && (
                        <div className="flex flex-col gap-1">
                          <button disabled={genDraft.isPending} onClick={() => genDraft.mutate({ id: a.id, draftType: 'TEAMING_AGREEMENT' })} className="text-gray-500 hover:text-gray-300 flex items-center gap-0.5"><FileText className="w-3 h-3" /> Draft agreement</button>
                          <label className="text-gray-500 hover:text-gray-300 flex items-center gap-0.5 cursor-pointer">
                            <Paperclip className="w-3 h-3" /> {a.agreementDocumentName ? 'Replace file' : 'Attach'}
                            <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) attach.mutate({ id: a.id, file: f }) }} />
                          </label>
                        </div>
                      )}
                      {a.agreementDocumentName && <span className="block text-[10px] text-gray-600 mt-0.5">📎 {a.agreementDocumentName}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Generated draft viewer */}
      {openDraft && draftText[openDraft] && (
        <div className="card">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-blue-400" />
            <h2 className="font-semibold text-gray-200 text-sm">Agreement draft</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded border border-orange-800 bg-orange-950/30 text-orange-300 ml-auto">Draft for review — not legal advice</span>
            <button onClick={() => setOpenDraft(null)} className="text-xs text-gray-500 hover:text-gray-300">Close</button>
          </div>
          <pre className="text-[11px] text-gray-300 whitespace-pre-wrap bg-gray-950/60 border border-gray-800 rounded p-3 max-h-96 overflow-y-auto">{draftText[openDraft]}</pre>
        </div>
      )}
    </div>
  )
}

export default TeamingAgreements
