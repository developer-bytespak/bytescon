// =============================================================
// Civilian Programs — public buying programs open to any commercial
// vendor, no SAM.gov registration or federal contractor status
// required. Fed by the hourly civilian_feed source sync: USAC E-Rate
// (FCC Form 470s — schools & libraries buying internet/IT services)
// and Rural Health Care service requests.
// =============================================================
import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { School, ExternalLink, Mail, ChevronDown, ChevronRight } from 'lucide-react'
import { civilianApi } from '../services/api'
import { PageHeader, StatCard, EmptyState, Chip, Spinner, type Tone } from '../components/ui'

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
  if (d <= 30) return { label: `${d}d left`, tone: 'gold' }
  return { label: `${d}d left`, tone: 'success' }
}

export function CivilianProgramsPage() {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['civilian-opps', search, page],
    queryFn: () => civilianApi.list({ search: search || undefined, page, limit: 25, sortBy: 'deadline', sortOrder: 'asc' }),
  })
  const opps: CivilianOpp[] = data?.data ?? []
  const total: number = data?.meta?.total ?? 0

  return (
    <div>
      <PageHeader
        title="Civilian Programs"
        subtitle="Public buying programs any commercial vendor can answer — no SAM.gov registration required."
        icon={<School />}
      />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <StatCard label="Open requests" value={String(total)} />
        <StatCard label="Programs" value="E-Rate · RHC" sub="Schools, libraries & rural health buyers" />
        <StatCard label="Entry barrier" value="None" sub="Bid directly — no federal registration" />
      </div>

      <div className="mb-3">
        <input
          className="input w-full sm:w-80"
          placeholder="Search buyers or services…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1) }}
          aria-label="Search civilian programs"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16"><Spinner size="lg" /></div>
      ) : opps.length === 0 ? (
        <div className="card"><EmptyState message="No open program requests match. The feeds refresh hourly." /></div>
      ) : (
        <div className="card !p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-faint)' }}>
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
                    <tr className="table-row align-top cursor-pointer" onClick={() => setOpen(expanded ? null : o.id)}>
                      <td className="px-5 py-3 max-w-[30rem]">
                        <div className="flex items-start gap-1.5">
                          {expanded
                            ? <ChevronDown className="w-3.5 h-3.5 mt-1 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />
                            : <ChevronRight className="w-3.5 h-3.5 mt-1 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />}
                          <div className="min-w-0">
                            <p className="font-medium truncate" style={{ color: 'var(--text)' }}>{o.title}</p>
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
                            <p style={{ color: 'var(--text-2)' }}>{new Date(o.responseDeadline).toLocaleDateString()}</p>
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
                          <div className="pt-3 grid gap-4 md:grid-cols-3">
                            <div className="md:col-span-2">
                              <p className="text-[11px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-faint)' }}>Services requested</p>
                              <p className="text-sm whitespace-pre-line leading-relaxed" style={{ color: 'var(--text-2)' }}>
                                {o.description || 'No description was included in the posting — the linked RFP or form carries the requirements.'}
                              </p>
                            </div>
                            <div>
                              {facts.length > 0 && (
                                <>
                                  <p className="text-[11px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-faint)' }}>Details</p>
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
          <div className="flex items-center justify-between px-5 py-3 text-xs" style={{ borderTop: '1px solid var(--line)', color: 'var(--text-faint)' }}>
            <span>Page {page} · {total} open requests</span>
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
