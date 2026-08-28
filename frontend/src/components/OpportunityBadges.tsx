// =============================================================
// Opportunity data-quality badges (§5.1) — honest source/type/status/amended
// labelling. A live record with a valid link gets a clickable external link
// named after the system that actually holds it (§6.1 added sources beyond
// SAM.gov); demo/manual records are clearly labelled and NEVER render a
// government link (demo notice ids 404; manual has no government source).
// =============================================================
import { sourceLinkLabel } from '../lib/samUrl'

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
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-300 border border-yellow-700 flex-shrink-0">DEMO</span>
  }
  if (opp.source === 'MANUAL') {
    return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 border border-gray-600 flex-shrink-0">MANUAL</span>
  }
  if (opp.hasValidSourceLink && opp.sourceUrl) {
    // Rendered as a <span> (not <a>) because this badge sits inside the row's
    // <Link>; a nested <a> is invalid DOM. Opens the source in a new tab.
    const url = opp.sourceUrl
    return (
      <span role="link" tabIndex={0}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); window.open(url, '_blank', 'noopener,noreferrer') }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); window.open(url, '_blank', 'noopener,noreferrer') } }}
        className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-300 border border-green-700 flex-shrink-0 inline-flex items-center gap-0.5 cursor-pointer">{sourceLinkLabel(opp.source)} ↗</span>
    )
  }
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700 flex-shrink-0">no live link</span>
}

export function StatusBadge({ status }: { status?: string }) {
  if (!status || status === 'ACTIVE') return null
  const tone: Record<string, string> = {
    ARCHIVED: 'bg-gray-800 text-gray-500 border-gray-700',
    EXPIRED: 'bg-gray-800 text-gray-500 border-gray-700',
    AWARDED: 'bg-blue-950/40 text-blue-300 border-blue-800',
    CANCELLED: 'bg-red-950/40 text-red-300 border-red-800',
  }
  return <span className={`text-[10px] px-1.5 py-0.5 rounded border flex-shrink-0 ${tone[status] || 'bg-gray-800 text-gray-400 border-gray-700'}`}>{status}</span>
}

export function AmendedBadge({ opp }: { opp: BadgeOpp }) {
  if (!opp.isAmended) return null
  return <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-700 flex-shrink-0">AMENDED{opp.amendmentCount ? ` ·${opp.amendmentCount}` : ''}</span>
}
