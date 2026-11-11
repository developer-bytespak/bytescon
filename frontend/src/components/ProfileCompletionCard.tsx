// "Complete your profile" card, shown above every page until the company
// profiles the account keeps are complete. Scoring, analysis and proposals are
// refused for an incomplete profile (backend services/profileGate.ts), so this
// says what is missing and links straight to where it is filled in.
import { Link, useLocation } from 'react-router-dom'
import { ClipboardList, ArrowRight } from 'lucide-react'
import { useProfileStatus, fieldHref, profileHref } from '../hooks/useProfileStatus'

const MAX_LISTED = 3

export function ProfileCompletionCard() {
  const { data } = useProfileStatus()
  const { pathname } = useLocation()
  if (!data || data.complete) return null

  const incomplete = data.clients.filter((c) => !c.complete)
  const contractor = data.accountType === 'CONTRACTOR'
  const own = contractor ? data.clients[0] : undefined

  // A consulting firm with no clients yet: the first step is adding one.
  if (!contractor && data.clients.length === 0) {
    return (
      <Card
        title="Add your first client"
        body="Scores, analysis and proposals are worked out for a client. Add one and complete its profile to get started."
        action={pathname === '/clients' ? null : { to: '/clients', label: 'Add a client' }}
      />
    )
  }

  if (own) {
    // My Company shows the same status at the top of the form.
    if (pathname === '/my-company') return null
    const next = own.missing.slice(0, MAX_LISTED)
    return (
      <Card
        title={`Complete your company profile (${own.percent}%)`}
        body="Scores, bid decisions, analysis and proposals use your company profile. Fill in the required details to switch them on."
        percent={own.percent}
        items={next.map((m) => ({ label: m.label, to: fieldHref(m.where, own) }))}
        more={own.missing.length - next.length}
        action={{ to: '/my-company', label: 'Complete profile' }}
      />
    )
  }

  const listed = incomplete.slice(0, MAX_LISTED)
  return (
    <Card
      title={incomplete.length === 1 ? '1 client profile is incomplete' : `${incomplete.length} client profiles are incomplete`}
      body="Scores, bid decisions, analysis and proposals for a client need its profile complete."
      items={listed.map((c) => ({ label: `${c.name} — ${c.percent}%, ${c.missing.length} required ${c.missing.length === 1 ? 'item' : 'items'} missing`, to: profileHref(c) }))}
      more={incomplete.length - listed.length}
      action={null}
    />
  )
}

function Card({ title, body, percent, items = [], more = 0, action }: {
  title: string
  body: string
  percent?: number
  items?: Array<{ label: string; to: string }>
  more?: number
  action: { to: string; label: string } | null
}) {
  return (
    <section
      aria-label="Complete your profile"
      className="mb-6 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row gap-4 sm:items-start"
      style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent-line)' }}
    >
      <span className="inline-grid place-items-center w-10 h-10 rounded-full shrink-0" style={{ background: 'var(--surface)', color: 'var(--accent)' }}>
        <ClipboardList className="w-5 h-5" aria-hidden="true" />
      </span>
      <div className="flex-1 min-w-0">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{title}</h2>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-2)' }}>{body}</p>
        {percent !== undefined && (
          <div className="mt-2 h-1.5 rounded-full overflow-hidden max-w-sm" style={{ background: 'var(--line-strong)' }} aria-hidden="true">
            <div className="h-full rounded-full" style={{ width: `${percent}%`, background: 'var(--accent)' }} />
          </div>
        )}
        {items.length > 0 && (
          <ul className="mt-2 space-y-1">
            {items.map((item) => (
              <li key={item.label} className="text-sm">
                <Link to={item.to} className="underline underline-offset-2" style={{ color: 'var(--accent)' }}>{item.label}</Link>
              </li>
            ))}
            {more > 0 && <li className="text-xs" style={{ color: 'var(--text-muted)' }}>and {more} more</li>}
          </ul>
        )}
      </div>
      {action && (
        <Link to={action.to} className="btn-primary inline-flex items-center gap-1.5 text-sm px-4 py-2 shrink-0 self-start">
          {action.label} <ArrowRight className="w-4 h-4" aria-hidden="true" />
        </Link>
      )}
    </section>
  )
}
