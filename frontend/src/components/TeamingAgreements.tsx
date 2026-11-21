import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { clientsApi, teamingApi } from '../services/api'
import { useIsContractor } from '../hooks/useAuth'
import { NewTeamingDeal } from './teaming/NewTeamingDeal'
import { usePermission } from '../hooks/usePermission'
import { useToast } from './Toast'
import { Spinner, EmptyState, ErrorBanner } from './ui'
import { Users, AlertTriangle, FileText, Paperclip, Bell } from 'lucide-react'
import { humanize } from '../lib/humanize'

// §5.1 Stage 4 — agreement/NDA/workshare tracker + reminders + editable draft
// (draft is never an executed agreement — it carries the review disclaimer).

interface Arrangement {
  id: string; role: string; arrangementType: string; scopePercent: number | null; teamingStatus: string
  agreementStatus: string; ndaStatus: string; agreementDueDate: string | null; agreementDocumentName: string | null
  workshareDescription: string | null; capabilityContribution: string | null
  partner: { id: string; name: string }; opportunity: { id: string; title: string; agency: string | null }
  clientCompany: { id: string; name: string; isSelf: boolean } | null
}
interface Reminder { arrangement: { id: string; partner: { name: string }; opportunity: { title: string } }; overdue: boolean; reasons: string[] }

const AGREEMENT_STATUSES = ['NONE', 'DRAFT', 'SENT', 'SIGNED']
// Only "signed" carries colour; the other states are steps, not warnings.
const statusTone: Record<string, string> = {
  NONE: 'chip-neutral', DRAFT: 'chip-neutral', SENT: 'chip-neutral', SIGNED: 'chip-success',
}
const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '—')
/** The partner's role on the bid, in words. */
const ROLE_TEXT: Record<string, string> = {
  SUB: 'Partner is a sub', PRIME: 'Partner is the prime', JV_MEMBER: 'Joint venture', MENTOR_PROTEGE: 'Mentor-protégé', BOTH: 'Not set',
}

export function TeamingAgreements() {
  // Admins, BD / Capture and Contracts manage teaming deals and agreements.
  const isAdmin = usePermission('PARTNER_MANAGE')
  const qc = useQueryClient()
  const { toast } = useToast()
  const [openDraft, setOpenDraft] = useState<string | null>(null)
  const [draftText, setDraftText] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const isContractor = useIsContractor()
  const clientsQ = useQuery({ queryKey: ['clients-for-teaming'], queryFn: () => clientsApi.list({ limit: 500 }), enabled: isAdmin && !isContractor })
  const clients: Array<{ id: string; name: string; isSelf?: boolean }> = (clientsQ.data?.data?.clients ?? clientsQ.data?.data ?? []).filter((c: { isSelf?: boolean }) => !c.isSelf)

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
          <Bell className="w-4 h-4 text-gray-400" />
          <h2 className="font-semibold text-gray-100 text-base">Agreement reminders</h2>
          {rem.data && <span className="text-xs text-gray-400">{rem.data.data.overdue} overdue · {rem.data.data.total} need attention</span>}
          {isAdmin && reminders.length > 0 && <button disabled={dispatch.isPending} onClick={() => dispatch.mutate()} className="btn-secondary btn-sm ml-auto">Notify owners</button>}
        </div>
        {rem.isLoading ? <Spinner size="sm" /> : reminders.length === 0 ? (
          <p className="text-sm text-gray-400">No unsigned, incomplete, or overdue agreements.</p>
        ) : (
          <ul className="v3-rule-list">
            {reminders.map((r) => (
              <li key={r.arrangement.id} className="text-[13px] flex items-center gap-2 py-2.5">
                {r.overdue && <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0" />}
                <span className="text-gray-300">{r.arrangement.partner.name}</span>
                <span className="text-gray-400">· {r.arrangement.opportunity.title}</span>
                <span className={`ml-auto ${r.overdue ? 'text-red-400' : 'text-gray-400'}`}>{r.reasons.join('; ')}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Agreement + workshare tracker */}
      <div className="card">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-4 h-4 text-gray-400" /><h2 className="font-semibold text-gray-100 text-base">Agreements and workshare</h2>
          {isAdmin && !adding && <button onClick={() => setAdding(true)} className="btn-secondary btn-sm ml-auto">Add a teaming deal</button>}
        </div>
        {isAdmin && adding && <NewTeamingDeal onDone={() => setAdding(false)} />}
        {arr.isLoading ? (
          <div className="flex justify-center py-4"><Spinner size="sm" /></div>
        ) : arr.error ? (
          <ErrorBanner message="Could not load teaming arrangements. Please retry." />
        ) : arrangements.length === 0 ? (
          <EmptyState message={isAdmin ? 'No teaming deals yet. Use "Add a teaming deal" to record who teams with whom on a bid, then track the agreement and workshare here.' : 'No teaming deals yet.'} />
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table w-full text-sm">
              <thead><tr className="text-left"><th className="py-2 pr-3">Partner</th><th>{isContractor ? 'Bidding' : 'Client bidding'}</th><th>Opportunity</th><th>Who leads</th><th>Workshare</th><th>Agreement</th><th>NDA</th><th>Actions</th></tr></thead>
              <tbody>
                {arrangements.map((a) => (
                  <tr key={a.id} className="align-top">
                    <td className="py-3 pr-3 text-gray-100 font-medium">{a.partner.name}</td>
                    <td className="text-gray-300 text-xs">
                      {a.clientCompany ? (a.clientCompany.isSelf ? 'Your company' : a.clientCompany.name)
                        : isAdmin && !isContractor && clients.length > 0 ? (
                          <select aria-label={`Client bidding with ${a.partner.name}`} defaultValue="" disabled={update.isPending}
                            onChange={(e) => e.target.value && update.mutate({ id: a.id, data: { clientCompanyId: e.target.value } })}
                            className="input !min-h-[32px] !text-xs !py-1">
                            <option value="">Not recorded: choose…</option>
                            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                          </select>
                        ) : <span className="text-amber-300">Not recorded</span>}
                    </td>
                    <td className="text-gray-400 text-xs">{a.opportunity.title}</td>
                    <td className="text-gray-400 text-xs">{ROLE_TEXT[a.role] ?? a.role}</td>
                    <td className="text-gray-300 text-xs">{a.scopePercent != null ? `${a.scopePercent}%` : '—'}</td>
                    <td>
                      {isAdmin ? (
                        <select value={a.agreementStatus} disabled={update.isPending} onChange={(e) => update.mutate({ id: a.id, data: { agreementStatus: e.target.value } })} className="input !min-h-[32px] !text-xs !py-1">
                          {AGREEMENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                        </select>
                      ) : <span className={`chip ${statusTone[a.agreementStatus]}`}>{humanize(a.agreementStatus)}</span>}
                      {a.agreementDueDate && a.agreementStatus !== 'SIGNED' && <span className="block text-xs text-gray-400 mt-1">Due {fmtDate(a.agreementDueDate)}</span>}
                    </td>
                    <td>
                      {isAdmin ? (
                        <select value={a.ndaStatus} disabled={update.isPending} onChange={(e) => update.mutate({ id: a.id, data: { ndaStatus: e.target.value } })} className="input !min-h-[32px] !text-xs !py-1">
                          {AGREEMENT_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
                        </select>
                      ) : <span className={`chip ${statusTone[a.ndaStatus]}`}>{humanize(a.ndaStatus)}</span>}
                    </td>
                    <td className="text-xs">
                      {isAdmin && (
                        <div className="flex flex-col gap-1">
                          <button disabled={genDraft.isPending} onClick={() => genDraft.mutate({ id: a.id, draftType: 'TEAMING_AGREEMENT' })} className="text-gray-300 hover:text-gray-100 flex items-center gap-1"><FileText className="w-3 h-3" /> Draft agreement</button>
                          <label className="text-gray-300 hover:text-gray-100 flex items-center gap-1 cursor-pointer">
                            <Paperclip className="w-3 h-3" /> {a.agreementDocumentName ? 'Replace file' : 'Attach'}
                            <input type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) attach.mutate({ id: a.id, file: f }) }} />
                          </label>
                        </div>
                      )}
                      {a.agreementDocumentName && <span className="flex items-center gap-1 text-xs text-gray-400 mt-1"><Paperclip className="w-3 h-3" /> {a.agreementDocumentName}</span>}
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
            <FileText className="w-4 h-4 text-gray-400" />
            <h2 className="font-semibold text-gray-100 text-base">Agreement draft</h2>
            <span className="chip badge-yellow ml-auto">Draft for review, not legal advice</span>
            <button onClick={() => setOpenDraft(null)} className="btn-ghost btn-sm">Close</button>
          </div>
          <pre className="panel text-xs text-gray-200 whitespace-pre-wrap p-4 max-h-96 overflow-y-auto">{draftText[openDraft]}</pre>
        </div>
      )}
    </div>
  )
}

export default TeamingAgreements
