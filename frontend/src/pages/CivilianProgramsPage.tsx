// =============================================================
// Civilian Programs — public buying programs open to any commercial
// vendor, no SAM.gov registration or federal contractor status
// required. Fed by the hourly civilian_feed source sync: USAC E-Rate
// (FCC Form 470s — schools & libraries buying internet/IT services)
// and Rural Health Care service requests. Filtered to the company's state
// by default (the State on My Company or the client profiles); any other
// state, or all of them, can be picked.
// =============================================================
import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { School, ExternalLink, Mail, ChevronDown, ChevronRight } from 'lucide-react'
import { civilianApi } from '../services/api'
import { PageHeader, StatCard, EmptyState, Chip, SkeletonRows, type Tone } from '../components/ui'
import { US_STATES } from '../lib/usStates'

interface CivilianOpp {
  id: string
  title: string
  agency: string
  noticeType: string | null
  solicitationNumber: string | null
  responseDeadline: string | null
  placeOfPerformance: string | null
  sourceUrl: string | null
  description: string | null
  sourceMetadata?: { raw?: Record<string, string> } | null
}

/** Program-specific facts worth surfacing from the raw feed row. */
function detailFacts(o: CivilianOpp): Array<[string, string]> {
  const raw = o.sourceMetadata?.raw ?? {}
  const facts: Array<[string, string | undefined]> = [
    ['Applicant type', raw.applicant_type],
    ['Funding year', raw.funding_year],
    ['Eligible entities', raw.number_of_eligible_entities],
    ['RFP', raw.rfp_identifier],
    ['Requested contract period', raw.requested_contract_period],
    ['Bid evaluation period', raw.expected_bid_evaluation_period],
    ['State/local restrictions', raw.state_or_local_restrictions],
  ]
  return facts.filter((f): f is [string, string] => Boolean(f[1] && String(f[1]).trim()))
}

// The application path for these programs IS the buyer's posted contact:
// bids go straight to the school district / health care provider during the
// bid window. E-Rate rows carry contact_*, RHC rows mail_contact_*.
function buyerContact(o: CivilianOpp): { name: string | null; email: string | null; phone: string | null } {
  const raw = o.sourceMetadata?.raw ?? {}
  const name = raw.contact_name
    ?? [raw.mail_contact_first_name, raw.mail_contact_last_name].filter(Boolean).join(' ')
  return {
    name: name || null,
    email: raw.contact_email ?? raw.mail_contact_email ?? null,
    phone: raw.contact_phone ?? raw.mail_contact_phone ?? null,
  }
}

function daysLeft(deadline: string | null): { label: string; tone: Tone } | null {
  if (!deadline) return null
  const d = Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000)
  if (d < 0) return { label: 'Closed', tone: 'neutral' }
  if (d <= 7) return { label: `${d}d left`, tone: 'danger' }
  return { label: `${d}d left`, tone: 'neutral' }
}

export function CivilianProgramsPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  // null = not chosen yet, so the company's state applies; '' = all states.
  const [picked, setPicked] = useState<string | null>(null)
  const home = useQuery({ queryKey: ['home-state'], queryFn: civilianApi.homeState, staleTime: 5 * 60_000 })
  const state = picked ?? home.data ?? ''
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['civilian-opps', search, state, page],
    queryFn: () => civilianApi.list({ search: search || undefined, state: state || undefined, page, limit: 25, sortBy: 'deadline', sortOrder: 'asc' }),
    enabled: picked !== null || !home.isLoading,
  })
  const stateName = US_STATES.find((s) => s.code === state)?.name
  const opps: CivilianOpp[] = data?.data ?? []
  const total: number = data?.meta?.total ?? 0

  return (
    <div>
      <PageHeader
        title="Civilian programs"
        subtitle="Public buying programs any commercial vendor can answer. No SAM.gov registration required."
        icon={<School />}
      />

      <div className="stagger grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatCard label="Open requests" value={String(total)} tone="neutral" />
        <StatCard label="Programs" value="E-Rate · RHC" sub="Schools, libraries & rural health buyers" />
        <StatCard label="Entry barrier" value="None" sub="Bid directly — no federal registration" />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          className="input w-full sm:w-80"
          placeholder="Search buyers or services…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          aria-label="Search civilian programs"
        />
        <select
          className="input w-full sm:w-64"
          value={state}
          onChange={(e) => { setPicked(e.target.value); setPage(1) }}
          aria-label="State"
        >
          <option value="">All states</option>
          {US_STATES.map((s) => (
            <option key={s.code} value={s.code}>{s.name}{s.code === home.data ? ' (your state)' : ''}</option>
          ))}
        </select>
        {!home.isLoading && !home.data && (
          <p className="text-xs" style={{ color: 'var(--text-faint)' }}>Add your state to your company profile to see it first.</p>
        )}
      </div>

      {isLoading || (picked === null && home.isLoading) ? (
        <div className="card !p-0"><span className="sr-only">Loading…</span><SkeletonRows rows={8} cols={5} /></div>
      ) : opps.length === 0 ? (
        <div className="card"><EmptyState icon={<School />} message={stateName ? `No open program requests in ${stateName} match. Choose another state or All states.` : 'No open program requests match. The feeds refresh every few hours.'} /></div>
      ) : (
        <div className="card !p-0 overflow-hidden animate-fade-in">
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr className="text-[13px]" style={{ color: 'var(--text-muted)' }}>
                  <th className="text-left font-medium px-5 py-3">Request</th>
                  <th className="text-left font-medium px-3 py-3">Buyer</th>
                  <th className="text-left font-medium px-3 py-3">Where</th>
                  <th className="text-left font-medium px-3 py-3">Bid window closes</th>
                  <th className="text-left font-medium px-3 py-3">Contact buyer</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {opps.map((o) => {
                  const dl = daysLeft(o.responseDeadline)
                  const contact = buyerContact(o)
                  const expanded = open === o.id
                  const facts = detailFacts(o)
                  return (
                    <Fragment key={o.id}>
                    <tr className="table-row align-top cursor-pointer" style={expanded ? { background: 'var(--surface-2)' } : undefined} onClick={() => setOpen(expanded ? null : o.id)}>
                      <td className="px-5 py-3 max-w-[30rem]">
                        <div className="flex items-start gap-1.5">
                          {expanded
                            ? <ChevronDown className="w-3.5 h-3.5 mt-1 flex-shrink-0" style={{ color: 'var(--accent-3)' }} />
                            : <ChevronRight className="w-3.5 h-3.5 mt-1 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />}
                          <div className="min-w-0">
                            <p className="font-medium truncate" style={{ color: 'var(--text)' }} title={o.title}>{o.title}</p>
                            <p className="text-[11px] font-mono mt-0.5" style={{ color: 'var(--text-faint)' }}>
                              {o.noticeType ?? '—'}{o.solicitationNumber ? ` · ${o.solicitationNumber}` : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 max-w-[16rem]"><p className="truncate" style={{ color: 'var(--text-2)' }}>{o.agency}</p></td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {o.placeOfPerformance ? <Chip tone="neutral">{o.placeOfPerformance}</Chip> : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {o.responseDeadline ? (
                          <div>
                            <p className="tabular-nums" style={{ color: 'var(--text-2)' }}>{new Date(o.responseDeadline).toLocaleDateString()}</p>
                            {dl && <Chip tone={dl.tone} dot className="mt-1">{dl.label}</Chip>}
                          </div>
                        ) : <span style={{ color: 'var(--text-dim)' }}>—</span>}
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap">
                        {contact.email ? (
                          <a
                            href={`mailto:${contact.email}?subject=${encodeURIComponent(`Bid: ${o.title}`.slice(0, 120))}`}
                            className="inline-flex items-center gap-1.5 text-xs"
                            style={{ color: 'var(--accent-3)' }}
                            title={contact.phone ? `${contact.email} · ${contact.phone}` : contact.email}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Mail className="w-3.5 h-3.5" />
                            <span className="max-w-[10rem] truncate">{contact.name || contact.email}</span>
                          </a>
                        ) : contact.phone ? (
                          <span className="text-xs" style={{ color: 'var(--text-2)' }}>{contact.name ? `${contact.name} · ` : ''}{contact.phone}</span>
                        ) : (
                          <span style={{ color: 'var(--text-dim)' }}>—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right">
                        {o.sourceUrl && (
                          <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer" className="icon-btn !w-7 !h-7" aria-label="Open source" title="Open source" onClick={(e) => e.stopPropagation()}>
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={6} className="px-5 pb-4 pt-0" style={{ background: 'var(--surface-2)' }}>
                          <div className="pt-3 grid gap-4 md:grid-cols-3 animate-fade-in">
                            <div className="md:col-span-2">
                              <p className="overline mb-1.5">Services requested</p>
                              <p className="text-sm whitespace-pre-line leading-relaxed" style={{ color: 'var(--text-2)' }}>
                                {o.description || 'No description was included in the posting — the linked RFP or form carries the requirements.'}
                              </p>
                            </div>
                            <div>
                              {facts.length > 0 && (
                                <>
                                  <p className="overline mb-1.5">Details</p>
                                  <dl className="space-y-1 text-xs">
                                    {facts.map(([k, v]) => (
                                      <div key={k} className="flex gap-2">
                                        <dt className="flex-shrink-0" style={{ color: 'var(--text-faint)' }}>{k}:</dt>
                                        <dd style={{ color: 'var(--text-2)' }}>{String(v).slice(0, 120)}</dd>
                                      </div>
                                    ))}
                                  </dl>
                                </>
                              )}
                              {(contact.email || contact.phone) && (
                                <p className="text-xs mt-3" style={{ color: 'var(--text-2)' }}>
                                  <span style={{ color: 'var(--text-faint)' }}>Bid to: </span>
                                  {contact.name ? `${contact.name} · ` : ''}{contact.email ?? ''}{contact.email && contact.phone ? ' · ' : ''}{contact.phone ?? ''}
                                </p>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-xs" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-faint)' }}>
            <span className="tabular-nums">Page {page} · {total} open requests</span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary !py-1.5 text-xs" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => p - 1)}>Prev</button>
              <button type="button" className="btn-secondary !py-1.5 text-xs" disabled={page * 25 >= total || isFetching} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
