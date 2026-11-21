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
  ACTIVE: 'neutral',
  STRONG: 'success',
}

const STATE_LABEL: Record<RelationshipState, string> = {
  NO_DATA: 'Not enough data',
  WEAK: 'Weak',
  DEVELOPING: 'Developing',
  ACTIVE: 'Active',
  STRONG: 'Strong',
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
    <div className="panel p-4">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-[13px] font-semibold text-gray-100">Relationship strength</span>
        <RelationshipBadge state={relationship.state} score={relationship.score} />
      </div>
      <p className="text-[13px] text-gray-400">{relationship.reason}</p>

      {relationship.evidence.length > 0 && (
        <div className="mt-3 pt-3 border-t space-y-1.5" style={{ borderColor: 'var(--line)' }}>
          {relationship.evidence.map((e) => (
            <div key={e.factor} className="flex items-start justify-between gap-3 text-xs">
              <div>
                <span className="text-gray-300">{e.factor}</span>
                <span className="text-gray-400">: {e.detail}</span>
              </div>
              <span className="tabular-nums text-gray-300 flex-shrink-0">+{e.points}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-gray-500 mt-3">
        Computed from logged interactions only. It is never written by an agent and is never stored, so it
        cannot go stale.
      </p>
    </div>
  )
}

const ACTIVITY_TONE: Partial<Record<CrmActivityType, BadgeTone>> = {
  // Activity kinds are categories, not states: all neutral.
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
    return <p className="text-[13px] text-gray-400">No interactions logged yet.</p>
  }
  return (
    <ol className="v3-rule-list">
      {activities.map((a) => (
        <li key={a.id} className="py-3 first:pt-0">
          <div className="flex items-center gap-2 flex-wrap">
            <ActivityTypeBadge type={a.activityType} />
            <span className="text-[13px] text-gray-200 font-medium">{a.subject}</span>
            <span className="text-xs text-gray-400 tabular-nums">{fmtDate(a.occurredAt)}</span>
            {a.followUpNeeded && <Badge tone="warning">Follow-up needed</Badge>}
          </div>
          {a.summary && <p className="text-[13px] text-gray-400 mt-1">{a.summary}</p>}
          <div className="flex gap-3 flex-wrap text-xs text-gray-400 mt-1">
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
