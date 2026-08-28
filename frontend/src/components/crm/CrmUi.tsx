// =============================================================
// §8.1 — Shared CRM presentation primitives.
//
// The honesty rule that matters most here: NO_DATA is rendered as "not enough
// data", never as a zero score and never as a weak relationship. A user who
// sees "weak" against a contact they have simply never logged will stop
// trusting every other number on the page.
// =============================================================
import { Badge, BadgeTone } from '../section6/Section6Ui'
import {
  ACTIVITY_TYPE_LABELS, CONTACT_ROLE_LABELS,
  type CrmActivity, type CrmActivityType, type GovContactRole,
  type RelationshipState, type RelationshipStrength,
} from '../../services/crmApi'

const STATE_TONE: Record<RelationshipState, BadgeTone> = {
  NO_DATA: 'neutral',
  WEAK: 'danger',
  DEVELOPING: 'warning',
  ACTIVE: 'info',
  STRONG: 'success',
}

const STATE_LABEL: Record<RelationshipState, string> = {
  NO_DATA: 'NOT ENOUGH DATA',
  WEAK: 'WEAK',
  DEVELOPING: 'DEVELOPING',
  ACTIVE: 'ACTIVE',
  STRONG: 'STRONG',
}

export function RelationshipBadge({ state, score }: { state: RelationshipState; score: number | null }) {
  return (
    <Badge tone={STATE_TONE[state]} title={state === 'NO_DATA' ? 'No interactions have been logged yet.' : undefined}>
      {STATE_LABEL[state]}{score !== null ? ` · ${score}` : ''}
    </Badge>
  )
}

/** Full strength panel: state, reason, and the evidence it was computed from. */
export function RelationshipPanel({ relationship }: { relationship: RelationshipStrength }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-xs font-semibold text-gray-300">Relationship strength</span>
        <RelationshipBadge state={relationship.state} score={relationship.score} />
      </div>
      <p className="text-[12px] text-gray-400">{relationship.reason}</p>

      {relationship.evidence.length > 0 && (
        <div className="mt-3 pt-3 border-t border-gray-800 space-y-1.5">
          {relationship.evidence.map((e) => (
            <div key={e.factor} className="flex items-start justify-between gap-3 text-[11px]">
              <div>
                <span className="text-gray-300">{e.factor}</span>
                <span className="text-gray-500"> — {e.detail}</span>
              </div>
              <span className="font-mono text-gray-400 flex-shrink-0">+{e.points}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-[10px] text-gray-600 mt-3">
        Computed from logged interactions only. It is never written by an agent and is never stored, so it
        cannot go stale.
      </p>
    </div>
  )
}

const ACTIVITY_TONE: Partial<Record<CrmActivityType, BadgeTone>> = {
  CALL: 'info',
  MEETING: 'brand',
  INDUSTRY_DAY: 'brand',
  SITE_VISIT: 'brand',
  CAPABILITY_BRIEFING: 'brand',
  CONFERENCE: 'brand',
}

export function ActivityTypeBadge({ type }: { type: CrmActivityType }) {
  return <Badge tone={ACTIVITY_TONE[type] ?? 'neutral'}>{ACTIVITY_TYPE_LABELS[type]}</Badge>
}

export function ContactRoleBadge({ role }: { role: GovContactRole }) {
  return <Badge tone="neutral">{CONTACT_ROLE_LABELS[role]}</Badge>
}

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** Reverse-chronological activity timeline shared by every CRM detail view. */
export function ActivityTimeline({ activities }: { activities: CrmActivity[] }) {
  if (activities.length === 0) {
    return <p className="text-[12px] text-gray-500">No interactions logged yet.</p>
  }
  return (
    <ol className="space-y-2.5">
      {activities.map((a) => (
        <li key={a.id} className="border-l-2 border-gray-800 pl-3">
          <div className="flex items-center gap-2 flex-wrap">
            <ActivityTypeBadge type={a.activityType} />
            <span className="text-[13px] text-gray-200 font-medium">{a.subject}</span>
            <span className="text-[11px] text-gray-500 font-mono">{fmtDate(a.occurredAt)}</span>
            {a.followUpNeeded && <Badge tone="warning">FOLLOW-UP NEEDED</Badge>}
          </div>
          {a.summary && <p className="text-[12px] text-gray-400 mt-0.5">{a.summary}</p>}
          <div className="flex gap-3 flex-wrap text-[11px] text-gray-500 mt-1">
            {a.governmentContact && <span>{a.governmentContact.fullName}</span>}
            {a.partner && <span>Partner: {a.partner.name}</span>}
            {a.partnerContact && <span>{a.partnerContact.fullName}</span>}
            {a.opportunity && <span className="truncate max-w-[280px]">Opportunity: {a.opportunity.title}</span>}
            {a.durationMinutes ? <span>{a.durationMinutes} min</span> : null}
            {a.participants.length > 0 && <span>{a.participants.length} participant(s)</span>}
          </div>
        </li>
      ))}
    </ol>
  )
}
