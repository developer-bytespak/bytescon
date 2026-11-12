// The optional profile extras still empty (address, phone, PSC codes, logo…).
// Shown once a profile is complete: never required, but they improve results.
import type { ClientProfileStatus } from '../services/api'

export function OptionalDetailsNote({ status }: { status: ClientProfileStatus }) {
  const optional = status.optional
  if (!status.complete || !optional || optional.missing.length === 0) return null
  return (
    <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
      Optional details: {optional.filled} of {optional.total} added. Adding more improves scores and proposals — still empty: {optional.missing.join(', ')}.
    </p>
  )
}
