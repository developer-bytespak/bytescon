// Picks a teammate for a piece of work. Every picker says plainly that it is
// optional and what choosing someone does (a notification, an approval only
// they can give, or just a name on the record), so nobody has to guess.
import { useId } from 'react'

export interface AssignUser { id: string; firstName?: string | null; lastName?: string | null; email?: string | null }

/** What each kind of assignment does, in one place. */
export const ASSIGN = {
  writer: {
    label: 'Assign writing to',
    hint: 'They get a notification. You can leave it unassigned.',
  },
  approver: {
    label: 'Get it approved by',
    hint: 'Only this person or an admin can approve it or send it back. Leave it empty and anyone who can approve may.',
  },
  requirement: {
    label: 'Assign this requirement to',
    hint: 'Shows who is responsible for it. No notification is sent.',
  },
  pursuit: {
    label: 'Assign this pursuit to',
    hint: 'Shows who leads it. No notification is sent.',
  },
  gateApprover: {
    label: 'Needs approval from',
    hint: 'They get a notification, and only they can approve, reject or ask for changes. Without one, an admin can only waive this review.',
  },
  qualifyReviewer: {
    label: 'Ask for a review from',
    hint: 'They get a notification. The final bid decision stays with an admin.',
  },
} as const

export type AssignKind = keyof typeof ASSIGN

export const personName = (u?: AssignUser | null) =>
  u ? ([u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'Unnamed') : ''

export function AssignPicker({
  kind, value, onChange, users, compact = false, disabled = false, className = '',
}: {
  kind: AssignKind
  value: string | null | undefined
  onChange: (userId: string | null) => void
  users: AssignUser[]
  /** For table cells: the column heading carries the label, so only the select shows. */
  compact?: boolean
  disabled?: boolean
  className?: string
}) {
  const id = useId()
  const { label, hint } = ASSIGN[kind]
  const select = (
    <select id={id} aria-label={`${label} (optional)`} value={value ?? ''} disabled={disabled}
      onChange={(e) => onChange(e.target.value || null)}
      className={compact ? 'input !w-auto !py-1 !px-2 !text-xs' : 'input mt-1 w-full !py-1.5'}>
      <option value="">Not assigned</option>
      {users.map((u) => <option key={u.id} value={u.id}>{personName(u)}</option>)}
    </select>
  )
  if (compact) return select
  return (
    <div className={className}>
      <label htmlFor={id} className="text-xs text-gray-400">
        {label} <span className="text-gray-600">(optional)</span>
      </label>
      {select}
      <p className="text-[11px] text-gray-500 mt-1 leading-snug">{hint}</p>
    </div>
  )
}
