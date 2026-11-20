// =============================================================
// /opportunities/:id/continue — opens the place where this bid's current step
// is done, so a contract opened from the Pipeline lands on its work:
//   Identified            → the opportunity's Qualify panel
//   Qualification         → the qualification page, at the decision
//   Capture / Proposal    → the step guide's step: proposal, then price, then submission
//   anything else         → the opportunity page (status, outcome)
// Uses the journey (GET /api/opportunities/:id/journey), the same source as the step guide.
// =============================================================
import { useEffect } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Spinner } from '../components/ui'
import { opportunitiesApi } from '../services/api'
import { journeyKey, type Journey } from '../hooks/journey'

/** Where to open a bid, given its journey. */
export function continueTarget(opportunityId: string, j: Journey | null | undefined): string {
  const page = `/opportunities/${opportunityId}`
  if (!j) return page
  if (j.stage === 'QUALIFICATION' && j.pursuitId) return `/pipeline/${j.pursuitId}#decision`
  const to = j.current?.action?.to
  if (to && (j.stage === null || ['IDENTIFIED', 'CAPTURE', 'PROPOSAL'].includes(j.stage))) return to
  return page
}

export default function ContinueOpportunity() {
  const { id } = useParams<{ id: string }>()
  const [params] = useSearchParams()
  const client = params.get('client')
  const navigate = useNavigate()
  const { data, isError, isSuccess } = useQuery<{ data: Journey }>({
    queryKey: journeyKey(id!, client),
    queryFn: () => opportunitiesApi.journey(id!, client),
    enabled: !!id,
  })
  useEffect(() => {
    if (!id || !(isSuccess || isError)) return
    const to = continueTarget(id, isSuccess ? data?.data : null)
    // Keep the client a consulting firm's link was for.
    navigate(client && !to.includes('?') ? to.replace(/(#.*)?$/, `?client=${encodeURIComponent(client)}$1`) : to, { replace: true })
  }, [id, client, data, isSuccess, isError, navigate])
  return <div className="flex justify-center py-24"><Spinner /></div>
}
