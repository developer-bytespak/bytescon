// =============================================================
// "Can I bid on this?" — the bid readiness checklist on the opportunity page.
// Data: GET /api/opportunities/:id/readiness (backend services/bidReadiness.ts).
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

function StatusIcon({ status }: { status: Status }) {
  if (status === 'PASS') return <CheckCircle2 className="w-4 h-4 text-green-400 shrink-0 mt-0.5" aria-label="Passed" />
  if (status === 'WARN') return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" aria-label="Check" />
  return <XCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-label="Failed" />
}

export function BidReadinessCard({ opportunityId }: { opportunityId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['opportunity-readiness', opportunityId],
    queryFn: () => opportunitiesApi.readiness(opportunityId).then((r: { data: Readiness }) => r.data),
  })

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">
          <ClipboardCheck className="w-5 h-5 text-blue-400" />
          Can I bid on this?
        </h2>
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
                </div>
              </li>
            ))}
          </ul>
          {data.verdict !== 'READY' && (
            <Link to="/registration" className="inline-block mt-3 text-sm text-blue-400 hover:text-blue-300">
              Update your records in Registration &amp; Compliance →
            </Link>
          )}
          <p className="text-xs text-gray-500 mt-3">{data.disclaimer}</p>
        </>
      )}
    </div>
  )
}
