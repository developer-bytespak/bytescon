// =============================================================
// Opportunity data-quality badges (§5.1) — honest source/type/status/amended
// labelling. A live record with a valid link gets a clickable external link
// named after the system that actually holds it (§6.1 added sources beyond
// SAM.gov); demo/manual records are clearly labelled and NEVER render a
// government link (demo notice ids 404; manual has no government source).
// =============================================================
import { sourceLinkLabel } from '../lib/samUrl'
import { ExternalLink } from 'lucide-react'
import { humanize } from '../lib/humanize'

export interface BadgeOpp {
  source?: string
  isDemo?: boolean
  sourceUrl?: string | null
  hasValidSourceLink?: boolean
  status?: string
  isAmended?: boolean
  amendmentCount?: number | null
}

export function SourceBadge({ opp }: { opp: BadgeOpp }) {
  if (opp.isDemo || opp.source === 'DEMO') {
    return <span className="chip flex-shrink-0">Demo</span>
  }
  if (opp.source === 'MANUAL') {
    return <span className="chip flex-shrink-0">Manual</span>
  }
  if (opp.hasValidSourceLink && opp.sourceUrl) {
    // Rendered as a <span> (not <a>) because this badge sits inside the row's
    // <Link>; a nested <a> is invalid DOM. Opens the source in a new tab.
    const url = opp.sourceUrl
    return (
      <span role="link" tabIndex={0}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(url, '_blank', 'noopener,noreferrer') }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); window.open(url, '_blank', 'noopener,noreferrer') } }}
        className="chip flex-shrink-0 cursor-pointer hover:!border-[color:var(--text-muted)]">{sourceLinkLabel(opp.source)}<ExternalLink className="w-3 h-3" aria-hidden="true" /></span>
    )
  }
  return <span className="chip flex-shrink-0 text-gray-500">No live link</span>
}

export function StatusBadge({ status }: { status?: string }) {
  if (!status || status === 'ACTIVE') return null
  const tone: Record<string, string> = {
    ARCHIVED: 'chip-neutral',
    EXPIRED: 'chip-neutral',
    AWARDED: 'chip-neutral',
    CANCELLED: 'chip-danger',
  }
  return <span className={`chip flex-shrink-0 ${tone[status] || 'chip-neutral'}`}>{humanize(status)}</span>
}

export function AmendedBadge({ opp }: { opp: BadgeOpp }) {
  if (!opp.isAmended) return null
  return <span className="chip badge-yellow flex-shrink-0">Amended{opp.amendmentCount ? ` ·${opp.amendmentCount}` : ''}</span>
}
