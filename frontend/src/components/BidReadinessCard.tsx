// =============================================================
// "Can I bid on this?" — the bid readiness checklist, step 1 of qualifying.
// Data: GET /api/opportunities/:id/readiness (backend services/bidReadiness.ts),
// for a consulting firm's client when one is given, else the firm's own records.
// =============================================================
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, ClipboardCheck, XCircle } from 'lucide-react'
import { opportunitiesApi } from '../services/api'

type Status = 'PASS' | 'WARN' | 'FAIL'
type Verdict = 'READY' | 'FIX_FIRST' | 'NOT_ELIGIBLE'

interface ReadinessItem {
  key: string
  label: string
  status: Status
  blocking?: 'HARD' | 'FIXABLE'
  detail: string
  fix?: string
}

interface Readiness {
  verdict: Verdict
  items: ReadinessItem[]
  disclaimer: string
}

const VERDICT: Record<Verdict, { label: string; className: string }> = {
  READY: { label: 'Ready to bid', className: 'bg-green-900/40 text-green-300 border-green-700/60' },
  FIX_FIRST: { label: 'Fix these first', className: 'bg-amber-900/40 text-amber-300 border-amber-700/60' },
  NOT_ELIGIBLE: { label: 'Not eligible to bid', className: 'bg-red-900/40 text-red-300 border-red-700/60' },
}

/**
 * Where a check's records are changed. Without a client this is a contractor's
 * own company (the card is only shown that way to contractors): its profile is
 * on My Company, its certification and bonding records on Registration &
 * Compliance. A client's details, certifications included, are on its page.
 */
function fixPlace(key: string, clientCompanyId?: string | null): { to: string; label: string } | null {
  const registration = { to: '/registration', label: 'Record it in Registration & Compliance →' }
  if (key === 'BONDING') return registration
  if (key !== 'SAM' && key !== 'NAICS' && key !== 'SET_ASIDE') return null
  if (clientCompanyId) return { to: `/clients/${clientCompanyId}`, label: 'Update this client\'s profile →' }
  return key === 'SET_ASIDE' ? registration : { to: '/my-company', label: 'Update it on My Company →' }
}

function FixLink({ itemKey, clientCompanyId }: { itemKey: string; clientCompanyId?: string | null }) {
  const place = fixPlace(itemKey, clientCompanyId)
  if (!place) return null
  return <Link to={place.to} className="inline-block mt-1 text-sm text-blue-400 hover:text-blue-300">{place.label}</Link>
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'PASS') return <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" aria-label="Passed" />
  if (status === 'WARN') return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-label="Check" />
  return <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-label="Failed" />
}

export function BidReadinessCard({ opportunityId, clientCompanyId, embedded = false }: {
  opportunityId: string
  /** A consulting firm's client: checks that client's profile instead of the firm's records. */
  clientCompanyId?: string | null
  /** Inside the qualify panel: no card frame, a smaller heading. */
  embedded?: boolean
}) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['opportunity-readiness', opportunityId, clientCompanyId ?? null],
    queryFn: () => opportunitiesApi.readiness(opportunityId, clientCompanyId).then((r: { data: Readiness }) => r.data),
  })
  const Heading = embedded ? 'h3' : 'h2'

  return (
    <div className={embedded ? '' : 'card'}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <Heading className={`${embedded ? 'text-sm' : 'text-lg'} font-semibold text-gray-200 flex items-center gap-2`}>
          <ClipboardCheck className={`${embedded ? 'w-4 h-4' : 'w-5 h-5'} text-blue-400`} />
          Can I bid on this?
        </Heading>
        {data && (
          <span className={`text-sm font-medium px-3 py-1 rounded-full border ${VERDICT[data.verdict].className}`}>
            {VERDICT[data.verdict].label}
          </span>
        )}
      </div>

      {isLoading && <p className="text-sm text-gray-500">Checking your records…</p>}
      {isError && <p className="text-sm text-red-400">We couldn't run the bid readiness check. Try again shortly.</p>}

      {data && (
        <>
          <ul className="divide-y divide-gray-800">
            {data.items.map((item) => (
              <li key={item.key} className="flex gap-3 py-2.5">
                <StatusIcon status={item.status} />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-200">{item.label}</p>
                  <p className="text-sm text-gray-400">{item.detail}</p>
                  {item.fix && item.status !== 'PASS' && (
                    <p className="text-sm text-gray-300 mt-1"><span className="font-medium">What to do: </span>{item.fix}</p>
                  )}
                  {item.status !== 'PASS' && <FixLink itemKey={item.key} clientCompanyId={clientCompanyId} />}
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-500 mt-3">{data.disclaimer}</p>
        </>
      )}
    </div>
  )
}
