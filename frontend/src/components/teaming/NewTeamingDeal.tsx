// Records a teaming deal: which partner teams with which bidder on which
// opportunity, and who leads. A consulting firm bids for one of its clients,
// never as itself, so it names the client; a contractor bids as its own company.
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { clientsApi, teamingApi } from '../../services/api'
import { getOpportunityOption, searchOpportunityOptions, type OpportunityOption } from '../../services/crmApi'
import { useIsContractor } from '../../hooks/useAuth'
import { useToast } from '../Toast'
import { SearchSelect, type SearchOption } from '../SearchSelect'

const toOption = (o: OpportunityOption): SearchOption => ({ id: o.id, label: o.title, hint: o.agency })
const searchOpps = async (term: string) => (await searchOpportunityOptions(term)).map(toOption)
const resolveOpp = async (id: string) => { const o = await getOpportunityOption(id); return o ? toOption(o) : null }

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

/** The partner's role on the bid, described from the bidder's side. */
export function leadOptions(bidder: string, partner: string) {
  return ([
    { role: 'SUB', type: 'TEAMING_AGREEMENT', label: `${bidder} is the prime; ${partner} is a subcontractor` },
    { role: 'PRIME', type: 'SUBCONTRACT', label: `${partner} is the prime; ${bidder} is a subcontractor` },
    { role: 'JV_MEMBER', type: 'JV', label: `${bidder} and ${partner} bid as a joint venture` },
    { role: 'MENTOR_PROTEGE', type: 'MENTOR_PROTEGE', label: `${bidder} and ${partner} bid as mentor and protégé` },
  ] as const).map((o) => ({ ...o, label: sentence(o.label) }))
}

interface Client { id: string; name: string; isSelf?: boolean }
interface Partner { id: string; name: string }

export function NewTeamingDeal({ onDone }: { onDone: () => void }) {
  const isContractor = useIsContractor()
  const qc = useQueryClient()
  const { toast } = useToast()
  const [opportunityId, setOpportunityId] = useState('')
  const [clientCompanyId, setClientCompanyId] = useState('')
  const [partnerId, setPartnerId] = useState('')
  const [role, setRole] = useState<string>('SUB')
  const [scope, setScope] = useState('')

  const clientsQ = useQuery({ queryKey: ['clients-for-teaming'], queryFn: () => clientsApi.list({ limit: 500 }), enabled: !isContractor })
  const partnersQ = useQuery({ queryKey: ['teaming-partners-for-deal'], queryFn: () => teamingApi.listPartners({ activeOnly: true }) })
  const clients: Client[] = (clientsQ.data?.data?.clients ?? clientsQ.data?.data ?? []).filter((c: Client) => !c.isSelf)
  const partners: Partner[] = partnersQ.data?.data?.partners ?? []

  const bidderName = isContractor ? 'your company' : (clients.find((c) => c.id === (clientCompanyId || (clients.length === 1 ? clients[0].id : '')))?.name ?? 'your client')
  const partnerName = partners.find((p) => p.id === partnerId)?.name ?? 'the partner'
  const options = leadOptions(bidderName, partnerName)
  const chosen = options.find((o) => o.role === role) ?? options[0]
  const needsClient = !isContractor && clients.length > 1

  const create = useMutation({
    mutationFn: () => teamingApi.createArrangement({
      opportunityId, partnerId, role: chosen.role, arrangementType: chosen.type,
      ...(isContractor ? {} : { clientCompanyId: clientCompanyId || (clients.length === 1 ? clients[0].id : undefined) }),
      ...(scope.trim() ? { scopePercent: Number(scope) } : {}),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['teaming-arrangements'] })
      qc.invalidateQueries({ queryKey: ['teaming-reminders'] })
      toast('Teaming deal added', 'success')
      onDone()
    },
    onError: (e: unknown) => toast((e as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not add the teaming deal', 'error'),
  })

  const ready = !!opportunityId && !!partnerId && (!needsClient || !!clientCompanyId)

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ready) create.mutate() }} className="panel p-4 mb-4 space-y-3 animate-fade-in" aria-label="Add a teaming deal">
      <p className="text-base font-semibold text-gray-100">Add a teaming deal</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <SearchSelect label="Opportunity *" value={opportunityId} onChange={setOpportunityId} search={searchOpps} resolve={resolveOpp} placeholder="Search your opportunities…" />
        {isContractor ? (
          <div>
            <p className="label">Bidding company</p>
            <p className="text-sm text-gray-200 mt-1.5">Your company (from My profile)</p>
          </div>
        ) : (
          <label className="label block">Client bidding with this partner {needsClient ? '*' : ''}
            <select aria-label="Client bidding with this partner" value={clientCompanyId || (clients.length === 1 ? clients[0].id : '')} onChange={(e) => setClientCompanyId(e.target.value)} className="input mt-1 w-full !py-1.5">
              {clients.length !== 1 && <option value="">Choose a client…</option>}
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <span className="block text-xs text-gray-400 mt-1">The client is the party to the teaming agreement, not your firm.</span>
          </label>
        )}
        <label className="label block">Partner *
          <select aria-label="Partner" value={partnerId} onChange={(e) => setPartnerId(e.target.value)} className="input mt-1 w-full !py-1.5">
            <option value="">Choose a sub or prime…</option>
            {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="label block">Partner's workshare % (optional)
          <input aria-label="Partner's workshare percent" type="number" min={0} max={100} value={scope} onChange={(e) => setScope(e.target.value)} className="input mt-1 w-full !py-1.5" placeholder="e.g. 30" />
        </label>
      </div>
      <fieldset>
        <legend className="label mb-1">Who leads the bid?</legend>
        <div className="space-y-1">
          {options.map((o) => (
            <label key={o.role} className="flex items-center gap-2 text-sm text-gray-300">
              <input type="radio" name="lead" value={o.role} checked={role === o.role} onChange={() => setRole(o.role)} /> {o.label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex gap-2">
        <button type="submit" className="btn-primary btn-sm" disabled={!ready || create.isPending}>{create.isPending ? 'Adding…' : 'Add teaming deal'}</button>
        <button type="button" className="btn-secondary btn-sm" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}
