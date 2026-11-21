// =============================================================
// SCW-6 — Subcontracting Path (read-only, Phase 4)
//
// Per SUBCONTRACTING_WORKFLOW_SPEC.md §3 SCW-6 layout. Surfaces SCW-1's
// likely-prime ranking on the opportunity detail page.
//
// Display contract:
//   - Top 5 primes by composite confidence shown by default; "Show all"
//     reveals the rest up to 10.
//   - Each prime carries the full 5-component decomposition, revealed by
//     clicking "Confidence X.XX" — per spec §2.3 "never return a confidence
//     value without the decomposition" and §3 SCW-6.1 "hover for breakdown".
//   - Missing data is explicit per spec §2.5 "no silent failures":
//     "Contact not on file", "SDVOSB status unverified", etc.
//   - "Draft Outreach" opens the draft modal, which also lists earlier drafts
//     for this prime. "Add to Capture Plan" stays disabled: no capture plan
//     feature exists yet to add to.
//   - Data-source citation footer per spec §2.2 "cite the data source".
// =============================================================

import { useEffect, useRef, useState } from 'react'
import { Loader, Network, Phone, Mail, AlertTriangle, ChevronDown, ChevronUp, ExternalLink, History, MessageSquare } from 'lucide-react'
import { scwApi, ScwLikelyPrime, ScwComponentBreakdown, ScwSubawardAnalysis } from '../../services/api'
import { OutreachDraftModal } from './OutreachDraftModal'

// Deep-link anchor: the dashboard ScwInbox links rows to
// /opportunities/:id#scw, so this component's wrapper carries id="scw"
// in every render state (loading, error, empty, populated) and scrolls
// itself into view once the load completes.
const SECTION_ANCHOR_ID = 'scw'

interface Props {
  opportunityId: string
}

const DEFAULT_VISIBLE = 5

export function SubcontractingPath({ opportunityId }: Props) {
  const [primes, setPrimes] = useState<ScwLikelyPrime[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [showAll, setShowAll] = useState(false)
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const hasScrolledRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    scwApi
      .likelyPrimes(opportunityId)
      .then((resp) => {
        if (cancelled) return
        setPrimes(Array.isArray(resp?.data) ? resp.data : [])
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.response?.data?.error || err?.message || 'Failed to load likely primes')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [opportunityId])

  // Deep-link scroll: when the page is loaded with #scw in the URL (from
  // the dashboard ScwInbox), scroll this section into view once the
  // initial load finishes. Guard with a ref so we don't re-scroll if the
  // user later scrolls away and we re-render for any reason.
  useEffect(() => {
    if (loading || hasScrolledRef.current) return
    if (typeof window === 'undefined') return
    if (window.location.hash !== `#${SECTION_ANCHOR_ID}`) return
    // setTimeout 0 defers until after this paint, so the OffsetParent
    // is stable when we measure. Smooth-scroll is the right default per
    // existing dashboard widgets that use anchors.
    const t = setTimeout(() => {
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      hasScrolledRef.current = true
    }, 0)
    return () => clearTimeout(t)
  }, [loading])

  if (loading) {
    return (
      <div id={SECTION_ANCHOR_ID} ref={sectionRef} className="card scroll-mt-6">
        <SectionHeader />
        <div className="flex items-center gap-2 text-gray-500 text-sm py-6">
          <Loader className="w-4 h-4 animate-spin" /> Computing likely primes...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div id={SECTION_ANCHOR_ID} ref={sectionRef} className="card scroll-mt-6">
        <SectionHeader />
        <div className="text-sm rounded-xl p-3" style={{ background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>
          {error}
        </div>
      </div>
    )
  }

  if (!primes || primes.length === 0) {
    return (
      <div id={SECTION_ANCHOR_ID} ref={sectionRef} className="card scroll-mt-6">
        <SectionHeader />
        <div className="text-sm text-gray-500 py-4">
          No historical primes found in USAspending for this NAICS + agency over the past 5 years.
          This is expected for very new agencies or rarely-bid NAICS codes; the SDVOSB BID SUB
          recommendation still applies but the operator will need to source primes manually.
        </div>
      </div>
    )
  }

  const visible = showAll ? primes : primes.slice(0, DEFAULT_VISIBLE)

  return (
    <div id={SECTION_ANCHOR_ID} ref={sectionRef} className="card scroll-mt-6">
      <SectionHeader />

      <p className="text-xs text-gray-500 mb-4">
        Past prime bidders on similar opportunities, ranked by composite confidence. Click a
        confidence score to see the component breakdown.
      </p>

      <div className="space-y-3">
        {visible.map((p, i) => (
          <PrimeCard
            key={`${p.primeName}-${i}`}
            rank={i + 1}
            prime={p}
            opportunityId={opportunityId}
            expanded={expandedIdx === i}
            onToggle={() => setExpandedIdx(expandedIdx === i ? null : i)}
          />
        ))}
      </div>

      {primes.length > DEFAULT_VISIBLE && (
        <button
          type="button"
          onClick={() => setShowAll((s) => !s)}
          className="mt-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          {showAll ? 'Show less' : `Show all (${primes.length})`}
        </button>
      )}

      <DataSourceFooter />
    </div>
  )
}

// =============================================================
// Section header
// =============================================================

function SectionHeader() {
  return (
    <h2 className="v3-h3 text-gray-100 mb-2 flex flex-wrap items-center gap-2">
      <Network className="w-5 h-5 text-gray-400" />
      Subcontracting path
      <span className="text-xs text-gray-500 font-normal ml-1">
        Bid as a sub: the primes most likely to need you
      </span>
    </h2>
  )
}

// =============================================================
// Per-prime card
// =============================================================

interface PrimeCardProps {
  rank: number
  prime: ScwLikelyPrime
  opportunityId: string
  expanded: boolean
  onToggle: () => void
}

function PrimeCard({ rank, prime, opportunityId, expanded, onToggle }: PrimeCardProps) {
  const composite = prime.confidence.composite
  const tier = tierFor(composite, prime.dataQuality.hasContact)
  const [showDraftModal, setShowDraftModal] = useState(false)

  return (
    <div className={`panel p-4 ${tier.borderClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-gray-200 font-medium truncate">
            <span className="text-gray-500 mr-2">{rank}.</span>
            {prime.primeName}
          </p>
          <p className="text-xs text-gray-500 mt-0.5 tabular-nums">
            {prime.primeUei ? `UEI ${prime.primeUei}` : 'UEI not on file'}
            {' · '}
            {prime.pastAwardsCount} past award{prime.pastAwardsCount === 1 ? '' : 's'}
            {' · '}
            ${fmtDollars(prime.totalPastValue)} total
            {prime.mostRecentAward && (
              <>
                {' · '}
                most recent {new Date(prime.mostRecentAward).toISOString().slice(0, 10)}
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={onToggle}
          className={`chip shrink-0 tabular-nums transition-colors ${tier.scoreClass}`}
          aria-expanded={expanded}
          aria-label={`Confidence ${composite.toFixed(2)} — click for breakdown`}
        >
          {composite.toFixed(2)}
          {expanded ? <ChevronUp className="w-3 h-3 inline ml-1" /> : <ChevronDown className="w-3 h-3 inline ml-1" />}
        </button>
      </div>

      {/* Contact line */}
      <div className="mt-2 text-xs">
        {renderContact(prime)}
      </div>

      {/* SDVOSB / size badges */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px]">
        {prime.sdvosbCertified && (
          <Badge className="">SDVOSB</Badge>
        )}
        {prime.businessSize === 'small' && !prime.sdvosbCertified && (
          <Badge className="">Small business</Badge>
        )}
        {prime.businessSize === null && (
          <Badge className="text-gray-500">Size unknown</Badge>
        )}
      </div>

      {/* Warnings — no silent failures */}
      {prime.dataQuality.warnings.length > 0 && (
        <ul className="mt-2 text-xs text-amber-400 space-y-0.5">
          {prime.dataQuality.warnings.map((w, idx) => (
            <li key={idx} className="flex items-start gap-1.5">
              <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}

      {/* Expanded: confidence decomposition + subaward analysis */}
      {expanded && (
        <>
          <ConfidenceBreakdown components={prime.confidence.components} citation={prime.confidence.citation} />
          <SubawardAnalysisPanel prime={prime} />
        </>
      )}

      {/* Action row */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowDraftModal(true)}
          className="btn-secondary btn-sm"
        >
          <MessageSquare className="w-3 h-3" />
          Draft outreach
        </button>
        <DisabledButton label="Add to capture plan" reason="Coming in v2 (capture-plan integration)" />
      </div>

      {showDraftModal && (
        <OutreachDraftModal
          opportunityId={opportunityId}
          prime={prime}
          onClose={() => setShowDraftModal(false)}
        />
      )}
    </div>
  )
}

function renderContact(prime: ScwLikelyPrime) {
  if (prime.contact.source === 'manual_research_required' || (!prime.contact.name && !prime.contact.email && !prime.contact.phone)) {
    return (
      <span className="text-gray-500">
        Contact not on file:{' '}
        <a
          href={`https://sam.gov/search/?index=ei&q=${encodeURIComponent(prime.primeName)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-200 underline underline-offset-2 inline-flex items-center gap-0.5"
        >
          look up in SAM.gov <ExternalLink className="w-3 h-3" />
        </a>
      </span>
    )
  }
  return (
    <div className="text-gray-300 space-y-0.5">
      {prime.contact.name && <div>{prime.contact.name}</div>}
      <div className="flex flex-wrap items-center gap-3 text-gray-400">
        {prime.contact.email && (
          <span className="inline-flex items-center gap-1">
            <Mail className="w-3 h-3" /> {prime.contact.email}
          </span>
        )}
        {prime.contact.phone && (
          <span className="inline-flex items-center gap-1">
            <Phone className="w-3 h-3" /> {prime.contact.phone}
          </span>
        )}
      </div>
    </div>
  )
}

// =============================================================
// Confidence breakdown panel
// =============================================================

const COMPONENT_LABELS: Record<string, string> = {
  awardFrequency: 'Award frequency in NAICS + agency',
  awardRecency: 'Award recency (2y half-life decay)',
  dollarVolume: 'Total dollar volume (log-normalized)',
  subawardPropensity: 'Subaward propensity (sub-$ / award-$)',
  sdvosbGoalGap: 'SDVOSB goal gap (FAR 52.219-9 pressure)',
}

interface BreakdownProps {
  components: Record<string, ScwComponentBreakdown>
  citation: string
}

function ConfidenceBreakdown({ components, citation }: BreakdownProps) {
  const rows = Object.entries(components) as Array<[string, ScwComponentBreakdown]>
  return (
    <div className="mt-3 pt-3 space-y-2" style={{ borderTop: '1px solid var(--line)' }}>
      {rows.map(([key, c]) => (
        <ComponentRow key={key} label={COMPONENT_LABELS[key] ?? key} c={c} />
      ))}
      <p className="text-[11px] text-gray-500 mt-2">{citation}</p>
    </div>
  )
}

function ComponentRow({ label, c }: { label: string; c: ScwComponentBreakdown }) {
  const barPct = Math.round(c.raw * 100)
  const barColor =
    c.confidence === 0 ? 'bg-gray-700' : ''
  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-gray-400">
          {label}
          <span className="text-gray-500 ml-2">weight {(c.weight * 100).toFixed(0)}%</span>
        </span>
        <span className="tabular-nums text-gray-300">
          {c.confidence === 0 ? (
            <span className="text-gray-500">no data</span>
          ) : (
            <>
              raw {c.raw.toFixed(2)} · conf {c.confidence.toFixed(2)}
            </>
          )}
        </span>
      </div>
      <div className="v3-bar mt-1">
        <i className={barColor} style={{ width: `${barPct}%` }} />
      </div>
      <p className="text-[11px] text-gray-500 mt-1">{c.reasoning}</p>
    </div>
  )
}

// =============================================================
// Subaward analysis panel (SCW-2)
// =============================================================

function SubawardAnalysisPanel({ prime }: { prime: ScwLikelyPrime }) {
  const identifier = prime.primeUei || prime.primeName
  const [data, setData] = useState<ScwSubawardAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setData(null)
    scwApi
      .subawardAnalysis(identifier)
      .then((resp) => {
        if (cancelled) return
        setData(resp?.data ?? null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.response?.data?.error || err?.message || 'Failed to load subaward analysis')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [identifier])

  return (
    <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
      <p className="text-xs font-semibold text-gray-300 mb-2 flex items-center gap-1.5">
        <History className="w-3.5 h-3.5 text-gray-500" />
        Subaward history (3y)
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-gray-500">
          <Loader className="w-3 h-3 animate-spin" /> Loading subaward analysis...
        </div>
      )}

      {error && (
        <div className="text-xs rounded-xl p-2" style={{ background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>{error}</div>
      )}

      {data && !loading && (
        <>
          <div className="grid grid-cols-3 gap-3 text-xs">
            <Stat
              label="Total subaward $"
              value={data.totalSubawardDollars !== null ? `$${fmtDollars(data.totalSubawardDollars)}` : '—'}
              hint={data.totalSubawardDollars === null ? 'no rows in corpus' : undefined}
            />
            <Stat
              label="Avg sub size"
              value={data.averageSubSize !== null ? `$${fmtDollars(data.averageSubSize)}` : '—'}
            />
            <Stat
              label="Sample size"
              value={`${data.dataQuality.sampleSize.toLocaleString()} rows`}
            />
          </div>

          {/* Fields known to be unavailable in v1 — surface explicitly */}
          <div className="grid grid-cols-3 gap-3 text-xs mt-2">
            <Stat
              label="% SDVOSB"
              value="—"
              hint="not available (R4)"
              dimmed
            />
            <Stat
              label="% small biz"
              value="—"
              hint="not available (R4)"
              dimmed
            />
            <Stat
              label="SDVOSB goal gap"
              value={
                data.sdvosbGoalGap.gapPercent !== null
                  ? `${data.sdvosbGoalGap.gapPercent.toFixed(1)}pp`
                  : '—'
              }
              hint={data.sdvosbGoalGap.source === 'unknown' ? 'not available' : undefined}
              dimmed={data.sdvosbGoalGap.source === 'unknown'}
            />
          </div>

          {data.dataQuality.warnings.length > 0 && (
            <ul className="mt-2 text-[11px] text-gray-500 space-y-0.5">
              {data.dataQuality.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-1">
                  <span className="text-gray-600">·</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] text-gray-500 mt-2">
            Computed {new Date(data.computedAt).toLocaleString()}{data.fromCache ? ' (cached)' : ''}
          </p>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, hint, dimmed }: { label: string; value: string; hint?: string; dimmed?: boolean }) {
  return (
    <div>
      <p className={`text-xs ${dimmed ? 'text-gray-600' : 'text-gray-500'}`}>{label}</p>
      <p className={`tabular-nums font-semibold ${dimmed ? 'text-gray-600' : 'text-gray-200'}`}>{value}</p>
      {hint && <p className="text-[11px] text-gray-500 mt-0.5">{hint}</p>}
    </div>
  )
}

// =============================================================
// Disabled button (Phase 4 placeholder)
// =============================================================

function DisabledButton({ label, reason }: { label: string; reason: string }) {
  return (
    <button
      type="button"
      disabled
      title={reason}
      className="btn-secondary btn-sm"
    >
      {label}
    </button>
  )
}

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span className={`chip ${className}`}>{children}</span>
  )
}

// =============================================================
// Footer
// =============================================================

function DataSourceFooter() {
  return (
    <p className="text-[11px] text-gray-500 mt-4 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
      Data sources: USAspending V2 (api.usaspending.gov) bulk prime + subaward pull (24-month rolling window),
      SAM.gov Entity API cache (recipient_profiles), internal scoring weights frozen by scw/confidence.ts.
    </p>
  )
}

// =============================================================
// Helpers
// =============================================================

function tierFor(composite: number, hasContact: boolean) {
  // Per spec §3 SCW-6 step 5 color coding. We don't have SDVOSB goal-gap
  // data in v1 (see R4 — docs/scw/data-layer-introspection.md), so the
  // "green" tier softens to "high confidence + contact on file" without
  // the goal-gap qualifier.
  if (composite >= 0.75 && hasContact) {
    return {
      borderClass: '',
      scoreClass: 'chip-success',
    }
  }
  if (composite >= 0.75) {
    return {
      borderClass: '',
      scoreClass: 'chip-accent',
    }
  }
  if (composite >= 0.5) {
    return {
      borderClass: '',
      scoreClass: 'chip-neutral',
    }
  }
  return {
    borderClass: '',
    scoreClass: 'chip-neutral text-gray-500',
  }
}

function fmtDollars(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toFixed(0)
}
