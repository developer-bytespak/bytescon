// =============================================================
// SCW-5 — Subcontracting Inbox dashboard widget.
//
// Per SUBCONTRACTING_WORKFLOW_SPEC.md §3 SCW-5: persistent dashboard
// notification surface for BID SUB opportunities meeting the trigger
// criteria (deadline ≥ 5d, ≥1 likely prime confidence ≥ 0.6, etc.). The
// criteria are enforced server-side in services/scw/notifications.ts —
// this component just renders.
//
// v1 has no "acknowledged" state — the spec called for one but persisting
// it requires an extra DB column + a write endpoint. UI shows the live
// list; if a user wants it gone, they convert it to action (click through
// to draft outreach).
// =============================================================

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Loader, Network, AlertTriangle, ChevronRight, ChevronDown, ChevronUp,
  Calendar, Trophy, DollarSign,
} from 'lucide-react'
import { scwApi, ScwSubBidNotification } from '../../services/api'

const DEFAULT_VISIBLE = 5
const FETCH_LIMIT = 25
const STALE_MS = 60_000 // re-fetch every minute on the dashboard

export function ScwInbox() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['scw-inbox'],
    queryFn: () => scwApi.notificationInbox(FETCH_LIMIT),
    staleTime: STALE_MS,
    refetchOnWindowFocus: true,
  })
  const [showAll, setShowAll] = useState(false)

  // Hide entirely on first load until we have data. Avoids the empty
  // "Subcontracting Inbox (0)" header flashing on every dashboard mount.
  if (isLoading) {
    return (
      <div className="card flex items-center gap-2 text-xs text-gray-500">
        <Loader className="w-4 h-4 animate-spin" />
        Loading subcontracting inbox...
      </div>
    )
  }

  if (error) {
    return (
      <div className="card border border-red-800 bg-red-950/30 text-sm text-red-300 flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>Failed to load subcontracting inbox: {(error as Error).message}</span>
      </div>
    )
  }

  const items = data?.data ?? []
  if (items.length === 0) return null // empty: render nothing rather than noise

  const visible = showAll ? items : items.slice(0, DEFAULT_VISIBLE)

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">
          <Network className="w-5 h-5 text-blue-400" />
          Subcontracting Inbox
          <span className="text-sm text-gray-500 font-normal">({items.length})</span>
        </h2>
        <span className="text-[10px] uppercase tracking-wide text-gray-600">
          BID SUB recommendations with actionable primes
        </span>
      </div>

      <div className="space-y-2">
        {visible.map((n) => (
          <InboxRow key={n.opportunityId} n={n} />
        ))}
      </div>

      {items.length > DEFAULT_VISIBLE && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="mt-3 text-xs text-gray-500 hover:text-gray-300 transition-colors inline-flex items-center gap-1"
        >
          {showAll ? (
            <>
              Show less <ChevronUp className="w-3 h-3" />
            </>
          ) : (
            <>
              Show {items.length - DEFAULT_VISIBLE} more <ChevronDown className="w-3 h-3" />
            </>
          )}
        </button>
      )}
    </div>
  )
}

// =============================================================
// Per-row card
// =============================================================

function InboxRow({ n }: { n: ScwSubBidNotification }) {
  const urgent = n.daysRemaining < 10
  const tier =
    n.daysRemaining < 5
      ? { border: 'border-red-800', bg: 'bg-red-950/20', dayClass: 'text-red-300' }
      : n.daysRemaining < 14
      ? { border: 'border-amber-800', bg: 'bg-amber-950/20', dayClass: 'text-amber-300' }
      : { border: 'border-gray-800', bg: 'bg-gray-900/40', dayClass: 'text-gray-400' }

  return (
    <Link
      to={`/opportunities/${n.opportunityId}#scw`}
      className={`block border rounded-lg p-3 transition-colors hover:bg-gray-900 ${tier.border} ${tier.bg}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 font-medium truncate">{n.opportunityTitle}</p>
          <p className="text-xs text-gray-500 mt-0.5 truncate">
            {n.agency} · {n.setAsideType}
          </p>
        </div>
        <div className="shrink-0 flex items-center gap-3 text-xs">
          <span className={`font-mono inline-flex items-center gap-1 ${tier.dayClass}`}>
            <Calendar className="w-3 h-3" /> {n.daysRemaining}d
          </span>
          <ChevronRight className="w-4 h-4 text-gray-600" />
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-400">
        {n.winProbability !== null && (
          <span className="inline-flex items-center gap-1">
            <Trophy className="w-3 h-3 text-gray-500" /> win prob {Math.round(n.winProbability * 100)}%
          </span>
        )}
        {n.netExpectedValue !== null && (
          <span className="inline-flex items-center gap-1">
            <DollarSign className="w-3 h-3 text-gray-500" /> NEV ${fmtDollars(n.netExpectedValue)}
          </span>
        )}
      </div>

      {n.topPrimes.length > 0 && (
        <p className="mt-1.5 text-[11px] text-gray-500">
          Top primes:{' '}
          {n.topPrimes.map((p, i) => (
            <span key={p.name}>
              <span className="text-gray-300">{p.name}</span>
              <span className="text-gray-600 ml-1">({p.confidence.toFixed(2)})</span>
              {i < n.topPrimes.length - 1 ? <span className="text-gray-700"> · </span> : null}
            </span>
          ))}
        </p>
      )}

      {urgent && (
        <p className="mt-1.5 text-[10px] uppercase tracking-wide text-red-400/80 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> Urgent — deadline within 10 days
        </p>
      )}
    </Link>
  )
}

function fmtDollars(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toFixed(0)
}
