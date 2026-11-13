// The optional profile details still empty that would improve results (PSC
// codes, contract vehicles, logo…), each with what it improves. Shown once a
// profile is complete; never required. Fields nothing reads yet (street, ZIP,
// phone, clearances, ISO) aren't suggested (backend profileCompleteness.ts).
import type { ClientProfileStatus } from '../services/api'

export function OptionalDetailsNote({ status }: { status: ClientProfileStatus }) {
  const improving = status.optional?.improving ?? []
  if (!status.complete || improving.length === 0) return null
  return (
    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
      To improve your results, you can also add: {improving.map((f) => `${f.label} (${f.improves})`).join(', ')}.
    </p>
  )
}
