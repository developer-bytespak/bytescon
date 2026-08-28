// =============================================================
// §8.1 — CRM context on an opportunity.
//
// Read-only composition over records that already exist: the agency already on
// the opportunity, contacts at that agency, interactions logged against it, and
// the next open follow-up. Weighted value is deliberately absent here — the
// portfolio service remains the only place that computes it.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, Users } from 'lucide-react'
import { Badge, EmptyPanel, ErrorPanel, LoadingPanel } from '../section6/Section6Ui'
import { ActivityTimeline, ContactRoleBadge } from './CrmUi'
import { crmApi, type OpportunityCrmContext } from '../../services/crmApi'

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function OpportunityCrmPanel({ opportunityId }: { opportunityId: string }) {
  const [data, setData] = useState<OpportunityCrmContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await crmApi.opportunityContext(opportunityId))
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load CRM context.')
    } finally {
      setLoading(false)
    }
  }, [opportunityId])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading relationships…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (!data) return null

  const nothingYet = data.contacts.length === 0 && data.activities.length === 0 && !data.nextFollowUp

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-300">Relationships</h3>
        <Link to="/crm" className="text-xs text-gray-500 hover:text-gray-300">Open CRM →</Link>
      </div>

      {data.agencyName && (
        <div className="text-[12px] text-gray-400">
          {/* SAM stores the agency as a dotted, inverted path
              ("ENERGY, DEPARTMENT OF.…"). Showing that raw is unreadable, so
              the server parses it and the department and office are shown as a
              person would say them. */}
          <p>
            Agency <span className="text-gray-200">{data.agencyPath?.department ?? data.agencyName}</span>
            {data.offices.length > 0 && <span className="text-gray-500"> · {data.offices.length} office(s) tracked</span>}
            {data.partnersEngaged > 0 && <span className="text-gray-500"> · {data.partnersEngaged} partner(s) engaged</span>}
          </p>
          {data.agencyPath?.office && (
            <p className="text-[11px] text-gray-500 mt-0.5">Buying office {data.agencyPath.office}</p>
          )}
        </div>
      )}

      {nothingYet ? (
        <EmptyPanel
          message="No relationship history on this opportunity yet."
          hint="Open the CRM, log a call or meeting against the contact, and pick this opportunity in the “Link to an opportunity” box — it will appear here."
        />
      ) : (
        <>
          {data.nextFollowUp && (
            <div className="border border-gray-800 rounded-lg p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <CalendarClock className="w-4 h-4 text-gray-500" />
                <span className="text-[10px] uppercase tracking-widest text-gray-500">Next follow-up</span>
                <Badge tone={new Date(data.nextFollowUp.dueAt) < new Date() ? 'danger' : 'info'}>
                  {new Date(data.nextFollowUp.dueAt) < new Date() ? 'OVERDUE' : data.nextFollowUp.status}
                </Badge>
              </div>
              <p className="text-[13px] text-gray-200 mt-1">{data.nextFollowUp.title}</p>
              <p className="text-[11px] text-gray-500">Due {fmtDate(data.nextFollowUp.dueAt)}</p>
            </div>
          )}

          {data.contacts.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-gray-500" />
                <span className="text-[10px] uppercase tracking-widest text-gray-500">Contacts at this agency</span>
              </div>
              <div className="space-y-1.5">
                {data.contacts.slice(0, 8).map((c) => (
                  <div key={c.id} className="flex items-center gap-2 flex-wrap text-[12px]">
                    <span className="text-gray-200">{c.fullName}</span>
                    <ContactRoleBadge role={c.contactRole} />
                    {c.title && <span className="text-gray-500">{c.title}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.activities.length > 0 && (
            <div>
              <span className="text-[10px] uppercase tracking-widest text-gray-500 block mb-2">Recent interactions</span>
              <ActivityTimeline activities={data.activities.slice(0, 6)} />
            </div>
          )}
        </>
      )}

      <p className="text-[10px] text-gray-600 border-t border-gray-800 pt-3">{data.valueNote}</p>
    </div>
  )
}
